import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROWS, truncationOf, summarizeInspection } from "../../dist/tools/gsc.js";

test("truncationOf flags a response that came back at the row limit", () => {
  const full = truncationOf(MAX_ROWS);
  assert.equal(full.truncated, true);
  assert.match(full.truncationNote, /25000 rows/);
  const partial = truncationOf(MAX_ROWS - 1);
  assert.deepEqual(partial, { truncated: false });
  assert.equal(truncationOf(10, 10).truncated, true);
  assert.equal(truncationOf(9, 10).truncated, false);
});

const INSPECTION = {
  indexStatusResult: {
    verdict: "PASS",
    coverageState: "Submitted and indexed",
    googleCanonical: "https://example.com/a",
    userCanonical: "https://example.com/a",
    sitemap: ["https://example.com/post-sitemap.xml"],
    referringUrls: ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4", "https://example.com/5", "https://example.com/6"],
  },
  mobileUsabilityResult: { verdict: "VERDICT_UNSPECIFIED" },
  richResultsResult: {
    detectedItems: [
      {
        richResultType: "Breadcrumbs",
        items: [
          { name: "Breadcrumb 1", issues: [{ issueMessage: "Missing field 'item'", severity: "ERROR" }] },
          { name: "Breadcrumb 2", issues: [{ issueMessage: "Missing field 'item'", severity: "ERROR" }, { issueMessage: "Missing field 'name'", severity: "WARNING" }] },
        ],
      },
      { richResultType: "Article", items: [{ name: "Article" }] },
    ],
  },
};

test("summarizeInspection keeps sitemaps, caps referring URLs and reports the real count", () => {
  const r = summarizeInspection("https://example.com/a", INSPECTION);
  assert.deepEqual(r.sitemaps, ["https://example.com/post-sitemap.xml"]);
  assert.equal(r.referringUrls.length, 5);
  assert.equal(r.referringUrlsTotal, 6);
  assert.equal(r.canonicalMismatch, false);
  assert.equal(r.problem, false);
  assert.equal(r.orphan, undefined);
  assert.equal(r.mobileUsability, "VERDICT_UNSPECIFIED");
});

test("summarizeInspection surfaces rich result issues with severity, deduped per type", () => {
  const r = summarizeInspection("https://example.com/a", INSPECTION);
  assert.deepEqual(r.richResults, [
    {
      type: "Breadcrumbs",
      items: 2,
      issues: [
        { severity: "ERROR", message: "Missing field 'item'", items: 2 },
        { severity: "WARNING", message: "Missing field 'name'", items: 1 },
      ],
    },
    { type: "Article", items: 1, issues: undefined },
  ]);
});

test("summarizeInspection marks an indexed URL with no sitemap and no referring URLs as an orphan", () => {
  // lastCrawlTime marks a complete inspection result; without it the lists being empty proves nothing.
  const r = summarizeInspection("https://example.com/orphan", { indexStatusResult: { verdict: "PASS", coverageState: "Indexed, not submitted in sitemap", lastCrawlTime: "2026-09-16T01:58:56Z" } });
  assert.equal(r.orphan, true);
  assert.equal(r.sitemaps, undefined);
  assert.equal(r.referringUrls, undefined);
  assert.equal(r.referringUrlsTotal, undefined);
  assert.equal(r.richResults, undefined);
  // Only signals that exist end up in the JSON, so batches of 100 URLs stay small.
  assert.ok(!JSON.stringify(r).includes("null"));
});

test("summarizeInspection flags canonical mismatches and non-indexed URLs as problems", () => {
  const mismatch = summarizeInspection("https://example.com/b", {
    indexStatusResult: { verdict: "PASS", googleCanonical: "https://example.com/c", userCanonical: "https://example.com/b", sitemap: ["https://example.com/sitemap.xml"] },
  });
  assert.equal(mismatch.canonicalMismatch, true);
  assert.equal(mismatch.problem, true);
  assert.equal(mismatch.orphan, undefined, "a URL listed in a sitemap is never an orphan");
  const missing = summarizeInspection("https://example.com/d", undefined);
  assert.equal(missing.problem, true);
  assert.equal(missing.verdict, undefined);
});

test("summarizeInspection does not call a URL orphaned on a partial inspection result", () => {
  // Google omits sitemap/referringUrls (and lastCrawlTime) on partial results; absent must not read as "none".
  const partial = summarizeInspection("https://example.com/a", { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } });
  assert.equal(partial.orphan, undefined);
  const full = summarizeInspection("https://example.com/b", { indexStatusResult: { verdict: "PASS", lastCrawlTime: "2026-09-16T01:58:56Z" } });
  assert.equal(full.orphan, true);
});
