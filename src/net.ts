/**
 * Outbound HTTP for URLs a caller supplied: SSRF guard, manual redirects with every hop checked,
 * one timeout over headers and body, a body size cap, and charset-aware text decoding.
 *
 * Why: over HTTP this server is shared (OAuth clients, hosted users, and models that read pages
 * written by strangers), so "fetch this URL" must not reach 127.0.0.1, the cloud metadata address
 * or the operator's private network. The address check runs inside the socket's DNS lookup, so a
 * host that resolves to a public address for a pre-check and to a private one for the connection
 * (DNS rebinding) is still caught.
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { envValue } from "./env.js";

/* ---------- address classification ---------- */

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, or null. Accepts `::` compression, a dotted IPv4 tail, brackets and a zone id. */
function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let raw: string[];
  if (halves.length === 2) {
    if (head.length + rest.length > 7) return null;
    raw = [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  } else raw = head;
  if (raw.length !== 8 || raw.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return raw.map((g) => parseInt(g, 16));
}

function privateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, incl. the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function privateIPv6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::a.b.c.d (compatible; covers :: and ::1) and ::ffff:a.b.c.d (mapped): judge the IPv4 inside.
  if (zero(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return privateIPv4(v4(g[6], g[7]));
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return privateIPv4(v4(g[6], g[7])); // IPv4-translated
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return privateIPv4(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return privateIPv4(v4(g[1], g[2])); // 6to4
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0] & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (g[0] & 0xff00) === 0xff00 || // multicast ff00::/8
    (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
    (g[0] === 0x0100 && zero(1, 4)) // discard-only 100::/64
  );
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved IPv4/IPv6 addresses (IPv4-mapped forms included). False for public addresses and for anything that is not an IP. */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim();
  const v4 = parseIPv4(s);
  if (v4) return privateIPv4(v4);
  const v6 = parseIPv6(s);
  return v6 ? privateIPv6(v6) : false;
}

/* ---------- policy ---------- */

let transport: "stdio" | "http" = "stdio";

/** Called once by the HTTP transport at startup: from then on private addresses are refused unless explicitly allowed. */
export function setNetworkTransport(mode: "stdio" | "http"): void { transport = mode; }

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

/** HTTP (shared) instance: blocked unless SEO_MCP_ALLOW_PRIVATE_URLS=1. stdio (local dev, e.g. auditing http://localhost:4321): allowed unless SEO_MCP_BLOCK_PRIVATE_URLS=1. */
export function privateAddressesBlocked(): boolean {
  return transport === "http" ? !truthy(envValue("SEO_MCP_ALLOW_PRIVATE_URLS")) : truthy(envValue("SEO_MCP_BLOCK_PRIVATE_URLS"));
}

export class BlockedUrlError extends Error {
  readonly code = "ERR_SEO_MCP_BLOCKED_URL";
  constructor(message: string) { super(message); this.name = "BlockedUrlError"; }
}

function privateRefusal(host: string, address: string): BlockedUrlError {
  const how = transport === "http" ? "set SEO_MCP_ALLOW_PRIVATE_URLS=1 only on an instance where every caller is trusted" : "unset SEO_MCP_BLOCK_PRIVATE_URLS to allow it in local development";
  const target = host === address ? address : `${host} (resolves to ${address})`;
  return new BlockedUrlError(`Refused to fetch ${target}: loopback, private, link-local and reserved addresses are blocked on this server to prevent SSRF; ${how}.`);
}

/** Reject non-http(s) schemes and, when the policy blocks, literal private IP hosts (sockets skip the DNS lookup for those). */
export function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`Refused to fetch ${url.href}: only http and https URLs can be fetched.`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && privateAddressesBlocked() && isPrivateAddress(host)) throw privateRefusal(host, host);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * `lookup` for the socket: resolves every address and refuses the connection when ANY of them is private
 * (and the policy blocks). Running at connect time is what defeats DNS rebinding.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts: dns.LookupOptions = typeof options === "function" ? {} : typeof options === "number" ? { family: options } : { ...options };
  const wantAll = Boolean(opts.all);
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    if (privateAddressesBlocked()) {
      const bad = addresses.find((x) => isPrivateAddress(x.address));
      if (bad) return cb(privateRefusal(hostname, bad.address));
    }
    if (wantAll) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  });
}

let agent: Agent | undefined;
const dispatcher = () => (agent ??= new Agent({ connect: { lookup: guardedLookup as never } }));

/* ---------- charset ---------- */

function encodingFor(label: string): string | null {
  try { return new TextDecoder(label.trim().toLowerCase()).encoding; } catch { return null; }
}

const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\b/i;
const XML_TYPE = /\bxml\b/i;

/**
 * Which encoding a body is in: byte-order mark, then the Content-Type charset, then (HTML only) a
 * `<meta charset>` / `http-equiv` declaration or the XML declaration in the first 4 KB, else UTF-8.
 * Unknown labels are skipped.
 */
export function sniffCharset(bytes: Uint8Array, contentType?: string | null): { charset: string; source: "bom" | "header" | "meta" | "default" } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: "utf-8", source: "bom" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: "utf-16be", source: "bom" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: "utf-16le", source: "bom" };
  const ct = contentType ?? "";
  const declared = /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(ct)?.[1];
  const fromHeader = declared ? encodingFor(declared) : null;
  if (fromHeader) return { charset: fromHeader, source: "header" };
  const html = !ct.trim() || HTML_TYPE.test(ct);
  if (html || XML_TYPE.test(ct)) {
    const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4096)).toString("latin1");
    const m = (html ? /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(head) : null) ?? /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([\w.:+-]+)["']/i.exec(head);
    const found = m ? encodingFor(m[1]) : null;
    // A declaration readable as ASCII cannot really be UTF-16 (the HTML spec maps it to UTF-8).
    if (found) return { charset: found.startsWith("utf-16") ? "utf-8" : found, source: "meta" };
  }
  return { charset: "utf-8", source: "default" };
}

/** Decode a body with the charset sniffCharset picks (GBK, Shift_JIS, windows-1252 ... instead of always UTF-8). */
export function decodeBody(bytes: Uint8Array, contentType?: string | null): { text: string; charset: string; source: "bom" | "header" | "meta" | "default" } {
  const found = sniffCharset(bytes, contentType);
  return { text: new TextDecoder(found.charset).decode(bytes), ...found };
}

/* ---------- fetch ---------- */

export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
export const MAX_REDIRECTS = 10;

export interface SafeFetchOptions {
  /** One deadline for connecting, headers and reading the body. Default 20 s. */
  timeoutMs?: number;
  /** Largest body (after decompression) a caller may read; reading more fails with a clear error. Default 15 MB. */
  maxBytes?: number;
}

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * fetch() for caller-supplied URLs. Redirects are followed here (at most 10), each hop re-checked;
 * `redirect: "manual"` returns the 3xx itself as before. The returned Response has the final `url`
 * and `redirected` set, a size-capped body, and a `text()` that honours the page's charset.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const mode = init.redirect ?? "follow";
  let current = new URL(input);
  const start = current.href;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out after ${Math.round(timeoutMs / 100) / 10} s fetching ${current.href}`)), timeoutMs);
  timer.unref?.();
  let settled = false;
  const finish = () => { if (!settled) { settled = true; clearTimeout(timer); } };
  const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  try {
    for (let hop = 0; ; hop++) {
      assertFetchableUrl(current);
      const res = await undiciFetch(current.href, { ...(init as object), method, body, headers: [...headers], redirect: "manual", signal, dispatcher: dispatcher() } as never);
      const location = res.headers.get("location");
      if (mode !== "manual" && location && [301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel().catch(() => {});
        if (mode === "error") throw new Error(`${start} redirects (HTTP ${res.status}) and redirect: "error" was requested`);
        if (hop >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects starting at ${start}`);
        const next = new URL(location, current);
        // Same method rewrites as fetch(): 303 -> GET, and 301/302 turn a POST into a GET.
        if (res.status === 303 ? method !== "GET" && method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST") {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        if (next.origin !== current.origin) for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
        current = next;
        continue;
      }
      return wrapResponse(res as unknown as Response, { url: current, redirected: hop > 0, maxBytes, finish, ctrl });
    }
  } catch (err) {
    finish();
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof BlockedUrlError) throw cause;
    if (err instanceof TypeError && err.message === "fetch failed" && cause instanceof Error) throw new Error(`fetch failed for ${current.href}: ${cause.message}`, { cause });
    throw err;
  }
}

function wrapResponse(res: Response, ctx: { url: URL; redirected: boolean; maxBytes: number; finish: () => void; ctrl: AbortController }): Response {
  const status = res.status;
  let body: ReadableStream<Uint8Array> | null = null;
  if (!res.body || NULL_BODY.has(status)) {
    void res.body?.cancel().catch(() => {});
    ctx.finish();
  } else body = limitBody(res.body, ctx);
  const inRange = status >= 200 && status <= 599;
  const statusText = /^[\t\x20-\x7e\x80-\xff]*$/.test(res.statusText) ? res.statusText : "";
  const out = new Response(body, { status: inRange ? status : 200, statusText, headers: res.headers });
  const url = new URL(ctx.url);
  url.hash = "";
  const prop = (value: unknown) => ({ value, configurable: true });
  const props: PropertyDescriptorMap = { url: prop(url.href), redirected: prop(ctx.redirected) };
  // Non-standard codes (LinkedIn answers 999) are outside what the Response constructor takes.
  if (!inRange) Object.assign(props, { status: prop(status), ok: prop(false) });
  Object.defineProperties(out, props);
  const contentType = res.headers.get("content-type");
  out.text = async () => decodeBody(new Uint8Array(await out.arrayBuffer()), contentType).text;
  return out;
}

function limitBody(src: ReadableStream<Uint8Array>, ctx: { url: URL; maxBytes: number; finish: () => void; ctrl: AbortController }): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { ctx.finish(); controller.close(); return; }
          total += value.byteLength;
          if (total > ctx.maxBytes) {
            ctx.finish();
            void reader.cancel().catch(() => {});
            controller.error(new Error(`Response body of ${ctx.url.href} is larger than ${mb(ctx.maxBytes)}; stopped reading (size limit of this server).`));
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          ctx.finish();
          controller.error(ctx.ctrl.signal.aborted && ctx.ctrl.signal.reason instanceof Error ? ctx.ctrl.signal.reason : err);
        }
      },
      cancel(reason) {
        ctx.finish();
        return reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}
