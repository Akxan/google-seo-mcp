# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Akxan/google-seo-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Akxan/google-seo-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Akxan/google-seo-mcp/releases/tag/v0.3.0
