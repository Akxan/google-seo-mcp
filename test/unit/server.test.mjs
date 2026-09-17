import { test } from "node:test";
import assert from "node:assert/strict";
import { toolsetOf, isWriteTool, inferAnnotations } from "../../dist/server.js";
import { narrowOptions } from "../../dist/http.js";
import { registerPrompts, PROMPT_NAMES } from "../../dist/prompts.js";
import { shq } from "../../dist/tools/wp.js";

test("toolsetOf maps prefixes to toolsets", () => {
  assert.equal(toolsetOf("gsc_list_sites"), "gsc");
  assert.equal(toolsetOf("ga_run_report"), "ga4");
  assert.equal(toolsetOf("wp_update_seo"), "wordpress");
  assert.equal(toolsetOf("github_get_file"), "github");
  assert.equal(toolsetOf("site_crawl"), "web");
  assert.equal(toolsetOf("knowledge_graph_check"), "geo");
  assert.equal(toolsetOf("migration_check"), "analysis");
  assert.equal(toolsetOf("google_auth_status"), "core");
});

test("write and destructive classification", () => {
  assert.equal(isWriteTool("gsc_search_analytics"), false);
  assert.equal(isWriteTool("wp_bulk_update_seo"), true);
  assert.equal(isWriteTool("gsc_delete_sitemap"), true);
  assert.equal(isWriteTool("github_commit_image"), true);
  assert.equal(inferAnnotations("github_commit_files").destructiveHint, true);
  assert.equal(isWriteTool("github_get_file"), false);
  assert.equal(inferAnnotations("wp_delete_redirect").destructiveHint, true);
  assert.equal(inferAnnotations("wp_update_seo").destructiveHint, false);
  assert.equal(inferAnnotations("page_audit").readOnlyHint, true);
});

test("shq produces POSIX-safe single-quoted strings", () => {
  assert.equal(shq("plain"), "'plain'");
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(shq(""), "''");
});

test("narrowOptions only ever removes access", () => {
  const u = (q) => new URL(`http://x/mcp${q}`);
  // No parameter: untouched.
  assert.deepEqual(narrowOptions({ toolsets: ["gsc", "ga4"] }, u("")), { toolsets: ["gsc", "ga4"] });
  // Narrowing an unrestricted instance.
  assert.deepEqual(narrowOptions({}, u("?toolsets=gsc,web")).toolsets, ["gsc", "web"]);
  // Cannot widen past what the instance allows: wordpress is not in the base set, so it is dropped.
  assert.deepEqual(narrowOptions({ toolsets: ["gsc", "ga4"] }, u("?toolsets=gsc,wordpress")).toolsets, ["gsc"]);
  // Cannot turn read-only off, and can turn it on.
  assert.equal(narrowOptions({ readOnly: true }, u("?readOnly=0")).readOnly, true);
  assert.equal(narrowOptions({ readOnly: false }, u("?readOnly=1")).readOnly, true);
  // Other restrictions survive.
  assert.deepEqual(narrowOptions({ exclude: ["brand_mentions"] }, u("?toolsets=gsc")).exclude, ["brand_mentions"]);
  // Typos are rejected rather than silently yielding an empty server.
  assert.throws(() => narrowOptions({}, u("?toolsets=gsc,wordpres")), /unknown toolset/);
  assert.throws(() => narrowOptions({}, u("?toolsets=")), /at least one/);
});

test("prompts are only offered when their toolsets are enabled", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const make = (enabled) => {
    const s = new McpServer({ name: "t", version: "0" });
    return registerPrompts(s, (ts) => enabled === null || enabled.includes(ts));
  };
  const all = make(null);
  assert.equal(all, PROMPT_NAMES.length, "an unrestricted instance offers every prompt");
  // publish_check and site_health need web + geo, so a data-only instance must not advertise them.
  assert.ok(make(["gsc", "ga4"]) < all);
  // An instance with no Search Console cannot run the four that start from it.
  assert.ok(make(["web", "geo"]) < all);
  assert.equal(make([]), 0, "a server with no toolsets offers no workflow it cannot run");
});

test("every prompt body names only tools that exist", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const names = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../tools.snap.json", import.meta.url), "utf8"));
  const captured = [];
  const s = new McpServer({ name: "t", version: "0" });
  s.registerPrompt = (name, cfg, cb) => { captured.push([name, cb]); return {}; };
  registerPrompts(s, () => true);
  for (const [name, cb] of captured) {
    const text = cb({}).messages[0].content.text;
    // Any snake_case token that looks like one of our tool prefixes must be a real tool.
    for (const m of text.match(/\b(gsc|ga|wp|github|gmail)_[a-z_]+\b/g) ?? []) {
      assert.ok(names.includes(m), `prompt ${name} refers to unknown tool ${m}`);
    }
    for (const m of text.match(/\b(page_audit|site_crawl|sitemap_check|robots_check|canonical_host_check|hreflang_check|social_preview_check|structured_data_audit|geo_page_score|eeat_audit|llms_txt_check|ai_crawler_access|crux_snapshot|crux_history|content_refresh_candidates|migration_check)\b/g) ?? []) {
      assert.ok(names.includes(m), `prompt ${name} refers to unknown tool ${m}`);
    }
  }
});
