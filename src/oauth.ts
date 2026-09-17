/**
 * OAuth 2.1 authorization server in front of /mcp. Opt-in with SEO_MCP_OAUTH=1.
 *
 * Why it exists: some clients cannot send a static bearer token at all. ChatGPT's plugin page, for
 * one, offers OAuth, "no authentication" or a mix of the two, so MCP_AUTH_TOKEN has nowhere to go.
 * This module speaks what such clients do speak: protected-resource metadata (RFC 9728),
 * authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591), authorization
 * code with PKCE S256, refresh with rotation and revocation (RFC 7009).
 *
 * The trust model does not change: the browser approval page asks for MCP_AUTH_TOKEN, so an issued
 * token is worth exactly what that token is worth (scope `mcp:full`) or a read-only slice of it
 * (`mcp:read`). No extra secret, no user accounts — one flag and the existing token.
 *
 * Pure helpers are exported for unit tests; OAuthStore takes a database path (":memory:" in tests).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { envValue } from "./env.js";
import { deriveKey, hashToken, signPayload, verifyPayload } from "./hosted/store.js";
import { esc } from "./hosted/pages.js";

export const ACCESS_PREFIX = "mcpa_", REFRESH_PREFIX = "mcpr_", CODE_PREFIX = "mcpc_";
export const SCOPE_FULL = "mcp:full", SCOPE_READ = "mcp:read";
const ACCESS_TTL_S = 24 * 3600;          // one day; clients refresh silently
const REFRESH_TTL_S = 90 * 86_400;       // slides forward on every refresh
const CODE_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;     // how long a rendered approval page stays valid
const MAX_FAILS = 10, FAIL_WINDOW_MS = 15 * 60_000;
const MAX_REDIRECT_URIS = 8, MAX_CLIENTS = 500;
const REPO = "https://github.com/Akxan/google-seo-mcp";

// ---------- pure helpers ----------

const nowS = () => Math.floor(Date.now() / 1000);

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** PKCE check. Only S256: `plain` is not accepted, as MCP requires the hashed form. */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256" || !verifier || !challenge) return false;
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** https anywhere, http only on loopback (RFC 8252), private-use schemes for desktop clients. No fragments, no wildcards. */
export function validRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (/^(javascript|data|file|blob|about|vbscript|ws|wss|ftp):$/.test(u.protocol)) return false;
  return /^[a-z][a-z0-9+.\-]*:$/.test(u.protocol);   // cursor://…, vscode://…, com.example.app:/cb
}

/** Requested scope string → what we will actually grant. Unknown values are ignored rather than rejected. */
export function pickScope(requested: string | null | undefined): string {
  const asked = (requested ?? "").split(/[\s+]+/).filter(Boolean);
  if (asked.includes(SCOPE_FULL)) return SCOPE_FULL;
  return asked.includes(SCOPE_READ) ? SCOPE_READ : SCOPE_FULL;
}

/** RFC 9728 document for the MCP endpoint: which authorization server guards it. */
export function protectedResourceMetadata(base: string, mcpPath: string) {
  return {
    resource: `${base}${mcpPath}`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE_FULL, SCOPE_READ],
    resource_name: "google-seo-mcp",
    resource_documentation: REPO,
  };
}

/** RFC 8414 document: the endpoints a client needs, plus the constraints we enforce. */
export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [SCOPE_FULL, SCOPE_READ],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: REPO,
  };
}

/** Public origin of this instance: SEO_MCP_PUBLIC_URL when set, otherwise what the proxy says. */
export function derivedBase(headers: http.IncomingHttpHeaders): string {
  const first = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v ?? "").split(",")[0].trim();
  const proto = first(headers["x-forwarded-proto"]) || "http";
  const host = first(headers["x-forwarded-host"]) || first(headers.host) || "localhost";
  return `${proto}://${host}`;
}

// ---------- store ----------

export interface OAuthClient { clientId: string; name: string | null; redirectUris: string[]; createdAt: string; lastUsedAt: string | null }
export interface Grant { id: string; clientId: string; scope: string; accessExp: number; refreshExp: number; createdAt: string; calls: number }
export interface Issued { access: string; refresh: string; expiresIn: number; scope: string; grantId: string }

export class OAuthStore {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS oauth_grants (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        access_hash TEXT NOT NULL, access_exp INTEGER NOT NULL,
        refresh_hash TEXT NOT NULL, refresh_exp INTEGER NOT NULL, prev_refresh_hash TEXT,
        created_at TEXT NOT NULL, last_used_at TEXT, calls INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS oauth_access ON oauth_grants(access_hash);
      CREATE INDEX IF NOT EXISTS oauth_refresh ON oauth_grants(refresh_hash);
    `);
  }

  close() { this.db.close(); }

  registerClient(name: string | null, redirectUris: string[]): OAuthClient {
    const now = new Date().toISOString(), clientId = randomBytes(16).toString("hex");
    this.db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?,?,?,?)").run(clientId, name, JSON.stringify(redirectUris), now);
    return { clientId, name, redirectUris, createdAt: now, lastUsedAt: null };
  }

  getClient(clientId: string): OAuthClient | null {
    const r = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as Record<string, string | null> | undefined;
    if (!r) return null;
    let uris: string[] = [];
    try { uris = JSON.parse(r.redirect_uris ?? "[]") as string[]; } catch { uris = []; }
    return { clientId: r.client_id!, name: r.name, redirectUris: uris, createdAt: r.created_at!, lastUsedAt: r.last_used_at };
  }

  countClients(): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n; }

  countGrants(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE revoked_at IS NULL AND refresh_exp > ?").get(nowS()) as { n: number }).n;
  }

  /** Registration is open by design, so drop day-old registrations that never completed a flow. */
  pruneClients(): number {
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const r = this.db.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_grants)").run(cutoff);
    return Number(r.changes);
  }

  issue(clientId: string, scope: string): Issued {
    const access = newSecret(ACCESS_PREFIX), refresh = newSecret(REFRESH_PREFIX);
    const id = randomBytes(8).toString("hex"), now = new Date().toISOString();
    this.db.prepare("INSERT INTO oauth_grants (id, client_id, scope, access_hash, access_exp, refresh_hash, refresh_exp, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, clientId, scope, hashToken(access), nowS() + ACCESS_TTL_S, hashToken(refresh), nowS() + REFRESH_TTL_S, now);
    this.db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").run(now, clientId);
    return { access, refresh, expiresIn: ACCESS_TTL_S, scope, grantId: id };
  }

  /** Resolve a presented access token; null when unknown, expired or revoked. Bumps usage counters. */
  resolveAccess(token: string): Grant | null {
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    const hash = hashToken(token);
    const r = this.db.prepare("SELECT * FROM oauth_grants WHERE access_hash = ? AND revoked_at IS NULL").get(hash) as Record<string, string | number | null> | undefined;
    if (!r || Number(r.access_exp) < nowS()) return null;
    this.db.prepare("UPDATE oauth_grants SET last_used_at = ?, calls = calls + 1 WHERE id = ?").run(new Date().toISOString(), String(r.id));
    return { id: String(r.id), clientId: String(r.client_id), scope: String(r.scope), accessExp: Number(r.access_exp), refreshExp: Number(r.refresh_exp), createdAt: String(r.created_at), calls: Number(r.calls ?? 0) };
  }

  /** Exchange a refresh token for a fresh pair. Presenting one we already rotated away is a replay: the grant dies (RFC 9700). */
  rotate(refresh: string, clientId: string | null): Issued | null {
    if (!refresh.startsWith(REFRESH_PREFIX)) return null;
    const hash = hashToken(refresh);
    const r = this.db.prepare("SELECT * FROM oauth_grants WHERE refresh_hash = ? AND revoked_at IS NULL").get(hash) as Record<string, string | number | null> | undefined;
    if (!r) {
      const replay = this.db.prepare("SELECT id FROM oauth_grants WHERE prev_refresh_hash = ? AND revoked_at IS NULL").get(hash) as { id: string } | undefined;
      if (replay) {
        this.db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), replay.id);
        console.error(JSON.stringify({ oauth: "refresh-replay", at: new Date().toISOString(), grant: replay.id }));
      }
      return null;
    }
    if (Number(r.refresh_exp) < nowS()) return null;
    if (clientId && String(r.client_id) !== clientId) return null;
    const access = newSecret(ACCESS_PREFIX), next = newSecret(REFRESH_PREFIX);
    this.db.prepare("UPDATE oauth_grants SET access_hash=?, access_exp=?, prev_refresh_hash=refresh_hash, refresh_hash=?, refresh_exp=?, last_used_at=? WHERE id=?")
      .run(hashToken(access), nowS() + ACCESS_TTL_S, hashToken(next), nowS() + REFRESH_TTL_S, new Date().toISOString(), String(r.id));
    return { access, refresh: next, expiresIn: ACCESS_TTL_S, scope: String(r.scope), grantId: String(r.id) };
  }

  /** Revoke by any of the grant's tokens (access, current or previous refresh). */
  revoke(token: string): boolean {
    const hash = hashToken(token);
    const r = this.db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ? OR prev_refresh_hash = ?) AND revoked_at IS NULL")
      .run(new Date().toISOString(), hash, hash, hash);
    return Number(r.changes) > 0;
  }
}

// ---------- server ----------

export interface OAuthGrantContext { label: string; readOnly: boolean; scope: string; clientId: string }

export interface OAuthServer {
  store: OAuthStore;
  /** Handle the metadata, registration, authorize, token and revoke routes; false when the path is not ours. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>;
  /** Resolve a bearer token from /mcp; null when it is not one of ours. */
  resolve(bearer: string): OAuthGrantContext | null;
  /** URL to advertise in WWW-Authenticate so an unauthenticated client can discover the flow. */
  metadataUrl(req: http.IncomingMessage): string;
  describe(): string;
}

interface Pending { clientId: string; redirectUri: string; challenge: string; scope: string; exp: number }

export function loadOAuth(): OAuthServer | null {
  if (!/^(1|true|yes)$/i.test(envValue("SEO_MCP_OAUTH") ?? "")) return null;
  const operatorToken = envValue("MCP_AUTH_TOKEN");
  if (!operatorToken) throw new Error("SEO_MCP_OAUTH=1 requires MCP_AUTH_TOKEN: the approval page asks for that token before it issues an OAuth token.");
  const mcpPath = envValue("MCP_PATH") ?? "/mcp";
  const fixedBase = envValue("SEO_MCP_PUBLIC_URL")?.replace(/\/+$/, "");
  const dataDir = envValue("SEO_MCP_DATA_DIR") ?? path.join(os.homedir(), ".config", "google-seo-mcp");
  const store = new OAuthStore(path.join(dataDir, "oauth.db"));
  // Approval requests are signed so a POST can only carry parameters from a page we rendered.
  const key = deriveKey(`${envValue("SEO_MCP_HOSTED_SECRET") ?? operatorToken}|oauth-approval`);
  const codes = new Map<string, Pending>();
  const fails = new Map<string, { n: number; until: number }>();

  const prPaths = new Set(["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${mcpPath}`]);
  const asPaths = new Set(["/.well-known/oauth-authorization-server", `/.well-known/oauth-authorization-server${mcpPath}`]);
  const ourPaths = new Set([...prPaths, ...asPaths, "/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"]);
  const baseOf = (req: http.IncomingMessage) => fixedBase ?? derivedBase(req.headers);

  function cors(res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  function jsonOut(res: http.ServerResponse, status: number, body: unknown) {
    cors(res);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  function htmlOut(res: http.ServerResponse, status: number, body: string, formAction = "'self'") {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }
  function bounce(res: http.ServerResponse, redirectUri: string, params: Record<string, string>) {
    const to = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) to.searchParams.set(k, v);
    res.writeHead(303, { Location: to.toString(), "Cache-Control": "no-store" });
    res.end();
  }
  function ipOf(req: http.IncomingMessage): string {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    return xff || req.socket.remoteAddress || "?";
  }
  function throttled(ip: string): boolean {
    const hit = fails.get(ip);
    return !!hit && hit.n >= MAX_FAILS && hit.until > Date.now();
  }
  function countFail(ip: string) {
    const hit = fails.get(ip);
    if (!hit || hit.until < Date.now()) fails.set(ip, { n: 1, until: Date.now() + FAIL_WINDOW_MS });
    else fails.set(ip, { n: hit.n + 1, until: Date.now() + FAIL_WINDOW_MS });
    if (fails.size > 1000) for (const [k, v] of fails) if (v.until < Date.now()) fails.delete(k);
  }
  function sweepCodes() {
    const now = Date.now();
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
  }
  function sameToken(given: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(operatorToken!);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, m = req.method ?? "GET";
    if (!ourPaths.has(p)) return false;
    if (m === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return true; }
    const base = baseOf(req);

    if (prPaths.has(p)) { jsonOut(res, m === "GET" ? 200 : 405, m === "GET" ? protectedResourceMetadata(base, mcpPath) : { error: "method not allowed" }); return true; }
    if (asPaths.has(p)) { jsonOut(res, m === "GET" ? 200 : 405, m === "GET" ? authServerMetadata(base) : { error: "method not allowed" }); return true; }

    // Dynamic client registration: open, as MCP clients cannot be pre-registered. It hands out an
    // identifier only; nothing can be obtained with it until a human approves with the operator token.
    if (p === "/oauth/register") {
      if (m !== "POST") { jsonOut(res, 405, { error: "invalid_request", error_description: "POST a client registration document" }); return true; }
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { jsonOut(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON of at most 16 KB" }); return true; }
      const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).map(String) : [];
      if (!uris.length || uris.length > MAX_REDIRECT_URIS) { jsonOut(res, 400, { error: "invalid_redirect_uri", error_description: `redirect_uris must hold 1 to ${MAX_REDIRECT_URIS} entries` }); return true; }
      const bad = uris.filter((u) => !validRedirectUri(u));
      if (bad.length) { jsonOut(res, 400, { error: "invalid_redirect_uri", error_description: `not accepted: ${bad.join(", ")} (https, http on loopback, or a private-use scheme)` }); return true; }
      store.pruneClients();
      // Registration needs no credentials by design, so keep it from filling the disk.
      if (store.countClients() >= MAX_CLIENTS) { jsonOut(res, 503, { error: "temporarily_unavailable", error_description: "too many client registrations on this server; try again later" }); return true; }
      const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : null;
      const c = store.registerClient(name, uris);
      console.error(JSON.stringify({ oauth: "register", at: new Date().toISOString(), client: c.clientId, name: c.name, redirectUris: uris }));
      jsonOut(res, 201, {
        client_id: c.clientId,
        client_id_issued_at: Math.floor(new Date(c.createdAt).getTime() / 1000),
        client_name: c.name ?? undefined,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: `${SCOPE_FULL} ${SCOPE_READ}`,
      });
      return true;
    }

    if (p === "/oauth/authorize") {
      sweepCodes();
      if (m === "GET") {
        const q = url.searchParams;
        const client = store.getClient(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        // An unverifiable client or redirect target must not be redirected to; show the error here instead.
        if (!client) { htmlOut(res, 400, errorPage("Unknown client", "This client_id is not registered on this server. Remove the connector and add it again so it can register.")); return true; }
        if (!redirectUri || !client.redirectUris.includes(redirectUri)) { htmlOut(res, 400, errorPage("Redirect URI mismatch", `The client asked to come back to ${esc(redirectUri) || "nothing"}, which it did not register.`)); return true; }
        const state = q.get("state") ?? "";
        if (q.get("response_type") !== "code") { bounce(res, redirectUri, { error: "unsupported_response_type", state }); return true; }
        const challenge = q.get("code_challenge") ?? "";
        if (!challenge || (q.get("code_challenge_method") ?? "") !== "S256") { bounce(res, redirectUri, { error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required", state }); return true; }
        const scope = pickScope(q.get("scope"));
        const approval = signPayload({ c: client.clientId, r: redirectUri, s: state, ch: challenge, sc: scope, exp: Date.now() + APPROVAL_TTL_MS }, key);
        htmlOut(res, 200, approvalPage({ base, client, redirectUri, scope, approval, error: null }), formActionFor(redirectUri));
        return true;
      }
      if (m === "POST") {
        const raw = await readBody(req).catch(() => null);
        if (raw === null) { htmlOut(res, 400, errorPage("Request too large", "The approval form is limited to 16 KB.")); return true; }
        const form = new URLSearchParams(raw);
        const blob = verifyPayload<{ c: string; r: string; s: string; ch: string; sc: string }>(form.get("approval") ?? undefined, key);
        if (!blob) { htmlOut(res, 400, errorPage("This page expired", "Approval pages are valid for ten minutes. Start the connection again from your client.")); return true; }
        const client = store.getClient(blob.c);
        if (!client || !client.redirectUris.includes(blob.r)) { htmlOut(res, 400, errorPage("Unknown client", "The client was removed while this page was open. Add the connector again.")); return true; }
        const ip = ipOf(req);
        if (throttled(ip)) { htmlOut(res, 429, errorPage("Too many attempts", "Ten wrong tokens from this address. Wait fifteen minutes and try again.")); return true; }
        const given = (form.get("token") ?? "").trim();
        if (!given || !sameToken(given)) {
          countFail(ip);
          console.error(JSON.stringify({ oauth: "approval-denied", at: new Date().toISOString(), client: blob.c, ip }));
          htmlOut(res, 401, approvalPage({ base, client, redirectUri: blob.r, scope: blob.sc, approval: form.get("approval") ?? "", error: "That is not the operator token for this server." }), formActionFor(blob.r));
          return true;
        }
        const scope = form.get("readonly") ? SCOPE_READ : blob.sc;
        const code = newSecret(CODE_PREFIX);
        codes.set(hashToken(code), { clientId: blob.c, redirectUri: blob.r, challenge: blob.ch, scope, exp: Date.now() + CODE_TTL_MS });
        console.error(JSON.stringify({ oauth: "approved", at: new Date().toISOString(), client: blob.c, name: client.name, scope }));
        bounce(res, blob.r, { code, state: blob.s });
        return true;
      }
      jsonOut(res, 405, { error: "invalid_request" });
      return true;
    }

    if (p === "/oauth/token") {
      if (m !== "POST") { jsonOut(res, 405, { error: "invalid_request" }); return true; }
      sweepCodes();
      const form = await readFormOrJson(req).catch(() => null);
      if (!form) { jsonOut(res, 400, { error: "invalid_request", error_description: "body must be at most 16 KB" }); return true; }
      const grantType = form.get("grant_type") ?? "";
      const clientId = form.get("client_id");
      if (grantType === "authorization_code") {
        const hash = hashToken(form.get("code") ?? "");
        const pending = codes.get(hash);
        codes.delete(hash);   // single use, whatever happens next
        if (!pending || pending.exp < Date.now()) { jsonOut(res, 400, { error: "invalid_grant", error_description: "unknown or expired code" }); return true; }
        if (clientId && clientId !== pending.clientId) { jsonOut(res, 400, { error: "invalid_grant", error_description: "code was issued to another client" }); return true; }
        const redirectUri = form.get("redirect_uri");
        if (redirectUri && redirectUri !== pending.redirectUri) { jsonOut(res, 400, { error: "invalid_grant", error_description: "redirect_uri does not match the authorization request" }); return true; }
        if (!verifyPkce(form.get("code_verifier") ?? "", pending.challenge, "S256")) { jsonOut(res, 400, { error: "invalid_grant", error_description: "code_verifier does not match code_challenge" }); return true; }
        const issued = store.issue(pending.clientId, pending.scope);
        console.error(JSON.stringify({ oauth: "issued", at: new Date().toISOString(), client: pending.clientId, grant: issued.grantId, scope: issued.scope }));
        jsonOut(res, 200, { access_token: issued.access, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: issued.scope });
        return true;
      }
      if (grantType === "refresh_token") {
        const issued = store.rotate(form.get("refresh_token") ?? "", clientId);
        if (!issued) { jsonOut(res, 400, { error: "invalid_grant", error_description: "unknown, expired or already-rotated refresh token" }); return true; }
        jsonOut(res, 200, { access_token: issued.access, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: issued.scope });
        return true;
      }
      jsonOut(res, 400, { error: "unsupported_grant_type", error_description: "authorization_code and refresh_token only" });
      return true;
    }

    if (p === "/oauth/revoke") {
      if (m !== "POST") { jsonOut(res, 405, { error: "invalid_request" }); return true; }
      const form = await readFormOrJson(req).catch(() => null);
      const hit = form ? store.revoke(form.get("token") ?? "") : false;
      if (hit) console.error(JSON.stringify({ oauth: "revoked", at: new Date().toISOString() }));
      jsonOut(res, 200, {});   // RFC 7009: unknown tokens also return 200
      return true;
    }

    return false;
  }

  return {
    store,
    handle,
    resolve(bearer) {
      if (!bearer.startsWith(ACCESS_PREFIX)) return null;
      const g = store.resolveAccess(bearer);
      if (!g) return null;
      return { label: `oauth client ${g.clientId}`, readOnly: g.scope === SCOPE_READ, scope: g.scope, clientId: g.clientId };
    },
    metadataUrl: (req) => `${baseOf(req)}/.well-known/oauth-protected-resource`,
    describe: () => `OAuth on (${store.countClients()} clients, ${store.countGrants()} grants, data in ${dataDir})`,
  };
}

async function readBody(req: http.IncomingMessage, limit = 16_384): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Token endpoints are form-encoded per spec, but some clients send JSON; accept both. */
async function readFormOrJson(req: http.IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  if ((req.headers["content-type"] ?? "").includes("json")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out.set(k, String(v));
      return out;
    } catch { /* fall through to form parsing */ }
  }
  return new URLSearchParams(raw);
}

/** CSP form-action must also cover the redirect that follows the POST, or Chrome blocks it. */
function formActionFor(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.origin && u.origin !== "null" ? `'self' ${u.origin}` : `'self' ${u.protocol}`;
  } catch { return "'self'"; }
}

const PAGE_CSS = `
:root{--bg:#fbfbf9;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e4df;--card:#fff;--accent:#1f5fbf;--accent-fg:#fff;--warn:#9a5b00;--code:#f3f3ee}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--line:#2c2c29;--card:#1c1c1a;--accent:#6ea2ff;--accent-fg:#0b1a33;--warn:#e0a84c;--code:#232321}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Noto Sans SC",sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:48px 20px 64px}
h1{font-size:26px;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:24px}
dl{margin:0 0 20px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14.5px}
dt{color:var(--muted)}dd{margin:0;word-break:break-all}
label{display:block;font-size:14.5px;color:var(--muted);margin-bottom:6px}
input[type=password]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.row{display:flex;align-items:flex-start;gap:9px;margin:18px 0 22px;font-size:14.5px;color:var(--fg)}
.btn{background:var(--accent);color:var(--accent-fg);padding:11px 20px;border-radius:8px;font-weight:600;border:0;cursor:pointer;font-size:15px}
.muted{color:var(--muted);font-size:14px}.warn{color:var(--warn)}
.err{border-left:4px solid #b3261e;padding:10px 14px;background:var(--code);border-radius:6px;margin:0 0 18px;font-size:14.5px}
code{font:13.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:2px 5px;border-radius:4px}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function errorPage(title: string, detail: string): string {
  return page(`${title} · google-seo-mcp`, `<h1>${esc(title)}</h1><p class="muted">${detail}</p><p class="muted">Server: google-seo-mcp · <a href="${REPO}">documentation</a></p>`);
}

function approvalPage(o: { base: string; client: OAuthClient; redirectUri: string; scope: string; approval: string; error: string | null }): string {
  const host = (() => { try { return new URL(o.redirectUri).host || new URL(o.redirectUri).protocol; } catch { return o.redirectUri; } })();
  return page("Authorize client · google-seo-mcp", `
    <h1>Connect this client?</h1>
    <p class="muted">A client asks for access to the MCP server at <code>${esc(new URL(o.base).host)}</code>. Paste the operator token to approve it.</p>
    <div class="card">
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
      <dl>
        <dt>Client</dt><dd>${esc(o.client.name ?? "(unnamed)")}</dd>
        <dt>Sends you back to</dt><dd>${esc(host)}</dd>
        <dt>Access</dt><dd>${o.scope === SCOPE_READ ? "read-only tools" : "every tool this instance offers, including writes"}</dd>
      </dl>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="approval" value="${esc(o.approval)}">
        <label for="token">Operator token (<code>MCP_AUTH_TOKEN</code>)</label>
        <input id="token" name="token" type="password" autocomplete="off" autofocus spellcheck="false" required>
        <div class="row"><input type="checkbox" id="readonly" name="readonly" value="1"${o.scope === SCOPE_READ ? " checked" : ""}><label for="readonly" style="margin:0;color:inherit">Read-only: register no write tools for this client (recommended for third-party assistants)</label></div>
        <button class="btn" type="submit">Approve</button>
      </form>
    </div>
    <p class="muted warn" style="margin-top:20px">Only approve a page you opened yourself from your own client. An approved client can act with your Google, WordPress and GitHub access until you revoke it.</p>
  `);
}
