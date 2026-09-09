# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

一个 MCP 服务（TypeScript，`@modelcontextprotocol/sdk`），把 Google Search Console、Google Analytics 4（Data API 与只读 Admin API）、网页与 GEO 审计（PageSpeed、CrUX、结构化数据、AI 爬虫、llms.txt 等）、跨数据源分析，以及可选的 WordPress（通过 SSH 执行 WP-CLI）和 GitHub 读写封装成约 80 个工具，用于 SEO/GEO 运维。生产环境是部署在服务器上的 Streamable HTTP 实例，所有客户端都连它；本机 stdio 只用于开发验证。面向用户的说明在 `README.md`（英文）和 `README.zh-CN.md`（中文）。

## 常用命令

```bash
npm run build          # tsc 编译到 dist/（postbuild 会给 dist/index.js 加执行权限）。每次改 src 后必须重新构建：客户端跑的是 dist/，不是 src/
npm run dev            # tsx src/index.ts（stdio，免构建）
npm start              # node dist/index.js（stdio）
npm run start:http     # node dist/index.js --http（或设置 MCP_TRANSPORT=http）
npm run inspector      # 用 MCP Inspector 调试 dist/
npm run docs:sync      # 按工具清单快照同步两份 README 与 package.json 的工具计数（npm test 会校验）
npm run check:secrets  # 扫描所有已跟踪文件里的密钥与个人信息（提交/推送钩子会自动跑）
npm run auth -- --client-secret ./client_secret.json   # 一次性 OAuth 授权，写入 ~/.config/google-seo-mcp/credentials.json
```

`npm test` 依次跑：`test/unit/*.test.mjs`（`node:test`，针对 `dist/` 里导出的纯函数：robots 解析、URL/路径归一化、日期、dotenv、schema 审计、工具分类）、`test/smoke.mjs`（启动服务、检查描述与注解、比对 `test/tools.snap.json`，增删工具后用 `UPDATE_SNAPSHOT=1 npm test` 刷新）、`scripts/sync-readme.mjs --check`。全部不访问网络。CI（`.github/workflows/deploy.yml` 的 test 任务）在每次推送和 PR 上跑同样的东西加密钥扫描，main 只有在它通过后才部署。真实调用的验证用临时的 MCP 客户端脚本：

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "service-account.json", WP_SITES: "[...]" } }));
console.log(await c.callTool({ name: "gsc_list_sites", arguments: {} }));
```

脚本要放在仓库根目录运行（需要从 `node_modules` 解析 SDK），用完删掉。测 HTTP 模式用 `curl -X POST /mcp`，带 `Authorization: Bearer` 和 `Accept: application/json, text/event-stream` 两个头。

**写入类工具的测试只能作用于临时对象**：WordPress 用 `wp post create --post_status=draft` 建的草稿（测完 `--force` 删除）、临时重定向（建了就删）、与当前值相同的无变化写入；GitHub 用临时分支（`createBranch`，测完删分支）；Search Console 只重新提交已有站点地图。绝不在真实文章、真实分支上做测试写入。

## 架构

- `src/server.ts`：`createServer()` 创建 `McpServer` 并注册全部工具。两种传输都调用它；HTTP 传输是**每个请求新建一个服务实例**（无状态，`sessionIdGenerator: undefined`）。它包了一层 `registerTool`：按工具名推断注解（`WRITE_TOOLS`、`DESTRUCTIVE_TOOLS` 正则）、只读模式下跳过写入工具、按 `toolsetOf()` 应用工具集筛选。**新增写入类工具时必须让名字匹配这两个正则**，否则会被当成只读。服务器 instructions 在 `buildInstructions()` 里。
- `src/index.ts`：入口，根据 `--http` 参数或 `MCP_TRANSPORT=http` 选择 stdio 或 HTTP。`src/http.ts` 是纯 `node:http` 服务，带 Bearer Token 鉴权（`MCP_AUTH_TOKEN`）、`/healthz`，默认只绑回环地址。
- `src/google.ts`：单例 `GoogleAuth`，以及 `googleapis` 客户端工厂（`searchconsole v1`、`analyticsdata v1beta`、`analyticsadmin v1beta`）。凭据查找顺序：`GOOGLE_CREDENTIALS_JSON` → `GOOGLE_APPLICATION_CREDENTIALS` → `~/.config/google-seo-mcp/credentials.json` → ADC。GA4 用的是 `googleapis` 的 REST 客户端而不是 `@google-analytics/data`，避免引入 gRPC。
- `src/util.ts`：`tool(fn)` 包装所有处理函数，返回值经 `fitResult()` 做体积保护（超过 `SEO_MCP_MAX_RESULT_CHARS` 时对最长的数组减半直到放下，并加 `_truncated` 说明）后以**紧凑 JSON**（不缩进）写进文本内容；抛出的异常经 `formatError` 变成 `isError` 结果（缺凭据和 403 会附加提示）。`heartbeat(extra, msg)` 给长任务发进度通知，超过约 10 秒的工具都要用。`resolveDate()` 把 `today`、`yesterday`、`NdaysAgo` 转成 `YYYY-MM-DD`，因为 Search Console 只接受绝对日期。
- `src/tools/gsc.ts`、`src/tools/ga.ts`：Google 工具。输入 schema 是传给 `registerTool` 的 zod raw shape，`.describe()` 文本要写清楚，那是 LLM 唯一能看到的说明。GA 的行数据由 `tabulate()` 拍平成 `{维度: 值, 指标: 数字}` 对象。
  - `gsc.ts` 导出 `query()`、`normalizePath()` 供其他模块复用；`gsc_delete_*`、`gsc_add_site` 是写入工具，名字必须保持这些前缀。
  - `ga.ts`：漏斗报告走 v1alpha，`googleapis` 没封装，用 `getAuth().getClient().request()` 直接 POST；漏斗步骤里页面条件要用 `unifiedPagePathScreen`（`pagePath` 不被接受），返回的 `metricHeaders` 会重复一遍，按名字去重后再对应 `metricValues`。`ga_property_config` 混用 admin v1beta 和 v1alpha（受众、增强型衡量只在 alpha）。`ga_check_compatibility` 在组合本身不兼容时 API 返回 400 而不是列表，已捕获成 `compatible:false`。
- `src/tools/web.ts`：不依赖 Google 授权的网页检查（`page_audit` 用 cheerio 解析、`pagespeed`、`sitemap_check`、`robots_check`）。`collectSitemapUrls()` 和 `parseRobots()` 被 gsc 模块复用。
- `src/tools/crawl.ts`：`site_crawl`（去重用去尾斜杠的 key，但请求始终用原始 URL，否则会误报 301 链）、`hreflang_check`、`compare_pages`（识别反爬页）、`social_preview_check`、`keyword_suggest`。
- `src/tools/analysis.ts`：跨数据源分析（`migration_check`、`cross_site_links`、`content_refresh_candidates`、`knowledge_graph_check`、`crux_history`、`brand_mentions`、`reviews_snapshot`），依赖 `gsc.ts` 导出的 `query()` 和 `normalizePath()`。
- `src/tools/github.ts`：GitHub REST，`github_commit_files` 用 Git Data API 一次提交多文件；token 取 `GITHUB_TOKEN`，否则 `gh auth token`。
- `src/tools/geo.ts`：GEO 与信任信号检查。`BOTS` 表维护 AI 爬虫的 robots 令牌和 UA 字符串；`SCHEMA_RULES` 是各 schema 类型的必填/推荐字段表；`analyzePage()` 是 `geo_page_score` 和 `eeat_audit` 共用的页面信号提取。`indexnow_submit` 和 `ai_citation_check` 依赖可选环境变量，缺失时返回带说明的错误而不是不注册。
- `src/tools/wp.ts`：WordPress 工具。只在设置了 `WP_SITES`（JSON 数组）或 `WP_SSH_*` 环境变量时注册。每次调用都是 `spawn` 一个 `ssh … 'cd <path> && wp …'`；所有远程参数都经 `shq()` 做 POSIX 单引号转义。大块数据（正文、构建器修改）通过 stdin 传，不放进 argv。
  - Yoast 字段就是原始 post meta（`_yoast_wpseo_title`、`_yoast_wpseo_metadesc` 等）。写完 meta 后 `rebuildYoastIndexable()` 用 `wp eval` 调 Yoast 的 `Indexable_Builder`，否则前台标题不会变。`purgeCache()` 清该文章在 WP Rocket、Super Cache、W3TC、LiteSpeed 中的缓存。
  - `scripts/wp-helper.php` 承载所有批量或需要 PHP 逻辑的操作（SEO 状态、批量 Yoast、媒体、分类、内链建议、Yoast Premium 重定向），输入输出都是 STDIN/STDOUT 的 JSON，由 `runHelper()` 调用。`wpPostIndexForHost()` 缓存全站 URL 到文章 ID 的映射，供 `gsc_opportunities` 使用。
  - `scripts/mfn-builder.php` 处理 BeTheme（Muffin Builder）的文章，这类文章正文以 base64 加 PHP 序列化的形式存在 `mfn-page-items` meta 里，`post_content` 是空的。`ensureHelper()` 在 sha256 不一致时把脚本上传到主机的 `~/.google-seo-mcp/`，再用 `wp eval-file` 执行。`eval-file` 的代码跑在函数作用域内，PHP 里不能依赖 `global` 变量。`set` 动作会重新生成 `mfn-page-items-seo` 并调用 `wp_update_post`，让 Yoast 和缓存插件感知到变化。
- 部署：`Dockerfile`（镜像内含 openssh-client、`scripts/`，以 `node` 用户运行，带 HEALTHCHECK）与 `docker-compose.yml`（`env_file: .env`，挂载 `secrets/service-account.json` 与 `secrets/ssh/`，宿主 `127.0.0.1:8787`）是生产方式；`deploy/vps-self-update.sh` 在服务器上拉取、重建、健康检查，`deploy/deploy-vps.sh` 从本机远程触发它；`deploy/` 里另有 systemd、Caddy、Nginx 样例（Nginx 必须 `proxy_buffering off`，否则 SSE 不通）。`src/env.ts` 按包根目录定位 `.env`，容器内由 compose 提供环境变量。

## 公共仓库规则（必须遵守）

本项目公开在 GitHub `Akxan/google-seo-mcp`。

- **每次改动完成后立即 `git commit` 并 `git push`**，不积攒。**提交信息一律用中文**，说明改了什么和为什么。
- **推送到 main 即自动部署到线上**：`.github/workflows/deploy.yml` 通过仓库 secrets（`VPS_HOST`、`VPS_USER`、`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`）用受限的部署密钥触发服务器上的 `deploy/vps-self-update.sh`（拉取、重建容器、健康检查）。test 任务在所有推送和 PR 上跑；deploy 任务只在 main、且本次提交改动了非文档文件时执行（用 `git diff HEAD~1` 判断），`workflow_dispatch` 可强制部署。推送后用 `gh run watch` 或 `gh run list --limit 1` 确认部署成功；失败时先看工作流日志，再看服务器容器日志。
- **每次提交前后都要检查不含个人与敏感信息**：`scripts/check-secrets.sh` 作为 pre-commit 与 pre-push 钩子自动运行（`npm install` 时的 `prepare` 会设置 `core.hooksPath`）；改动涉及文档或示例时再手动跑一次 `npm run check:secrets`。机器特有的标识（IP、用户名、域名、项目 ID）写在 `.secret-patterns.local`（gitignored）里供扫描器使用。工具描述、示例、测试里一律用 `example.com`、`octocat/my-site` 这类占位值。
- **Dependabot 的 PR**：用 `gh pr merge N --squash --delete-branch --subject "<中文标题>"` 合并，标题保持中文。一次只合并一个，`gh run watch` 等上一个部署成功再合并下一个（工作流的 concurrency 组只保留一个排队中的运行，连续合并会把中间的取消）。两个 PR 改同一文件时先合并一个，再在另一个上评论 `@dependabot rebase`。主版本升级（zod、Node、SDK）先在本地按 PR 分支构建、`npm test`，并用临时客户端脚本对比升级前后 `tools/list` 的 schema，再把修正推回 PR 分支。`npm audit` 报的漏洞若无修复版本，在代码里规避（如 `image-size` 的 `disableTypes`）并写进 CHANGELOG 的 Security 段。
- 个人与站点相关的信息只放在 `.env`（含注释）和 `CLAUDE.local.md`，两者都不入库；本文件保持通用。
- **README.md 用英文，每次新增或修改功能都要同步更新**（工具表、配置项、限制）；`README.zh-CN.md` 是中文版，功能变化时一并更新。
- 提交身份用仓库本地设置的 GitHub noreply 邮箱，不用个人邮箱。
- 不要把 `.env`、`service-account.json`、`CLAUDE.local.md`、`.secret-patterns.local` 从 `.gitignore` 移除。

## 新增或修改工具的完整流程

1. 在对应的 `src/tools/*.ts` 模块里用 `server.registerTool` 注册；名字用 `前缀_动作` 形式，前缀决定工具集（见 `toolsetOf()`）；写入类工具名必须匹配 `WRITE_TOOLS`（删除类再匹配 `DESTRUCTIVE_TOOLS`）。每个参数都要 `.describe()`，可枚举的用 `z.enum`，描述精炼（80 个工具的定义已约 2.1 万 token）。**写入类工具必须提供 `dryRun` 参数**，返回当前值与将要做的改动而不落地。纯函数尽量导出并在 `test/unit/` 加用例。
2. 需要新密钥的：`.env` 与 `.env.example` 各加一行带用途注释的条目；密钥缺失时抛出带申请路径的错误。
3. `npm run build`，用临时客户端脚本对真实数据验证（写入只用临时对象），删掉脚本。
4. `UPDATE_SNAPSHOT=1 npm test` 刷新工具清单快照，然后 `npm run docs:sync` 让两份 README 和 `package.json` 里的工具总数、分组计数自动对齐（`npm test` 会检查是否过期），再 `npm test` 确认通过。
5. 手动更新 `README.md` 的工具表内容（新工具名和一句话说明）和配置表，`README.zh-CN.md` 同步；必要时更新 `buildInstructions()`。在 `CHANGELOG.md` 的 Unreleased 下加一条。
6. 中文提交信息，`git push`；推送会自动部署，用 `gh run watch` 看到成功后，用线上地址调一次新工具确认（`/healthz` 先通）。
7. 涉及服务器 `.env` 的变更（新密钥、`WP_SITES`）要在服务器上同步并重启容器。
8. 一批功能完成后发版：`npm pkg set version=x.y.z`（服务器上报的版本号从 `package.json` 读取），把 CHANGELOG 的 Unreleased 改成版本段落并更新底部链接，提交后 `git tag -a vx.y.z -m '...'`、`git push origin vx.y.z`、`gh release create vx.y.z --title ... --notes-file <(从 CHANGELOG 摘出该段)`。

## 对外形象的维护（README、徽章、仓库元数据）

自动的：工具数徽章是 shields 动态徽章，直接读 `test/tools.snap.json`；发行版徽章读 GitHub Releases；部署徽章读 Actions；README、README.zh-CN、package.json 里的工具总数与分组计数由 `npm run docs:sync` 生成，`npm test` 会校验。这些不用手改。

按需的，触发条件明确：
- **新增了集成领域或依赖**（接入新的外部服务、换了库）：更新 README 的「Tech stack」表和架构图/说明、「Keywords」段；`package.json` 的 `description`/`keywords`；用 `gh repo edit --description ... --add-topic ...` 同步仓库描述和主题（主题上限 20 个，加新的要先删旧的）。
- **新增或改动工具**：README 两份的工具表、示例提示（如果新工具值得展示）、配置表（新密钥）、CHANGELOG。
- **发版**：版本号、CHANGELOG 段落、tag、GitHub Release（见上面第 8 步）。发行说明用英文、按领域分组，和 README 口径一致。
- **不要做的**：不为纯文档或重构提交改版本号；不手改徽章数字；不在描述里写无法验证的形容词。
- **不发布到 npm 或 MCP 注册中心**（用户决定，2026-09-09）：`package.json` 标了 `private: true`，安装方式只有 clone 加构建。

## 配置与密钥

- **`.env` 是唯一真源**（gitignored）：Google 凭据路径、各 API 密钥、`WP_SITES`、可选第三方密钥、HTTP 模式参数，外加注释形式的站点信息、资源 ID、客户端配置位置和依赖清单。`src/env.ts` 在 `index.ts` / `auth.ts` 启动时读取它（按包根目录定位，与工作目录无关；已存在的环境变量优先）。`.env.example` 是脱敏模板。
- **服务器有自己的一份 `.env`**（位置见 `CLAUDE.local.md`），不会自动同步：新增或更换密钥要本机和服务器各改一次，服务器改完需要 `docker compose up -d` 重启容器才生效（`env_file` 只在启动时读取）。
- 客户端（Claude Code、桌面 App、网页、手机）都连生产 HTTP 实例，认证一律是请求头 `Authorization: Bearer <MCP_AUTH_TOKEN>`（Claude Code 用 `claude mcp add --transport http --header`，claude.ai 连接器在「Request headers」里填）；本机不再有 stdio 注册。新工具部署后客户端在下一次新对话自动拿到，不需要重连。
- 新增需要密钥的工具时：在 `.env` 和 `.env.example` 各加一行带用途注释的条目，工具在密钥缺失时抛出带申请路径的错误（不要在注册阶段隐藏工具）。

## 约定与注意事项

- stdio 模式下除 MCP 协议外不能往 stdout 写任何东西，日志一律用 `console.error`。
- `.env`、`service-account.json`、`credentials.json`、`client_secret*.json` 已在 `.gitignore`，秘密不进仓库，也不要出现在工具描述里。
- 80 个工具的定义约 2.2 万 token，每次对话都会加载：描述写得准确但不要啰嗦，新工具优先合并进现有模块而不是再拆文件；`SEO_MCP_TOOLSETS` 可按需裁剪。
- `buildInstructions()` 里点名了推荐先用的工具（snapshot、opportunities 等），新增重要的分析类工具时把它加进去。
- 密钥扫描器误报时，在 `scripts/check-secrets.sh` 的 `BENIGN`（合法占位值）或 `ALLOW`（合法文件）里加豁免，不要绕过钩子提交。
- Search Console 数据延迟 2 到 3 天；URL 检查每个资源每天约 2000 次配额，不要对整站循环调用。
- 对基于构建器的文章，`wp_update_post` 的 `content` 参数会被主题忽略，要用 `wp_builder_*` 工具。第一次编辑某篇文章前先跑 `wp_builder_check`。
