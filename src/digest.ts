/**
 * The weekly check nobody remembers to run.
 *
 * Every tool in this server answers a question someone asked; problems, though, tend to appear in
 * the weeks nobody asks. This builds a week-over-week Search Console report per property — totals,
 * the pages and queries that moved, what disappeared — and the HTTP server can run it on a schedule
 * and file it as a GitHub issue, so a drop arrives on its own instead of waiting to be noticed.
 *
 * Fetching lives in `buildDigest` (Search Console only, through gsc.ts's `query()`); everything that
 * decides, compares or renders is a pure function below and covered by unit tests.
 */
import { envValue } from "./env.js";
import { query, type Row } from "./tools/gsc.js";

export interface Totals { clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface Mover { key: string; clicks: number; previousClicks: number; delta: number; impressions: number; position: number | null; previousPosition: number | null }
export interface Digest {
  site: string;
  period: { current: { start: string; end: string }; previous: { start: string; end: string }; days: number };
  totals: Totals & { previous: Totals; clicksDelta: number; impressionsDelta: number; positionDelta: number | null };
  pagesDown: Mover[]; pagesUp: Mover[];
  queriesDown: Mover[]; queriesUp: Mover[];
  lostQueries: Mover[]; newQueries: Mover[];
  attention: string[];
}

/** YYYY-MM-DD `days` before `date`. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The two comparable windows: `days` ending at `end`, and the `days` immediately before them. */
export function periods(end: string, days: number) {
  const currentStart = shiftDate(end, days - 1);
  const previousEnd = shiftDate(currentStart, 1);
  return { current: { start: currentStart, end }, previous: { start: shiftDate(previousEnd, days - 1), end: previousEnd }, days };
}

function totalsOf(rows: Row[]): Totals {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  const weighted = rows.reduce((n, r) => n + (r.position ?? 0) * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? Number((clicks / impressions).toFixed(4)) : null,
    position: impressions ? Number((weighted / impressions).toFixed(2)) : null,
  };
}

const keyOf = (r: Row) => Object.values(r.keys)[0] ?? "";

/**
 * Join two periods on their single dimension. `minClicks` keeps the noise out: on a small site a
 * page going from 1 click to 0 is not a finding, and a digest full of those stops being read.
 */
export function compare(current: Row[], previous: Row[], minClicks = 3): { down: Mover[]; up: Mover[]; lost: Mover[]; fresh: Mover[] } {
  const before = new Map(previous.map((r) => [keyOf(r), r]));
  const after = new Map(current.map((r) => [keyOf(r), r]));
  const movers: Mover[] = [];
  for (const [key, r] of after) {
    const p = before.get(key);
    movers.push({ key, clicks: r.clicks, previousClicks: p?.clicks ?? 0, delta: r.clicks - (p?.clicks ?? 0), impressions: r.impressions, position: r.position, previousPosition: p?.position ?? null });
  }
  const lost: Mover[] = [];
  for (const [key, p] of before) {
    if (after.has(key)) continue;
    if (p.clicks < minClicks) continue;
    lost.push({ key, clicks: 0, previousClicks: p.clicks, delta: -p.clicks, impressions: 0, position: null, previousPosition: p.position });
  }
  const moved = movers.filter((m) => Math.abs(m.delta) >= minClicks);
  return {
    down: moved.filter((m) => m.delta < 0 && m.previousClicks >= minClicks).sort((a, b) => a.delta - b.delta),
    up: moved.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta),
    lost: lost.sort((a, b) => a.delta - b.delta),
    fresh: movers.filter((m) => m.previousClicks === 0 && m.clicks >= minClicks).sort((a, b) => b.clicks - a.clicks),
  };
}

/** Plain-language flags, so the report says what happened before anyone reads a table. */
export function attentionLines(d: Omit<Digest, "attention">): string[] {
  const out: string[] = [];
  const { clicks, previous, clicksDelta, positionDelta } = d.totals;
  const pct = previous.clicks ? Math.round((clicksDelta / previous.clicks) * 100) : null;
  if (previous.clicks >= 10 && pct !== null && pct <= -25) out.push(`Clicks fell ${Math.abs(pct)}% (${previous.clicks} → ${clicks}). Start with the pages below, then gsc_compare_periods for the full picture.`);
  if (pct !== null && pct >= 25 && clicks >= 10) out.push(`Clicks rose ${pct}% (${previous.clicks} → ${clicks}).`);
  if (positionDelta !== null && positionDelta >= 1.5) out.push(`Average position worsened by ${positionDelta.toFixed(1)} places; check whether a page lost its ranking or new queries entered at the bottom.`);
  if (positionDelta !== null && positionDelta <= -1.5) out.push(`Average position improved by ${Math.abs(positionDelta).toFixed(1)} places.`);
  if (d.lostQueries.length) out.push(`${d.lostQueries.length} quer${d.lostQueries.length === 1 ? "y" : "ies"} that brought clicks last period brought none this one.`);
  if (d.pagesDown.length >= 3) out.push(`${d.pagesDown.length} pages lost clicks; the worst is ${d.pagesDown[0].key}.`);
  if (!out.length) out.push(previous.clicks || clicks ? "Nothing moved enough to report." : "No search traffic in either period.");
  return out;
}

export async function buildDigest(siteUrl: string, days = 7, endDate = "3daysAgo", rowLimit = 500, minClicks = 3): Promise<Digest> {
  const { resolveDate } = await import("./util.js");
  const end = resolveDate(endDate);
  const p = periods(end, days);
  const fetch = (range: { start: string; end: string }, dimension: "page" | "query") =>
    query({ siteUrl, startDate: range.start, endDate: range.end, dimensions: [dimension], rowLimit });
  const [curPages, prevPages, curQueries, prevQueries] = await Promise.all([
    fetch(p.current, "page"), fetch(p.previous, "page"), fetch(p.current, "query"), fetch(p.previous, "query"),
  ]);

  const totals = totalsOf(curPages), previous = totalsOf(prevPages);
  const pages = compare(curPages, prevPages, minClicks), queries = compare(curQueries, prevQueries, minClicks);
  const core = {
    site: siteUrl,
    period: p,
    totals: {
      ...totals,
      previous,
      clicksDelta: totals.clicks - previous.clicks,
      impressionsDelta: totals.impressions - previous.impressions,
      positionDelta: totals.position !== null && previous.position !== null ? Number((totals.position - previous.position).toFixed(2)) : null,
    },
    pagesDown: pages.down.slice(0, 10), pagesUp: pages.up.slice(0, 5),
    queriesDown: queries.down.slice(0, 10), queriesUp: queries.up.slice(0, 5),
    lostQueries: queries.lost.slice(0, 10), newQueries: queries.fresh.slice(0, 5),
  };
  return { ...core, attention: attentionLines(core) };
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

/** GitHub-flavoured Markdown for the issue body (and the copy kept on disk). */
export function renderDigest(digests: Digest[]): string {
  const out: string[] = [];
  for (const d of digests) {
    const t = d.totals;
    out.push(`## ${d.site}`);
    out.push(`\`${d.period.current.start}\` → \`${d.period.current.end}\` vs \`${d.period.previous.start}\` → \`${d.period.previous.end}\``);
    out.push("");
    for (const line of d.attention) out.push(`- ${line}`);
    out.push("");
    out.push("| | now | before | change |");
    out.push("|---|---|---|---|");
    out.push(`| clicks | ${t.clicks} | ${t.previous.clicks} | ${sign(t.clicksDelta)} |`);
    out.push(`| impressions | ${t.impressions} | ${t.previous.impressions} | ${sign(t.impressionsDelta)} |`);
    out.push(`| CTR | ${t.ctr !== null ? (t.ctr * 100).toFixed(2) + "%" : "-"} | ${t.previous.ctr !== null ? (t.previous.ctr * 100).toFixed(2) + "%" : "-"} | |`);
    const positionChange = t.positionDelta === null ? "" : `${sign(t.positionDelta)} (${t.positionDelta < 0 ? "better" : t.positionDelta > 0 ? "worse" : "unchanged"})`;
    out.push(`| position | ${t.position ?? "-"} | ${t.previous.position ?? "-"} | ${positionChange} |`);
    out.push("");
    const table = (title: string, rows: Mover[], withPosition = true) => {
      if (!rows.length) return;
      out.push(`### ${title}`);
      out.push(withPosition ? "| | clicks | before | change | position |" : "| | clicks | before | change |");
      out.push(withPosition ? "|---|---|---|---|---|" : "|---|---|---|---|");
      for (const r of rows) {
        const cells = [`\`${r.key}\``, String(r.clicks), String(r.previousClicks), sign(r.delta)];
        if (withPosition) cells.push(r.position !== null ? `${r.position}${r.previousPosition !== null ? ` (was ${r.previousPosition})` : ""}` : "-");
        out.push(`| ${cells.join(" | ")} |`);
      }
      out.push("");
    };
    table("Pages that lost clicks", d.pagesDown);
    table("Queries that lost clicks", d.queriesDown);
    table("Queries that stopped bringing clicks", d.lostQueries, false);
    table("Pages that gained", d.pagesUp);
    table("Queries that gained", d.queriesUp);
    table("New queries", d.newQueries);
  }
  out.push("---");
  out.push("Generated by google-seo-mcp. Ask your agent for `seo_digest` any time, or `gsc_compare_periods` for a different window.");
  return out.join("\n");
}

// ---------- schedule ----------

export interface Schedule { weekday: number; hour: number }
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** `mon:08` (UTC) → {weekday, hour}; null when unset or malformed, so a typo never silently disables the digest. */
export function parseSchedule(spec: string | undefined): Schedule | null {
  const m = /^([a-z]{3})\s*[:@ ]\s*(\d{1,2})$/i.exec((spec ?? "").trim());
  if (!m) return null;
  const weekday = WEEKDAYS.indexOf(m[1].toLowerCase());
  const hour = Number(m[2]);
  return weekday < 0 || hour > 23 ? null : { weekday, hour };
}

/**
 * Should the digest run now? True once the scheduled hour has arrived and nothing ran since the
 * previous occurrence — so a restart does not re-send it, and a server that was down at the time
 * still sends it late instead of skipping the week.
 */
export function isDue(schedule: Schedule, now: Date, lastRunISO: string | null): boolean {
  const occurrence = previousOccurrence(schedule, now);
  if (now < occurrence) return false;
  return !lastRunISO || new Date(lastRunISO) < occurrence;
}

/** The most recent moment matching the schedule, at or before `now`. */
export function previousOccurrence(schedule: Schedule, now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour));
  const back = (d.getUTCDay() - schedule.weekday + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

/** Sites to report on, from SEO_MCP_DIGEST_SITES (comma-separated Search Console properties). */
export function digestSites(): string[] {
  return (envValue("SEO_MCP_DIGEST_SITES") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- scheduled run ----------

/** Where the state marker and the Markdown copies live. */
function digestDir(): string | null {
  const dir = envValue("SEO_MCP_DATA_DIR");
  return dir ? dir : null;
}

/**
 * Run the digest for every configured site and file it: a Markdown copy in the data directory and,
 * when SEO_MCP_DIGEST_REPO is set, a GitHub issue. Returns what it did, for the log line.
 */
export async function runDigest(): Promise<{ sites: string[]; issue?: string; file?: string; errors: string[] }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const sites = digestSites();
  const errors: string[] = [];
  const digests: Digest[] = [];
  for (const site of sites) {
    try { digests.push(await buildDigest(site)); } catch (e) { errors.push(`${site}: ${(e as Error).message}`); }
  }
  if (!digests.length) return { sites: [], errors };

  const body = renderDigest(digests);
  const date = digests[0].period.current.end;
  const out: { sites: string[]; issue?: string; file?: string; errors: string[] } = { sites: digests.map((d) => d.site), errors };

  const dir = digestDir();
  if (dir) {
    const file = path.join(dir, "digests", `${date}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body + "\n");
    out.file = file;
  }

  const repo = envValue("SEO_MCP_DIGEST_REPO");
  if (repo) {
    try {
      const { gh } = await import("./tools/github.js");
      const issue = await gh<{ html_url: string }>(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: `SEO digest ${date}`, body: body.slice(0, 60_000), labels: ["seo-digest"] }),
      });
      out.issue = issue.html_url;
    } catch (e) {
      errors.push(`issue: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Start the weekly check when SEO_MCP_DIGEST_SITES is set. The timer ticks hourly rather than
 * sleeping until the exact moment, so a container that restarts (every deploy does) still runs a
 * digest it would otherwise have slept through, and never sends the same week twice.
 */
export function startDigestSchedule(): string | null {
  const sites = digestSites();
  if (!sites.length) return null;
  const spec = envValue("SEO_MCP_DIGEST_AT") ?? "mon:08";
  const schedule = parseSchedule(spec);
  if (!schedule) throw new Error(`SEO_MCP_DIGEST_AT must look like 'mon:08' (weekday:hour, UTC); got '${spec}'.`);

  const markerFile = async () => {
    const path = await import("node:path");
    const dir = digestDir();
    return dir ? path.join(dir, "digest-last-run") : null;
  };
  const tick = async () => {
    try {
      const fs = await import("node:fs/promises");
      const file = await markerFile();
      const last = file ? await fs.readFile(file, "utf8").then((s) => s.trim()).catch(() => null) : null;
      if (!isDue(schedule, new Date(), last)) return;
      const now = new Date().toISOString();
      if (file) await fs.writeFile(file, now);   // written first: a failure must not retry every hour
      const result = await runDigest();
      console.error(JSON.stringify({ digest: "sent", at: now, ...result }));
    } catch (e) {
      console.error(JSON.stringify({ digest: "failed", at: new Date().toISOString(), error: (e as Error).message }));
    }
  };
  setTimeout(() => void tick(), 30_000).unref();          // once shortly after boot, for a missed week
  setInterval(() => void tick(), 3600_000).unref();
  return `weekly digest ${spec} UTC for ${sites.join(", ")}${envValue("SEO_MCP_DIGEST_REPO") ? ` → issues in ${envValue("SEO_MCP_DIGEST_REPO")}` : ""}`;
}
