/**
 * Cross-source analyses: migration_check, cross_site_links, content_refresh_candidates,
 * knowledge_graph_check, crux_history, brand_mentions, reviews_snapshot.
 */
import { z } from "zod";
import * as cheerio from "cheerio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { heartbeat, resolveDate, round, tool } from "../util.js";
import { collectSitemapUrls, fetchWithTimeout } from "./web.js";
import { normalizePath, query as gscQuery } from "./gsc.js";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

const siteUrl = z.string().describe("Search Console property, e.g. 'sc-domain:example.com'.");

export function registerAnalysisTools(server: McpServer) {
  server.registerTool(
    "migration_check",
    {
      title: "Pre-migration URL safety net",
      description:
        "Before pointing a domain at a new (static) site, verify that every URL that matters on the old site still works on the new one. Collects old URLs from Search Console (pages with impressions in the period) and the old sitemap, rewrites each to the new host (e.g. a pages.dev preview), follows redirects, and classifies: OK (200 same path), REDIRECTED (301/302 to a 200 page), REDIRECT_TO_HOME (traffic likely lost), CHAIN (2+ hops), NOT_FOUND (404/410), ERROR. Results are sorted by old-site clicks so the costliest gaps come first.",
      inputSchema: {
        siteUrl,
        oldSitemapUrl: z.string().url().optional().describe("Old site's sitemap (index supported). Defaults to none: only Search Console pages are used."),
        newHost: z.string().describe("Host of the new site to test against, e.g. 'my-site.pages.dev' or 'new.example.com'."),
        startDate: z.string().default("180daysAgo"),
        endDate: z.string().default("3daysAgo"),
        maxUrls: z.number().int().min(1).max(1500).default(600),
        concurrency: z.number().int().min(1).max(8).default(6),
        includeOk: z.boolean().default(false).describe("Include OK rows in the response (otherwise only problems and redirects)."),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "checking URLs on the new host");
      try {
        const gsc = await gscQuery({ siteUrl: a.siteUrl, startDate: a.startDate, endDate: a.endDate, dimensions: ["page"], rowLimit: 25000 });
        const traffic = new Map<string, { clicks: number; impressions: number }>();
        for (const r of gsc) traffic.set(normalizePath(r.keys.page), { clicks: r.clicks, impressions: r.impressions });
        const urls = new Map<string, string>(); // path -> original URL
        for (const r of gsc) urls.set(normalizePath(r.keys.page), r.keys.page);
        let sitemapCount = 0;
        if (a.oldSitemapUrl) { const sm = await collectSitemapUrls(a.oldSitemapUrl, { maxUrls: 5000 }); sitemapCount = sm.urls.length; for (const u of sm.urls) { const p = normalizePath(u.loc); if (!urls.has(p)) urls.set(p, u.loc); } }
        const list = [...urls.entries()].map(([path, url]) => ({ path, url, ...(traffic.get(path) ?? { clicks: 0, impressions: 0 }) })).sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions).slice(0, a.maxUrls);
        const newOrigin = a.newHost.startsWith("http") ? new URL(a.newHost).origin : `https://${a.newHost}`;
        const results = await mapLimit(list, a.concurrency, async (item) => {
          const original = new URL(item.url);
          let current = `${newOrigin}${original.pathname}${original.search}`;
          const hops: { url: string; status: number }[] = [];
          try {
            for (let i = 0; i < 6; i++) {
              const res = await fetchWithTimeout(current, { method: "GET", redirect: "manual" }, 20_000);
              if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { hops.push({ url: current, status: res.status }); current = new URL(res.headers.get("location")!, current).toString(); continue; }
              const finalPath = normalizePath(current);
              let cls: string;
              if (res.status === 200 && hops.length === 0) cls = "OK";
              else if (res.status === 200 && finalPath === "/" && item.path !== "/") cls = "REDIRECT_TO_HOME";
              else if (res.status === 200 && hops.length >= 2) cls = "CHAIN";
              else if (res.status === 200) cls = "REDIRECTED";
              else if (res.status === 404 || res.status === 410) cls = "NOT_FOUND";
              else cls = "ERROR";
              return { path: item.path, clicks: item.clicks, impressions: item.impressions, class: cls, finalUrl: current, finalStatus: res.status, hops: hops.length, redirectTypes: hops.map((h) => h.status) };
            }
            return { path: item.path, clicks: item.clicks, impressions: item.impressions, class: "CHAIN", finalUrl: current, finalStatus: 0, hops: hops.length, redirectTypes: hops.map((h) => h.status) };
          } catch (e) { return { path: item.path, clicks: item.clicks, impressions: item.impressions, class: "ERROR", finalUrl: current, finalStatus: 0, hops: hops.length, error: (e as Error).message }; }
        });
        const summary: Record<string, { urls: number; clicks: number; impressions: number }> = {};
        for (const r of results) { const s = summary[r.class] ?? { urls: 0, clicks: 0, impressions: 0 }; s.urls++; s.clicks += r.clicks; s.impressions += r.impressions; summary[r.class] = s; }
        const totalClicks = results.reduce((s, r) => s + r.clicks, 0);
        const lostClicks = results.filter((r) => ["NOT_FOUND", "ERROR", "REDIRECT_TO_HOME"].includes(r.class)).reduce((s, r) => s + r.clicks, 0);
        return { siteUrl: a.siteUrl, newHost: newOrigin, period: { start: resolveDate(a.startDate), end: resolveDate(a.endDate) }, sources: { searchConsolePages: gsc.length, sitemapUrls: sitemapCount, tested: results.length }, summary, clicksAtRisk: { lost: lostClicks, total: totalClicks, pct: totalClicks ? round((lostClicks / totalClicks) * 100, 1) : 0 }, problems: results.filter((r) => r.class !== "OK" && (a.includeOk || r.class !== "REDIRECTED" || r.hops > 1)), redirected: a.includeOk ? undefined : results.filter((r) => r.class === "REDIRECTED" && r.hops === 1).length, ok: a.includeOk ? results.filter((r) => r.class === "OK") : undefined };
      } finally { stop(); }
    }),
  );

  server.registerTool(
    "cross_site_links",
    {
      title: "Cross-site internal linking opportunities",
      description:
        "For two Search Console properties you own on the same topic, find pages that rank for the same or overlapping queries and suggest links between them (site A page -> site B page and vice versa). Optionally fetches the top candidate pages to check whether a cross-domain link already exists.",
      inputSchema: {
        siteA: siteUrl,
        siteB: siteUrl,
        startDate: z.string().default("90daysAgo"),
        endDate: z.string().default("3daysAgo"),
        minImpressions: z.number().int().min(1).default(5),
        checkExistingLinks: z.number().int().min(0).max(40).default(20).describe("Fetch this many top candidate pages to detect existing links."),
        top: z.number().int().min(1).max(200).default(40),
      },
    },
    tool(async (a) => {
      const [ra, rb] = await Promise.all([
        gscQuery({ siteUrl: a.siteA, startDate: a.startDate, endDate: a.endDate, dimensions: ["query", "page"], rowLimit: 25000 }),
        gscQuery({ siteUrl: a.siteB, startDate: a.startDate, endDate: a.endDate, dimensions: ["query", "page"], rowLimit: 25000 }),
      ]);
      const STOP = new Set("the a an of in on to for and or is are with from by at as de la el los las en y o del al un una para con por que es se su lo".split(" "));
      const terms = (q: string) => q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
      type PQ = { page: string; queries: Map<string, number>; terms: Map<string, number>; impressions: number };
      const build = (rows: typeof ra) => { const m = new Map<string, PQ>(); for (const r of rows) { if (r.impressions < a.minImpressions) continue; const p = m.get(r.keys.page) ?? { page: r.keys.page, queries: new Map(), terms: new Map(), impressions: 0 }; p.queries.set(r.keys.query, r.impressions); for (const t of terms(r.keys.query)) p.terms.set(t, (p.terms.get(t) ?? 0) + r.impressions); p.impressions += r.impressions; m.set(r.keys.page, p); } return [...m.values()]; };
      const A = build(ra), B = build(rb);
      const pairs: { pageA: string; pageB: string; sharedQueries: string[]; sharedTerms: string[]; score: number }[] = [];
      for (const pa of A) for (const pb of B) {
        const sharedQueries = [...pa.queries.keys()].filter((q) => pb.queries.has(q));
        const sharedTerms = [...pa.terms.keys()].filter((t) => pb.terms.has(t));
        const score = sharedQueries.reduce((s, q) => s + (pa.queries.get(q) ?? 0) + (pb.queries.get(q) ?? 0), 0) * 3 + sharedTerms.reduce((s, t) => s + Math.min(pa.terms.get(t) ?? 0, pb.terms.get(t) ?? 0), 0);
        if (sharedQueries.length || sharedTerms.length >= 2) pairs.push({ pageA: pa.page, pageB: pb.page, sharedQueries, sharedTerms: sharedTerms.slice(0, 10), score });
      }
      pairs.sort((x, y) => y.score - x.score);
      const top = pairs.slice(0, a.top);
      const hostA = new URL(top[0]?.pageA ?? "https://a/").hostname, hostB = new URL(top[0]?.pageB ?? "https://b/").hostname;
      const linkCache = new Map<string, Set<string>>();
      const outHosts = async (url: string) => { if (linkCache.has(url)) return linkCache.get(url)!; const set = new Set<string>(); try { const res = await fetchWithTimeout(url); const $ = cheerio.load(await res.text()); $("a[href]").each((_, el) => { try { set.add(new URL($(el).attr("href")!, url).hostname); } catch { /* ignore */ } }); } catch { /* ignore */ } linkCache.set(url, set); return set; };
      const toCheck = [...new Set(top.slice(0, a.checkExistingLinks).flatMap((p) => [p.pageA, p.pageB]))];
      await mapLimit(toCheck, 4, outHosts);
      const withLinks = top.map((p) => ({ ...p, aLinksToB: linkCache.has(p.pageA) ? linkCache.get(p.pageA)!.has(hostB) : null, bLinksToA: linkCache.has(p.pageB) ? linkCache.get(p.pageB)!.has(hostA) : null }));
      return { siteA: a.siteA, siteB: a.siteB, period: { start: resolveDate(a.startDate), end: resolveDate(a.endDate) }, pagesA: A.length, pagesB: B.length, candidatePairs: pairs.length, suggestions: withLinks, note: "Add a contextual link from the page with more authority to the other where the shared query is discussed; avoid sitewide footer links." };
    }),
  );

  server.registerTool(
    "content_refresh_candidates",
    {
      title: "Content refresh candidates (decaying pages)",
      description:
        "Find pages whose clicks or impressions dropped between two periods and that have not been updated recently (sitemap lastmod), with the queries they lost the most on. These are the best candidates for a content refresh: update facts, expand answers, add FAQ, re-publish with a new dateModified.",
      inputSchema: {
        siteUrl,
        sitemapUrl: z.string().url().optional().describe("Sitemap to read lastmod dates from (index supported)."),
        currentStart: z.string().default("90daysAgo"),
        currentEnd: z.string().default("3daysAgo"),
        previousStart: z.string().default("180daysAgo"),
        previousEnd: z.string().default("91daysAgo"),
        minPreviousClicks: z.number().int().min(0).default(3),
        staleDays: z.number().int().min(0).default(120).describe("Consider a page stale if lastmod is older than this many days (or unknown)."),
        top: z.number().int().min(1).max(200).default(30),
      },
    },
    tool(async (a) => {
      const base = { siteUrl: a.siteUrl, dimensions: ["query", "page"] as ("query" | "page")[], rowLimit: 25000 };
      const [cur, prev] = await Promise.all([gscQuery({ ...base, startDate: a.currentStart, endDate: a.currentEnd }), gscQuery({ ...base, startDate: a.previousStart, endDate: a.previousEnd })]);
      type Agg = { clicks: number; impressions: number; queries: Map<string, { clicks: number; impressions: number; position: number | null }> };
      const agg = (rows: typeof cur) => { const m = new Map<string, Agg>(); for (const r of rows) { const p = m.get(r.keys.page) ?? { clicks: 0, impressions: 0, queries: new Map() }; p.clicks += r.clicks; p.impressions += r.impressions; p.queries.set(r.keys.query, { clicks: r.clicks, impressions: r.impressions, position: r.position }); m.set(r.keys.page, p); } return m; };
      const C = agg(cur), P = agg(prev);
      const lastmod = new Map<string, string>();
      if (a.sitemapUrl) for (const u of (await collectSitemapUrls(a.sitemapUrl, { maxUrls: 5000 })).urls) if (u.lastmod) lastmod.set(normalizePath(u.loc), u.lastmod);
      const now = Date.now();
      const rows = [...P.entries()].filter(([, p]) => p.clicks >= a.minPreviousClicks).map(([page, p]) => {
        const c = C.get(page) ?? { clicks: 0, impressions: 0, queries: new Map() };
        const lm = lastmod.get(normalizePath(page));
        const ageDays = lm ? Math.round((now - Date.parse(lm)) / 86_400_000) : null;
        const lostQueries = [...p.queries.entries()].map(([q, pv]) => { const cv = c.queries.get(q); return { query: q, clicksPrev: pv.clicks, clicks: cv?.clicks ?? 0, positionPrev: pv.position, position: cv?.position ?? null, delta: (cv?.clicks ?? 0) - pv.clicks }; }).filter((x) => x.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 5);
        return { page, clicks: c.clicks, clicksPrev: p.clicks, clicksDelta: c.clicks - p.clicks, clicksPct: p.clicks ? round(((c.clicks - p.clicks) / p.clicks) * 100, 1) : null, impressions: c.impressions, impressionsPrev: p.impressions, lastmod: lm ?? null, ageDays, stale: ageDays == null || ageDays > a.staleDays, lostQueries };
      }).filter((r) => r.clicksDelta < 0 || r.impressions < r.impressionsPrev * 0.7).sort((x, y) => x.clicksDelta - y.clicksDelta);
      const staleFirst = [...rows].sort((x, y) => Number(y.stale) - Number(x.stale) || x.clicksDelta - y.clicksDelta);
      return { siteUrl: a.siteUrl, current: { start: resolveDate(a.currentStart), end: resolveDate(a.currentEnd) }, previous: { start: resolveDate(a.previousStart), end: resolveDate(a.previousEnd) }, decliningPages: rows.length, totalClicksLost: rows.reduce((s, r) => s + r.clicksDelta, 0), candidates: staleFirst.slice(0, a.top) };
    }),
  );

  server.registerTool(
    "knowledge_graph_check",
    {
      title: "Entity presence: Google Knowledge Graph + Wikidata",
      description:
        "Check whether a brand/business/place exists as an entity in Wikidata (free, no key) and in Google's Knowledge Graph Search API (needs the 'Knowledge Graph Search API' enabled on the GCP project and a key in GOOGLE_API_KEY or PAGESPEED_API_KEY). AI engines and Google rely on entities to know 'who' a site is; if none exists, the result includes the steps to establish one.",
      inputSchema: { name: z.string().describe("Entity name, e.g. 'Altai Turismo' or 'Casa Sefardí de Sevilla'."), languages: z.array(z.string()).default(["en", "es"]), limit: z.number().int().min(1).max(20).default(5) },
    },
    tool(async (a) => {
      const wikidata = await mapLimit(a.languages, 3, async (lang) => {
        const res = await fetchWithTimeout(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(a.name)}&language=${lang}&uselang=${lang}&limit=${a.limit}&format=json`, {}, 20_000);
        const data = (await res.json()) as { search?: { id: string; label?: string; description?: string; url?: string }[] };
        return { language: lang, results: (data.search ?? []).map((s) => ({ id: s.id, label: s.label, description: s.description, url: `https://www.wikidata.org/wiki/${s.id}` })) };
      });
      const key = process.env.GOOGLE_API_KEY ?? process.env.PAGESPEED_API_KEY;
      let kg: unknown = null;
      if (key) {
        const params = new URLSearchParams({ query: a.name, key, limit: String(a.limit) });
        for (const l of a.languages) params.append("languages", l);
        const res = await fetchWithTimeout(`https://kgsearch.googleapis.com/v1/entities:search?${params}`, {}, 20_000);
        const data = (await res.json()) as { error?: { message?: string }; itemListElement?: { result?: { "@id"?: string; name?: string; "@type"?: string[]; description?: string; detailedDescription?: { url?: string }; url?: string }; resultScore?: number }[] };
        const str = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? str(v[0]) : v && typeof v === "object" && "@value" in (v as object) ? String((v as { "@value": unknown })["@value"]) : undefined);
        kg = data.error ? { error: data.error.message, hint: /not been used|disabled|API key/i.test(data.error.message ?? "") ? "Enable 'Knowledge Graph Search API' in the GCP project and allow it on the API key." : undefined } : (data.itemListElement ?? []).map((e) => ({ id: e.result?.["@id"], name: str(e.result?.name), types: e.result?.["@type"], description: str(e.result?.description), wikipedia: e.result?.detailedDescription?.url, url: e.result?.url, score: e.resultScore }));
      }
      const exactWd = wikidata.some((w) => w.results.some((r) => r.label?.toLowerCase() === a.name.toLowerCase()));
      const exactKg = Array.isArray(kg) && (kg as { name?: string }[]).some((r) => r.name?.toLowerCase() === a.name.toLowerCase());
      return { name: a.name, wikidata, knowledgeGraph: kg ?? "skipped: no GOOGLE_API_KEY / PAGESPEED_API_KEY", found: { wikidata: exactWd, knowledgeGraph: exactKg }, howToEstablish: exactWd && exactKg ? undefined : ["Keep Organization/LocalBusiness schema identical on every page (name, url, logo, address, telephone, sameAs).", "Create and complete a Google Business Profile with the exact same name and website.", "Add sameAs links to all real profiles: Google Maps, TripAdvisor, Instagram, Facebook, YouTube, LinkedIn, Wikidata item.", "Create a Wikidata item (allowed for businesses with verifiable references: official site, press, registries); Wikipedia only if notability is met.", "Get mentioned by name on authoritative third-party sites (tourism boards, press, directories) with consistent NAP."] };
    }),
  );

  server.registerTool(
    "crux_history",
    {
      title: "Core Web Vitals field history (CrUX)",
      description:
        "Real-user Core Web Vitals from the Chrome UX Report History API for an origin or URL: weekly p75 of LCP, INP, CLS, FCP, TTFB over the last ~25 weeks and the share of good/needs-improvement/poor. Needs the 'Chrome UX Report API' enabled on the GCP project and a key in CRUX_API_KEY / GOOGLE_API_KEY / PAGESPEED_API_KEY. Returns 404 when the page has too little traffic for CrUX; try the origin instead.",
      inputSchema: { target: z.string().url().describe("Page URL or origin (https://example.com)."), scope: z.enum(["origin", "url"]).default("origin"), formFactor: z.enum(["PHONE", "DESKTOP", "ALL"]).default("PHONE"), weeks: z.number().int().min(1).max(40).default(12) },
    },
    tool(async (a) => {
      const key = process.env.CRUX_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.PAGESPEED_API_KEY;
      if (!key) throw new Error("No API key. Set CRUX_API_KEY (or reuse PAGESPEED_API_KEY) and enable 'Chrome UX Report API' on the GCP project.");
      const body: Record<string, unknown> = a.scope === "origin" ? { origin: new URL(a.target).origin } : { url: a.target };
      if (a.formFactor !== "ALL") body.formFactor = a.formFactor;
      body.metrics = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte"];
      const res = await fetchWithTimeout(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 30_000);
      const data = (await res.json()) as { error?: { message?: string; status?: string }; record?: { collectionPeriods?: { lastDate: { year: number; month: number; day: number } }[]; metrics?: Record<string, { histogramTimeseries?: { start: number; end?: number; densities: (number | null)[] }[]; percentilesTimeseries?: { p75s: (number | null)[] } }> } };
      if (!res.ok || data.error) throw new Error(`CrUX API: ${data.error?.message ?? `HTTP ${res.status}`}${data.error?.status === "NOT_FOUND" ? " (not enough Chrome traffic for this target; try scope=origin)" : ""}${/not been used|disabled/i.test(data.error?.message ?? "") ? " Hint: enable 'Chrome UX Report API' in the GCP project and allow it on the API key." : ""}`);
      const periods = (data.record?.collectionPeriods ?? []).map((p) => `${p.lastDate.year}-${String(p.lastDate.month).padStart(2, "0")}-${String(p.lastDate.day).padStart(2, "0")}`);
      const n = periods.length;
      const from = Math.max(0, n - a.weeks);
      const names: Record<string, string> = { largest_contentful_paint: "lcpMs", interaction_to_next_paint: "inpMs", cumulative_layout_shift: "cls", first_contentful_paint: "fcpMs", experimental_time_to_first_byte: "ttfbMs" };
      const thresholds: Record<string, [number, number]> = { lcpMs: [2500, 4000], inpMs: [200, 500], cls: [0.1, 0.25], fcpMs: [1800, 3000], ttfbMs: [800, 1800] };
      const metrics: Record<string, unknown> = {};
      for (const [k, m] of Object.entries(data.record?.metrics ?? {})) {
        const label = names[k] ?? k;
        const p75 = (m.percentilesTimeseries?.p75s ?? []).slice(from).map((v) => (v == null ? null : typeof v === "string" ? Number(v) : v));
        const good = (m.histogramTimeseries?.[0]?.densities ?? []).slice(from).map((v) => (v == null ? null : round(v, 3)));
        const latest = p75[p75.length - 1];
        const [g, p] = thresholds[label] ?? [0, 0];
        metrics[label] = { latestP75: latest, rating: latest == null ? null : latest <= g ? "good" : latest <= p ? "needs-improvement" : "poor", p75Series: p75, goodShareSeries: good };
      }
      return { target: body.origin ?? body.url, formFactor: a.formFactor, weeksEnding: periods.slice(from), metrics };
    }),
  );

  server.registerTool(
    "brand_mentions",
    {
      title: "Brand mentions on the web (Brave Search)",
      description:
        "Search the web for pages mentioning a brand name that are not on your own domain, and check whether each mentioning page links to you. Unlinked mentions are outreach targets for links; the list also shows what context AI engines associate with the brand. Requires BRAVE_API_KEY (free tier available at brave.com/search/api).",
      inputSchema: { brand: z.string(), domain: z.string().describe("Your domain, excluded from results and used to detect links."), count: z.number().int().min(1).max(20).default(20), country: z.string().default("es"), language: z.string().default("en"), checkLinks: z.boolean().default(true) },
    },
    tool(async (a) => {
      const key = process.env.BRAVE_API_KEY;
      if (!key) throw new Error("BRAVE_API_KEY is not set. Get a free key at https://brave.com/search/api/ and add it to the MCP env.");
      const q = `"${a.brand}" -site:${a.domain}`;
      const res = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${a.count}&country=${a.country}&search_lang=${a.language}`, { headers: { "X-Subscription-Token": key, Accept: "application/json" } }, 20_000);
      const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; age?: string }[] }; message?: string };
      if (!res.ok) throw new Error(`Brave Search: ${data.message ?? `HTTP ${res.status}`}`);
      const dom = a.domain.replace(/^www\./, "").toLowerCase();
      const results = data.web?.results ?? [];
      const rows = await mapLimit(results, 4, async (r) => {
        let linksToYou: boolean | null = null;
        if (a.checkLinks) { try { const pr = await fetchWithTimeout(r.url, {}, 15_000); const $ = cheerio.load(await pr.text()); linksToYou = $("a[href]").toArray().some((el) => { try { return new URL($(el).attr("href")!, r.url).hostname.replace(/^www\./, "").endsWith(dom); } catch { return false; } }); } catch { linksToYou = null; } }
        return { title: r.title, url: r.url, host: new URL(r.url).hostname, snippet: r.description, age: r.age, linksToYou };
      });
      return { brand: a.brand, query: q, results: rows.length, unlinkedMentions: rows.filter((r) => r.linksToYou === false), linkedMentions: rows.filter((r) => r.linksToYou === true).length, all: rows };
    }),
  );

  server.registerTool(
    "reviews_snapshot",
    {
      title: "Google Business reviews snapshot (Places API)",
      description:
        "Fetch rating, review count and the latest reviews of a Google Business Profile via the Places API (New). Use it as the source for AggregateRating schema and to monitor reputation. Requires GOOGLE_PLACES_API_KEY with 'Places API (New)' enabled (billing must be enabled on the project; Google grants a monthly free allowance).",
      inputSchema: { query: z.string().optional().describe("Business name + city to search, e.g. 'Altai Turismo Sevilla'."), placeId: z.string().optional().describe("Google Place ID if known (skips the search)."), language: z.string().default("en") },
    },
    tool(async (a) => {
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set. Enable 'Places API (New)' on the GCP project (requires billing) and create a key restricted to it.");
      let placeId = a.placeId;
      let candidates: unknown[] = [];
      if (!placeId) {
        if (!a.query) throw new Error("Provide query or placeId.");
        const sr = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount" }, body: JSON.stringify({ textQuery: a.query, languageCode: a.language }) }, 20_000);
        const sd = (await sr.json()) as { error?: { message?: string }; places?: { id: string; displayName?: { text: string }; formattedAddress?: string; rating?: number; userRatingCount?: number }[] };
        if (!sr.ok) throw new Error(`Places API: ${sd.error?.message ?? `HTTP ${sr.status}`}`);
        candidates = (sd.places ?? []).map((p) => ({ placeId: p.id, name: p.displayName?.text, address: p.formattedAddress, rating: p.rating, reviews: p.userRatingCount }));
        placeId = sd.places?.[0]?.id;
        if (!placeId) return { query: a.query, candidates, note: "No place found" };
      }
      const dr = await fetchWithTimeout(`https://places.googleapis.com/v1/places/${placeId}?languageCode=${a.language}`, { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,displayName,formattedAddress,rating,userRatingCount,googleMapsUri,websiteUri,internationalPhoneNumber,reviews,businessStatus,regularOpeningHours" } }, 20_000);
      const d = (await dr.json()) as { error?: { message?: string }; displayName?: { text: string }; formattedAddress?: string; rating?: number; userRatingCount?: number; googleMapsUri?: string; websiteUri?: string; internationalPhoneNumber?: string; businessStatus?: string; reviews?: { rating?: number; relativePublishTimeDescription?: string; publishTime?: string; text?: { text: string }; authorAttribution?: { displayName?: string } }[] };
      if (!dr.ok) throw new Error(`Places API: ${d.error?.message ?? `HTTP ${dr.status}`}`);
      return { placeId, name: d.displayName?.text, address: d.formattedAddress, phone: d.internationalPhoneNumber, website: d.websiteUri, mapsUrl: d.googleMapsUri, status: d.businessStatus, rating: d.rating, reviewCount: d.userRatingCount, latestReviews: (d.reviews ?? []).map((r) => ({ rating: r.rating, when: r.relativePublishTimeDescription, date: r.publishTime, author: r.authorAttribution?.displayName, text: r.text?.text?.slice(0, 500) })), aggregateRatingSchema: d.rating ? { "@type": "AggregateRating", ratingValue: d.rating, reviewCount: d.userRatingCount, bestRating: 5 } : null, otherCandidates: candidates.slice(1) };
    }),
  );
}
