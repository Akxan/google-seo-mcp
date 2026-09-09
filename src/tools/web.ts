/**
 * Page-level checks that need no Google authorization:
 * page_audit, pagespeed, sitemap_check, robots_check.
 */
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import * as cheerio from "cheerio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { heartbeat, round, tool } from "../util.js";

const UA = "Mozilla/5.0 (compatible; google-seo-mcp/0.1; +https://github.com/Akxan/google-seo-mcp)";

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "*/*", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** Follow redirects manually so the chain can be reported. */
async function fetchFollow(url: string, maxHops = 6): Promise<{ response: Response; chain: { url: string; status: number }[] }> {
  const chain: { url: string; status: number }[] = [];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchWithTimeout(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      chain.push({ url: current, status: res.status });
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return { response: res, chain };
  }
  throw new Error(`Too many redirects starting at ${url}`);
}

export async function collectSitemapUrls(sitemapUrl: string, opts: { maxSitemaps?: number; maxUrls?: number } = {}) {
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const maxUrls = opts.maxUrls ?? 50_000;
  const urls: { loc: string; lastmod?: string; sitemap: string }[] = [];
  const sitemaps: { url: string; type: "index" | "urlset" | "error"; count: number; error?: string }[] = [];
  const queue = [sitemapUrl];
  const seen = new Set<string>();
  while (queue.length && sitemaps.length < maxSitemaps && urls.length < maxUrls) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await fetchWithTimeout(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let body: string;
      const buf = Buffer.from(await res.arrayBuffer());
      body = u.endsWith(".gz") || res.headers.get("content-type")?.includes("gzip") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      if (/<sitemapindex/i.test(body)) {
        const children = [...body.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
        sitemaps.push({ url: u, type: "index", count: children.length });
        queue.push(...children);
      } else {
        const entries = [...body.matchAll(/<url>([\s\S]*?)<\/url>/gi)];
        let n = 0;
        for (const e of entries) {
          const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(e[1])?.[1];
          if (!loc) continue;
          const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(e[1])?.[1];
          urls.push({ loc: decodeXml(loc), lastmod, sitemap: u });
          n++;
          if (urls.length >= maxUrls) break;
        }
        sitemaps.push({ url: u, type: "urlset", count: n });
      }
    } catch (err) {
      sitemaps.push({ url: u, type: "error", count: 0, error: (err as Error).message });
    }
  }
  return { sitemaps, urls, truncated: queue.length > 0 || urls.length >= maxUrls };
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/* ---------- robots.txt ---------- */

interface RobotsGroup { agents: string[]; rules: { type: "allow" | "disallow"; path: string }[] }

export function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (current) current.rules.push({ type: key, path: val });
      lastWasAgent = false;
    } else if (key === "sitemap") {
      sitemaps.push(val);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function robotsPatternToRegex(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp("^" + re);
}

export function robotsAllows(parsed: ReturnType<typeof parseRobots>, url: string, userAgent = "googlebot") {
  const path = (() => { const u = new URL(url); return u.pathname + u.search; })();
  const ua = userAgent.toLowerCase();
  let group = parsed.groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!group) group = parsed.groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matchedRule: null, group: null };
  let best: { type: "allow" | "disallow"; path: string } | null = null;
  for (const r of group.rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    if (robotsPatternToRegex(r.path).test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === "allow")) best = r;
    }
  }
  return { allowed: !best || best.type === "allow", matchedRule: best, group: group.agents };
}

export interface AuditOptions { maxHeadings?: number; maxImagesMissingAlt?: number }
export type AuditResult = Awaited<ReturnType<typeof auditPage>>;

/** Core of page_audit, reused by site_crawl and compare_pages. */
export async function auditPage(url: string, opts: AuditOptions = {}) {
  const a = { url, maxHeadings: opts.maxHeadings ?? 60, maxImagesMissingAlt: opts.maxImagesMissingAlt ?? 20 };
  const t0 = Date.now();
  const { response, chain } = await fetchFollow(a.url);
  const html = await response.text();
  const ms = Date.now() - t0;
  const finalUrl = response.url || (chain.length ? undefined : a.url) || a.url;
  const $ = cheerio.load(html);
  const base = new URL(finalUrl);
  const text = (sel: string) => $(sel).first().text().trim();
  const attr = (sel: string, n: string) => $(sel).first().attr(n)?.trim();

  const title = text("title");
  const description = attr('meta[name="description"]', "content") ?? "";
  const metaRobots = attr('meta[name="robots"]', "content") ?? "";
  const xRobots = response.headers.get("x-robots-tag") ?? "";
  const canonical = attr('link[rel="canonical"]', "href");
  const canonicalAbs = canonical ? new URL(canonical, finalUrl).toString() : undefined;
  const lang = $("html").attr("lang");
  const hreflang = $('link[rel="alternate"][hreflang]').map((_, el) => ({ hreflang: $(el).attr("hreflang"), href: $(el).attr("href") })).get();
  const og = Object.fromEntries($('meta[property^="og:"]').map((_, el) => [[$(el).attr("property"), $(el).attr("content")]]).get());
  const headings = $("h1, h2, h3").map((_, el) => ({ tag: el.tagName.toLowerCase(), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 160) })).get();
  const h1s = headings.filter((h) => h.tag === "h1");
  const imgs = $("img").toArray();
  const missingAlt = imgs.filter((el) => !($(el).attr("alt") ?? "").trim()).map((el) => $(el).attr("src") ?? $(el).attr("data-src") ?? "(no src)");
  let internal = 0, external = 0, nofollow = 0;
  const internalUrls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")!.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    let u: URL;
    try { u = new URL(href, finalUrl); } catch { return; }
    if (u.hostname === base.hostname) { internal++; internalUrls.add(u.pathname); } else external++;
    if (/\bnofollow\b/i.test($(el).attr("rel") ?? "")) nofollow++;
  });
  $("script, style, noscript, template").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;
  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const walk = (n: unknown) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") { const t = (n as { "@type"?: unknown })["@type"]; if (t) jsonLdTypes.push(...(Array.isArray(t) ? t : [t]).map(String)); if ((n as { "@graph"?: unknown })["@graph"]) walk((n as { "@graph"?: unknown })["@graph"]); } };
      walk(data);
    } catch { jsonLdTypes.push("(invalid JSON-LD)"); }
  });

  const issues: { severity: "error" | "warning" | "info"; message: string }[] = [];
  const add = (severity: "error" | "warning" | "info", message: string) => issues.push({ severity, message });
  if (response.status !== 200) add("error", `HTTP status ${response.status}`);
  if (chain.length) add("info", `Reached via ${chain.length} redirect(s): ${chain.map((c) => `${c.status} ${c.url}`).join(" -> ")}`);
  if (!title) add("error", "Missing <title>");
  else if (title.length > 60) add("warning", `Title is ${title.length} chars (aim for 30-60)`);
  else if (title.length < 30) add("info", `Title is short (${title.length} chars)`);
  if (!description) add("warning", "Missing meta description");
  else if (description.length > 160) add("warning", `Meta description is ${description.length} chars (aim for 120-155)`);
  else if (description.length < 70) add("info", `Meta description is short (${description.length} chars)`);
  if (/noindex/i.test(metaRobots) || /noindex/i.test(xRobots)) add("error", "Page is noindex");
  if (!canonicalAbs) add("warning", "No canonical link");
  else if (canonicalAbs.replace(/\/$/, "") !== finalUrl.replace(/\/$/, "")) add("warning", `Canonical points elsewhere: ${canonicalAbs}`);
  if (h1s.length === 0) add("warning", "No H1");
  else if (h1s.length > 1) add("warning", `${h1s.length} H1 tags`);
  if (missingAlt.length) add("warning", `${missingAlt.length} of ${imgs.length} images have no alt text`);
  if (wordCount < 300) add("info", `Thin content: ${wordCount} words`);
  if (!lang) add("info", "No lang attribute on <html>");
  if (!$('meta[name="viewport"]').length) add("warning", "No viewport meta tag");
  if (!jsonLdTypes.length) add("info", "No JSON-LD structured data");

  return {
    requestedUrl: a.url,
    finalUrl,
    status: response.status,
    redirectChain: chain,
    fetchMs: ms,
    htmlBytes: Buffer.byteLength(html),
    contentType: response.headers.get("content-type"),
    title: { text: title, length: title.length },
    metaDescription: { text: description, length: description.length },
    robots: { meta: metaRobots || null, header: xRobots || null },
    canonical: canonicalAbs ?? null,
    lang: lang ?? null,
    hreflang,
    openGraph: og,
    headings: { h1Count: h1s.length, h2Count: headings.filter((h) => h.tag === "h2").length, h3Count: headings.filter((h) => h.tag === "h3").length, outline: headings.slice(0, a.maxHeadings) },
    images: { total: imgs.length, missingAlt: missingAlt.length, missingAltSamples: missingAlt.slice(0, a.maxImagesMissingAlt) },
    links: { internal, internalUnique: internalUrls.size, external, nofollow },
    wordCount,
    structuredData: [...new Set(jsonLdTypes)],
    issues,
  };
}

/* ---------- registration ---------- */

export function registerWebTools(server: McpServer) {
  server.registerTool(
    "page_audit",
    {
      title: "On-page SEO audit of a URL",
      description:
        "Fetch a page like a crawler and report: final URL and redirect chain, status, title, meta description, robots (meta + X-Robots-Tag), canonical, lang/hreflang, Open Graph, H1/H2/H3 outline, images missing alt, internal/external/nofollow link counts, word count, JSON-LD schema types, HTML size and fetch time, plus a list of flagged issues. Works for any site, no authorization needed.",
      inputSchema: {
        url: z.string().url(),
        maxHeadings: z.number().int().min(0).max(200).default(60).describe("How many H1-H3 headings to include in the outline."),
        maxImagesMissingAlt: z.number().int().min(0).max(200).default(20),
      },
    },
    tool(async (a) => auditPage(a.url, a)),
  );

  server.registerTool(
    "pagespeed",
    {
      title: "PageSpeed Insights / Core Web Vitals",
      description:
        "Run Google PageSpeed Insights for a URL. Returns Lighthouse category scores (performance, SEO, accessibility, best practices), lab metrics (LCP, CLS, TBT, FCP, Speed Index), real-user CrUX field data (LCP, CLS, INP) when available, and the top improvement opportunities with estimated savings. Set PAGESPEED_API_KEY for a higher quota. Each run takes 15-60 s; Google caches results for a short while, so if a call times out simply call again. A 'Lighthouse returned error' after retry usually means the page never becomes idle (endless animations/JS) and cannot be audited by PSI.",
      inputSchema: {
        url: z.string().url(),
        strategy: z.enum(["mobile", "desktop", "both"]).default("mobile"),
        categories: z.array(z.enum(["performance", "seo", "accessibility", "best-practices"])).default(["performance", "seo"]),
        topOpportunities: z.number().int().min(0).max(20).default(8),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "waiting for PageSpeed Insights");
      try {
      const run = async (strategy: "mobile" | "desktop") => {
        const params = new URLSearchParams({ url: a.url, strategy });
        for (const c of a.categories) params.append("category", c);
        if (process.env.PAGESPEED_API_KEY) params.set("key", process.env.PAGESPEED_API_KEY);
        const fetchOnce = async () => {
          const res = await fetchWithTimeout(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {}, 150_000);
          const data = (await res.json()) as PsiResponse;
          if (!res.ok || data.error) throw new Error(`PageSpeed API: ${data.error?.message ?? `HTTP ${res.status}`}`);
          return data;
        };
        let data: PsiResponse;
        try {
          data = await fetchOnce();
        } catch (err) {
          if (!/Lighthouse returned error|Something went wrong|HTTP 5\d\d/.test((err as Error).message)) throw err;
          data = await fetchOnce(); // one retry for transient Lighthouse failures
        }
        const lh = data.lighthouseResult;
        const audits = lh?.audits ?? {};
        const num = (id: string) => audits[id]?.numericValue;
        const field = data.loadingExperience?.metrics ?? {};
        const fieldMetric = (k: string) => (field[k] ? { p75: field[k].percentile, category: field[k].category } : null);
        const opportunities = Object.values(audits)
          .filter((x) => x.details?.type === "opportunity" && (x.details.overallSavingsMs ?? 0) > 0)
          .sort((x, y) => (y.details?.overallSavingsMs ?? 0) - (x.details?.overallSavingsMs ?? 0))
          .slice(0, a.topOpportunities)
          .map((x) => ({ id: x.id, title: x.title, savingsMs: Math.round(x.details?.overallSavingsMs ?? 0), score: x.score }));
        const failedSeo = Object.values(audits).filter((x) => lh?.categories?.seo?.auditRefs?.some((r) => r.id === x.id) && x.score !== null && x.score !== undefined && x.score < 1 && x.scoreDisplayMode !== "notApplicable").map((x) => ({ id: x.id, title: x.title }));
        return {
          strategy,
          scores: Object.fromEntries(Object.entries(lh?.categories ?? {}).map(([k, v]) => [k, v.score == null ? null : Math.round(v.score * 100)])),
          lab: { lcpMs: Math.round(num("largest-contentful-paint") ?? -1), cls: round(num("cumulative-layout-shift"), 3), tbtMs: Math.round(num("total-blocking-time") ?? -1), fcpMs: Math.round(num("first-contentful-paint") ?? -1), speedIndexMs: Math.round(num("speed-index") ?? -1) },
          field: data.loadingExperience?.overall_category ? { overall: data.loadingExperience.overall_category, lcp: fieldMetric("LARGEST_CONTENTFUL_PAINT_MS"), cls: fieldMetric("CUMULATIVE_LAYOUT_SHIFT_SCORE"), inp: fieldMetric("INTERACTION_TO_NEXT_PAINT"), fcp: fieldMetric("FIRST_CONTENTFUL_PAINT_MS") } : null,
          opportunities,
          failedSeoAudits: failedSeo,
          lighthouseVersion: lh?.lighthouseVersion,
        };
      };
      const strategies: ("mobile" | "desktop")[] = a.strategy === "both" ? ["mobile", "desktop"] : [a.strategy];
      const results = await Promise.all(strategies.map(run));
      return { url: a.url, results };
      } finally {
        stop();
      }
    }),
  );

  server.registerTool(
    "sitemap_check",
    {
      title: "Sitemap fetch and URL health check",
      description:
        "Fetch a sitemap (sitemap index supported, .gz supported), list its URLs, and check the HTTP status of a sample (or all) of them to find 404s, redirects and server errors. Pass a site root to auto-discover the sitemap from robots.txt or /sitemap.xml.",
      inputSchema: {
        url: z.string().url().describe("Sitemap URL, or the site root (e.g. https://example.com/) to auto-discover."),
        sampleSize: z.number().int().min(0).max(500).default(50).describe("How many URLs to status-check (0 = list only). Sampled evenly across the sitemap."),
        checkAll: z.boolean().default(false).describe("Check every URL (capped at 500)."),
        listUrls: z.boolean().default(false).describe("Include the full URL list in the response."),
        concurrency: z.number().int().min(1).max(10).default(5),
      },
    },
    tool(async (a) => {
      let sitemapUrl = a.url;
      const u = new URL(a.url);
      if (u.pathname === "/" || u.pathname === "") {
        let found: string | undefined;
        try {
          const robots = await fetchWithTimeout(new URL("/robots.txt", u).toString());
          if (robots.ok) found = parseRobots(await robots.text()).sitemaps[0];
        } catch { /* ignore */ }
        sitemapUrl = found ?? new URL("/sitemap.xml", u).toString();
      }
      const { sitemaps, urls, truncated } = await collectSitemapUrls(sitemapUrl);
      const n = a.checkAll ? Math.min(urls.length, 500) : Math.min(a.sampleSize, urls.length);
      const step = n ? urls.length / n : 0;
      const sample = n ? Array.from({ length: n }, (_, i) => urls[Math.floor(i * step)]) : [];
      const checked = await mapLimit(sample, a.concurrency, async (entry) => {
        try {
          let res = await fetchWithTimeout(entry.loc, { method: "HEAD", redirect: "manual" }, 15_000);
          if (res.status === 405 || res.status === 403) res = await fetchWithTimeout(entry.loc, { method: "GET", redirect: "manual" }, 15_000);
          return { url: entry.loc, status: res.status, location: res.headers.get("location") ?? undefined };
        } catch (err) {
          return { url: entry.loc, status: 0, error: (err as Error).message };
        }
      });
      const statusCounts: Record<string, number> = {};
      for (const c of checked) statusCounts[String(c.status)] = (statusCounts[String(c.status)] ?? 0) + 1;
      const problems = checked.filter((c) => c.status !== 200);
      const lastmods = urls.map((x) => x.lastmod).filter(Boolean).sort();
      return {
        sitemapUrl,
        sitemaps,
        totalUrls: urls.length,
        truncated,
        lastmodRange: lastmods.length ? { oldest: lastmods[0], newest: lastmods[lastmods.length - 1], withLastmod: lastmods.length } : null,
        checked: checked.length,
        statusCounts,
        problems,
        urls: a.listUrls ? urls.map((x) => x.loc) : undefined,
      };
    }),
  );

  server.registerTool(
    "robots_check",
    {
      title: "robots.txt check",
      description: "Fetch a site's robots.txt, show its groups and sitemap lines, and test whether specific URLs are crawlable for a given user agent (default Googlebot) using Google's longest-match rules.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1).describe("URLs to test. robots.txt is fetched from the first URL's origin."),
        userAgent: z.string().default("Googlebot"),
      },
    },
    tool(async (a) => {
      const origin = new URL(a.urls[0]).origin;
      const res = await fetchWithTimeout(`${origin}/robots.txt`);
      if (res.status === 404) return { origin, robotsTxt: null, note: "No robots.txt (404): everything is crawlable", results: a.urls.map((url) => ({ url, allowed: true })) };
      if (!res.ok) throw new Error(`robots.txt returned HTTP ${res.status}`);
      const body = await res.text();
      const parsed = parseRobots(body);
      return {
        origin,
        groups: parsed.groups.map((g) => ({ agents: g.agents, rules: g.rules.length, disallow: g.rules.filter((r) => r.type === "disallow").map((r) => r.path), allow: g.rules.filter((r) => r.type === "allow").map((r) => r.path) })),
        sitemaps: parsed.sitemaps,
        userAgent: a.userAgent,
        results: a.urls.map((url) => ({ url, ...robotsAllows(parsed, url, a.userAgent) })),
      };
    }),
  );
}

interface PsiResponse {
  error?: { message?: string };
  loadingExperience?: { overall_category?: string; metrics?: Record<string, { percentile: number; category: string }> };
  lighthouseResult?: {
    lighthouseVersion?: string;
    categories?: Record<string, { score?: number | null; auditRefs?: { id: string }[] }>;
    audits?: Record<string, { id: string; title: string; score?: number | null; scoreDisplayMode?: string; numericValue?: number; details?: { type?: string; overallSavingsMs?: number } }>;
  };
}
