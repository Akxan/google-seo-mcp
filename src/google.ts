import fs from "node:fs";
import { envValue } from "./env.js";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

// Read-only queries that Google sends as POST: safe to retry. Writes (creating a key event, a custom
// dimension) are not on the list, so a timeout after the server already applied one is never replayed.
const READ_ONLY_POST = /searchAnalytics\/query|:runReport|:batchRunReports|:runPivotReport|:batchRunPivotReports|:runFunnelReport|:runRealtimeReport|:checkCompatibility|urlInspection\/index:inspect/i;
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);

/** Whether a failed Google API call should be retried: transient errors only, and POST only for read-only queries. Pure, for tests. */
export function shouldRetryGoogle(err: { code?: string; response?: { status?: number }; config?: { method?: string; url?: unknown; retryConfig?: { currentRetryAttempt?: number; retry?: number } } }): boolean {
  const cfg = err.config?.retryConfig;
  if (!cfg || (cfg.currentRetryAttempt ?? 0) >= (cfg.retry ?? 0)) return false;
  const status = err.response?.status;
  const transient = status ? status === 429 || status >= 500 : TRANSIENT_CODES.has(String(err.code));
  if (!transient) return false;
  const method = String(err.config?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" || (method === "POST" && READ_ONLY_POST.test(String(err.config?.url ?? "")));
}

// Every Google API call had no timeout (a stuck connection held a tool call until the client gave up)
// and a 429 or 503 from Search Console or GA4 failed the whole tool on the first try.
google.options({ timeout: 90_000, retryConfig: { retry: 2, retryDelay: 1000, shouldRetry: shouldRetryGoogle as never } });

export const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/analytics.edit",
];

export const DEFAULT_CREDENTIALS_PATH = path.join(
  os.homedir(),
  ".config",
  "google-seo-mcp",
  "credentials.json",
);

/**
 * Credential resolution order:
 * 1. GOOGLE_CREDENTIALS_JSON  - inline JSON (service account or authorized_user)
 * 2. GOOGLE_APPLICATION_CREDENTIALS - path to a JSON key file
 * 3. ~/.config/google-seo-mcp/credentials.json - written by `npm run auth`
 * 4. Application Default Credentials (gcloud auth application-default login)
 */
function resolveCredentialOptions(): { keyFile?: string; credentials?: object } {
  const inline = envValue("GOOGLE_CREDENTIALS_JSON");
  if (inline) {
    return { credentials: JSON.parse(inline) };
  }
  const envPath = envValue("GOOGLE_APPLICATION_CREDENTIALS");
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${envPath}`);
    }
    return { keyFile: envPath };
  }
  if (fs.existsSync(DEFAULT_CREDENTIALS_PATH)) {
    return { keyFile: DEFAULT_CREDENTIALS_PATH };
  }
  return {};
}

let cachedAuth: GoogleAuth | undefined;

/**
 * Per-request credentials for hosted (multi-tenant) mode. The HTTP layer wraps each request in
 * `runWithAuth()` and every Google call inside it transparently uses that user's OAuth grant
 * instead of the operator's own credentials. Outside such a scope `getAuth()` behaves as before.
 */
export interface RequestAuth {
  auth: GoogleAuth;
  label: string;
  scopes?: string[];
  /** Hosted users' own GitHub credential (GitHub App installation token); absent = GitHub tools must refuse, never fall back to the operator's token. */
  githubToken?: () => Promise<string>;
}
const requestAuth = new AsyncLocalStorage<RequestAuth>();

/** The hosted request scope, if any. */
export function currentRequest(): RequestAuth | undefined {
  return requestAuth.getStore();
}

export function runWithAuth<T>(ctx: RequestAuth, fn: () => T): T {
  return requestAuth.run(ctx, fn);
}

/** Build a GoogleAuth backed by a user's OAuth refresh token (access tokens are refreshed automatically). */
export function userOAuth(clientId: string, clientSecret: string, refreshToken: string): GoogleAuth {
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return new GoogleAuth({ authClient: client });
}

/** Scopes in effect: the user's grant inside a hosted request, otherwise the operator's SCOPES. */
export function currentScopes(): string[] {
  return requestAuth.getStore()?.scopes ?? SCOPES;
}

export function getAuth(): GoogleAuth {
  const scoped = requestAuth.getStore();
  if (scoped) return scoped.auth;
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({ scopes: SCOPES, ...resolveCredentialOptions() });
  }
  return cachedAuth;
}

export function searchConsole() {
  return google.searchconsole({ version: "v1", auth: getAuth() });
}

export function analyticsData() {
  return google.analyticsdata({ version: "v1beta", auth: getAuth() });
}

export function analyticsAdmin() {
  return google.analyticsadmin({ version: "v1beta", auth: getAuth() });
}

/** Describe which credential source is active, for diagnostics. */
export function describeCredentialSource(): string {
  const scoped = requestAuth.getStore();
  if (scoped) return scoped.label;
  if (envValue("GOOGLE_CREDENTIALS_JSON")) return "GOOGLE_CREDENTIALS_JSON (inline)";
  const envPath = envValue("GOOGLE_APPLICATION_CREDENTIALS");
  if (envPath) return `GOOGLE_APPLICATION_CREDENTIALS=${envPath}`;
  if (fs.existsSync(DEFAULT_CREDENTIALS_PATH)) return DEFAULT_CREDENTIALS_PATH;
  return "Application Default Credentials (gcloud)";
}
