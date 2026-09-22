import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits, sliceUtf8, imageContentRefusal, MAX_INLINE_IMAGE_BYTES } from "../../dist/tools/github.js";

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

// Binary image content must never travel through the model as base64 (2026-09-14: a committed
// 67 KB WebP whose header was valid and whose pixels were noise).
const big = (head) => Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(MAX_INLINE_IMAGE_BYTES, 0x41)]);

test("imageContentRefusal stops model-written image bytes and names the tool to use", () => {
  const webp = big("RIFF\u0000\u0000\u0000\u0000WEBP");
  const msg = imageContentRefusal("src/assets/hero.webp", webp);
  assert.match(msg, /github_commit_image/);
  assert.match(msg, /image header detected/);
  for (const [name, head] of [["png", "\x89PNG\r\n\x1a\n"], ["jpeg", "\xff\xd8\xff\xe0"], ["gif", "GIF89a"], ["bmp", "BM\u0000\u0000"], ["ico", "\u0000\u0000\u0001\u0000"]]) {
    assert.ok(imageContentRefusal(`x.${name}`, big(head)), name);
  }
  assert.ok(imageContentRefusal("img/photo.jpg", Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 0x41)), "an image extension is refused even without a valid header");
  assert.match(imageContentRefusal("img/photo.jpg", Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 0x41)), /image file extension/);
});

test("imageContentRefusal leaves text, SVG and tiny files alone", () => {
  assert.equal(imageContentRefusal("src/pages/index.astro", Buffer.from("<html>".repeat(5000))), null);
  assert.equal(imageContentRefusal("public/logo.svg", Buffer.from(`<svg>${"<path/>".repeat(2000)}</svg>`)), null, "SVG is text a model may legitimately write");
  assert.equal(imageContentRefusal("public/favicon.ico", Buffer.alloc(1024, 1)), null, "a tiny icon still passes");
  assert.equal(imageContentRefusal("data.json", Buffer.from(JSON.stringify({ a: "x".repeat(9000) }))), null);
});
