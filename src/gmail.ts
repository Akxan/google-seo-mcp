/**
 * Gmail (read-only) client for the attachment tools. Authorized once with `npm run auth -- --gmail`;
 * the authorized_user JSON lives at GMAIL_CREDENTIALS (default ~/.config/google-seo-mcp/gmail.json).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";
import { envValue } from "./env.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
export const DEFAULT_GMAIL_CREDENTIALS_PATH = path.join(os.homedir(), ".config", "google-seo-mcp", "gmail.json");

export function gmailCredentialsPath(): string { return envValue("GMAIL_CREDENTIALS") ?? DEFAULT_GMAIL_CREDENTIALS_PATH; }

let cached: gmail_v1.Gmail | undefined;
export function getGmail(): gmail_v1.Gmail {
  if (cached) return cached;
  const file = gmailCredentialsPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Gmail is not authorized: no credentials at ${file}. Run \`npm run auth -- --gmail --client-secret ./client_secret.json\` once (read-only scope, needs the Gmail API enabled on the Google Cloud project), then point GMAIL_CREDENTIALS at the file; on a server copy it into secrets/.`);
  }
  const auth = new GoogleAuth({ keyFile: file, scopes: GMAIL_SCOPES });
  return (cached = google.gmail({ version: "v1", auth }));
}

export interface AttachmentRef { attachmentId: string; filename: string; mimeType: string; size: number }

/** Every attachment part of a message payload (nested multiparts included). Pure, for tests. */
export function collectAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (p?: gmail_v1.Schema$MessagePart | null) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) out.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0 });
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

export function header(m: gmail_v1.Schema$Message, name: string): string | undefined {
  return m.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? undefined;
}
