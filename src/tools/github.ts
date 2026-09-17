/**
 * GitHub tools so static sites (Astro on Cloudflare Pages) can be edited from any MCP client.
 * Token: GITHUB_TOKEN env, else `gh auth token` (GitHub CLI) if available.
 */
import { execFile } from "node:child_process";
import { envValue } from "../env.js";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { heartbeat, tool } from "../util.js";
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

async function gh<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await githubToken();
  if (!token) throw new Error("No GitHub token. Set GITHUB_TOKEN (fine-grained PAT with Contents read/write on the repos) or log in with `gh auth login`.");
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "google-seo-mcp", ...(init.headers ?? {}) } });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(data as { message?: string })?.message ?? text.slice(0, 300)}`);
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

async function branchHead(repo: string, branch: string): Promise<string | null> {
  try { const r = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${branch}`); return r.object.sha; } catch { return null; }
}

/** One commit on `branch` from base64 blobs (sha null = delete). Creates the branch from the default branch when asked. */
export async function commitBlobs(repo: string, branch: string, message: string, entries: { path: string; base64: string | null }[], createBranch: boolean) {
  let headSha = await branchHead(repo, branch);
  if (!headSha) {
    if (!createBranch) throw new Error(`Branch '${branch}' not found. Pass createBranch=true to create it from the default branch.`);
    const info = await gh<{ default_branch: string }>(`/repos/${repo}`);
    const base = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${info.default_branch}`);
    const created = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
    headSha = created.object.sha;
  }
  const headCommit = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${headSha}`);
  const tree = await Promise.all(entries.map(async (e) => {
    if (e.base64 === null) return { path: e.path, mode: "100644", type: "blob", sha: null as string | null };
    const blob = await gh<{ sha: string }>(`/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: e.base64, encoding: "base64" }) });
    return { path: e.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const newTree = await gh<{ sha: string }>(`/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
  const commit = await gh<{ sha: string; html_url: string }>(`/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }) });
  await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
  return { commit: commit.sha.slice(0, 7), url: commit.html_url };
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
        "Read a text file from a repository branch. Returns content, sha, size and the file's URL. Files of any size are readable (the blob API is used past GitHub's 1 MB contents limit), but only maxBytes are returned per call: page through a large content bundle with the nextOffset of a truncated reply, or change it in place with github_commit_files edits instead of reading it whole. Binary files are refused.",
      inputSchema: {
        repo: repoParam,
        path: z.string().describe("Path inside the repository, e.g. 'src/pages/index.astro'."),
        ref: z.string().optional().describe("Branch, tag or commit; defaults to the default branch."),
        maxBytes: z.number().int().min(1000).max(300_000).default(100_000).describe("Most bytes of file content to return in one call, so a huge file cannot flood the answer. Above ~100 KB the server's own result cap may trim the reply further."),
        offset: z.number().int().min(0).default(0).describe("Byte offset to start at (use the nextOffset of a truncated reply). Never splits a UTF-8 character."),
      },
    },
    tool(async (a) => {
      const path = a.path.replace(/^\//, "");
      const ref = a.ref ?? (await gh<{ default_branch: string }>(`/repos/${a.repo}`)).default_branch;
      const file = await readRepoFile(a.repo, path, ref);
      if (!file) throw new Error(`${path} not found on '${ref}' (or it is a directory: use github_list_dir).`);
      if (file.text === null) throw new Error(`${path} is binary (${file.bytes} bytes); this tool returns text only.`);
      const { text, start, end, truncated } = sliceUtf8(file.buf, a.offset, a.maxBytes);
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
      description: "Search file contents in one repository (GitHub code search syntax, e.g. 'og:image path:src', 'canonical extension:astro'). Returns matching files with fragments. Indexed for the default branch only.",
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
        "Whether the site actually built and went live after a commit: GitHub Actions check runs, the combined commit status, and deployments with their latest state (this is how Cloudflare Pages, Netlify and Vercel report back). Call it after github_commit_files with the sha it returned, before submitting the URL to IndexNow or inspecting it in Search Console. waitSeconds polls until everything finishes instead of returning a pending snapshot. Read-only.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().optional().describe("Commit sha or branch name; defaults to the repository's default branch head."),
        waitSeconds: z.number().int().min(0).max(900).default(0).describe("Keep polling until every check and deployment settles, up to this many seconds. 0 returns immediately."),
        includeLogs: z.boolean().default(false).describe("For failed Actions runs, include the tail of the failing job's log (helps diagnose a broken build)."),
        verifyUrl: z.string().url().optional().describe("Page to fetch once the build settles, to confirm the change is actually live. Needed for hosts that deploy without reporting back to GitHub (Cloudflare Pages on this setup reports nothing), where checks alone stay empty."),
        expectText: z.string().optional().describe("Text that must appear in verifyUrl's HTML for the deploy to count as live, e.g. a phrase from the page you just changed."),
      },
    },
    tool(async (a, extra) => {
      let sha: string;
      if (a.ref && /^[0-9a-f]{7,40}$/i.test(a.ref)) sha = a.ref;
      else {
        const branch = a.ref ?? (await gh<{ default_branch: string }>(`/repos/${a.repo}`)).default_branch;
        const head = await branchHead(a.repo, branch);
        if (!head) throw new Error(`branch '${branch}' not found in ${a.repo}`);
        sha = head;
      }
      const stop = heartbeat(extra, "waiting for the build to finish");
      try {
        const deadline = Date.now() + a.waitSeconds * 1000;
        let snapshot!: BuildSnapshot;
        for (;;) {
          snapshot = await buildSnapshot(a.repo, sha);
          if (snapshot.settled || Date.now() >= deadline) break;
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
        const nothingReported = snapshot.checks.length === 0 && snapshot.deployments.length === 0;
        return {
          repo: a.repo,
          sha: sha.slice(0, 7),
          ...snapshot,
          failureLog,
          live,
          note: nothingReported && !a.verifyUrl ? "No checks or deployments are attached to this commit. Either CI has not started yet, or the host deploys without reporting back to GitHub; pass verifyUrl (with expectText) to confirm the change is live by fetching the page instead." : undefined,
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
      const info = await gh<{ default_branch: string }>(`/repos/${a.repo}`);
      const readRef = (await branchHead(a.repo, a.branch)) ? a.branch : info.default_branch;
      const plan = await Promise.all(a.files.map(async (f) => {
        const path = f.path.replace(/^\//, "");
        const modes = [f.content !== undefined, !!f.edits, f.delete].filter(Boolean).length;
        if (modes !== 1) throw new Error(`${path}: give exactly one of content, edits or delete.`);
        const current = await readRepoFile(a.repo, path, readRef);
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
          return { path, action: !current ? "create" : current.buf.equals(buf) ? "unchanged" : "update", currentBytes: current?.bytes ?? 0, newBytes: buf.length, binary: true, base64: buf.toString("base64") };
        }
        const next = f.content ?? "";
        const stats = current?.text !== null && current?.text !== undefined ? diffStats(current.text, next) : {};
        return { path, action: !current ? "create" : current.text === next ? "unchanged" : "update", currentBytes: current?.bytes ?? 0, newBytes: Buffer.byteLength(next), ...stats, base64: Buffer.from(next, "utf8").toString("base64") };
      }));
      const report = plan.map(({ base64: _b, ...rest }) => rest);
      if (a.dryRun) return { repo: a.repo, branch: a.branch, comparedAgainst: readRef, dryRun: true, files: report, note: "No commit was made." };
      const entries = plan.filter((p) => p.action !== "unchanged").map((p) => ({ path: p.path, base64: p.base64 }));
      if (!entries.length) return { repo: a.repo, branch: a.branch, files: report, note: "Nothing to commit: every file already has that content." };
      const done = await commitBlobs(a.repo, a.branch, a.message, entries, a.createBranch);
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
      const res = await fetchWithTimeout(a.sourceUrl, {}, 30_000);
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
