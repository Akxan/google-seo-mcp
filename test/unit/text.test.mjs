import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, splitSentences, firstWords, displayWidth, contentWords, QUESTION_TERMS } from "../../dist/text.js";
import { fitResult } from "../../dist/util.js";
import { compactJsonSchema } from "../../dist/server.js";
import { shouldRetryGoogle } from "../../dist/google.js";

test("countWords counts Chinese and Japanese words without relying on spaces", () => {
  assert.equal(countWords("one two  three"), 3);
  assert.equal(countWords(""), 0);
  const zh = countWords("塞维利亚的犹太区保留了三座古老的犹太会堂。");
  assert.ok(zh >= 6 && zh <= 16, `zh=${zh}`);
  assert.ok(countWords("東京で日本語を勉強しています") >= 4);
  assert.ok(countWords("App 開發費用怎麼算") >= 3);
});

test("splitSentences splits after CJK full stops even without a following space", () => {
  assert.deepEqual(splitSentences("第一句。第二句！第三句？"), ["第一句。", "第二句！", "第三句？"]);
  assert.deepEqual(splitSentences("One. Two? Three!"), ["One.", "Two?", "Three!"]);
  assert.equal(splitSentences("كم السعر؟ هذا جيد").length, 2);
});

test("firstWords keeps the first n words in every script", () => {
  assert.equal(firstWords("a b c d e", 3), "a b c");
  const zh = firstWords("塞维利亚的犹太区保留了三座古老的犹太会堂", 3);
  assert.ok(zh.length > 0 && zh.length < 12, zh);
});

test("displayWidth counts East Asian characters as two columns", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("App開發"), 7);
});

test("contentWords drops common function words in several languages", () => {
  assert.deepEqual(contentWords("die Geschichte der Juden und Sevilla"), ["geschichte", "juden", "sevilla"]);
  assert.ok(!contentWords("les quartiers des villes").includes("les"));
  assert.ok(QUESTION_TERMS.has("warum") && QUESTION_TERMS.has("怎么") && QUESTION_TERMS.has("كيف"));
});

test("fitResult trims nested arrays, not only top-level ones", () => {
  const data = { reports: [{ name: "a", rows: Array.from({ length: 400 }, (_, i) => ({ i, v: "x".repeat(40) })) }, { name: "b", rows: [] }] };
  const out = fitResult(data, 5000);
  assert.ok(JSON.stringify(out.data).length <= 5000);
  assert.ok(out.data.reports[0].rows.length < 400 && out.data.reports[0].rows.length >= 5);
  assert.match(out.truncated, /reports\[0\]\.rows: \d+ of 400 items/);
  assert.equal(fitResult({ small: [1, 2, 3] }, 5000).truncated, undefined);
});

test("compactJsonSchema drops $schema and implicit safe-integer bounds only", () => {
  const s = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { n: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, m: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: 50 } } };
  assert.deepEqual(compactJsonSchema(s), { type: "object", properties: { n: { type: "integer", minimum: 0 }, m: { type: "integer", maximum: 50 } } });
});

test("shouldRetryGoogle retries transient failures, and POST only for read-only queries", () => {
  const cfg = (method, url, attempt = 0) => ({ method, url, retryConfig: { currentRetryAttempt: attempt, retry: 2 } });
  assert.equal(shouldRetryGoogle({ response: { status: 503 }, config: cfg("GET", "https://example.com/x") }), true);
  assert.equal(shouldRetryGoogle({ response: { status: 429 }, config: cfg("POST", "https://searchconsole.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query") }), true);
  assert.equal(shouldRetryGoogle({ response: { status: 503 }, config: cfg("POST", "https://analyticsadmin.googleapis.com/v1beta/properties/1/keyEvents") }), false);
  assert.equal(shouldRetryGoogle({ response: { status: 400 }, config: cfg("GET", "https://example.com/x") }), false);
  assert.equal(shouldRetryGoogle({ code: "ECONNRESET", config: cfg("GET", "https://example.com/x") }), true);
  assert.equal(shouldRetryGoogle({ response: { status: 503 }, config: cfg("GET", "https://example.com/x", 2) }), false);
});
