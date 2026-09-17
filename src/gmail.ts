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

export interface BodyPartRef { mimeType: string; size: number; data?: string; attachmentId?: string }

/**
 * The readable body parts (text/plain and text/html) of a message payload, attachments excluded.
 * Same nested-multipart walk as collectAttachments. Pure, for tests.
 */
export function collectBodyParts(payload: gmail_v1.Schema$MessagePart | undefined): BodyPartRef[] {
  const out: BodyPartRef[] = [];
  const walk = (p?: gmail_v1.Schema$MessagePart | null) => {
    if (!p) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    // A part with a filename is an attachment, even when it is text/plain.
    if (!p.filename && /^text\/(plain|html)$/.test(mime) && (p.body?.data || p.body?.attachmentId)) {
      out.push({ mimeType: mime, size: p.body?.size ?? 0, data: p.body?.data ?? undefined, attachmentId: p.body?.attachmentId ?? undefined });
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

// Named entities worth decoding: the structural ones plus what Spanish and French copy actually uses.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•",
  middot: "·", deg: "°", euro: "€", copy: "©", reg: "®", trade: "™", iexcl: "¡", iquest: "¿",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
  agrave: "à", egrave: "è", ccedil: "ç", ouml: "ö", auml: "ä",
};

/** Turn an HTML mail body into readable plain text (block tags become newlines, markup and entities go). Pure, for tests. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|section|article|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
