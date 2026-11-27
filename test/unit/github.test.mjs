import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits, sliceUtf8, imageContentRefusal, MAX_INLINE_IMAGE_BYTES, sliceUtf8Fitting, findInText, commitMatches, matchCloudflareBuilds, combineBuildState } from "../../dist/tools/github.js";

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

test("sliceUtf8Fitting shrinks the window until the escaped text fits, so nextOffset never skips content", () => {
  const buf = Buffer.from('"a\\b"\n'.repeat(20000)); // quotes, backslashes and newlines double when JSON-escaped
  const s = sliceUtf8Fitting(buf, 0, 100000, 50000);
  assert.ok(JSON.stringify(s.text).length <= 50000);
  assert.equal(Buffer.byteLength(s.text), s.end - s.start);
  assert.equal(s.truncated, true);
  const plain = sliceUtf8Fitting(Buffer.from("x".repeat(3000)), 0, 100000, 50000);
  assert.equal(plain.end, 3000);
  assert.equal(plain.truncated, false);
});

// --- github_get_file find: grep a whole file (code search sees nothing in private repos) ---

test("findInText gives line numbers and UTF-8 byte offsets that sliceUtf8 can read from", () => {
  const text = "héllo\n€uro wörld\nfoo € bar\n";
  const r = findInText(text, "€");
  assert.equal(r.totalMatches, 2);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.matches.map((m) => m.line), [2, 3]);
  const buf = Buffer.from(text, "utf8");
  for (const m of r.matches) assert.equal(sliceUtf8(buf, m.byteOffset, 3).text, "€", "byteOffset points at the match start");
  assert.equal(r.matches[0].byteOffset, Buffer.byteLength("héllo\n"));
  assert.equal(r.matches[1].byteOffset, Buffer.byteLength("héllo\n€uro wörld\nfoo "));
});

test("findInText: literal by default, regex per line on request, ignoreCase both ways", () => {
  assert.equal(findInText("axb a.b", "a.b").totalMatches, 1, "metacharacters are literal unless regex=true");
  assert.equal(findInText("axb a.b", "a.b", { regex: true }).totalMatches, 2);
  const src = "import a from 'a';\nconst s = 'IMPORT b';\nImport c from 'c';\n";
  const r = findInText(src, "^import\\s+\\w+", { regex: true, ignoreCase: true });
  assert.deepEqual(r.matches.map((m) => m.line), [1, 3], "^ anchors at each line start");
  assert.equal(findInText(src, "import").totalMatches, 1, "case-sensitive by default");
  assert.equal(findInText(src, "IMPORT", { ignoreCase: true }).totalMatches, 3);
  assert.equal(findInText("ÉCOLE école", "école", { ignoreCase: true }).totalMatches, 2, "non-ASCII case folding");
  assert.equal(findInText("a-b", "a\\-b", { regex: true }).totalMatches, 1, "legacy escapes that unicode mode rejects still work");
});

test("findInText rejects an invalid regex clearly and stops a catastrophic one", () => {
  assert.throws(() => findInText("abc", "(unclosed", { regex: true }), /Invalid regex .*regex=false/);
  assert.throws(() => findInText("", ""), /must not be empty/);
  const t0 = Date.now();
  assert.throws(() => findInText(`${"a".repeat(40)}!`, "(a+)+$", { regex: true, timeoutMs: 200 }), /stopped after 200 ms/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(findInText("abc", "x*", { regex: true }).totalMatches, 4, "zero-length matches advance instead of looping");
});

test("findInText context is grep-style and clipped at the file edges", () => {
  const text = ["one", "two", "three", "four", "five"].join("\n") + "\n";
  assert.equal(findInText(text, "one", { context: 2 }).matches[0].excerpt, "1:one\n2-two\n3-three");
  assert.equal(findInText(text, "five", { context: 2 }).matches[0].excerpt, "3-three\n4-four\n5:five", "no phantom empty line after the final newline");
  assert.equal(findInText(text, "three", { context: 0 }).matches[0].excerpt, "3:three");
  assert.equal(findInText("a\r\nb\r\n", "b", { context: 1 }).matches[0].excerpt, "1-a\n2:b", "CRLF line ends are dropped");
});

test("findInText caps matches, counts them all, and centres long lines on the match", () => {
  const r = findInText("x ".repeat(30), "x", { maxMatches: 5, context: 0 });
  assert.equal(r.matches.length, 5);
  assert.equal(r.totalMatches, 30);
  assert.equal(r.truncated, true);
  const m = findInText(`${"a".repeat(9000)}NEEDLE${"b".repeat(9000)}`, "NEEDLE").matches[0];
  assert.match(m.excerpt, /NEEDLE/, "the match is visible even 9,000 characters into a one-line file");
  assert.ok(m.excerpt.length < 320, `excerpt stays short (${m.excerpt.length})`);
  assert.equal(m.byteOffset, 9000);
});

// --- github_build_status: Cloudflare Workers Builds and Pages (fixtures, no network) ---

const SHA = "3f2a9c1d4e5b6a7980f1e2d3c4b5a69788776655";
const OTHER = "a".repeat(40);
const wb = (uuid, hash, status, outcome, created) => ({
  build_uuid: uuid, status, build_outcome: outcome, created_on: created,
  build_trigger_metadata: { commit_hash: hash, branch: "main", repo_name: "my-site", provider_account_name: "octocat", environment_variables: { SOME_VAR: "do-not-leak" } },
});
const pd = (id, hash, stage, extra = {}) => ({
  id, url: `https://${id.slice(0, 8)}.docs.pages.dev`, environment: "production", created_on: "2026-01-02T10:00:00.000000Z",
  latest_stage: stage, deployment_trigger: { type: "github:push", metadata: { commit_hash: hash, branch: "main" } }, env_vars: { SOME_VAR: { value: "do-not-leak" } }, ...extra,
});

test("commitMatches accepts the full sha or a prefix of at least 7 characters", () => {
  assert.ok(commitMatches(SHA, SHA));
  assert.ok(commitMatches(SHA.slice(0, 7).toUpperCase(), SHA));
  assert.ok(!commitMatches(SHA.slice(0, 6), SHA));
  assert.ok(!commitMatches(OTHER, SHA));
  assert.ok(!commitMatches(undefined, SHA));
});

test("matchCloudflareBuilds picks the newest build of the commit per Worker / Pages project and copies no env vars", () => {
  const builds = matchCloudflareBuilds(SHA, "acct123", {
    workers: [
      { name: "my-site", builds: [wb("u-old", SHA, "stopped", "fail", "2026-01-02T10:00:00Z"), wb("u-new", SHA, "stopped", "success", "2026-01-02T10:05:00Z"), wb("u-x", OTHER, "running", null, "2026-01-02T11:00:00Z")] },
      { name: "unrelated", builds: [wb("u-y", OTHER, "stopped", "success", "2026-01-02T09:00:00Z")] },
    ],
    pages: [{ name: "docs", deployments: [pd("d1-0000-0000", SHA.slice(0, 12), { name: "build", status: "active" })] }],
  });
  assert.equal(builds.length, 2);
  const [w, p] = builds;
  assert.deepEqual({ provider: w.provider, name: w.name, status: w.status, detail: w.detail, branch: w.branch }, { provider: "workers", name: "my-site", status: "success", detail: "stopped/success", branch: "main" });
  assert.equal(w.url, "https://dash.cloudflare.com/acct123/workers/services/view/my-site/production/builds/u-new");
  assert.deepEqual({ provider: p.provider, status: p.status, detail: p.detail, environment: p.environment }, { provider: "pages", status: "running", detail: "build:active", environment: "production" });
  assert.equal(p.url, "https://dash.cloudflare.com/acct123/pages/view/docs/d1-0000-0000");
  assert.equal(p.deploymentUrl, "https://d1-0000-.docs.pages.dev");
  assert.doesNotMatch(JSON.stringify(builds), /do-not-leak/);
});

test("matchCloudflareBuilds maps Workers and Pages states", () => {
  const w = (status, outcome) => matchCloudflareBuilds(SHA, "a", { workers: [{ name: "w", builds: [wb("u", SHA, status, outcome, "2026-01-01T00:00:00Z")] }] })[0].status;
  assert.equal(w("queued", null), "queued");
  assert.equal(w("initializing", null), "running");
  assert.equal(w("running", null), "running");
  assert.equal(w("stopped", "success"), "success");
  assert.equal(w("stopped", "fail"), "failure");
  assert.equal(w("stopped", "cancelled"), "failure");
  assert.equal(w("stopped", "skipped"), "skipped");
  const p = (stage, extra) => matchCloudflareBuilds(SHA, "a", { pages: [{ name: "p", deployments: [pd("d", SHA, stage, extra)] }] })[0].status;
  assert.equal(p({ name: "queued", status: "idle" }), "queued");
  assert.equal(p({ name: "clone_repo", status: "active" }), "running");
  assert.equal(p({ name: "build", status: "success" }), "running", "built but not deployed yet");
  assert.equal(p({ name: "deploy", status: "success" }), "success");
  assert.equal(p({ name: "build", status: "failure" }), "failure");
  assert.equal(p({ name: "deploy", status: "canceled" }), "failure");
  assert.equal(p({ name: "queued", status: "idle" }, { is_skipped: true }), "skipped");
});

test("combineBuildState counts a Cloudflare success as built and waits for a running one", () => {
  const cf = (status) => [{ provider: "pages", name: "p", status, detail: "", url: "" }];
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "none" }, cf("success")), { settled: true, conclusion: "success" });
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "none" }, []), { settled: true, conclusion: "none" });
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "success" }, cf("running")), { settled: false, conclusion: "pending" });
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "none" }, cf("queued")), { settled: false, conclusion: "pending" });
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "success" }, cf("failure")), { settled: true, conclusion: "failure" });
  assert.deepEqual(combineBuildState({ settled: false, conclusion: "pending" }, cf("success")), { settled: false, conclusion: "pending" });
  assert.deepEqual(combineBuildState({ settled: true, conclusion: "none" }, cf("skipped")), { settled: true, conclusion: "none" });
});
