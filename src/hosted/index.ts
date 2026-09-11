/**
 * Hosted (multi-tenant) mode. Enabled when SEO_MCP_HOSTED_CLIENT_ID, SEO_MCP_HOSTED_CLIENT_SECRET,
 * SEO_MCP_HOSTED_SECRET and SEO_MCP_PUBLIC_URL are all set. Adds a small web UI (landing page, Google
 * sign-in, token dashboard, privacy/terms) next to /mcp, and lets /mcp accept per-user tokens
 * (`seo_…`) in addition to the operator's MCP_AUTH_TOKEN. Users get a read-only server limited to
 * the toolsets that only need their own Google grant.
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { envValue } from "../env.js";
import { userOAuth, type RequestAuth } from "../google.js";
import type { ServerOptions } from "../server.js";
import { HostedStore, deriveKey, signPayload, verifyPayload, type User } from "./store.js";
import { dashboardPage, landingPage, pickLang, privacyPage, termsPage, type Lang, type Shell } from "./pages.js";

export const HOSTED_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

/** What a signed-in user's server looks like: read-only, own-data toolsets, no tools that spend the operator's paid quotas. */
export const HOSTED_SERVER_OPTIONS: ServerOptions = {
  readOnly: true,
  toolsets: ["gsc", "ga4", "web", "geo", "analysis"],
  exclude: ["ai_citation_check", "reviews_snapshot", "brand_mentions"],
};

const REPO = "https://github.com/Akxan/google-seo-mcp";
const SESSION_COOKIE = "seo_session", STATE_COOKIE = "seo_oauth", FLASH_COOKIE = "seo_flash", LANG_COOKIE = "seo_lang";
const SESSION_DAYS = 30;

export interface Hosted {
  publicUrl: string;
  mcpUrl: string;
  store: HostedStore;
  clientId: string;
  /** Resolve a bearer token from /mcp to a per-request auth context; null if it is not a hosted token. */
  resolve(bearer: string): { auth: RequestAuth; user: User } | null;
  /** Handle web routes; returns false when the path is not one of ours. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>;
  describe(): string;
}

export function loadHosted(): Hosted | null {
  const clientId = envValue("SEO_MCP_HOSTED_CLIENT_ID"), clientSecret = envValue("SEO_MCP_HOSTED_CLIENT_SECRET");
  const secret = envValue("SEO_MCP_HOSTED_SECRET"), publicUrlRaw = envValue("SEO_MCP_PUBLIC_URL");
  if (!clientId && !clientSecret && !secret && !publicUrlRaw) return null;
  const missing = [["SEO_MCP_HOSTED_CLIENT_ID", clientId], ["SEO_MCP_HOSTED_CLIENT_SECRET", clientSecret], ["SEO_MCP_HOSTED_SECRET", secret], ["SEO_MCP_PUBLIC_URL", publicUrlRaw]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Hosted mode is partially configured; missing ${missing.join(", ")}`);
  const publicUrl = publicUrlRaw!.replace(/\/+$/, "");
  const mcpPath = envValue("MCP_PATH") ?? "/mcp";
  const key = deriveKey(secret!);
  const dataDir = envValue("SEO_MCP_DATA_DIR") ?? path.join(os.homedir(), ".config", "google-seo-mcp");
  const store = new HostedStore(path.join(dataDir, "hosted.db"), key);
  const secure = publicUrl.startsWith("https://");
  const contact = envValue("SEO_MCP_HOSTED_CONTACT") ?? `${REPO}/issues`;
  const verified = /^(1|true|yes)$/i.test(envValue("SEO_MCP_HOSTED_VERIFIED") ?? "");
  const host = new URL(publicUrl).host;
  const toolCount = countTools();
  const cookieBase = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  const oauth = () => new OAuth2Client({ clientId, clientSecret, redirectUri: `${publicUrl}/oauth/callback` });
  const csrfFor = (uid: string) => createHmac("sha256", key).update(`csrf:${uid}`).digest("base64url");

  function sessionUser(req: http.IncomingMessage): User | null {
    const s = verifyPayload<{ uid: string }>(cookies(req)[SESSION_COOKIE], key);
    return s?.uid ? store.getUser(s.uid) : null;
  }
  function setCookie(res: http.ServerResponse, name: string, value: string, maxAge: number) {
    const prev = res.getHeader("Set-Cookie");
    const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
    list.push(`${name}=${value}; Max-Age=${maxAge}; ${cookieBase}`);
    res.setHeader("Set-Cookie", list);
  }
  function html(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(body);
  }
  function redirect(res: http.ServerResponse, to: string) { res.writeHead(303, { Location: to, "Cache-Control": "no-store" }); res.end(); }
  function shell(req: http.IncomingMessage, url: URL, lang: Lang, title: string, user: User | null): Shell {
    return { lang, title, user: user ? { email: user.email, picture: user.picture } : null, repo: REPO, path: url.pathname };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, m = req.method ?? "GET";
    const c = cookies(req);
    const lang = pickLang(c[LANG_COOKIE], req.headers["accept-language"], url.searchParams.get("lang"));
    if (url.searchParams.get("lang")) setCookie(res, LANG_COOKIE, lang, 365 * 86400);
    const user = sessionUser(req);

    if (p === "/" && m === "GET") { html(res, 200, landingPage(shell(req, url, lang, "google-seo-mcp", user), { toolCount, verified })); return true; }
    if (p === "/privacy" && m === "GET") { html(res, 200, privacyPage(shell(req, url, lang, "Privacy · google-seo-mcp", user), { contact, host })); return true; }
    if (p === "/terms" && m === "GET") { html(res, 200, termsPage(shell(req, url, lang, "Terms · google-seo-mcp", user), { host })); return true; }
    if (p === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /terms\nDisallow: /\n"); return true; }

    if (p === "/login" && m === "GET") {
      const state = randomBytes(16).toString("base64url");
      setCookie(res, STATE_COOKIE, signPayload({ state, exp: Date.now() + 10 * 60_000 }, key), 600);
      const authUrl = oauth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: HOSTED_SCOPES, state, include_granted_scopes: true });
      redirect(res, authUrl);
      return true;
    }
    if (p === "/oauth/callback" && m === "GET") {
      const expected = verifyPayload<{ state: string }>(c[STATE_COOKIE], key);
      setCookie(res, STATE_COOKIE, "", 0);
      const err = url.searchParams.get("error"), code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (err || !code || !state || !expected || expected.state !== state) { html(res, 400, landingPage(shell(req, url, lang, "google-seo-mcp", null), { toolCount, verified }).replace("<section class=\"hero\">", `<p class="notice warn">Sign-in was cancelled or the session expired (${esc(err ?? "state mismatch")}). Please try again.</p><section class="hero">`)); return true; }
      try {
        const client = oauth();
        const { tokens } = await client.getToken(code);
        if (!tokens.id_token) throw new Error("no id_token in token response");
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) throw new Error("id_token lacks sub/email");
        const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
        const u = store.upsertUser({ googleSub: payload.sub, email: payload.email, name: payload.name ?? null, picture: payload.picture ?? null, refreshToken: tokens.refresh_token ?? null, scopes: granted.length ? granted : HOSTED_SCOPES });
        setCookie(res, SESSION_COOKIE, signPayload({ uid: u.id, exp: Date.now() + SESSION_DAYS * 86400_000 }, key), SESSION_DAYS * 86400);
        console.error(JSON.stringify({ hosted: "signin", at: new Date().toISOString(), user: u.id, newUser: u.createdAt === u.lastSeenAt }));
        redirect(res, "/dashboard");
      } catch (e) {
        console.error("oauth callback failed:", e);
        html(res, 500, landingPage(shell(req, url, lang, "google-seo-mcp", null), { toolCount, verified }).replace("<section class=\"hero\">", `<p class="notice warn">Google sign-in failed: ${esc((e as Error).message)}</p><section class="hero">`));
      }
      return true;
    }

    // Everything below needs a session.
    if (p === "/dashboard" || p === "/tokens" || p === "/tokens/revoke" || p === "/disconnect" || p === "/logout") {
      if (!user) { redirect(res, "/login"); return true; }
      if (m === "POST") {
        const form = await readForm(req);
        if (form.get("csrf") !== csrfFor(user.id) && p !== "/logout") { html(res, 403, "<p>Invalid form token. Reload the page and try again.</p>"); return true; }
        if (p === "/logout") { setCookie(res, SESSION_COOKIE, "", 0); redirect(res, "/"); return true; }
        if (p === "/tokens") {
          if (store.listTokens(user.id).filter((t) => !t.revokedAt).length >= 10) { html(res, 400, "<p>Token limit reached (10). Revoke one first.</p>"); return true; }
          const { token } = store.createToken(user.id, (form.get("label") ?? "").trim().slice(0, 40) || null);
          setCookie(res, FLASH_COOKIE, signPayload({ token, exp: Date.now() + 120_000 }, key), 120);
          redirect(res, "/dashboard");
          return true;
        }
        if (p === "/tokens/revoke") { store.revokeToken(user.id, form.get("hash") ?? ""); redirect(res, "/dashboard"); return true; }
        if (p === "/disconnect") {
          const rt = store.refreshTokenOf(user.id);
          if (rt) { try { await oauth().revokeToken(rt); } catch (e) { console.error("google revoke failed (continuing):", (e as Error).message); } }
          store.deleteUser(user.id);
          setCookie(res, SESSION_COOKIE, "", 0);
          console.error(JSON.stringify({ hosted: "disconnect", at: new Date().toISOString(), user: user.id }));
          redirect(res, "/");
          return true;
        }
      }
      if (p === "/dashboard" && m === "GET") {
        const flash = verifyPayload<{ token: string }>(c[FLASH_COOKIE], key);
        if (c[FLASH_COOKIE]) setCookie(res, FLASH_COOKIE, "", 0);
        html(res, 200, dashboardPage(shell(req, url, lang, "Dashboard · google-seo-mcp", user), {
          user: { email: user.email, name: user.name, picture: user.picture, createdAt: user.createdAt, scopes: user.scopes },
          tokens: store.listTokens(user.id).filter((t) => !t.revokedAt),
          newToken: flash?.token ?? null,
          endpoint: `${publicUrl}${mcpPath}`,
          csrf: csrfFor(user.id),
        }));
        return true;
      }
      res.writeHead(405); res.end(); return true;
    }
    return false;
  }

  return {
    publicUrl,
    mcpUrl: `${publicUrl}${mcpPath}`,
    store,
    clientId: clientId!,
    resolve(bearer) {
      const hit = store.resolveToken(bearer);
      if (!hit) return null;
      const rt = store.refreshTokenOf(hit.user.id);
      if (!rt) return null;
      return { user: hit.user, auth: { auth: userOAuth(clientId!, clientSecret!, rt), label: `Google account ${hit.user.email} (hosted, read-only)`, scopes: hit.user.scopes.filter((x) => x.includes("googleapis")) } };
    },
    handle,
    describe: () => `hosted mode at ${publicUrl} (${store.countUsers()} users, data in ${dataDir})`,
  };
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("form too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function countTools(): number {
  try {
    const snap = new URL("../../test/tools.snap.json", import.meta.url);
    return (JSON.parse(fs.readFileSync(snap, "utf8")) as string[]).length;
  } catch { return 80; }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
