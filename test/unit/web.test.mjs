import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, extractJsonLdTypes, sizesToPx, collectIcons, pickFavicon, parseLinkHeader, parseSitemapAlternates, extractFieldData, failedAuditsByCategory } from "../../dist/tools/web.js";
import * as cheerio from "cheerio";
import { normalizeUrl, cleanUrl } from "../../dist/tools/crawl.js";
import { normalizePath } from "../../dist/tools/gsc.js";
import { cruxRating, diagnoseLcp, hostFromProperty, waybackCdxUrl, parseCdxRows, parseWikipediaUrl, summarizePageviews } from "../../dist/tools/analysis.js";

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

test("sizesToPx takes the largest square edge and treats 'any' as scalable", () => {
  assert.equal(sizesToPx("16x16 32x32"), 32);
  assert.equal(sizesToPx("180X180"), 180);
  assert.equal(sizesToPx("any"), Number.MAX_SAFE_INTEGER);
  assert.equal(sizesToPx(undefined), null);
  assert.equal(sizesToPx("wide"), null);
});

test("collectIcons/pickFavicon prefer a declared icon of at least 48px, then apple-touch-icon, then /favicon.ico", () => {
  const page = "https://example.com/es/blog/post";
  const $ = cheerio.load(`<html><head>
    <link rel="shortcut icon" href="/favicon-16.png" sizes="16x16">
    <link rel="icon" type="image/png" href="../icon-96.png" sizes="96x96">
    <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
    <link rel="manifest" href="/site.webmanifest">
    <meta name="theme-color" content="#123456">
  </head><body></body></html>`);
  const found = collectIcons($, page);
  assert.equal(found.icons.length, 2);
  assert.equal(found.manifest, "https://example.com/site.webmanifest");
  assert.equal(found.themeColor, "#123456");
  assert.equal(found.appleTouchIcons[0].href, "https://example.com/apple.png");
  const pick = pickFavicon(found, page);
  assert.equal(pick.url, "https://example.com/es/icon-96.png");
  assert.equal(pick.declaredPx, 96);
  // only a tiny icon declared: it is still the one Google would read
  const small = collectIcons(cheerio.load('<link rel="icon" href="/f.ico" sizes="16x16">'), page);
  assert.equal(pickFavicon(small, page).declaredPx, 16);
  // nothing declared at all -> implicit /favicon.ico at the origin
  const none = pickFavicon(collectIcons(cheerio.load("<html></html>"), page), page);
  assert.equal(none.url, "https://example.com/favicon.ico");
  assert.equal(none.source, "implicit /favicon.ico");
});

test("parseLinkHeader splits entries and keeps quoted parameters", () => {
  const h = '<https://example.com/en/>; rel="alternate"; hreflang="en", <https://example.com/es/>; rel=alternate; hreflang=es, <https://example.com/style.css>; rel=preload; as=style';
  const parsed = parseLinkHeader(h);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { url: "https://example.com/en/", params: { rel: "alternate", hreflang: "en" } });
  assert.equal(parsed[1].params.hreflang, "es");
  assert.equal(parsed[2].params.as, "style");
  assert.deepEqual(parseLinkHeader(null), []);
});

test("parseSitemapAlternates reads xhtml:link hreflang entries of one <url> block", () => {
  const block = `<loc>https://example.com/es/casa/</loc>
    <xhtml:link rel="alternate" hreflang="es" href="https://example.com/es/casa/"/>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/house/?a=1&amp;b=2"/>
    <link rel="alternate" hreflang="x-default" href="https://example.com/"/>
    <xhtml:link rel="canonical" href="https://example.com/es/casa/"/>`;
  assert.deepEqual(parseSitemapAlternates(block), [
    { hreflang: "es", href: "https://example.com/es/casa/" },
    { hreflang: "en", href: "https://example.com/en/house/?a=1&b=2" },
    { hreflang: "x-default", href: "https://example.com/" },
  ]);
  assert.deepEqual(parseSitemapAlternates("<loc>https://example.com/</loc>"), []);
});

test("extractFieldData scales CLS back from CrUX's integer form and reads every metric", () => {
  const exp = {
    overall_category: "AVERAGE",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: "AVERAGE" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 900, category: "AVERAGE" },
    },
  };
  const f = extractFieldData(exp);
  assert.equal(f.overall, "AVERAGE");
  assert.deepEqual(f.cls, { p75: 0.05, category: "FAST" });
  assert.equal(f.lcp.p75, 3100);
  assert.equal(f.ttfb.p75, 900);
  assert.equal(f.fcp, null);
  assert.equal(extractFieldData(undefined), null);
});

test("failedAuditsByCategory groups by the requesting category, skips passes and non-applicable audits", () => {
  const lh = {
    categories: {
      seo: { auditRefs: [{ id: "document-title" }, { id: "meta-description" }, { id: "canonical" }] },
      "best-practices": { auditRefs: [{ id: "is-on-https" }, { id: "deprecations" }] },
    },
    audits: {
      "document-title": { id: "document-title", title: "Has a title", score: 1 },
      "meta-description": { id: "meta-description", title: "No meta description", score: 0 },
      canonical: { id: "canonical", title: "Canonical", score: null, scoreDisplayMode: "notApplicable" },
      "is-on-https": { id: "is-on-https", title: "Uses HTTPS", score: 0.5 },
      deprecations: { id: "deprecations", title: "Deprecated APIs", score: null, scoreDisplayMode: "informative" },
    },
  };
  const failed = failedAuditsByCategory(lh);
  assert.deepEqual(Object.keys(failed), ["seo", "best-practices"]);
  assert.deepEqual(failed.seo, [{ id: "meta-description", title: "No meta description", score: 0 }]);
  assert.equal(failed["best-practices"][0].id, "is-on-https");
  assert.deepEqual(failedAuditsByCategory(undefined), {});
});

test("cruxRating applies Google's thresholds and stays silent for metrics without one", () => {
  assert.equal(cruxRating("lcpMs", 2500), "good");
  assert.equal(cruxRating("lcpMs", 2501), "needs-improvement");
  assert.equal(cruxRating("lcpMs", 4001), "poor");
  assert.equal(cruxRating("cls", 0.1), "good");
  assert.equal(cruxRating("rttMs", 85), null);
  assert.equal(cruxRating("lcpMs", null), null);
});

test("diagnoseLcp names the dominant sub-part and ignores missing ones", () => {
  const d = diagnoseLcp({ ttfbMs: 458, resourceLoadDelayMs: 257, resourceLoadDurationMs: 89, elementRenderDelayMs: 206 });
  assert.equal(d.dominant, "ttfbMs");
  assert.equal(d.shares.ttfbMs, 0.453);
  assert.match(d.advice, /Server response/);
  const render = diagnoseLcp({ ttfbMs: 100, resourceLoadDelayMs: null, resourceLoadDurationMs: 50, elementRenderDelayMs: 900 });
  assert.equal(render.dominant, "elementRenderDelayMs");
  assert.equal(Object.keys(render.shares).length, 3);
  assert.deepEqual(diagnoseLcp({ ttfbMs: null }), { dominant: null, shares: {}, advice: null });
});

test("hostFromProperty and waybackCdxUrl build a CDX query from any property form", () => {
  assert.equal(hostFromProperty("sc-domain:example.com"), "example.com");
  assert.equal(hostFromProperty("https://www.example.com/es/"), "example.com");
  const u = new URL(waybackCdxUrl("sc-domain:example.com", 500, 2015));
  assert.equal(u.origin + u.pathname, "https://web.archive.org/cdx/search/cdx");
  assert.equal(u.searchParams.get("url"), "example.com");
  assert.equal(u.searchParams.get("matchType"), "domain");
  assert.equal(u.searchParams.get("collapse"), "urlkey");
  assert.equal(u.searchParams.get("filter"), "statuscode:200");
  assert.equal(u.searchParams.get("limit"), "500");
  assert.equal(u.searchParams.get("from"), "2015");
});

test("parseCdxRows drops the header row, assets and off-host captures, keeping the newest capture per path", () => {
  const rows = [
    ["original", "timestamp"],
    ["http://example.com/blog/post/", "20180101000000"],
    ["https://www.example.com/blog/post", "20200101000000"],
    ["http://example.com/wp-content/uploads/a.jpg", "20190101000000"],
    ["http://example.com/logo.png", "20190101000000"],
    ["http://other.org/page", "20190101000000"],
    ["http://es.example.com/guia/", "20170101000000"],
    ["not a url", "20190101000000"],
  ];
  const out = parseCdxRows(rows, "sc-domain:example.com");
  assert.deepEqual(out.map((x) => new URL(x.url).pathname), ["/blog/post", "/guia/"]);
  assert.equal(out[0].lastCapture, "20200101000000");
  assert.deepEqual(parseCdxRows([], "example.com"), []);
  assert.deepEqual(parseCdxRows({ error: "x" }, "example.com"), []);
});

test("parseWikipediaUrl reads language and title, and rejects other URLs", () => {
  assert.deepEqual(parseWikipediaUrl("https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla"), { language: "es", title: "Real Alcázar de Sevilla" });
  assert.deepEqual(parseWikipediaUrl("https://en.m.wikipedia.org/wiki/Seville"), { language: "en", title: "Seville" });
  assert.equal(parseWikipediaUrl("https://example.com/wiki/Seville"), null);
  assert.equal(parseWikipediaUrl("Real Alcázar"), null);
});

test("summarizePageviews totals, peaks, year-over-year and seasonality", () => {
  const items = [];
  for (let i = 0; i < 24; i++) {
    const month = (i % 12) + 1;
    // second year is 10% up, and April is always the strongest month
    items.push({ timestamp: `${2024 + Math.floor(i / 12)}${String(month).padStart(2, "0")}0100`, views: (month === 4 ? 200 : 100) * (i < 12 ? 1 : 1.1) });
  }
  const s = summarizePageviews(items);
  assert.equal(s.months.length, 24);
  assert.equal(s.months[0].month, "2024-01");
  assert.equal(s.yoyPct, 10);
  assert.equal(s.peak.month, "2025-04");
  assert.equal(s.strongestMonths[0].month, "04");
  assert.equal(s.lastMonth.month, "2025-12");
  assert.equal(summarizePageviews([]).yoyPct, null);
});
