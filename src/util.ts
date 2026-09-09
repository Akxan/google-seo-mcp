import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: formatError(err) }] };
}

export function formatError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      code?: number | string;
      response?: { status?: number; data?: { error?: { message?: string; status?: string; details?: unknown } } };
      errors?: { message?: string; reason?: string }[];
    };
    const apiErr = e.response?.data?.error;
    const parts = [];
    if (e.response?.status ?? e.code) parts.push(`HTTP ${e.response?.status ?? e.code}`);
    if (apiErr?.status) parts.push(apiErr.status);
    parts.push(apiErr?.message ?? e.message ?? String(err));
    if (e.errors?.length) parts.push(e.errors.map((x) => `${x.reason ?? ""}: ${x.message ?? ""}`).join("; "));
    const text = parts.join(" | ");
    return withHint(text);
  }
  return String(err);
}

function withHint(text: string): string {
  if (/Could not load the default credentials|GOOGLE_APPLICATION_CREDENTIALS/i.test(text)) {
    return `${text}\nHint: run \`npm run auth\` to authorize with your Google account, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON.`;
  }
  if (/PERMISSION_DENIED|403/.test(text)) {
    return `${text}\nHint: make sure the authorized account (or service-account email) has been added as a user on the Search Console property / GA4 property, and that the API is enabled in the Google Cloud project.`;
  }
  return text;
}

/** Minimal view of the SDK's per-request extra info that handlers may use. */
export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
  signal?: AbortSignal;
}

/** Wrap a tool handler so that thrown errors become MCP error results. */
export function tool<A>(fn: (args: A, extra: ToolExtra) => Promise<unknown>): (args: A, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args: A, extra: ToolExtra) => {
    try {
      return ok(await fn(args, extra));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Send periodic progress notifications while a long task runs, if the client asked for progress. Returns a stop function. */
export function heartbeat(extra: ToolExtra, message: string, everyMs = 8000): () => void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return () => {};
  let n = 0;
  const timer = setInterval(() => {
    n++;
    void extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => {});
  }, everyMs);
  return () => clearInterval(timer);
}

/**
 * Resolve relative dates ("today", "yesterday", "NdaysAgo") to YYYY-MM-DD.
 * Search Console requires absolute dates; GA4 accepts both, but we normalize anyway.
 */
export function resolveDate(input: string): string {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const now = new Date();
  let offset: number;
  if (s === "today") offset = 0;
  else if (s === "yesterday") offset = 1;
  else {
    const m = /^(\d+)daysAgo$/i.exec(s);
    if (!m) throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, today, yesterday or NdaysAgo.`);
    offset = Number(m[1]);
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
  return d.toISOString().slice(0, 10);
}

export function round(n: number | null | undefined, digits: number): number | null {
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function toNumber(v: string | null | undefined): number | string | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? n : v;
}
