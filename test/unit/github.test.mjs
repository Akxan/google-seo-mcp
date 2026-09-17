import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits, sliceUtf8 } from "../../dist/tools/github.js";

test("applyTextEdits replaces a unique match, in order, without $-pattern surprises", () => {
  const r = applyTextEdits("a=1\nb=2\nc=3\n", [{ find: "b=2", replace: "b=$&20" }, { find: "c=3", replace: "" }]);
  assert.equal(r.text, "a=1\nb=$&20\n\n");
  assert.equal(r.applied, 2);
});

test("applyTextEdits refuses missing and ambiguous finds unless all=true", () => {
  assert.throws(() => applyTextEdits("x y x", [{ find: "z", replace: "" }]), /not found/);
  assert.throws(() => applyTextEdits("x y x", [{ find: "x", replace: "q" }]), /occurs 2 times/);
  const r = applyTextEdits("x y x", [{ find: "x", replace: "q", all: true }]);
  assert.deepEqual(r, { text: "q y q", applied: 2 });
});

test("sliceUtf8 pages through a file without splitting a multibyte character", () => {
  const buf = Buffer.from("aé€ñz", "utf8"); // 1 + 2 + 3 + 2 + 1 = 9 bytes
  const first = sliceUtf8(buf, 0, 2);
  assert.equal(first.text, "a"); // backed off the middle of "é"
  assert.deepEqual([first.start, first.end, first.truncated], [0, 1, true]);
  const second = sliceUtf8(buf, first.end, 4);
  assert.equal(second.text, "é"); // "€" would not fit whole
  const rest = sliceUtf8(buf, second.end, 100);
  assert.equal(rest.text, "€ñz");
  assert.equal(rest.truncated, false);
  assert.equal(first.text + second.text + rest.text, "aé€ñz");
});

test("sliceUtf8 clamps a wild offset and never returns half a character", () => {
  const buf = Buffer.from("héllo", "utf8");
  assert.deepEqual(sliceUtf8(buf, 999, 10), { text: "", start: 6, end: 6, truncated: false });
  assert.equal(sliceUtf8(buf, 2, 10).text, "llo"); // offset 2 sits inside "é": move to the next lead byte
  assert.equal(sliceUtf8(buf, 0, 1).text, "h");
});
