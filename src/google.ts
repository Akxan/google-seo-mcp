import fs from "node:fs";
import { envValue } from "./env.js";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";

export const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/analytics.readonly",
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

export function getAuth(): GoogleAuth {
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
  if (envValue("GOOGLE_CREDENTIALS_JSON")) return "GOOGLE_CREDENTIALS_JSON (inline)";
  const envPath = envValue("GOOGLE_APPLICATION_CREDENTIALS");
  if (envPath) return `GOOGLE_APPLICATION_CREDENTIALS=${envPath}`;
  if (fs.existsSync(DEFAULT_CREDENTIALS_PATH)) return DEFAULT_CREDENTIALS_PATH;
  return "Application Default Credentials (gcloud)";
}
