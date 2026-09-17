import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate, round, toNumber, formatError } from "../../dist/util.js";
import { parseDotEnv, envValue } from "../../dist/env.js";
import { isAdditive, periodTotals, buildDimensionFilter, buildOrderBys, dataQuality, quotaOf, audienceFilterText, compactAudienceClauses } from "../../dist/tools/ga.js";

test("resolveDate keeps ISO dates and resolves relative ones", () => {
  assert.equal(resolveDate("2026-01-31"), "2026-01-31");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(resolveDate("today"), today);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 7);
  assert.equal(resolveDate("7daysAgo"), d.toISOString().slice(0, 10));
  assert.throws(() => resolveDate("last week"), /Invalid date/);
});

test("round and toNumber", () => {
  assert.equal(round(0.123456, 2), 0.12);
  assert.equal(round(null, 2), null);
  assert.equal(toNumber("42"), 42);
  assert.equal(toNumber("(not set)"), "(not set)");
  assert.equal(toNumber(undefined), null);
});

test("formatError adds hints for auth problems", () => {
  assert.match(formatError(new Error("Could not load the default credentials")), /npm run auth/);
  assert.match(formatError({ response: { status: 403, data: { error: { message: "x", status: "PERMISSION_DENIED" } } } }), /added as a user/);
});

test("parseDotEnv handles quotes, comments and empty values", () => {
  const env = parseDotEnv(`# comment\nA=1\nB="two words"\nC='x' \nD=val # trailing comment\nE=\nexport F=6\nBAD LINE\n`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "val", F: "6" });
  assert.equal("E" in env, false);
});

test("envValue treats empty and blank variables as unset", () => {
  process.env.SEO_MCP_TEST_EMPTY = "";
  process.env.SEO_MCP_TEST_BLANK = "   ";
  process.env.SEO_MCP_TEST_SET = " value ";
  assert.equal(envValue("SEO_MCP_TEST_EMPTY"), undefined);
  assert.equal(envValue("SEO_MCP_TEST_BLANK"), undefined);
  assert.equal(envValue("SEO_MCP_TEST_SET"), "value");
  assert.equal(envValue("SEO_MCP_TEST_MISSING"), undefined);
  assert.equal(envValue("SEO_MCP_TEST_EMPTY") ?? "fallback", "fallback");
});

test("isAdditive rejects rates and averages, accepts counts", () => {
  for (const m of ["sessions", "activeUsers", "screenPageViews", "keyEvents", "eventCount"]) assert.equal(isAdditive(m), true, m);
  for (const m of ["engagementRate", "bounceRate", "averageSessionDuration", "sessionsPerUser"]) assert.equal(isAdditive(m), false, m);
});

test("periodTotals splits the API totals by date-range name", () => {
  const out = periodTotals({
    dimensionHeaders: [{ name: "pagePath" }, { name: "dateRange" }],
    metricHeaders: [{ name: "sessions" }, { name: "engagementRate" }],
    totals: [
      { dimensionValues: [{ value: "RESERVED_TOTAL" }, { value: "current" }], metricValues: [{ value: "120" }, { value: "0.64" }] },
      { dimensionValues: [{ value: "RESERVED_TOTAL" }, { value: "previous" }], metricValues: [{ value: "90" }, { value: "0.58" }] },
    ],
  });
  assert.deepEqual(out.current, { sessions: 120, engagementRate: 0.64 });
  assert.deepEqual(out.previous, { sessions: 90, engagementRate: 0.58 });
});

test("periodTotals returns nothing when the report has no dateRange dimension", () => {
  assert.deepEqual(periodTotals({ dimensionHeaders: [{ name: "pagePath" }], metricHeaders: [{ name: "sessions" }], totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: [{ value: "5" }] }] }), {});
});

test("buildDimensionFilter builds string, inList, not, and/or expressions", () => {
  assert.equal(buildDimensionFilter(undefined), undefined);
  assert.equal(buildDimensionFilter([]), undefined);
  assert.deepEqual(buildDimensionFilter([{ field: "pagePath", value: "/x", matchType: "CONTAINS", caseSensitive: true }]), {
    filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: "/x", caseSensitive: true } },
  });
  assert.deepEqual(buildDimensionFilter([{ field: "pagePath", values: ["/a", "/b"] }]), {
    filter: { fieldName: "pagePath", inListFilter: { values: ["/a", "/b"], caseSensitive: false } },
  });
  assert.deepEqual(buildDimensionFilter([{ field: "country", value: "ES", not: true }]), {
    notExpression: { filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "ES", caseSensitive: false } } },
  });
  const two = [{ field: "country", value: "ES" }, { field: "deviceCategory", value: "mobile" }];
  assert.equal(Object.keys(buildDimensionFilter(two))[0], "andGroup");
  assert.equal(Object.keys(buildDimensionFilter(two, "or"))[0], "orGroup");
  assert.equal(buildDimensionFilter(two, "or").orGroup.expressions.length, 2);
  assert.throws(() => buildDimensionFilter([{ field: "pagePath" }]), /one of value or values/);
  assert.throws(() => buildDimensionFilter([{ field: "pagePath", value: "/a", values: ["/b"] }]), /not both/);
});

test("buildOrderBys defaults to the first metric descending", () => {
  assert.deepEqual(buildOrderBys(undefined, "sessions"), [{ metric: { metricName: "sessions" }, desc: true }]);
  assert.deepEqual(buildOrderBys([], "sessions"), [{ metric: { metricName: "sessions" }, desc: true }]);
  assert.deepEqual(buildOrderBys([{ dimension: "date", desc: false }, { metric: "activeUsers" }], "sessions"), [
    { dimension: { dimensionName: "date" }, desc: false },
    { metric: { metricName: "activeUsers" }, desc: true },
  ]);
});

test("dataQuality only speaks up when the report is incomplete", () => {
  assert.equal(dataQuality(undefined), undefined);
  assert.equal(dataQuality({ currencyCode: "EUR", timeZone: "Europe/Madrid" }), undefined);
  const thresholded = dataQuality({ subjectToThresholding: true, dataLossFromOtherRow: true });
  assert.equal(thresholded.thresholded, true);
  assert.equal(thresholded.otherRowDataLoss, true);
  assert.match(thresholded.note, /threshold/);
  assert.match(thresholded.note, /\(other\)/);
  const sampled = dataQuality({ samplingMetadatas: [{ samplesReadCount: "250", samplingSpaceSize: "1000" }] });
  assert.deepEqual(sampled.sampling, [{ samplesRead: 250, samplingSpace: 1000, percent: 25 }]);
  assert.match(sampled.note, /25%/);
  assert.equal(dataQuality({ emptyReason: "NO_DATA" }).emptyReason, "NO_DATA");
});

test("quotaOf returns every bucket the response carried", () => {
  assert.equal(quotaOf(undefined), undefined);
  assert.equal(quotaOf({ tokensPerDay: {} }), undefined);
  assert.deepEqual(quotaOf({ tokensPerDay: { consumed: 3, remaining: 24997 }, concurrentRequests: { remaining: 10 } }), {
    tokensPerDay: { consumed: 3, remaining: 24997 },
    concurrentRequests: { consumed: null, remaining: 10 },
  });
});

test("audienceFilterText renders the clauses that define an audience", () => {
  assert.equal(audienceFilterText(undefined), "");
  assert.equal(
    audienceFilterText({ dimensionOrMetricFilter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: "/tours/" } } }),
    'pagePath CONTAINS "/tours/"',
  );
  assert.equal(audienceFilterText({ eventFilter: { eventName: "purchase" } }), "event purchase");
  assert.equal(
    audienceFilterText({
      andGroup: {
        filterExpressions: [
          { eventFilter: { eventName: "purchase" } },
          { notExpression: { dimensionOrMetricFilter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN", value: { int64Value: "3" } } } } },
        ],
      },
    }),
    "event purchase AND NOT sessions GREATER_THAN 3",
  );
  assert.equal(
    audienceFilterText({ orGroup: { filterExpressions: [{ dimensionOrMetricFilter: { fieldName: "country", inListFilter: { values: ["ES", "FR"] } } }] } }),
    "(country IN [ES, FR])",
  );
});

test("compactAudienceClauses keeps the scope, type and sequence steps", () => {
  assert.deepEqual(compactAudienceClauses(undefined), []);
  assert.deepEqual(
    compactAudienceClauses([
      { clauseType: "INCLUDE", simpleFilter: { scope: "AUDIENCE_FILTER_SCOPE_WITHIN_SAME_SESSION", filterExpression: { eventFilter: { eventName: "purchase" } } } },
      {
        clauseType: "EXCLUDE",
        sequenceFilter: {
          scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS",
          sequenceMaximumDuration: "600s",
          sequenceSteps: [{ filterExpression: { eventFilter: { eventName: "view_item" } } }, { filterExpression: { eventFilter: { eventName: "purchase" } } }],
        },
      },
    ]),
    [
      { type: "INCLUDE", scope: "WITHIN_SAME_SESSION", filter: "event purchase" },
      { type: "EXCLUDE", scope: "ACROSS_ALL_SESSIONS", maxDuration: "600s", sequence: ["event view_item", "event purchase"] },
    ],
  );
});
