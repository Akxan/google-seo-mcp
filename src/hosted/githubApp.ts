/**
 * GitHub App integration for hosted mode: users install the app on the repositories they choose,
 * the server mints short-lived installation tokens (1 h) from the app's private key when a tool
 * needs one. Enabled when SEO_MCP_GITHUB_APP_ID, SEO_MCP_GITHUB_APP_SLUG, SEO_MCP_GITHUB_APP_CLIENT_ID,
 * SEO_MCP_GITHUB_APP_CLIENT_SECRET and SEO_MCP_GITHUB_APP_PRIVATE_KEY_FILE are all set.
 */
import fs from "node:fs";
import { createSign } from "node:crypto";
import { envValue } from "../env.js";

const API = "https://api.github.com";

export interface GitHubAppConfig { appId: string; slug: string; clientId: string; clientSecret: string; privateKey: string }

export function loadGitHubApp(): GitHubAppConfig | null {
  const appId = envValue("SEO_MCP_GITHUB_APP_ID"), slug = envValue("SEO_MCP_GITHUB_APP_SLUG"), clientId = envValue("SEO_MCP_GITHUB_APP_CLIENT_ID"), clientSecret = envValue("SEO_MCP_GITHUB_APP_CLIENT_SECRET"), keyFile = envValue("SEO_MCP_GITHUB_APP_PRIVATE_KEY_FILE");
  if (!appId && !slug && !clientId && !clientSecret && !keyFile) return null;
  const missing = [["SEO_MCP_GITHUB_APP_ID", appId], ["SEO_MCP_GITHUB_APP_SLUG", slug], ["SEO_MCP_GITHUB_APP_CLIENT_ID", clientId], ["SEO_MCP_GITHUB_APP_CLIENT_SECRET", clientSecret], ["SEO_MCP_GITHUB_APP_PRIVATE_KEY_FILE", keyFile]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`GitHub App is partially configured; missing ${missing.join(", ")}`);
  if (!fs.existsSync(keyFile!)) throw new Error(`SEO_MCP_GITHUB_APP_PRIVATE_KEY_FILE points to a missing file: ${keyFile}`);
  return { appId: appId!, slug: slug!, clientId: clientId!, clientSecret: clientSecret!, privateKey: fs.readFileSync(keyFile!, "utf8") };
}

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** RS256 JWT that authenticates as the app itself (valid ≤ 10 min per GitHub). */
export function appJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64({ alg: "RS256", typ: "JWT" }), body = b64({ iat: now - 60, exp: now + 540, iss: appId });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "google-seo-mcp", ...(init.headers ?? {}) } });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(data as { message?: string })?.message ?? text.slice(0, 200)}`);
  return data as T;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

/** Installation access token, cached until shortly before it expires. */
export async function installationToken(app: GitHubAppConfig, installationId: string): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const d = await api<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(app.appId, app.privateKey), { method: "POST" });
  tokenCache.set(installationId, { token: d.token, exp: Date.parse(d.expires_at) });
  return d.token;
}

/** Exchange the `code` GitHub appends after "request user authorization during installation" for a user token. */
export async function exchangeUserCode(app: GitHubAppConfig, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "google-seo-mcp" }, body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }) });
  const d = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!d.access_token) throw new Error(`GitHub OAuth: ${d.error_description ?? d.error ?? "no access_token"}`);
  return d.access_token;
}

export interface Installation { id: number; account: { login: string; type: string }; repository_selection: string }

/** Installations the signed-in GitHub user can access; used to prove the installation_id in the callback is theirs. */
export async function userInstallations(userToken: string): Promise<{ login: string; installations: Installation[] }> {
  const me = await api<{ login: string }>("/user", userToken);
  const d = await api<{ installations: Installation[] }>("/user/installations?per_page=100", userToken);
  return { login: me.login, installations: d.installations };
}

export async function installationRepos(app: GitHubAppConfig, installationId: string): Promise<string[]> {
  const t = await installationToken(app, installationId);
  const d = await api<{ repositories: { full_name: string }[] }>("/installation/repositories?per_page=100", t);
  return d.repositories.map((r) => r.full_name);
}

/** Uninstall the app for this installation (revokes every token minted from it). */
export async function deleteInstallation(app: GitHubAppConfig, installationId: string): Promise<void> {
  await api(`/app/installations/${installationId}`, appJwt(app.appId, app.privateKey), { method: "DELETE" });
  tokenCache.delete(installationId);
}
