/**
 * MCP prompts: named, ready-made workflows a client shows as slash commands.
 *
 * A prompt is the reliable answer to "will it pick the right tool?" - the sequence is written
 * down instead of inferred. Keep each one short: the list travels with every conversation, and
 * the body is only sent when the user actually picks it.
 *
 * Each prompt declares which toolsets it needs, so an instance narrowed with `?toolsets=` or
 * SEO_MCP_TOOLSETS never offers a workflow whose tools are not registered.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** MCP prompt arguments are always strings on the wire, so every schema here is a z.string(). */
type PromptArgs = Record<string, z.ZodString | z.ZodOptional<z.ZodString>>;

const site = z.string().describe("Search Console property, e.g. 'sc-domain:example.com'.");
const url = z.string().describe("Full page URL.");

interface PromptDef {
  name: string;
  title: string;
  description: string;
  /** Toolsets whose absence makes the workflow impossible. */
  needs: string[];
  argsSchema: PromptArgs;
  body: (a: Record<string, string | undefined>) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "traffic_drop",
    title: "Investigate a traffic drop",
    description: "Find out what changed when clicks fell: totals, which pages and queries lost, and whether it is a ranking, indexing or technical problem.",
    needs: ["gsc"],
    argsSchema: { siteUrl: site, days: z.string().optional().describe("Comparison window in days, default 28.") },
    body: (a) => `Investigate the traffic drop on ${a.siteUrl}. Work in this order and stop early if one step explains it:

1. gsc_site_snapshot (days=${a.days ?? 28}) for the shape of the drop: clicks, impressions, average position, and which pages moved most.
2. gsc_compare_periods on the same window by page, then by query, to name the specific losers.
3. If position fell but impressions held, it is a ranking problem: run gsc_cannibalization and content_refresh_candidates on the affected pages.
4. If impressions fell sharply, suspect indexing: run gsc_index_coverage on the top losing URLs and check for coverage or canonical problems.
5. If neither, check the pages themselves: page_audit on the two worst URLs, and canonical_host_check on the domain.

Report what changed, the most likely cause with the evidence for it, and the smallest fix that addresses it. Say plainly if the data does not support a conclusion.`,
  },
  {
    name: "quick_wins",
    title: "Find quick wins",
    description: "The changes with the best effort-to-traffic ratio right now: near-miss rankings and pages that rank but are not clicked.",
    needs: ["gsc"],
    argsSchema: { siteUrl: site, section: z.string().optional().describe("Optional path fragment to scope to, e.g. '/es/'.") },
    body: (a) => `Find the quick wins for ${a.siteUrl}${a.section ? `, scoped to pages containing '${a.section}'` : ""}.

1. gsc_opportunities for queries ranking just outside the top results.
2. gsc_ctr_opportunities for queries already ranking well but under-clicked.
3. gsc_question_queries to see which of those pages are missing a direct answer.${a.section ? `\n\nPass filters: [{dimension:"page", operator:"contains", expression:"${a.section}"}] to each.` : ""}

Merge the three into one ranked list. For each item give the page, the query, what to change (title, meta description, or a new section answering the question) and the realistic click gain. Put the single highest-value change first and say why.`,
  },
  {
    name: "publish_check",
    title: "Pre-publish page check",
    description: "Everything worth checking on one page before or just after publishing it: on-page SEO, structured data, sharing preview and AI-answer readiness.",
    needs: ["web", "geo"],
    argsSchema: { url },
    body: (a) => `Run the pre-publish checks on ${a.url} and report only what needs fixing:

1. page_audit for title, meta description, headings, canonical, images without alt and the favicon.
2. structured_data_audit for JSON-LD problems.
3. social_preview_check for the sharing card.
4. geo_page_score for whether an AI answer engine can quote the page.

Give one list, ordered by impact, each item saying exactly what to change. If the page is fine, say so instead of inventing work.`,
  },
  {
    name: "site_health",
    title: "Technical site audit",
    description: "A whole-site technical pass: crawl, sitemap, robots, redirects, hreflang, Core Web Vitals and AI crawler access.",
    needs: ["web", "geo"],
    argsSchema: { startUrl: url, siteUrl: z.string().optional().describe("Search Console property, to add index coverage.") },
    body: (a) => `Audit ${a.startUrl} technically:

1. canonical_host_check on the domain: every variant must land on one address.
2. site_crawl for broken links, redirect chains, duplicate titles and orphan pages.
3. sitemap_check and robots_check.
4. hreflang_check if the site is multilingual.
5. crux_snapshot for real-user Core Web Vitals and, if LCP is poor, which phase is to blame.
6. ai_crawler_access and llms_txt_check for AI answer engines.${a.siteUrl ? `\n7. gsc_index_coverage on a sample from the sitemap of ${a.siteUrl}.` : ""}

Report findings grouped as: breaks indexing, hurts ranking, cosmetic. Skip anything that is already correct.`,
  },
  {
    name: "monthly_report",
    title: "Monthly performance report",
    description: "Search Console and GA4 for the last month against the previous one, written as a report rather than a data dump.",
    needs: ["gsc", "ga4"],
    argsSchema: { siteUrl: site, propertyId: z.string().describe("GA4 property ID, e.g. '123456789'.") },
    body: (a) => `Write the monthly report for ${a.siteUrl}.

1. gsc_site_snapshot (days=30) and gsc_compare_periods for search performance.
2. ga_compare_periods on property ${a.propertyId} for sessions, engagement and key events.
3. ga_landing_page_seo to join organic landing pages with their search data.

Write it for someone who will not read the raw numbers: what moved, why as far as the data shows, and the two or three things worth doing next month. Quote every figure with its period. Do not extrapolate beyond what the tools returned, and name anything the data cannot explain.`,
  },
  {
    name: "index_bloat",
    title: "Find index bloat",
    description: "Thin or duplicate pages that should not be indexed: author and date archives, tag pages, paginated and parameter URLs.",
    needs: ["gsc"],
    argsSchema: { siteUrl: site },
    body: (a) => `Look for index bloat on ${a.siteUrl}:

1. gsc_search_analytics by page over 90 days to list indexed URLs with near-zero clicks.
2. gsc_list_sitemaps, and if there is an index file pass sitemapIndex to see the child sitemaps: author, date, tag and format archives are the usual culprits.
3. gsc_index_coverage on a sample of the suspicious URLs, looking for orphan pages and duplicates.

Report which URL groups should be noindexed or switched off, how many pages each group is, and what they cost. On WordPress with Yoast, read wp_get_seo_settings first and propose the exact setting to change; never change it without showing the dry run.`,
  },
];

/** Register the prompts whose required toolsets are all enabled on this instance. */
export function registerPrompts(server: McpServer, enabled: (toolset: string) => boolean): number {
  let n = 0;
  for (const p of PROMPTS) {
    if (!p.needs.every(enabled)) continue;
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, (args) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.body((args ?? {}) as Record<string, string | undefined>) } }],
    }));
    n++;
  }
  return n;
}

export const PROMPT_NAMES = PROMPTS.map((p) => p.name);
