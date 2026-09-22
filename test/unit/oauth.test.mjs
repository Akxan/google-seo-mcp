import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  ACCESS_PREFIX, REFRESH_PREFIX, SCOPE_FULL, SCOPE_READ, OAuthStore,
  authServerMetadata, derivedBase, newSecret, pickScope, protectedResourceMetadata, validRedirectUri, verifyPkce,
} from "../../dist/oauth.js";

const challengeFor = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const verifier = randomBytes(32).toString("base64url");

test("PKCE: S256 only, and the verifier must actually match", () => {
  assert.equal(verifyPkce(verifier, challengeFor(verifier), "S256"), true);
  assert.equal(verifyPkce(verifier, challengeFor(verifier + "x"), "S256"), false);
  assert.equal(verifyPkce(verifier, verifier, "plain"), false, "plain is not accepted");
  assert.equal(verifyPkce("short", challengeFor("short"), "S256"), false, "verifier under 43 chars");
  assert.equal(verifyPkce("a".repeat(200), challengeFor("a".repeat(200)), "S256"), false, "verifier over 128 chars");
  assert.equal(verifyPkce("a".repeat(50) + "$", challengeFor("a".repeat(50) + "$"), "S256"), false, "illegal characters");
  assert.equal(verifyPkce("", "", "S256"), false);
});

test("redirect URIs: https, loopback http and private-use schemes only", () => {
  for (const ok of ["https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:3000/cb", "http://127.0.0.1:1455/oauth/callback", "cursor://anysphere.cursor/mcp", "com.example.app:/done"]) {
    assert.equal(validRedirectUri(ok), true, ok);
  }
  for (const bad of ["http://example.com/cb", "https://example.com/cb#frag", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com", "not a url", "", "https://" + "x".repeat(3000)]) {
    assert.equal(validRedirectUri(bad), false, bad);
  }
});

test("scope: unknown values are ignored, read stays read, default is full", () => {
  assert.equal(pickScope(null), SCOPE_FULL);
  assert.equal(pickScope(""), SCOPE_FULL);
  assert.equal(pickScope("mcp:read"), SCOPE_READ);
  assert.equal(pickScope("openid profile"), SCOPE_FULL);
  assert.equal(pickScope("mcp:read mcp:full"), SCOPE_FULL);
});

test("metadata documents describe the endpoints a client needs", () => {
  const pr = protectedResourceMetadata("https://mcp.example.com", "/mcp");
  assert.equal(pr.resource, "https://mcp.example.com/mcp");
  assert.deepEqual(pr.authorization_servers, ["https://mcp.example.com"]);
  const as = authServerMetadata("https://mcp.example.com");
  assert.equal(as.issuer, "https://mcp.example.com");
  assert.equal(as.authorization_endpoint, "https://mcp.example.com/oauth/authorize");
  assert.equal(as.token_endpoint, "https://mcp.example.com/oauth/token");
  assert.equal(as.registration_endpoint, "https://mcp.example.com/oauth/register");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"], "never advertise plain");
  assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(as.scopes_supported, [SCOPE_FULL, SCOPE_READ]);
});

test("public origin comes from the proxy headers", () => {
  assert.equal(derivedBase({ host: "mcp.example.com", "x-forwarded-proto": "https" }), "https://mcp.example.com");
  assert.equal(derivedBase({ host: "127.0.0.1:8080" }), "http://127.0.0.1:8080");
  assert.equal(derivedBase({ host: "a.example", "x-forwarded-host": "b.example", "x-forwarded-proto": "https, http" }), "https://b.example");
  assert.equal(derivedBase({}), "http://localhost");
});

test("tokens are prefixed and random", () => {
  const a = newSecret(ACCESS_PREFIX), b = newSecret(ACCESS_PREFIX);
  assert.ok(a.startsWith(ACCESS_PREFIX) && a.length > 40);
  assert.notEqual(a, b);
  assert.ok(newSecret(REFRESH_PREFIX).startsWith(REFRESH_PREFIX));
});

test("store: register, issue, resolve, revoke", () => {
  const s = new OAuthStore(":memory:");
  const c = s.registerClient("ChatGPT", ["https://chatgpt.com/cb"]);
  assert.equal(s.countClients(), 1);
  assert.deepEqual(s.getClient(c.clientId).redirectUris, ["https://chatgpt.com/cb"]);
  assert.equal(s.getClient("nope"), null);

  const issued = s.issue(c.clientId, SCOPE_FULL);
  assert.ok(issued.access.startsWith(ACCESS_PREFIX) && issued.refresh.startsWith(REFRESH_PREFIX));
  assert.equal(s.countGrants(), 1);
  const grant = s.resolveAccess(issued.access);
  assert.equal(grant.clientId, c.clientId);
  assert.equal(grant.scope, SCOPE_FULL);
  assert.equal(s.resolveAccess(newSecret(ACCESS_PREFIX)), null, "unknown token");
  assert.equal(s.resolveAccess(issued.refresh), null, "a refresh token is not an access token");
  assert.equal(s.resolveAccess("seo_something"), null, "another prefix");

  assert.equal(s.revoke(issued.access), true);
  assert.equal(s.resolveAccess(issued.access), null, "revoked");
  assert.equal(s.revoke(issued.access), false, "already revoked");
  assert.equal(s.countGrants(), 0);
  s.close();
});

test("store: refresh rotates, and replaying an old refresh token kills the grant", () => {
  const s = new OAuthStore(":memory:");
  const c = s.registerClient(null, ["https://example.com/cb"]);
  const first = s.issue(c.clientId, SCOPE_READ);

  const second = s.rotate(first.refresh, c.clientId);
  assert.ok(second && second.access !== first.access && second.refresh !== first.refresh);
  assert.equal(second.scope, SCOPE_READ, "scope survives the rotation");
  assert.equal(s.resolveAccess(first.access), null, "the old access token stops working");
  assert.ok(s.resolveAccess(second.access));
  assert.equal(s.rotate(second.refresh, "other-client"), null, "bound to its client");
  assert.equal(s.rotate(newSecret(REFRESH_PREFIX), null), null, "unknown refresh token");

  assert.equal(s.rotate(first.refresh, c.clientId), null, "replay is refused");
  assert.equal(s.resolveAccess(second.access), null, "and the whole grant is revoked");
  assert.equal(s.countGrants(), 0);
  s.close();
});

test("store: open registration is pruned, but clients with grants are kept", () => {
  const s = new OAuthStore(":memory:");
  const used = s.registerClient("used", ["https://example.com/cb"]);
  s.registerClient("fresh", ["https://example.com/cb"]);
  s.issue(used.clientId, SCOPE_FULL);
  assert.equal(s.pruneClients(), 0, "nothing is a day old yet");
  assert.equal(s.countClients(), 2);
  s.close();
});

test("store: grants can be listed and revoked by id, the way the oauth_* tools do it", () => {
  const s = new OAuthStore(":memory:");
  const c = s.registerClient("ChatGPT", ["https://chatgpt.com/cb"]);
  const a = s.issue(c.clientId, SCOPE_FULL), b = s.issue(c.clientId, SCOPE_READ);

  const live = s.listGrants();
  assert.equal(live.length, 2);
  assert.equal(live[0].client, "ChatGPT");
  assert.deepEqual(live.map((g) => g.scope).sort(), [SCOPE_FULL, SCOPE_READ]);
  assert.ok(live.every((g) => g.revokedAt === null && !g.accessExpired && !g.refreshExpired));
  assert.equal(live.find((g) => g.id === a.grantId).calls, 0);
  s.resolveAccess(a.access);
  assert.equal(s.listGrants().find((g) => g.id === a.grantId).calls, 1, "usage is counted");

  assert.equal(s.revokeGrant(a.grantId), true);
  assert.equal(s.revokeGrant(a.grantId), false, "already revoked");
  assert.equal(s.revokeGrant("no-such-id"), false);
  assert.equal(s.resolveAccess(a.access), null, "the revoked client is cut off");
  assert.ok(s.resolveAccess(b.access), "the other grant is untouched");
  assert.equal(s.listGrants().length, 1);
  assert.equal(s.listGrants(true).length, 2, "includeRevoked shows the history");
  s.close();
});
