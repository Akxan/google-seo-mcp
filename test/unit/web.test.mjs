import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, extractJsonLdTypes } from "../../dist/tools/web.js";
import * as cheerio from "cheerio";
import { normalizeUrl, cleanUrl } from "../../dist/tools/crawl.js";
import { normalizePath } from "../../dist/tools/gsc.js";

const ROBOTS = `User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /private*\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n`;

test("parseRobots groups agents and collects sitemaps", () => {
  const r = parseRobots(ROBOTS);
  assert.equal(r.groups.length, 2);
  assert.deepEqual(r.groups[0].agents, ["*"]);
  assert.deepEqual(r.sitemaps, ["https://example.com/sitemap.xml"]);
});

test("robotsAllows applies longest-match with allow winning ties and per-agent groups", () => {
  const r = parseRobots(ROBOTS);
  assert.equal(robotsAllows(r, "https://example.com/wp-admin/", "googlebot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/wp-admin/admin-ajax.php", "googlebot").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/private-notes", "bingbot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/blog/", "googlebot").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/blog/", "gptbot").allowed, false);
  assert.equal(robotsAllows(parseRobots(""), "https://example.com/x", "googlebot").allowed, true);
});

test("URL normalisation strips hash and trailing slash for keys but not for fetching", () => {
  assert.equal(normalizeUrl("https://example.com/a/b/#top"), "https://example.com/a/b");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
  assert.equal(cleanUrl("https://example.com/a/b/#top"), "https://example.com/a/b/");
  assert.equal(normalizePath("https://example.com/Blog/Post/"), "/blog/post");
  assert.equal(normalizePath("https://example.com/"), "/");
});

test("extractJsonLdTypes reads every block, @graph nodes and arrays, and flags invalid JSON", () => {
  const html = `<html><head><title>x</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["BlogPosting","Article"]}]}</script>
    <script>console.log("not schema")</script>
    <script type="application/ld+json">{not json}</script>
    </head><body><p>body</p></body></html>`;
  const types = extractJsonLdTypes(cheerio.load(html));
  assert.deepEqual(types, ["WebSite", "Organization", "BlogPosting", "Article", "(invalid JSON-LD)"]);
});
