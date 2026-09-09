# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

一个 MCP 服务（TypeScript，`@modelcontextprotocol/sdk`），把 Google Search Console、Google Analytics 4 Data API，以及可选的 WordPress（通过 SSH 执行 WP-CLI）封装成工具，用于 SEO 运维。本地客户端走 stdio，服务器 24 小时运行走 Streamable HTTP。面向用户的说明在 `README.md`（英文）和 `README.zh-CN.md`（中文）。

## 常用命令

```bash
npm run build          # tsc 编译到 dist/（postbuild 会给 dist/index.js 加执行权限）。每次改 src 后必须重新构建：客户端跑的是 dist/，不是 src/
npm run dev            # tsx src/index.ts（stdio，免构建）
npm start              # node dist/index.js（stdio）
npm run start:http     # node dist/index.js --http（或设置 MCP_TRANSPORT=http）
npm run inspector      # 用 MCP Inspector 调试 dist/
npm run auth -- --client-secret ./client_secret.json   # 一次性 OAuth 授权，写入 ~/.config/google-seo-mcp/credentials.json
```

`npm test` 跑 `test/smoke.mjs`：启动服务、检查每个工具的描述与注解、比对 `test/tools.snap.json` 的工具清单（增删工具后用 `UPDATE_SNAPSHOT=1 npm test` 刷新），不访问网络。真实调用的验证用临时的 MCP 客户端脚本：

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "service-account.json", WP_SITES: "[...]" } }));
console.log(await c.callTool({ name: "gsc_list_sites", arguments: {} }));
```

脚本要放在仓库根目录运行（需要从 `node_modules` 解析 SDK），用完删掉。测 HTTP 模式用 `curl -X POST /mcp`，带 `Authorization: Bearer` 和 `Accept: application/json, text/event-stream` 两个头。

## 架构

- `src/server.ts`：`createServer()` 创建 `McpServer` 并注册全部工具。两种传输都调用它；HTTP 传输是**每个请求新建一个服务实例**（无状态，`sessionIdGenerator: undefined`）。它包了一层 `registerTool`：按工具名推断注解（`WRITE_TOOLS`、`DESTRUCTIVE_TOOLS` 正则）、只读模式下跳过写入工具、按 `toolsetOf()` 应用工具集筛选。**新增写入类工具时必须让名字匹配这两个正则**，否则会被当成只读。服务器 instructions 在 `buildInstructions()` 里。
- `src/index.ts`：入口，根据 `--http` 参数或 `MCP_TRANSPORT=http` 选择 stdio 或 HTTP。`src/http.ts` 是纯 `node:http` 服务，带 Bearer Token 鉴权（`MCP_AUTH_TOKEN`）、`/healthz`，默认只绑回环地址。
- `src/google.ts`：单例 `GoogleAuth`，以及 `googleapis` 客户端工厂（`searchconsole v1`、`analyticsdata v1beta`、`analyticsadmin v1beta`）。凭据查找顺序：`GOOGLE_CREDENTIALS_JSON` → `GOOGLE_APPLICATION_CREDENTIALS` → `~/.config/google-seo-mcp/credentials.json` → ADC。GA4 用的是 `googleapis` 的 REST 客户端而不是 `@google-analytics/data`，避免引入 gRPC。
- `src/util.ts`：`tool(fn)` 包装所有处理函数，返回值 JSON 序列化进文本内容，抛出的异常经 `formatError` 变成 `isError` 结果（缺凭据和 403 会附加提示）。`resolveDate()` 把 `today`、`yesterday`、`NdaysAgo` 转成 `YYYY-MM-DD`，因为 Search Console 只接受绝对日期。
- `src/tools/gsc.ts`、`src/tools/ga.ts`：Google 工具。输入 schema 是传给 `registerTool` 的 zod raw shape，`.describe()` 文本要写清楚，那是 LLM 唯一能看到的说明。GA 的行数据由 `tabulate()` 拍平成 `{维度: 值, 指标: 数字}` 对象。
- `src/tools/web.ts`：不依赖 Google 授权的网页检查（`page_audit` 用 cheerio 解析、`pagespeed`、`sitemap_check`、`robots_check`）。`collectSitemapUrls()` 和 `parseRobots()` 被 gsc 模块复用。
- `src/tools/crawl.ts`：`site_crawl`（去重用去尾斜杠的 key，但请求始终用原始 URL，否则会误报 301 链）、`hreflang_check`、`compare_pages`（识别反爬页）、`social_preview_check`、`keyword_suggest`。
- `src/tools/analysis.ts`：跨数据源分析（`migration_check`、`cross_site_links`、`content_refresh_candidates`、`knowledge_graph_check`、`crux_history`、`brand_mentions`、`reviews_snapshot`），依赖 `gsc.ts` 导出的 `query()` 和 `normalizePath()`。
- `src/tools/github.ts`：GitHub REST，`github_commit_files` 用 Git Data API 一次提交多文件；token 取 `GITHUB_TOKEN`，否则 `gh auth token`。
- `src/tools/geo.ts`：GEO 与信任信号检查。`BOTS` 表维护 AI 爬虫的 robots 令牌和 UA 字符串；`SCHEMA_RULES` 是各 schema 类型的必填/推荐字段表；`analyzePage()` 是 `geo_page_score` 和 `eeat_audit` 共用的页面信号提取。`indexnow_submit` 和 `ai_citation_check` 依赖可选环境变量，缺失时返回带说明的错误而不是不注册。
- `src/tools/wp.ts`：WordPress 工具。只在设置了 `WP_SITES`（JSON 数组）或 `WP_SSH_*` 环境变量时注册。每次调用都是 `spawn` 一个 `ssh … 'cd <path> && wp …'`；所有远程参数都经 `shq()` 做 POSIX 单引号转义。大块数据（正文、构建器修改）通过 stdin 传，不放进 argv。
  - Yoast 字段就是原始 post meta（`_yoast_wpseo_title`、`_yoast_wpseo_metadesc` 等）。写完 meta 后 `rebuildYoastIndexable()` 用 `wp eval` 调 Yoast 的 `Indexable_Builder`，否则前台标题不会变。`purgeCache()` 清该文章在 WP Rocket、Super Cache、W3TC、LiteSpeed 中的缓存。
  - `scripts/wp-helper.php` 承载所有批量或需要 PHP 逻辑的操作（SEO 状态、批量 Yoast、媒体、分类、内链建议、Yoast Premium 重定向），输入输出都是 STDIN/STDOUT 的 JSON，由 `runHelper()` 调用。`wpPostIndexForHost()` 缓存全站 URL 到文章 ID 的映射，供 `gsc_opportunities` 使用。
  - `scripts/mfn-builder.php` 处理 BeTheme（Muffin Builder）的文章，这类文章正文以 base64 加 PHP 序列化的形式存在 `mfn-page-items` meta 里，`post_content` 是空的。`ensureHelper()` 在 sha256 不一致时把脚本上传到主机的 `~/.google-seo-mcp/`，再用 `wp eval-file` 执行。`eval-file` 的代码跑在函数作用域内，PHP 里不能依赖 `global` 变量。`set` 动作会重新生成 `mfn-page-items-seo` 并调用 `wp_update_post`，让 Yoast 和缓存插件感知到变化。
- `deploy/`：systemd 单元、环境变量样例、Caddy 和 Nginx 反代示例（Nginx 必须 `proxy_buffering off`，否则 SSE 不通）。`Dockerfile` 和 `docker-compose.yml` 用于 HTTP 模式。

## 公共仓库规则（必须遵守）

本项目公开在 GitHub `Akxan/google-seo-mcp`。

- **每次改动完成后立即 `git commit` 并 `git push`**，不积攒。**提交信息一律用中文**，说明改了什么和为什么。
- **每次提交前后都要检查不含个人与敏感信息**：`scripts/check-secrets.sh` 作为 pre-commit 与 pre-push 钩子自动运行（`npm install` 时的 `prepare` 会设置 `core.hooksPath`）；改动涉及文档或示例时再手动跑一次 `npm run check:secrets`。机器特有的标识（IP、用户名、域名、项目 ID）写在 `.secret-patterns.local`（gitignored）里供扫描器使用。工具描述、示例、测试里一律用 `example.com`、`octocat/my-site` 这类占位值。
- 个人与站点相关的信息只放在 `.env`（含注释）和 `CLAUDE.local.md`，两者都不入库；本文件保持通用。
- **README.md 用英文，每次新增或修改功能都要同步更新**（工具表、配置项、限制）；`README.zh-CN.md` 是中文版，功能变化时一并更新。
- 提交身份用仓库本地设置的 GitHub noreply 邮箱，不用个人邮箱。
- 不要把 `.env`、`service-account.json`、`CLAUDE.local.md`、`.secret-patterns.local` 从 `.gitignore` 移除。

## 配置与密钥

- **`.env` 是唯一真源**（gitignored）：Google 凭据路径、各 API 密钥、`WP_SITES`、可选第三方密钥、HTTP 模式参数，外加注释形式的站点信息、资源 ID、客户端配置位置和依赖清单。`src/env.ts` 在 `index.ts` / `auth.ts` 启动时读取它（按包根目录定位，与工作目录无关；已存在的环境变量优先）。`.env.example` 是脱敏模板。
- 两个客户端配置只包含启动命令，不再各自存密钥：新增或更换密钥只改 `.env`，然后重启桌面 App / 新开 Claude Code 会话。
- 新增需要密钥的工具时：在 `.env` 和 `.env.example` 各加一行带用途注释的条目，工具在密钥缺失时抛出带申请路径的错误（不要在注册阶段隐藏工具）。

## 约定与注意事项

- stdio 模式下除 MCP 协议外不能往 stdout 写任何东西，日志一律用 `console.error`。
- `.env`、`service-account.json`、`credentials.json`、`client_secret*.json` 已在 `.gitignore`，秘密不进仓库，也不要出现在工具描述里。
- 工具同时注册在 Claude Code（用户级，`claude mcp get google-seo`）和 Claude 桌面 App（`~/Library/Application Support/Claude/claude_desktop_config.json`），两边都只指向 `dist/index.js`。新增工具只需重新构建；改密钥只改 `.env`。
- Search Console 数据延迟 2 到 3 天；URL 检查每个资源每天约 2000 次配额，不要对整站循环调用。
- 对基于构建器的文章，`wp_update_post` 的 `content` 参数会被主题忽略，要用 `wp_builder_*` 工具。第一次编辑某篇文章前先跑 `wp_builder_check`。
