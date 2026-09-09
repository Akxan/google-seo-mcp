import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { analyticsdata_v1beta } from "googleapis";
import { analyticsAdmin, analyticsData, getAuth } from "../google.js";
import { google } from "googleapis";
import { resolveDate, round, toNumber, tool } from "../util.js";
import { normalizePath, query as gscQuery } from "./gsc.js";

const propertyId = z
  .string()
  .describe("GA4 property ID, e.g. '123456789' (see ga_list_properties).");

function propertyName(id: string) {
  return id.startsWith("properties/") ? id : `properties/${id}`;
}

const MATCH_TYPES = ["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"] as const;

const simpleDimensionFilter = z.object({
  field: z.string().describe("Dimension API name, e.g. pagePath, country."),
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
        "GA4 Data API report. Common dimensions: date, pagePath, landingPage, sessionDefaultChannelGroup, sessionSource, country, deviceCategory, eventName. Common metrics: sessions, activeUsers, newUsers, screenPageViews, engagementRate, bounceRate, keyEvents, eventCount (more via ga_get_metadata). Optional comparison range.",
      inputSchema: {
        propertyId,
        startDate: z.string().default("28daysAgo").describe("YYYY-MM-DD, today, yesterday or NdaysAgo."),
        endDate: z.string().default("yesterday"),
        compareStartDate: z.string().optional().describe("Second range start; adds a dateRange dimension."),
        compareEndDate: z.string().optional(),
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1).default(["sessions", "activeUsers", "screenPageViews"]),
        dimensionFilters: z.array(simpleDimensionFilter).optional().describe("AND-ed dimension filters."),
        metricFilters: z.array(simpleMetricFilter).optional().describe("AND-ed metric filters (post-aggregation)."),
        dimensionFilter: z.any().optional().describe("Raw FilterExpression; overrides dimensionFilters."),
        metricFilter: z.any().optional().describe("Raw FilterExpression; overrides metricFilters."),
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

  server.registerTool(
    "ga_run_pivot_report",
    {
      title: "GA4 pivot report",
      description:
        "Cross-tab one dimension against another, e.g. landing pages (rows) by device category (columns) with sessions. Simpler than the raw API: give rowDimension, columnDimension and metrics; the tool builds the two pivots and returns a matrix plus row totals.",
      inputSchema: {
        propertyId,
        rowDimension: z.string().default("landingPage"),
        columnDimension: z.string().default("deviceCategory"),
        metrics: z.array(z.string()).min(1).default(["sessions"]),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("yesterday"),
        dimensionFilters: z.array(simpleDimensionFilter).optional(),
        rowLimit: z.number().int().min(1).max(500).default(50),
        columnLimit: z.number().int().min(1).max(50).default(10),
      },
    },
    tool(async (args) => {
      const res = await analyticsData().properties.runPivotReport({
        property: propertyName(args.propertyId),
        requestBody: {
          dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
          dimensions: [{ name: args.rowDimension }, { name: args.columnDimension }],
          metrics: args.metrics.map((name) => ({ name })),
          dimensionFilter: buildDimensionFilter(args.dimensionFilters),
          pivots: [
            { fieldNames: [args.rowDimension], limit: String(args.rowLimit), orderBys: [{ metric: { metricName: args.metrics[0] }, desc: true }] },
            { fieldNames: [args.columnDimension], limit: String(args.columnLimit), orderBys: [{ metric: { metricName: args.metrics[0] }, desc: true }] },
          ],
        },
      });
      const d = res.data;
      const dimNames = (d.dimensionHeaders ?? []).map((h) => h.name ?? "");
      const metNames = (d.metricHeaders ?? []).map((h) => h.name ?? "");
      const rowIdx = dimNames.indexOf(args.rowDimension), colIdx = dimNames.indexOf(args.columnDimension);
      const matrix = new Map<string, Record<string, unknown>>();
      const columns = new Set<string>();
      for (const r of d.rows ?? []) {
        const rowKey = r.dimensionValues?.[rowIdx]?.value ?? "";
        const colKey = r.dimensionValues?.[colIdx]?.value ?? "";
        columns.add(colKey);
        const entry = matrix.get(rowKey) ?? { [args.rowDimension]: rowKey };
        for (const [i, m] of metNames.entries()) entry[`${colKey}.${m}`] = toNumber(r.metricValues?.[i]?.value);
        matrix.set(rowKey, entry);
      }
      const rows = [...matrix.values()].map((e) => { for (const m of metNames) e[`total.${m}`] = [...columns].reduce((s, c) => s + (typeof e[`${c}.${m}`] === "number" ? (e[`${c}.${m}`] as number) : 0), 0); return e; });
      rows.sort((a, b) => ((b[`total.${metNames[0]}`] as number) ?? 0) - ((a[`total.${metNames[0]}`] as number) ?? 0));
      return { property: propertyName(args.propertyId), period: { start: args.startDate, end: args.endDate }, rowDimension: args.rowDimension, columnDimension: args.columnDimension, columns: [...columns], metrics: metNames, rows };
    }),
  );

  server.registerTool(
    "ga_batch_run_reports",
    {
      title: "GA4 batch reports",
      description: "Run up to 5 standard reports in one API call (same property). Each item takes the same fields as ga_run_report's core: dimensions, metrics, startDate, endDate, dimensionFilters, limit. Returns one tabulated result per report, in order.",
      inputSchema: {
        propertyId,
        reports: z.array(z.object({
          name: z.string().optional().describe("Label echoed back in the result."),
          dimensions: z.array(z.string()).default([]),
          metrics: z.array(z.string()).min(1),
          startDate: z.string().default("28daysAgo"),
          endDate: z.string().default("yesterday"),
          dimensionFilters: z.array(simpleDimensionFilter).optional(),
          limit: z.number().int().min(1).max(10000).default(50),
        })).min(1).max(5),
      },
    },
    tool(async (args) => {
      const res = await analyticsData().properties.batchRunReports({
        property: propertyName(args.propertyId),
        requestBody: { requests: args.reports.map((r) => ({ dateRanges: [{ startDate: r.startDate, endDate: r.endDate }], dimensions: r.dimensions.map((name) => ({ name })), metrics: r.metrics.map((name) => ({ name })), dimensionFilter: buildDimensionFilter(r.dimensionFilters), limit: String(r.limit), orderBys: [{ metric: { metricName: r.metrics[0] }, desc: true }] })) },
      });
      return { property: propertyName(args.propertyId), reports: (res.data.reports ?? []).map((rep, i) => ({ name: args.reports[i].name ?? `report ${i + 1}`, period: { start: args.reports[i].startDate, end: args.reports[i].endDate }, ...tabulate(rep) })) };
    }),
  );

  server.registerTool(
    "ga_run_funnel_report",
    {
      title: "GA4 funnel report",
      description:
        "Funnel (v1alpha): users reaching each step and drop-off between steps. Steps are event names with an optional page-path filter, e.g. [{name:'Tour page', event:'page_view', pagePathContains:'/tours/'}, {name:'Book', event:'click_book'}]. Open by default; closed=true requires entering at step 1. Optional breakdown dimension.",
      inputSchema: {
        propertyId,
        steps: z.array(z.object({ name: z.string(), event: z.string().describe("Event name, e.g. page_view, view_item, purchase."), pagePathContains: z.string().optional().describe("Only count the event on pages whose path contains this.") })).min(2).max(10),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("yesterday"),
        closed: z.boolean().default(false),
        breakdown: z.string().optional().describe("Dimension to break the funnel down by, e.g. 'deviceCategory' or 'sessionDefaultChannelGroup'."),
      },
    },
    tool(async (args) => {
      const auth = getAuth();
      const client = await auth.getClient();
      const stepFilter = (s: { event: string; pagePathContains?: string }) => {
        const eventFilter = { funnelFieldFilter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: s.event } } };
        if (!s.pagePathContains) return { funnelFilterExpression: eventFilter };
        return { funnelFilterExpression: { andGroup: { expressions: [eventFilter, { funnelFieldFilter: { fieldName: "unifiedPagePathScreen", stringFilter: { matchType: "CONTAINS", value: s.pagePathContains, caseSensitive: false } } }] } } };
      };
      const body: Record<string, unknown> = {
        dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
        funnel: { isOpenFunnel: !args.closed, steps: args.steps.map((s) => ({ name: s.name, filterExpression: stepFilter(s).funnelFilterExpression })) },
      };
      if (args.breakdown) body.funnelBreakdown = { breakdownDimension: { name: args.breakdown }, limit: "5" };
      const res = await client.request<{ funnelTable?: { dimensionHeaders?: { name: string }[]; metricHeaders?: { name: string }[]; rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[] } }>({ url: `https://analyticsdata.googleapis.com/v1alpha/${propertyName(args.propertyId)}:runFunnelReport`, method: "POST", data: body });
      const t = res.data.funnelTable ?? {};
      const dims = (t.dimensionHeaders ?? []).map((h) => h.name);
      // The alpha API repeats the metric headers; keep the first occurrence of each name.
      const mets = [...new Set((t.metricHeaders ?? []).map((h) => h.name))];
      const rows = (t.rows ?? []).map((r) => { const o: Record<string, unknown> = {}; dims.forEach((n, i) => (o[n] = r.dimensionValues?.[i]?.value)); mets.forEach((n, i) => { if (i < (r.metricValues?.length ?? 0)) o[n] = toNumber(r.metricValues?.[i]?.value); }); return o; });
      return { property: propertyName(args.propertyId), period: { start: args.startDate, end: args.endDate }, openFunnel: !args.closed, steps: args.steps.map((x) => x.name), dimensions: dims, metrics: mets, rows, note: "activeUsers per step; completion rate and abandonments are relative to the previous step." };
    }),
  );

  server.registerTool(
    "ga_check_compatibility",
    {
      title: "Check dimension/metric compatibility",
      description: "Ask GA4 whether a set of dimensions and metrics can be queried together (some combinations are incompatible) and which additional fields are still compatible. Use before building an unusual ga_run_report.",
      inputSchema: { propertyId, dimensions: z.array(z.string()).default([]), metrics: z.array(z.string()).default([]), onlyIncompatible: z.boolean().default(true).describe("Return only fields flagged incompatible (default) instead of the full compatible lists.") },
    },
    tool(async (args) => {
      let d: analyticsdata_v1beta.Schema$CheckCompatibilityResponse;
      try {
        d = (await analyticsData().properties.checkCompatibility({ property: propertyName(args.propertyId), requestBody: { dimensions: args.dimensions.map((name) => ({ name })), metrics: args.metrics.map((name) => ({ name })), compatibilityFilter: args.onlyIncompatible ? "INCOMPATIBLE" : "COMPATIBILITY_UNSPECIFIED" } })).data;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/incompatible/i.test(msg)) return { property: propertyName(args.propertyId), requested: { dimensions: args.dimensions, metrics: args.metrics }, compatible: false, reason: "GA4 rejects this exact combination: " + msg.slice(0, 200), hint: "Remove one field at a time and re-check; source/medium dimensions cannot be combined with organicGoogleSearch* metrics, item* dimensions need item-scoped metrics." };
        throw e;
      }
      const pick = (list: { dimensionMetadata?: { apiName?: string | null } | null; metricMetadata?: { apiName?: string | null } | null; compatibility?: string | null }[] | undefined) => (list ?? []).map((x) => ({ name: x.dimensionMetadata?.apiName ?? x.metricMetadata?.apiName, compatibility: x.compatibility }));
      const all = [...pick(d.dimensionCompatibilities), ...pick(d.metricCompatibilities)];
      const requested = new Set([...args.dimensions, ...args.metrics]);
      const requestedIncompatible = all.filter((x) => x.compatibility === "INCOMPATIBLE" && requested.has(String(x.name))).map((x) => x.name);
      const othersIncompatible = all.filter((x) => x.compatibility === "INCOMPATIBLE" && !requested.has(String(x.name))).map((x) => x.name);
      return { property: propertyName(args.propertyId), requested: { dimensions: args.dimensions, metrics: args.metrics }, compatible: requestedIncompatible.length === 0, requestedIncompatible, otherFieldsNowIncompatible: othersIncompatible.length, otherFieldsNowIncompatibleSample: othersIncompatible.slice(0, 15), dimensions: args.onlyIncompatible ? undefined : pick(d.dimensionCompatibilities), metrics: args.onlyIncompatible ? undefined : pick(d.metricCompatibilities) };
    }),
  );

  server.registerTool(
    "ga_property_config",
    {
      title: "GA4 property configuration (read-only)",
      description: "Read a property's setup: details (time zone, currency, industry, created), data retention, data streams (with measurement IDs and enhanced-measurement settings for web streams), custom dimensions and metrics, key events (conversions), Google Ads links and audiences. Choose sections to keep the output small.",
      inputSchema: { propertyId, sections: z.array(z.enum(["details", "streams", "customDimensions", "customMetrics", "keyEvents", "adsLinks", "audiences", "retention"])).default(["details", "streams", "customDimensions", "customMetrics", "keyEvents", "adsLinks", "audiences", "retention"]) },
    },
    tool(async (args) => {
      const name = propertyName(args.propertyId);
      const admin = analyticsAdmin();
      const alpha = google.analyticsadmin({ version: "v1alpha", auth: getAuth() });
      const want = new Set(args.sections);
      const out: Record<string, unknown> = { property: name };
      const tasks: Promise<void>[] = [];
      if (want.has("details")) tasks.push(admin.properties.get({ name }).then((r) => { out.details = { displayName: r.data.displayName, timeZone: r.data.timeZone, currencyCode: r.data.currencyCode, industryCategory: r.data.industryCategory, serviceLevel: r.data.serviceLevel, createTime: r.data.createTime, parent: r.data.parent }; }));
      if (want.has("retention")) tasks.push(admin.properties.getDataRetentionSettings({ name: `${name}/dataRetentionSettings` }).then((r) => { out.dataRetention = { eventDataRetention: r.data.eventDataRetention, resetUserDataOnNewActivity: r.data.resetUserDataOnNewActivity }; }));
      if (want.has("streams")) tasks.push(admin.properties.dataStreams.list({ parent: name }).then(async (r) => {
        const streams = await Promise.all((r.data.dataStreams ?? []).map(async (s) => {
          const base = { name: s.name, displayName: s.displayName, type: s.type, createTime: s.createTime, web: s.webStreamData ? { measurementId: s.webStreamData.measurementId, defaultUri: s.webStreamData.defaultUri } : undefined };
          if (s.type === "WEB_DATA_STREAM" && s.name) { try { const em = await alpha.properties.dataStreams.getEnhancedMeasurementSettings({ name: `${s.name}/enhancedMeasurementSettings` }); return { ...base, enhancedMeasurement: { enabled: em.data.streamEnabled, scrolls: em.data.scrollsEnabled, outboundClicks: em.data.outboundClicksEnabled, siteSearch: em.data.siteSearchEnabled, videoEngagement: em.data.videoEngagementEnabled, fileDownloads: em.data.fileDownloadsEnabled, pageChanges: em.data.pageChangesEnabled, formInteractions: em.data.formInteractionsEnabled } }; } catch { return base; } }
          return base;
        }));
        out.dataStreams = streams;
      }));
      if (want.has("customDimensions")) tasks.push(admin.properties.customDimensions.list({ parent: name, pageSize: 200 }).then((r) => { out.customDimensions = (r.data.customDimensions ?? []).map((d) => ({ parameterName: d.parameterName, displayName: d.displayName, scope: d.scope, description: d.description })); }));
      if (want.has("customMetrics")) tasks.push(admin.properties.customMetrics.list({ parent: name, pageSize: 200 }).then((r) => { out.customMetrics = (r.data.customMetrics ?? []).map((m) => ({ parameterName: m.parameterName, displayName: m.displayName, scope: m.scope, unit: m.measurementUnit })); }));
      if (want.has("keyEvents")) tasks.push(admin.properties.keyEvents.list({ parent: name, pageSize: 200 }).then((r) => { out.keyEvents = (r.data.keyEvents ?? []).map((k) => ({ eventName: k.eventName, countingMethod: k.countingMethod, custom: k.custom, createTime: k.createTime })); }));
      if (want.has("adsLinks")) tasks.push(admin.properties.googleAdsLinks.list({ parent: name }).then((r) => { out.googleAdsLinks = (r.data.googleAdsLinks ?? []).map((l) => ({ customerId: l.customerId, canManageClients: l.canManageClients, adsPersonalizationEnabled: l.adsPersonalizationEnabled, createTime: l.createTime })); }));
      if (want.has("audiences")) tasks.push(alpha.properties.audiences.list({ parent: name, pageSize: 200 }).then((r) => { out.audiences = (r.data.audiences ?? []).map((a) => ({ displayName: a.displayName, description: a.description, membershipDurationDays: a.membershipDurationDays, adsPersonalizationEnabled: a.adsPersonalizationEnabled })); }).catch((e) => { out.audiences = { error: (e as Error).message.slice(0, 200) }; }));
      await Promise.all(tasks);
      return out;
    }),
  );

}
