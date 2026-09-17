# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Search Console
- Analysis tools no longer truncate silently. `gsc_opportunities`, `gsc_cannibalization`, `gsc_ctr_opportunities` and `gsc_question_queries` request the API's 25000-row maximum in one call; when the response comes back at that limit the result now carries `truncated: true` and a note telling you to shorten the period or add a filter, instead of quietly analysing part of the property.
- `gsc_index_coverage` keeps the inspection fields it used to drop: which sitemaps list each URL, its referring URLs (first five, with the real total), and rich-result issues with their severity rather than a bare list of type names. It also derives `orphan` (indexed, in no sitemap, nothing linking to it) and an orphan count, set only when the inspection came back complete, because Google omits both lists on partial results.
- `gsc_compare_periods` compares by `searchAppearance` and `date` as well, and accepts `dataState` and `aggregationType`.
- `gsc_site_snapshot` accepts `dataState`; with `all` the window ends yesterday instead of three days ago, so fresh not-yet-final data is visible. It also accepts `aggregationType`. With the default `final` the dates are unchanged.
- `gsc_rich_results_report` and `gsc_question_queries` accept `searchType`; they were locked to web results.
- `gsc_list_sitemaps` accepts `sitemapIndex`, listing the child sitemaps inside an index file with their own error and warning counts. On a Yoast site that is how you find which child file holds the problem.

### Added
- `canonical_host_check`: confirms http/https, www/bare and trailing-slash variants of a URL all end at one address, with the full redirect chain for each. Two variants both answering 200 splits ranking signals between what Google reads as two sites; it is a silent failure on Cloudflare Pages and after a WordPress migration, and nothing here tested for it.
- Search Console analysis tools accept `filters`: `gsc_site_snapshot`, `gsc_opportunities`, `gsc_cannibalization`, `gsc_ctr_opportunities` and `gsc_question_queries` can now be scoped to a language folder or a site section (`page contains /es/`, or a regex) instead of always covering the whole property. `gsc_opportunities` merges them with its existing `country` shortcut.
- `gsc_search_analytics` supports the `hour` dimension with `dataState: "hourly_all"` (up to the last 10 days by hour), to confirm within hours that a republished page is being picked up rather than waiting out the 2-3 day lag. The two must be used together, and the tool now says so instead of letting the API return a 400.
- `github_build_status`: whether a commit actually built and went live. Reads Actions check runs, the combined commit status and deployments with their latest state, optionally waiting until everything settles and tailing the log of a failed job. Hosts that deploy without reporting back to GitHub (Cloudflare Pages on this setup reports nothing) are covered by `verifyUrl`/`expectText`, which fetches the page and confirms the change is served. Closes the loop after `github_commit_files`: until now the server committed and went blind, so it could submit a URL to IndexNow or Search Console before the site had rebuilt.
- `wp_upload_media`: fetch an image by URL, convert and resize it on the server through the same sharp pipeline as `github_commit_image`, upload it into the WordPress media library with alt text, and optionally set it as a post's featured image. The image pipeline previously only reached GitHub, so `pagespeed` and `crux_history` could diagnose an oversized hero image on the WordPress site with no way to fix it.
- `wp_update_seo` now also writes the Open Graph and Twitter title/description/image overrides, Yoast's schema page/article type and the cornerstone flag; `wp_get_post` returns them. `social_preview_check` could report a bad sharing image that nothing here was able to change. Prefer `schemaPageType` over `wp_set_schema` for page type, since `wp_set_schema` adds a second JSON-LD block that can contradict Yoast's graph.
- `wp_builder_restore`: undo for `wp_builder_update`. Every builder write now snapshots the post's raw `mfn-page-items` first (last 3 kept) and a restore can roll back to any of them; restoring snapshots the current state too, so it is itself reversible. WordPress does not version postmeta, so before this a builder edit could not be undone by a revision restore. `wp_builder_check` lists the snapshots.

### Fixed
- `ai_citation_check` now calls Perplexity's Agent API (`POST /v1/agent`). The Sonar chat-completions endpoint it used is retired on 2026-09-27, which would have broken the tool outright. Web search is opt-in on the new API, so the request declares the `web_search` tool explicitly; in-text citations are reported ahead of the plain search results. `model` becomes `effort` (fast/low/medium).
- GA4 reports asked for no aggregation, so `totals` was always empty. `ga_run_report`, `ga_run_realtime_report`, `ga_batch_run_reports` and `ga_compare_periods` now send `metricAggregations: ["TOTAL"]`.
- `ga_compare_periods` summed every metric across dimension rows, which is meaningless for rates (`engagementRate`, `bounceRate`) and averages. It now uses the API's own per-period totals and, when the API returns none, reports a non-additive metric as `null` with a note instead of a wrong number.
- Search Console filters accepted `date` as a filter dimension, which the API rejects with HTTP 400. The filter schema is now limited to the five dimensions the API actually accepts.
- `crux_history` never sent `collectionPeriodCount`, so the API returned its default of 25 collection periods and any `weeks` above 25 was silently capped. It now requests the number asked for (up to 40) and also returns `poorShareSeries` alongside the good share.

### Changed
- `reviews_snapshot` no longer emits a ready-to-paste `AggregateRating` block and no longer suggests using Google Maps ratings as a schema source. Google prohibits aggregating ratings from other sites, and a business marking up reviews about itself makes the page ineligible for review stars; the tool now returns an explicit warning instead.

### Known issues
- Binary files must never travel through the model as base64 `content` in `github_commit_files`: on 2026-09-14 a client session (claude.ai app) emailed a photo, ran `github_commit_attachment` only as a dry run, then committed a ~67 KB WebP whose base64 it had written out itself. The RIFF/VP8 header was plausible, so the file decoded without errors, but the pixel data was noise. A guard that rejects base64 image content above a few KB (pointing to `github_commit_image` / `github_commit_attachment`) is planned but not implemented yet.

### Fixed
- `page_audit` / `site_crawl` no longer count `alt=""` (decorative images) as missing alt text; only a missing attribute is reported, and `images.decorativeEmptyAlt` gives the count of intentionally empty ones (a site with decorative arches was reported as 328 missing).

## [0.9.0] - 2026-09-11

### Added
- Hosted mode: GitHub connection through a GitHub App (`SEO_MCP_GITHUB_APP_*`). Users install the app on the repositories they choose; the server verifies the installation against the signed-in GitHub user (OAuth code returned with the installation), stores only the installation id and mints one-hour installation tokens on demand. Connected users get the `github_*` toolset including `github_commit_files` and `github_commit_image` while the rest of their server stays read-only; *Disconnect* uninstalls the app. GitHub tools inside a hosted request never fall back to the operator's `GITHUB_TOKEN`.
- `ServerOptions.allowWrite` (write-tool prefixes that survive `readOnly`); write-audit lines carry `who` for hosted users; `google_auth_status` reports the scopes actually granted by the user.

## [0.8.0] - 2026-09-11

### Added
- Hosted mode (optional, `SEO_MCP_HOSTED_*` + `SEO_MCP_PUBLIC_URL`): a landing page (English/Chinese), *Sign in with Google*, and a dashboard where each user creates up to 10 personal bearer tokens for `/mcp`, plus privacy and terms pages. Users grant read-only Search Console and GA4 scopes; refresh tokens are AES-256-GCM encrypted in a `node:sqlite` database; a `seo_…` token runs the request inside that user's OAuth grant (`AsyncLocalStorage` scope around the request) on a read-only server limited to the `gsc`, `ga4`, `web`, `geo`, `analysis` toolsets, without the tools that spend paid third-party quotas. The operator's `MCP_AUTH_TOKEN` is unchanged.
- `ServerOptions.exclude` to leave named tools unregistered; `formatError` hint for revoked/expired Google grants (`invalid_grant`).
- Docker: `./data` volume at `/data` for the hosted database.

### Changed
- README architecture diagram, keywords, `package.json` description/keywords and the repository description now cover the Gmail integration and the image pipeline (the 0.7.0 release had left them out).

### Security
- `sharp` 0.34.5 → 0.35.x (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c reported by Dependabot right after the 0.7.0 release).

## [0.7.0] - 2026-09-11

### Added
- Gmail attachment tools (optional, read-only OAuth via `npm run auth -- --gmail`): `gmail_find_attachments` lists messages and their attachments; `github_commit_attachment` takes one attachment, converts it on the server when it is an image (same options as `github_commit_image`) and commits it. A photo someone emailed reaches the repository without passing through any client machine.
- Write audit log: every write-tool call logs one JSON line to stderr (tool, outcome, duration, client user agent, identifiers such as post id, repo, branch, file paths; never content), visible with `docker logs`.

### Changed
- `docker-compose.yml` mounts the whole `secrets/` directory read-only at `/secrets` (service account, optional Gmail credentials) instead of the single file.

## [0.6.0] - 2026-09-11

### Added
- `github_commit_files`: per-file `edits` (in-place find/replace against the branch's current content, each find validated to match exactly once, so a 300 KB content bundle no longer has to be resent) and `encoding: base64` for binaries; files whose content already matches are skipped.
- `github_commit_image`: fetch an image from a URL, convert it on the server (webp by default), resize or cover-crop it (attention-based or centred), add variants such as a card thumbnail, and commit everything in one commit. With these two, a blog post with pictures can be published to a static site from a phone through MCP alone.

### Changed
- README (both languages): client setup for the Claude apps, OpenAI Codex, Cursor, VS Code, Gemini CLI and any other MCP client, with timeout notes and the ChatGPT OAuth limitation; tagline, keywords and repository description mention Codex/Cursor and the current tool count.
- README (both languages): "Works with any agent" section: compatibility table, Claude Agent SDK and OpenAI Agents SDK examples (DeepSeek through an OpenAI-compatible endpoint), third-party and local models with a read-only trimmed second instance, and the known limits (ChatGPT OAuth-only connectors, legacy SSE clients, Codex providers needing the Responses API).
- README (both languages): community acknowledgment of LINUX DO.

### Fixed
- `page_audit` (and therefore `site_crawl` / `compare_pages`) reported "No JSON-LD structured data" on every page: script tags were stripped for the word count before the JSON-LD blocks were read. Extraction now runs first via the exported `extractJsonLdTypes()` (unit-tested).

## [0.5.1] - 2026-09-09

### Added
- `envValue()`: environment variables that are empty or whitespace-only count as unset everywhere. Docker's `env_file` passes `KEY=` through as an empty string, which previously satisfied `??` fallbacks; optional integrations now fall back correctly and an empty `MCP_PORT` / `MCP_AUTH_TOKEN` can no longer pick a random port or disable authentication.

### Changed
- `/healthz` returns only `{"ok":true}` to unauthenticated callers; version and credential source are included when the request carries the Bearer token.
- Deploy workflow decides "docs-only" against the previously pushed commit instead of `HEAD~1`, so multi-commit pushes deploy correctly; `deploy/vps-self-update.sh` prunes dangling images and build cache beyond 4 GB after a healthy deploy; the Nginx sample gains HSTS, a per-IP rate limit and an unauthenticated `/healthz` location.
- README lists the 21 WordPress tools by name; `.env.example` and both READMEs document `GOOGLE_CREDENTIALS_JSON`, `SEO_MCP_MAX_RESULT_CHARS` and the OAuth variables used by `npm run auth`.
- Dependencies: zod 4 (record schemas now declare their key type; tool schemas otherwise unchanged), Docker image on Node 26 (same runtime as development; LTS from 2026-10-28), GitHub Actions `checkout`/`setup-node` v7; CI tests on Node 26.

### Removed
- npm / MCP-registry publishing preparation (`server.json`, scoped package name); the package is marked `private` and is installed from the repository only.

### Fixed
- `npm test` now runs the unit tests (present since 0.5.0 but never wired into the script, so CI did not execute them).
- `package.json` `main` pointed to a non-existent `index.js`; it is `dist/index.js`.

### Security
- `social_preview_check`: the ICNS, JXL and HEIF parsers of `image-size` are disabled (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq: unbounded loops on crafted files, no fixed release yet) because `og:image` bytes come from third-party hosts.

## [0.5.0] - 2026-09-09

### Added
- `dryRun` on every WordPress write tool and on `github_commit_files`: returns current values and the intended changes without writing.
- Unit tests (`node:test`) for the robots.txt parser, URL/path normalisation, date helpers, dotenv parser, schema audit and tool classification; CI workflow runs build, tests and the secret scan on every push and pull request, and `main` deploys only after they pass.
- Progress notifications on all long-running tools (index coverage, structured-data audit, E-E-A-T audit, llms.txt generation, hreflang, cross-site links, brand mentions, AI crawler access).
- Result size guard: oversized arrays are trimmed to `SEO_MCP_MAX_RESULT_CHARS` with a note on how to narrow the request.
- Dependabot for npm, GitHub Actions and Docker.

### Changed
- Tool results are compact JSON instead of pretty-printed (fewer tokens per call); repeated parameter descriptions shortened.
- `knowledge_graph_check` and `brand_mentions` belong to the `geo` toolset.

## [0.4.0] - 2026-09-09

### Added
- Search Console management: `gsc_delete_sitemap`, `gsc_add_site`, `gsc_delete_site`.
- GA4: `ga_run_pivot_report`, `ga_batch_run_reports`, `ga_run_funnel_report` (v1alpha), `ga_check_compatibility`, `ga_property_config` (read-only Admin API: streams, custom definitions, key events, audiences, Ads links, retention).
- Production Docker image with SSH client and PHP helpers, health check, `docker-compose.yml` with mounted secrets.
- Push-to-deploy: `.github/workflows/deploy.yml` triggers `deploy/vps-self-update.sh` on the server through a forced-command SSH key; `deploy/deploy-vps.sh` for manual updates.
- `scripts/sync-readme.mjs` keeps tool counts in the READMEs and `package.json` in sync (checked by `npm test`); dynamic tools badge.

### Changed
- Server version is read from `package.json`.

## [0.3.0] - 2026-09-09

### Added
- 72 tools across Search Console, GA4, page and site audits (`site_crawl`, `hreflang_check`, `compare_pages`, `social_preview_check`, `keyword_suggest`), GEO (`ai_crawler_access`, `llms_txt_*`, `structured_data_audit`, `schema_*`, `geo_page_score`, `eeat_audit`, `knowledge_graph_check`, `indexnow_submit`, `ai_citation_check`, `brand_mentions`), analysis (`migration_check`, `cross_site_links`, `content_refresh_candidates`, `crux_history`, `reviews_snapshot`), WordPress (posts, Yoast, page builder, media, terms, redirects, JSON-LD injection) and GitHub (read, search, atomic multi-file commits).
- Tool annotations, server instructions, `--read-only` mode, `--toolsets` filtering, `.env` auto-loading, smoke test with tool snapshot, secret-scan git hooks.
- stdio and stateless Streamable HTTP transports with Bearer auth.

[Unreleased]: https://github.com/Akxan/google-seo-mcp/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Akxan/google-seo-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Akxan/google-seo-mcp/releases/tag/v0.3.0
