/**
 * GEO (generative engine optimization) and advanced SEO checks:
 * ai_crawler_access, llms_txt_check, llms_txt_generate, structured_data_audit,
 * geo_page_score, eeat_audit, indexnow_submit, ai_citation_check.
 */
import { z } from "zod";
import * as cheerio from "cheerio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { round, tool } from "../util.js";
import { collectSitemapUrls, fetchWithTimeout, parseRobots, robotsAllows } from "./web.js";

/* ---------- shared helpers ---------- */

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

async function loadPage(url: string) {
  const res = await fetchWithTimeout(url);
  const html = await res.text();
  return { res, html, $: cheerio.load(html) };
}

function extractJsonLd($: cheerio.CheerioAPI): { blocks: unknown[]; invalid: number } {
  const blocks: unknown[] = [];
  let invalid = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    try { blocks.push(JSON.parse($(el).text())); } catch { invalid++; }
  });
  return { blocks, invalid };
}

/** Flatten JSON-LD (incl. @graph and arrays) into a list of typed nodes. */
function flattenNodes(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o["@type"]) out.push(o);
    if (o["@graph"]) walk(o["@graph"]);
  };
  blocks.forEach(walk);
  return out;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).map(String);
}

const QUESTION_WORDS = /^(how|what|why|when|where|which|who|is|are|can|does|do|should|best|top|cómo|como|qué|que|por qué|cuándo|cuando|dónde|donde|cuál|cual|quién|quien|cuánto|cuanto|mejor|mejores|es|son|puedo|se puede|wie|was|warum|wann|wo|welche|comment|quoi|pourquoi|quand|où)\b/i;

function isQuestion(s: string) { return /\?\s*$/.test(s) || QUESTION_WORDS.test(s.trim()); }

const STOP = new Set("the a an of in on to for and or is are with from by at as vs de la el los las en y o del al un una para con por que es se su lo mi".split(" "));
function contentWords(s: string) { return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)); }

/* ---------- AI crawler list ---------- */

interface Bot { name: string; robotsToken: string; ua?: string; owner: string; purpose: string }
const BOTS: Bot[] = [
  { name: "GPTBot", robotsToken: "gptbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", owner: "OpenAI", purpose: "training" },
  { name: "OAI-SearchBot", robotsToken: "oai-searchbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", owner: "OpenAI", purpose: "ChatGPT search index" },
  { name: "ChatGPT-User", robotsToken: "chatgpt-user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", owner: "OpenAI", purpose: "live fetch on user request" },
  { name: "ClaudeBot", robotsToken: "claudebot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", owner: "Anthropic", purpose: "training" },
  { name: "Claude-SearchBot", robotsToken: "claude-searchbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot)", owner: "Anthropic", purpose: "search index" },
  { name: "Claude-User", robotsToken: "claude-user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com/claude-user)", owner: "Anthropic", purpose: "live fetch on user request" },
  { name: "PerplexityBot", robotsToken: "perplexitybot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", owner: "Perplexity", purpose: "search index" },
  { name: "Perplexity-User", robotsToken: "perplexity-user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", owner: "Perplexity", purpose: "live fetch on user request" },
  { name: "Google-Extended", robotsToken: "google-extended", owner: "Google", purpose: "Gemini training (robots-only token; AI Overviews use Googlebot)" },
  { name: "Googlebot", robotsToken: "googlebot", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", owner: "Google", purpose: "Search + AI Overviews" },
  { name: "Bingbot", robotsToken: "bingbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36", owner: "Microsoft", purpose: "Bing + Copilot + ChatGPT search" },
  { name: "Applebot", robotsToken: "applebot", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", owner: "Apple", purpose: "Siri/Spotlight" },
  { name: "Applebot-Extended", robotsToken: "applebot-extended", owner: "Apple", purpose: "Apple Intelligence training (robots-only)" },
  { name: "Amazonbot", robotsToken: "amazonbot", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", owner: "Amazon", purpose: "Alexa" },
  { name: "meta-externalagent", robotsToken: "meta-externalagent", ua: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", owner: "Meta", purpose: "Meta AI training" },
  { name: "DuckAssistBot", robotsToken: "duckassistbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; DuckAssistBot/1.0; +http://duckduckgo.com/duckassistbot.html)", owner: "DuckDuckGo", purpose: "DuckAssist answers" },
  { name: "CCBot", robotsToken: "ccbot", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)", owner: "Common Crawl", purpose: "open dataset used by many LLMs" },
  { name: "Bytespider", robotsToken: "bytespider", ua: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", owner: "ByteDance", purpose: "training" },
];

/* ---------- schema rules ---------- */

const SCHEMA_RULES: Record<string, { required: string[]; recommended: string[] }> = {
  Organization: { required: ["name", "url"], recommended: ["logo", "sameAs", "address", "telephone", "contactPoint"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "url", "openingHoursSpecification", "geo", "image", "priceRange", "sameAs", "aggregateRating"] },
  TravelAgency: { required: ["name", "address"], recommended: ["telephone", "url", "image", "sameAs", "aggregateRating", "areaServed"] },
  TouristAttraction: { required: ["name"], recommended: ["description", "image", "address", "geo", "url", "touristType"] },
  TouristTrip: { required: ["name"], recommended: ["description", "itinerary", "offers", "provider", "image", "touristType"] },
  Product: { required: ["name"], recommended: ["image", "description", "offers", "aggregateRating", "brand", "sku"] },
  Offer: { required: ["price", "priceCurrency"], recommended: ["availability", "url", "validFrom"] },
  Event: { required: ["name", "startDate", "location"], recommended: ["endDate", "image", "description", "offers", "organizer", "eventStatus"] },
  Article: { required: ["headline", "datePublished", "author"], recommended: ["image", "dateModified", "publisher", "mainEntityOfPage", "description"] },
  BlogPosting: { required: ["headline", "datePublished", "author"], recommended: ["image", "dateModified", "publisher", "mainEntityOfPage", "description"] },
  NewsArticle: { required: ["headline", "datePublished", "author"], recommended: ["image", "dateModified", "publisher"] },
  FAQPage: { required: ["mainEntity"], recommended: [] },
  Question: { required: ["name", "acceptedAnswer"], recommended: [] },
  BreadcrumbList: { required: ["itemListElement"], recommended: [] },
  WebSite: { required: ["name", "url"], recommended: ["potentialAction", "inLanguage"] },
  WebPage: { required: ["name"], recommended: ["description", "url", "inLanguage", "isPartOf"] },
  Person: { required: ["name"], recommended: ["url", "jobTitle", "sameAs", "image"] },
  Review: { required: ["author", "reviewRating", "itemReviewed"], recommended: ["datePublished", "reviewBody"] },
  AggregateRating: { required: ["ratingValue"], recommended: ["reviewCount", "ratingCount", "bestRating"] },
  ImageObject: { required: ["url"], recommended: ["width", "height", "caption"] },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration", "contentUrl", "embedUrl"] },
  HowTo: { required: ["name", "step"], recommended: ["totalTime", "image", "supply", "tool"] },
};

function auditNode(node: Record<string, unknown>) {
  const types = typesOf(node);
  const missing: string[] = [];
  const recommendedMissing: string[] = [];
  for (const t of types) {
    const rule = SCHEMA_RULES[t];
    if (!rule) continue;
    for (const f of rule.required) if (node[f] == null || node[f] === "") missing.push(f);
    for (const f of rule.recommended) if (node[f] == null || node[f] === "") recommendedMissing.push(f);
  }
  const problems: string[] = [];
  if (types.includes("FAQPage")) {
    const qs = Array.isArray(node.mainEntity) ? (node.mainEntity as Record<string, unknown>[]) : [];
    if (!qs.length) problems.push("FAQPage has no questions");
    qs.forEach((q, i) => { const a = q.acceptedAnswer as Record<string, unknown> | undefined; if (!q.name) problems.push(`question ${i + 1} missing name`); if (!a || !a.text) problems.push(`question ${i + 1} missing acceptedAnswer.text`); });
  }
  if (types.includes("BreadcrumbList")) {
    const items = Array.isArray(node.itemListElement) ? (node.itemListElement as Record<string, unknown>[]) : [];
    items.forEach((it, i) => { if (it.position == null) problems.push(`breadcrumb ${i + 1} missing position`); if (!it.name) problems.push(`breadcrumb ${i + 1} missing name`); if (i < items.length - 1 && !it.item) problems.push(`breadcrumb ${i + 1} missing item URL`); });
  }
  for (const k of ["datePublished", "dateModified", "startDate", "uploadDate"]) {
    const v = node[k];
    if (typeof v === "string" && Number.isNaN(Date.parse(v))) problems.push(`${k} is not a valid ISO date: ${v}`);
  }
  const known = types.some((t) => SCHEMA_RULES[t]);
  return { types, known, missingRequired: [...new Set(missing)], missingRecommended: [...new Set(recommendedMissing)], problems };
}

/* ---------- GEO page analysis (shared by geo_page_score and eeat_audit) ---------- */

function analyzePage(url: string, $: cheerio.CheerioAPI, html: string) {
  const nodes = flattenNodes(extractJsonLd($).blocks);
  const has = (t: string) => nodes.some((n) => typesOf(n).includes(t));
  const $main = $("main, article, [role=main]").first().length ? $("main, article, [role=main]").first() : $("body");
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const headings = $main.find("h2, h3").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
  const questionHeadings = headings.filter(isQuestion);
  const paragraphs = $main.find("p").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter((t) => t.length > 40);
  const firstParagraph = paragraphs[0] ?? "";
  const h1Words = contentWords(h1);
  const firstParaWords = new Set(contentWords(firstParagraph));
  const h1Overlap = h1Words.length ? round(h1Words.filter((w) => firstParaWords.has(w)).length / h1Words.length, 2) ?? 0 : 0;
  const lists = $main.find("ul, ol").length;
  const tables = $main.find("table").length;
  const faqHeading = headings.some((h) => /faq|preguntas frecuentes|frequently asked|questions fréquentes|häufige fragen/i.test(h));
  const faqSchema = has("FAQPage");
  const authorSchema = nodes.some((n) => n.author);
  const authorMeta = Boolean($('meta[name="author"]').attr("content") || $('[rel="author"]').length || $(".author, .byline, [class*=author]").first().text().trim());
  const datePublished = nodes.map((n) => n.datePublished).find(Boolean) ?? $('meta[property="article:published_time"]').attr("content") ?? $("time[datetime]").first().attr("datetime") ?? null;
  const dateModified = nodes.map((n) => n.dateModified).find(Boolean) ?? $('meta[property="article:modified_time"]').attr("content") ?? null;
  const base = new URL(url);
  const externalDomains = new Set<string>();
  let externalDofollow = 0;
  $main.find("a[href]").each((_, el) => {
    try { const u = new URL($(el).attr("href")!, url); if (u.hostname !== base.hostname && /^https?:$/.test(u.protocol)) { externalDomains.add(u.hostname); if (!/nofollow/i.test($(el).attr("rel") ?? "")) externalDofollow++; } } catch { /* ignore */ }
  });
  const text = $main.text().replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?。])\s+/);
  const statSentences = sentences.filter((s) => /\d/.test(s) && /(%|€|\$|km|min|hour|hora|year|año|people|personas|\d{4})/i.test(s)).length;
  const summarySection = headings.some((h) => /summary|tl;dr|key takeaways|in short|resumen|en resumen|puntos clave|conclusi/i.test(h)) || /\b(tl;dr|key takeaways|in short)\b/i.test(text.slice(0, 3000));
  const wordCount = text ? text.split(" ").length : 0;
  const avgParagraphWords = paragraphs.length ? Math.round(paragraphs.reduce((a, p) => a + p.split(" ").length, 0) / paragraphs.length) : 0;
  const lastUpdatedVisible = /(last updated|updated on|última actualización|actualizado)/i.test(text.slice(0, 5000));
  return { h1, headings, questionHeadings, firstParagraph, h1Overlap, lists, tables, faqHeading, faqSchema, authorSchema, authorMeta, datePublished, dateModified, lastUpdatedVisible, externalDomains: [...externalDomains], externalDofollow, statSentences, summarySection, wordCount, avgParagraphWords, paragraphs: paragraphs.length, schemaTypes: [...new Set(nodes.flatMap(typesOf))], htmlBytes: Buffer.byteLength(html) };
}

/* ---------- registration ---------- */

export function registerGeoTools(server: McpServer) {
  server.registerTool(
    "ai_crawler_access",
    {
      title: "AI crawler access check",
      description:
        "Check whether AI and search crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Googlebot, Bingbot, Applebot, Amazonbot, Meta, CCBot, Bytespider...) can reach a page: robots.txt rules for the site root and for the URL, plus a live request with each bot's User-Agent to detect UA-based blocks (e.g. Cloudflare 'block AI bots', WAF rules). Being blocked from OAI-SearchBot, PerplexityBot or Claude-SearchBot means the site cannot be cited by those assistants.",
      inputSchema: {
        url: z.string().url().describe("A representative page, e.g. the homepage or an important article."),
        liveFetch: z.boolean().default(true).describe("Also request the page with each bot UA (one request per bot)."),
      },
    },
    tool(async (a) => {
      const origin = new URL(a.url).origin;
      const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`);
      const robotsText = robotsRes.ok ? await robotsRes.text() : "";
      const parsed = parseRobots(robotsText);
      const rows = await mapLimit(BOTS, 4, async (bot) => {
        const root = robotsAllows(parsed, `${origin}/`, bot.robotsToken);
        const page = robotsAllows(parsed, a.url, bot.robotsToken);
        let live: { status: number; server?: string | null; blocked: boolean } | null = null;
        if (a.liveFetch && bot.ua) {
          try {
            const r = await fetchWithTimeout(a.url, { headers: { "User-Agent": bot.ua }, redirect: "manual" }, 15_000);
            live = { status: r.status, server: r.headers.get("server"), blocked: r.status === 403 || r.status === 401 || r.status === 429 || r.status === 503 };
          } catch (e) { live = { status: 0, blocked: true, server: (e as Error).message }; }
        }
        return { bot: bot.name, owner: bot.owner, purpose: bot.purpose, robotsAllowsRoot: root.allowed, robotsAllowsPage: page.allowed, robotsRule: page.matchedRule?.path ?? null, robotsGroup: page.group, live };
      });
      const blockedBy = { robots: rows.filter((r) => !r.robotsAllowsPage).map((r) => r.bot), live: rows.filter((r) => r.live?.blocked).map((r) => r.bot) };
      const citationBots = ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Googlebot", "Bingbot"];
      const citationBlocked = citationBots.filter((b) => blockedBy.robots.includes(b) || blockedBy.live.includes(b));
      return { url: a.url, robotsTxtFound: robotsRes.ok, robotsGroups: parsed.groups.map((g) => g.agents.join(",")), results: rows, blockedBy, citationBlocked, verdict: citationBlocked.length ? `Blocked for citation-relevant bots: ${citationBlocked.join(", ")}` : "All citation-relevant bots can access the page" };
    }),
  );

  server.registerTool(
    "llms_txt_check",
    {
      title: "llms.txt check",
      description: "Check /llms.txt and /llms-full.txt: existence, size, structure (H1 title, blockquote summary, H2 sections with markdown links), robots access, and whether the linked URLs respond 200.",
      inputSchema: { siteUrl: z.string().url().describe("Site root, e.g. https://example.com/"), checkLinks: z.number().int().min(0).max(200).default(50) },
    },
    tool(async (a) => {
      const origin = new URL(a.siteUrl).origin;
      const check = async (path: string) => {
        const res = await fetchWithTimeout(`${origin}${path}`, { redirect: "follow" });
        if (!res.ok) return { path, exists: false, status: res.status };
        const text = await res.text();
        const looksHtml = /^\s*<!doctype html|<html/i.test(text);
        const lines = text.split(/\r?\n/);
        const h1 = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "") ?? null;
        const blockquote = lines.find((l) => /^>\s*/.test(l))?.replace(/^>\s*/, "") ?? null;
        const sections = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, ""));
        const links = [...text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ title: m[1], url: m[2] }));
        const problems: string[] = [];
        if (looksHtml) problems.push("Returned HTML instead of plain markdown (probably a soft 404 / SPA fallback)");
        if (!h1) problems.push("Missing H1 title line ('# Site name')");
        if (!blockquote) problems.push("Missing blockquote summary ('> one-paragraph description')");
        if (!links.length && !looksHtml) problems.push("No markdown links found");
        if (!/text\/(plain|markdown)/.test(res.headers.get("content-type") ?? "")) problems.push(`Content-Type is ${res.headers.get("content-type")} (should be text/plain or text/markdown)`);
        return { path, exists: true, status: res.status, bytes: Buffer.byteLength(text), contentType: res.headers.get("content-type"), h1, summary: blockquote, sections, linkCount: links.length, links, problems };
      };
      const [llms, full] = await Promise.all([check("/llms.txt"), check("/llms-full.txt")]);
      let linkChecks: { url: string; status: number }[] = [];
      if (llms.exists && a.checkLinks && llms.links) {
        linkChecks = await mapLimit(llms.links.slice(0, a.checkLinks), 5, async (l) => { try { const r = await fetchWithTimeout(l.url, { method: "HEAD" }, 15_000); return { url: l.url, status: r.status }; } catch { return { url: l.url, status: 0 }; } });
      }
      const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`);
      const robots = robotsRes.ok ? parseRobots(await robotsRes.text()) : { groups: [], sitemaps: [] };
      const strip = (o: typeof llms) => o.exists ? { ...o, links: undefined } : o;
      return {
        site: origin,
        llmsTxt: strip(llms),
        llmsFullTxt: strip(full),
        brokenLinks: linkChecks.filter((l) => l.status !== 200),
        checkedLinks: linkChecks.length,
        robotsAllowsLlmsTxt: robotsAllows(robots, `${origin}/llms.txt`, "gptbot").allowed,
        recommendation: !llms.exists ? "No llms.txt. Use llms_txt_generate to draft one from the sitemap." : llms.problems?.length ? "Fix the listed problems." : "llms.txt looks well-formed.",
      };
    }),
  );

  server.registerTool(
    "llms_txt_generate",
    {
      title: "Draft an llms.txt from the sitemap",
      description: "Crawl the sitemap (up to maxPages), read each page's title and meta description, and produce a draft llms.txt in the standard format (H1, blockquote summary, H2 sections grouped by first path segment, '- [title](url): description' lines). Review and edit the draft before publishing it at /llms.txt.",
      inputSchema: {
        siteUrl: z.string().url(),
        siteName: z.string().optional().describe("Override the H1; defaults to the homepage <title>."),
        summary: z.string().optional().describe("Blockquote summary; defaults to the homepage meta description."),
        maxPages: z.number().int().min(1).max(300).default(80),
        excludePatterns: z.array(z.string()).default(["/tag/", "/category/", "/author/", "/page/", "/wp-", "/feed", "?"]).describe("Skip URLs containing any of these substrings."),
      },
    },
    tool(async (a) => {
      const origin = new URL(a.siteUrl).origin;
      let sitemapUrl = `${origin}/sitemap.xml`;
      try { const r = await fetchWithTimeout(`${origin}/robots.txt`); if (r.ok) sitemapUrl = parseRobots(await r.text()).sitemaps[0] ?? sitemapUrl; } catch { /* ignore */ }
      const { urls } = await collectSitemapUrls(sitemapUrl, { maxUrls: 5000 });
      const filtered = urls.map((u) => u.loc).filter((u) => !a.excludePatterns.some((p) => u.includes(p))).slice(0, a.maxPages);
      const home = await loadPage(`${origin}/`);
      const siteName = a.siteName ?? home.$("title").first().text().trim() ?? origin;
      const summary = a.summary ?? home.$('meta[name="description"]').attr("content")?.trim() ?? "";
      const pages = await mapLimit(filtered, 5, async (url) => {
        try {
          const { $ } = await loadPage(url);
          const title = ($("h1").first().text().trim() || $("title").first().text().trim()).replace(/\s+/g, " ");
          const desc = ($('meta[name="description"]').attr("content") ?? "").trim().replace(/\s+/g, " ");
          return { url, title, desc };
        } catch { return null; }
      });
      const groups = new Map<string, { url: string; title: string; desc: string }[]>();
      for (const p of pages) {
        if (!p || !p.title) continue;
        const seg = new URL(p.url).pathname.split("/").filter(Boolean)[0] ?? "";
        const key = seg ? seg.replace(/[-_]/g, " ") : "Main pages";
        groups.set(key, [...(groups.get(key) ?? []), p]);
      }
      const lines = [`# ${siteName}`, "", summary ? `> ${summary}` : "> (add a one-paragraph description of the site here)", ""];
      for (const [name, list] of [...groups.entries()].sort((x, y) => y[1].length - x[1].length)) {
        lines.push(`## ${name.charAt(0).toUpperCase() + name.slice(1)}`, "");
        for (const p of list) lines.push(`- [${p.title}](${p.url})${p.desc ? `: ${p.desc}` : ""}`);
        lines.push("");
      }
      return { site: origin, pagesIncluded: pages.filter(Boolean).length, sections: groups.size, llmsTxt: lines.join("\n") };
    }),
  );

  server.registerTool(
    "structured_data_audit",
    {
      title: "Structured data (JSON-LD) audit",
      description:
        "Extract JSON-LD from one or more pages, validate required/recommended properties per schema type (Organization, LocalBusiness, TravelAgency, TouristTrip, Product/Offer, Event, Article/BlogPosting, FAQPage, BreadcrumbList, WebSite, Person, Review...), flag invalid JSON and bad dates, and check entity consistency across pages (organization name, telephone, address, sameAs must match everywhere). Pass explicit urls or a sitemap to sample.",
      inputSchema: {
        urls: z.array(z.string().url()).max(40).optional(),
        sitemapUrl: z.string().url().optional().describe("Sample pages from this sitemap instead of explicit urls."),
        sampleSize: z.number().int().min(1).max(40).default(15),
      },
    },
    tool(async (a) => {
      let urls = a.urls ?? [];
      if (!urls.length && a.sitemapUrl) {
        const all = (await collectSitemapUrls(a.sitemapUrl, { maxUrls: 5000 })).urls.map((u) => u.loc);
        const step = Math.max(1, Math.floor(all.length / a.sampleSize));
        urls = all.filter((_, i) => i % step === 0).slice(0, a.sampleSize);
      }
      if (!urls.length) throw new Error("Provide urls[] or sitemapUrl.");
      const entities: { page: string; type: string; name?: unknown; telephone?: unknown; address?: unknown; sameAs?: unknown; url?: unknown }[] = [];
      const pages = await mapLimit(urls, 4, async (url) => {
        try {
          const { $ } = await loadPage(url);
          const { blocks, invalid } = extractJsonLd($);
          const nodes = flattenNodes(blocks);
          const audits = nodes.map(auditNode);
          for (const n of nodes) {
            const t = typesOf(n).find((x) => ["Organization", "LocalBusiness", "TravelAgency", "TourOperator", "Corporation"].includes(x));
            if (t) entities.push({ page: url, type: t, name: n.name, telephone: n.telephone, address: n.address, sameAs: n.sameAs, url: n.url });
          }
          const microdata = $("[itemscope]").length;
          return { url, jsonLdBlocks: blocks.length, invalidJsonLd: invalid, microdataItems: microdata, types: [...new Set(nodes.flatMap(typesOf))], issues: audits.filter((x) => x.missingRequired.length || x.problems.length).map((x) => ({ types: x.types, missingRequired: x.missingRequired, problems: x.problems })), recommendations: audits.filter((x) => x.missingRecommended.length).map((x) => ({ types: x.types, missingRecommended: x.missingRecommended })), unknownTypes: audits.filter((x) => !x.known).flatMap((x) => x.types) };
        } catch (e) { return { url, error: (e as Error).message }; }
      });
      const variants = (k: "name" | "telephone" | "address" | "sameAs" | "url") => { const m = new Map<string, string[]>(); for (const e of entities) { if (e[k] == null) continue; const v = JSON.stringify(e[k]); m.set(v, [...(m.get(v) ?? []), e.page]); } return [...m.entries()].map(([value, pagesFound]) => ({ value: JSON.parse(value), pages: pagesFound.length })); };
      const consistency = { organizationsFound: entities.length, name: variants("name"), telephone: variants("telephone"), address: variants("address"), sameAs: variants("sameAs"), url: variants("url") };
      const inconsistent = (["name", "telephone", "address", "sameAs", "url"] as const).filter((k) => consistency[k].length > 1);
      const typeCounts: Record<string, number> = {};
      for (const p of pages) for (const t of (p as { types?: string[] }).types ?? []) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      return { pagesAudited: pages.length, typeCounts, pagesWithoutSchema: pages.filter((p) => (p as { jsonLdBlocks?: number }).jsonLdBlocks === 0).map((p) => p.url), pagesWithIssues: pages.filter((p) => ((p as { issues?: unknown[] }).issues?.length ?? 0) > 0).length, entityConsistency: { ...consistency, inconsistentFields: inconsistent }, pages };
    }),
  );

  server.registerTool(
    "geo_page_score",
    {
      title: "GEO readiness score of a page",
      description:
        "Score how easily AI answer engines (ChatGPT, Perplexity, Google AI Overviews) can extract and cite a page: direct answer in the first paragraph, question-style headings, FAQ section and FAQPage schema, lists/tables, quotable statistics, summary section, author and dates (E-E-A-T), outbound citations, structured data. Returns a 0-100 score, the signals found and concrete fixes.",
      inputSchema: { url: z.string().url() },
    },
    tool(async (a) => {
      const { res, html, $ } = await loadPage(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = analyzePage(a.url, $, html);
      const checks: { signal: string; points: number; max: number; detail: string; fix?: string }[] = [];
      const add = (signal: string, ok: number, max: number, detail: string, fix?: string) => checks.push({ signal, points: ok, max, detail, fix: ok < max ? fix : undefined });
      add("Direct answer in first paragraph", p.firstParagraph.length >= 80 && p.firstParagraph.length <= 600 && p.h1Overlap >= 0.4 ? 15 : p.firstParagraph ? 6 : 0, 15, `first paragraph ${p.firstParagraph.length} chars, overlap with H1 keywords ${Math.round(p.h1Overlap * 100)}%`, "Open with a 2-3 sentence answer that restates the H1 topic and gives the conclusion before the details.");
      add("Question-style headings", Math.min(10, p.questionHeadings.length * 4), 10, `${p.questionHeadings.length} of ${p.headings.length} H2/H3 phrased as questions`, "Rephrase key H2s as the questions people ask (How much..., Is it worth..., Cuánto cuesta...).");
      add("FAQ section", (p.faqHeading ? 5 : 0) + (p.faqSchema ? 7 : 0), 12, `FAQ heading: ${p.faqHeading}, FAQPage schema: ${p.faqSchema}`, "Add a FAQ section with 4-6 real questions and mark it up with FAQPage JSON-LD.");
      add("Lists and tables", Math.min(10, p.lists * 3 + p.tables * 4), 10, `${p.lists} lists, ${p.tables} tables`, "Turn comparisons, steps and prices into lists or tables; AI engines lift these verbatim.");
      add("Quotable facts and numbers", Math.min(10, p.statSentences * 2), 10, `${p.statSentences} sentences with concrete numbers/units`, "Add specific figures (prices, durations, distances, dates, counts) in full sentences.");
      add("Summary / key takeaways", p.summarySection ? 6 : 0, 6, `summary section: ${p.summarySection}`, "Add a short 'Key takeaways' or 'In short' block near the top or bottom.");
      add("Author attribution", (p.authorSchema ? 5 : 0) + (p.authorMeta ? 3 : 0), 8, `schema author: ${p.authorSchema}, visible byline/meta: ${p.authorMeta}`, "Show a named author with a short bio and add author to Article schema.");
      add("Publish and update dates", (p.datePublished ? 4 : 0) + (p.dateModified ? 3 : 0) + (p.lastUpdatedVisible ? 1 : 0), 8, `published: ${p.datePublished ?? "none"}, modified: ${p.dateModified ?? "none"}, visible 'updated' text: ${p.lastUpdatedVisible}`, "Expose datePublished/dateModified in schema and show 'Last updated' on the page.");
      add("Outbound citations", Math.min(6, p.externalDofollow * 2), 6, `${p.externalDofollow} dofollow external links to ${p.externalDomains.length} domains`, "Cite 2-3 authoritative sources (official tourism sites, museums, statistics) with normal links.");
      add("Structured data present", p.schemaTypes.length ? (p.schemaTypes.some((t) => /Article|BlogPosting|FAQPage|TouristTrip|Product|Event|LocalBusiness/.test(t)) ? 8 : 4) : 0, 8, `types: ${p.schemaTypes.join(", ") || "none"}`, "Add Article/BlogPosting (or the matching type) JSON-LD with headline, author, dates, image.");
      add("Depth and readability", (p.wordCount >= 600 ? 4 : p.wordCount >= 300 ? 2 : 0) + (p.avgParagraphWords > 0 && p.avgParagraphWords <= 90 ? 3 : 1), 7, `${p.wordCount} words, ${p.paragraphs} paragraphs, avg ${p.avgParagraphWords} words/paragraph`, "Aim for 600+ words with short paragraphs (under 90 words).");
      const score = checks.reduce((s, c) => s + c.points, 0);
      return { url: a.url, score, grade: score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D", h1: p.h1, checks, fixes: checks.filter((c) => c.fix).sort((x, y) => (y.max - y.points) - (x.max - x.points)).map((c) => c.fix), firstParagraph: p.firstParagraph.slice(0, 400), questionHeadings: p.questionHeadings, schemaTypes: p.schemaTypes };
    }),
  );

  server.registerTool(
    "eeat_audit",
    {
      title: "E-E-A-T site audit",
      description:
        "Site-level trust signals that search and AI engines weigh: About and Contact pages, privacy/terms, visible address and phone, Organization/LocalBusiness schema on the homepage, review/rating schema, social profiles (sameAs), author pages, HTTPS, plus a sample of articles checked for bylines and dates. Returns a pass/fail checklist with what to add.",
      inputSchema: { siteUrl: z.string().url(), sampleArticles: z.number().int().min(0).max(20).default(5) },
    },
    tool(async (a) => {
      const origin = new URL(a.siteUrl).origin;
      const home = await loadPage(`${origin}/`);
      const $ = home.$;
      const nodes = flattenNodes(extractJsonLd($).blocks);
      const links = $("a[href]").map((_, el) => ({ href: $(el).attr("href")!, text: $(el).text().replace(/\s+/g, " ").trim().toLowerCase() })).get();
      const findLink = (re: RegExp) => links.find((l) => re.test(l.href.toLowerCase()) || re.test(l.text));
      const resolve = (href?: string) => { try { return href ? new URL(href, origin).toString() : null; } catch { return null; } };
      const about = resolve(findLink(/about|sobre|nosotros|quienes|qui[eé]nes somos|chi siamo|über uns/)?.href);
      const contact = resolve(findLink(/contact|contacto|kontakt/)?.href);
      const privacy = resolve(findLink(/privacy|privacidad|datenschutz|legal|aviso/)?.href);
      const terms = resolve(findLink(/terms|condiciones|términos|agb/)?.href);
      const status = async (u: string | null) => { if (!u) return null; try { return (await fetchWithTimeout(u, { method: "HEAD" }, 15_000)).status; } catch { return 0; } };
      const [aboutStatus, contactStatus, privacyStatus, termsStatus] = await Promise.all([status(about), status(contact), status(privacy), status(terms)]);
      const bodyText = $("body").text().replace(/\s+/g, " ");
      const phone = /(\+\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/.exec(bodyText)?.[0] ?? null;
      const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(bodyText)?.[0] ?? null;
      const addressText = /\b\d{5}\b/.test(bodyText) || /(calle|c\/|avenida|plaza|street|st\.|road|rd\.|strasse|rue)\b/i.test(bodyText);
      const org = nodes.find((n) => typesOf(n).some((t) => /Organization|LocalBusiness|TravelAgency|TourOperator/.test(t)));
      const sameAs = org?.sameAs ? (Array.isArray(org.sameAs) ? org.sameAs : [org.sameAs]) : [];
      const socialLinks = links.filter((l) => /facebook|instagram|tiktok|youtube|linkedin|x\.com|twitter|tripadvisor|google\.com\/maps|pinterest/.test(l.href)).map((l) => l.href);
      const reviewsSchema = nodes.some((n) => typesOf(n).some((t) => /AggregateRating|Review/.test(t)) || n.aggregateRating);
      let sitemapUrls: string[] = [];
      try { const r = await fetchWithTimeout(`${origin}/robots.txt`); const sm = r.ok ? parseRobots(await r.text()).sitemaps[0] : undefined; sitemapUrls = (await collectSitemapUrls(sm ?? `${origin}/sitemap.xml`, { maxUrls: 3000 })).urls.map((u) => u.loc); } catch { /* ignore */ }
      const authorPages = sitemapUrls.filter((u) => /\/author\/|\/autor\/|\/team\/|\/equipo\//.test(u));
      const articleCandidates = sitemapUrls.filter((u) => /\/blog\/|\/news\/|\/noticias\/|\/\d{4}\/|\/guide|\/guia/.test(u) || (new URL(u).pathname.split("/").filter(Boolean).length === 1 && !/^\/(about|contact|es|en|de|fr|it)\/?$/.test(new URL(u).pathname))).slice(0, a.sampleArticles);
      const articles = await mapLimit(articleCandidates, 4, async (url) => { try { const p = await loadPage(url); const an = analyzePage(url, p.$, p.html); return { url, author: an.authorSchema || an.authorMeta, datePublished: Boolean(an.datePublished), dateModified: Boolean(an.dateModified), schema: an.schemaTypes }; } catch { return { url, error: true }; } });
      const checklist = [
        { item: "HTTPS", pass: origin.startsWith("https://"), detail: origin },
        { item: "About page linked and reachable", pass: aboutStatus === 200, detail: about ? `${about} -> ${aboutStatus}` : "no about link found on homepage" },
        { item: "Contact page linked and reachable", pass: contactStatus === 200, detail: contact ? `${contact} -> ${contactStatus}` : "no contact link found" },
        { item: "Privacy policy", pass: privacyStatus === 200, detail: privacy ? `${privacy} -> ${privacyStatus}` : "no privacy link found" },
        { item: "Terms / legal notice", pass: termsStatus === 200, detail: terms ? `${terms} -> ${termsStatus}` : "no terms link found" },
        { item: "Visible phone number", pass: Boolean(phone), detail: phone ?? "none detected on homepage" },
        { item: "Visible email", pass: Boolean(email), detail: email ?? "none detected" },
        { item: "Visible postal address", pass: addressText, detail: addressText ? "address-like text found" : "no street/postal code text found" },
        { item: "Organization/LocalBusiness schema on homepage", pass: Boolean(org), detail: org ? `${typesOf(org).join(",")}: ${String(org.name ?? "")}` : "none" },
        { item: "Schema has address + telephone", pass: Boolean(org?.address && org?.telephone), detail: org ? `address: ${Boolean(org.address)}, telephone: ${Boolean(org.telephone)}` : "n/a" },
        { item: "sameAs social/profile links in schema", pass: sameAs.length >= 2, detail: `${sameAs.length} sameAs entries; ${socialLinks.length} social links on page` },
        { item: "Review / rating schema", pass: reviewsSchema, detail: reviewsSchema ? "found" : "none (add AggregateRating from real reviews if you display them)" },
        { item: "Author pages in sitemap", pass: authorPages.length > 0, detail: `${authorPages.length} author/team URLs` },
        { item: "Articles carry author + dates", pass: articles.length > 0 && articles.every((x) => "author" in x && x.author && x.datePublished), detail: `${articles.filter((x) => "author" in x && x.author).length}/${articles.length} sampled articles have an author, ${articles.filter((x) => "datePublished" in x && x.datePublished).length}/${articles.length} have datePublished` },
      ];
      return { site: origin, score: Math.round((checklist.filter((c) => c.pass).length / checklist.length) * 100), checklist, sampledArticles: articles, socialLinks: [...new Set(socialLinks)].slice(0, 15) };
    }),
  );

  server.registerTool(
    "indexnow_submit",
    {
      title: "IndexNow: notify Bing/Yandex of changed URLs",
      description:
        "Submit up to 1000 changed URLs to IndexNow (Bing, Yandex, Naver, Seznam; Bing's index feeds ChatGPT search and Copilot). Requires INDEXNOW_KEY and the key file published at https://<host>/<key>.txt (or set INDEXNOW_KEY_LOCATION). The tool verifies the key file before submitting. Google does not support IndexNow.",
      inputSchema: { urls: z.array(z.string().url()).min(1).max(1000), key: z.string().optional().describe("Overrides INDEXNOW_KEY."), keyLocation: z.string().url().optional().describe("Overrides INDEXNOW_KEY_LOCATION.") },
    },
    tool(async (a) => {
      const key = a.key ?? process.env.INDEXNOW_KEY;
      if (!key) throw new Error("No IndexNow key. Generate one (32 hex chars, e.g. `openssl rand -hex 16`), publish it as https://<host>/<key>.txt containing the key, and set INDEXNOW_KEY.");
      const host = new URL(a.urls[0]).host;
      if (a.urls.some((u) => new URL(u).host !== host)) throw new Error("All URLs must belong to the same host.");
      const keyLocation = a.keyLocation ?? process.env.INDEXNOW_KEY_LOCATION ?? `https://${host}/${key}.txt`;
      const kf = await fetchWithTimeout(keyLocation, {}, 15_000);
      const kfText = kf.ok ? (await kf.text()).trim() : "";
      if (!kf.ok || kfText !== key) throw new Error(`Key file check failed: ${keyLocation} returned HTTP ${kf.status}${kf.ok ? " with non-matching content" : ""}. Publish a text file containing exactly the key.`);
      const res = await fetchWithTimeout("https://api.indexnow.org/indexnow", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ host, key, keyLocation, urlList: a.urls }) }, 30_000);
      const meaning: Record<number, string> = { 200: "OK, URLs submitted", 202: "Accepted, key validation pending", 400: "Bad request", 403: "Forbidden: key not valid for this host", 422: "URLs do not belong to the host or key mismatch", 429: "Too many requests" };
      return { host, submitted: a.urls.length, status: res.status, meaning: meaning[res.status] ?? "unexpected status", keyLocation };
    }),
  );

  server.registerTool(
    "ai_citation_check",
    {
      title: "Check AI answer citations (Perplexity)",
      description:
        "Ask Perplexity's Sonar API a question a customer might ask and report which sources it cites, whether your domain is among them, and the answer text. Useful to see if the site is being cited by AI search for target queries. Requires PERPLEXITY_API_KEY (paid, cents per call). ChatGPT and Google AI Overviews have no such API.",
      inputSchema: {
        question: z.string().describe("A natural question, e.g. 'What is the best guided walking tour in Seville?'"),
        domain: z.string().describe("Your domain to look for in the citations, e.g. 'example.com'."),
        model: z.enum(["sonar", "sonar-pro"]).default("sonar"),
        country: z.string().optional().describe("Optional 2-letter country code for localized search, e.g. 'ES', 'US'."),
      },
    },
    tool(async (a) => {
      const key = process.env.PERPLEXITY_API_KEY;
      if (!key) throw new Error("PERPLEXITY_API_KEY is not set. Create a key at https://www.perplexity.ai/settings/api and add it to the MCP env.");
      const body: Record<string, unknown> = { model: a.model, messages: [{ role: "user", content: a.question }], return_citations: true };
      if (a.country) body.web_search_options = { user_location: { country: a.country } };
      const res = await fetchWithTimeout("https://api.perplexity.ai/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, 60_000);
      const data = (await res.json()) as { error?: { message?: string }; citations?: string[]; search_results?: { url: string; title?: string }[]; choices?: { message?: { content?: string } }[] };
      if (!res.ok) throw new Error(`Perplexity API: ${data.error?.message ?? `HTTP ${res.status}`}`);
      const citations = data.citations ?? data.search_results?.map((s) => s.url) ?? [];
      const dom = a.domain.replace(/^www\./, "").toLowerCase();
      const cited = citations.filter((c) => { try { return new URL(c).hostname.replace(/^www\./, "").toLowerCase().endsWith(dom); } catch { return false; } });
      const answer = data.choices?.[0]?.message?.content ?? "";
      return { question: a.question, model: a.model, cited: cited.length > 0, yourCitations: cited, citationRank: cited.length ? citations.indexOf(cited[0]) + 1 : null, allCitations: citations, competitorDomains: [...new Set(citations.map((c) => { try { return new URL(c).hostname.replace(/^www\./, ""); } catch { return c; } }))].filter((d) => !d.endsWith(dom)), answer: answer.slice(0, 3000), mentionsDomainInText: answer.toLowerCase().includes(dom) };
    }),
  );
  server.registerTool(
    "schema_validate",
    {
      title: "Validate JSON-LD",
      description: "Validate one or more JSON-LD objects before publishing: required/recommended properties per type (same rules as structured_data_audit), FAQ/Breadcrumb structure, ISO dates, @context presence. Returns the normalized, compact JSON ready to inject.",
      inputSchema: { jsonld: z.union([z.string(), z.record(z.unknown()), z.array(z.record(z.unknown()))]).describe("JSON-LD as an object, array of objects, or JSON string.") },
    },
    tool(async (a) => {
      const parsed = typeof a.jsonld === "string" ? JSON.parse(a.jsonld) : a.jsonld;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const problems: string[] = [];
      for (const [i, obj] of list.entries()) { if (!obj["@context"]) problems.push(`object ${i + 1}: missing @context (use "https://schema.org")`); if (!obj["@type"]) problems.push(`object ${i + 1}: missing @type`); }
      const nodes = flattenNodes(list);
      const audits = nodes.map(auditNode);
      return { objects: list.length, nodes: nodes.length, valid: problems.length === 0 && audits.every((x) => !x.missingRequired.length && !x.problems.length), problems, nodeAudits: audits.filter((x) => x.missingRequired.length || x.problems.length || x.missingRecommended.length), compactJson: JSON.stringify(list.length === 1 ? list[0] : list) };
    }),
  );

  server.registerTool(
    "schema_generate",
    {
      title: "Draft JSON-LD from a page",
      description:
        "Generate draft JSON-LD from an existing page: 'faq' extracts question-style headings and the paragraph(s) that follow them into FAQPage; 'article' builds Article/BlogPosting from title, meta description, dates, author and og:image; 'breadcrumb' from the URL path; 'all' returns every applicable block. Review the text (answers are trimmed to ~600 chars) then publish with wp_set_schema or by editing the site code.",
      inputSchema: { url: z.string().url(), kind: z.enum(["faq", "article", "breadcrumb", "all"]).default("all"), organizationName: z.string().optional().describe("Publisher name for Article; defaults to og:site_name."), maxQuestions: z.number().int().min(1).max(30).default(10) },
    },
    tool(async (a) => {
      const { html, $ } = await loadPage(a.url);
      const meta = (sel: string) => $(sel).first().attr("content")?.trim();
      const out: Record<string, unknown>[] = [];
      const p = analyzePage(a.url, $, html);
      if (a.kind === "faq" || a.kind === "all") {
        const $main = $("main, article, [role=main]").first().length ? $("main, article, [role=main]").first() : $("body");
        const qa: { q: string; a: string }[] = [];
        $main.find("h2, h3, h4").each((_, el) => {
          const q = $(el).text().replace(/\s+/g, " ").trim();
          if (!isQuestion(q) || q.length < 8) return;
          let ans = "";
          let node = $(el).next();
          while (node.length && ans.length < 600 && !/^h[1-4]$/i.test(node.prop("tagName") ?? "")) { const t = node.text().replace(/\s+/g, " ").trim(); if (t) ans += (ans ? " " : "") + t; node = node.next(); }
          if (ans.length >= 30) qa.push({ q, a: ans.slice(0, 600) });
        });
        // BeTheme/other builders often place the answer in a sibling column; fall back to "Q?A" runs inside one block
        if (!qa.length) { const text = $main.text().replace(/\s+/g, " "); for (const m of text.matchAll(/([A-ZÁÉÍÓÚÑ¿][^.?!]{10,140}\?)\s*([^?]{40,600}?)(?=\s[A-ZÁÉÍÓÚÑ¿][^.?!]{10,140}\?|$)/g)) { if (qa.length >= a.maxQuestions) break; qa.push({ q: m[1].trim(), a: m[2].trim() }); } }
        if (qa.length) out.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: qa.slice(0, a.maxQuestions).map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) });
      }
      if (a.kind === "article" || a.kind === "all") {
        const headline = p.h1 || $("title").first().text().trim();
        const author = meta('meta[name="author"]') ?? $('[rel="author"]').first().text().trim() ?? undefined;
        const art: Record<string, unknown> = { "@context": "https://schema.org", "@type": "BlogPosting", headline, description: meta('meta[name="description"]') ?? undefined, image: meta('meta[property="og:image"]') ? [meta('meta[property="og:image"]')] : undefined, datePublished: p.datePublished ?? undefined, dateModified: p.dateModified ?? p.datePublished ?? undefined, author: author ? { "@type": "Person", name: author } : undefined, publisher: { "@type": "Organization", name: a.organizationName ?? meta('meta[property="og:site_name"]') ?? new URL(a.url).hostname }, mainEntityOfPage: { "@type": "WebPage", "@id": a.url }, inLanguage: $("html").attr("lang") ?? undefined };
        out.push(Object.fromEntries(Object.entries(art).filter(([, v]) => v !== undefined)));
      }
      if (a.kind === "breadcrumb" || a.kind === "all") {
        const u = new URL(a.url);
        const segs = u.pathname.split("/").filter(Boolean);
        const items = [{ "@type": "ListItem", position: 1, name: "Home", item: u.origin + "/" }, ...segs.map((seg, i) => ({ "@type": "ListItem", position: i + 2, name: i === segs.length - 1 ? (p.h1 || seg) : seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), item: i === segs.length - 1 ? undefined : `${u.origin}/${segs.slice(0, i + 1).join("/")}/` }))];
        if (segs.length) out.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map((it) => Object.fromEntries(Object.entries(it).filter(([, v]) => v !== undefined))) });
      }
      const audits = flattenNodes(out).map(auditNode).filter((x) => x.missingRequired.length || x.problems.length);
      return { url: a.url, existingTypes: p.schemaTypes, generated: out, warnings: audits, note: out.some((o) => o["@type"] === "FAQPage") ? "Only publish FAQPage markup for questions that are visibly answered on the page." : undefined };
    }),
  );

}
