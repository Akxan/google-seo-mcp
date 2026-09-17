import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate, round, toNumber, formatError } from "../../dist/util.js";
import { parseDotEnv, envValue } from "../../dist/env.js";
import { isAdditive, periodTotals } from "../../dist/tools/ga.js";

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
