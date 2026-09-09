import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { analyticsdata_v1beta } from "googleapis";
import { analyticsAdmin, analyticsData } from "../google.js";
import { resolveDate, round, toNumber, tool } from "../util.js";
import { normalizePath, query as gscQuery } from "./gsc.js";

const propertyId = z
  .string()
  .describe("GA4 property ID, e.g. '123456789' or 'properties/123456789'. Use ga_list_properties to discover it.");

function propertyName(id: string) {
  return id.startsWith("properties/") ? id : `properties/${id}`;
}

const MATCH_TYPES = ["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"] as const;

const simpleDimensionFilter = z.object({
  field: z.string().describe("Dimension API name, e.g. 'pagePath', 'sessionDefaultChannelGroup', 'country'."),
  value: z.string(),
  matchType: z.enum(MATCH_TYPES).default("EXACT"),
  caseSensitive: z.boolean().default(false),
  not: z.boolean().default(false).describe("Negate this filter."),
});

const simpleMetricFilter = z.object({
  field: z.string().describe("Metric API name, e.g. 'sessions'."),
  operation: z.enum(["EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL"]).default("GREATER_THAN"),
  value: z.number(),
});

function buildDimensionFilter(filters: z.infer<typeof simpleDimensionFilter>[] | undefined): analyticsdata_v1beta.Schema$FilterExpression | undefined {
  if (!filters?.length) return undefined;
  const exprs = filters.map((f) => {
    const expr: analyticsdata_v1beta.Schema$FilterExpression = {
      filter: { fieldName: f.field, stringFilter: { matchType: f.matchType, value: f.value, caseSensitive: f.caseSensitive } },
    };
    return f.not ? { notExpression: expr } : expr;
  });
  return exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };
}

function buildMetricFilter(filters: z.infer<typeof simpleMetricFilter>[] | undefined): analyticsdata_v1beta.Schema$FilterExpression | undefined {
  if (!filters?.length) return undefined;
  const exprs = filters.map((f) => ({
    filter: { fieldName: f.field, numericFilter: { operation: f.operation, value: { doubleValue: f.value } } },
  }));
  return exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };
}

function tabulate(res: analyticsdata_v1beta.Schema$RunReportResponse | analyticsdata_v1beta.Schema$RunRealtimeReportResponse) {
  const dimNames = (res.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metNames = (res.metricHeaders ?? []).map((h) => h.name ?? "");
  const rows = (res.rows ?? []).map((r) => {
    const o: Record<string, unknown> = {};
    dimNames.forEach((n, i) => (o[n] = r.dimensionValues?.[i]?.value ?? null));
    metNames.forEach((n, i) => (o[n] = toNumber(r.metricValues?.[i]?.value)));
    return o;
  });
  const totals = (res.totals ?? []).map((r) => {
    const o: Record<string, unknown> = {};
    metNames.forEach((n, i) => (o[n] = toNumber(r.metricValues?.[i]?.value)));
    return o;
  });
  return { dimensions: dimNames, metrics: metNames, rowCount: res.rowCount ?? rows.length, returnedRows: rows.length, totals, rows };
}

export function registerAnalyticsTools(server: McpServer) {
  server.registerTool(
    "ga_list_properties",
    {
      title: "List GA4 properties",
      description: "List all Google Analytics accounts and GA4 properties the authorized account can access. Requires the Analytics Admin API to be enabled.",
      inputSchema: {},
    },
    tool(async () => {
      const out: { account: string; accountName: string; property: string; propertyName: string }[] = [];
      let pageToken: string | undefined;
      do {
        const res = await analyticsAdmin().accountSummaries.list({ pageSize: 200, pageToken });
        for (const a of res.data.accountSummaries ?? []) {
          for (const p of a.propertySummaries ?? []) {
            out.push({
              account: a.account ?? "",
              accountName: a.displayName ?? "",
              property: p.property ?? "",
              propertyName: p.displayName ?? "",
            });
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    }),
  );

  server.registerTool(
    "ga_run_report",
    {
      title: "GA4 report",
      description:
        "Run a Google Analytics 4 Data API report. Common dimensions: date, pagePath, landingPage, sessionDefaultChannelGroup, sessionSource, sessionMedium, country, deviceCategory, eventName. Common metrics: sessions, activeUsers, totalUsers, newUsers, screenPageViews, engagementRate, averageSessionDuration, bounceRate, conversions, eventCount, keyEvents. Use ga_get_metadata to discover more. Optionally add a comparison date range.",
      inputSchema: {
        propertyId,
        startDate: z.string().default("28daysAgo").describe("YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'."),
        endDate: z.string().default("yesterday"),
        compareStartDate: z.string().optional().describe("Optional second date range start; adds a 'dateRange' dimension to rows."),
        compareEndDate: z.string().optional(),
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1).default(["sessions", "activeUsers", "screenPageViews"]),
        dimensionFilters: z.array(simpleDimensionFilter).optional().describe("Simple AND-ed dimension filters."),
        metricFilters: z.array(simpleMetricFilter).optional().describe("Simple AND-ed metric filters (applied after aggregation)."),
        dimensionFilter: z.any().optional().describe("Raw GA4 FilterExpression JSON. Overrides dimensionFilters when given."),
        metricFilter: z.any().optional().describe("Raw GA4 FilterExpression JSON. Overrides metricFilters when given."),
        orderBy: z
          .array(z.object({ metric: z.string().optional(), dimension: z.string().optional(), desc: z.boolean().default(true) }))
          .optional()
          .describe("Sort order. Defaults to first metric descending."),
        limit: z.number().int().min(1).max(100000).default(100),
        offset: z.number().int().min(0).default(0),
        keepEmptyRows: z.boolean().default(false),
      },
    },
    tool(async (args) => {
      const dateRanges = [{ startDate: args.startDate, endDate: args.endDate, name: "current" }];
      if (args.compareStartDate && args.compareEndDate) {
        dateRanges.push({ startDate: args.compareStartDate, endDate: args.compareEndDate, name: "previous" });
      }
      const orderBys: analyticsdata_v1beta.Schema$OrderBy[] | undefined = args.orderBy
        ? args.orderBy.map((o) =>
            o.dimension
              ? { dimension: { dimensionName: o.dimension }, desc: o.desc }
              : { metric: { metricName: o.metric ?? args.metrics[0] }, desc: o.desc },
          )
        : [{ metric: { metricName: args.metrics[0] }, desc: true }];
      const res = await analyticsData().properties.runReport({
        property: propertyName(args.propertyId),
        requestBody: {
          dateRanges,
          dimensions: args.dimensions.map((name) => ({ name })),
          metrics: args.metrics.map((name) => ({ name })),
          dimensionFilter: args.dimensionFilter ?? buildDimensionFilter(args.dimensionFilters),
          metricFilter: args.metricFilter ?? buildMetricFilter(args.metricFilters),
          orderBys,
          limit: String(args.limit),
          offset: String(args.offset),
          keepEmptyRows: args.keepEmptyRows,
          returnPropertyQuota: true,
        },
      });
      const q = res.data.propertyQuota;
      const quota = q ? { tokensPerDayRemaining: q.tokensPerDay?.remaining, tokensPerHourRemaining: q.tokensPerHour?.remaining } : undefined;
      return { property: propertyName(args.propertyId), dateRanges, ...tabulate(res.data), quota };
    }),
  );

  server.registerTool(
    "ga_run_realtime_report",
    {
      title: "GA4 realtime report",
      description:
        "Real-time (last 30 minutes) GA4 data. Dimensions: country, city, deviceCategory, unifiedScreenName, eventName, minutesAgo. Metrics: activeUsers, screenPageViews, eventCount, keyEvents.",
      inputSchema: {
        propertyId,
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1).default(["activeUsers"]),
        limit: z.number().int().min(1).max(100000).default(50),
      },
    },
    tool(async (args) => {
      const res = await analyticsData().properties.runRealtimeReport({
        property: propertyName(args.propertyId),
        requestBody: {
          dimensions: args.dimensions.map((name) => ({ name })),
          metrics: args.metrics.map((name) => ({ name })),
          limit: String(args.limit),
        },
      });
      return { property: propertyName(args.propertyId), ...tabulate(res.data) };
    }),
  );

  server.registerTool(
    "ga_get_metadata",
    {
      title: "GA4 dimensions & metrics metadata",
      description:
        "List the dimensions and metrics available for a GA4 property (including custom ones). Filter by a search string to keep the output small.",
      inputSchema: {
        propertyId,
        search: z.string().optional().describe("Case-insensitive substring matched against API name, UI name and category, e.g. 'page', 'conversion'."),
        kind: z.enum(["all", "dimensions", "metrics"]).default("all"),
      },
    },
    tool(async (args) => {
      const res = await analyticsData().properties.getMetadata({ name: `${propertyName(args.propertyId)}/metadata` });
      const q = args.search?.toLowerCase();
      const pick = <T extends { apiName?: string | null; uiName?: string | null; category?: string | null; description?: string | null; customDefinition?: boolean | null }>(items: T[] | undefined) =>
        (items ?? [])
          .filter((i) => !q || [i.apiName, i.uiName, i.category].some((s) => s?.toLowerCase().includes(q)))
          .map((i) => ({ apiName: i.apiName, uiName: i.uiName, category: i.category, description: i.description, custom: i.customDefinition ?? false }));
      return {
        dimensions: args.kind === "metrics" ? undefined : pick(res.data.dimensions),
        metrics: args.kind === "dimensions" ? undefined : pick(res.data.metrics),
      };
    }),
  );
  server.registerTool(
    "ga_compare_periods",
    {
      title: "GA4 period comparison",
      description:
        "Compare GA4 metrics between a current and a previous period, broken down by dimensions (default: channel group). Returns per-row current/previous/delta/percent change plus period totals. Use it for 'how did organic traffic change vs last month'.",
      inputSchema: {
        propertyId,
        dimensions: z.array(z.string()).default(["sessionDefaultChannelGroup"]),
        metrics: z.array(z.string()).min(1).default(["sessions", "activeUsers", "keyEvents"]),
        currentStart: z.string().default("28daysAgo"),
        currentEnd: z.string().default("yesterday"),
        previousStart: z.string().default("56daysAgo"),
        previousEnd: z.string().default("29daysAgo"),
        dimensionFilters: z.array(simpleDimensionFilter).optional(),
        limit: z.number().int().min(1).max(1000).default(50).describe("Rows returned (sorted by absolute change of the first metric)."),
      },
    },
    tool(async (args) => {
      const res = await analyticsData().properties.runReport({
        property: propertyName(args.propertyId),
        requestBody: {
          dateRanges: [
            { startDate: args.currentStart, endDate: args.currentEnd, name: "current" },
            { startDate: args.previousStart, endDate: args.previousEnd, name: "previous" },
          ],
          dimensions: args.dimensions.map((name) => ({ name })),
          metrics: args.metrics.map((name) => ({ name })),
          dimensionFilter: buildDimensionFilter(args.dimensionFilters),
          limit: "100000",
        },
      });
      const t = tabulate(res.data);
      const keyOf = (row: Record<string, unknown>) => args.dimensions.map((d) => String(row[d])).join(" | ");
      const merged = new Map<string, Record<string, unknown>>();
      const totals = { current: {} as Record<string, number>, previous: {} as Record<string, number> };
      for (const row of t.rows) {
        const period = String(row.dateRange) as "current" | "previous";
        const k = keyOf(row);
        const entry = merged.get(k) ?? Object.fromEntries(args.dimensions.map((d) => [d, row[d]]));
        for (const m of args.metrics) {
          const v = typeof row[m] === "number" ? (row[m] as number) : 0;
          entry[`${m}_${period}`] = v;
          totals[period][m] = (totals[period][m] ?? 0) + v;
        }
        merged.set(k, entry);
      }
      const rows = [...merged.values()].map((e) => {
        for (const m of args.metrics) {
          const c = (e[`${m}_current`] as number) ?? 0;
          const p = (e[`${m}_previous`] as number) ?? 0;
          e[`${m}_current`] = c;
          e[`${m}_previous`] = p;
          e[`${m}_delta`] = round(c - p, 4);
          e[`${m}_pct`] = p === 0 ? null : round(((c - p) / p) * 100, 1);
        }
        return e;
      });
      const first = args.metrics[0];
      rows.sort((a, b) => Math.abs(b[`${first}_delta`] as number) - Math.abs(a[`${first}_delta`] as number));
      const totalRows = Object.fromEntries(args.metrics.map((m) => {
        const c = totals.current[m] ?? 0, p = totals.previous[m] ?? 0;
        return [m, { current: round(c, 4), previous: round(p, 4), delta: round(c - p, 4), pct: p === 0 ? null : round(((c - p) / p) * 100, 1) }];
      }));
      return {
        property: propertyName(args.propertyId),
        current: { start: args.currentStart, end: args.currentEnd },
        previous: { start: args.previousStart, end: args.previousEnd },
        totals: totalRows,
        rows: rows.slice(0, args.limit),
      };
    }),
  );

  server.registerTool(
    "ga_landing_page_seo",
    {
      title: "Organic landing pages: GA4 + Search Console merged",
      description:
        "One table per landing page combining GA4 organic-search behaviour (sessions, engagement rate, bounce rate, avg. session duration, key events) with Search Console performance (clicks, impressions, CTR, position) for the same period. Requires both the GA4 property and the Search Console property of the same site.",
      inputSchema: {
        propertyId,
        siteUrl: z.string().describe("Search Console property for the same site, e.g. 'sc-domain:example.com'."),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("3daysAgo"),
        limit: z.number().int().min(1).max(1000).default(100),
        sortBy: z.enum(["clicks", "sessions", "impressions", "bounceRate"]).default("clicks"),
      },
    },
    tool(async (args) => {
      const start = resolveDate(args.startDate);
      const end = resolveDate(args.endDate);
      const [gaRes, gscRows] = await Promise.all([
        analyticsData().properties.runReport({
          property: propertyName(args.propertyId),
          requestBody: {
            dateRanges: [{ startDate: start, endDate: end }],
            dimensions: [{ name: "landingPagePlusQueryString" }],
            metrics: ["sessions", "activeUsers", "engagementRate", "bounceRate", "averageSessionDuration", "keyEvents"].map((name) => ({ name })),
            dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } },
            limit: "10000",
          },
        }),
        gscQuery({ siteUrl: args.siteUrl, startDate: start, endDate: end, dimensions: ["page"], rowLimit: 5000 }),
      ]);
      const ga = tabulate(gaRes.data).rows;
      type Merged = { path: string; sessions: number; activeUsers: number; engagementRate: number | null; bounceRate: number | null; avgSessionDurationSec: number | null; keyEvents: number; clicks: number; impressions: number; ctr: number | null; position: number | null; url: string | null };
      const merged = new Map<string, Merged>();
      const blank = (path: string): Merged => ({ path, sessions: 0, activeUsers: 0, engagementRate: null, bounceRate: null, avgSessionDurationSec: null, keyEvents: 0, clicks: 0, impressions: 0, ctr: null, position: null, url: null });
      for (const r of ga) {
        const path = normalizePath("https://x" + String(r.landingPagePlusQueryString ?? "/").replace(/\?.*$/, ""));
        const e = merged.get(path) ?? blank(path);
        const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
        const wSess = e.sessions + n("sessions");
        e.engagementRate = wSess ? round(((e.engagementRate ?? 0) * e.sessions + n("engagementRate") * n("sessions")) / wSess, 4) : null;
        e.bounceRate = wSess ? round(((e.bounceRate ?? 0) * e.sessions + n("bounceRate") * n("sessions")) / wSess, 4) : null;
        e.avgSessionDurationSec = wSess ? round(((e.avgSessionDurationSec ?? 0) * e.sessions + n("averageSessionDuration") * n("sessions")) / wSess, 1) : null;
        e.sessions = wSess;
        e.activeUsers += n("activeUsers");
        e.keyEvents += n("keyEvents");
        merged.set(path, e);
      }
      for (const r of gscRows) {
        const path = normalizePath(r.keys.page);
        const e = merged.get(path) ?? blank(path);
        e.clicks += r.clicks;
        e.impressions += r.impressions;
        e.position = r.position;
        e.ctr = e.impressions ? round(e.clicks / e.impressions, 4) : null;
        e.url = r.keys.page;
        merged.set(path, e);
      }
      const rows = [...merged.values()];
      const key = args.sortBy as keyof Merged;
      rows.sort((a, b) => ((b[key] as number) ?? 0) - ((a[key] as number) ?? 0));
      return {
        property: propertyName(args.propertyId),
        siteUrl: args.siteUrl,
        period: { start, end },
        pages: rows.length,
        totals: { sessions: rows.reduce((a, r) => a + r.sessions, 0), clicks: rows.reduce((a, r) => a + r.clicks, 0), impressions: rows.reduce((a, r) => a + r.impressions, 0) },
        rows: rows.slice(0, args.limit),
      };
    }),
  );

}
