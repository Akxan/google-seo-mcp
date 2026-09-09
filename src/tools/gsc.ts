import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { searchconsole_v1 } from "googleapis";
import { searchConsole } from "../google.js";
import { resolveDate, round, tool } from "../util.js";
import { wpPostIndexForHost } from "./wp.js";
import { collectSitemapUrls, fetchWithTimeout } from "./web.js";
import * as cheerio from "cheerio";

const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
const OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"] as const;

const siteUrl = z
  .string()
  .describe("Property URL exactly as shown in Search Console, e.g. 'https://example.com/' or 'sc-domain:example.com'. Use gsc_list_sites to discover it.");

const dateField = (what: string) =>
  z.string().describe(`${what} date: YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo' (e.g. '28daysAgo'). Search Console data lags ~2-3 days.`);

const filterSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  operator: z.enum(OPERATORS).default("equals"),
  expression: z.string().describe("Value to match. For device use DESKTOP/MOBILE/TABLET; for country use 3-letter ISO code like 'usa', 'chn'."),
});

export type Row = { keys: Record<string, string>; clicks: number; impressions: number; ctr: number | null; position: number | null };

function mapRows(rows: searchconsole_v1.Schema$ApiDataRow[] | undefined, dimensions: readonly string[]): Row[] {
  return (rows ?? []).map((r) => {
    const keys: Record<string, string> = {};
    dimensions.forEach((d, i) => (keys[d] = r.keys?.[i] ?? ""));
    return {
      keys,
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: round(r.ctr, 4),
      position: round(r.position, 2),
    };
  });
}

export function normalizePath(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "") || "/";
    return p.toLowerCase();
  } catch {
    return url.replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
  }
}

function flatten(rows: Row[]) {
  return rows.map((r) => ({ ...r.keys, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}

export async function query(params: {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions: readonly (typeof DIMENSIONS)[number][];
  searchType?: string;
  rowLimit?: number;
  startRow?: number;
  filters?: z.infer<typeof filterSchema>[];
  dataState?: string;
  aggregationType?: string;
}) {
  const res = await searchConsole().searchanalytics.query({
    siteUrl: params.siteUrl,
    requestBody: {
      startDate: resolveDate(params.startDate),
      endDate: resolveDate(params.endDate),
      dimensions: [...params.dimensions],
      type: params.searchType,
      rowLimit: params.rowLimit,
      startRow: params.startRow,
      dataState: params.dataState,
      aggregationType: params.aggregationType,
      dimensionFilterGroups: params.filters?.length
        ? [{ groupType: "and", filters: params.filters.map((f) => ({ dimension: f.dimension, operator: f.operator, expression: f.expression })) }]
        : undefined,
    },
  });
  return mapRows(res.data.rows, params.dimensions);
}

export function registerSearchConsoleTools(server: McpServer) {
  server.registerTool(
    "gsc_list_sites",
    {
      title: "List Search Console properties",
      description: "List all Search Console properties (sites) the authorized account can access, with permission level.",
      inputSchema: {},
    },
    tool(async () => {
      const res = await searchConsole().sites.list();
      return (res.data.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
    }),
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Search Console performance report",
      description:
        "Query Google Search performance data (clicks, impressions, CTR, average position) grouped by query, page, country, device, date or searchAppearance. Supports filtering (e.g. only rows where page contains '/blog/') and pagination.",
      inputSchema: {
        siteUrl,
        startDate: dateField("Start"),
        endDate: dateField("End"),
        dimensions: z.array(z.enum(DIMENSIONS)).default(["query"]).describe("Group-by dimensions. Omit for site totals; use ['date'] for a daily trend."),
        searchType: z.enum(SEARCH_TYPES).default("web"),
        rowLimit: z.number().int().min(1).max(25000).default(100),
        startRow: z.number().int().min(0).default(0).describe("Pagination offset."),
        filters: z.array(filterSchema).optional().describe("All filters are AND-ed."),
        dataState: z.enum(["final", "all"]).default("final").describe("'all' includes fresh (not yet finalized) data of the last days."),
        aggregationType: z.enum(["auto", "byPage", "byProperty"]).optional(),
      },
    },
    tool(async (args) => {
      const rows = await query(args);
      const totals = rows.reduce(
        (t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }),
        { clicks: 0, impressions: 0 },
      );
      return {
        siteUrl: args.siteUrl,
        startDate: resolveDate(args.startDate),
        endDate: resolveDate(args.endDate),
        rowCount: rows.length,
        totalsOfReturnedRows: totals,
        rows: flatten(rows),
      };
    }),
  );

  server.registerTool(
    "gsc_compare_periods",
    {
      title: "Compare two periods in Search Console",
      description:
        "Compare search performance between a current and a previous period for a single dimension (query or page). Returns rows with deltas, sorted by biggest click change, so you can spot winners and losers.",
      inputSchema: {
        siteUrl,
        dimension: z.enum(["query", "page", "country", "device"]).default("page"),
        currentStart: dateField("Current period start"),
        currentEnd: dateField("Current period end"),
        previousStart: dateField("Previous period start"),
        previousEnd: dateField("Previous period end"),
        searchType: z.enum(SEARCH_TYPES).default("web"),
        rowLimit: z.number().int().min(1).max(5000).default(500).describe("Rows fetched per period before joining."),
        filters: z.array(filterSchema).optional(),
        top: z.number().int().min(1).max(500).default(50).describe("How many winners and losers to return."),
      },
    },
    tool(async (args) => {
      const [current, previous] = await Promise.all([
        query({ ...args, dimensions: [args.dimension], startDate: args.currentStart, endDate: args.currentEnd }),
        query({ ...args, dimensions: [args.dimension], startDate: args.previousStart, endDate: args.previousEnd }),
      ]);
      const byKey = new Map<string, { current?: Row; previous?: Row }>();
      for (const r of current) byKey.set(r.keys[args.dimension], { current: r });
      for (const r of previous) {
        const k = r.keys[args.dimension];
        byKey.set(k, { ...byKey.get(k), previous: r });
      }
      const merged = [...byKey.entries()].map(([key, { current: c, previous: p }]) => ({
        [args.dimension]: key,
        clicks: c?.clicks ?? 0,
        clicksPrev: p?.clicks ?? 0,
        clicksDelta: (c?.clicks ?? 0) - (p?.clicks ?? 0),
        impressions: c?.impressions ?? 0,
        impressionsPrev: p?.impressions ?? 0,
        impressionsDelta: (c?.impressions ?? 0) - (p?.impressions ?? 0),
        ctr: c?.ctr ?? null,
        ctrPrev: p?.ctr ?? null,
        position: c?.position ?? null,
        positionPrev: p?.position ?? null,
        positionDelta: c?.position != null && p?.position != null ? round(c.position - p.position, 2) : null,
      }));
      const sum = (rows: Row[], k: "clicks" | "impressions") => rows.reduce((a, r) => a + r[k], 0);
      merged.sort((a, b) => b.clicksDelta - a.clicksDelta);
      return {
        siteUrl: args.siteUrl,
        dimension: args.dimension,
        current: { start: resolveDate(args.currentStart), end: resolveDate(args.currentEnd), clicks: sum(current, "clicks"), impressions: sum(current, "impressions") },
        previous: { start: resolveDate(args.previousStart), end: resolveDate(args.previousEnd), clicks: sum(previous, "clicks"), impressions: sum(previous, "impressions") },
        winners: merged.filter((r) => r.clicksDelta > 0).slice(0, args.top),
        losers: merged.filter((r) => r.clicksDelta < 0).reverse().slice(0, args.top),
        new: merged.filter((r) => r.clicksPrev === 0 && r.clicks > 0).length,
        lost: merged.filter((r) => r.clicks === 0 && r.clicksPrev > 0).length,
      };
    }),
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect a URL (index status)",
      description:
        "Run the URL Inspection API for a page: index status, last crawl time, canonical selection, robots.txt state, mobile usability, rich results and AMP status. Quota: ~2000 calls/day per property.",
      inputSchema: {
        siteUrl,
        inspectionUrl: z.string().url().describe("Full URL of the page to inspect. Must belong to the property."),
        languageCode: z.string().default("en-US").describe("BCP-47 language for the response messages, e.g. 'zh-CN'."),
      },
    },
    tool(async (args) => {
      const res = await searchConsole().urlInspection.index.inspect({
        requestBody: { siteUrl: args.siteUrl, inspectionUrl: args.inspectionUrl, languageCode: args.languageCode },
      });
      return res.data.inspectionResult;
    }),
  );

  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "List sitemaps",
      description: "List sitemaps submitted for a property, with last submitted/downloaded times, errors, warnings and URL counts.",
      inputSchema: { siteUrl },
    },
    tool(async (args) => {
      const res = await searchConsole().sitemaps.list({ siteUrl: args.siteUrl });
      return res.data.sitemap ?? [];
    }),
  );

  server.registerTool(
    "gsc_submit_sitemap",
    {
      title: "Submit a sitemap",
      description: "Submit (or resubmit) a sitemap URL for a property.",
      inputSchema: {
        siteUrl,
        feedpath: z.string().url().describe("Absolute sitemap URL, e.g. 'https://example.com/sitemap.xml'."),
      },
    },
    tool(async (args) => {
      await searchConsole().sitemaps.submit({ siteUrl: args.siteUrl, feedpath: args.feedpath });
      return { submitted: args.feedpath };
    }),
  );
  server.registerTool(
    "gsc_opportunities",
    {
      title: "Find quick-win keywords (striking distance)",
      description:
        "Find queries with high impressions but average position in a range (default 8-20): pages already ranking on page 1-2 that can be pushed into the top results with title/content/internal-link work. Groups results by page and, when a WordPress site is configured for this domain, maps each page to its post ID so you can edit it directly.",
      inputSchema: {
        siteUrl,
        startDate: dateField("Start").default("28daysAgo"),
        endDate: dateField("End").default("3daysAgo"),
        minPosition: z.number().min(1).default(8),
        maxPosition: z.number().min(1).default(20),
        minImpressions: z.number().int().min(1).default(20),
        searchType: z.enum(SEARCH_TYPES).default("web"),
        country: z.string().optional().describe("Optional 3-letter country code filter, e.g. 'esp', 'usa'."),
        top: z.number().int().min(1).max(500).default(50),
      },
    },
    tool(async (args) => {
      const filters = args.country ? [{ dimension: "country" as const, operator: "equals" as const, expression: args.country }] : undefined;
      const rows = await query({ ...args, dimensions: ["query", "page"], rowLimit: 25000, filters });
      const hits = rows.filter((r) => r.position != null && r.position >= args.minPosition && r.position <= args.maxPosition && r.impressions >= args.minImpressions);
      hits.sort((a, b) => b.impressions - a.impressions);
      let host: string | undefined;
      try { host = args.siteUrl.startsWith("sc-domain:") ? args.siteUrl.slice(10) : new URL(args.siteUrl).hostname; } catch { /* ignore */ }
      const wp = host ? await wpPostIndexForHost(host).catch(() => null) : null;
      const wpFor = (page: string) => wp?.byPath.get(normalizePath(page));
      const byPage = new Map<string, { page: string; queries: number; impressions: number; clicks: number; bestQuery: string; wpPostId?: number; wpTitle?: string }>();
      for (const r of hits) {
        const key = r.keys.page;
        const cur = byPage.get(key) ?? { page: key, queries: 0, impressions: 0, clicks: 0, bestQuery: r.keys.query, wpPostId: wpFor(key)?.ID, wpTitle: wpFor(key)?.title };
        cur.queries++;
        cur.impressions += r.impressions;
        cur.clicks += r.clicks;
        byPage.set(key, cur);
      }
      return {
        siteUrl: args.siteUrl,
        period: { start: resolveDate(args.startDate), end: resolveDate(args.endDate) },
        criteria: { position: [args.minPosition, args.maxPosition], minImpressions: args.minImpressions },
        wordpressSite: wp?.site ?? null,
        opportunities: hits.slice(0, args.top).map((r) => ({ query: r.keys.query, page: r.keys.page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, wpPostId: wpFor(r.keys.page)?.ID ?? null })),
        pages: [...byPage.values()].sort((a, b) => b.impressions - a.impressions).slice(0, args.top),
      };
    }),
  );

  server.registerTool(
    "gsc_cannibalization",
    {
      title: "Keyword cannibalization",
      description:
        "Find queries for which two or more pages of the site receive impressions, i.e. pages competing against each other for the same keyword. Each result lists the competing pages with clicks, impressions and position so you can consolidate or differentiate them.",
      inputSchema: {
        siteUrl,
        startDate: dateField("Start").default("90daysAgo"),
        endDate: dateField("End").default("3daysAgo"),
        minImpressionsPerPage: z.number().int().min(1).default(10),
        searchType: z.enum(SEARCH_TYPES).default("web"),
        top: z.number().int().min(1).max(500).default(50),
      },
    },
    tool(async (args) => {
      const rows = await query({ ...args, dimensions: ["query", "page"], rowLimit: 25000 });
      const byQuery = new Map<string, Row[]>();
      for (const r of rows) {
        if (r.impressions < args.minImpressionsPerPage) continue;
        const list = byQuery.get(r.keys.query) ?? [];
        list.push(r);
        byQuery.set(r.keys.query, list);
      }
      const result = [...byQuery.entries()]
        .filter(([, list]) => list.length >= 2)
        .map(([q, list]) => ({
          query: q,
          pages: list.length,
          totalImpressions: list.reduce((a, r) => a + r.impressions, 0),
          totalClicks: list.reduce((a, r) => a + r.clicks, 0),
          competing: list.sort((a, b) => b.impressions - a.impressions).map((r) => ({ page: r.keys.page, clicks: r.clicks, impressions: r.impressions, position: r.position })),
        }))
        .sort((a, b) => b.totalImpressions - a.totalImpressions);
      return { siteUrl: args.siteUrl, period: { start: resolveDate(args.startDate), end: resolveDate(args.endDate) }, cannibalizedQueries: result.length, results: result.slice(0, args.top) };
    }),
  );

  server.registerTool(
    "gsc_index_coverage",
    {
      title: "Batch index coverage check",
      description:
        "Run the URL Inspection API over a list of URLs (or the first N URLs of the site's sitemap) and summarize index status: indexed / not indexed, coverage state, robots state, last crawl, canonical mismatch. Costs one inspection call per URL against the ~2000/day quota, so keep batches small.",
      inputSchema: {
        siteUrl,
        urls: z.array(z.string().url()).max(100).optional().describe("Explicit URLs to inspect."),
        sitemapUrl: z.string().url().optional().describe("Alternatively, take URLs from this sitemap (index supported)."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max URLs when reading from the sitemap."),
        onlyProblems: z.boolean().default(false).describe("Return only URLs that are not indexed or have a canonical mismatch."),
        languageCode: z.string().default("en-US"),
      },
    },
    tool(async (args) => {
      let urls = args.urls ?? [];
      if (!urls.length && args.sitemapUrl) urls = (await collectSitemapUrls(args.sitemapUrl, { maxUrls: args.limit })).urls.map((u) => u.loc);
      if (!urls.length) throw new Error("Provide urls[] or sitemapUrl.");
      const api = searchConsole();
      const results: Record<string, unknown>[] = [];
      let i = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (i < urls.length) {
            const url = urls[i++];
            try {
              const res = await api.urlInspection.index.inspect({ requestBody: { siteUrl: args.siteUrl, inspectionUrl: url, languageCode: args.languageCode } });
              const r = res.data.inspectionResult;
              const idx = r?.indexStatusResult;
              const canonicalMismatch = Boolean(idx?.googleCanonical && idx.userCanonical && idx.googleCanonical !== idx.userCanonical);
              results.push({
                url,
                verdict: idx?.verdict,
                coverageState: idx?.coverageState,
                indexingState: idx?.indexingState,
                robotsTxtState: idx?.robotsTxtState,
                pageFetchState: idx?.pageFetchState,
                lastCrawlTime: idx?.lastCrawlTime,
                crawledAs: idx?.crawledAs,
                googleCanonical: idx?.googleCanonical,
                userCanonical: idx?.userCanonical,
                canonicalMismatch,
                mobileUsability: r?.mobileUsabilityResult?.verdict,
                richResults: r?.richResultsResult?.detectedItems?.map((d) => d.richResultType),
                problem: idx?.verdict !== "PASS" || canonicalMismatch,
              });
            } catch (err) {
              results.push({ url, error: (err as Error).message, problem: true });
            }
          }
        }),
      );
      const summary: Record<string, number> = {};
      for (const r of results) { const k = String(r.coverageState ?? r.error ?? "unknown"); summary[k] = (summary[k] ?? 0) + 1; }
      const ordered = urls.map((u) => results.find((r) => r.url === u)!);
      return { siteUrl: args.siteUrl, inspected: results.length, summary, results: args.onlyProblems ? ordered.filter((r) => r.problem) : ordered };
    }),
  );

  server.registerTool(
    "gsc_question_queries",
    {
      title: "Question queries (AI Overview / featured snippet targets)",
      description:
        "Find question-style queries (how, what, why, best, is it, cómo, qué, cuánto, dónde...) the site already gets impressions for, grouped by page. Optionally fetches each page to check whether a heading matches the question and whether FAQPage schema exists, so you know where to add FAQ answers. These queries are the ones AI Overviews and answer engines pick up.",
      inputSchema: {
        siteUrl,
        startDate: dateField("Start").default("90daysAgo"),
        endDate: dateField("End").default("3daysAgo"),
        minImpressions: z.number().int().min(1).default(5),
        checkPages: z.number().int().min(0).max(30).default(15).describe("How many of the top pages to fetch and check for matching headings / FAQ schema (0 = skip)."),
        top: z.number().int().min(1).max(500).default(100),
      },
    },
    tool(async (args) => {
      const QUESTION = /^(how|what|why|when|where|which|who|is|are|can|does|do|should|best|top|cómo|como|qué|que|por qué|cuándo|cuando|dónde|donde|cuál|cual|quién|quien|cuánto|cuanto|mejor|mejores|vale la pena|se puede|wie|was|warum|wann|wo|welche|comment|quoi|pourquoi|quand|où)\b|\?$/i;
      const rows = await query({ ...args, dimensions: ["query", "page"], rowLimit: 25000 });
      const qs = rows.filter((r) => r.impressions >= args.minImpressions && QUESTION.test(r.keys.query.trim())).sort((a, b) => b.impressions - a.impressions);
      const byPage = new Map<string, Row[]>();
      for (const r of qs) byPage.set(r.keys.page, [...(byPage.get(r.keys.page) ?? []), r]);
      const pagesSorted = [...byPage.entries()].sort((a, b) => b[1].reduce((s, r) => s + r.impressions, 0) - a[1].reduce((s, r) => s + r.impressions, 0));
      const STOP = new Set("the a an of in on to for and or is are with from by at as vs de la el los las en y o del al un una para con por que es se su lo how what why when where which who can does do should best top cómo como qué cuándo cuando dónde donde cuál cual cuánto cuanto".split(" "));
      const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
      const pageInfo = new Map<string, { faqSchema: boolean; headings: string[]; error?: string }>();
      let i = 0;
      const toCheck = pagesSorted.slice(0, args.checkPages).map(([p]) => p);
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < toCheck.length) {
          const url = toCheck[i++];
          try {
            const res = await fetchWithTimeout(url);
            const $ = cheerio.load(await res.text());
            const faqSchema = $('script[type="application/ld+json"]').toArray().some((el) => /"FAQPage"/.test($(el).text()));
            const headings = $("h1, h2, h3, h4").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get();
            pageInfo.set(url, { faqSchema, headings });
          } catch (e) { pageInfo.set(url, { faqSchema: false, headings: [], error: (e as Error).message }); }
        }
      }));
      const pages = pagesSorted.map(([page, list]) => {
        const info = pageInfo.get(page);
        const questions = list.map((r) => {
          const qw = words(r.keys.query);
          const matched = info ? info.headings.find((h) => { const hw = new Set(words(h)); return qw.length && qw.filter((w) => hw.has(w)).length / qw.length >= 0.6; }) : undefined;
          return { query: r.keys.query, impressions: r.impressions, clicks: r.clicks, position: r.position, headingAnswers: info ? Boolean(matched) : null, matchedHeading: matched ?? null };
        });
        return { page, questions: questions.length, impressions: list.reduce((s, r) => s + r.impressions, 0), clicks: list.reduce((s, r) => s + r.clicks, 0), faqSchema: info?.faqSchema ?? null, unansweredQuestions: info ? questions.filter((q) => !q.headingAnswers).length : null, topQuestions: questions.slice(0, 15) };
      });
      return { siteUrl: args.siteUrl, period: { start: resolveDate(args.startDate), end: resolveDate(args.endDate) }, questionQueries: qs.length, pagesWithQuestions: pages.length, pages: pages.slice(0, args.top), suggestion: "For pages with unanswered questions: add an H2/H3 phrased like the query with a 40-60 word direct answer, and mark the section up as FAQPage." };
    }),
  );

  server.registerTool(
    "gsc_rich_results_report",
    {
      title: "Search appearance / rich results report",
      description: "Show how the site appears in Google results: clicks and impressions per search appearance type (rich results, FAQ, review snippet, video, AMP, translated results, Discover...), and the top pages for each appearance type.",
      inputSchema: {
        siteUrl,
        startDate: dateField("Start").default("90daysAgo"),
        endDate: dateField("End").default("3daysAgo"),
        pagesPerType: z.number().int().min(1).max(100).default(10),
      },
    },
    tool(async (args) => {
      const types = await query({ ...args, dimensions: ["searchAppearance"], rowLimit: 100 });
      const totals = (await query({ ...args, dimensions: [], rowLimit: 1 }))[0];
      const detail = await Promise.all(types.map(async (t) => {
        const pages = await query({ ...args, dimensions: ["page"], rowLimit: args.pagesPerType, filters: [{ dimension: "searchAppearance", operator: "equals", expression: t.keys.searchAppearance }] });
        return { appearance: t.keys.searchAppearance, clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position, shareOfImpressions: totals?.impressions ? round(t.impressions / totals.impressions, 3) : null, topPages: flatten(pages) };
      }));
      return { siteUrl: args.siteUrl, period: { start: resolveDate(args.startDate), end: resolveDate(args.endDate) }, siteTotals: totals ? { clicks: totals.clicks, impressions: totals.impressions } : null, appearances: detail.sort((a, b) => b.impressions - a.impressions), note: types.length ? undefined : "No search appearance data: the site currently shows only as plain blue links." };
    }),
  );

  server.registerTool(
    "gsc_site_snapshot",
    {
      title: "Site snapshot (one-call overview)",
      description:
        "One call that answers 'how is the site doing': totals for the period and the previous period of equal length (clicks, impressions, CTR, position with deltas), top queries, top pages, device and country split, and the biggest winners/losers by page. Use this first when asked for an overview or a report.",
      inputSchema: { siteUrl, days: z.number().int().min(7).max(180).default(28), top: z.number().int().min(3).max(50).default(10), searchType: z.enum(SEARCH_TYPES).default("web") },
    },
    tool(async (args) => {
      const end = resolveDate("3daysAgo");
      const start = resolveDate(`${args.days + 2}daysAgo`);
      const prevEnd = resolveDate(`${args.days + 3}daysAgo`);
      const prevStart = resolveDate(`${2 * args.days + 2}daysAgo`);
      const base = { siteUrl: args.siteUrl, searchType: args.searchType };
      const [tot, prevTot, queries, pages, prevPages, devices, countries, daily] = await Promise.all([
        query({ ...base, startDate: start, endDate: end, dimensions: [], rowLimit: 1 }),
        query({ ...base, startDate: prevStart, endDate: prevEnd, dimensions: [], rowLimit: 1 }),
        query({ ...base, startDate: start, endDate: end, dimensions: ["query"], rowLimit: args.top }),
        query({ ...base, startDate: start, endDate: end, dimensions: ["page"], rowLimit: 500 }),
        query({ ...base, startDate: prevStart, endDate: prevEnd, dimensions: ["page"], rowLimit: 500 }),
        query({ ...base, startDate: start, endDate: end, dimensions: ["device"], rowLimit: 5 }),
        query({ ...base, startDate: start, endDate: end, dimensions: ["country"], rowLimit: args.top }),
        query({ ...base, startDate: start, endDate: end, dimensions: ["date"], rowLimit: 200 }),
      ]);
      const t = tot[0] ?? { clicks: 0, impressions: 0, ctr: null, position: null };
      const pv = prevTot[0] ?? { clicks: 0, impressions: 0, ctr: null, position: null };
      const pct = (c: number, p: number) => (p ? round(((c - p) / p) * 100, 1) : null);
      const prevMap = new Map(prevPages.map((r) => [r.keys.page, r]));
      const movers = pages.map((r) => ({ page: r.keys.page, clicks: r.clicks, clicksPrev: prevMap.get(r.keys.page)?.clicks ?? 0, delta: r.clicks - (prevMap.get(r.keys.page)?.clicks ?? 0), position: r.position }));
      for (const [page, r] of prevMap) if (!pages.some((p) => p.keys.page === page)) movers.push({ page, clicks: 0, clicksPrev: r.clicks, delta: -r.clicks, position: null });
      movers.sort((a, b) => b.delta - a.delta);
      return {
        siteUrl: args.siteUrl,
        period: { start, end, days: args.days },
        previousPeriod: { start: prevStart, end: prevEnd },
        totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position, clicksChangePct: pct(t.clicks, pv.clicks), impressionsChangePct: pct(t.impressions, pv.impressions), positionChange: t.position != null && pv.position != null ? round(t.position - pv.position, 2) : null, previous: { clicks: pv.clicks, impressions: pv.impressions, ctr: pv.ctr, position: pv.position } },
        topQueries: flatten(queries),
        topPages: flatten(pages.slice(0, args.top)),
        devices: flatten(devices),
        countries: flatten(countries),
        winners: movers.filter((m) => m.delta > 0).slice(0, args.top),
        losers: movers.filter((m) => m.delta < 0).reverse().slice(0, args.top),
        dailyClicks: daily.map((d) => ({ date: d.keys.date, clicks: d.clicks, impressions: d.impressions })),
        rankingPages: pages.length,
      };
    }),
  );

  server.registerTool(
    "gsc_ctr_opportunities",
    {
      title: "CTR opportunities (page-1 rankings with weak CTR)",
      description:
        "Queries already ranking in the top positions whose CTR is far below the typical CTR for that position, weighted by impressions: the fastest wins from rewriting titles and meta descriptions. Benchmark CTR by position: 1: 28%, 2: 15%, 3: 11%, 4: 8%, 5: 7%, 6-10: 5-3%.",
      inputSchema: { siteUrl, startDate: dateField("Start").default("28daysAgo"), endDate: dateField("End").default("3daysAgo"), maxPosition: z.number().min(1).max(20).default(10), minImpressions: z.number().int().min(1).default(30), dimension: z.enum(["query", "page"]).default("page"), top: z.number().int().min(1).max(200).default(30), searchType: z.enum(SEARCH_TYPES).default("web") },
    },
    tool(async (args) => {
      const bench = (pos: number) => (pos <= 1 ? 0.28 : pos <= 2 ? 0.15 : pos <= 3 ? 0.11 : pos <= 4 ? 0.08 : pos <= 5 ? 0.07 : pos <= 7 ? 0.05 : pos <= 10 ? 0.03 : 0.015);
      const rows = await query({ ...args, dimensions: args.dimension === "page" ? ["page", "query"] : ["query", "page"], rowLimit: 25000 });
      const hits = rows.filter((r) => r.position != null && r.position <= args.maxPosition && r.impressions >= args.minImpressions).map((r) => { const b = bench(r.position!); const ctr = r.ctr ?? 0; const gap = b - ctr; return { query: r.keys.query, page: r.keys.page, clicks: r.clicks, impressions: r.impressions, position: r.position, ctr, benchmarkCtr: b, extraClicksIfBenchmark: Math.round(Math.max(0, gap) * r.impressions), title: undefined as string | undefined }; }).filter((r) => r.extraClicksIfBenchmark > 0).sort((a, b) => b.extraClicksIfBenchmark - a.extraClicksIfBenchmark);
      const byPage = new Map<string, { page: string; potentialClicks: number; queries: number; topQuery: string }>();
      for (const h of hits) { const e = byPage.get(h.page) ?? { page: h.page, potentialClicks: 0, queries: 0, topQuery: h.query }; e.potentialClicks += h.extraClicksIfBenchmark; e.queries++; byPage.set(h.page, e); }
      return { siteUrl: args.siteUrl, period: { start: resolveDate(args.startDate), end: resolveDate(args.endDate) }, opportunities: hits.slice(0, args.top), pages: [...byPage.values()].sort((a, b) => b.potentialClicks - a.potentialClicks).slice(0, args.top), note: "extraClicksIfBenchmark = impressions x (benchmark CTR - current CTR) for the period; rewrite title/description of the top pages first." };
    }),
  );

}
