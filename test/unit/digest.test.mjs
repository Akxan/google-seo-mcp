import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionLines, compare, isDue, parseSchedule, periods, previousOccurrence, renderDigest, shiftDate } from "../../dist/digest.js";

const row = (key, clicks, impressions = clicks * 20, position = 10) => ({ keys: { page: key }, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test("periods returns two adjacent windows of the same length", () => {
  const p = periods("2026-09-19", 7);
  assert.deepEqual(p.current, { start: "2026-09-13", end: "2026-09-19" });
  assert.deepEqual(p.previous, { start: "2026-09-06", end: "2026-09-12" });
  assert.equal(shiftDate("2026-03-01", 1), "2026-02-28", "crosses a month");
  assert.equal(shiftDate("2026-01-01", 1), "2025-12-31", "crosses a year");
});

test("compare finds losers, winners, vanished and new keys, ignoring noise", () => {
  const now = [row("/a", 10), row("/b", 2), row("/keeps", 5), row("/new", 4), row("/tiny-new", 1)];
  const before = [row("/a", 30), row("/b", 1), row("/keeps", 5), row("/gone", 8), row("/gone-tiny", 1)];
  const r = compare(now, before);
  assert.deepEqual(r.down.map((m) => m.key), ["/a"], "only real drops");
  assert.equal(r.down[0].delta, -20);
  assert.deepEqual(r.up.map((m) => m.key), ["/new"]);
  assert.deepEqual(r.lost.map((m) => m.key), ["/gone"], "a 1-click disappearance is not a finding");
  assert.deepEqual(r.fresh.map((m) => m.key), ["/new"]);
  assert.ok(!r.down.some((m) => m.key === "/keeps"), "unchanged pages are left out");
  assert.deepEqual(compare(now, before, 15).down.map((m) => m.key), ["/a"], "a 20-click drop still clears a bar of 15");
  assert.deepEqual(compare(now, before, 25).down, [], "and is filtered out by a bar of 25");
  assert.deepEqual(compare(now, before, 25).fresh, [], "so is a 4-click newcomer");
});

test("attentionLines says what happened before any table is read", () => {
  const base = { site: "sc-domain:example.com", period: periods("2026-09-19", 7), pagesDown: [], pagesUp: [], queriesDown: [], queriesUp: [], lostQueries: [], newQueries: [] };
  const totals = (clicks, prev, positionDelta = null) => ({ clicks, impressions: 100, ctr: 0.1, position: 9, previous: { clicks: prev, impressions: 100, ctr: 0.1, position: 9 }, clicksDelta: clicks - prev, impressionsDelta: 0, positionDelta });
  assert.match(attentionLines({ ...base, totals: totals(30, 100) })[0], /fell 70%/);
  assert.match(attentionLines({ ...base, totals: totals(100, 30) })[0], /rose 233%/);
  assert.match(attentionLines({ ...base, totals: totals(50, 50, 2.4) }).join(" "), /position worsened by 2.4/);
  assert.match(attentionLines({ ...base, totals: totals(50, 50, -3.1) }).join(" "), /position improved by 3.1/);
  assert.match(attentionLines({ ...base, totals: totals(50, 50) })[0], /Nothing moved/);
  assert.match(attentionLines({ ...base, totals: totals(0, 0) })[0], /No search traffic/);
  assert.match(attentionLines({ ...base, totals: totals(50, 50), lostQueries: [{ key: "x" }] }).join(" "), /1 query that brought clicks/);
});

test("renderDigest produces a readable report with the tables that have rows", () => {
  const digest = {
    site: "sc-domain:example.com",
    period: periods("2026-09-19", 7),
    totals: { clicks: 30, impressions: 900, ctr: 0.0333, position: 12.4, previous: { clicks: 50, impressions: 800, ctr: 0.0625, position: 10.1 }, clicksDelta: -20, impressionsDelta: 100, positionDelta: 2.3 },
    pagesDown: [{ key: "/es/tours/", clicks: 2, previousClicks: 18, delta: -16, impressions: 300, position: 14.1, previousPosition: 7.2 }],
    pagesUp: [], queriesDown: [], queriesUp: [],
    lostQueries: [{ key: "tour sevilla", clicks: 0, previousClicks: 9, delta: -9, impressions: 0, position: null, previousPosition: 8.4 }],
    newQueries: [],
    attention: ["Clicks fell 40% (50 → 30)."],
  };
  const md = renderDigest([digest]);
  assert.match(md, /## sc-domain:example\.com/);
  assert.match(md, /- Clicks fell 40%/);
  assert.match(md, /\| clicks \| 30 \| 50 \| -20 \|/);
  assert.match(md, /\| position \| 12\.4 \| 10\.1 \| \+2\.3 \(worse\) \|/, "a lower position is better, so the direction is spelled out");
  assert.match(md, /### Pages that lost clicks/);
  assert.match(md, /\/es\/tours\/.*-16.*was 7\.2/);
  assert.match(md, /### Queries that stopped bringing clicks/);
  assert.ok(!md.includes("### Pages that gained"), "empty tables are left out");
});

test("parseSchedule accepts weekday:hour and refuses anything else", () => {
  assert.deepEqual(parseSchedule("mon:08"), { weekday: 1, hour: 8 });
  assert.deepEqual(parseSchedule("SUN @ 23"), { weekday: 0, hour: 23 });
  for (const bad of ["monday:08", "mon:24", "mon", "", undefined, "8:mon"]) assert.equal(parseSchedule(bad), null, String(bad));
});

test("isDue fires once per week and survives a restart", () => {
  const schedule = { weekday: 1, hour: 8 };                       // Monday 08:00 UTC
  const monday = new Date("2026-09-21T08:00:00Z");
  assert.equal(previousOccurrence(schedule, monday).toISOString(), "2026-09-21T08:00:00.000Z");
  assert.equal(previousOccurrence(schedule, new Date("2026-09-21T07:59:00Z")).toISOString(), "2026-09-14T08:00:00.000Z");

  assert.equal(isDue(schedule, monday, null), true, "never run before");
  assert.equal(isDue(schedule, monday, "2026-09-21T08:00:01Z"), false, "already sent this week");
  assert.equal(isDue(schedule, new Date("2026-09-21T09:30:00Z"), "2026-09-21T08:00:01Z"), false, "a restart does not resend");
  assert.equal(isDue(schedule, new Date("2026-09-23T10:00:00Z"), "2026-09-14T08:00:01Z"), true, "a missed week is sent late");
  assert.equal(isDue(schedule, new Date("2026-09-20T12:00:00Z"), "2026-09-14T08:00:01Z"), false, "not due before the hour");
});
