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
import { tool } from "../util.js";
import { fetchWithTimeout } from "./web.js";

const execFileP = promisify(execFile);
const API = "https://api.github.com";
let cachedToken: string | undefined;

export async function githubToken(): Promise<string | undefined> {
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
async function readRepoFile(repo: string, path: string, ref: string): Promise<{ text: string | null; bytes: number; buf: Buffer } | null> {
  let d: { type: string; encoding?: string; content?: string; size: number; sha: string };
  try { d = await gh(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`); } catch { return null; }
  if (d.type !== "file") return null;
  let buf: Buffer;
  if (d.encoding === "base64" && d.content) buf = Buffer.from(d.content, "base64");
  else { const blob = await gh<{ content: string }>(`/repos/${repo}/git/blobs/${d.sha}`); buf = Buffer.from(blob.content, "base64"); }
  return { text: buf.subarray(0, 8000).includes(0) ? null : buf.toString("utf8"), bytes: buf.length, buf };
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
      description: "Read a file (text) from a repository branch. Returns content, sha (needed for edits), size and the branch's latest commit. Files over 1 MB are refused; use github_list_dir to browse.",
      inputSchema: { repo: repoParam, path: z.string(), ref: z.string().optional().describe("Branch, tag or commit; defaults to the default branch.") },
    },
    tool(async (a) => {
      const q = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : "";
      const d = await gh<{ type: string; size: number; sha: string; encoding?: string; content?: string; html_url: string; download_url?: string }>(`/repos/${a.repo}/contents/${a.path.replace(/^\//, "")}${q}`);
      if (d.type !== "file") throw new Error(`${a.path} is a ${d.type}, not a file`);
      if (d.size > 1_000_000) throw new Error(`File is ${d.size} bytes; too large for this tool`);
      const content = d.encoding === "base64" && d.content ? Buffer.from(d.content, "base64").toString("utf8") : "";
      return { repo: a.repo, path: a.path, ref: a.ref ?? "(default)", sha: d.sha, size: d.size, url: d.html_url, content };
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
