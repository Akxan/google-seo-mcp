# Contributing to google-seo-mcp

Thanks for helping improve **google-seo-mcp**, the SEO & GEO MCP server for Claude Code, Cursor, Codex and any MCP client. Bug reports, tool ideas, documentation fixes and pull requests are all welcome.

> 中文：欢迎提交 Issue 和 Pull Request，用中文或英文都可以。下面的流程与要求对中英文贡献者相同。

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/Akxan/google-seo-mcp/issues/new/choose) first for anything larger than a small fix, so we can agree on the approach.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Never include real data.** Issues, tests, fixtures, examples and commit messages are public. Use placeholders such as `example.com`, `sc-domain:example.com` and `octocat/my-site`, never a real site, property ID, token or email address.

## Development setup

Requirements: Node.js 22 or newer, npm, and (for the WordPress helper tests) PHP.

```bash
git clone https://github.com/Akxan/google-seo-mcp.git
cd google-seo-mcp
npm ci            # also installs the git hooks that run the secret scan
npm run build     # compiles src/ to dist/ — clients run dist/, so rebuild after every change
npm test          # unit tests, MCP smoke test and README checks; no network access
```

`npm run dev` starts the server over stdio without building, and `npm run inspector` opens it in the MCP Inspector.

## Adding or changing a tool

1. Register it in the matching `src/tools/*.ts` module with `server.registerTool`. The name prefix (`gsc_`, `ga_`, `wp_`, `github_`, …) decides its toolset.
2. Give every parameter a `.describe()` and use `z.enum` for fixed choices. Keep descriptions short and precise: all tool definitions travel with every conversation.
3. **Write tools** must match the `WRITE_TOOLS` pattern in `src/server.ts` (and `DESTRUCTIVE_TOOLS` when they delete), and must offer a `dryRun` parameter that shows the current value and the planned change without applying it.
4. Export pure helper functions and cover them in `test/unit/`.
5. Run `UPDATE_SNAPSHOT=1 npm test` to refresh the tool snapshot, then `npm run docs:sync` to update the tool counts in both READMEs, then `npm test` again.
6. Add the tool to the tables in `README.md` and `README.zh-CN.md`, and a line under **Unreleased** in `CHANGELOG.md`.

## Pull requests

- Keep each pull request focused on one change and describe what changed and why.
- CI runs the build, the tests and the secret scan on every push and pull request; it must pass before merging.
- Test write tools only against throwaway objects (a draft post, a temporary branch, a no-op write), never against live content.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
