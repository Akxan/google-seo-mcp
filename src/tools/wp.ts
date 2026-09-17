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
import { heartbeat, tool } from "../util.js";
import { imageOptionShape, renderImageOutputs, type ImageOptions } from "./github.js";
import { fetchWithTimeout } from "./web.js";

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

async function wp(site: WpSite, args: string[], stdin?: string, timeoutMs?: number): Promise<string> {
  const r = await ssh(site, wpCmd(site, args), stdin, timeoutMs);
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

/** Run a PHP snippet that echoes JSON through `wp eval`; an {error} payload or a non-zero exit throws. */
async function evalJson<T = unknown>(site: WpSite, php: string, timeoutMs?: number): Promise<T> {
  const r = await ssh(site, `cd ${shq(site.path)} && wp eval ${shq(php)}`, undefined, timeoutMs);
  const text = r.stdout.trim();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const err = (parsed as { error?: string } | null)?.error;
  if (r.code !== 0 || err) throw new Error(`wp eval failed: ${err ?? (r.stderr || text).trim().slice(0, 800)}`);
  return parsed as T;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' (site timezone) to the MySQL datetime WordPress stores. */
function normalizeWpDate(input: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid date "${input}": use 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' in the site's timezone.`);
  return `${m[1]} ${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}`;
}

const YOAST_KEYS = {
  seoTitle: "_yoast_wpseo_title",
  metaDescription: "_yoast_wpseo_metadesc",
  focusKeyword: "_yoast_wpseo_focuskw",
  canonical: "_yoast_wpseo_canonical",
  noindex: "_yoast_wpseo_meta-robots-noindex",
  ogTitle: "_yoast_wpseo_opengraph-title",
  ogDescription: "_yoast_wpseo_opengraph-description",
  ogImage: "_yoast_wpseo_opengraph-image",
  twitterTitle: "_yoast_wpseo_twitter-title",
  twitterDescription: "_yoast_wpseo_twitter-description",
  twitterImage: "_yoast_wpseo_twitter-image",
  schemaPageType: "_yoast_wpseo_schema_page_type",
  schemaArticleType: "_yoast_wpseo_schema_article_type",
  cornerstone: "_yoast_wpseo_is_cornerstone",
  primaryCategory: "_yoast_wpseo_primary_category",
  robotsAdvanced: "_yoast_wpseo_meta-robots-adv",
  breadcrumbTitle: "_yoast_wpseo_bctitle",
} as const;

/** Yoast's advanced robots directives, stored comma-separated in one meta value. */
export const ROBOTS_ADVANCED = ["noimageindex", "noarchive", "nosnippet", "none"] as const;
const THUMBNAIL_KEY = "_thumbnail_id";

/** Yoast meta plus the featured image id of one post, in a single WP-CLI call. */
async function getPostMeta(site: WpSite, id: number) {
  const rows = await wpJson<{ meta_key: string; meta_value: string }[]>(site, [
    "post", "meta", "list", String(id), `--keys=${[...Object.values(YOAST_KEYS), THUMBNAIL_KEY].join(",")}`, "--fields=meta_key,meta_value",
  ]);
  const byKey = new Map((rows ?? []).map((r) => [r.meta_key, r.meta_value]));
  const num = (key: string) => { const n = Number(byKey.get(key)); return Number.isFinite(n) && n > 0 ? n : null; };
  return { yoast: { ...yoastFrom(byKey), primaryCategory: num(YOAST_KEYS.primaryCategory), robotsAdvanced: (byKey.get(YOAST_KEYS.robotsAdvanced) ?? "").split(",").map((s) => s.trim()).filter(Boolean), breadcrumbTitle: byKey.get(YOAST_KEYS.breadcrumbTitle) ?? "" }, featuredMediaId: num(THUMBNAIL_KEY) };
}

function yoastFrom(byKey: Map<string, string>) {
  const noindexRaw = byKey.get(YOAST_KEYS.noindex);
  return {
    seoTitle: byKey.get(YOAST_KEYS.seoTitle) ?? "",
    metaDescription: byKey.get(YOAST_KEYS.metaDescription) ?? "",
    focusKeyword: byKey.get(YOAST_KEYS.focusKeyword) ?? "",
    canonical: byKey.get(YOAST_KEYS.canonical) ?? "",
    noindex: noindexRaw === "1" ? true : noindexRaw === "2" ? false : null,
    ogTitle: byKey.get(YOAST_KEYS.ogTitle) ?? "",
    ogDescription: byKey.get(YOAST_KEYS.ogDescription) ?? "",
    ogImage: byKey.get(YOAST_KEYS.ogImage) ?? "",
    twitterTitle: byKey.get(YOAST_KEYS.twitterTitle) ?? "",
    twitterDescription: byKey.get(YOAST_KEYS.twitterDescription) ?? "",
    twitterImage: byKey.get(YOAST_KEYS.twitterImage) ?? "",
    schemaPageType: byKey.get(YOAST_KEYS.schemaPageType) ?? "",
    schemaArticleType: byKey.get(YOAST_KEYS.schemaArticleType) ?? "",
    cornerstone: byKey.get(YOAST_KEYS.cornerstone) === "1",
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
    .describe(`Configured site: ${sites.map((s) => s.name).join(", ")}. Defaults to the first.`);
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
      description: "Show WordPress core version, site URL, permalink structure, active plugins and Yoast title settings for a configured site. With checkUpdates it also asks WordPress.org what is out of date. For the site-wide Yoast configuration (title templates, archive noindex, breadcrumbs, knowledge-graph identity) use wp_get_seo_settings.",
      inputSchema: {
        site: siteParam,
        checkUpdates: z.boolean().default(false).describe("Also report available core, plugin and theme updates (a few seconds slower, calls WordPress.org). An outdated Yoast quietly stops emitting parts of its schema graph, so check this when structured data looks wrong."),
      },
    },
    tool(async ({ site, checkUpdates }, extra) => {
      const s = pick(site);
      const raw = await wp(s, ["eval", `echo json_encode(['version'=>get_bloginfo('version'),'siteurl'=>get_option('siteurl'),'home'=>get_option('home'),'blogname'=>get_option('blogname'),'blogdescription'=>get_option('blogdescription'),'permalink'=>get_option('permalink_structure'),'language'=>get_locale(),'timezone'=>wp_timezone_string(),'yoast_separator'=>get_option('wpseo_titles')['separator'] ?? null,'post_counts'=>['post'=>(array)wp_count_posts('post'),'page'=>(array)wp_count_posts('page')]]);`]);
      const plugins = await wpJson<{ name: string; version: string }[]>(s, ["plugin", "list", "--status=active", "--fields=name,version"]);
      let updates: Record<string, unknown> | undefined;
      if (checkUpdates) {
        const stop = heartbeat(extra, "asking WordPress.org for available updates");
        try {
          // These commands print a "Success:" line instead of JSON when nothing is available.
          const lenient = async (args: string[]) => {
            try { const out = (await wp(s, [...args, "--format=json"], undefined, 180_000)).trim(); return out.startsWith("[") ? (JSON.parse(out) as unknown[]) : []; } catch (e) { return { error: (e as Error).message.slice(0, 200) }; }
          };
          const [core, plug, themes] = await Promise.all([
            lenient(["core", "check-update"]),
            lenient(["plugin", "list", "--update=available", "--fields=name,version,update_version"]),
            lenient(["theme", "list", "--update=available", "--fields=name,version,update_version"]),
          ]);
          updates = { core, plugins: plug, themes, yoastOutdated: Array.isArray(plug) && plug.some((p) => /^(wordpress-seo|wordpress-seo-premium)$/.test(String((p as { name?: string }).name))) };
        } finally { stop(); }
      }
      return { site: s.name, host: `${s.user}@${s.host}:${s.port ?? 22}`, path: s.path, ...JSON.parse(raw), activePlugins: plugins, updates };
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
      const [url, meta] = await Promise.all([wp(s, ["post", "url", String(a.id)]), getPostMeta(s, a.id)]);
      const { post_content, post_content_filtered, ...rest } = post;
      return {
        site: s.name,
        url: url.trim(),
        ...rest,
        post_content: a.includeContent ? post_content : `(omitted, ${String(post_content ?? "").length} chars)`,
        featuredMediaId: meta.featuredMediaId,
        yoast: meta.yoast,
      };
    }),
  );

  server.registerTool(
    "wp_update_post",
    {
      title: "Update a WordPress post",
      description:
        "Update title, slug, excerpt, content, status, publish date and/or featured image of a post or page. Only the fields you pass are changed. Changing the slug changes the URL: WordPress keeps a redirect from the old slug automatically (Yoast Premium also records it), but check internal links afterwards. To schedule a post, pass status='future' together with a date in the future (WP-Cron publishes it); to move a scheduled post, pass the new date. featuredMediaId sets the thumbnail Yoast falls back to for social sharing.",
      inputSchema: {
        site: siteParam,
        id: postId,
        title: z.string().optional().describe("New post title (the H1 and Yoast's %%title%%)."),
        slug: z.string().optional().describe("New post_name (URL slug), lowercase-hyphenated."),
        excerpt: z.string().optional().describe("New excerpt; themes and archives use it as the summary."),
        content: z.string().optional().describe("Full replacement post_content (HTML or block markup). Fetch the current content with wp_get_post first and edit it; partial updates are not supported."),
        status: z.enum(["publish", "draft", "pending", "private", "future"]).optional().describe("'future' = scheduled; it needs a date in the future, here or already on the post."),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).optional().describe("Publish date in the site's timezone: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]'. Schedules the post with status='future', or changes the published date of a live post (which changes the URL when the permalink structure contains the date)."),
        featuredMediaId: z.number().int().min(0).nullable().optional().describe("Attachment ID to use as the featured image (from wp_list_media or wp_upload_media); 0 or null removes it."),
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const date = a.date !== undefined ? normalizeWpDate(a.date) : undefined;
      if (a.dryRun) {
        const cur = await wpJson<Record<string, unknown>>(s, ["post", "get", String(a.id), "--fields=post_title,post_name,post_excerpt,post_status,post_date"]);
        const changes = [["title", "post_title", a.title], ["slug", "post_name", a.slug], ["excerpt", "post_excerpt", a.excerpt], ["status", "post_status", a.status], ["date", "post_date", date]].filter(([, , v]) => v !== undefined).map(([field, key, to]) => ({ field, from: cur[key as string], to }));
        if (a.content !== undefined) changes.push({ field: "content", from: `(current content, use wp_get_post to view)`, to: `${a.content.length} chars` });
        let featured: unknown;
        if (a.featuredMediaId !== undefined) {
          const want = a.featuredMediaId ?? 0;
          featured = await evalJson(s, `$c=get_post_thumbnail_id(${a.id}); $o=['from'=>$c?(int)$c:null,'fromUrl'=>$c?wp_get_attachment_url($c):null,'to'=>${want} ?: null]; ${want > 0 ? `$o['toIsAttachment']=get_post_type(${want})==='attachment'; $o['toUrl']=wp_get_attachment_url(${want}) ?: null;` : ""} echo json_encode($o);`);
        }
        return { site: s.name, id: a.id, dryRun: true, changes, featuredImage: featured };
      }
      const wantsPostUpdate = [a.title, a.slug, a.excerpt, a.content, a.status, date].some((v) => v !== undefined);
      if (!wantsPostUpdate && a.featuredMediaId === undefined) throw new Error("Nothing to update: pass at least one of title, slug, excerpt, content, status, date, featuredMediaId.");
      let result = "";
      if (wantsPostUpdate) {
        const args = ["post", "update", String(a.id)];
        if (a.content !== undefined) args.push("-");
        if (a.title !== undefined) args.push(`--post_title=${a.title}`);
        if (a.slug !== undefined) args.push(`--post_name=${a.slug}`);
        if (a.excerpt !== undefined) args.push(`--post_excerpt=${a.excerpt}`);
        if (a.status !== undefined) args.push(`--post_status=${a.status}`);
        if (date !== undefined) {
          // post_date_gmt must be sent too: wp_update_post keeps the old GMT value otherwise, and the
          // cron event that publishes a scheduled post is timed from post_date_gmt. edit_date is required
          // as well, or wp_update_post silently resets a draft's date to "now" (its "drafts shouldn't be
          // assigned a date" rule), which turns a scheduled post into an immediately published one.
          const gmt = (await wp(s, ["eval", `echo get_gmt_from_date(${shq(date)});`])).trim();
          args.push(`--post_date=${date}`, `--post_date_gmt=${gmt}`, "--edit_date=1");
        }
        result = (await wp(s, args, a.content)).trim();
      }
      let featured: unknown;
      if (a.featuredMediaId !== undefined) {
        const want = a.featuredMediaId ?? 0;
        featured = await evalJson(s, want > 0
          ? `if (get_post_type(${want}) !== 'attachment') { echo json_encode(['error'=>'media ${want} is not an attachment']); exit(1); } set_post_thumbnail(${a.id}, ${want}); echo json_encode(['featuredMediaId'=>(int) get_post_thumbnail_id(${a.id}),'url'=>wp_get_attachment_url(${want})]);`
          : `delete_post_thumbnail(${a.id}); echo json_encode(['featuredMediaId'=>null]);`);
      }
      const cachePurged = await purgeCache(s, a.id);
      const rows = await wpJson<Record<string, unknown>[]>(s, ["post", "list", `--post__in=${a.id}`, "--post_type=any", "--post_status=any", `--fields=${POST_FIELDS},post_date_gmt`]);
      const row = rows?.[0];
      const ts = Date.parse(String(row?.post_date_gmt ?? "").replace(" ", "T") + "Z");
      const inFuture = Number.isFinite(ts) && ts > Date.now();
      const notes: string[] = [];
      if (row?.post_status === "future") notes.push(inFuture ? `Scheduled: WordPress publishes it at ${row.post_date} site time, as long as WP-Cron runs (a page view triggers it).` : "Status is 'future' but the date is in the past: WordPress will publish it on the next cron run.");
      else if (a.status === "future") notes.push(`WordPress published it straight away instead of scheduling it: the date (${row?.post_date}) is not in the future. Pass a later date.`);
      else if (date !== undefined && inFuture) notes.push(`post_date is in the future but the status is '${row?.post_status}': pass status='future' to actually schedule it.`);
      return { site: s.name, result, featuredImage: featured, cachePurged, post: row ?? null, notes: notes.length ? notes : undefined };
    }),
  );

  server.registerTool(
    "wp_update_seo",
    {
      title: "Update Yoast SEO meta",
      description:
        "Set Yoast SEO fields on a post/page: SEO title (<title> tag, supports Yoast variables like %%sep%% %%sitename%%), meta description, focus keyword, canonical URL, noindex, the social sharing overrides that social_preview_check reports on (Open Graph and Twitter title/description/image), the Yoast schema page/article type, the cornerstone flag, the primary category (which drives the breadcrumb trail and %%primary_category%%), the breadcrumb title, and the advanced robots directives. Only passed fields change; pass an empty string to reset a field to Yoast's default. Rebuilds the Yoast indexable so the change is live immediately.",
      inputSchema: {
        site: siteParam,
        id: postId,
        seoTitle: z.string().optional().describe("Aim for <= 60 characters."),
        metaDescription: z.string().optional().describe("Aim for 120-155 characters."),
        focusKeyword: z.string().optional().describe("Yoast's focus keyphrase for this page (drives its own analysis, not Google)."),
        canonical: z.string().optional().describe("Absolute URL, or empty string to clear."),
        noindex: z.boolean().nullable().optional().describe("true = noindex, false = force index, null = Yoast default."),
        ogTitle: z.string().optional().describe("Open Graph title override (Facebook, WhatsApp, LinkedIn); empty string clears it."),
        ogDescription: z.string().optional().describe("Open Graph description override."),
        ogImage: z.string().optional().describe("Absolute URL of the sharing image; >=1200x630 and under 5 MB. Fixes what social_preview_check flags."),
        twitterTitle: z.string().optional().describe("Twitter/X title override; falls back to the Open Graph one when empty."),
        twitterDescription: z.string().optional().describe("Twitter/X description override."),
        twitterImage: z.string().optional().describe("Absolute URL of the Twitter/X card image."),
        schemaPageType: z.enum(["WebPage", "ItemPage", "AboutPage", "FAQPage", "QAPage", "ProfilePage", "ContactPage", "MedicalWebPage", "CollectionPage", "CheckoutPage", "RealEstateListing", "SearchResultsPage"]).optional().describe("Yoast's own schema page type. Prefer this over wp_set_schema for page type: wp_set_schema adds a second JSON-LD block that can contradict Yoast's graph."),
        schemaArticleType: z.enum(["None", "Article", "BlogPosting", "SocialMediaPosting", "NewsArticle", "AdvertiserContentArticle", "SatiricalArticle", "ScholarlyArticle", "TechArticle", "Report"]).optional().describe("Yoast's schema article type for posts."),
        cornerstone: z.boolean().optional().describe("Mark as cornerstone content (affects Yoast's internal-linking suggestions and its own analysis)."),
        primaryCategory: z.number().int().positive().nullable().optional().describe("Term ID (from wp_list_terms) of the category Yoast treats as primary: it picks the breadcrumb trail and %%primary_category%% in permalinks/templates. Must be a category the post is in; null clears it."),
        breadcrumbTitle: z.string().optional().describe("Shorter title for this page in the Yoast breadcrumb trail (a rich-result surface); empty string falls back to the post title."),
        robotsAdvanced: z.array(z.enum(ROBOTS_ADVANCED)).max(4).optional().describe("Advanced robots directives for this page: noimageindex, noarchive, nosnippet ('none' = explicitly no directives). Empty array restores the site default. Note: Yoast has no per-post max-snippet field."),
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      if (a.dryRun) {
        const cur = (await getPostMeta(s, a.id)).yoast;
        const changes = (["seoTitle", "metaDescription", "focusKeyword", "canonical", "noindex", "ogTitle", "ogDescription", "ogImage", "twitterTitle", "twitterDescription", "twitterImage", "schemaPageType", "schemaArticleType", "cornerstone", "primaryCategory", "breadcrumbTitle", "robotsAdvanced"] as const).filter((k) => a[k] !== undefined).map((k) => ({ field: k, from: cur[k], to: a[k] }));
        return { site: s.name, id: a.id, dryRun: true, changes };
      }
      if (a.primaryCategory) {
        const terms = await wpJson<number[]>(s, ["post", "term", "list", String(a.id), "category", "--field=term_id"]);
        if (!(terms ?? []).map(Number).includes(a.primaryCategory)) throw new Error(`Post ${a.id} is not in category ${a.primaryCategory} (it is in ${(terms ?? []).join(", ") || "none"}); assign the category first, Yoast ignores a primary category the post does not have.`);
      }
      const updates: [string, string][] = [];
      if (a.seoTitle !== undefined) updates.push([YOAST_KEYS.seoTitle, a.seoTitle]);
      if (a.metaDescription !== undefined) updates.push([YOAST_KEYS.metaDescription, a.metaDescription]);
      if (a.focusKeyword !== undefined) updates.push([YOAST_KEYS.focusKeyword, a.focusKeyword]);
      if (a.canonical !== undefined) updates.push([YOAST_KEYS.canonical, a.canonical]);
      if (a.noindex !== undefined) updates.push([YOAST_KEYS.noindex, a.noindex === true ? "1" : a.noindex === false ? "2" : ""]);
      for (const k of ["ogTitle", "ogDescription", "ogImage", "twitterTitle", "twitterDescription", "twitterImage", "schemaPageType", "schemaArticleType"] as const) {
        if (a[k] !== undefined) updates.push([YOAST_KEYS[k], a[k] as string]);
      }
      if (a.cornerstone !== undefined) updates.push([YOAST_KEYS.cornerstone, a.cornerstone ? "1" : ""]);
      if (a.primaryCategory !== undefined) updates.push([YOAST_KEYS.primaryCategory, a.primaryCategory === null ? "" : String(a.primaryCategory)]);
      if (a.breadcrumbTitle !== undefined) updates.push([YOAST_KEYS.breadcrumbTitle, a.breadcrumbTitle]);
      if (a.robotsAdvanced !== undefined) updates.push([YOAST_KEYS.robotsAdvanced, a.robotsAdvanced.join(",")]);
      if (!updates.length) throw new Error("Nothing to update: pass at least one SEO field.");
      const remote = updates
        .map(([k, v]) => (v === "" ? `(wp post meta delete ${a.id} ${shq(k)} || true)` : `wp post meta update ${a.id} ${shq(k)} ${shq(v)}`))
        .join(" && ");
      const r = await ssh(s, `cd ${shq(s.path)} && ${remote}`);
      if (r.code !== 0) throw new Error(`meta update failed: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
      const indexable = await rebuildYoastIndexable(s, a.id);
      const [meta, cachePurged] = await Promise.all([getPostMeta(s, a.id), purgeCache(s, a.id)]);
      return { site: s.name, id: a.id, updated: updates.map(([k]) => k), indexable, cachePurged, yoast: meta.yoast };
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
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
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
      description: "Read-only check that a post's Muffin Builder data can be decoded and re-encoded losslessly before editing it. Also lists the snapshots kept for wp_builder_restore.",
      inputSchema: { site: siteParam, id: postId },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await builder<object>(pick(a.site), "check", a.id)) })),
  );

  server.registerTool(
    "wp_builder_restore",
    {
      title: "Restore builder content from a snapshot",
      description:
        "Undo a wp_builder_update. Every builder write first snapshots the post's raw builder data (the last 3 are kept), because WordPress does not version postmeta and a normal revision restore will not bring builder content back. index 0 is the most recent snapshot; list them with wp_builder_check. Restoring itself takes a snapshot first, so it can be undone too. Always run with dryRun first to see which snapshot you would go back to.",
      inputSchema: {
        site: siteParam,
        id: postId,
        index: z.number().int().min(0).max(2).default(0).describe("Which snapshot to restore: 0 = the state just before the most recent write."),
        dryRun: z.boolean().default(true).describe("Preview the snapshot and the current state without writing."),
      },
    },
    tool(async (a) => {
      const site = pick(a.site);
      const res = await builder<Record<string, unknown>>(site, "restore", a.id, [String(a.index), a.dryRun ? "dry" : "live"]);
      if (a.dryRun) return { site: site.name, ...res };
      await rebuildYoastIndexable(site, a.id);
      const purged = await purgeCache(site, a.id);
      return { site: site.name, ...res, cachePurged: purged };
    }),
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
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "bulk_seo", [], JSON.stringify({ items: a.items, dryRun: a.dryRun }))) })),
  );

  server.registerTool(
    "wp_list_media",
    {
      title: "List media files",
      description: "List media-library files with alt text, caption, dimensions, mime type, file size and the post they are attached to. Defaults to images; set mimeType to 'application/pdf' for brochures and itineraries (they are indexable and can rank) or 'any' for everything. Use missingAltOnly to find images without alt text; with it the result also carries totalMissingAlt, pages and hasMore so you can work through a backlog page by page.",
      inputSchema: {
        site: siteParam,
        missingAltOnly: z.boolean().default(false).describe("Only files whose alt text is empty (images that need one)."),
        mimeType: z.string().default("image").describe("Mime filter: a prefix like 'image', 'video', 'audio', 'application', an exact type like 'application/pdf', or 'any' for every attachment."),
        search: z.string().optional().describe("Free-text search on file name, title and caption."),
        attachedTo: z.number().int().positive().optional().describe("Only files uploaded to this post ID."),
        perPage: z.number().int().min(1).max(200).default(50).describe("Files per page."),
        page: z.number().int().min(1).default(1).describe("Page number, 1-based."),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "media_list", [], JSON.stringify(a))) })),
  );

  server.registerTool(
    "wp_upload_media",
    {
      title: "Add an image to the WordPress media library",
      description:
        "Fetch an image from a URL, convert and resize it on the server (webp by default, same pipeline as github_commit_image), upload it into the media library with alt text, and optionally set it as a post's featured image. This is the fix path for the oversized hero images that pagespeed and crux_history report on a BeTheme site: nothing else here can put an optimised image into WordPress. Use dryRun to see the resulting dimensions and bytes before uploading.",
      inputSchema: {
        site: siteParam,
        sourceUrl: z.string().url().describe("Public URL of the source image."),
        filename: z.string().regex(/^[\w.-]+$/).describe("File name to store it under, without a path, e.g. 'juderia-sevilla-noche.webp'."),
        alt: z.string().describe("Alt text. Describe the picture; leave empty only for purely decorative images."),
        title: z.string().optional(),
        caption: z.string().optional(),
        attachToPost: z.number().int().positive().optional().describe("Post ID to attach the image to."),
        setFeatured: z.boolean().default(false).describe("Also set it as that post's featured image (needs attachToPost). This is the thumbnail Yoast falls back to for social sharing."),
        width: imageOptionShape.width,
        height: imageOptionShape.height,
        focus: imageOptionShape.focus,
        format: imageOptionShape.format,
        quality: imageOptionShape.quality,
        dryRun: z.boolean().default(false).describe("Fetch and convert, report dimensions and bytes, upload nothing."),
      },
    },
    tool(async (a) => {
      const site = pick(a.site);
      if (a.setFeatured && !a.attachToPost) throw new Error("setFeatured needs attachToPost: say which post the image belongs to.");
      const res = await fetchWithTimeout(a.sourceUrl, { headers: { "User-Agent": "google-seo-mcp image fetch" } }, 60_000);
      if (!res.ok) throw new Error(`Could not fetch ${a.sourceUrl}: HTTP ${res.status}`);
      const src = Buffer.from(await res.arrayBuffer());
      const opts: ImageOptions = { path: a.filename, width: a.width, height: a.height, focus: a.focus, format: a.format, quality: a.quality };
      const { source, outputs, notes } = await renderImageOutputs(src, opts);
      const out = outputs[0];
      if (a.dryRun) return { site: site.name, dryRun: true, source, wouldUpload: { filename: a.filename, width: out.width, height: out.height, bytes: out.bytes }, notes };
      // Pipe the bytes over stdin: base64 on the command line would blow the argv limit.
      const php = `$raw = file_get_contents('php://stdin'); $bytes = base64_decode($raw); $tmp = wp_tempnam(${shq(a.filename)}); file_put_contents($tmp, $bytes); $file = ['name' => ${shq(a.filename)}, 'tmp_name' => $tmp]; require_once ABSPATH . 'wp-admin/includes/media.php'; require_once ABSPATH . 'wp-admin/includes/file.php'; require_once ABSPATH . 'wp-admin/includes/image.php'; $id = media_handle_sideload($file, ${a.attachToPost ?? 0}); if (is_wp_error($id)) { echo json_encode(['error' => $id->get_error_message()]); exit(1); } update_post_meta($id, '_wp_attachment_image_alt', ${shq(a.alt)}); $post = ['ID' => $id]; ${a.title ? `$post['post_title'] = ${shq(a.title)};` : ""} ${a.caption ? `$post['post_excerpt'] = ${shq(a.caption)};` : ""} if (count($post) > 1) wp_update_post($post); ${a.setFeatured && a.attachToPost ? `set_post_thumbnail(${a.attachToPost}, $id);` : ""} echo json_encode(['id' => $id, 'url' => wp_get_attachment_url($id), 'file' => get_attached_file($id)]);`;
      const r = await ssh(site, `cd ${shq(site.path)} && wp eval ${shq(php)}`, out.base64);
      const text = r.stdout.trim();
      let parsed: { id?: number; url?: string; file?: string; error?: string } | null = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (r.code !== 0 || parsed?.error) throw new Error(`upload failed: ${parsed?.error ?? (r.stderr || text).slice(0, 800)}`);
      const purged = a.attachToPost ? await purgeCache(site, a.attachToPost) : "n/a";
      return { site: site.name, id: parsed?.id, url: parsed?.url, width: out.width, height: out.height, bytes: out.bytes, source, alt: a.alt, attachedTo: a.attachToPost ?? null, featured: !!(a.setFeatured && a.attachToPost), cachePurged: purged, notes };
    }),
  );

  server.registerTool(
    "wp_update_media",
    {
      title: "Update media alt/title/caption, regenerate thumbnails",
      description: "Set alt text, title, caption and/or description on one or more media items, and/or run `wp media regenerate` so WordPress rebuilds the intermediate image sizes. Regenerate after the theme's registered image sizes change or srcset markup points at sizes that no longer exist; regenerateAll walks the whole library and takes minutes.",
      inputSchema: {
        site: siteParam,
        items: z.array(z.object({ id: z.number().int().positive(), alt: z.string().optional(), title: z.string().optional(), caption: z.string().optional(), description: z.string().optional() })).min(1).max(100).optional().describe("Media items to edit (attachment IDs from wp_list_media); omit to only regenerate."),
        regenerateThumbnails: z.boolean().default(false).describe("Regenerate the image sizes of the listed items (needs items, or use regenerateAll)."),
        regenerateAll: z.boolean().default(false).describe("Regenerate every image in the library instead. Slow: minutes on a large library, and it rewrites files on disk."),
        onlyMissing: z.boolean().default(true).describe("When regenerating, skip sizes that already exist (much faster; set false to force a rebuild of every size)."),
        dryRun: z.boolean().default(false).describe("Preview only: return current values and what would be regenerated, without writing."),
      },
    },
    tool(async (a, extra) => {
      const s = pick(a.site);
      const regenerate = a.regenerateAll || a.regenerateThumbnails;
      if (!a.items?.length && !regenerate) throw new Error("Nothing to do: pass items to edit, or regenerateThumbnails/regenerateAll.");
      if (a.regenerateThumbnails && !a.regenerateAll && !a.items?.length) throw new Error("regenerateThumbnails needs items; use regenerateAll for the whole library.");
      const runRegenerate = async () => {
        const args = ["media", "regenerate", "--yes"];
        if (!a.regenerateAll) args.push(...(a.items ?? []).map((i) => String(i.id)));
        if (a.onlyMissing) args.push("--only-missing");
        const stop = heartbeat(extra, "regenerating image sizes");
        try {
          const out = await wp(s, args, undefined, 590_000);
          const lines = out.trim().split("\n");
          return { command: args.join(" "), summary: lines[lines.length - 1], output: out.slice(-3000) };
        } catch (e) {
          return { command: args.join(" "), error: (e as Error).message.slice(0, 500) };
        } finally { stop(); }
      };
      if (a.dryRun) {
        const wouldRegenerate = regenerate ? { scope: a.regenerateAll ? "all images" : `${a.items?.length ?? 0} items`, onlyMissing: a.onlyMissing } : undefined;
        if (!a.items?.length) return { site: s.name, dryRun: true, wouldRegenerate, note: "No commands were run." };
        const rows = await wpJson<{ ID: number; post_title: string; post_excerpt: string; post_content: string }[]>(s, ["post", "list", "--post_type=attachment", "--post_status=inherit", `--post__in=${a.items.map((i) => i.id).join(",")}`, "--fields=ID,post_title,post_excerpt,post_content"]);
        const alts = await Promise.all(a.items.map((i) => wp(s, ["post", "meta", "get", String(i.id), "_wp_attachment_image_alt"]).then((v) => v.trim()).catch(() => "")));
        return { site: s.name, dryRun: true, wouldRegenerate, changes: a.items.map((i, idx) => { const cur = rows.find((r) => r.ID === i.id); return { id: i.id, found: Boolean(cur), alt: i.alt !== undefined ? { from: alts[idx], to: i.alt } : undefined, title: i.title !== undefined ? { from: cur?.post_title, to: i.title } : undefined, caption: i.caption !== undefined ? { from: cur?.post_excerpt, to: i.caption } : undefined, description: i.description !== undefined ? { from: cur?.post_content, to: i.description } : undefined }; }) };
      }
      const updated = a.items?.length ? await runHelper<object>(s, "wp", "media_update", [], JSON.stringify({ items: a.items })) : undefined;
      const regenerated = regenerate ? await runRegenerate() : undefined;
      return { site: s.name, ...(updated ?? {}), regenerated };
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
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
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
        dryRun: z.boolean().default(false).describe("Preview the change without writing."),
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
      inputSchema: { site: siteParam, origin: z.string(), format: z.enum(["plain", "regex"]).default("plain"), dryRun: z.boolean().default(false).describe("Preview the change without writing."), },
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
      inputSchema: { site: siteParam, id: postId, jsonld: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())), z.null()]), dryRun: z.boolean().default(false).describe("Preview the change without writing."), },
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

  server.registerTool(
    "wp_get_seo_settings",
    {
      title: "Read site-wide Yoast settings",
      description:
        "Read Yoast's site-level configuration: title and meta-description templates per post type and taxonomy, which archives are indexed or switched off (author, date, tag, format, search, 404), the XML sitemap switch and what each type contributes to it, the breadcrumb setup, and the Organization/Person knowledge-graph identity with its sameAs social profiles. Thin indexed author/date/tag archives - the classic index bloat that gsc_index_coverage surfaces on a one-author site - are configured here; change them with wp_update_seo_settings.",
      inputSchema: {
        site: siteParam,
        raw: z.boolean().default(false).describe("Also return the raw wpseo_titles / wpseo_social / wpseo option arrays, for keys this tool does not summarise."),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "seo_settings_get", [], JSON.stringify({ raw: a.raw }))) })),
  );

  server.registerTool(
    "wp_update_seo_settings",
    {
      title: "Update site-wide Yoast settings",
      description:
        "Change Yoast's site-level configuration: title and meta-description templates, noindex per post type / taxonomy / archive (the same switch also drops that type from the XML sitemap), switching author, date and format archives off entirely, the title separator, the breadcrumb trail, the Organization/Person identity with its social profiles, and the XML sitemap itself. This is the fix path for index bloat from author, date and tag archives. These settings are site-wide and WordPress does not version them, so read wp_get_seo_settings first; dryRun is ON by default and returns the exact from/to list - call again with dryRun=false to apply. Afterwards Yoast's sitemap cache and the page cache are flushed, so a resubmitted sitemap is not a stale one.",
      inputSchema: {
        site: siteParam,
        templates: z.array(z.object({
          for: z.string().describe("What the template is for: a post type ('post', 'page'), a taxonomy ('tax-category', 'tax-post_tag'), or 'author-wpseo' (author archives), 'archive-wpseo' (date archives), 'search-wpseo', '404-wpseo'. Exact keys come from wp_get_seo_settings."),
          title: z.string().optional().describe("Title template; Yoast variables allowed (%%title%% %%sep%% %%sitename%% %%page%% %%primary_category%%)."),
          metaDescription: z.string().optional().describe("Meta-description template; empty string clears it."),
          noindex: z.boolean().optional().describe("true = noindex this type/archive and drop it from the XML sitemap (Yoast uses one switch for both)."),
        })).max(30).optional().describe("Per-type templates and index switches."),
        archives: z.object({
          disableAuthor: z.boolean().describe("Switch author archives off completely (they 404/redirect). The usual answer on a single-author site."),
          disableDate: z.boolean().describe("Switch date archives off completely."),
          disableFormat: z.boolean().describe("Switch post-format archives off."),
          disableAttachmentPages: z.boolean().describe("Redirect attachment pages to the file itself (Yoast's default; keeps thin image pages out of the index)."),
        }).partial().optional().describe("Switch whole archive types off. Stronger than noindex: the URLs stop existing."),
        separator: z.enum(["sc-dash", "sc-ndash", "sc-mdash", "sc-middot", "sc-bull", "sc-star", "sc-smstar", "sc-pipe", "sc-tilde", "sc-laquo", "sc-raquo", "sc-lt", "sc-gt"]).optional().describe("Yoast's %%sep%% character."),
        breadcrumbs: z.object({
          enabled: z.boolean(),
          separator: z.string().describe("Character between crumbs, e.g. '»'."),
          homeText: z.string().describe("Label of the first crumb, e.g. 'Home'."),
          prefix: z.string().describe("Text before the whole trail (usually empty)."),
          archivePrefix: z.string().describe("Prefix on archive pages, e.g. 'Archives for'."),
          searchPrefix: z.string().describe("Prefix on search pages, e.g. 'You searched for'."),
          notFoundText: z.string().describe("Last crumb on 404 pages."),
          boldLast: z.boolean().describe("Bold the current page in the trail."),
          taxonomyForPosts: z.string().describe("Taxonomy shown in the trail for posts, e.g. 'category'."),
        }).partial().optional().describe("Breadcrumb configuration; the trail is what Yoast turns into BreadcrumbList schema, a rich-result surface."),
        organization: z.object({
          type: z.enum(["company", "person"]).describe("Whether the site represents an organization or a person; drives Yoast's knowledge-graph entity."),
          name: z.string(),
          alternateName: z.string(),
          logoId: z.number().int().positive().describe("Attachment ID of the logo (from wp_list_media)."),
          personUserId: z.number().int().positive().describe("WordPress user ID the site represents, when type='person'."),
          websiteName: z.string().describe("Name of the WebSite entity in schema; defaults to the site title."),
          alternateWebsiteName: z.string(),
        }).partial().optional().describe("The Organization/Person entity Yoast publishes in its schema graph, which knowledge_graph_check looks for."),
        socialProfiles: z.object({
          facebook: z.string().describe("Full profile URL; empty string clears."),
          twitter: z.string().describe("X/Twitter handle without the @, as Yoast stores it."),
          instagram: z.string(),
          linkedin: z.string(),
          youtube: z.string(),
          pinterest: z.string(),
          wikipedia: z.string(),
          other: z.array(z.string()).max(10).describe("Any further sameAs profile URLs (replaces the current list)."),
        }).partial().optional().describe("The sameAs profiles Yoast puts in the Organization/Person schema; knowledge_graph_check reports on these."),
        xmlSitemap: z.boolean().optional().describe("Yoast's XML sitemap feature as a whole (sitemap_index.xml)."),
        dryRun: z.boolean().default(true).describe("Default true: report every from/to without writing. Pass false to apply."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const { site: _s, ...payload } = a;
      return { site: s.name, ...(await runHelper<object>(s, "wp", "seo_settings_set", [], JSON.stringify(payload))) };
    }),
  );

  server.registerTool(
    "wp_list_revisions",
    {
      title: "List revisions of a post",
      description:
        "List the stored revisions of a post or page with date, author and how far each one differs from what is live now, so a bad edit can be rolled back with wp_update_post_from_revision. BeTheme builder text lives in post meta, which WordPress does not version: for those posts the revision only covers the (often empty) post_content, and wp_builder_check / wp_builder_restore is the right tool.",
      inputSchema: {
        site: siteParam,
        id: postId,
        limit: z.number().int().min(1).max(50).default(20).describe("Most recent revisions to return."),
      },
    },
    tool(async (a) => ({ site: pick(a.site).name, ...(await runHelper<object>(pick(a.site), "wp", "revisions_list", [], JSON.stringify({ id: a.id, limit: a.limit }))) })),
  );

  server.registerTool(
    "wp_update_post_from_revision",
    {
      title: "Restore a post from a revision",
      description:
        "Roll a post or page back to one of its revisions (title, content and excerpt), for example after a rewrite that lost content. dryRun is ON by default and returns the line-level diff between what is live now and that revision - call again with dryRun=false to apply. WordPress stores the current state as a new revision first, so the rollback can itself be undone. Rebuilds the Yoast indexable and purges the post's cache. Builder content is not in revisions: use wp_builder_restore for BeTheme posts.",
      inputSchema: {
        site: siteParam,
        id: postId,
        revisionId: z.number().int().positive().describe("Revision ID from wp_list_revisions (must belong to this post)."),
        dryRun: z.boolean().default(true).describe("Default true: show the diff without writing. Pass false to restore."),
      },
    },
    tool(async (a) => {
      const s = pick(a.site);
      const res = await runHelper<Record<string, unknown>>(s, "wp", "revision_restore", [], JSON.stringify({ id: a.id, revisionId: a.revisionId, dryRun: a.dryRun }));
      return { site: s.name, ...res };
    }),
  );

  server.registerTool(
    "wp_delete_cache",
    {
      title: "Purge caches site-wide",
      description:
        "Purge caches for the whole site (WP Rocket, WP Super Cache, W3TC, LiteSpeed), and optionally regenerate WP Rocket's critical CSS, flush the object cache and clear Yoast's sitemap cache. Single-post writes purge their own page already; this is the site-wide one to run after wp_bulk_update_seo across many posts, a term rename, a theme or CSS change, or wp_update_seo_settings. Stale critical CSS is a common cause of the layout shift (CLS) that pagespeed and crux_history report, so regenerate it whenever the theme's CSS changed. Regenerating critical CSS runs in the background on the site and takes a few minutes to finish.",
      inputSchema: {
        site: siteParam,
        pageCache: z.boolean().default(true).describe("Clear all cached HTML."),
        criticalCss: z.boolean().default(false).describe("Also run WP Rocket's critical-CSS regeneration (`wp rocket regenerate --file=critical-css`)."),
        objectCache: z.boolean().default(false).describe("Also flush the object cache (transients, Redis/Memcached)."),
        yoastSitemap: z.boolean().default(false).describe("Also clear Yoast's cached XML sitemaps, so the next fetch (or gsc_submit_sitemap) sees current data."),
        dryRun: z.boolean().default(false).describe("Preview only: report what would be purged without running anything."),
      },
    },
    tool(async (a, extra) => {
      const s = pick(a.site);
      const plan = { pageCache: a.pageCache, criticalCss: a.criticalCss, objectCache: a.objectCache, yoastSitemap: a.yoastSitemap };
      if (!Object.values(plan).some(Boolean)) throw new Error("Nothing to purge: enable at least one of pageCache, criticalCss, objectCache, yoastSitemap.");
      if (a.dryRun) return { site: s.name, dryRun: true, would: plan, note: "Nothing was purged." };
      const stop = heartbeat(extra, "purging caches");
      try {
        const res = await runHelper<object>(s, "wp", "purge_site", [], JSON.stringify(plan));
        let criticalCss: unknown;
        if (a.criticalCss) {
          try { criticalCss = { started: true, output: (await wp(s, ["rocket", "regenerate", "--file=critical-css"], undefined, 300_000)).trim().slice(-1500) }; }
          catch (e) { criticalCss = { started: false, error: (e as Error).message.slice(0, 400), hint: "This WP Rocket version may not expose the CLI command; regenerate critical CSS from the WP Rocket settings page instead." }; }
        }
        return { site: s.name, ...res, criticalCss };
      } finally { stop(); }
    }),
  );
}
