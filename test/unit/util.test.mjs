import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate, round, toNumber, formatError } from "../../dist/util.js";
import { parseDotEnv } from "../../dist/env.js";

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
