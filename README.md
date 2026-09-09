# google-seo-mcp

An [MCP](https://modelcontextprotocol.io) server that turns Google Search Console, Google Analytics 4, on-page/GEO audits, WordPress (via WP-CLI over SSH) and GitHub into **72 tools** an AI assistant can use to run SEO and GEO (generative-engine optimization) operations for your websites: diagnose, then fix, in one conversation.

Works with Claude Code, Claude Desktop and any MCP client over stdio, or as a Streamable HTTP server for 24/7 use.

## What it can do

| Area | Tools |
|---|---|
| **Search Console** | list sites, performance queries with filters/pagination, period comparison, one-call site snapshot, striking-distance keywords (`gsc_opportunities`), CTR opportunities, cannibalization, question queries for FAQ/AI Overview targets, rich-results report, URL inspection, batch index coverage, sitemaps |
| **GA4** | list properties, `run_report` with simple or raw filters, realtime, metadata, period comparison, organic landing pages merged with Search Console data |
| **Page & site audits** | `page_audit`, `site_crawl` (broken links, redirect chains, duplicates, thin/orphan pages), `pagespeed` (PageSpeed Insights / Core Web Vitals), `crux_history`, sitemap and robots checks, hreflang check, social preview (Open Graph) check, competitor page comparison, Google Autocomplete keyword ideas |
| **GEO** | AI crawler access (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended…), `llms.txt` check and generator, structured-data audit with entity consistency, `geo_page_score`, E-E-A-T audit, JSON-LD generation/validation, Knowledge Graph + Wikidata entity check, IndexNow, Perplexity citation check, brand mentions, Google reviews snapshot |
| **Analysis** | pre-migration URL safety net (`migration_check`), cross-site link opportunities between two properties, content-refresh candidates |
| **WordPress** (optional) | posts, Yoast SEO fields (single and bulk), BeTheme/Muffin Builder content, media alt text, categories/tags, internal-link suggestions, Yoast Premium redirects, JSON-LD injection, raw WP-CLI |
| **GitHub** (optional) | read files, list directories, search code, list commits, atomic multi-file commits so a static site can be edited from any client |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`…), the server publishes `instructions` for the model, and there is a read-only mode and toolset filtering.

## Quick start

Requirements: Node 18+, a Google Cloud project with the **Search Console API**, **Google Analytics Data API** and **Google Analytics Admin API** enabled.

```bash
git clone https://github.com/Akxan/google-seo-mcp.git
cd google-seo-mcp
npm install
npm run build
cp .env.example .env      # fill in credentials (see below)
```

### Google credentials

**Service account (recommended, works unattended):** create a service account in the Cloud project, download its JSON key, set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` in `.env`, then add the service-account email as a user on each Search Console property (permission *Full*) and each GA4 property (role *Viewer*).

**Your own Google account (OAuth):** create an OAuth client ID of type *Desktop app*, download `client_secret.json`, run

```bash
npm run auth -- --client-secret ./client_secret.json
```

and the resulting `~/.config/google-seo-mcp/credentials.json` is picked up automatically.

Lookup order: `GOOGLE_CREDENTIALS_JSON` (inline) → `GOOGLE_APPLICATION_CREDENTIALS` → `~/.config/google-seo-mcp/credentials.json` → Application Default Credentials.

### Connect a client

Claude Code:

```bash
claude mcp add google-seo -- node /absolute/path/google-seo-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "google-seo": {
      "command": "node",
      "args": ["/absolute/path/google-seo-mcp/dist/index.js"]
    }
  }
}
```

The server reads `.env` from its own directory at startup, so client configs need nothing but the command. Environment variables passed by the client take precedence.

Try: *"List my Search Console sites"*, *"Give me a snapshot of example.com for the last 28 days"*, *"Which queries rank 8-20 with the most impressions?"*, *"Audit https://example.com/page and score it for AI answer engines"*.

## Configuration

All settings live in `.env` (see `.env.example`, which documents every key). Summary:

| Variable | Purpose |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CREDENTIALS_JSON` | Google auth |
| `PAGESPEED_API_KEY` | PageSpeed Insights (free; without it you share a public quota that is usually exhausted) |
| `CRUX_API_KEY`, `GOOGLE_API_KEY` | Chrome UX Report API, Knowledge Graph Search API (free; fall back to `PAGESPEED_API_KEY`) |
| `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_PLACES_API_KEY` | optional: brand mentions, AI citation check, Google reviews |
| `INDEXNOW_KEY`, `INDEXNOW_KEY_LOCATION` | optional: IndexNow submissions |
| `GITHUB_TOKEN` | GitHub tools (falls back to `gh auth token`) |
| `WP_SITES` | JSON array of WordPress sites reachable over SSH; omit to disable `wp_*` tools |
| `SEO_MCP_READ_ONLY=1` or `--read-only` | register no write tools |
| `SEO_MCP_TOOLSETS` or `--toolsets=` | comma list of `gsc,ga4,web,geo,analysis,wordpress,github` |
| `MCP_TRANSPORT=http`, `MCP_HOST`, `MCP_PORT`, `MCP_PATH`, `MCP_AUTH_TOKEN` | HTTP mode |

Tools that need an optional key return an error explaining how to obtain it instead of silently disappearing.

### WordPress over SSH

`WP_SITES='[{"name":"mysite","host":"1.2.3.4","port":22,"user":"ssh_user","path":"domains/example.com/public_html"}]'`

Needs WP-CLI on the host and passwordless SSH from the machine running the server. Two PHP helpers (`scripts/mfn-builder.php`, `scripts/wp-helper.php`) are uploaded to `~/.google-seo-mcp/` on the host on first use. Yoast changes rebuild the Yoast indexable and purge WP Rocket / Super Cache / W3TC / LiteSpeed for the affected post. `wp_set_schema` installs a 5-line mu-plugin that prints stored JSON-LD in `<head>`.

## Running as a 24/7 HTTP server

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js --http
curl http://127.0.0.1:8080/healthz
```

Stateless Streamable HTTP: a fresh server instance per request, Bearer-token auth, loopback bind by default. `deploy/` contains a systemd unit, an env-file example and Caddy/Nginx reverse-proxy samples (Nginx needs `proxy_buffering off`). `Dockerfile` and `docker-compose.yml` are provided. Connect remote clients with

```bash
claude mcp add --transport http google-seo https://mcp.example.com/mcp --header "Authorization: Bearer <token>"
```

## Development

```bash
npm run dev          # tsx src/index.ts (stdio, no build)
npm run build        # tsc -> dist/
npm test             # smoke test: tool descriptions, annotations, instructions, tool-list snapshot
npm run inspector    # MCP Inspector against dist/
npm run check:secrets  # scan tracked files for keys / personal data (also runs as pre-commit and pre-push hooks)
```

Layout: `src/server.ts` builds the server (annotations, read-only mode, toolsets, instructions), `src/tools/*` hold one module per area, `src/google.ts` the Google clients, `src/util.ts` the tool wrapper and date helpers. See `CLAUDE.md` for architecture notes.

## Notes and limits

- Search Console data lags 2–3 days; end date ranges at `3daysAgo`. URL Inspection has a ~2,000 calls/day quota per property.
- PageSpeed runs take 15–60 s; the tool retries once and sends progress notifications. Pages that never become idle cannot be audited by Lighthouse.
- CrUX only has data for origins with enough Chrome traffic.
- All fetched page text and CMS content is untrusted third-party data; the server instructions tell the model not to follow instructions found in it.

## License

MIT
