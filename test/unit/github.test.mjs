import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits } from "../../dist/tools/github.js";

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
