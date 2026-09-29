import { test } from "node:test";
import assert from "node:assert/strict";
import { trackingGap } from "../../dist/tools/ga.js";

test("trackingGap stays quiet when GA4 roughly matches Search Console", () => {
  assert.equal(trackingGap(30, 25).severity, "none", "83% is a normal gap");
  assert.equal(trackingGap(100, 60).severity, "none", "ad blockers and bots explain tens of percent");
  assert.equal(trackingGap(100, 130).severity, "none", "GA4's Organic Search also counts Bing and others");
});

test("trackingGap does not judge a handful of clicks", () => {
  const r = trackingGap(12, 0);
  assert.equal(r.severity, "none");
  assert.equal(r.note, undefined);
  assert.deepEqual(trackingGap(0, 5), { ratio: null, severity: "none" });
});

test("trackingGap warns below half and escalates below a fifth", () => {
  const w = trackingGap(100, 35);
  assert.equal(w.severity, "warning");
  assert.equal(w.ratio, 0.35);
  const s = trackingGap(71, 0);
  assert.equal(s.severity, "severe", "the case that prompted this: 71 clicks, 0 organic sessions");
  assert.match(s.note, /71 clicks/);
  assert.match(s.note, /consent mode/);
  assert.match(s.note, /Search Console for search volume/);
});
