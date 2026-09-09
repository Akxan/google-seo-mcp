# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Removed
- npm / MCP-registry publishing preparation (`server.json`, scoped package name); the package is marked `private` and is installed from the repository only.

### Changed
- Dependencies: zod 4 (record schemas now declare their key type; tool schemas otherwise unchanged), Docker image on Node 26 (same runtime as development; LTS from 2026-10-28), GitHub Actions `checkout`/`setup-node` v7; CI tests on Node 26.

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

[Unreleased]: https://github.com/Akxan/google-seo-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Akxan/google-seo-mcp/releases/tag/v0.3.0
