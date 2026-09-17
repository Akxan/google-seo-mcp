/**
 * End-to-end check of the OAuth layer (SEO_MCP_OAUTH=1): starts the HTTP server on a spare port and
 * walks the flow a real client performs — 401 discovery, both metadata documents, dynamic
 * registration, the approval page, code exchange with PKCE, a tools/list call with the issued
 * token, the read-only scope, refresh rotation, replay detection and revocation.
 * Loopback sockets only; no Google, WordPress or GitHub calls.
 *   node test/oauth-http.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const TOKEN = "test-operator-" + randomBytes(8).toString("hex");
const REDIRECT = "https://client.example.com/cb";
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-oauth-test-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

// Empty strings keep .env from filling these in: envValue() treats blank as unset.
const proc = spawn(process.execPath, [entry, "--http"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    MCP_TRANSPORT: "http", MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_PATH: "/mcp",
    MCP_AUTH_TOKEN: TOKEN, SEO_MCP_OAUTH: "1", SEO_MCP_DATA_DIR: dataDir,
    SEO_MCP_TOOLSETS: "gsc", SEO_MCP_READ_ONLY: "", SEO_MCP_PUBLIC_URL: "",
    SEO_MCP_HOSTED_CLIENT_ID: "", SEO_MCP_HOSTED_CLIENT_SECRET: "", SEO_MCP_HOSTED_SECRET: "",
    WP_SITES: "", GOOGLE_APPLICATION_CREDENTIALS: "", GOOGLE_CREDENTIALS_JSON: "", GMAIL_CREDENTIALS: "",
  },
});
let log = "";
proc.stderr.on("data", (d) => { log += String(d); });
await waitForStart();

try {
  // 1. An unauthenticated call must point the client at the metadata (RFC 9728).
  const anon = await mcp(null);
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("www-authenticate"), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);

  // 2. Both metadata documents, at the plain and the path-suffixed location clients try.
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const doc = await getJson(p);
    assert.equal(doc.resource, `${base}/mcp`, p);
    assert.deepEqual(doc.authorization_servers, [base], p);
  }
  const as = await getJson("/.well-known/oauth-authorization-server");
  assert.equal(as.issuer, base);
  assert.equal(as.authorization_endpoint, `${base}/oauth/authorize`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);

  // 3. Dynamic registration: redirect URIs are validated, then a client_id comes back.
  const bad = await postJson("/oauth/register", { client_name: "evil", redirect_uris: ["http://evil.example.com/cb"] });
  assert.equal(bad.status, 400, "http redirect off loopback is refused");
  const none = await postJson("/oauth/register", { client_name: "empty", redirect_uris: [] });
  assert.equal(none.status, 400, "redirect_uris is required");
  const reg = await postJson("/oauth/register", { client_name: "Test Client", redirect_uris: [REDIRECT] });
  assert.equal(reg.status, 201);
  const clientId = reg.body.client_id;
  assert.ok(clientId && reg.body.token_endpoint_auth_method === "none");

  // 4. Authorize: PKCE is mandatory, unknown clients never get redirected to.
  const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1" })}`, { redirect: "manual" });
  assert.equal(noPkce.status, 303);
  assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
  const unknown = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "nope", redirect_uri: REDIRECT })}`, { redirect: "manual" });
  assert.equal(unknown.status, 400, "unknown client_id stops on our own page");
  const mismatch = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://elsewhere.example/cb", code_challenge: "x", code_challenge_method: "S256" })}`, { redirect: "manual" });
  assert.equal(mismatch.status, 400, "unregistered redirect_uri stops on our own page");

  // 5. The approval page only issues a code for the operator token.
  const pending = await openApproval(clientId);
  const wrong = await postForm("/oauth/authorize", { approval: pending.approval, token: "not-the-token" });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /not the operator token/);
  const stale = await postForm("/oauth/authorize", { approval: "forged.payload", token: TOKEN });
  assert.equal(stale.status, 400, "an unsigned approval blob is refused");

  // 6. A wrong PKCE verifier cannot redeem a code, and the code is spent either way.
  const first = await approve(clientId, {});
  const badVerifier = await postForm("/oauth/token", { grant_type: "authorization_code", code: first.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: randomBytes(32).toString("base64url") });
  assert.equal(badVerifier.status, 400);
  assert.equal(JSON.parse(badVerifier.text).error, "invalid_grant");
  const replayCode = await postForm("/oauth/token", { grant_type: "authorization_code", code: first.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: first.verifier });
  assert.equal(replayCode.status, 400, "codes are single use");

  // 7. The full flow, and the token works on /mcp.
  const full = await exchange(clientId, await approve(clientId, {}));
  assert.equal(full.token_type, "Bearer");
  assert.equal(full.scope, "mcp:full");
  assert.ok(full.access_token.startsWith("mcpa_") && full.refresh_token.startsWith("mcpr_"));
  const listed = await mcp(full.access_token);
  assert.equal(listed.status, 200);
  assert.match(listed.text, /gsc_search_analytics/);
  assert.match(listed.text, /gsc_submit_sitemap/, "mcp:full keeps the write tools");

  // 8. The read-only checkbox on the approval page removes the write tools.
  const ro = await exchange(clientId, await approve(clientId, { readonly: "1" }));
  assert.equal(ro.scope, "mcp:read");
  const roList = await mcp(ro.access_token);
  assert.equal(roList.status, 200);
  assert.match(roList.text, /gsc_search_analytics/);
  assert.doesNotMatch(roList.text, /gsc_submit_sitemap/, "mcp:read must not register write tools");

  // 9. Refresh rotates both tokens; the old access token dies with the rotation.
  const rotated = await postForm("/oauth/token", { grant_type: "refresh_token", refresh_token: full.refresh_token, client_id: clientId });
  assert.equal(rotated.status, 200);
  const next = JSON.parse(rotated.text);
  assert.notEqual(next.access_token, full.access_token);
  assert.notEqual(next.refresh_token, full.refresh_token);
  assert.equal((await mcp(next.access_token)).status, 200);
  assert.equal((await mcp(full.access_token)).status, 401, "the rotated-away access token stops working");

  // 10. Replaying the spent refresh token kills the whole grant (RFC 9700).
  const replay = await postForm("/oauth/token", { grant_type: "refresh_token", refresh_token: full.refresh_token, client_id: clientId });
  assert.equal(replay.status, 400);
  assert.equal((await mcp(next.access_token)).status, 401, "replay revokes the grant");

  // 11. Revocation, and the operator's own token is unaffected by all of this.
  const revoked = await postForm("/oauth/revoke", { token: ro.access_token });
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(ro.access_token)).status, 401);
  assert.equal((await mcp(TOKEN)).status, 200, "the static operator token still works");
  assert.equal((await mcp("mcpa_" + randomBytes(32).toString("base64url"))).status, 401, "a forged token is refused");

  // 12. An oversized body is answered with 400 and does not take the server down.
  const huge = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x".repeat(40_000), redirect_uris: [REDIRECT] }) });
  assert.equal(huge.status, 400);
  assert.equal((await mcp(TOKEN)).status, 200, "the server survives an oversized body");

  // 13. The audit trail names what was approved.
  assert.match(log, /"oauth":"register"/);
  assert.match(log, /"oauth":"approved"/);
  assert.match(log, /"oauth":"refresh-replay"/);
  assert.ok(!log.includes(TOKEN), "the operator token never reaches the log");

  console.log("oauth http test passed");
} catch (err) {
  console.error("FAILED:", err.message);
  console.error("--- server log ---\n" + log.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function openApproval(clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "st-" + randomBytes(3).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "mcp:full",
  });
  const res = await fetch(`${base}/oauth/authorize?${q}`);
  const text = await res.text();
  assert.equal(res.status, 200);
  const approval = /name="approval" value="([^"]+)"/.exec(text)?.[1];
  assert.ok(approval, "approval page carries a signed request");
  assert.ok(!text.includes(TOKEN), "the page never echoes the operator token");
  return { approval, verifier, state: q.get("state") };
}

async function approve(clientId, extra) {
  const pending = await openApproval(clientId);
  const posted = await postForm("/oauth/authorize", { approval: pending.approval, token: TOKEN, ...extra });
  assert.equal(posted.status, 303);
  const cb = new URL(posted.location);
  assert.equal(cb.searchParams.get("state"), pending.state);
  const code = cb.searchParams.get("code");
  assert.ok(code?.startsWith("mcpc_"));
  return { code, verifier: pending.verifier };
}

async function exchange(clientId, { code, verifier }) {
  const r = await postForm("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  assert.equal(r.status, 200, r.text);
  return JSON.parse(r.text);
}

async function mcp(token) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function getJson(p) {
  const res = await fetch(base + p);
  assert.equal(res.status, 200, p);
  return res.json();
}

async function postJson(p, body) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function postForm(p, body) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForStart() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (/listening on http/.test(log)) return;
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}):\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}
