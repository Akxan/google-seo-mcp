/**
 * Site-wide checks: site_crawl, hreflang_check, compare_pages, social_preview_check, keyword_suggest.
 */
import { z } from "zod";
import * as cheerio from "cheerio";
import { imageSize } from "image-size";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { heartbeat, round, tool } from "../util.js";
import { auditPage, collectSitemapUrls, fetchWithTimeout, parseRobots, robotsAllows } from "./web.js";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }));
  return out;
}

/** Dedupe key: no hash, no trailing slash. Never fetch this form; fetch the URL as found. */
function normalizeUrl(u: string): string {
  const x = new URL(u);
  x.hash = "";
  if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
  return x.toString();
}
function cleanUrl(u: string): string { const x = new URL(u); x.hash = ""; return x.toString(); }

export function registerCrawlTools(server: McpServer) {
  server.registerTool(
    "site_crawl",
    {
      title: "Crawl the site and audit every page",
      description:
        "Breadth-first crawl from a start URL (same host only, respects robots.txt for Googlebot), auditing each HTML page like page_audit. Returns a site-level summary: status code counts, broken internal links with their referrers, redirect chains, duplicate titles and descriptions, pages missing title/description/H1, noindex pages, thin pages, images without alt, orphan pages (in sitemap but never linked), click depth from the start page and inbound-link counts per page. Use maxPages to bound the run; a 200-page crawl takes 1-3 minutes.",
      inputSchema: {
        startUrl: z.string().url(),
        maxPages: z.number().int().min(1).max(500).default(150),
        concurrency: z.number().int().min(1).max(8).default(5),
        includeSitemap: z.boolean().default(true).describe("Also read the sitemap to detect orphan pages and seed the queue."),
        pathPrefix: z.string().optional().describe("Only crawl URLs whose path starts with this, e.g. '/blog/'."),
        includePages: z.boolean().default(false).describe("Include the per-page audit rows in the response (large)."),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "crawling");
      try {
        const start = cleanUrl(a.startUrl);
        const origin = new URL(start).origin;
        const host = new URL(start).hostname;
        let robots = { groups: [], sitemaps: [] as string[] } as ReturnType<typeof parseRobots>;
        try { const r = await fetchWithTimeout(`${origin}/robots.txt`); if (r.ok) robots = parseRobots(await r.text()); } catch { /* ignore */ }
        const sitemapUrls = new Set<string>();
        if (a.includeSitemap) {
          const sm = robots.sitemaps[0] ?? `${origin}/sitemap.xml`;
          try { for (const u of (await collectSitemapUrls(sm, { maxUrls: 5000 })).urls) sitemapUrls.add(u.loc); } catch { /* ignore */ }
        }
        const allowed = (u: string) => { const x = new URL(u); return x.hostname === host && /^https?:$/.test(x.protocol) && (!a.pathPrefix || x.pathname.startsWith(a.pathPrefix)) && robotsAllows(robots, u, "googlebot").allowed && !/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|xml|ico|woff2?)$/i.test(x.pathname); };
        const depth = new Map<string, number>([[normalizeUrl(start), 0]]);
        const inlinks = new Map<string, Set<string>>();
        const queue: string[] = [start];
        const seen = new Set<string>([normalizeUrl(start)]);
        const pages: Record<string, unknown>[] = [];
        const linkStatus = new Map<string, number>();
        const brokenLinks: { url: string; status: number; foundOn: string }[] = [];
        const redirectChains: { url: string; hops: number; finalUrl: string; foundOn: string }[] = [];
        // seed from sitemap so unlinked pages still get crawled (depth = Infinity until linked)
        const sitemapKeys = new Set([...sitemapUrls].map(normalizeUrl));
        for (const u of sitemapUrls) if (!seen.has(normalizeUrl(u)) && allowed(u)) { seen.add(normalizeUrl(u)); queue.push(u); }
        let processed = 0;
        while (queue.length && processed < a.maxPages) {
          const batch = queue.splice(0, Math.min(a.concurrency, a.maxPages - processed));
          processed += batch.length;
          await mapLimit(batch, a.concurrency, async (url) => {
            try {
              const r = await auditPage(url, { maxHeadings: 0, maxImagesMissingAlt: 0 });
              const finalUrl = cleanUrl(r.finalUrl);
              const finalKey = normalizeUrl(finalUrl);
              linkStatus.set(url, r.status);
              const key = normalizeUrl(url);
              if (r.redirectChain.length) redirectChains.push({ url, hops: r.redirectChain.length, finalUrl, foundOn: [...(inlinks.get(key) ?? [])][0] ?? "(seed)" });
              if (r.status >= 400) { for (const ref of inlinks.get(key) ?? ["(seed)"]) brokenLinks.push({ url, status: r.status, foundOn: ref }); return; }
              if (!/text\/html/.test(r.contentType ?? "")) return;
              if (finalKey !== key && seen.has(finalKey) && r.redirectChain.length) return; // redirected onto a page crawled separately
              const d = depth.get(key) ?? Infinity;
              // discover links
              const res = await fetchWithTimeout(finalUrl);
              const $ = cheerio.load(await res.text());
              const found = new Set<string>();
              $("a[href]").each((_, el) => { try { const u = cleanUrl(new URL($(el).attr("href")!, finalUrl).toString()); if (allowed(u)) found.add(u); } catch { /* ignore */ } });
              for (const u of found) {
                const k = normalizeUrl(u);
                if (!inlinks.has(k)) inlinks.set(k, new Set());
                inlinks.get(k)!.add(finalUrl);
                if (!depth.has(k) || depth.get(k)! > d + 1) depth.set(k, d + 1);
                if (!seen.has(k)) { seen.add(k); queue.push(u); }
              }
              pages.push({ url: finalUrl, status: r.status, title: r.title.text, titleLength: r.title.length, description: r.metaDescription.text, descriptionLength: r.metaDescription.length, canonical: r.canonical, noindex: /noindex/i.test(r.robots.meta ?? "") || /noindex/i.test(r.robots.header ?? ""), h1Count: r.headings.h1Count, wordCount: r.wordCount, imagesMissingAlt: r.images.missingAlt, internalLinks: r.links.internal, externalLinks: r.links.external, schema: r.structuredData, issues: r.issues.filter((i) => i.severity !== "info").map((i) => i.message), inSitemap: sitemapKeys.has(finalKey) });
            } catch (e) { pages.push({ url, error: (e as Error).message }); }
          });
        }
        const ok = pages.filter((p) => !p.error) as { url: string; title: string; description: string; noindex: boolean; h1Count: number; wordCount: number; imagesMissingAlt: number; inSitemap: boolean; canonical: string | null; status: number }[];
        const dup = (key: "title" | "description") => { const m = new Map<string, string[]>(); for (const p of ok) if (p[key]) m.set(p[key], [...(m.get(p[key]) ?? []), p.url]); return [...m.entries()].filter(([, v]) => v.length > 1).map(([value, urls]) => ({ [key]: value, urls })); };
        const crawledSet = new Set(ok.map((p) => normalizeUrl(p.url)));
        const orphans = [...sitemapUrls].filter((u) => !inlinks.has(normalizeUrl(u)) && normalizeUrl(u) !== normalizeUrl(start));
        const statusCounts: Record<string, number> = {};
        for (const [, st] of linkStatus) statusCounts[String(st)] = (statusCounts[String(st)] ?? 0) + 1;
        const inlinkCounts = ok.map((p) => ({ url: p.url, inlinks: inlinks.get(normalizeUrl(p.url))?.size ?? 0, depth: depth.get(normalizeUrl(p.url)) ?? null })).sort((x, y) => x.inlinks - y.inlinks);
        return {
          startUrl: start,
          crawled: pages.length,
          discovered: seen.size,
          notCrawled: queue.length,
          sitemapUrls: sitemapUrls.size,
          statusCounts,
          brokenInternalLinks: brokenLinks.slice(0, 200),
          redirectChains: redirectChains.filter((r) => r.hops >= 1).slice(0, 200),
          duplicateTitles: dup("title"),
          duplicateDescriptions: dup("description"),
          missingTitle: ok.filter((p) => !p.title).map((p) => p.url),
          missingDescription: ok.filter((p) => !p.description).map((p) => p.url),
          missingH1: ok.filter((p) => p.h1Count === 0).map((p) => p.url),
          multipleH1: ok.filter((p) => p.h1Count > 1).map((p) => p.url),
          noindexPages: ok.filter((p) => p.noindex).map((p) => p.url),
          thinPages: ok.filter((p) => p.wordCount < 300 && !p.noindex).map((p) => ({ url: p.url, words: p.wordCount })),
          canonicalMismatch: ok.filter((p) => p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.url)).map((p) => ({ url: p.url, canonical: p.canonical })),
          imagesMissingAltTotal: ok.reduce((s, p) => s + p.imagesMissingAlt, 0),
          orphanPages: orphans.slice(0, 200),
          crawledNotInSitemap: a.includeSitemap && sitemapUrls.size ? ok.filter((p) => !p.inSitemap && !p.noindex).map((p) => p.url).slice(0, 200) : undefined,
          leastLinkedPages: inlinkCounts.slice(0, 20),
          deepestPages: [...inlinkCounts].filter((x) => x.depth != null).sort((x, y) => (y.depth as number) - (x.depth as number)).slice(0, 10),
          pages: a.includePages ? pages : undefined,
          crawledUrls: crawledSet.size,
        };
      } finally { stop(); }
    }),
  );

  server.registerTool(
    "hreflang_check",
    {
      title: "hreflang / multilingual consistency check",
      description:
        "For a page (or a sitemap sample), read its hreflang alternates and verify: every alternate URL is reachable, points back (reciprocal) to the source, has a self-referencing entry, uses valid language-region codes, has an x-default, and that canonicals do not contradict the alternates. Also compares <html lang> with the declared hreflang.",
      inputSchema: {
        urls: z.array(z.string().url()).max(30).optional(),
        sitemapUrl: z.string().url().optional().describe("Sample pages from a sitemap instead."),
        sampleSize: z.number().int().min(1).max(30).default(10),
      },
    },
    tool(async (a) => {
      let urls = a.urls ?? [];
      if (!urls.length && a.sitemapUrl) { const all = (await collectSitemapUrls(a.sitemapUrl, { maxUrls: 5000 })).urls.map((u) => u.loc); const step = Math.max(1, Math.floor(all.length / a.sampleSize)); urls = all.filter((_, i) => i % step === 0).slice(0, a.sampleSize); }
      if (!urls.length) throw new Error("Provide urls[] or sitemapUrl.");
      const cache = new Map<string, { status: number; alternates: { lang: string; href: string }[]; canonical: string | null; htmlLang: string | null }>();
      const read = async (url: string) => {
        const key = normalizeUrl(url);
        if (cache.has(key)) return cache.get(key)!;
        try {
          const res = await fetchWithTimeout(url);
          const $ = cheerio.load(await res.text());
          const alternates = $('link[rel="alternate"][hreflang]').map((_, el) => ({ lang: ($(el).attr("hreflang") ?? "").toLowerCase(), href: normalizeUrl(new URL($(el).attr("href")!, url).toString()) })).get();
          const canonical = $('link[rel="canonical"]').attr("href") ? normalizeUrl(new URL($('link[rel="canonical"]').attr("href")!, url).toString()) : null;
          const entry = { status: res.status, alternates, canonical, htmlLang: $("html").attr("lang")?.toLowerCase() ?? null };
          cache.set(key, entry);
          return entry;
        } catch (e) { const entry = { status: 0, alternates: [], canonical: null, htmlLang: null }; cache.set(key, entry); return entry; }
      };
      const LANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{2}|-[0-9]{3}|-[a-z]{4})?)$/;
      const results = await mapLimit(urls, 4, async (url) => {
        const src = await read(url);
        const self = normalizeUrl(url);
        const problems: string[] = [];
        if (!src.alternates.length) return { url, alternates: 0, problems: ["No hreflang annotations (fine for single-language sites)"] };
        if (!src.alternates.some((x) => x.href === self || x.href === src.canonical)) problems.push("Missing self-referencing hreflang");
        if (!src.alternates.some((x) => x.lang === "x-default")) problems.push("No x-default entry");
        for (const alt of src.alternates) if (!LANG_RE.test(alt.lang)) problems.push(`Invalid hreflang code '${alt.lang}'`);
        if (src.canonical && src.canonical !== self) problems.push(`Canonical (${src.canonical}) differs from URL; hreflang on a canonicalized page is ignored`);
        const langs = src.alternates.map((x) => x.lang.split("-")[0]).filter((l) => l !== "x");
        if (src.htmlLang && !langs.includes(src.htmlLang.split("-")[0])) problems.push(`<html lang="${src.htmlLang}"> not among declared hreflang languages`);
        const alternates = await mapLimit(src.alternates, 4, async (alt) => {
          const t = await read(alt.href);
          const reciprocal = t.alternates.some((x) => x.href === self || (src.canonical && x.href === src.canonical));
          const issues: string[] = [];
          if (t.status !== 200) issues.push(`HTTP ${t.status}`);
          else if (!reciprocal && alt.href !== self) issues.push("does not link back (non-reciprocal)");
          if (t.canonical && t.canonical !== alt.href) issues.push(`alternate canonicalizes elsewhere (${t.canonical})`);
          return { lang: alt.lang, href: alt.href, status: t.status, reciprocal, issues };
        });
        const langCount = new Map<string, number>();
        for (const x of src.alternates) langCount.set(x.lang, (langCount.get(x.lang) ?? 0) + 1);
        for (const [l, n] of langCount) if (n > 1) problems.push(`hreflang '${l}' declared ${n} times`);
        return { url, htmlLang: src.htmlLang, canonical: src.canonical, alternates: alternates.length, problems, alternateDetails: alternates.filter((x) => x.issues.length) };
      });
      return { checked: results.length, pagesWithProblems: results.filter((r) => r.problems.length || (r.alternateDetails?.length ?? 0) > 0).length, results };
    }),
  );

  server.registerTool(
    "compare_pages",
    {
      title: "Compare your page with competitor pages",
      description:
        "Audit several URLs (yours plus pages ranking above you) side by side: word count, title/description, heading counts and outline, lists/tables, images, internal/external links, schema types, fetch time, HTML size. Also extracts the most frequent content terms of each page and lists terms competitors use that your page lacks (content-gap hint).",
      inputSchema: {
        yourUrl: z.string().url(),
        competitorUrls: z.array(z.string().url()).min(1).max(6),
        gapTerms: z.number().int().min(0).max(60).default(25),
      },
    },
    tool(async (a) => {
      const urls = [a.yourUrl, ...a.competitorUrls];
      const STOP = new Set("the a an of in on to for and or is are with from by at as vs it this that these those you your we our they their be been was were will can not no yes more most very also than then so if but about into over after before up down out all any each other such only own same too just de la el los las en y o del al un una para con por que es se su lo mi tu sus le les como más pero sin sobre entre hasta desde este esta estos estas ese esa eso también muy ya son fue han hay está están puede pueden".split(" "));
      const rows = await mapLimit(urls, 4, async (url) => {
        try {
          const r = await auditPage(url, { maxHeadings: 40, maxImagesMissingAlt: 0 });
          const res = await fetchWithTimeout(r.finalUrl);
          const $ = cheerio.load(await res.text());
          $("script, style, nav, header, footer, noscript").remove();
          const $main = $("main, article").first().length ? $("main, article").first() : $("body");
          const text = $main.text().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ");
          const freq = new Map<string, number>();
          for (const w of text.split(/\s+/)) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
          const terms = [...freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, 80);
          const blocked = r.wordCount < 60 && /checking your browser|just a moment|verify you are human|access denied|enable javascript and cookies/i.test($("body").text());
          return { url, status: r.status, blocked: blocked || undefined, note: blocked ? "Anti-bot page returned instead of content; word counts and terms are not meaningful" : undefined, title: r.title.text, titleLength: r.title.length, descriptionLength: r.metaDescription.length, wordCount: r.wordCount, h1: r.headings.h1Count, h2: r.headings.h2Count, h3: r.headings.h3Count, lists: $main.find("ul, ol").length, tables: $main.find("table").length, images: r.images.total, internalLinks: r.links.internal, externalLinks: r.links.external, schema: r.structuredData, fetchMs: r.fetchMs, htmlKB: Math.round(r.htmlBytes / 1024), outline: r.headings.outline.map((h) => `${h.tag}: ${h.text}`), terms: Object.fromEntries(terms) };
        } catch (e) { return { url, error: (e as Error).message }; }
      });
      const yours = rows[0] as { terms?: Record<string, number>; wordCount?: number };
      const yourTerms = new Set(Object.keys(yours.terms ?? {}));
      const gap = new Map<string, { competitors: number; total: number }>();
      for (const c of rows.slice(1)) if (!(c as { blocked?: boolean }).blocked) for (const [t, n] of Object.entries((c as { terms?: Record<string, number> }).terms ?? {})) if (!yourTerms.has(t)) { const g = gap.get(t) ?? { competitors: 0, total: 0 }; g.competitors++; g.total += n; gap.set(t, g); }
      const gapTerms = [...gap.entries()].sort((x, y) => y[1].competitors - x[1].competitors || y[1].total - x[1].total).slice(0, a.gapTerms).map(([term, g]) => ({ term, usedByCompetitors: g.competitors, occurrences: g.total }));
      const compWords = rows.slice(1).filter((r) => !(r as { blocked?: boolean }).blocked).map((r) => (r as { wordCount?: number }).wordCount ?? 0).filter(Boolean);
      return { yours: { ...rows[0], terms: undefined }, competitors: rows.slice(1).map((r) => ({ ...r, terms: undefined })), wordCountBenchmark: { yours: yours.wordCount ?? 0, competitorAvg: compWords.length ? Math.round(compWords.reduce((s, n) => s + n, 0) / compWords.length) : null, competitorMax: compWords.length ? Math.max(...compWords) : null }, contentGapTerms: gapTerms };
    }),
  );

  server.registerTool(
    "social_preview_check",
    {
      title: "Open Graph / Twitter card preview check",
      description: "Validate how a page previews when shared (social networks, messaging apps, AI chat link cards): og:title/description/image/url/type, twitter:card, image reachability, dimensions (recommended 1200x630), file size and content type, plus fallbacks used when tags are missing.",
      inputSchema: { url: z.string().url() },
    },
    tool(async (a) => {
      const res = await fetchWithTimeout(a.url);
      const $ = cheerio.load(await res.text());
      const meta = (sel: string) => $(sel).first().attr("content")?.trim() ?? null;
      const og = { title: meta('meta[property="og:title"]'), description: meta('meta[property="og:description"]'), image: meta('meta[property="og:image"]'), imageAlt: meta('meta[property="og:image:alt"]'), url: meta('meta[property="og:url"]'), type: meta('meta[property="og:type"]'), siteName: meta('meta[property="og:site_name"]'), locale: meta('meta[property="og:locale"]') };
      const tw = { card: meta('meta[name="twitter:card"]'), title: meta('meta[name="twitter:title"]'), description: meta('meta[name="twitter:description"]'), image: meta('meta[name="twitter:image"]'), site: meta('meta[name="twitter:site"]') };
      const fallback = { title: $("title").first().text().trim() || null, description: meta('meta[name="description"]') };
      const issues: string[] = [];
      if (!og.title) issues.push(`og:title missing (falls back to <title>: ${fallback.title ?? "none"})`);
      if (!og.description) issues.push("og:description missing");
      if (!og.image) issues.push("og:image missing: shares will show no image");
      if (!og.url) issues.push("og:url missing");
      if (!og.type) issues.push("og:type missing (use 'website' or 'article')");
      if (!tw.card) issues.push("twitter:card missing (use 'summary_large_image')");
      let image: Record<string, unknown> | null = null;
      if (og.image) {
        try {
          const imgUrl = new URL(og.image, a.url).toString();
          const ir = await fetchWithTimeout(imgUrl, {}, 20_000);
          const buf = Buffer.from(await ir.arrayBuffer());
          let dims: { width?: number; height?: number; type?: string } = {};
          try { dims = imageSize(buf); } catch { /* not an image */ }
          image = { url: imgUrl, status: ir.status, contentType: ir.headers.get("content-type"), sizeKB: Math.round(buf.length / 1024), width: dims.width ?? null, height: dims.height ?? null, format: dims.type ?? null, absolute: /^https?:\/\//.test(og.image) };
          if (ir.status !== 200) issues.push(`og:image returns HTTP ${ir.status}`);
          if (!/^https?:\/\//.test(og.image)) issues.push("og:image should be an absolute https URL");
          if (dims.width && dims.height) {
            if (dims.width < 1200 || dims.height < 630) issues.push(`og:image is ${dims.width}x${dims.height}; recommended 1200x630 or larger`);
            const ratio = dims.width / dims.height;
            if (Math.abs(ratio - 1.91) > 0.25) issues.push(`og:image aspect ratio ${round(ratio, 2)}; recommended ~1.91:1`);
          } else if (ir.status === 200) issues.push("Could not read og:image dimensions (unsupported format?)");
          if (buf.length > 5 * 1024 * 1024) issues.push("og:image larger than 5 MB; some platforms will drop it");
        } catch (e) { issues.push(`og:image fetch failed: ${(e as Error).message}`); }
      }
      if (og.title && og.title.length > 70) issues.push(`og:title is ${og.title.length} chars; keep under ~70`);
      if (og.description && og.description.length > 200) issues.push(`og:description is ${og.description.length} chars; keep under ~200`);
      return { url: a.url, openGraph: og, twitter: tw, fallback, image, issues, ok: issues.length === 0 };
    }),
  );

  server.registerTool(
    "keyword_suggest",
    {
      title: "Keyword ideas from Google Autocomplete",
      description:
        "Expand a seed keyword using Google Autocomplete suggestions (free, no key): the seed itself, question prefixes (how/what/why/best/cómo/qué...), and optionally a-z suffix expansion. Set language (hl) and country (gl) to match the market, e.g. hl='es', gl='es' or hl='en', gl='gb'. Returns deduplicated suggestions grouped by prefix, useful for long-tail and FAQ ideas.",
      inputSchema: {
        seed: z.string().min(2),
        hl: z.string().default("en").describe("Interface language code."),
        gl: z.string().default("us").describe("Country code."),
        questions: z.boolean().default(true),
        alphabet: z.boolean().default(false).describe("Also expand with 'seed a', 'seed b', ... (26 extra requests)."),
        extraPrefixes: z.array(z.string()).optional().describe("Custom prefixes/suffix words to combine with the seed."),
      },
    },
    tool(async (a) => {
      const prefixesByLang: Record<string, string[]> = {
        en: ["how", "what", "why", "when", "where", "which", "is", "can", "best", "vs", "near", "cheap", "price"],
        es: ["cómo", "qué", "por qué", "cuándo", "dónde", "cuál", "es", "mejor", "precio", "barato", "cerca de", "vs"],
        de: ["wie", "was", "warum", "wann", "wo", "welche", "beste", "preis", "günstig"],
        fr: ["comment", "quoi", "pourquoi", "quand", "où", "quel", "meilleur", "prix", "pas cher"],
        it: ["come", "cosa", "perché", "quando", "dove", "quale", "migliore", "prezzo"],
      };
      const prefixes = a.questions ? (prefixesByLang[a.hl.split("-")[0]] ?? prefixesByLang.en) : [];
      const queries: { label: string; q: string }[] = [{ label: "seed", q: a.seed }, ...prefixes.map((p) => ({ label: p, q: `${p} ${a.seed}` })), ...(a.extraPrefixes ?? []).map((p) => ({ label: p, q: `${p} ${a.seed}` }))];
      if (a.alphabet) for (const c of "abcdefghijklmnopqrstuvwxyz") queries.push({ label: `+${c}`, q: `${a.seed} ${c}` });
      const fetchSuggest = async (q: string): Promise<string[]> => {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(a.hl)}&gl=${encodeURIComponent(a.gl)}&q=${encodeURIComponent(q)}`;
        const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } }, 15_000);
        if (!res.ok) return [];
        const data = (await res.json()) as [string, string[]];
        return Array.isArray(data?.[1]) ? data[1] : [];
      };
      const groups = await mapLimit(queries, 4, async ({ label, q }) => ({ label, query: q, suggestions: await fetchSuggest(q) }));
      const all = new Set<string>();
      for (const g of groups) for (const s of g.suggestions) all.add(s.toLowerCase());
      const questions = [...all].filter((s) => /^(how|what|why|when|where|which|is|can|does|do|should|cómo|qué|por qué|cuándo|dónde|cuál|es|se puede|wie|was|warum|wann|wo|welche|comment|quoi|pourquoi|quand|où|come|cosa|perché|quando|dove|quale)\b/.test(s));
      return { seed: a.seed, hl: a.hl, gl: a.gl, requests: groups.length, uniqueSuggestions: all.size, questions, groups: groups.filter((g) => g.suggestions.length), all: [...all] };
    }),
  );
}
