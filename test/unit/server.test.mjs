import { test } from "node:test";
import assert from "node:assert/strict";
import { toolsetOf, isWriteTool, inferAnnotations } from "../../dist/server.js";
import { narrowOptions } from "../../dist/http.js";
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
