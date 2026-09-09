/**
 * GitHub tools so static sites (Astro on Cloudflare Pages) can be edited from any MCP client.
 * Token: GITHUB_TOKEN env, else `gh auth token` (GitHub CLI) if available.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tool } from "../util.js";

const execFileP = promisify(execFile);
const API = "https://api.github.com";
let cachedToken: string | undefined;

export async function githubToken(): Promise<string | undefined> {
  if (cachedToken) return cachedToken;
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
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
        "Create one commit on a branch that adds/updates/deletes several files atomically (Git Data API), then the branch is updated so the site's CI/CD (e.g. Cloudflare Pages) deploys it. Send the full new content of each file; read the current content first with github_get_file and apply your edit locally. Set createBranch to work on a new branch off the default branch instead of committing directly.",
      inputSchema: {
        repo: repoParam,
        branch: z.string().describe("Branch to commit to, e.g. 'main'."),
        message: z.string().describe("Commit message. Follow the repository's conventions (language, style)."),
        files: z.array(z.object({ path: z.string(), content: z.string().optional().describe("Full new file content (UTF-8). Omit when delete=true."), delete: z.boolean().default(false) })).min(1).max(50),
        createBranch: z.boolean().default(false).describe("If true, create `branch` from the repo's default branch when it does not exist yet."),
      },
    },
    tool(async (a) => {
      const repo = await gh<{ default_branch: string }>(`/repos/${a.repo}`);
      let ref: { object: { sha: string } };
      try { ref = await gh(`/repos/${a.repo}/git/ref/heads/${a.branch}`); } catch (e) {
        if (!a.createBranch) throw new Error(`Branch '${a.branch}' not found (${(e as Error).message}). Pass createBranch=true to create it.`);
        const base = await gh<{ object: { sha: string } }>(`/repos/${a.repo}/git/ref/heads/${repo.default_branch}`);
        ref = await gh(`/repos/${a.repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${a.branch}`, sha: base.object.sha }) });
      }
      const headSha = ref.object.sha;
      const headCommit = await gh<{ tree: { sha: string } }>(`/repos/${a.repo}/git/commits/${headSha}`);
      const tree = await Promise.all(a.files.map(async (f) => {
        const path = f.path.replace(/^\//, "");
        if (f.delete) return { path, mode: "100644", type: "blob", sha: null as string | null };
        if (f.content === undefined) throw new Error(`content required for ${path}`);
        const blob = await gh<{ sha: string }>(`/repos/${a.repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }) });
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      }));
      const newTree = await gh<{ sha: string }>(`/repos/${a.repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
      const commit = await gh<{ sha: string; html_url: string }>(`/repos/${a.repo}/git/commits`, { method: "POST", body: JSON.stringify({ message: a.message, tree: newTree.sha, parents: [headSha] }) });
      await gh(`/repos/${a.repo}/git/refs/heads/${a.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      return { repo: a.repo, branch: a.branch, commit: commit.sha.slice(0, 7), url: commit.html_url, files: a.files.map((f) => ({ path: f.path, action: f.delete ? "deleted" : "written" })) };
    }),
  );
}
