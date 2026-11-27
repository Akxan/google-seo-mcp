import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { envValue } from "./env.js";

/** Upper bound for a tool result; larger payloads are trimmed so one call cannot flood the model's context. */
export const MAX_RESULT_CHARS = Number(envValue("SEO_MCP_MAX_RESULT_CHARS") ?? 120_000);

type Path = (string | number)[];

/** Arrays longer than 5 items anywhere in the value (up to 4 levels deep), e.g. `rows` inside each report of a batch. */
function arraysIn(value: unknown, path: Path, out: { path: Path; len: number; size: number }[], depth = 0): void {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 5) out.push({ path, len: value.length, size: JSON.stringify(value).length });
    value.forEach((v, i) => arraysIn(v, [...path, i], out, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(value)) arraysIn(v, [...path, k], out, depth + 1);
}

function getAt(root: unknown, path: Path): unknown {
  let cur = root as Record<string | number, unknown> | undefined;
  for (const p of path) { if (!cur || typeof cur !== "object") return undefined; cur = cur[p] as Record<string | number, unknown> | undefined; }
  return cur;
}

function setAt(root: Record<string | number, unknown>, path: Path, value: unknown): void {
  let cur = root;
  for (const p of path.slice(0, -1)) cur = cur[p] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
}

const label = (path: Path) => path.slice(1).map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("") || "items";

/** Trim oversized arrays inside a result (largest first, at any depth) until it fits, and say what was cut. */
export function fitResult(data: unknown, max = MAX_RESULT_CHARS): { data: unknown; truncated?: string } {
  let text = JSON.stringify(data);
  if (text.length <= max || !data || typeof data !== "object") return { data };
  const holder = { root: JSON.parse(text) as unknown };
  const notes: string[] = [];
  const candidates: { path: Path; len: number; size: number }[] = [];
  arraysIn(holder.root, ["root"], candidates);
  candidates.sort((a, b) => b.size - a.size);
  for (const c of candidates) {
    if (text.length <= max) break;
    const arr = getAt(holder, c.path);
    if (!Array.isArray(arr) || arr.length <= 5) continue; // already removed with a parent, or trimmed
    let keep = arr.length;
    while (keep > 5 && text.length > max) {
      keep = Math.max(5, Math.floor(keep / 2));
      setAt(holder, c.path, arr.slice(0, keep));
      text = JSON.stringify(holder.root);
    }
    if (keep < arr.length) notes.push(`${label(c.path)}: ${keep} of ${arr.length} items`);
  }
  const clone = holder.root as Record<string, unknown>;
  if (text.length > max && !Array.isArray(clone)) { // still too big: fall back to a hard cut of long strings
    for (const [key, value] of Object.entries(clone)) if (typeof value === "string" && value.length > 2000) { clone[key] = value.slice(0, 2000) + "…"; notes.push(`${key}: string cut to 2000 chars`); }
    text = JSON.stringify(clone);
  }
  return { data: clone, truncated: notes.length ? `Result truncated to fit ${max} chars (${notes.join("; ")}). Narrow the request (smaller limit/top, fewer dimensions, a filter, or pagination) to see more.` : undefined };
}

export function ok(data: unknown): CallToolResult {
  const fitted = fitResult(data);
  const payload = fitted.truncated && fitted.data && typeof fitted.data === "object" ? { ...(fitted.data as object), _truncated: fitted.truncated } : fitted.data;
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
  if (/invalid_grant|Token has been expired or revoked/i.test(text)) {
    return `${text}\nHint: the Google authorization behind this token was revoked or expired. Sign in again on the dashboard (hosted service) or re-run \`npm run auth\` (self-hosted).`;
  }
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
