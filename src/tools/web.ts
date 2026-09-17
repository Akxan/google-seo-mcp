/**
 * Page-level checks that need no Google authorization:
 * page_audit, pagespeed, sitemap_check, robots_check.
 */
import { gunzipSync } from "node:zlib";
import { envValue } from "../env.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import { imageSize, disableTypes } from "image-size";

// Same advisories as in crawl.ts (GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq): favicon bytes come from
// whatever host is being audited, so the parsers that can loop forever on crafted input stay off.
disableTypes(["icns", "jxl", "jxl-stream", "heif"]);
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { heartbeat, round, tool } from "../util.js";

const UA = "Mozilla/5.0 (compatible; google-seo-mcp/0.1; +https://github.com/Akxan/google-seo-mcp)";

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "*/*", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** Follow redirects manually so the chain can be reported. */
async function fetchFollow(url: string, maxHops = 6): Promise<{ response: Response; chain: { url: string; status: number }[] }> {
  const chain: { url: string; status: number }[] = [];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchWithTimeout(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      chain.push({ url: current, status: res.status });
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return { response: res, chain };
  }
  throw new Error(`Too many redirects starting at ${url}`);
}

export async function collectSitemapUrls(sitemapUrl: string, opts: { maxSitemaps?: number; maxUrls?: number } = {}) {
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const maxUrls = opts.maxUrls ?? 50_000;
  const urls: { loc: string; lastmod?: string; sitemap: string; alternates?: { hreflang: string; href: string }[] }[] = [];
  const sitemaps: { url: string; type: "index" | "urlset" | "error"; count: number; error?: string }[] = [];
  const queue = [sitemapUrl];
  const seen = new Set<string>();
  while (queue.length && sitemaps.length < maxSitemaps && urls.length < maxUrls) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await fetchWithTimeout(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let body: string;
      const buf = Buffer.from(await res.arrayBuffer());
      body = u.endsWith(".gz") || res.headers.get("content-type")?.includes("gzip") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      if (/<sitemapindex/i.test(body)) {
        const children = [...body.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
        sitemaps.push({ url: u, type: "index", count: children.length });
        queue.push(...children);
      } else {
        const entries = [...body.matchAll(/<url>([\s\S]*?)<\/url>/gi)];
        let n = 0;
        for (const e of entries) {
          const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(e[1])?.[1];
          if (!loc) continue;
          const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(e[1])?.[1];
          // Multilingual plugins (Polylang, WPML, some Astro integrations) put hreflang in the sitemap instead of the HTML.
          const alternates = /hreflang/i.test(e[1]) ? parseSitemapAlternates(e[1]) : undefined;
          urls.push({ loc: decodeXml(loc), lastmod, sitemap: u, ...(alternates?.length ? { alternates } : {}) });
          n++;
          if (urls.length >= maxUrls) break;
        }
        sitemaps.push({ url: u, type: "urlset", count: n });
      }
    } catch (err) {
      sitemaps.push({ url: u, type: "error", count: 0, error: (err as Error).message });
    }
  }
  return { sitemaps, urls, truncated: queue.length > 0 || urls.length >= maxUrls };
}

/** `<xhtml:link rel="alternate" hreflang="es" href="..."/>` entries inside one `<url>` block of a sitemap. */
export function parseSitemapAlternates(urlBlock: string): { hreflang: string; href: string }[] {
  const out: { hreflang: string; href: string }[] = [];
  for (const m of urlBlock.matchAll(/<(?:[a-z0-9]+:)?link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    const hreflang = /hreflang\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (hreflang && href) out.push({ hreflang: hreflang.trim().toLowerCase(), href: decodeXml(href.trim()) });
  }
  return out;
}

/** Parse an HTTP `Link:` header into its entries: `<https://example.com/en/>; rel="alternate"; hreflang="en"`. */
export function parseLinkHeader(header: string | null | undefined): { url: string; params: Record<string, string> }[] {
  if (!header) return [];
  const out: { url: string; params: Record<string, string> }[] = [];
  // Split on commas that separate entries (a comma inside <...> or "..." belongs to the value).
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const p of m[2].split(";")) {
      const kv = /^\s*([a-z*-]+)\s*=\s*("([^"]*)"|[^;]*)\s*$/i.exec(p);
      if (kv) params[kv[1].toLowerCase()] = (kv[3] ?? kv[2] ?? "").trim();
    }
    out.push({ url: m[1].trim(), params });
  }
  return out;
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/* ---------- robots.txt ---------- */

interface RobotsGroup { agents: string[]; rules: { type: "allow" | "disallow"; path: string }[] }

export function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (current) current.rules.push({ type: key, path: val });
      lastWasAgent = false;
    } else if (key === "sitemap") {
      sitemaps.push(val);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function robotsPatternToRegex(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp("^" + re);
}

export function robotsAllows(parsed: ReturnType<typeof parseRobots>, url: string, userAgent = "googlebot") {
  const path = (() => { const u = new URL(url); return u.pathname + u.search; })();
  const ua = userAgent.toLowerCase();
  let group = parsed.groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!group) group = parsed.groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matchedRule: null, group: null };
  let best: { type: "allow" | "disallow"; path: string } | null = null;
  for (const r of group.rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    if (robotsPatternToRegex(r.path).test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === "allow")) best = r;
    }
  }
  return { allowed: !best || best.type === "allow", matchedRule: best, group: group.agents };
}

/** All @type values declared in a page's JSON-LD blocks (including @graph nodes); "(invalid JSON-LD)" marks unparsable blocks. */
export function extractJsonLdTypes($: cheerio.CheerioAPI): string[] {
  const types: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n: unknown) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === "object") {
          const t = (n as { "@type"?: unknown })["@type"];
          if (t) types.push(...(Array.isArray(t) ? t : [t]).map(String));
          if ((n as { "@graph"?: unknown })["@graph"]) walk((n as { "@graph"?: unknown })["@graph"]);
        }
      };
      walk(JSON.parse($(el).text()));
    } catch { types.push("(invalid JSON-LD)"); }
  });
  return types;
}

/* ---------- favicon ---------- */

export interface IconLink { rel: string; href: string; sizes?: string; type?: string; px: number | null }

/** Largest square edge declared in a `sizes` attribute ("16x16 32x32" -> 32). "any" (scalable SVG) wins over any pixel size. */
export function sizesToPx(sizes?: string): number | null {
  if (!sizes) return null;
  if (/\bany\b/i.test(sizes)) return Number.MAX_SAFE_INTEGER;
  const found = [...sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)].map((m) => Math.min(Number(m[1]), Number(m[2])));
  return found.length ? Math.max(...found) : null;
}

/** Icon-related <link>/<meta> declarations of a page, hrefs resolved against the page URL. */
export function collectIcons($: cheerio.CheerioAPI, pageUrl: string): { icons: IconLink[]; appleTouchIcons: IconLink[]; manifest: string | null; themeColor: string | null } {
  const abs = (h?: string) => { try { return h ? new URL(h.trim(), pageUrl).toString() : null; } catch { return null; } };
  const icons: IconLink[] = [];
  const appleTouchIcons: IconLink[] = [];
  $("link[rel][href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").trim().toLowerCase();
    const href = abs($(el).attr("href"));
    if (!href) return;
    const tokens = rel.split(/\s+/);
    const sizes = $(el).attr("sizes")?.trim();
    const entry: IconLink = { rel, href, sizes, type: $(el).attr("type")?.trim(), px: sizesToPx(sizes) };
    if (tokens.includes("icon") || tokens.includes("shortcut") || tokens.includes("mask-icon")) icons.push(entry);
    else if (tokens.some((t) => t.startsWith("apple-touch-icon"))) appleTouchIcons.push(entry);
  });
  return { icons, appleTouchIcons, manifest: abs($('link[rel~="manifest"]').first().attr("href")), themeColor: $('meta[name="theme-color"]').first().attr("content")?.trim() ?? null };
}

/**
 * The icon Google would use for the mobile result: the largest declared rel=icon (>=48 px preferred),
 * then apple-touch-icon, then the implicit /favicon.ico.
 */
export function pickFavicon(found: { icons: IconLink[]; appleTouchIcons: IconLink[] }, pageUrl: string): { url: string; source: string; declaredPx: number | null } {
  const best = (list: IconLink[]) => [...list].sort((a, b) => (b.px ?? 0) - (a.px ?? 0))[0];
  const big = best(found.icons.filter((i) => (i.px ?? 0) >= 48));
  const icon = big ?? best(found.icons) ?? best(found.appleTouchIcons);
  if (icon) return { url: icon.href, source: `<link rel="${icon.rel}">`, declaredPx: icon.px === Number.MAX_SAFE_INTEGER ? null : icon.px };
  return { url: new URL("/favicon.ico", pageUrl).toString(), source: "implicit /favicon.ico", declaredPx: null };
}

/** Fetch the chosen favicon and judge it against Google's requirements (square, >=48x48, crawlable). */
async function verifyFavicon(candidate: { url: string; source: string; declaredPx: number | null }, origin: string) {
  const issues: string[] = [];
  let status = 0, contentType: string | null = null, bytes = 0;
  let width: number | null = null, height: number | null = null, format: string | null = null;
  // An inline data: icon (a common "disable the favicon" trick) can never be crawled or shown by Google.
  if (/^data:/i.test(candidate.url)) return { ...candidate, status: null, contentType: null, bytes: null, width, height, format, crawlable: null, issues: ["Favicon is declared as an inline data: URI; Google needs a crawlable file URL (e.g. /favicon.ico or /icon-192.png)"] };
  try {
    const res = await fetchWithTimeout(candidate.url, {}, 15_000);
    status = res.status;
    contentType = res.headers.get("content-type");
    const buf = Buffer.from(await res.arrayBuffer());
    bytes = buf.length;
    if (status !== 200) issues.push(`Favicon ${candidate.url} returns HTTP ${status}: Google shows a generic globe instead`);
    else {
      try { const d = imageSize(buf); width = d.width ?? null; height = d.height ?? null; format = d.type ?? null; } catch { /* unreadable format */ }
      if (format === "svg") { /* scalable: no size check */ }
      else if (width && height) {
        if (width !== height) issues.push(`Favicon is ${width}x${height}, not square; Google requires a square icon`);
        else if (width < 48) issues.push(`Favicon is ${width}x${width}; Google wants at least 48x48 (a multiple of 48) for the mobile result icon`);
      } else issues.push("Could not read the favicon's dimensions (unsupported format?)");
    }
  } catch (e) { issues.push(`Favicon fetch failed: ${(e as Error).message}`); }
  // Google fetches the favicon with Googlebot and Googlebot-Image; a robots.txt block hides it from the SERP.
  let crawlable: { googlebot: boolean; googlebotImage: boolean } | null = null;
  try {
    const r = await fetchWithTimeout(`${origin}/robots.txt`, {}, 10_000);
    if (r.ok) {
      const parsed = parseRobots(await r.text());
      crawlable = { googlebot: robotsAllows(parsed, candidate.url, "googlebot").allowed, googlebotImage: robotsAllows(parsed, candidate.url, "googlebot-image").allowed };
      if (!crawlable.googlebot || !crawlable.googlebotImage) issues.push(`robots.txt blocks the favicon for ${!crawlable.googlebot ? "Googlebot" : ""}${!crawlable.googlebot && !crawlable.googlebotImage ? " and " : ""}${!crawlable.googlebotImage ? "Googlebot-Image" : ""}`);
    }
  } catch { /* ignore */ }
  return { ...candidate, status, contentType, bytes, width, height, format, crawlable, issues };
}

export interface AuditOptions { maxHeadings?: number; maxImagesMissingAlt?: number; checkFavicon?: boolean }
export type AuditResult = Awaited<ReturnType<typeof auditPage>>;

/** Core of page_audit, reused by site_crawl and compare_pages. */
export async function auditPage(url: string, opts: AuditOptions = {}) {
  const a = { url, maxHeadings: opts.maxHeadings ?? 60, maxImagesMissingAlt: opts.maxImagesMissingAlt ?? 20, checkFavicon: opts.checkFavicon ?? false };
  const t0 = Date.now();
  const { response, chain } = await fetchFollow(a.url);
  const html = await response.text();
  const ms = Date.now() - t0;
  const finalUrl = response.url || (chain.length ? undefined : a.url) || a.url;
  const $ = cheerio.load(html);
  const base = new URL(finalUrl);
  const text = (sel: string) => $(sel).first().text().trim();
  const attr = (sel: string, n: string) => $(sel).first().attr(n)?.trim();

  const title = text("title");
  const description = attr('meta[name="description"]', "content") ?? "";
  const metaRobots = attr('meta[name="robots"]', "content") ?? "";
  const xRobots = response.headers.get("x-robots-tag") ?? "";
  const canonical = attr('link[rel="canonical"]', "href");
  const canonicalAbs = canonical ? new URL(canonical, finalUrl).toString() : undefined;
  const lang = $("html").attr("lang");
  const hreflang = $('link[rel="alternate"][hreflang]').map((_, el) => ({ hreflang: $(el).attr("hreflang"), href: $(el).attr("href") })).get();
  const og = Object.fromEntries($('meta[property^="og:"]').map((_, el) => [[$(el).attr("property"), $(el).attr("content")]]).get());
  const feeds = $('link[rel~="alternate"][href][type*="rss"], link[rel~="alternate"][href][type*="atom"]').map((_, el) => { try { return { title: $(el).attr("title"), href: new URL($(el).attr("href")!, finalUrl).toString() }; } catch { return null; } }).get().filter(Boolean);
  const iconLinks = collectIcons($, finalUrl);
  const faviconPick = pickFavicon(iconLinks, finalUrl);
  const favicon = a.checkFavicon ? await verifyFavicon(faviconPick, base.origin) : { ...faviconPick, issues: [] as string[] };
  const headings = $("h1, h2, h3").map((_, el) => ({ tag: el.tagName.toLowerCase(), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 160) })).get();
  const h1s = headings.filter((h) => h.tag === "h1");
  const imgs = $("img").toArray();
  // `alt=""` is the correct markup for decorative images (WCAG, Google): only a *missing* attribute is a defect.
  const missingAlt = imgs.filter((el) => $(el).attr("alt") === undefined).map((el) => $(el).attr("src") ?? $(el).attr("data-src") ?? "(no src)");
  const decorative = imgs.filter((el) => ($(el).attr("alt") ?? "x").trim() === "").length;
  let internal = 0, external = 0, nofollow = 0;
  const internalUrls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")!.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    let u: URL;
    try { u = new URL(href, finalUrl); } catch { return; }
    if (u.hostname === base.hostname) { internal++; internalUrls.add(u.pathname); } else external++;
    if (/\bnofollow\b/i.test($(el).attr("rel") ?? "")) nofollow++;
  });
  // Read JSON-LD before scripts are stripped for the word count (stripping first hid every schema block).
  const jsonLdTypes = extractJsonLdTypes($);
  $("script, style, noscript, template").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;

  const issues: { severity: "error" | "warning" | "info"; message: string }[] = [];
  const add = (severity: "error" | "warning" | "info", message: string) => issues.push({ severity, message });
  if (response.status !== 200) add("error", `HTTP status ${response.status}`);
  if (chain.length) add("info", `Reached via ${chain.length} redirect(s): ${chain.map((c) => `${c.status} ${c.url}`).join(" -> ")}`);
  if (!title) add("error", "Missing <title>");
  else if (title.length > 60) add("warning", `Title is ${title.length} chars (aim for 30-60)`);
  else if (title.length < 30) add("info", `Title is short (${title.length} chars)`);
  if (!description) add("warning", "Missing meta description");
  else if (description.length > 160) add("warning", `Meta description is ${description.length} chars (aim for 120-155)`);
  else if (description.length < 70) add("info", `Meta description is short (${description.length} chars)`);
  if (/noindex/i.test(metaRobots) || /noindex/i.test(xRobots)) add("error", "Page is noindex");
  if (!canonicalAbs) add("warning", "No canonical link");
  else if (canonicalAbs.replace(/\/$/, "") !== finalUrl.replace(/\/$/, "")) add("warning", `Canonical points elsewhere: ${canonicalAbs}`);
  if (h1s.length === 0) add("warning", "No H1");
  else if (h1s.length > 1) add("warning", `${h1s.length} H1 tags`);
  if (missingAlt.length) add("warning", `${missingAlt.length} of ${imgs.length} images have no alt text`);
  if (wordCount < 300) add("info", `Thin content: ${wordCount} words`);
  if (!lang) add("info", "No lang attribute on <html>");
  if (!$('meta[name="viewport"]').length) add("warning", "No viewport meta tag");
  if (!jsonLdTypes.length) add("info", "No JSON-LD structured data");
  if (a.checkFavicon) {
    if (!iconLinks.icons.length && !iconLinks.appleTouchIcons.length) add("info", "No <link rel=icon>: Google falls back to /favicon.ico");
    for (const m of favicon.issues) add("warning", m);
  }

  return {
    requestedUrl: a.url,
    finalUrl,
    status: response.status,
    redirectChain: chain,
    fetchMs: ms,
    htmlBytes: Buffer.byteLength(html),
    contentType: response.headers.get("content-type"),
    title: { text: title, length: title.length },
    metaDescription: { text: description, length: description.length },
    robots: { meta: metaRobots || null, header: xRobots || null },
    canonical: canonicalAbs ?? null,
    lang: lang ?? null,
    hreflang,
    openGraph: og,
    feeds,
    favicon: { ...favicon, declared: iconLinks.icons.map((i) => ({ rel: i.rel, href: i.href, sizes: i.sizes, type: i.type })), appleTouchIcon: iconLinks.appleTouchIcons[0]?.href ?? null, manifest: iconLinks.manifest, themeColor: iconLinks.themeColor },
    headings: { h1Count: h1s.length, h2Count: headings.filter((h) => h.tag === "h2").length, h3Count: headings.filter((h) => h.tag === "h3").length, outline: headings.slice(0, a.maxHeadings) },
    images: { total: imgs.length, missingAlt: missingAlt.length, missingAltSamples: missingAlt.slice(0, a.maxImagesMissingAlt), decorativeEmptyAlt: decorative },
    links: { internal, internalUnique: internalUrls.size, external, nofollow },
    wordCount,
    structuredData: [...new Set(jsonLdTypes)],
    issues,
  };
}

/* ---------- registration ---------- */

/** One host/scheme variant: follow redirects manually so the whole chain is visible. */
export async function traceRedirects(url: string, maxHops = 6): Promise<{ start: string; hops: { url: string; status: number; location?: string }[]; final: string; finalStatus: number; error?: string }> {
  const hops: { url: string; status: number; location?: string }[] = [];
  let current = url;
  try {
    for (let i = 0; i < maxHops; i++) {
      const res = await fetchWithTimeout(current, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; google-seo-mcp canonical check)" } }, 15_000);
      const location = res.headers.get("location") ?? undefined;
      hops.push({ url: current, status: res.status, location });
      if (res.status >= 300 && res.status < 400 && location) { current = new URL(location, current).toString(); continue; }
      return { start: url, hops, final: current, finalStatus: res.status };
    }
    return { start: url, hops, final: current, finalStatus: 0, error: `more than ${maxHops} redirects` };
  } catch (e) {
    return { start: url, hops, final: current, finalStatus: 0, error: (e as Error).message };
  }
}

/* ---------- PageSpeed Insights helpers ---------- */

/**
 * One CrUX block of a PSI response (page-level `loadingExperience` or site-level `originLoadingExperience`).
 * CrUX reports CLS as an integer scaled by 100 (5 = 0.05), so it is scaled back here.
 */
export function extractFieldData(exp?: PsiLoadingExperience) {
  if (!exp || (!exp.metrics && !exp.overall_category)) return null;
  const m = exp.metrics ?? {};
  const pick = (k: string, scale = 1) => (m[k] ? { p75: round(m[k].percentile * scale, 3), category: m[k].category } : null);
  return {
    overall: exp.overall_category ?? null,
    lcp: pick("LARGEST_CONTENTFUL_PAINT_MS"),
    inp: pick("INTERACTION_TO_NEXT_PAINT"),
    cls: pick("CUMULATIVE_LAYOUT_SHIFT_SCORE", 0.01),
    fcp: pick("FIRST_CONTENTFUL_PAINT_MS"),
    ttfb: pick("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
  };
}

/** Failed audits grouped by the Lighthouse category that references them (only the categories PSI was asked for exist in the response). */
export function failedAuditsByCategory(lh: PsiResponse["lighthouseResult"], max = 20): Record<string, { id: string; title: string; score: number | null }[]> {
  const audits = Object.values(lh?.audits ?? {});
  const out: Record<string, { id: string; title: string; score: number | null }[]> = {};
  for (const [name, cat] of Object.entries(lh?.categories ?? {})) {
    const refs = new Set((cat.auditRefs ?? []).map((r) => r.id));
    const failed = audits
      .filter((x) => refs.has(x.id) && typeof x.score === "number" && x.score < 1 && x.scoreDisplayMode !== "notApplicable" && x.scoreDisplayMode !== "informative" && x.scoreDisplayMode !== "manual")
      .sort((x, y) => (x.score ?? 0) - (y.score ?? 0))
      .slice(0, max)
      .map((x) => ({ id: x.id, title: x.title, score: x.score ?? null }));
    if (failed.length) out[name] = failed;
  }
  return out;
}

export function registerWebTools(server: McpServer) {
  server.registerTool(
    "page_audit",
    {
      title: "On-page SEO audit of a URL",
      description:
        "Fetch a page like a crawler and report: final URL and redirect chain, status, title, meta description, robots (meta + X-Robots-Tag), canonical, lang/hreflang, Open Graph, RSS/Atom feeds, favicon (declared icons, apple-touch-icon, manifest, theme-color, and a live check that it is square, >=48x48 and crawlable by Googlebot/Googlebot-Image, which is what the mobile result icon needs), H1/H2/H3 outline, images missing alt, internal/external/nofollow link counts, word count, JSON-LD schema types, HTML size and fetch time, plus a list of flagged issues. Works for any site, no authorization needed.",
      inputSchema: {
        url: z.string().url(),
        maxHeadings: z.number().int().min(0).max(200).default(60).describe("How many H1-H3 headings to include in the outline."),
        maxImagesMissingAlt: z.number().int().min(0).max(200).default(20),
        checkFavicon: z.boolean().default(true).describe("Fetch the favicon and robots.txt to verify size, shape and crawlability (2 extra requests)."),
      },
    },
    tool(async (a) => auditPage(a.url, a)),
  );

  server.registerTool(
    "pagespeed",
    {
      title: "PageSpeed Insights / Core Web Vitals",
      description:
        "Run Google PageSpeed Insights for a URL. Returns Lighthouse category scores (performance, SEO, accessibility, best practices), lab metrics (LCP, CLS, TBT, FCP, Speed Index), real-user CrUX data for the page and for the whole origin (LCP, INP, CLS, FCP, TTFB), so low-traffic pages still get field numbers, the failed audits of every requested category, and the top opportunities with estimated savings. Set PAGESPEED_API_KEY for a higher quota. Each run takes 15-60 s; Google caches results for a short while, so if a call times out simply call again. A 'Lighthouse returned error' after retry usually means the page never becomes idle (endless animations/JS) and cannot be audited by PSI.",
      inputSchema: {
        url: z.string().url(),
        strategy: z.enum(["mobile", "desktop", "both"]).default("mobile"),
        categories: z.array(z.enum(["performance", "seo", "accessibility", "best-practices"])).default(["performance", "seo"]),
        topOpportunities: z.number().int().min(0).max(20).default(8),
        locale: z.string().optional().describe("Language of the audit titles and descriptions, e.g. 'es', 'en', 'pt-BR'. Default 'en'."),
        maxFailedAudits: z.number().int().min(0).max(50).default(15).describe("Failed audits to list per category."),
      },
    },
    tool(async (a, extra) => {
      const stop = heartbeat(extra, "waiting for PageSpeed Insights");
      try {
      const run = async (strategy: "mobile" | "desktop") => {
        const params = new URLSearchParams({ url: a.url, strategy });
        for (const c of a.categories) params.append("category", c);
        if (a.locale) params.set("locale", a.locale);
        const psiKey = envValue("PAGESPEED_API_KEY");
          if (psiKey) params.set("key", psiKey);
        const fetchOnce = async () => {
          const res = await fetchWithTimeout(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {}, 150_000);
          const data = (await res.json()) as PsiResponse;
          if (!res.ok || data.error) throw new Error(`PageSpeed API: ${data.error?.message ?? `HTTP ${res.status}`}`);
          return data;
        };
        let data: PsiResponse;
        try {
          data = await fetchOnce();
        } catch (err) {
          if (!/Lighthouse returned error|Something went wrong|HTTP 5\d\d/.test((err as Error).message)) throw err;
          data = await fetchOnce(); // one retry for transient Lighthouse failures
        }
        const lh = data.lighthouseResult;
        const audits = lh?.audits ?? {};
        const num = (id: string) => audits[id]?.numericValue;
        const opportunities = Object.values(audits)
          .filter((x) => x.details?.type === "opportunity" && (x.details.overallSavingsMs ?? 0) > 0)
          .sort((x, y) => (y.details?.overallSavingsMs ?? 0) - (x.details?.overallSavingsMs ?? 0))
          .slice(0, a.topOpportunities)
          .map((x) => ({ id: x.id, title: x.title, savingsMs: Math.round(x.details?.overallSavingsMs ?? 0), score: x.score }));
        const originFallback = Boolean(data.loadingExperience?.origin_fallback);
        // PSI returns an empty loadingExperience (or origin_fallback) when the URL has too little CrUX traffic.
        const pageField = originFallback ? null : extractFieldData(data.loadingExperience);
        const originField = extractFieldData(data.originLoadingExperience);
        return {
          strategy,
          scores: Object.fromEntries(Object.entries(lh?.categories ?? {}).map(([k, v]) => [k, v.score == null ? null : Math.round(v.score * 100)])),
          lab: { lcpMs: Math.round(num("largest-contentful-paint") ?? -1), cls: round(num("cumulative-layout-shift"), 3), tbtMs: Math.round(num("total-blocking-time") ?? -1), fcpMs: Math.round(num("first-contentful-paint") ?? -1), speedIndexMs: Math.round(num("speed-index") ?? -1) },
          // Page-level CrUX is empty for low-traffic URLs; the origin block covers the whole site.
          field: pageField,
          fieldOrigin: originField,
          fieldNote: pageField ? undefined : originField ? "No page-level field data (too little CrUX traffic for this URL); fieldOrigin is the site-wide real-user data." : "No CrUX field data for this URL or its origin (too little Chrome traffic); only the lab metrics apply.",
          opportunities,
          failedAudits: failedAuditsByCategory(lh, a.maxFailedAudits),
          lighthouseVersion: lh?.lighthouseVersion,
          locale: lh?.configSettings?.locale,
        };
      };
      const strategies: ("mobile" | "desktop")[] = a.strategy === "both" ? ["mobile", "desktop"] : [a.strategy];
      const results = await Promise.all(strategies.map(run));
      return { url: a.url, results };
      } finally {
        stop();
      }
    }),
  );

  server.registerTool(
    "sitemap_check",
    {
      title: "Sitemap fetch and URL health check",
      description:
        "Fetch a sitemap (sitemap index supported, .gz supported), list its URLs, and check the HTTP status of a sample (or all) of them to find 404s, redirects and server errors. Pass a site root to auto-discover the sitemap from robots.txt or /sitemap.xml.",
      inputSchema: {
        url: z.string().url().describe("Sitemap URL, or the site root (e.g. https://example.com/) to auto-discover."),
        sampleSize: z.number().int().min(0).max(500).default(50).describe("How many URLs to status-check (0 = list only). Sampled evenly across the sitemap."),
        checkAll: z.boolean().default(false).describe("Check every URL (capped at 500)."),
        listUrls: z.boolean().default(false).describe("Include the full URL list in the response."),
        concurrency: z.number().int().min(1).max(10).default(5),
      },
    },
    tool(async (a) => {
      let sitemapUrl = a.url;
      const u = new URL(a.url);
      if (u.pathname === "/" || u.pathname === "") {
        let found: string | undefined;
        try {
          const robots = await fetchWithTimeout(new URL("/robots.txt", u).toString());
          if (robots.ok) found = parseRobots(await robots.text()).sitemaps[0];
        } catch { /* ignore */ }
        sitemapUrl = found ?? new URL("/sitemap.xml", u).toString();
      }
      const { sitemaps, urls, truncated } = await collectSitemapUrls(sitemapUrl);
      const n = a.checkAll ? Math.min(urls.length, 500) : Math.min(a.sampleSize, urls.length);
      const step = n ? urls.length / n : 0;
      const sample = n ? Array.from({ length: n }, (_, i) => urls[Math.floor(i * step)]) : [];
      const checked = await mapLimit(sample, a.concurrency, async (entry) => {
        try {
          let res = await fetchWithTimeout(entry.loc, { method: "HEAD", redirect: "manual" }, 15_000);
          if (res.status === 405 || res.status === 403) res = await fetchWithTimeout(entry.loc, { method: "GET", redirect: "manual" }, 15_000);
          return { url: entry.loc, status: res.status, location: res.headers.get("location") ?? undefined };
        } catch (err) {
          return { url: entry.loc, status: 0, error: (err as Error).message };
        }
      });
      const statusCounts: Record<string, number> = {};
      for (const c of checked) statusCounts[String(c.status)] = (statusCounts[String(c.status)] ?? 0) + 1;
      const problems = checked.filter((c) => c.status !== 200);
      const lastmods = urls.map((x) => x.lastmod).filter(Boolean).sort();
      return {
        sitemapUrl,
        sitemaps,
        totalUrls: urls.length,
        truncated,
        lastmodRange: lastmods.length ? { oldest: lastmods[0], newest: lastmods[lastmods.length - 1], withLastmod: lastmods.length } : null,
        checked: checked.length,
        statusCounts,
        problems,
        urls: a.listUrls ? urls.map((x) => x.loc) : undefined,
      };
    }),
  );

  server.registerTool(
    "canonical_host_check",
    {
      title: "Canonical host check (www, https, trailing slash)",
      description:
        "Check that every way of typing the home page ends at one single address: http and https, www and bare domain, and the trailing-slash variants. When two of them both answer 200, Google sees duplicate sites and splits the ranking signals between them. This is a common silent failure on Cloudflare Pages and after a WordPress migration. Returns the full redirect chain for each variant and says which ones are wrong. No key needed.",
      inputSchema: {
        domain: z.string().describe("Bare domain, e.g. 'example.com' (do not include a scheme)."),
        path: z.string().default("/").describe("Path to test, default the home page."),
      },
    },
    tool(async (a) => {
      const host = a.domain.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
      const path = a.path.startsWith("/") ? a.path : `/${a.path}`;
      const variants = [`http://${host}${path}`, `http://www.${host}${path}`, `https://${host}${path}`, `https://www.${host}${path}`];
      const traced = await Promise.all(variants.map((u) => traceRedirects(u)));
      const live = traced.filter((t) => t.finalStatus >= 200 && t.finalStatus < 300);
      const finals = [...new Set(live.map((t) => t.final))];
      const canonical = finals.length === 1 ? finals[0] : null;
      const problems: string[] = [];
      if (finals.length > 1) problems.push(`${finals.length} different addresses serve content: ${finals.join(" , ")}. Redirect all of them to one with a 301.`);
      for (const t of traced) {
        if (t.error) problems.push(`${t.start}: ${t.error}`);
        else if (t.finalStatus === 0) problems.push(`${t.start}: no response`);
        else if (t.finalStatus >= 400) problems.push(`${t.start}: ends at HTTP ${t.finalStatus}`);
        else if (t.start.startsWith("http://") && t.final.startsWith("http://")) problems.push(`${t.start} never upgrades to https`);
        else if (t.hops.filter((h) => h.status >= 300 && h.status < 400).length > 1) problems.push(`${t.start}: ${t.hops.length - 1} redirects before landing (each hop loses a little link equity; redirect straight to the final URL)`);
      }
      return { domain: host, path, canonical, ok: problems.length === 0, problems, variants: traced.map((t) => ({ from: t.start, chain: t.hops.map((h) => `${h.status}${h.location ? ` -> ${h.location}` : ""}`), final: t.final, finalStatus: t.finalStatus, error: t.error })) };
    }),
  );

  server.registerTool(
    "robots_check",
    {
      title: "robots.txt check",
      description: "Fetch a site's robots.txt, show its groups and sitemap lines, and test whether specific URLs are crawlable for a given user agent (default Googlebot) using Google's longest-match rules.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1).describe("URLs to test. robots.txt is fetched from the first URL's origin."),
        userAgent: z.string().default("Googlebot"),
      },
    },
    tool(async (a) => {
      const origin = new URL(a.urls[0]).origin;
      const res = await fetchWithTimeout(`${origin}/robots.txt`);
      if (res.status === 404) return { origin, robotsTxt: null, note: "No robots.txt (404): everything is crawlable", results: a.urls.map((url) => ({ url, allowed: true })) };
      if (!res.ok) throw new Error(`robots.txt returned HTTP ${res.status}`);
      const body = await res.text();
      const parsed = parseRobots(body);
      return {
        origin,
        groups: parsed.groups.map((g) => ({ agents: g.agents, rules: g.rules.length, disallow: g.rules.filter((r) => r.type === "disallow").map((r) => r.path), allow: g.rules.filter((r) => r.type === "allow").map((r) => r.path) })),
        sitemaps: parsed.sitemaps,
        userAgent: a.userAgent,
        results: a.urls.map((url) => ({ url, ...robotsAllows(parsed, url, a.userAgent) })),
      };
    }),
  );
}

export interface PsiLoadingExperience { overall_category?: string; origin_fallback?: boolean; metrics?: Record<string, { percentile: number; category: string }> }

export interface PsiResponse {
  error?: { message?: string };
  loadingExperience?: PsiLoadingExperience;
  originLoadingExperience?: PsiLoadingExperience;
  lighthouseResult?: {
    lighthouseVersion?: string;
    configSettings?: { locale?: string };
    categories?: Record<string, { score?: number | null; auditRefs?: { id: string }[] }>;
    audits?: Record<string, { id: string; title: string; score?: number | null; scoreDisplayMode?: string; numericValue?: number; details?: { type?: string; overallSavingsMs?: number } }>;
  };
}
