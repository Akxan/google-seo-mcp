import { test } from "node:test";
import assert from "node:assert/strict";
import { HostedStore, deriveKey, encrypt, decrypt, newToken, hashToken, signPayload, verifyPayload, TOKEN_PREFIX } from "../../dist/hosted/store.js";
import { HOSTED_SERVER_OPTIONS, HOSTED_SCOPES } from "../../dist/hosted/index.js";
import { pickLang, landingPage, dashboardPage, privacyPage } from "../../dist/hosted/pages.js";
import { isWriteTool } from "../../dist/server.js";

const key = deriveKey("test-secret");

test("encrypt/decrypt round-trips and rejects tampering", () => {
  const blob = encrypt("1//refresh-token", key);
  assert.equal(decrypt(blob, key), "1//refresh-token");
  assert.notEqual(encrypt("1//refresh-token", key), blob, "fresh IV per call");
  const parts = blob.split(".");
  parts[2] = parts[2].slice(0, -2) + "AA";
  assert.throws(() => decrypt(parts.join("."), key));
  assert.throws(() => decrypt(blob, deriveKey("other")));
});

test("tokens are prefixed, random and stored only as hashes", () => {
  const a = newToken(), b = newToken();
  assert.ok(a.startsWith(TOKEN_PREFIX) && a.length > 40);
  assert.notEqual(a, b);
  assert.equal(hashToken(a).length, 64);
});

test("signed payloads verify, expire and reject bad signatures", () => {
  const good = signPayload({ uid: "u1", exp: Date.now() + 1000 }, key);
  assert.equal(verifyPayload(good, key).uid, "u1");
  assert.equal(verifyPayload(good, deriveKey("x")), null);
  assert.equal(verifyPayload(signPayload({ uid: "u1", exp: Date.now() - 1 }, key), key), null);
  assert.equal(verifyPayload(good.slice(0, -1) + (good.endsWith("A") ? "B" : "A"), key), null);
  assert.equal(verifyPayload(undefined, key), null);
  assert.equal(verifyPayload("garbage", key), null);
});

test("store: users, tokens, resolve, revoke, delete cascade", () => {
  const s = new HostedStore(":memory:", key);
  const u = s.upsertUser({ googleSub: "sub1", email: "a@example.com", name: "A", refreshToken: "rt1", scopes: HOSTED_SCOPES });
  assert.equal(s.countUsers(), 1);
  assert.equal(s.refreshTokenOf(u.id), "rt1");
  // sign-in again without a refresh token keeps the stored one and updates profile
  const u2 = s.upsertUser({ googleSub: "sub1", email: "a2@example.com", refreshToken: null, scopes: HOSTED_SCOPES });
  assert.equal(u2.id, u.id);
  assert.equal(u2.email, "a2@example.com");
  assert.equal(s.refreshTokenOf(u.id), "rt1");
  assert.throws(() => s.upsertUser({ googleSub: "new", email: "n@example.com", refreshToken: null, scopes: [] }), /refresh token/);

  const { token, row } = s.createToken(u.id, "laptop");
  assert.equal(row.label, "laptop");
  assert.equal(row.prefix, token.slice(0, 10));
  const hit = s.resolveToken(token);
  assert.equal(hit.user.id, u.id);
  assert.equal(s.resolveToken("seo_nope"), null);
  assert.equal(s.resolveToken("not-a-token"), null);
  assert.equal(s.listTokens(u.id)[0].calls, 1);
  s.revokeToken(u.id, row.hash);
  assert.equal(s.resolveToken(token), null);
  s.revokeToken("someone-else", row.hash); // no-op for other users
  s.deleteUser(u.id);
  assert.equal(s.countUsers(), 0);
  assert.equal(s.listTokens(u.id).length, 0, "tokens cascade");
  s.close();
});

test("hosted server options are read-only and exclude paid tools", () => {
  assert.equal(HOSTED_SERVER_OPTIONS.readOnly, true);
  assert.ok(!HOSTED_SERVER_OPTIONS.toolsets.includes("wordpress") && !HOSTED_SERVER_OPTIONS.toolsets.includes("github") && !HOSTED_SERVER_OPTIONS.toolsets.includes("gmail"));
  for (const t of HOSTED_SERVER_OPTIONS.exclude) assert.equal(isWriteTool(t), false, `${t} is hidden by readOnly already`);
  assert.ok(HOSTED_SCOPES.every((s) => s === "openid" || /readonly|userinfo/.test(s)), "only read-only Google scopes");
});

test("pages: language pick and escaping", () => {
  assert.equal(pickLang(undefined, "zh-CN,zh;q=0.9", null), "zh");
  assert.equal(pickLang(undefined, "en-US", null), "en");
  assert.equal(pickLang("zh", "en-US", null), "zh");
  assert.equal(pickLang("zh", "zh", "en"), "en");
  const shell = { lang: "en", title: "t", user: null, repo: "https://github.com/octocat/x", path: "/" };
  assert.match(landingPage(shell, { toolCount: 80, verified: false }), /Sign in with Google/);
  const dash = dashboardPage({ ...shell, user: { email: "a@example.com", picture: null } }, { user: { email: "<b>x</b>@example.com", name: null, picture: null, createdAt: "2026-09-11T00:00:00Z", scopes: [] }, tokens: [], newToken: "seo_abc", endpoint: "https://mcp.example.com/mcp", csrf: "c" });
  assert.match(dash, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(dash, /seo_abc/);
  assert.match(privacyPage({ ...shell, lang: "zh" }, { contact: "c", host: "h" }), /隐私政策/);
});

import { generateKeyPairSync, createVerify } from "node:crypto";
import { appJwt } from "../../dist/hosted/githubApp.js";
import { createServer } from "../../dist/server.js";

test("store: connections upsert, read, delete, cascade", () => {
  const s = new HostedStore(":memory:", key);
  const u = s.upsertUser({ googleSub: "g", email: "g@example.com", refreshToken: "rt", scopes: [] });
  assert.equal(s.getConnection(u.id, "github"), null);
  s.setConnection(u.id, { provider: "github", externalId: "123", label: "octocat", meta: { selection: "selected" } });
  s.setConnection(u.id, { provider: "github", externalId: "456", label: "octocat" });
  const c = s.getConnection(u.id, "github");
  assert.equal(c.externalId, "456");
  assert.deepEqual(c.meta, {});
  s.deleteConnection(u.id, "github");
  assert.equal(s.getConnection(u.id, "github"), null);
  s.setConnection(u.id, { provider: "github", externalId: "1" });
  s.deleteUser(u.id);
  assert.equal(s.getConnection(u.id, "github"), null, "connections cascade with the user");
  s.close();
});

test("GitHub App JWT is RS256-signed with the expected claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = appJwt("12345", pem, 1_700_000_000);
  const [h, b, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url")), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "12345" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, "base64url")));
});

test("createServer honours readOnly + allowWrite + exclude", async () => {
  const names = (srv) => Object.keys(srv._registeredTools ?? {});
  const ro = createServer({ readOnly: true, toolsets: ["github"] });
  assert.ok(names(ro).includes("github_get_file") && !names(ro).some((n) => n.startsWith("github_commit_")));
  const gh = createServer({ readOnly: true, toolsets: ["github"], allowWrite: ["github_commit_"], exclude: ["github_commit_attachment"] });
  assert.ok(names(gh).includes("github_commit_files") && names(gh).includes("github_commit_image"));
  assert.ok(!names(gh).includes("github_commit_attachment"));
  assert.ok(!names(gh).includes("gsc_submit_sitemap"));
});
