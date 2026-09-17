/**
 * Cross-source analyses: migration_check, cross_site_links, content_refresh_candidates,
 * knowledge_graph_check, crux_history, brand_mentions, reviews_snapshot.
 */
import { z } from "zod";
import { envValue } from "../env.js";
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

/* ---------- CrUX (Chrome UX Report) shared bits ---------- */

const CRUX_NAMES: Record<string, string> = { largest_contentful_paint: "lcpMs", interaction_to_next_paint: "inpMs", cumulative_layout_shift: "cls", first_contentful_paint: "fcpMs", experimental_time_to_first_byte: "ttfbMs", round_trip_time: "rttMs" };
const CRUX_THRESHOLDS: Record<string, [number, number]> = { lcpMs: [2500, 4000], inpMs: [200, 500], cls: [0.1, 0.25], fcpMs: [1800, 3000], ttfbMs: [800, 1800] };

/** Google's good / needs-improvement / poor buckets for a p75 value; null for metrics without public thresholds (RTT). */
export function cruxRating(label: string, value: number | null): string | null {
  const t = CRUX_THRESHOLDS[label];
  if (!t || value == null) return null;
  return value <= t[0] ? "good" : value <= t[1] ? "needs-improvement" : "poor";
}

function cruxKey(): string {
  const key = envValue("CRUX_API_KEY") ?? envValue("GOOGLE_API_KEY") ?? envValue("PAGESPEED_API_KEY");
  if (!key) throw new Error("No API key. Set CRUX_API_KEY (or reuse PAGESPEED_API_KEY) and enable 'Chrome UX Report API' on the GCP project: https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com");
  return key;
}

/**
 * Which phase of LCP to attack first. CrUX reports each sub-part's own p75, so they do not add up to the
 * LCP p75; they are compared as shares of their sum, which is what Google's own LCP breakdown guidance does.
 */
export function diagnoseLcp(parts: Record<string, number | null>): { dominant: string | null; shares: Record<string, number>; advice: string | null } {
  const advice: Record<string, string> = {
    ttfbMs: "Server response dominates: cache HTML at the edge/CDN, cut slow plugin or database work, keep redirects off the critical path.",
    resourceLoadDelayMs: "The LCP image is discovered late: preload it, remove loading=lazy and fetchpriority=low from it, and avoid loading it from CSS or JavaScript.",
    resourceLoadDurationMs: "The LCP image transfer is slow: serve a smaller WebP/AVIF at the displayed size, set width/height, and serve it from a CDN.",
    elementRenderDelayMs: "Rendering is blocked after the resource arrived: defer non-critical JS/CSS, inline critical CSS, use font-display: swap, and avoid client-side hydration of the hero.",
  };
  const entries = Object.entries(parts).filter(([, v]) => typeof v === "number") as [string, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!entries.length || total <= 0) return { dominant: null, shares: {}, advice: null };
  const shares = Object.fromEntries(entries.map(([k, v]) => [k, round(v / total, 3) ?? 0]));
  const dominant = entries.sort((x, y) => y[1] - x[1])[0][0];
  return { dominant, shares, advice: advice[dominant] ?? null };
}

const ymd = (d?: { year: number; month: number; day: number }) => (d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);

/* ---------- Wikipedia / Wikimedia ---------- */

/** Language and article title out of a Wikipedia URL; null when the input is not one. */
export function parseWikipediaUrl(input: string): { language: string; title: string } | null {
  try {
    const u = new URL(input);
    const m = /^([a-z0-9-]+)\.(?:m\.)?wikipedia\.org$/i.exec(u.hostname);
    if (!m) return null;
    const fromPath = /^\/wiki\/(.+)$/.exec(decodeURIComponent(u.pathname))?.[1];
    const title = fromPath ?? u.searchParams.get("title") ?? null;
    return title ? { language: m[1].toLowerCase(), title: title.replace(/_/g, " ") } : null;
  } catch { return null; }
}

/** Monthly pageview items from the Wikimedia API: totals, peak, year-over-year trend and the strongest calendar months. */
export function summarizePageviews(items: { timestamp: string; views: number }[]) {
  const months = items.map((i) => ({ month: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}`, views: i.views })).sort((x, y) => x.month.localeCompare(y.month));
  const sum = (list: { views: number }[]) => list.reduce((s, m) => s + m.views, 0);
  const total = sum(months);
  const last12 = months.slice(-12), prev12 = months.slice(-24, -12);
  const byCalendarMonth = new Map<string, number[]>();
  for (const m of months) byCalendarMonth.set(m.month.slice(5), [...(byCalendarMonth.get(m.month.slice(5)) ?? []), m.views]);
  const strongestMonths = [...byCalendarMonth.entries()].map(([month, v]) => ({ month, avgViews: Math.round(v.reduce((s, n) => s + n, 0) / v.length) })).sort((x, y) => y.avgViews - x.avgViews).slice(0, 3);
  return {
    months,
    totalViews: total,
    monthlyAvg: months.length ? Math.round(total / months.length) : 0,
    peak: months.length ? months.reduce((b, m) => (m.views > b.views ? m : b)) : null,
    lastMonth: months[months.length - 1] ?? null,
    last12Months: sum(last12),
    previous12Months: sum(prev12),
    yoyPct: prev12.length && sum(prev12) > 0 ? round(((sum(last12) - sum(prev12)) / sum(prev12)) * 100, 1) : null,
    strongestMonths,
  };
}

/* ---------- Internet Archive (Wayback CDX) ---------- */

/** Bare host of a Search Console property ('sc-domain:example.com' / 'https://www.example.com/' -> 'example.com'). */
export function hostFromProperty(property: string): string {
  return property.trim().replace(/^sc-domain:/i, "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
}

/** CDX query for every distinct URL the Internet Archive ever captured with a 200 on a domain (free, no key). */
export function waybackCdxUrl(host: string, limit: number, fromYear?: number): string {
  const p = new URLSearchParams({ url: hostFromProperty(host), matchType: "domain", output: "json", collapse: "urlkey", "filter": "statuscode:200", fl: "original,timestamp", limit: String(limit) });
  if (fromYear) p.set("from", String(fromYear));
  return `https://web.archive.org/cdx/search/cdx?${p}`;
}

const ARCHIVE_NOISE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|pdf|zip|gz|mp4|mp3|woff2?|ttf|eot|xml|json|txt|rss)$/i;

/** CDX rows ([[header],[original,timestamp],...]) reduced to distinct page URLs on the host, newest capture first. */
export function parseCdxRows(rows: unknown, host: string): { url: string; lastCapture: string | null }[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  const body = Array.isArray(rows[0]) && String((rows[0] as string[])[0]).toLowerCase() === "original" ? rows.slice(1) : rows;
  const bare = hostFromProperty(host);
  const out = new Map<string, { url: string; lastCapture: string | null }>();
  for (const r of body) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    let u: URL;
    try { u = new URL(r[0]); } catch { continue; }
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h !== bare && !h.endsWith(`.${bare}`)) continue;
    if (ARCHIVE_NOISE.test(u.pathname)) continue;
    if (/\/(wp-admin|wp-json|wp-content|wp-includes|cgi-bin)\//i.test(u.pathname) || /\/feed\/?$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = `${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`.toLowerCase();
    const ts = typeof r[1] === "string" ? r[1] : null;
    const prev = out.get(key);
    if (!prev || (ts && prev.lastCapture && ts > prev.lastCapture)) out.set(key, { url: u.toString(), lastCapture: ts });
  }
  return [...out.values()].sort((x, y) => (y.lastCapture ?? "").localeCompare(x.lastCapture ?? ""));
}

export function registerAnalysisTools(server: McpServer) {
  server.registerTool(
    "migration_check",
    {
      title: "Pre-migration URL safety net",
      description:
        "Pre-migration check: collect old URLs from Search Console (pages with impressions), the old sitemap and optionally the Internet Archive, test each on the new host, classify OK / REDIRECTED / REDIRECT_TO_HOME / CHAIN / NOT_FOUND / ERROR, sorted by old-site clicks. Search Console only remembers 16 months of URLs that got impressions, so on an old site turn on includeWayback (and raise maxUrls) to recover the rest.",
      inputSchema: {
        siteUrl,
        oldSitemapUrl: z.string().url().optional().describe("Old site's sitemap (index supported). Defaults to none: only Search Console pages are used."),
        newHost: z.string().describe("Host of the new site to test against, e.g. 'my-site.pages.dev' or 'new.example.com'."),
        startDate: z.string().default("180daysAgo"),
        endDate: z.string().default("3daysAgo"),
        includeWayback: z.boolean().default(false).describe("Also pull historical URLs of the domain from the Internet Archive CDX API (free, no key). Finds pages Search Console has dropped; these have no click data, so raise maxUrls."),
        waybackLimit: z.number().int().min(10).max(10000).default(1000).describe("Max archived URLs to request."),
        waybackFromYear: z.number().int().min(1996).max(2100).optional().describe("Only captures from this year on, e.g. 2015, to skip a long-gone version of the site."),
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
        let waybackCount = 0, waybackNew = 0;
        let waybackError: string | undefined;
        if (a.includeWayback) {
          const host = hostFromProperty(a.siteUrl);
          try {
            const res = await fetchWithTimeout(waybackCdxUrl(host, a.waybackLimit, a.waybackFromYear), { headers: { Accept: "application/json" } }, 120_000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rows = parseCdxRows(await res.json(), host);
            waybackCount = rows.length;
            for (const r of rows) { const p = normalizePath(r.url); if (!urls.has(p)) { urls.set(p, r.url); waybackNew++; } }
          } catch (e) { waybackError = `Internet Archive lookup failed: ${(e as Error).message}`; }
        }
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
        return { siteUrl: a.siteUrl, newHost: newOrigin, period: { start: resolveDate(a.startDate), end: resolveDate(a.endDate) }, sources: { searchConsolePages: gsc.length, sitemapUrls: sitemapCount, waybackUrls: a.includeWayback ? waybackCount : undefined, waybackOnlyUrls: a.includeWayback ? waybackNew : undefined, waybackError, knownUrls: urls.size, tested: results.length }, summary, clicksAtRisk: { lost: lostClicks, total: totalClicks, pct: totalClicks ? round((lostClicks / totalClicks) * 100, 1) : 0 }, problems: results.filter((r) => r.class !== "OK" && (a.includeOk || r.class !== "REDIRECTED" || r.hops > 1)), redirected: a.includeOk ? undefined : results.filter((r) => r.class === "REDIRECTED" && r.hops === 1).length, ok: a.includeOk ? results.filter((r) => r.class === "OK") : undefined };
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
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "comparing the two properties");
      try {
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
      } finally { stop(); }
    }),
  );

  server.registerTool(
    "content_refresh_candidates",
    {
      title: "Content refresh candidates (decaying pages)",
      description:
        "Pages that used to perform and no longer do. Finds pages whose clicks or impressions dropped between two periods and that have not been updated recently (sitemap lastmod), with the queries they lost the most on. Use it for deciding what to rewrite; gsc_opportunities is for what to push over the line. Best candidates for a content refresh: update facts, expand answers, add FAQ, re-publish with a new dateModified.",
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
        "Check whether a brand/business/place exists as an entity in Wikidata (free, no key) and in Google's Knowledge Graph Search API (needs the 'Knowledge Graph Search API' enabled on the GCP project and a key in GOOGLE_API_KEY or PAGESPEED_API_KEY). AI engines and Google rely on entities to know 'who' a site is; if none exists, the result includes the steps to establish one. Narrow a generic heritage or place name with types, or pass ids to follow one known entity over time instead of searching by name again.",
      inputSchema: {
        name: z.string().describe("Entity name, e.g. 'Altai Turismo' or 'Casa Sefardí de Sevilla'."),
        languages: z.array(z.string()).default(["en", "es"]),
        limit: z.number().int().min(1).max(20).default(5),
        types: z.array(z.string()).max(10).optional().describe("Restrict Knowledge Graph hits to these schema.org types, e.g. ['Organization','Place','TouristAttraction'] - the fastest way to cut the noise around a generic monument or town name."),
        ids: z.array(z.string()).max(10).optional().describe("Look up known Knowledge Graph entity ids instead of searching by name, e.g. ['kg:/m/02_286'] as printed by a previous run (the 'kg:' prefix is stripped automatically). Tracks the same entity over time without re-matching the name."),
      },
    },
    tool(async (a) => {
      const wikidata = await mapLimit(a.languages, 3, async (lang) => {
        const res = await fetchWithTimeout(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(a.name)}&language=${lang}&uselang=${lang}&limit=${a.limit}&format=json`, {}, 20_000);
        const data = (await res.json()) as { search?: { id: string; label?: string; description?: string; url?: string }[] };
        return { language: lang, results: (data.search ?? []).map((s) => ({ id: s.id, label: s.label, description: s.description, url: `https://www.wikidata.org/wiki/${s.id}` })) };
      });
      const key = envValue("GOOGLE_API_KEY") ?? envValue("PAGESPEED_API_KEY");
      let kg: unknown = null;
      if (key) {
        const params = new URLSearchParams({ key, limit: String(a.limit) });
        // ids and query are alternatives: with ids the API returns those entities directly, no name matching.
        // The API rejects the "kg:" prefix it prints in @id, so it is stripped here.
        if (a.ids?.length) for (const id of a.ids) params.append("ids", id.trim().replace(/^kg:/i, ""));
        else params.set("query", a.name);
        for (const l of a.languages) params.append("languages", l);
        for (const t of a.types ?? []) params.append("types", t);
        const res = await fetchWithTimeout(`https://kgsearch.googleapis.com/v1/entities:search?${params}`, {}, 20_000);
        const data = (await res.json()) as { error?: { message?: string }; itemListElement?: { result?: { "@id"?: string; name?: string; "@type"?: string[]; description?: string; detailedDescription?: { url?: string }; url?: string }; resultScore?: number }[] };
        const str = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? str(v[0]) : v && typeof v === "object" && "@value" in (v as object) ? String((v as { "@value": unknown })["@value"]) : undefined);
        kg = data.error ? { error: data.error.message, hint: /not been used|disabled|API key/i.test(data.error.message ?? "") ? "Enable 'Knowledge Graph Search API' in the GCP project and allow it on the API key." : undefined } : (data.itemListElement ?? []).map((e) => ({ id: e.result?.["@id"], name: str(e.result?.name), types: e.result?.["@type"], description: str(e.result?.description), wikipedia: e.result?.detailedDescription?.url, url: e.result?.url, score: e.resultScore }));
      }
      const exactWd = wikidata.some((w) => w.results.some((r) => r.label?.toLowerCase() === a.name.toLowerCase()));
      // With explicit ids the name is not what was searched, so any returned entity counts as found.
      const exactKg = Array.isArray(kg) && (a.ids?.length ? kg.length > 0 : (kg as { name?: string }[]).some((r) => r.name?.toLowerCase() === a.name.toLowerCase()));
      return { name: a.name, query: a.ids?.length ? { ids: a.ids } : { name: a.name, types: a.types }, wikidata, knowledgeGraph: kg ?? "skipped: no GOOGLE_API_KEY / PAGESPEED_API_KEY", found: { wikidata: exactWd, knowledgeGraph: exactKg }, howToEstablish: exactWd && exactKg ? undefined : ["Keep Organization/LocalBusiness schema identical on every page (name, url, logo, address, telephone, sameAs).", "Create and complete a Google Business Profile with the exact same name and website.", "Add sameAs links to all real profiles: Google Maps, TripAdvisor, Instagram, Facebook, YouTube, LinkedIn, Wikidata item.", "Create a Wikidata item (allowed for businesses with verifiable references: official site, press, registries); Wikipedia only if notability is met.", "Get mentioned by name on authoritative third-party sites (tourism boards, press, directories) with consistent NAP."] };
    }),
  );

  server.registerTool(
    "wikipedia_pageviews",
    {
      title: "Wikipedia pageviews for a place or entity",
      description:
        "Monthly Wikipedia pageviews per language for a monument, town, museum or brand (Wikimedia API, free, no key). Resolves the name through Wikidata so every language version of the article is found at once, then returns views per month, the year-over-year trend and the strongest calendar months. Use it as a demand and seasonality signal that is independent of your own traffic (it covers people who never reached your site), to decide which language deserves content first, and to pick the article worth citing and linking as sameAs/about in your schema.",
      inputSchema: {
        name: z.string().describe("Entity name ('Real Alcázar de Sevilla') or a full Wikipedia article URL."),
        languages: z.array(z.string()).max(8).default(["es", "en"]).describe("Wikipedia language editions to measure, e.g. ['es','en','fr']."),
        wikidataId: z.string().optional().describe("Wikidata Q-id (e.g. 'Q206443') to skip the name search and be sure of the entity."),
        months: z.number().int().min(3).max(60).default(24).describe("How many months back (24 shows a full year-over-year comparison)."),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "reading Wikipedia pageviews");
      try {
        const api = "https://www.wikidata.org/w/api.php";
        const fromUrl = parseWikipediaUrl(a.name);
        let entity: { id?: string; label?: string; description?: string; sitelinks?: Record<string, { title?: string }> } | null = null;
        // 1. Wikidata: explicit id, or the article's item when a URL was given, or a name search.
        let id = a.wikidataId;
        if (!id && fromUrl) {
          const r = await fetchWithTimeout(`${api}?action=wbgetentities&sites=${fromUrl.language}wiki&titles=${encodeURIComponent(fromUrl.title)}&props=sitelinks|labels|descriptions&languages=${a.languages.join("|")}&format=json&origin=*`, {}, 20_000);
          const d = (await r.json()) as { entities?: Record<string, { id?: string; labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; sitelinks?: Record<string, { title?: string }> }> };
          const first = Object.values(d.entities ?? {}).find((e) => e.id && !e.id.startsWith("-"));
          if (first) entity = { id: first.id, label: first.labels?.[a.languages[0]]?.value ?? Object.values(first.labels ?? {})[0]?.value, description: first.descriptions?.[a.languages[0]]?.value, sitelinks: first.sitelinks };
        } else if (!id) {
          const r = await fetchWithTimeout(`${api}?action=wbsearchentities&search=${encodeURIComponent(a.name)}&language=${a.languages[0]}&uselang=${a.languages[0]}&limit=1&format=json&origin=*`, {}, 20_000);
          const d = (await r.json()) as { search?: { id: string }[] };
          id = d.search?.[0]?.id;
        }
        if (!entity && id) {
          const r = await fetchWithTimeout(`${api}?action=wbgetentities&ids=${encodeURIComponent(id)}&props=sitelinks|labels|descriptions&languages=${a.languages.join("|")}&format=json&origin=*`, {}, 20_000);
          const d = (await r.json()) as { entities?: Record<string, { id?: string; labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; sitelinks?: Record<string, { title?: string }> }> };
          const e = d.entities?.[id];
          if (e) entity = { id: e.id ?? id, label: e.labels?.[a.languages[0]]?.value ?? Object.values(e.labels ?? {})[0]?.value, description: e.descriptions?.[a.languages[0]]?.value, sitelinks: e.sitelinks };
        }
        // 2. Title per language: the Wikidata sitelink, else the name (or the URL's title) as typed.
        const titleFor = (lang: string) => entity?.sitelinks?.[`${lang}wiki`]?.title ?? (fromUrl?.language === lang ? fromUrl.title : undefined) ?? (entity ? undefined : fromUrl?.title ?? a.name);
        const end = new Date();
        const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - a.months + 1, 1));
        const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
        const languages = await mapLimit(a.languages, 3, async (lang) => {
          const title = titleFor(lang);
          if (!title) return { language: lang, title: null, note: "No article in this language" };
          const article = encodeURIComponent(title.replace(/ /g, "_"));
          const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${article}/monthly/${stamp(start)}/${stamp(end)}`;
          try {
            const r = await fetchWithTimeout(url, {}, 30_000);
            const d = (await r.json()) as { items?: { timestamp: string; views: number }[]; detail?: string | { title?: string } };
            if (!r.ok || !d.items?.length) return { language: lang, title, articleUrl: `https://${lang}.wikipedia.org/wiki/${article}`, note: r.status === 404 ? "No pageview data (article missing or too new)" : typeof d.detail === "string" ? d.detail : `HTTP ${r.status}` };
            return { language: lang, title, articleUrl: `https://${lang}.wikipedia.org/wiki/${article}`, ...summarizePageviews(d.items) };
          } catch (e) { return { language: lang, title, note: (e as Error).message }; }
        });
        const ranked = languages.filter((l): l is typeof l & { totalViews: number } => typeof (l as { totalViews?: number }).totalViews === "number").sort((x, y) => y.totalViews - x.totalViews);
        return {
          name: a.name,
          entity: entity?.id ? { wikidataId: entity.id, label: entity.label, description: entity.description, url: `https://www.wikidata.org/wiki/${entity.id}` } : null,
          months: a.months,
          languages,
          totalViews: ranked.reduce((s, l) => s + l.totalViews, 0),
          topLanguage: ranked[0] ? { language: ranked[0].language, totalViews: ranked[0].totalViews, articleUrl: ranked[0].articleUrl } : null,
          note: ranked[0] ? `Link and mark up ${ranked[0].articleUrl} as sameAs/about for this entity, and plan content for the strongest months listed above.` : "No Wikipedia article found; knowledge_graph_check lists the steps to establish the entity.",
        };
      } finally { stop(); }
    }),
  );

  server.registerTool(
    "crux_history",
    {
      title: "Core Web Vitals field history (CrUX)",
      description:
        "Real-user Core Web Vitals trend from the Chrome UX Report History API for an origin or URL: weekly p75 of LCP, INP, CLS, FCP, TTFB over the last ~25 weeks with the share of good / needs-improvement / poor for each week. Use crux_snapshot for the latest record and the LCP sub-part breakdown. Needs the 'Chrome UX Report API' enabled on the GCP project and a key in CRUX_API_KEY / GOOGLE_API_KEY / PAGESPEED_API_KEY. Returns 404 when the page has too little traffic for CrUX; try the origin instead.",
      inputSchema: { target: z.string().url().describe("Page URL or origin (https://example.com)."), scope: z.enum(["origin", "url"]).default("origin"), formFactor: z.enum(["PHONE", "DESKTOP", "TABLET", "ALL"]).default("PHONE").describe("Device class; ALL merges every device."), weeks: z.number().int().min(1).max(40).default(12) },
    },
    tool(async (a) => {
      const key = cruxKey();
      const body: Record<string, unknown> = a.scope === "origin" ? { origin: new URL(a.target).origin } : { url: a.target };
      if (a.formFactor !== "ALL") body.formFactor = a.formFactor;
      body.metrics = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte"];
      body.collectionPeriodCount = a.weeks; // without this the API returns its default of 25, so weeks > 25 was silently capped
      const res = await fetchWithTimeout(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 30_000);
      const data = (await res.json()) as { error?: { message?: string; status?: string }; record?: { collectionPeriods?: { lastDate: { year: number; month: number; day: number } }[]; metrics?: Record<string, { histogramTimeseries?: { start: number; end?: number; densities: (number | null)[] }[]; percentilesTimeseries?: { p75s: (number | null)[] } }> } };
      if (!res.ok || data.error) throw new Error(`CrUX API: ${data.error?.message ?? `HTTP ${res.status}`}${data.error?.status === "NOT_FOUND" ? " (not enough Chrome traffic for this target; try scope=origin)" : ""}${/not been used|disabled/i.test(data.error?.message ?? "") ? " Hint: enable 'Chrome UX Report API' in the GCP project and allow it on the API key." : ""}`);
      const periods = (data.record?.collectionPeriods ?? []).map((p) => `${p.lastDate.year}-${String(p.lastDate.month).padStart(2, "0")}-${String(p.lastDate.day).padStart(2, "0")}`);
      const n = periods.length;
      const from = Math.max(0, n - a.weeks);
      const metrics: Record<string, unknown> = {};
      for (const [k, m] of Object.entries(data.record?.metrics ?? {})) {
        const label = CRUX_NAMES[k] ?? k;
        const p75 = (m.percentilesTimeseries?.p75s ?? []).slice(from).map((v) => (v == null ? null : typeof v === "string" ? Number(v) : v));
        const share = (i: number) => (m.histogramTimeseries?.[i]?.densities ?? []).slice(from).map((v) => (v == null ? null : round(v, 3)));
        const latest = p75[p75.length - 1];
        metrics[label] = { latestP75: latest, rating: cruxRating(label, latest ?? null), p75Series: p75, goodShareSeries: share(0), needsImprovementShareSeries: share(1), poorShareSeries: share(2) };
      }
      return { target: body.origin ?? body.url, formFactor: a.formFactor, weeksEnding: periods.slice(from), metrics };
    }),
  );

  server.registerTool(
    "crux_snapshot",
    {
      title: "Latest Core Web Vitals + LCP breakdown (CrUX)",
      description:
        "Latest 28-day real-user record from the Chrome UX Report for an origin or URL: p75 and good/needs-improvement/poor shares for LCP, INP, CLS, FCP, TTFB and round-trip time, plus the LCP sub-part breakdown (time to first byte, resource load delay, resource load duration, element render delay) that says WHY LCP is slow - slow server, image found too late, slow transfer or blocked rendering - with the dominant phase named. Also the LCP element type (image vs text) and the navigation mix (back/forward cache, prerender, reload). Use crux_history for the weekly trend. Needs the 'Chrome UX Report API' enabled and CRUX_API_KEY / GOOGLE_API_KEY / PAGESPEED_API_KEY; NOT_FOUND means too little traffic, so try scope=origin.",
      inputSchema: {
        target: z.string().url().describe("Page URL or origin (https://example.com)."),
        scope: z.enum(["origin", "url"]).default("origin").describe("'origin' = whole site (always has the most data), 'url' = that single page."),
        formFactor: z.enum(["PHONE", "DESKTOP", "TABLET", "ALL"]).default("PHONE").describe("Device class; ALL merges every device."),
      },
    },
    tool(async (a) => {
      const key = cruxKey();
      const body: Record<string, unknown> = a.scope === "origin" ? { origin: new URL(a.target).origin } : { url: a.target };
      if (a.formFactor !== "ALL") body.formFactor = a.formFactor;
      body.metrics = [
        "largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte", "round_trip_time",
        "largest_contentful_paint_image_time_to_first_byte", "largest_contentful_paint_image_resource_load_delay", "largest_contentful_paint_image_resource_load_duration", "largest_contentful_paint_image_element_render_delay",
        "largest_contentful_paint_resource_type", "navigation_types",
      ];
      const res = await fetchWithTimeout(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 30_000);
      const data = (await res.json()) as {
        error?: { message?: string; status?: string };
        urlNormalizationDetails?: { originalUrl?: string; normalizedUrl?: string };
        record?: { key?: Record<string, string>; metrics?: Record<string, { histogram?: { start?: number | string; end?: number | string; density?: number }[]; percentiles?: { p75?: number | string }; fractions?: Record<string, number> }>; collectionPeriod?: { firstDate?: { year: number; month: number; day: number }; lastDate?: { year: number; month: number; day: number } } };
      };
      if (!res.ok || data.error) throw new Error(`CrUX API: ${data.error?.message ?? `HTTP ${res.status}`}${data.error?.status === "NOT_FOUND" ? " (not enough Chrome traffic for this target; try scope=origin)" : ""}${/not been used|disabled/i.test(data.error?.message ?? "") ? " Hint: enable 'Chrome UX Report API' in the GCP project and allow it on the API key." : ""}`);
      const m = data.record?.metrics ?? {};
      const p75 = (k: string): number | null => { const v = m[k]?.percentiles?.p75; return v == null ? null : Number(v); };
      const metric = (k: string) => {
        const label = CRUX_NAMES[k] ?? k;
        const v = p75(k);
        const h = (m[k]?.histogram ?? []).map((b) => round(b.density ?? 0, 4));
        if (v == null && !h.length) return null;
        return { p75: v, rating: cruxRating(label, v), good: h[0] ?? null, needsImprovement: h[1] ?? null, poor: h[2] ?? null };
      };
      const parts = {
        ttfbMs: p75("largest_contentful_paint_image_time_to_first_byte"),
        resourceLoadDelayMs: p75("largest_contentful_paint_image_resource_load_delay"),
        resourceLoadDurationMs: p75("largest_contentful_paint_image_resource_load_duration"),
        elementRenderDelayMs: p75("largest_contentful_paint_image_element_render_delay"),
      };
      const diagnosis = diagnoseLcp(parts);
      const metrics: Record<string, unknown> = {};
      for (const k of ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte", "round_trip_time"]) {
        const v = metric(k);
        if (v) metrics[CRUX_NAMES[k] ?? k] = v;
      }
      const fractions = (k: string) => (m[k]?.fractions ? Object.fromEntries(Object.entries(m[k].fractions!).map(([n, v]) => [n, round(v, 4)])) : null);
      return {
        target: body.origin ?? body.url,
        formFactor: a.formFactor,
        collectionPeriod: { first: ymd(data.record?.collectionPeriod?.firstDate), last: ymd(data.record?.collectionPeriod?.lastDate) },
        metrics,
        lcpBreakdown: Object.values(parts).some((v) => v != null)
          ? { ...parts, shares: diagnosis.shares, dominant: diagnosis.dominant, advice: diagnosis.advice, resourceType: fractions("largest_contentful_paint_resource_type"), note: "Each sub-part is its own p75, so they do not add up to the LCP p75; compare their relative size. Sub-parts only exist when the LCP element is an image." }
          : { note: "No LCP sub-parts for this target: too little data, or the LCP element is text (see resourceType).", resourceType: fractions("largest_contentful_paint_resource_type") },
        navigationTypes: fractions("navigation_types"),
        urlNormalization: data.urlNormalizationDetails ?? undefined,
      };
    }),
  );

  server.registerTool(
    "brand_mentions",
    {
      title: "Brand mentions on the web (Brave Search)",
      description:
        "Search the web for pages mentioning a brand name that are not on your own domain, and check whether each mentioning page links to you. Unlinked mentions are outreach targets; the excerpts show in what context AI engines see the brand. Use freshness='pw'/'pm' to monitor only new mentions and offset to page past the first 20. Requires BRAVE_API_KEY (pay-as-you-go, about $5 per 1000 requests with ~$5 of free monthly credits: https://brave.com/search/api/).",
      inputSchema: {
        brand: z.string(),
        domain: z.string().describe("Your domain, excluded from results and used to detect links."),
        count: z.number().int().min(1).max(20).default(20).describe("Results per page (max 20)."),
        offset: z.number().int().min(0).max(9).default(0).describe("Result page to fetch (0 = first 'count' results, 1 = next, up to 9): how to reach beyond the first 20 mentions."),
        country: z.string().default("es"),
        language: z.string().default("en"),
        freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Only pages discovered in the past day / week / month / year. Leave unset for all time."),
        extraSnippets: z.boolean().default(true).describe("Ask Brave for up to 5 excerpts per result so you can read what is said about the brand, not just that it is mentioned."),
        checkLinks: z.boolean().default(true),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "checking mentioning pages");
      try {
      const key = envValue("BRAVE_API_KEY");
      if (!key) throw new Error("BRAVE_API_KEY is not set. Create one at https://brave.com/search/api/ (pay-as-you-go, ~$5/1k requests with ~$5 of free monthly credits) and add it to the MCP env.");
      const q = `"${a.brand}" -site:${a.domain}`;
      const params = new URLSearchParams({ q, count: String(a.count), country: a.country, search_lang: a.language });
      if (a.offset) params.set("offset", String(a.offset));
      if (a.freshness) params.set("freshness", a.freshness);
      if (a.extraSnippets) params.set("extra_snippets", "true");
      const res = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?${params}`, { headers: { "X-Subscription-Token": key, Accept: "application/json" } }, 20_000);
      const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; age?: string; page_age?: string; extra_snippets?: string[] }[] }; message?: string; error?: { detail?: string } };
      if (!res.ok) throw new Error(`Brave Search: ${data.message ?? data.error?.detail ?? `HTTP ${res.status}`}${res.status === 422 && a.extraSnippets ? " (extra_snippets needs a paid Brave plan; retry with extraSnippets=false)" : ""}`);
      const dom = a.domain.replace(/^www\./, "").toLowerCase();
      const results = data.web?.results ?? [];
      const rows = await mapLimit(results, 4, async (r) => {
        let linksToYou: boolean | null = null;
        if (a.checkLinks) { try { const pr = await fetchWithTimeout(r.url, {}, 15_000); const $ = cheerio.load(await pr.text()); linksToYou = $("a[href]").toArray().some((el) => { try { return new URL($(el).attr("href")!, r.url).hostname.replace(/^www\./, "").endsWith(dom); } catch { return false; } }); } catch { linksToYou = null; } }
        return { title: r.title, url: r.url, host: new URL(r.url).hostname, snippet: r.description, excerpts: r.extra_snippets?.slice(0, 5), age: r.age ?? r.page_age, linksToYou };
      });
      return { brand: a.brand, query: q, offset: a.offset, freshness: a.freshness ?? "all time", results: rows.length, unlinkedMentions: rows.filter((r) => r.linksToYou === false), linkedMentions: rows.filter((r) => r.linksToYou === true).length, all: rows, more: rows.length === a.count && a.offset < 9 ? `Call again with offset=${a.offset + 1} for the next ${a.count}.` : undefined };
      } finally { stop(); }
    }),
  );

  server.registerTool(
    "reviews_snapshot",
    {
      title: "Google Business reviews snapshot (Places API)",
      description:
        "Fetch rating, review count and the latest reviews of a Google Business Profile via the Places API (New), to monitor reputation and spot what visitors praise or complain about. Do NOT copy these numbers into AggregateRating schema: Google forbids aggregating ratings from another site, and a business marking up reviews about itself makes the page ineligible for review stars. Requires GOOGLE_PLACES_API_KEY with 'Places API (New)' enabled (billing must be enabled on the project; Google grants a monthly free allowance).",
      inputSchema: { query: z.string().optional().describe("Business name + city to search, e.g. 'Altai Turismo Sevilla'."), placeId: z.string().optional().describe("Google Place ID if known (skips the search)."), language: z.string().default("en") },
    },
    tool(async (a) => {
      const key = envValue("GOOGLE_PLACES_API_KEY");
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
      return { placeId, name: d.displayName?.text, address: d.formattedAddress, phone: d.internationalPhoneNumber, website: d.websiteUri, mapsUrl: d.googleMapsUri, status: d.businessStatus, rating: d.rating, reviewCount: d.userRatingCount, latestReviews: (d.reviews ?? []).map((r) => ({ rating: r.rating, when: r.relativePublishTimeDescription, date: r.publishTime, author: r.authorAttribution?.displayName, text: r.text?.text?.slice(0, 500) })), schemaWarning: "Do not publish these values as AggregateRating: Google prohibits aggregating ratings from other sites, and self-serving reviews on your own LocalBusiness/Organization page are ineligible for the star feature. Collect reviews on your own site instead.", otherCandidates: candidates.slice(1) };
    }),
  );
}
