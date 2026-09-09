/**
 * WordPress tools: run WP-CLI over SSH on the hosting box.
 *
 * Configure sites with WP_SITES (JSON array) or, for a single site,
 * WP_SSH_HOST / WP_SSH_PORT / WP_SSH_USER / WP_PATH [/ WP_SSH_KEY].
 */
import { spawn } from "node:child_process";
import { envValue } from "../env.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tool } from "../util.js";

export interface WpSite {
  name: string;
  host: string;
  port?: number;
  user: string;
  path: string;
  identityFile?: string;
}

export function loadWpSites(): WpSite[] {
  const json = envValue("WP_SITES");
  if (json) {
    const sites = JSON.parse(json) as WpSite[];
    if (!Array.isArray(sites) || sites.some((s) => !s.name || !s.host || !s.user || !s.path)) {
      throw new Error("WP_SITES must be a JSON array of {name, host, port?, user, path, identityFile?}");
    }
    return sites;
  }
  const { WP_SSH_HOST, WP_SSH_PORT, WP_SSH_USER, WP_PATH, WP_SSH_KEY } = process.env;
  if (WP_SSH_HOST && WP_SSH_USER && WP_PATH) {
    return [{ name: "default", host: WP_SSH_HOST, port: WP_SSH_PORT ? Number(WP_SSH_PORT) : undefined, user: WP_SSH_USER, path: WP_PATH, identityFile: WP_SSH_KEY }];
  }
  return [];
}

/** POSIX single-quote shell escaping. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function ssh(site: WpSite, remoteCommand: string, stdin?: string, timeoutMs = 120_000): Promise<ExecResult> {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15"];
  if (site.port) args.push("-p", String(site.port));
  if (site.identityFile) args.push("-i", site.identityFile);
  args.push(`${site.user}@${site.host}`, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ssh to ${site.host} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function wpCmd(site: WpSite, args: string[]): string {
  return `cd ${shq(site.path)} && wp ${args.map(shq).join(" ")}`;
}

async function wp(site: WpSite, args: string[], stdin?: string): Promise<string> {
  const r = await ssh(site, wpCmd(site, args), stdin);
  if (r.code !== 0) {
    throw new Error(`wp ${args.slice(0, 3).join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r.stdout;
}

async function wpJson<T = unknown>(site: WpSite, args: string[]): Promise<T> {
  const out = await wp(site, [...args, "--format=json"]);
  const trimmed = out.trim();
  return (trimmed ? JSON.parse(trimmed) : null) as T;
}

const YOAST_KEYS = {
  seoTitle: "_yoast_wpseo_title",
  metaDescription: "_yoast_wpseo_metadesc",
  focusKeyword: "_yoast_wpseo_focuskw",
  canonical: "_yoast_wpseo_canonical",
  noindex: "_yoast_wpseo_meta-robots-noindex",
} as const;

async function getYoastMeta(site: WpSite, id: number) {
  const rows = await wpJson<{ meta_key: string; meta_value: string }[]>(site, [
    "post", "meta", "list", String(id), `--keys=${Object.values(YOAST_KEYS).join(",")}`, "--fields=meta_key,meta_value",
  ]);
  const byKey = new Map((rows ?? []).map((r) => [r.meta_key, r.meta_value]));
  const noindexRaw = byKey.get(YOAST_KEYS.noindex);
  return {
    seoTitle: byKey.get(YOAST_KEYS.seoTitle) ?? "",
    metaDescription: byKey.get(YOAST_KEYS.metaDescription) ?? "",
    focusKeyword: byKey.get(YOAST_KEYS.focusKeyword) ?? "",
    canonical: byKey.get(YOAST_KEYS.canonical) ?? "",
    noindex: noindexRaw === "1" ? true : noindexRaw === "2" ? false : null,
  };
}

/** Rebuild the Yoast indexable for one post so front-end title/description reflect meta changes. */
async function rebuildYoastIndexable(site: WpSite, id: number): Promise<string> {
  const php = `$r = YoastSEO()->classes->get(\\Yoast\\WP\\SEO\\Repositories\\Indexable_Repository::class); $b = YoastSEO()->classes->get(\\Yoast\\WP\\SEO\\Builders\\Indexable_Builder::class); $i = $r->find_by_id_and_type(${id}, 'post', false); if ($i) { $b->build($i); echo 'rebuilt'; } else { $b->build_for_id_and_type(${id}, 'post'); echo 'created'; }`;
  try {
    return (await wp(site, ["eval", php])).trim();
  } catch (e) {
    await wp(site, ["yoast", "index", "--skip-confirmation"]);
    return `fallback full index (${(e as Error).message.slice(0, 120)})`;
  }
}


const HELPERS = {
  builder: { local: fileURLToPath(new URL("../../scripts/mfn-builder.php", import.meta.url)), remote: ".google-seo-mcp/mfn-builder.php" },
  wp: { local: fileURLToPath(new URL("../../scripts/wp-helper.php", import.meta.url)), remote: ".google-seo-mcp/wp-helper.php" },
} as const;
const helperUploaded = new Set<string>();

/** Ensure a PHP helper on the host matches the local copy (uploads once per process per site+helper). */
async function ensureHelper(site: WpSite, name: keyof typeof HELPERS): Promise<string> {
  const h = HELPERS[name];
  const key = `${site.name}:${name}`;
  if (helperUploaded.has(key)) return h.remote;
  const local = fs.readFileSync(h.local, "utf8");
  const hash = createHash("sha256").update(local).digest("hex");
  const check = await ssh(site, `sha256sum ${shq(h.remote)} 2>/dev/null | cut -d" " -f1`);
  if (check.stdout.trim() !== hash) {
    const up = await ssh(site, `mkdir -p $(dirname ${shq(h.remote)}) && cat > ${shq(h.remote)}`, local);
    if (up.code !== 0) throw new Error(`failed to upload ${name} helper: ${up.stderr}`);
  }
  helperUploaded.add(key);
  return h.remote;
}

async function runHelper<T = unknown>(site: WpSite, name: keyof typeof HELPERS, action: string, argv: string[], stdin?: string): Promise<T> {
  const remote = await ensureHelper(site, name);
  const r = await ssh(site, `cd ${shq(site.path)} && wp eval-file ~/${remote} ${[action, ...argv].map(shq).join(" ")}`, stdin);
  const text = r.stdout.trim();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (r.code !== 0) {
    const msg = (parsed as { error?: string } | null)?.error ?? (r.stderr || text).split("\nStack trace:")[0].slice(0, 1500);
    throw new Error(`${name} ${action} failed: ${msg}`);
  }
  return parsed as T;
}

/** Cached index of published post URLs per site, used to map Search Console pages to post IDs. */
const postIndexCache = new Map<string, { home: string; byPath: Map<string, { ID: number; title: string }> }>();
async function postIndex(site: WpSite) {
  const cached = postIndexCache.get(site.name);
  if (cached) return cached;
  const data = await runHelper<{ home: string; posts: { ID: number; title: string; url: string; type: string }[] }>(site, "wp", "post_index", [], "{}");
  const byPath = new Map<string, { ID: number; title: string }>();
  for (const p of data.posts) byPath.set(normalizePathLocal(p.url), { ID: p.ID, title: p.title });
  const entry = { home: data.home, byPath };
  postIndexCache.set(site.name, entry);
  return entry;
}
function normalizePathLocal(url: string): string {
  try { return (new URL(url).pathname.replace(/\/+$/, "") || "/").toLowerCase(); } catch { return url; }
}

/** Find the configured WordPress site whose home URL host matches, and return its post index. */
export async function wpPostIndexForHost(host: string): Promise<{ site: string; byPath: Map<string, { ID: number; title: string }> } | null> {
  const wanted = host.replace(/^www\./, "").toLowerCase();
  for (const site of loadWpSites()) {
    try {
      const idx = await postIndex(site);
      const h = new URL(idx.home).hostname.replace(/^www\./, "").toLowerCase();
      if (h === wanted) return { site: site.name, byPath: idx.byPath };
    } catch { /* skip unreachable site */ }
  }
  return null;
}

async function builder<T = unknown>(site: WpSite, action: string, id: number, extra: string[] = [], stdin?: string): Promise<T> {
  return runHelper<T>(site, "builder", action, [String(id), ...extra], stdin);
}

/** Purge page caches for one post (WP Rocket, LiteSpeed, WP Super Cache, W3TC) if the plugin is present. */
async function purgeCache(site: WpSite, id: number): Promise<string> {
  const php = `$done=[]; if(function_exists('rocket_clean_post')){rocket_clean_post(${id}); $done[]='wp-rocket';} if(function_exists('wp_cache_post_change')){wp_cache_post_change(${id}); $done[]='wp-super-cache';} if(function_exists('w3tc_flush_post')){w3tc_flush_post(${id}); $done[]='w3tc';} if(function_exists('do_action')){do_action('litespeed_purge_post', ${id});} echo implode(',', $done) ?: 'none';`;
  try { return (await wp(site, ["eval", php])).trim(); } catch (e) { return `purge failed: ${(e as Error).message.slice(0, 100)}`; }
}

const POST_FIELDS = "ID,post_title,post_name,post_status,post_type,post_date,post_modified,url";

export function registerWordPressTools(server: McpServer, sites: WpSite[]) {
  const siteParam = z
    .string()
    .optional()
    .describe(`WordPress site name from configuration. Defaults to '${sites[0].name}'. Configured: ${sites.map((s) => s.name).join(", ")}.`);
  const pick = (name?: string): WpSite => {
    const s = sites.find((x) => x.name === (name ?? sites[0].name));
    if (!s) throw new Error(`Unknown WordPress site '${name}'. Configured: ${sites.map((x) => x.name).join(", ")}`);
    return s;
  };
  const postId = z.number().int().positive().describe("Post/page ID (from wp_list_posts).");

  server.registerTool(
    "wp_site_info",
    {
      title: "WordPress site info",
      description: "Show WordPress core version, site URL, permalink structure, active plugins and Yoast title settings for a configured site.",
      inputSchema: { site: siteParam },
    },
    tool(async ({ site }) => {
      const s = pick(site);
      const raw = await wp(s, ["eval", `echo json_encode(['version'=>get_bloginfo('version'),'siteurl'=>get_option('siteurl'),'home'=>get_option('home'),'blogname'=>get_option('blogname'),'blogdescription'=>get_option('blogdescription'),'permalink'=>get_option('permalink_structure'),'language'=>get_locale(),'timezone'=>wp_timezone_string(),'yoast_separator'=>get_option('wpseo_titles')['separator'] ?? null,'post_counts'=>['post'=>(array)wp_count_posts('post'),'page'=>(array)wp_count_posts('page')]]);`]);
      const plugins = await wpJson<{ name: string; version: string }[]>(s, ["plugin", "list", "--status=active", "--fields=name,version"]);
      return { site: s.name, host: `${s.user}@${s.host}:${s.port ?? 22}`, path: s.path, ...JSON.parse(raw), activePlugins: plugins };
    }),
  );

  server.registerTool(
    "wp_list_posts",
    {
      title: "List WordPress posts/pages",
      description: "List posts or pages with ID, title, slug, status, dates and URL. Supports search and pagination. Use it to find the post ID for a URL you saw in Search Console.",
      inputSchema: {
        site: siteParam,
        postType: z.enum(["post", "page", "any"]).default("post"),
        status: z.enum(["publish", "draft", "pending", "private", "future", "any"]).default("publish"),
        search: z.string().optional().describe("Free-text search on title/content."),
        slug: z.string().optional().describe("Exact slug (post_name) match, e.g. 'seville-to-ronda-day-trip'."),
        perPage: z.number().int().min(1).max(200).default(50),
        page: z.number().int().min(1).default(1),
        orderBy: z.enum(["date", "modified", "title", "ID"]).default("date"),
        order: z.enum(["ASC", "DESC"]).default("DESC"),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const args = ["post", "list", `--post_type=${a.postType}`, `--post_status=${a.status}`, `--posts_per_page=${a.perPage}`, `--paged=${a.page}`, `--orderby=${a.orderBy}`, `--order=${a.order}`, `--fields=${POST_FIELDS}`];
      if (a.search) args.push(`--s=${a.search}`);
      if (a.slug) args.push(`--name=${a.slug}`);
      const rows = await wpJson<Record<string, unknown>[]>(s, args);
      return { site: s.name, page: a.page, perPage: a.perPage, count: rows?.length ?? 0, posts: rows ?? [] };
    }),
  );

  server.registerTool(
    "wp_get_post",
    {
      title: "Get a WordPress post",
      description: "Fetch one post/page: title, slug, status, excerpt, full content (HTML/blocks), URL and Yoast SEO meta (SEO title, meta description, focus keyword, canonical, noindex).",
      inputSchema: {
        site: siteParam,
        id: postId,
        includeContent: z.boolean().default(true).describe("Set false to skip post_content for a lighter response."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const post = await wpJson<Record<string, unknown>>(s, ["post", "get", String(a.id)]);
      const [url, yoast] = await Promise.all([wp(s, ["post", "url", String(a.id)]), getYoastMeta(s, a.id)]);
      const { post_content, post_content_filtered, ...rest } = post;
      return {
        site: s.name,
        url: url.trim(),
        ...rest,
        post_content: a.includeContent ? post_content : `(omitted, ${String(post_content ?? "").length} chars)`,
        yoast,
      };
    }),
  );

  server.registerTool(
    "wp_update_post",
    {
      title: "Update a WordPress post",
      description:
        "Update title, slug, excerpt, content and/or status of a post or page. Only the fields you pass are changed. Changing the slug changes the URL: WordPress keeps a redirect from the old slug automatically (Yoast Premium also records it), but check internal links afterwards.",
      inputSchema: {
        site: siteParam,
        id: postId,
        title: z.string().optional(),
        slug: z.string().optional().describe("New post_name (URL slug), lowercase-hyphenated."),
        excerpt: z.string().optional(),
        content: z.string().optional().describe("Full replacement post_content (HTML or block markup). Fetch the current content with wp_get_post first and edit it; partial updates are not supported."),
        status: z.enum(["publish", "draft", "pending", "private"]).optional(),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const cur = await wpJson<Record<string, unknown>>(s, ["post", "get", String(a.id), "--fields=post_title,post_name,post_excerpt,post_status"]);
        const changes = [["title", "post_title", a.title], ["slug", "post_name", a.slug], ["excerpt", "post_excerpt", a.excerpt], ["status", "post_status", a.status]].filter(([, , v]) => v !== undefined).map(([field, key, to]) => ({ field, from: cur[key as string], to }));
        if (a.content !== undefined) changes.push({ field: "content", from: `(current content, use wp_get_post to view)`, to: `${a.content.length} chars` });
        return { site: s.name, id: a.id, dryRun: true, changes };
      }
      const args = ["post", "update", String(a.id)];
      if (a.content !== undefined) args.push("-");
      if (a.title !== undefined) args.push(`--post_title=${a.title}`);
      if (a.slug !== undefined) args.push(`--post_name=${a.slug}`);
      if (a.excerpt !== undefined) args.push(`--post_excerpt=${a.excerpt}`);
      if (a.status !== undefined) args.push(`--post_status=${a.status}`);
      if (args.length === 3) throw new Error("Nothing to update: pass at least one of title, slug, excerpt, content, status.");
      const out = await wp(s, args, a.content);
      const cachePurged = await purgeCache(s, a.id);
      const rows = await wpJson<Record<string, unknown>[]>(s, ["post", "list", `--post__in=${a.id}`, "--post_type=any", "--post_status=any", `--fields=${POST_FIELDS}`]);
      return { site: s.name, result: out.trim(), cachePurged, post: rows?.[0] ?? null };
    }),
  );

  server.registerTool(
    "wp_update_seo",
    {
      title: "Update Yoast SEO meta",
      description:
        "Set Yoast SEO fields on a post/page: SEO title (<title> tag, supports Yoast variables like %%sep%% %%sitename%%), meta description, focus keyword, canonical URL, noindex. Only passed fields change; pass an empty string to reset a field to Yoast's default. Rebuilds the Yoast indexable so the change is live immediately.",
      inputSchema: {
        site: siteParam,
        id: postId,
        seoTitle: z.string().optional().describe("Aim for <= 60 characters."),
        metaDescription: z.string().optional().describe("Aim for 120-155 characters."),
        focusKeyword: z.string().optional(),
        canonical: z.string().optional().describe("Absolute URL, or empty string to clear."),
        noindex: z.boolean().nullable().optional().describe("true = noindex, false = force index, null = Yoast default."),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const cur = await getYoastMeta(s, a.id);
        const changes = (["seoTitle", "metaDescription", "focusKeyword", "canonical", "noindex"] as const).filter((k) => a[k] !== undefined).map((k) => ({ field: k, from: cur[k], to: a[k] }));
        return { site: s.name, id: a.id, dryRun: true, changes };
      }
      const updates: [string, string][] = [];
      if (a.seoTitle !== undefined) updates.push([YOAST_KEYS.seoTitle, a.seoTitle]);
      if (a.metaDescription !== undefined) updates.push([YOAST_KEYS.metaDescription, a.metaDescription]);
      if (a.focusKeyword !== undefined) updates.push([YOAST_KEYS.focusKeyword, a.focusKeyword]);
      if (a.canonical !== undefined) updates.push([YOAST_KEYS.canonical, a.canonical]);
      if (a.noindex !== undefined) updates.push([YOAST_KEYS.noindex, a.noindex === true ? "1" : a.noindex === false ? "2" : ""]);
      if (!updates.length) throw new Error("Nothing to update: pass at least one SEO field.");
      const remote = updates
        .map(([k, v]) => (v === "" ? `(wp post meta delete ${a.id} ${shq(k)} || true)` : `wp post meta update ${a.id} ${shq(k)} ${shq(v)}`))
        .join(" && ");
      const r = await ssh(s, `cd ${shq(s.path)} && ${remote}`);
      if (r.code !== 0) throw new Error(`meta update failed: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
      const indexable = await rebuildYoastIndexable(s, a.id);
      const [yoast, cachePurged] = await Promise.all([getYoastMeta(s, a.id), purgeCache(s, a.id)]);
      return { site: s.name, id: a.id, updated: updates.map(([k]) => k), indexable, cachePurged, yoast };
    }),
  );

  server.registerTool(
    "wp_builder_list_items",
    {
      title: "List page-builder items (BeTheme/Muffin Builder)",
      description:
        "For posts built with BeTheme's Muffin Builder (post_content is empty and the text lives in builder items), list every builder item with its uid, type (heading, column, image...) and text fields (title, content, header_tag, src, alt...). Use the uid + field with wp_builder_update to edit copy.",
      inputSchema: { site: siteParam, id: postId },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await builder<object>(pick(a.site), "list", a.id)) })),
  );

  server.registerTool(
    "wp_builder_update",
    {
      title: "Update page-builder item fields",
      description:
        "Edit text fields of Muffin Builder items (e.g. a heading's 'title' or 'header_tag', a column's HTML 'content', an image's 'alt'). Applies all edits atomically, regenerates the builder's SEO copy, bumps post_modified and rebuilds the Yoast indexable. Fetch current values with wp_builder_list_items first and send the full replacement value.",
      inputSchema: {
        site: siteParam,
        id: postId,
        edits: z.array(z.object({ uid: z.string(), field: z.string(), value: z.string() })).min(1),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const list = await builder<{ items: { uid: string; type: string; fields: Record<string, string> }[] }>(s, "list", a.id);
        const changes = a.edits.map((e) => { const it = list.items.find((x) => x.uid === e.uid); return { uid: e.uid, type: it?.type ?? "(not found)", field: e.field, from: it?.fields?.[e.field] ?? null, to: e.value }; });
        return { site: s.name, id: a.id, dryRun: true, changes, missing: changes.filter((c) => c.type === "(not found)").map((c) => c.uid) };
      }
      const result = await builder<object>(s, "set", a.id, [], JSON.stringify(a.edits));
      const [yoastIndex, cachePurged] = await Promise.all([rebuildYoastIndexable(s, a.id), purgeCache(s, a.id)]);
      return { site: s.name, ...result, yoastIndex, cachePurged };
    }),
  );

  server.registerTool(
    "wp_builder_check",
    {
      title: "Verify builder round-trip",
      description: "Read-only check that a post's Muffin Builder data can be decoded and re-encoded losslessly before editing it.",
      inputSchema: { site: siteParam, id: postId },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await builder<object>(pick(a.site), "check", a.id)) })),
  );

  server.registerTool(
    "wp_seo_status",
    {
      title: "Yoast SEO status of all posts",
      description: "List every published post/page with its Yoast SEO title, meta description, focus keyword, noindex flag, word count and which fields are missing. Use missingOnly to get the to-do list for wp_bulk_update_seo.",
      inputSchema: {
        site: siteParam,
        postTypes: z.array(z.string()).default(["post", "page"]),
        missingOnly: z.boolean().default(false),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "seo_status", [], JSON.stringify({ postTypes: a.postTypes, missingOnly: a.missingOnly }))) })),
  );

  server.registerTool(
    "wp_bulk_update_seo",
    {
      title: "Bulk update Yoast SEO fields",
      description: "Set SEO title / meta description / focus keyword / canonical / noindex on many posts in one call. Only passed fields change; empty string clears a field. Rebuilds Yoast indexables and purges caches for each post.",
      inputSchema: {
        site: siteParam,
        items: z.array(z.object({
          id: z.number().int().positive(),
          seoTitle: z.string().optional(),
          metaDescription: z.string().optional(),
          focusKeyword: z.string().optional(),
          canonical: z.string().optional(),
          noindex: z.boolean().nullable().optional(),
        })).min(1).max(100),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "bulk_seo", [], JSON.stringify({ items: a.items, dryRun: a.dryRun }))) })),
  );

  server.registerTool(
    "wp_list_media",
    {
      title: "List media images",
      description: "List images in the media library with alt text, caption, dimensions, file size and the post they are attached to. Use missingAltOnly to find images without alt text.",
      inputSchema: {
        site: siteParam,
        missingAltOnly: z.boolean().default(false),
        search: z.string().optional(),
        attachedTo: z.number().int().positive().optional().describe("Only images uploaded to this post ID."),
        perPage: z.number().int().min(1).max(200).default(50),
        page: z.number().int().min(1).default(1),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "media_list", [], JSON.stringify(a))) })),
  );

  server.registerTool(
    "wp_update_media",
    {
      title: "Update media alt/title/caption",
      description: "Set alt text, title, caption and/or description on one or more media items.",
      inputSchema: {
        site: siteParam,
        items: z.array(z.object({ id: z.number().int().positive(), alt: z.string().optional(), title: z.string().optional(), caption: z.string().optional(), description: z.string().optional() })).min(1).max(100),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const rows = await wpJson<{ ID: number; post_title: string; post_excerpt: string; post_content: string }[]>(s, ["post", "list", "--post_type=attachment", "--post_status=inherit", `--post__in=${a.items.map((i) => i.id).join(",")}`, "--fields=ID,post_title,post_excerpt,post_content"]);
        const alts = await Promise.all(a.items.map((i) => wp(s, ["post", "meta", "get", String(i.id), "_wp_attachment_image_alt"]).then((v) => v.trim()).catch(() => "")));
        return { site: s.name, dryRun: true, changes: a.items.map((i, idx) => { const cur = rows.find((r) => r.ID === i.id); return { id: i.id, found: Boolean(cur), alt: i.alt !== undefined ? { from: alts[idx], to: i.alt } : undefined, title: i.title !== undefined ? { from: cur?.post_title, to: i.title } : undefined, caption: i.caption !== undefined ? { from: cur?.post_excerpt, to: i.caption } : undefined, description: i.description !== undefined ? { from: cur?.post_content, to: i.description } : undefined }; }) };
      }
      return { site: s.name, ...(await runHelper<object>(s, "wp", "media_update", [], JSON.stringify({ items: a.items }))) };
    }),
  );

  server.registerTool(
    "wp_list_terms",
    {
      title: "List categories/tags",
      description: "List terms of a taxonomy (category, post_tag or custom) with post count, description, URL and Yoast term SEO title/description/noindex.",
      inputSchema: { site: siteParam, taxonomy: z.string().default("category"), search: z.string().optional() },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "terms_list", [], JSON.stringify(a))) })),
  );

  server.registerTool(
    "wp_update_term",
    {
      title: "Update a category/tag",
      description: "Update name, slug, description and Yoast SEO title/meta description/noindex of a term. Rebuilds the Yoast term indexable.",
      inputSchema: {
        site: siteParam,
        taxonomy: z.string().default("category"),
        id: z.number().int().positive(),
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        seoTitle: z.string().optional(),
        metaDescription: z.string().optional(),
        noindex: z.boolean().nullable().optional(),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const list = await runHelper<{ terms: Record<string, unknown>[] }>(s, "wp", "terms_list", [], JSON.stringify({ taxonomy: a.taxonomy }));
        const cur = list.terms.find((t) => t.id === a.id);
        if (!cur) throw new Error(`term ${a.id} not found in ${a.taxonomy}`);
        const changes = (["name", "slug", "description", "seoTitle", "metaDescription", "noindex"] as const).filter((k) => a[k] !== undefined).map((k) => ({ field: k, from: cur[k], to: a[k] }));
        return { site: s.name, taxonomy: a.taxonomy, id: a.id, dryRun: true, changes };
      }
      const { dryRun, ...rest } = a;
      return { site: s.name, ...(await runHelper<object>(s, "wp", "term_update", [], JSON.stringify(rest))) };
    }),
  );

  server.registerTool(
    "wp_internal_link_suggestions",
    {
      title: "Internal link suggestions",
      description:
        "Given a target post and its keywords (take them from gsc_search_analytics / gsc_opportunities for that page), find other published posts whose text mentions those keywords, with a snippet around the match and whether they already link to the target. Best candidates for adding an internal link come first.",
      inputSchema: {
        site: siteParam,
        targetId: postId.describe("Post ID that should receive more internal links."),
        keywords: z.array(z.string()).min(1).max(20),
        postTypes: z.array(z.string()).default(["post", "page"]),
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "internal_links", [], JSON.stringify(a))) })),
  );

  server.registerTool(
    "wp_list_redirects",
    {
      title: "List Yoast redirects",
      description: "List redirects managed by Yoast SEO Premium (plain and regex), optionally filtered by a search string.",
      inputSchema: { site: siteParam, search: z.string().optional() },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "redirects_list", [], JSON.stringify(a))) })),
  );

  server.registerTool(
    "wp_add_redirect",
    {
      title: "Add a Yoast redirect",
      description: "Create a redirect in Yoast SEO Premium. origin is a path relative to the site root (e.g. 'old-post/'), target a path or absolute URL. Fails if a redirect for that origin already exists.",
      inputSchema: {
        site: siteParam,
        origin: z.string(),
        target: z.string().default("").describe("Empty is allowed only for 410/451."),
        type: z.enum(["301", "302", "307", "410", "451"]).default("301"),
        format: z.enum(["plain", "regex"]).default("plain"),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const cur = await runHelper<{ redirects: { origin: string; target: string; type: number; format: string }[] }>(s, "wp", "redirects_list", [], JSON.stringify({ search: a.origin.replace(/^\/|\/$/g, "") }));
        const clash = cur.redirects.find((r) => r.origin.replace(/^\/|\/$/g, "") === a.origin.replace(/^\/|\/$/g, ""));
        return { site: s.name, dryRun: true, wouldCreate: { origin: a.origin, target: a.target, type: Number(a.type), format: a.format }, conflict: clash ?? null };
      }
      const { dryRun, ...rest } = a;
      return { site: s.name, ...(await runHelper<object>(s, "wp", "redirect_add", [], JSON.stringify({ ...rest, type: Number(a.type) }))) };
    }),
  );

  server.registerTool(
    "wp_delete_redirect",
    {
      title: "Delete a Yoast redirect",
      description: "Remove a Yoast SEO Premium redirect by its origin.",
      inputSchema: { site: siteParam, origin: z.string(), format: z.enum(["plain", "regex"]).default("plain"), dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."), },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const cur = await runHelper<{ redirects: { origin: string; target: string; type: number; format: string }[] }>(s, "wp", "redirects_list", [], JSON.stringify({ search: a.origin.replace(/^\/|\/$/g, "") }));
        const hit = cur.redirects.find((r) => r.origin.replace(/^\/|\/$/g, "") === a.origin.replace(/^\/|\/$/g, "") && r.format === a.format);
        return { site: s.name, dryRun: true, wouldDelete: hit ?? null, found: Boolean(hit) };
      }
      const { dryRun, ...rest } = a;
      return { site: s.name, ...(await runHelper<object>(s, "wp", "redirect_delete", [], JSON.stringify(rest))) };
    }),
  );

  server.registerTool(
    "wp_set_schema",
    {
      title: "Publish JSON-LD on a WordPress post",
      description:
        "Store JSON-LD (object or array, e.g. FAQPage from schema_generate) on a post; a tiny mu-plugin (installed automatically on first use) prints it in <head> on that page. Pass null to remove. Validate with schema_validate first. Works alongside Yoast's own graph.",
      inputSchema: { site: siteParam, id: postId, jsonld: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())), z.null()]), dryRun: z.boolean().default(false).describe("Preview only: return current values and the intended changes without writing."), },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) { const cur = await runHelper<{ schema: unknown; muPluginInstalled: boolean }>(s, "wp", "schema_get", [], JSON.stringify({ id: a.id })); return { site: s.name, id: a.id, dryRun: true, from: cur.schema, to: a.jsonld, muPluginInstalled: cur.muPluginInstalled }; }
      return { site: s.name, ...(await runHelper<object>(s, "wp", "schema_set", [], JSON.stringify({ id: a.id, jsonld: a.jsonld }))) };
    }),
  );

  server.registerTool(
    "wp_get_schema",
    {
      title: "Read JSON-LD stored on a post",
      description: "Return the JSON-LD previously published with wp_set_schema (if any) and whether the mu-plugin is installed.",
      inputSchema: { site: siteParam, id: postId },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "schema_get", [], JSON.stringify({ id: a.id }))) })),
  );

  server.registerTool(
    "wp_run",
    {
      title: "Run a WP-CLI command",
      description:
        "Run an arbitrary WP-CLI command on the site (without the leading 'wp'). Use for anything the other tools do not cover: 'cache flush', 'option get blogname', 'plugin list', 'yoast index --reindex --skip-confirmation', 'search-replace ...'. Destructive commands run as-is, so be deliberate.",
      inputSchema: {
        site: siteParam,
        args: z.array(z.string()).min(1).describe("Command tokens, e.g. ['plugin','list','--status=active','--format=json']."),
        stdin: z.string().optional().describe("Optional data piped to the command's STDIN."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const r = await ssh(s, wpCmd(s, a.args), a.stdin);
      return { site: s.name, exitCode: r.code, stdout: r.stdout.slice(0, 20000), stderr: r.stderr.slice(0, 4000) };
    }),
  );
}
