/**
 * GitHub tools so static sites (Astro on Cloudflare Pages) can be edited from any MCP client.
 * Token: GITHUB_TOKEN env, else `gh auth token` (GitHub CLI) if available.
 */
import { execFile } from "node:child_process";
import vm from "node:vm";
import { envValue } from "../env.js";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { heartbeat, MAX_RESULT_CHARS, tool } from "../util.js";
import { fetchWithTimeout } from "./web.js";
import { currentRequest } from "../google.js";

const execFileP = promisify(execFile);
const API = "https://api.github.com";
let cachedToken: string | undefined;

export async function githubToken(): Promise<string | undefined> {
  const scoped = currentRequest();
  if (scoped) {
    // Hosted request: only that user's own connection counts.
    if (!scoped.githubToken) throw new Error("GitHub is not connected for this account. Open the dashboard and click 'Connect GitHub' to install the app on the repositories you want to edit.");
    return scoped.githubToken();
  }
  if (cachedToken) return cachedToken;
  const fromEnv = envValue("GITHUB_TOKEN");
  if (fromEnv) return (cachedToken = fromEnv);
  try { const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 10_000 }); if (stdout.trim()) return (cachedToken = stdout.trim()); } catch { /* gh not available */ }
  return undefined;
}

/** A GitHub API failure that keeps the HTTP status, so a refused fast-forward (422) can be told apart from other errors. */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function gh<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await githubToken();
  if (!token) throw new Error("No GitHub token. Set GITHUB_TOKEN (fine-grained PAT with Contents read/write on the repos) or log in with `gh auth login`.");
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "google-seo-mcp", ...(init.headers ?? {}) } });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new GitHubError(`GitHub ${res.status} ${path}: ${(data as { message?: string })?.message ?? text.slice(0, 300)}`, res.status);
  return data as T;
}

const repoParam = z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("Repository as 'owner/name', e.g. 'octocat/my-site'.");

export interface BuildSnapshot {
  settled: boolean;
  conclusion: "success" | "failure" | "pending" | "none";
  checks: { name: string; status: string; conclusion: string | null; url?: string }[];
  commitStatus: { state: string; contexts: { context: string; state: string; url?: string }[] } | null;
  deployments: { environment: string; state: string; url?: string; description?: string }[];
}

const DONE = new Set(["completed", "success", "failure", "error", "inactive"]);
const BAD = new Set(["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** Checks, commit status and deployments for one sha, plus whether everything has settled. */
export async function buildSnapshot(repo: string, sha: string): Promise<BuildSnapshot> {
  const [runs, status, deps] = await Promise.all([
    gh<{ check_runs: { name: string; status: string; conclusion: string | null; html_url?: string }[] }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })),
    gh<{ state: string; statuses: { context: string; state: string; target_url?: string }[] }>(`/repos/${repo}/commits/${sha}/status`).catch(() => null),
    gh<{ id: number; environment: string; description?: string }[]>(`/repos/${repo}/deployments?sha=${sha}&per_page=10`).catch(() => []),
  ]);
  const deployments = await Promise.all(
    (deps ?? []).map(async (d) => {
      const st = await gh<{ state: string; environment_url?: string; target_url?: string; description?: string }[]>(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`).catch(() => []);
      const latest = st[0];
      return { environment: d.environment, state: latest?.state ?? "pending", url: latest?.environment_url ?? latest?.target_url, description: latest?.description ?? d.description };
    }),
  );
  const checks = (runs.check_runs ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url }));
  const settled =
    checks.every((c) => c.status === "completed") &&
    deployments.every((d) => DONE.has(d.state)) &&
    (status?.state !== "pending" || (status?.statuses ?? []).length === 0);
  const failed = checks.some((c) => c.conclusion && BAD.has(c.conclusion)) || deployments.some((d) => BAD.has(d.state)) || status?.state === "failure" || status?.state === "error";
  const anything = checks.length > 0 || deployments.length > 0 || (status?.statuses ?? []).length > 0;
  return {
    settled,
    conclusion: failed ? "failure" : !anything ? "none" : settled ? "success" : "pending",
    checks,
    commitStatus: status ? { state: status.state, contexts: (status.statuses ?? []).map((x) => ({ context: x.context, state: x.state, url: x.target_url })) } : null,
    deployments,
  };
}

/** Fetch a page to confirm a deploy really landed, for hosts that report nothing to GitHub. */
async function probe(url: string, expect?: string): Promise<{ url: string; status: number; ok: boolean; textFound?: boolean }> {
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "google-seo-mcp build check" } }, 20_000);
    const body = expect ? await res.text() : "";
    return { url, status: res.status, ok: res.ok, textFound: expect ? body.includes(expect) : undefined };
  } catch (e) {
    return { url, status: 0, ok: false, textFound: expect ? false : undefined };
  }
}

/** Tail of the log of the first failed job in the most recent Actions run for a sha. */
async function failingRunLog(repo: string, sha: string): Promise<string | undefined> {
  try {
    const runs = await gh<{ workflow_runs: { id: number; conclusion: string | null }[] }>(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=10`);
    const bad = (runs.workflow_runs ?? []).find((r) => r.conclusion && BAD.has(r.conclusion));
    if (!bad) return undefined;
    const jobs = await gh<{ jobs: { id: number; name: string; conclusion: string | null }[] }>(`/repos/${repo}/actions/runs/${bad.id}/jobs?per_page=30`);
    const job = (jobs.jobs ?? []).find((j) => j.conclusion && BAD.has(j.conclusion));
    if (!job) return undefined;
    const token = await githubToken();
    const res = await fetch(`${API}/repos/${repo}/actions/jobs/${job.id}/logs`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "google-seo-mcp" }, redirect: "follow" });
    if (!res.ok) return undefined;
    const text = await res.text();
    return `job "${job.name}" (last 3000 chars):\n${text.slice(-3000)}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cloudflare Workers Builds and Pages: neither reports to GitHub on this kind of setup, so with a read-only API
// token (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) github_build_status looks the commit up on Cloudflare itself.
// ---------------------------------------------------------------------------------------------------------------

export interface CfWorkersBuild {
  build_uuid: string; status?: string; build_outcome?: string | null; created_on?: string;
  build_trigger_metadata?: { commit_hash?: string; branch?: string; repo_name?: string; provider_account_name?: string };
}
export interface CfPagesDeployment {
  id: string; url?: string; environment?: string; created_on?: string; is_skipped?: boolean;
  latest_stage?: { name?: string; status?: string };
  deployment_trigger?: { metadata?: { commit_hash?: string; branch?: string } };
}
interface CfPagesProject { name: string; source?: { type?: string; config?: { owner?: string; repo_name?: string } } | null }

export type CfBuildState = "queued" | "running" | "success" | "failure" | "skipped";
export interface CloudflareBuild {
  provider: "workers" | "pages"; name: string; status: CfBuildState; detail: string;
  branch?: string; environment?: string; created?: string; url: string; deploymentUrl?: string;
}

/** A build's commit hash against the full sha: equal or one a prefix of the other, at least 7 hex characters. */
export function commitMatches(hash: string | undefined, sha: string): boolean {
  const h = hash?.trim().toLowerCase(), s = sha.trim().toLowerCase();
  return !!h && h.length >= 7 && s.length >= 7 && (s.startsWith(h) || h.startsWith(s));
}

function workersState(b: CfWorkersBuild): { status: CfBuildState; detail: string } {
  const s = b.status ?? "unknown", o = b.build_outcome ?? undefined;
  const detail = o ? `${s}/${o}` : s;
  if (s === "queued") return { status: "queued", detail };
  if (s !== "stopped") return { status: "running", detail }; // initializing, running
  return { status: o === "success" ? "success" : o === "skipped" ? "skipped" : "failure", detail }; // fail, cancelled, terminated
}

function pagesState(d: CfPagesDeployment): { status: CfBuildState; detail: string } {
  const name = d.latest_stage?.name ?? "unknown", st = d.latest_stage?.status ?? "unknown";
  const detail = `${name}:${st}`;
  if (d.is_skipped || st === "skipped") return { status: "skipped", detail };
  if (st === "failure" || st === "canceled") return { status: "failure", detail };
  if (name === "deploy" && st === "success") return { status: "success", detail };
  return { status: name === "queued" ? "queued" : "running", detail };
}

const newestFirst = (x: { created_on?: string }, y: { created_on?: string }) => (y.created_on ?? "").localeCompare(x.created_on ?? "");

/**
 * The newest Workers build and Pages deployment of `sha` per script/project, summarised (status, dashboard link).
 * Only named fields are copied, so build environment variables in the API payload never reach the reply. Pure, for tests.
 */
export function matchCloudflareBuilds(
  sha: string,
  accountId: string,
  input: { workers?: { name: string; builds: CfWorkersBuild[] }[]; pages?: { name: string; deployments: CfPagesDeployment[] }[] },
): CloudflareBuild[] {
  const dash = `https://dash.cloudflare.com/${encodeURIComponent(accountId)}`;
  const out: CloudflareBuild[] = [];
  for (const w of input.workers ?? []) {
    const b = w.builds.filter((x) => commitMatches(x.build_trigger_metadata?.commit_hash, sha)).sort(newestFirst)[0];
    if (b) out.push({ provider: "workers", name: w.name, ...workersState(b), branch: b.build_trigger_metadata?.branch, created: b.created_on, url: `${dash}/workers/services/view/${encodeURIComponent(w.name)}/production/builds/${b.build_uuid}` });
  }
  for (const p of input.pages ?? []) {
    const d = p.deployments.filter((x) => commitMatches(x.deployment_trigger?.metadata?.commit_hash, sha)).sort(newestFirst)[0];
    if (d) out.push({ provider: "pages", name: p.name, ...pagesState(d), branch: d.deployment_trigger?.metadata?.branch, environment: d.environment, created: d.created_on, url: `${dash}/pages/view/${encodeURIComponent(p.name)}/${d.id}`, deploymentUrl: d.url });
  }
  return out;
}

/** GitHub's own snapshot combined with Cloudflare builds: a successful Cloudflare build counts as built. Pure, for tests. */
export function combineBuildState(github: Pick<BuildSnapshot, "settled" | "conclusion">, cf: CloudflareBuild[]): Pick<BuildSnapshot, "settled" | "conclusion"> {
  const settled = github.settled && !cf.some((b) => b.status === "queued" || b.status === "running");
  if (github.conclusion === "failure" || cf.some((b) => b.status === "failure")) return { settled, conclusion: "failure" };
  if (!settled) return { settled, conclusion: "pending" };
  if (github.conclusion === "none") return { settled, conclusion: cf.some((b) => b.status === "success") ? "success" : "none" };
  return { settled, conclusion: github.conclusion };
}

const CF_API = "https://api.cloudflare.com/client/v4";
const CF_SCAN_LIMIT = 20;

/** One Cloudflare GET. Errors carry Cloudflare's message, never the request headers. */
async function cfGet<T>(token: string, path: string): Promise<{ result?: T; result_info?: { total_pages?: number } }> {
  let res: Response;
  try { res = await fetchWithTimeout(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, 8000); }
  catch { throw new Error("no answer within 8 s"); }
  const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message?: string }[]; result?: T; result_info?: { total_pages?: number } } | null;
  if (!res.ok || !body || body.success === false) {
    const msg = (body?.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(`HTTP ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ""}`);
  }
  return body;
}

const sameRepo = (owner: string | undefined, name: string | undefined, repo: string) => !!owner && !!name && `${owner}/${name}`.toLowerCase() === repo.toLowerCase();

/** Lists fetched once per github_build_status call and reused while it polls. */
interface CfScan {
  scripts?: { name: string; tag: string }[];
  projects?: { name: string; linked: boolean }[];
  workersOff?: boolean;
  pagesOff?: boolean;
  /** Per provider, the scripts/projects that already showed a build of this commit: later polls ask only those. */
  matched: { workers?: Set<string>; pages?: Set<string> };
  notes: string[];
}

/** Workers Builds and Pages deployments of `sha`; undefined when not configured, or for hosted users (never the operator's account). */
async function cloudflareLookup(repo: string, sha: string, scan: CfScan): Promise<{ builds: CloudflareBuild[]; linked: string[]; notes: string[] } | undefined> {
  if (currentRequest()) return undefined;
  const token = envValue("CLOUDFLARE_API_TOKEN"), account = envValue("CLOUDFLARE_ACCOUNT_ID");
  if (!token || !account) return undefined;
  const acct = `/accounts/${encodeURIComponent(account)}`;
  const notes: string[] = [];
  const wanted = (kind: "workers" | "pages", name: string) => !scan.matched[kind] || scan.matched[kind].has(name);

  const workers = async (): Promise<{ items: { name: string; builds: CfWorkersBuild[] }[]; linked: string[] }> => {
    if (scan.workersOff) return { items: [], linked: [] };
    try {
      if (!scan.scripts) {
        const all = ((await cfGet<{ id: string; tag?: string }[]>(token, `${acct}/workers/scripts`)).result ?? []).filter((s) => s.tag);
        if (all.length > CF_SCAN_LIMIT) scan.notes.push(`Only the first ${CF_SCAN_LIMIT} of ${all.length} Workers were checked.`);
        scan.scripts = all.slice(0, CF_SCAN_LIMIT).map((s) => ({ name: s.id, tag: s.tag! }));
      }
      const scripts = scan.scripts.filter((s) => wanted("workers", s.name));
      if (!scripts.length) return { items: [], linked: [] };
      // One request for every script's latest build; a script's full list only when it builds this repo.
      const latest = (await cfGet<{ builds?: Record<string, CfWorkersBuild> }>(token, `${acct}/builds/builds/latest?external_script_ids=${scripts.map((s) => s.tag).join(",")}`)).result?.builds ?? {};
      const linked: string[] = [];
      const items = await Promise.all(scripts.map(async (s) => {
        const last = latest[s.tag];
        if (!last) return null; // never built from git
        const meta = last.build_trigger_metadata;
        const isLinked = sameRepo(meta?.provider_account_name, meta?.repo_name, repo);
        if (isLinked) linked.push(s.name);
        if (commitMatches(meta?.commit_hash, sha)) return { name: s.name, builds: [last] };
        if (!isLinked) return null;
        try { return { name: s.name, builds: (await cfGet<CfWorkersBuild[]>(token, `${acct}/builds/workers/${s.tag}/builds?per_page=10`)).result ?? [] }; }
        catch (e) { notes.push(`Worker ${s.name}: builds not readable (${(e as Error).message}).`); return null; }
      }));
      return { items: items.filter((x): x is { name: string; builds: CfWorkersBuild[] } => !!x), linked };
    } catch (e) {
      scan.workersOff = true;
      scan.notes.push(`Workers Builds not checked (${(e as Error).message}); the token needs Workers Scripts Read and Workers CI Read.`);
      return { items: [], linked: [] };
    }
  };

  const pages = async (): Promise<{ items: { name: string; deployments: CfPagesDeployment[] }[]; linked: string[] }> => {
    if (scan.pagesOff) return { items: [], linked: [] };
    try {
      if (!scan.projects) {
        // Pages lists at most 10 projects per page.
        const first = await cfGet<CfPagesProject[]>(token, `${acct}/pages/projects?page=1`);
        let all = first.result ?? [];
        const pagesTotal = first.result_info?.total_pages ?? 1;
        if (pagesTotal > 1) all = all.concat((await cfGet<CfPagesProject[]>(token, `${acct}/pages/projects?page=2`)).result ?? []);
        if (pagesTotal > 2) scan.notes.push(`Only the first ${CF_SCAN_LIMIT} Pages projects were checked.`);
        // A project connected to another repository cannot have built this commit; a direct-upload one
        // (wrangler pages deploy from CI) still may have, with the commit hash in its metadata.
        scan.projects = all
          .filter((p) => !p.source || sameRepo(p.source.config?.owner, p.source.config?.repo_name, repo))
          .slice(0, CF_SCAN_LIMIT)
          .map((p) => ({ name: p.name, linked: !!p.source }));
      }
      const projects = scan.projects.filter((p) => wanted("pages", p.name));
      const items = await Promise.all(projects.map(async (p) => {
        try { return { name: p.name, deployments: (await cfGet<CfPagesDeployment[]>(token, `${acct}/pages/projects/${encodeURIComponent(p.name)}/deployments?per_page=10`)).result ?? [] }; }
        catch (e) { notes.push(`Pages project ${p.name}: deployments not readable (${(e as Error).message}).`); return null; }
      }));
      return { items: items.filter((x): x is { name: string; deployments: CfPagesDeployment[] } => !!x), linked: projects.filter((p) => p.linked).map((p) => p.name) };
    } catch (e) {
      scan.pagesOff = true;
      scan.notes.push(`Pages not checked (${(e as Error).message}); the token needs Cloudflare Pages Read.`);
      return { items: [], linked: [] };
    }
  };

  const [w, p] = await Promise.all([workers(), pages()]);
  const builds = matchCloudflareBuilds(sha, account, { workers: w.items, pages: p.items });
  for (const kind of ["workers", "pages"] as const) {
    const names = builds.filter((b) => b.provider === kind).map((b) => b.name);
    if (names.length) scan.matched[kind] = new Set(names);
  }
  return { builds, linked: [...w.linked, ...p.linked], notes: [...scan.notes, ...notes] };
}

/** One in-place text edit: `find` must occur exactly once unless `all` is set. */
export interface TextEdit { find: string; replace: string; all?: boolean }

/** Apply edits in order; throws with the reason when a find string is missing or ambiguous (so nothing half-applied gets committed). */
export function applyTextEdits(text: string, edits: TextEdit[], label = "file"): { text: string; applied: number } {
  let out = text;
  let applied = 0;
  edits.forEach((e, i) => {
    const count = out.split(e.find).length - 1;
    if (count === 0) throw new Error(`${label}: edit #${i + 1} not applied, find string not found: ${JSON.stringify(e.find.slice(0, 80))}`);
    if (count > 1 && !e.all) throw new Error(`${label}: edit #${i + 1} is ambiguous, find string occurs ${count} times (add surrounding context or set all=true): ${JSON.stringify(e.find.slice(0, 80))}`);
    out = e.all ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace);
    applied += e.all ? count : 1;
  });
  return { text: out, applied };
}

function diffStats(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  const inA = new Set(a), inB = new Set(b);
  return { linesAdded: b.filter((l) => !inA.has(l)).length, linesRemoved: a.filter((l) => !inB.has(l)).length };
}

/** Current file on a ref: text (null when binary), size; null when missing. Falls back to the blob API for files over the 1 MB contents limit. */
async function readRepoFile(repo: string, path: string, ref: string): Promise<{ text: string | null; bytes: number; buf: Buffer; sha: string; url?: string } | null> {
  let d: { type: string; encoding?: string; content?: string; size: number; sha: string; html_url?: string };
  try { d = await gh(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`); } catch { return null; }
  if (d.type !== "file") return null;
  let buf: Buffer;
  if (d.encoding === "base64" && d.content) buf = Buffer.from(d.content, "base64");
  else { const blob = await gh<{ content: string }>(`/repos/${repo}/git/blobs/${d.sha}`); buf = Buffer.from(blob.content, "base64"); }
  return { text: buf.subarray(0, 8000).includes(0) ? null : buf.toString("utf8"), bytes: buf.length, buf, sha: d.sha, url: d.html_url };
}

/**
 * A byte window of a UTF-8 buffer that never splits a multibyte character, so paging through a
 * big file with offset/nextOffset cannot corrupt the text. Pure, for tests.
 */
export function sliceUtf8(buf: Buffer, offset: number, maxBytes: number): { text: string; start: number; end: number; truncated: boolean } {
  let start = Math.min(Math.max(0, Math.trunc(offset)), buf.length);
  while (start > 0 && start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // land on a lead byte
  let end = Math.min(start + Math.max(1, Math.trunc(maxBytes)), buf.length);
  while (end > start && end < buf.length && (buf[end] & 0xc0) === 0x80) end--; // do not cut a character in half
  return { text: buf.subarray(start, end).toString("utf8"), start, end, truncated: end < buf.length };
}

/**
 * Like sliceUtf8, but shrinks the window until the JSON-escaped text fits maxChars. Quotes, backslashes and
 * newlines in source code grow when escaped, and a reply over the server's result cap used to be cut to 2,000
 * characters while nextOffset still pointed past the full window, so whatever lay in between was silently
 * skipped. Pure, for tests.
 */
export function sliceUtf8Fitting(buf: Buffer, offset: number, maxBytes: number, maxChars: number) {
  let window = Math.max(1, Math.trunc(maxBytes));
  let s = sliceUtf8(buf, offset, window);
  while (window > 1000 && JSON.stringify(s.text).length > maxChars) {
    window = Math.max(1000, Math.floor(window * Math.min(0.9, maxChars / JSON.stringify(s.text).length)));
    s = sliceUtf8(buf, offset, window);
  }
  return s;
}

export interface FindOptions { regex?: boolean; ignoreCase?: boolean; context?: number; maxMatches?: number; timeoutMs?: number }
export interface FindMatch { line: number; byteOffset: number; excerpt: string }

const EXCERPT_LINE_CHARS = 300;

/** A line cut to about EXCERPT_LINE_CHARS, centred on column `at` when given: a minified bundle is one huge line, and its first 300 characters would not show the match. */
function clipLine(line: string, at?: number): string {
  if (line.length <= EXCERPT_LINE_CHARS) return line;
  let start = at === undefined ? 0 : Math.max(0, Math.min(at - 100, line.length - EXCERPT_LINE_CHARS));
  const low = (i: number) => { const c = line.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  if (start > 0 && low(start)) start--; // do not split a surrogate pair
  let end = start + EXCERPT_LINE_CHARS;
  if (end < line.length && low(end)) end++;
  return (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
}

function compileFind(pattern: string, regex: boolean, ignoreCase: boolean): RegExp {
  const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = `gm${ignoreCase ? "i" : ""}`;
  try { return new RegExp(source, `${flags}u`); } catch { /* not valid in unicode mode (e.g. "\-"): try the legacy syntax */ }
  try { return new RegExp(source, flags); } catch (e) {
    throw new Error(`Invalid regex ${JSON.stringify(pattern)}: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}. Set regex=false to search for the literal text.`);
  }
}

// Runs inside a vm context with a timeout, so a catastrophic regex on a 1 MB file stops after a moment instead of
// freezing the shared server for every connected client.
const FIND_SCAN = "const hits = []; let total = 0, m; re.lastIndex = 0; while ((m = re.exec(text)) !== null) { if (total++ < max) hits.push(m.index); if (m[0] === '') re.lastIndex++; } ({ hits, total })";

/**
 * Grep a whole text: each match with its 1-based line, the UTF-8 byte offset of the match start (usable as
 * github_get_file's offset) and grep-style context lines ("12:" the match, "11-" around it). Pure, for tests.
 */
export function findInText(text: string, pattern: string, opts: FindOptions = {}): { matches: FindMatch[]; totalMatches: number; truncated: boolean } {
  if (!pattern) throw new Error("find must not be empty.");
  const context = Math.min(10, Math.max(0, Math.trunc(opts.context ?? 2)));
  const max = Math.min(100, Math.max(1, Math.trunc(opts.maxMatches ?? 20)));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const re = compileFind(pattern, !!opts.regex, !!opts.ignoreCase);
  let found: { hits: number[]; total: number };
  try {
    found = vm.runInNewContext(FIND_SCAN, { re, text, max }, { timeout: timeoutMs });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new Error(`find was stopped after ${timeoutMs} ms on this file; simplify the regex (avoid nested quantifiers such as (a+)+).`);
    throw e;
  }
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineCount = text.endsWith("\n") ? starts.length - 1 : starts.length; // no phantom line after a final newline
  const lineOf = (idx: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return Math.min(lo, Math.max(0, lineCount - 1));
  };
  const lineText = (n: number) => text.slice(starts[n], n + 1 < starts.length ? starts[n + 1] - 1 : text.length).replace(/\r$/, "");
  let prev = 0, bytes = 0;
  const matches = Array.from(found.hits, (idx) => {
    bytes += Buffer.byteLength(text.slice(prev, idx), "utf8");
    prev = idx;
    const ln = lineOf(idx);
    const rows: string[] = [];
    for (let n = Math.max(0, ln - context); n <= Math.min(lineCount - 1, ln + context); n++) {
      rows.push(`${n + 1}${n === ln ? ":" : "-"}${clipLine(lineText(n), n === ln ? idx - starts[ln] : undefined)}`);
    }
    return { line: ln + 1, byteOffset: bytes, excerpt: rows.join("\n") };
  });
  return { matches, totalMatches: found.total, truncated: found.total > matches.length };
}

async function branchHead(repo: string, branch: string): Promise<string | null> {
  try { const r = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${branch}`); return r.object.sha; } catch { return null; }
}

function branchMoved(branch: string, readAt: string, now: string | null): Error {
  return new Error(`Branch '${branch}' moved while this commit was being prepared: the files were read at ${readAt.slice(0, 7)}, but ${now ? `the branch is now at ${now.slice(0, 7)}` : "another commit landed since"}. Nothing was committed, so that newer change was not overwritten. Re-run the same call: it re-reads the files from the new head and re-checks every edit.`);
}

/**
 * One commit on `branch` from base64 blobs (base64 null = delete). Creates the branch from the default branch when asked.
 * expectedParent is the commit the caller read its files at: the new commit is built on exactly that commit and the
 * ref is only fast-forwarded, so when another session committed in between, the commit is refused instead of
 * silently overwriting that work with edits computed on the old content. Without it the current head is used,
 * which is fine for callers that write whole new files (images).
 */
export async function commitBlobs(repo: string, branch: string, message: string, entries: { path: string; base64: string | null }[], createBranch: boolean, expectedParent?: string) {
  let headSha = await branchHead(repo, branch);
  if (headSha && expectedParent && headSha !== expectedParent) throw branchMoved(branch, expectedParent, headSha);
  if (!headSha) {
    if (!createBranch) throw new Error(`Branch '${branch}' not found. Pass createBranch=true to create it from the default branch.`);
    let base = expectedParent;
    if (!base) {
      const info = await gh<{ default_branch: string }>(`/repos/${repo}`);
      base = (await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${info.default_branch}`)).object.sha;
    }
    try {
      headSha = (await gh<{ object: { sha: string } }>(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }) })).object.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) throw new Error(`Branch '${branch}' was created by someone else while this commit was being prepared. Nothing was committed; re-run the same call to build on it.`);
      throw e;
    }
  }
  const headCommit = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${headSha}`);
  const tree = await Promise.all(entries.map(async (e) => {
    if (e.base64 === null) return { path: e.path, mode: "100644", type: "blob", sha: null as string | null };
    const blob = await gh<{ sha: string }>(`/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: e.base64, encoding: "base64" }) });
    return { path: e.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const newTree = await gh<{ sha: string }>(`/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
  const commit = await gh<{ sha: string; html_url: string }>(`/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }) });
  try {
    await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
  } catch (e) {
    // 422 "Update is not a fast forward": the branch got a new commit after headSha was read.
    if (e instanceof GitHubError && e.status === 422) throw branchMoved(branch, headSha, await branchHead(repo, branch));
    throw e;
  }
  return { commit: commit.sha.slice(0, 7), sha: commit.sha, url: commit.html_url };
}

/** Image file extensions a commit might carry. SVG is left out: it is text a model can legitimately write. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|ico|tiff?)$/i;
/** Enough bytes for any real image header, and small enough that a placeholder or favicon still passes. */
export const MAX_INLINE_IMAGE_BYTES = 4096;

/** Magic bytes of the formats a model is most likely to hallucinate a header for. */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const ascii = (at: number, n: number) => buf.subarray(at, at + n).toString("latin1");
  if (buf[0] === 0x89 && ascii(1, 3) === "PNG") return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;            // JPEG
  if (ascii(0, 3) === "GIF") return true;
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return true;
  if (ascii(4, 4) === "ftyp" && /^(avif|avis|heic|heix|hevc|mif1|msf1)/.test(ascii(8, 4))) return true;
  if (ascii(0, 2) === "BM") return true;                                              // BMP
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return true;         // TIFF
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return true;      // ICO
  return false;
}

/**
 * Refuse binary image content that travelled through the model as base64, and say what to use instead.
 * On 2026-09-14 a client session committed a ~67 KB WebP it had written the base64 for itself: the RIFF
 * header was plausible, the file decoded without error, and every pixel was noise. A model cannot encode
 * an image, so anything image-shaped above a few KB has to come from the server-side pipeline instead.
 * Returns the error message, or null when the content is fine to commit.
 */
export function imageContentRefusal(path: string, buf: Buffer): string | null {
  if (buf.length <= MAX_INLINE_IMAGE_BYTES) return null;
  const byExtension = IMAGE_EXTENSIONS.test(path), byHeader = looksLikeImage(buf);
  if (!byExtension && !byHeader) return null;
  return `${path}: refusing ${Math.round(buf.length / 1024)} KB of base64 image content (${byHeader ? "image header detected" : "image file extension"}). Image bytes must not pass through the model - the base64 would be invented, and the file would decode to noise. Use github_commit_image (fetches a URL and converts it on the server) or github_commit_attachment (an image from an email), which both commit the real bytes. Text files, including SVG, are unaffected.`;
}

export const IMAGE_FORMATS = ["webp", "jpeg", "png", "avif"] as const;

/** Image options shared by github_commit_image and github_commit_attachment. */
export const imageOptionShape = {
  width: z.number().int().min(16).max(8000).optional().describe("Target width. With height too, the image is cover-cropped to exactly that size; alone, height follows the aspect ratio. Never upscaled."),
  height: z.number().int().min(16).max(8000).optional(),
  focus: z.enum(["attention", "centre"]).default("attention").describe("Crop anchor: 'attention' keeps the visually busiest region, 'centre' crops symmetrically."),
  format: z.enum(IMAGE_FORMATS).default("webp"),
  quality: z.number().int().min(1).max(100).default(82),
  variants: z.array(z.object({ path: z.string(), width: z.number().int().min(16).max(8000), height: z.number().int().min(16).max(8000).optional() })).max(5).optional().describe("Extra outputs from the same source (same format/quality/focus), e.g. a 1000×562 card version."),
};
export interface ImageOptions { path: string; width?: number; height?: number; focus: "attention" | "centre"; format: (typeof IMAGE_FORMATS)[number]; quality: number; variants?: { path: string; width: number; height?: number }[] }
export interface RenderedImage { path: string; width: number; height: number; bytes: number; base64: string }

/** Decode, orient, resize/crop and encode one source image into the main output plus variants. */
export async function renderImageOutputs(src: Buffer, o: ImageOptions): Promise<{ source: { bytes: number; width: number; height: number; format?: string }; outputs: RenderedImage[]; notes: string[] }> {
  const meta = await sharp(src, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) throw new Error("Not a decodable image.");
  const render = async (path: string, width?: number, height?: number): Promise<RenderedImage> => {
    let img = sharp(src, { failOn: "none" }).rotate();
    if (width || height) img = img.resize({ width, height, fit: width && height ? "cover" : "inside", position: o.focus === "attention" ? sharp.strategy.attention : "centre", withoutEnlargement: true });
    const out = await img.toFormat(o.format, { quality: o.quality }).toBuffer({ resolveWithObject: true });
    return { path: path.replace(/^\//, ""), width: out.info.width, height: out.info.height, bytes: out.info.size, base64: out.data.toString("base64") };
  };
  const outputs = [await render(o.path, o.width, o.height), ...(await Promise.all((o.variants ?? []).map((v) => render(v.path, v.width, v.height))))];
  const notes: string[] = [];
  if (o.width && meta.width < o.width) notes.push(`Source is only ${meta.width}px wide, output was not upscaled.`);
  return { source: { bytes: src.length, width: meta.width, height: meta.height, format: meta.format }, outputs, notes };
}

export function registerGitHubTools(server: McpServer) {
  server.registerTool(
    "github_get_file",
    {
      title: "Read a file from GitHub",
      description:
        "Read a text file from a repository branch. Returns content, sha, size and the file's URL. Files of any size are readable (the blob API is used past GitHub's 1 MB contents limit), but only maxBytes are returned per call: page through a large content bundle with the nextOffset of a truncated reply, or change it in place with github_commit_files edits instead of reading it whole. With find it greps the whole file instead and returns only matching lines, which also works where github_search_code finds nothing. Binary files are refused.",
      inputSchema: {
        repo: repoParam,
        path: z.string().describe("Path inside the repository, e.g. 'src/pages/index.astro'."),
        ref: z.string().optional().describe("Branch, tag or commit; defaults to the default branch."),
        maxBytes: z.number().int().min(1000).max(300_000).default(100_000).describe("Most bytes of file content to return in one call, so a huge file cannot flood the answer. Above ~100 KB the server's own result cap may trim the reply further."),
        offset: z.number().int().min(0).default(0).describe("Byte offset to start at (use the nextOffset of a truncated reply). Never splits a UTF-8 character."),
        find: z.string().min(1).optional().describe("Search the whole file for this text; returns matches (line, byteOffset usable as offset, excerpt) instead of content."),
        regex: z.boolean().default(false).describe("find is a JavaScript regex (^ and $ match per line)."),
        ignoreCase: z.boolean().default(false),
        context: z.number().int().min(0).max(10).default(2).describe("Lines shown around each match."),
        maxMatches: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(async (a) => {
      const path = a.path.replace(/^\//, "");
      const ref = a.ref ?? (await gh<{ default_branch: string }>(`/repos/${a.repo}`)).default_branch;
      const file = await readRepoFile(a.repo, path, ref);
      if (!file) throw new Error(`${path} not found on '${ref}' (or it is a directory: use github_list_dir).`);
      if (file.text === null) throw new Error(`${path} is binary (${file.bytes} bytes); this tool returns text only.`);
      if (a.find !== undefined) {
        const r = findInText(file.text, a.find, { regex: a.regex, ignoreCase: a.ignoreCase, context: a.context, maxMatches: a.maxMatches });
        return {
          repo: a.repo, path, ref, sha: file.sha, size: file.bytes, url: file.url,
          find: a.find, totalMatches: r.totalMatches, truncated: r.truncated || undefined,
          note: !r.totalMatches ? "No match anywhere in the file." : `${r.truncated ? `First ${r.matches.length} of ${r.totalMatches} matches. ` : ""}Read around a match with offset=<its byteOffset>.`,
          matches: r.matches,
        };
      }
      // Leave room for the reply's other fields under the server-wide result cap.
      const { text, start, end, truncated } = sliceUtf8Fitting(file.buf, a.offset, a.maxBytes, MAX_RESULT_CHARS - 4000);
      return {
        repo: a.repo, path, ref, sha: file.sha, size: file.bytes, url: file.url,
        offset: start, returnedBytes: end - start, truncated,
        nextOffset: truncated ? end : undefined,
        note: truncated ? `Only bytes ${start}-${end} of ${file.bytes} are shown. Call again with offset=${end}, or edit the file in place with github_commit_files edits instead of rewriting it whole.` : undefined,
        content: text,
      };
    }),
  );

  server.registerTool(
    "github_list_dir",
    {
      title: "List a directory in GitHub",
      description: "List files and folders at a path in a repository (name, type, size, sha).",
      inputSchema: { repo: repoParam, path: z.string().default(""), ref: z.string().optional() },
    },
    tool(async (a) => {
      const q = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : "";
      const d = await gh<{ name: string; path: string; type: string; size: number; sha: string }[]>(`/repos/${a.repo}/contents/${a.path.replace(/^\//, "")}${q}`);
      if (!Array.isArray(d)) throw new Error(`${a.path} is a file, use github_get_file`);
      return { repo: a.repo, path: a.path || "/", entries: d.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha })) };
    }),
  );

  server.registerTool(
    "github_search_code",
    {
      title: "Search code in a repository",
      description: "Search file contents in one repository (GitHub code search syntax, e.g. 'og:image path:src', 'canonical extension:astro'). Returns matching files with fragments. Indexed for the default branch only, and often empty for private repos: then search a known file with github_get_file find.",
      inputSchema: { repo: repoParam, query: z.string(), limit: z.number().int().min(1).max(50).default(20) },
    },
    tool(async (a) => {
      const d = await gh<{ total_count: number; items: { path: string; html_url: string; text_matches?: { fragment: string }[] }[] }>(`/search/code?q=${encodeURIComponent(`${a.query} repo:${a.repo}`)}&per_page=${a.limit}`, { headers: { Accept: "application/vnd.github.text-match+json" } });
      return { repo: a.repo, total: d.total_count, results: d.items.map((i) => ({ path: i.path, url: i.html_url, fragments: (i.text_matches ?? []).map((m) => m.fragment).slice(0, 3) })) };
    }),
  );

  server.registerTool(
    "github_list_commits",
    {
      title: "Recent commits",
      description: "List recent commits of a branch, optionally only those touching a path.",
      inputSchema: { repo: repoParam, branch: z.string().optional(), path: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    },
    tool(async (a) => {
      const p = new URLSearchParams({ per_page: String(a.limit) });
      if (a.branch) p.set("sha", a.branch);
      if (a.path) p.set("path", a.path);
      const d = await gh<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }[]>(`/repos/${a.repo}/commits?${p}`);
      return { repo: a.repo, commits: d.map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit.author.date, author: c.commit.author.name, message: c.commit.message.split("\n")[0], url: c.html_url })) };
    }),
  );

  server.registerTool(
    "github_build_status",
    {
      title: "Build / deploy status of a commit",
      description:
        "Whether the site actually built and went live after a commit: GitHub Actions check runs, the combined commit status, and deployments with their latest state (how Netlify and Vercel report back). With CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set it also reads the commit's Cloudflare Workers Builds and Pages deployments, which often report nothing to GitHub. Call it after github_commit_files with the sha it returned, before submitting the URL to IndexNow or inspecting it in Search Console. waitSeconds polls until everything finishes instead of returning a pending snapshot. Read-only.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().optional().describe("Commit sha or branch name; defaults to the repository's default branch head."),
        waitSeconds: z.number().int().min(0).max(900).default(0).describe("Keep polling until every check and deployment settles, up to this many seconds. 0 returns immediately."),
        includeLogs: z.boolean().default(false).describe("For failed Actions runs, include the tail of the failing job's log (helps diagnose a broken build)."),
        verifyUrl: z.string().url().optional().describe("Page to fetch once the build settles, to confirm the change is actually live. Needed for hosts that deploy without reporting back to GitHub (Cloudflare without the API token), where checks alone stay empty."),
        expectText: z.string().optional().describe("Text that must appear in verifyUrl's HTML for the deploy to count as live, e.g. a phrase from the page you just changed."),
      },
    },
    tool(async (a, extra) => {
      let sha: string;
      if (a.ref && /^[0-9a-f]{40}$/i.test(a.ref)) sha = a.ref;
      else if (a.ref && /^[0-9a-f]{7,39}$/i.test(a.ref)) {
        // The deployments and Actions-runs endpoints only match a full sha: a short one returns nothing,
        // so a 7-character commit id from github_commit_files would report "no deployments" forever.
        sha = (await gh<{ sha: string }>(`/repos/${a.repo}/commits/${a.ref}`)).sha;
      } else {
        const branch = a.ref ?? (await gh<{ default_branch: string }>(`/repos/${a.repo}`)).default_branch;
        const head = await branchHead(a.repo, branch);
        if (!head) throw new Error(`branch '${branch}' not found in ${a.repo}`);
        sha = head;
      }
      const stop = heartbeat(extra, "waiting for the build to finish");
      try {
        const started = Date.now();
        const deadline = started + a.waitSeconds * 1000;
        const scan: CfScan = { matched: {}, notes: [] };
        let snapshot!: BuildSnapshot;
        let cf!: Awaited<ReturnType<typeof cloudflareLookup>>;
        let state!: Pick<BuildSnapshot, "settled" | "conclusion">;
        for (;;) {
          [snapshot, cf] = await Promise.all([buildSnapshot(a.repo, sha), cloudflareLookup(a.repo, sha, scan)]);
          state = combineBuildState(snapshot, cf?.builds ?? []);
          // A Cloudflare build shows up a few seconds after the push: while a Worker or Pages project is linked to
          // this repo but has no build of the commit yet, keep looking for up to a minute.
          const awaitingCloudflare = !!cf && !cf.builds.length && cf.linked.length > 0 && Date.now() - started < 60_000;
          if ((state.settled && !awaitingCloudflare) || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 10_000));
        }
        let failureLog: string | undefined;
        if (a.includeLogs && snapshot.conclusion === "failure") failureLog = await failingRunLog(a.repo, sha);
        let live: { url: string; status: number; ok: boolean; textFound?: boolean } | undefined;
        if (a.verifyUrl) {
          const until = Date.now() + a.waitSeconds * 1000;
          for (;;) {
            live = await probe(a.verifyUrl, a.expectText);
            if ((live.ok && live.textFound !== false) || Date.now() >= until) break;
            await new Promise((r) => setTimeout(r, 10_000));
          }
        }
        const nothingReported = snapshot.checks.length === 0 && snapshot.deployments.length === 0 && !cf?.builds.length;
        const cfNote = cf && [
          ...(cf.builds.length ? [] : [cf.linked.length ? `No build of this commit yet in ${cf.linked.join(", ")}.` : "No Workers build or Pages deployment found for this commit."]),
          ...cf.notes,
        ].join(" ");
        return {
          repo: a.repo,
          sha: sha.slice(0, 7),
          ...snapshot,
          ...state,
          cloudflare: cf ? { builds: cf.builds, note: cfNote || undefined } : undefined,
          failureLog,
          live,
          note: nothingReported && !a.verifyUrl ? `No checks or deployments are attached to this commit. Either CI has not started yet, or the host deploys without reporting back to GitHub; pass verifyUrl (with expectText) to confirm the change is live by fetching the page instead${cf || currentRequest() ? "" : ", or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to read Cloudflare builds"}.` : undefined,
        };
      } finally {
        stop();
      }
    }),
  );

  server.registerTool(
    "github_commit_files",
    {
      title: "Commit file changes to GitHub",
      description:
        "One atomic commit that adds, updates, edits or deletes several files on a branch (Git Data API); the site's CI/CD then deploys. Per file give exactly one of: content (full replacement; set encoding=base64 for binary), edits (in-place find/replace against the branch's current file, right for large files such as a 300 KB content bundle), or delete. createBranch=true creates the branch from the default branch first. dryRun previews sizes, changed-line counts and whether each edit matches exactly once, without committing.",
      inputSchema: {
        repo: repoParam,
        branch: z.string().describe("Branch to commit to, e.g. 'main'."),
        message: z.string().describe("Commit message in the repository's conventions."),
        files: z.array(z.object({
          path: z.string(),
          content: z.string().optional().describe("Full new file content. UTF-8 text, or base64 when encoding=base64."),
          encoding: z.enum(["utf8", "base64"]).default("utf8").describe("base64 for binary files (images, fonts)."),
          edits: z.array(z.object({ find: z.string().min(1).describe("Exact text to replace; must occur once (include context to disambiguate)."), replace: z.string().describe("Replacement text (may be empty, may span lines)."), all: z.boolean().default(false).describe("Replace every occurrence instead of requiring a single match.") })).min(1).max(50).optional().describe("Applied in order to the file's current content on the branch; the file must exist and be text."),
          delete: z.boolean().default(false),
        })).min(1).max(50),
        createBranch: z.boolean().default(false).describe("If true, create `branch` from the repo's default branch when it does not exist yet."),
        dryRun: z.boolean().default(false).describe("Preview only: report each file's action, sizes and changed-line counts (edits are validated) without committing."),
      },
    },
    tool(async (a) => {
      // Resolve the head once and read every file at that exact commit: commitBlobs builds on it and only
      // fast-forwards, so a commit another session made in between is never overwritten by stale edits.
      const head = await branchHead(a.repo, a.branch);
      const readRef = head ? a.branch : (await gh<{ default_branch: string }>(`/repos/${a.repo}`)).default_branch;
      const baseSha = head ?? (await branchHead(a.repo, readRef));
      if (!baseSha) throw new Error(`Neither '${a.branch}' nor the default branch '${readRef}' has a head commit (empty repository?).`);
      const plan = await Promise.all(a.files.map(async (f) => {
        const path = f.path.replace(/^\//, "");
        const modes = [f.content !== undefined, !!f.edits, f.delete].filter(Boolean).length;
        if (modes !== 1) throw new Error(`${path}: give exactly one of content, edits or delete.`);
        const current = await readRepoFile(a.repo, path, baseSha);
        if (f.delete) return { path, action: current ? "delete" : "delete (file not found)", currentBytes: current?.bytes ?? 0, base64: null as string | null };
        if (f.edits) {
          if (!current) throw new Error(`${path}: not found on '${readRef}'; edits need an existing file (use content to create one).`);
          if (current.text === null) throw new Error(`${path}: binary file; edits work on text only.`);
          const { text, applied } = applyTextEdits(current.text, f.edits, path);
          return { path, action: text === current.text ? "unchanged" : "edited", editsApplied: applied, currentBytes: current.bytes, newBytes: Buffer.byteLength(text), ...diffStats(current.text, text), base64: Buffer.from(text, "utf8").toString("base64") };
        }
        if (f.encoding === "base64") {
          const buf = Buffer.from(f.content ?? "", "base64");
          if (!buf.length || buf.toString("base64").replace(/=+$/, "") !== (f.content ?? "").replace(/\s+/g, "").replace(/=+$/, "")) throw new Error(`${path}: content is not valid base64.`);
          const refusal = imageContentRefusal(path, buf);
          if (refusal) throw new Error(refusal);
          return { path, action: !current ? "create" : current.buf.equals(buf) ? "unchanged" : "update", currentBytes: current?.bytes ?? 0, newBytes: buf.length, binary: true, base64: buf.toString("base64") };
        }
        const next = f.content ?? "";
        const stats = current?.text !== null && current?.text !== undefined ? diffStats(current.text, next) : {};
        return { path, action: !current ? "create" : current.text === next ? "unchanged" : "update", currentBytes: current?.bytes ?? 0, newBytes: Buffer.byteLength(next), ...stats, base64: Buffer.from(next, "utf8").toString("base64") };
      }));
      const report = plan.map(({ base64: _b, ...rest }) => rest);
      if (a.dryRun) return { repo: a.repo, branch: a.branch, comparedAgainst: `${readRef}@${baseSha.slice(0, 7)}`, dryRun: true, files: report, note: "No commit was made." };
      const entries = plan.filter((p) => p.action !== "unchanged").map((p) => ({ path: p.path, base64: p.base64 }));
      if (!entries.length) return { repo: a.repo, branch: a.branch, files: report, note: "Nothing to commit: every file already has that content." };
      const done = await commitBlobs(a.repo, a.branch, a.message, entries, a.createBranch, baseSha);
      return { repo: a.repo, branch: a.branch, ...done, files: report };
    }),
  );

  server.registerTool(
    "github_commit_image",
    {
      title: "Fetch an image, convert it on the server, commit it to GitHub",
      description:
        "Download an image from a public URL, convert it (webp by default), resize or cover-crop it, optionally add variants (e.g. a card thumbnail), and commit every output to a branch in one commit. Runs entirely on the server, nothing on the client machine. Use dryRun to see resulting dimensions and bytes first; then register the file in the site's code with github_commit_files (edits).",
      inputSchema: {
        repo: repoParam,
        branch: z.string().describe("Branch to commit to, e.g. 'main'."),
        message: z.string().describe("Commit message in the repository's conventions."),
        sourceUrl: z.string().url().describe("http(s) URL of the source image: an image already on a site, a CDN, a shared Google Drive link (uc?export=download&id=…), etc."),
        path: z.string().describe("Destination path in the repo, e.g. 'public/assets/img/blog/cover.webp'."),
        ...imageOptionShape,
        createBranch: z.boolean().default(false),
        dryRun: z.boolean().default(false).describe("Fetch and convert, report dimensions and bytes, commit nothing."),
      },
    },
    tool(async (a) => {
      const res = await fetchWithTimeout(a.sourceUrl, {}, 60_000, { maxBytes: 40 * 1024 * 1024 });
      if (!res.ok) throw new Error(`Source image returned HTTP ${res.status}.`);
      const src = Buffer.from(await res.arrayBuffer());
      if (src.length > 40 * 1024 * 1024) throw new Error("Source image is larger than 40 MB.");
      const { source: meta, outputs, notes } = await renderImageOutputs(src, a);
      const report = outputs.map(({ base64: _b, ...rest }) => rest);
      const source = { url: a.sourceUrl, ...meta };
      if (a.dryRun) return { dryRun: true, source, outputs: report, notes, note: "No commit was made." };
      const done = await commitBlobs(a.repo, a.branch, a.message, outputs.map((o) => ({ path: o.path, base64: o.base64 })), a.createBranch);
      return { repo: a.repo, branch: a.branch, ...done, source, outputs: report, notes };
    }),
  );
}
