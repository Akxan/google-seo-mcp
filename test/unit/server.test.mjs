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

test("a prompt never fails just because the client did not ask for its arguments", async () => {
  // Claude Code's VS Code extension does not surface MCP prompts at all, and the CLI lists them
  // without eliciting arguments, so an empty call is a real path, not a theoretical one.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const captured = [];
  const s = new McpServer({ name: "t", version: "0" });
  s.registerPrompt = (name, cfg, cb) => { captured.push([name, cfg, cb]); return {}; };
  registerPrompts(s, () => true);
  for (const [name, cfg, cb] of captured) {
    for (const [arg, schema] of Object.entries(cfg.argsSchema ?? {})) {
      assert.ok(schema.safeParse(undefined).success, `${name}.${arg} must be optional`);
    }
    const text = cb({}).messages[0].content.text;
    assert.ok(!text.includes("undefined"), `${name} interpolates "undefined" when called without arguments`);
    assert.ok(text.length > 100, `${name} produced no usable body without arguments`);
  }
});

// /privacy promises access logs go after 30 days; audit.log used to grow forever.
test("keepRecentAuditLines drops lines past the retention window and keeps the rest", async () => {
  const { keepRecentAuditLines, AUDIT_RETENTION_DAYS } = await import("../../dist/server.js");
  assert.equal(AUDIT_RETENTION_DAYS, 30, "the number the privacy page states");
  const now = Date.parse("2026-10-20T12:00:00Z");
  const line = (at, tool) => JSON.stringify({ audit: "write", at, tool, ok: true });
  const text = [
    line("2026-09-14T20:46:38.313Z", "github_commit_files"), // 36 days old
    line("2026-09-20T12:00:00.000Z", "wp_update_seo"),        // exactly 30 days: kept
    line("2026-10-19T08:00:00.000Z", "indexnow_submit"),
  ].join("\n") + "\n";
  const kept = keepRecentAuditLines(text, now);
  assert.ok(!kept.includes("github_commit_files"), "36 days old is gone");
  assert.ok(kept.includes("wp_update_seo"), "the boundary day stays");
  assert.ok(kept.includes("indexnow_submit"));
  assert.ok(kept.endsWith("\n"), "still one line per entry, so the next append starts clean");
});

test("keepRecentAuditLines never drops a line it cannot date", async () => {
  const { keepRecentAuditLines } = await import("../../dist/server.js");
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.match(keepRecentAuditLines("not json at all\n", now), /not json at all/, "unreadable evidence is kept, not silently lost");
  assert.match(keepRecentAuditLines('{"at":"garbage"}\n', now), /garbage/);
  assert.equal(keepRecentAuditLines("", now), "");
  assert.equal(keepRecentAuditLines("\n\n", now), "", "blank lines are not kept");
  const old = JSON.stringify({ at: "2020-01-01T00:00:00Z" }) + "\n";
  assert.equal(keepRecentAuditLines(old, now), "", "everything expired leaves an empty file, not a stray newline");
});
