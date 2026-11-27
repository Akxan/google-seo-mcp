import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, extractJsonLdTypes, sizesToPx, collectIcons, pickFavicon, parseLinkHeader, parseSitemapAlternates, extractFieldData, failedAuditsByCategory, normalizeRobotsPath, robotsPathMatches, withCacheBuster, stripCacheBuster, cacheInfo, CACHE_BUST_PARAM, collectSitemapUrls, auditPage } from "../../dist/tools/web.js";
import http from "node:http";
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

test("robotsAllows picks the most specific group, not the first substring match (RFC 9309)", () => {
  const txt = "User-agent: Googlebot\nDisallow: /private/\n\nUser-agent: Googlebot-Image\nDisallow: /photos/\n\nUser-agent: *\nDisallow: /\n";
  const r = parseRobots(txt);
  // Googlebot-Image has its own group: Googlebot's rules do not apply to it.
  assert.equal(robotsAllows(r, "https://example.com/private/x", "googlebot-image").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/photos/a.jpg", "Googlebot-Image").allowed, false);
  assert.deepEqual(robotsAllows(r, "https://example.com/photos/a.jpg", "googlebot-image").group, ["googlebot-image"]);
  assert.equal(robotsAllows(r, "https://example.com/photos/a.jpg", "googlebot").allowed, true);
  // Without its own group, Googlebot-Image falls back to Googlebot's (what the favicon check relies on).
  const fallback = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private/\n");
  assert.equal(robotsAllows(fallback, "https://example.com/private/x", "googlebot-image").allowed, false);
  assert.equal(robotsAllows(fallback, "https://example.com/blog/", "googlebot-image").allowed, true);
  // A full UA string still finds its group; "*" is only the fallback for crawlers nothing names.
  assert.equal(robotsAllows(r, "https://example.com/private/x", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/blog/", "bingbot").allowed, false);
  // A short token does not capture a longer crawler name it happens to be inside.
  const bot = parseRobots("User-agent: bot\nDisallow: /\n");
  assert.equal(robotsAllows(bot, "https://example.com/", "googlebot").allowed, true);
  // Version suffixes and wildcards on the User-agent line are ignored, as Google does.
  assert.equal(robotsAllows(parseRobots("User-agent: GPTBot/1.0\nDisallow: /\n"), "https://example.com/", "gptbot").allowed, false);
  assert.equal(robotsAllows(parseRobots("User-agent: googlebot*\nDisallow: /x\n"), "https://example.com/x", "googlebot").allowed, false);
});

test("robotsAllows merges every group that names the same agent", () => {
  const r = parseRobots("User-agent: GPTBot\nDisallow: /a/\n\nUser-agent: *\nDisallow: /tmp/\n\nUser-agent: gptbot\nDisallow: /b/\nAllow: /a/public/\n");
  assert.equal(robotsAllows(r, "https://example.com/a/x", "gptbot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/b/x", "gptbot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/a/public/x", "gptbot").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/tmp/x", "gptbot").allowed, true); // * does not apply once named
  const stars = parseRobots("User-agent: *\nDisallow: /a/\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /b/\n");
  assert.equal(robotsAllows(stars, "https://example.com/b/x", "bingbot").allowed, false);
  assert.equal(robotsAllows(stars, "https://example.com/a/x", "bingbot").allowed, false);
});

test("robots rules and URL paths are compared in one percent-encoded form", () => {
  assert.equal(normalizeRobotsPath("/café"), "/caf%C3%A9");
  assert.equal(normalizeRobotsPath("/caf%c3%a9"), "/caf%C3%A9");
  assert.equal(normalizeRobotsPath("/foo/bar/%62%61%7A"), "/foo/bar/baz"); // RFC 9309 table: unreserved octets decoded
  assert.equal(normalizeRobotsPath("/a%2Fb?x=https%3a%2f%2f"), "/a%2Fb?x=https%3A%2F%2F"); // reserved ones stay encoded
  assert.equal(normalizeRobotsPath("/日本/*.pdf$"), "/%E6%97%A5%E6%9C%AC/*.pdf$");
  assert.equal(normalizeRobotsPath("/a b"), "/a%20b");
  assert.equal(normalizeRobotsPath("/x😀"), "/x%F0%9F%98%80");
  const r = parseRobots("User-agent: *\nDisallow: /café\nDisallow: /%E6%97%A5%E6%9C%AC/\nAllow: /caf%c3%a9/menu\n");
  assert.equal(robotsAllows(r, "https://example.com/café/", "googlebot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/caf%c3%a9/", "googlebot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/日本/page", "googlebot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/café/menu", "googlebot").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/cafe", "googlebot").allowed, true);
});

test("robots wildcards: * anywhere, $ only at the end, and no regex blow-up", () => {
  assert.equal(robotsPathMatches("/a/b.pdf", "/*.pdf$"), true);
  assert.equal(robotsPathMatches("/a/b.pdf?x=1", "/*.pdf$"), false);
  assert.equal(robotsPathMatches("/a/b.pdf?x=1", "/*.pdf"), true);
  assert.equal(robotsPathMatches("/fish", "/fish*"), true);
  assert.equal(robotsPathMatches("/Fish", "/fish"), false);
  assert.equal(robotsPathMatches("/a$b", "/a$b"), true); // a $ before the end is a literal character
  assert.equal(robotsPathMatches("/", "/$"), true);
  assert.equal(robotsPathMatches("/x", "/$"), false);
  const r = parseRobots("User-agent: *\nDisallow: /*.php$\nAllow: /index.php$\n");
  assert.equal(robotsAllows(r, "https://example.com/wp-login.php", "googlebot").allowed, false);
  assert.equal(robotsAllows(r, "https://example.com/index.php", "googlebot").allowed, true);
  assert.equal(robotsAllows(r, "https://example.com/wp-login.php?x", "googlebot").allowed, true);
  // A hostile rule that makes a backtracking regex take minutes is linear here.
  const t0 = Date.now();
  assert.equal(robotsPathMatches("/" + "a".repeat(3000), "/" + "*a".repeat(40) + "b"), false);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("cache-busting helpers add a parameter and strip it from everything shown", () => {
  const busted = withCacheBuster("https://example.com/a?q=b%20c#top", "T1");
  assert.equal(busted, `https://example.com/a?q=b%20c&${CACHE_BUST_PARAM}=T1#top`);
  assert.equal(withCacheBuster("https://example.com/", "T2"), `https://example.com/?${CACHE_BUST_PARAM}=T2`);
  assert.equal(stripCacheBuster(busted), "https://example.com/a?q=b%20c#top");
  assert.equal(stripCacheBuster(`https://example.com/?${CACHE_BUST_PARAM}=T2`), "https://example.com/");
  assert.equal(stripCacheBuster(`https://example.com/?${CACHE_BUST_PARAM}=T2&x=1`), "https://example.com/?x=1");
  assert.equal(stripCacheBuster(`https://example.com/?a=1&${CACHE_BUST_PARAM}=T2&x=1`), "https://example.com/?a=1&x=1");
  const deep = stripCacheBuster({ finalUrl: `https://example.com/?${CACHE_BUST_PARAM}=z`, chain: [{ url: `https://example.com/a?${CACHE_BUST_PARAM}=z`, status: 301 }], issues: [{ message: `Reached via 1 redirect(s): 301 https://example.com/a?${CACHE_BUST_PARAM}=z` }], n: 3, nil: null });
  assert.deepEqual(deep, { finalUrl: "https://example.com/", chain: [{ url: "https://example.com/a", status: 301 }], issues: [{ message: "Reached via 1 redirect(s): 301 https://example.com/a" }], n: 3, nil: null });
  assert.deepEqual(cacheInfo(new Headers({ "cf-cache-status": "HIT", age: "120", "x-cache": "Hit from cloudfront" }), true), { fresh: true, cfCacheStatus: "HIT", age: "120", xCache: "Hit from cloudfront", lastModified: null });
});

/** A loopback server for one test; handler(req, res, url). */
async function serve(handler) {
  const srv = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://x")));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("page_audit fresh busts caches, reports cache headers and never shows the parameter", async () => {
  const seen = [];
  const srv = await serve((req, res, u) => {
    seen.push({ url: req.url, cacheControl: req.headers["cache-control"] });
    if (u.pathname === "/old") { res.writeHead(301, { Location: `/new/${u.search}` }); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "cf-cache-status": "MISS", age: "0" });
    // A page that echoes the request URL into its canonical must not be flagged for it.
    res.end(`<html lang="en"><head><title>A title that is long enough to pass</title><link rel="canonical" href="${u.pathname}${u.search}"></head><body><h1>x</h1></body></html>`);
  });
  try {
    const r = await auditPage(`${srv.base}/old`, { fresh: true, maxHeadings: 5 });
    assert.ok(seen.every((s) => s.url.includes(CACHE_BUST_PARAM) && s.cacheControl === "no-cache"));
    assert.equal(r.requestedUrl, `${srv.base}/old`);
    assert.equal(r.finalUrl, `${srv.base}/new/`);
    assert.deepEqual(r.redirectChain, [{ url: `${srv.base}/old`, status: 301 }]);
    assert.equal(r.canonical, `${srv.base}/new/`);
    assert.deepEqual(r.cache, { fresh: true, cfCacheStatus: "MISS", age: "0", xCache: null, lastModified: null });
    assert.equal(JSON.stringify(r).includes(CACHE_BUST_PARAM), false);
    assert.ok(!r.issues.some((i) => /Canonical points elsewhere/.test(i.message)));
    seen.length = 0;
    const plain = await auditPage(`${srv.base}/new/`, { maxHeadings: 5 });
    assert.equal(seen[0].url, "/new/");
    assert.equal(seen[0].cacheControl, undefined);
    assert.equal(plain.cache.fresh, false);
    assert.equal(plain.cache.cfCacheStatus, "MISS");
  } finally { await srv.close(); }
});

test("collectSitemapUrls fetches child sitemaps 4 at a time, keeps index order and honours the limits", async () => {
  let inFlight = 0, peak = 0;
  const srv = await serve((_req, res, u) => {
    if (u.pathname === "/index.xml") {
      const kids = Array.from({ length: 7 }, (_, i) => `<sitemap><loc>${srv.base}/s${i}.xml</loc></sitemap>`).join("");
      return res.end(`<?xml version="1.0"?><sitemapindex>${kids}<sitemap><loc>${srv.base}/s0.xml</loc></sitemap></sitemapindex>`);
    }
    const m = /^\/s(\d)\.xml$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    const i = Number(m[1]);
    inFlight++; peak = Math.max(peak, inFlight);
    // Earlier sitemaps answer later, so completion order is the reverse of index order.
    setTimeout(() => {
      inFlight--;
      if (i === 3) { res.writeHead(500); return res.end(); }
      res.end(`<urlset>${[0, 1, 2].map((k) => `<url><loc>https://example.com/p${i}-${k}</loc></url>`).join("")}</urlset>`);
    }, 80 - i * 10);
  });
  try {
    const all = await collectSitemapUrls(`${srv.base}/index.xml`);
    assert.ok(peak > 1 && peak <= 4, `peak concurrency ${peak}`);
    assert.deepEqual(all.sitemaps.map((s) => [s.url.replace(srv.base, ""), s.type, s.count]), [["/index.xml", "index", 8], ["/s0.xml", "urlset", 3], ["/s1.xml", "urlset", 3], ["/s2.xml", "urlset", 3], ["/s3.xml", "error", 0], ["/s4.xml", "urlset", 3], ["/s5.xml", "urlset", 3], ["/s6.xml", "urlset", 3]]);
    assert.equal(all.urls.length, 18);
    assert.equal(all.urls[0].loc, "https://example.com/p0-0");
    assert.equal(all.urls[17].loc, "https://example.com/p6-2");
    assert.equal(all.truncated, false); // the duplicate s0 entry is skipped, not left over
    const capped = await collectSitemapUrls(`${srv.base}/index.xml`, { maxUrls: 7 });
    assert.deepEqual(capped.urls.map((x) => x.loc), ["https://example.com/p0-0", "https://example.com/p0-1", "https://example.com/p0-2", "https://example.com/p1-0", "https://example.com/p1-1", "https://example.com/p1-2", "https://example.com/p2-0"]);
    assert.deepEqual(capped.sitemaps.map((s) => s.count), [8, 3, 3, 1]);
    assert.equal(capped.truncated, true);
    const few = await collectSitemapUrls(`${srv.base}/index.xml`, { maxSitemaps: 3 });
    assert.deepEqual(few.sitemaps.map((s) => s.url.replace(srv.base, "")), ["/index.xml", "/s0.xml", "/s1.xml"]);
    assert.equal(few.truncated, true);
  } finally { await srv.close(); }
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
