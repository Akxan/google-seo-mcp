# Google SEO MCP

把 **Google Search Console**、**Google Analytics 4**、PageSpeed 与 CrUX、网页与 GEO 审计（结构化数据、llms.txt、AI 爬虫）、
可选的 WordPress（SSH + WP-CLI）和 GitHub 封装成一个 MCP 服务，让 Claude、Codex、Cursor 等任何 MCP 客户端
可以直接查询你网站的搜索表现、索引状态和 GA4 流量，并动手修改页面，用于日常 SEO / GEO 运维。

支持两种运行方式：

| 方式 | 场景 | 启动命令 |
|---|---|---|
| stdio | 本机使用，客户端按需拉起 | `node dist/index.js` |
| Streamable HTTP | 部署在 Linux 服务器上 24 小时运行 | `node dist/index.js --http` |

## 工具列表

| 工具 | 作用 |
|---|---|
| `google_auth_status` | 检查当前使用的 Google 凭据是否有效（排障先跑这个） |
| `gsc_list_sites` | 列出账号可访问的所有 Search Console 资源 |
| `gsc_search_analytics` | 搜索表现报告：点击、展示、CTR、排名，可按 query/page/country/device/date 分组并过滤 |
| `gsc_compare_periods` | 两个时间段对比，按点击变化排序，直接看出涨跌页面/关键词 |
| `gsc_inspect_url` | URL 检查：索引状态、抓取时间、规范网址、robots、移动可用性 |
| `gsc_list_sitemaps` | 列出已提交的站点地图及错误/警告 |
| `gsc_submit_sitemap` | 提交或重新提交站点地图 |
| `ga_list_properties` | 列出账号可访问的 GA4 媒体资源 |
| `ga_run_report` | GA4 报告：任意维度/指标、过滤、排序、分页，支持对比时间段 |
| `ga_run_realtime_report` | GA4 实时（最近 30 分钟）数据 |
| `ga_get_metadata` | 查询某媒体资源可用的维度和指标（含自定义维度） |
| `ga_compare_periods` | GA4 两个时间段对比，按维度拆分，含总量和百分比变化 |
| `ga_landing_page_seo` | 自然搜索落地页：GA4 行为数据与 Search Console 点击数据合并成一张表 |
| `ga_run_pivot_report` | 透视表：一个维度做行、一个做列，例如落地页 × 设备 |
| `ga_batch_run_reports` | 一次调用跑最多 5 个报表 |
| `ga_run_funnel_report` | 漏斗：按事件定义步骤，看每步人数与流失，可按维度拆分 |
| `ga_check_compatibility` | 检查维度指标组合能否一起查询 |
| `ga_property_config` | 只读配置：时区货币、数据保留、数据流与增强型衡量、自定义维度指标、关键事件、Google Ads 关联、受众 |
| `gsc_delete_sitemap` / `gsc_add_site` / `gsc_delete_site` | 站点地图删除、资源添加与移除 |
| `gsc_opportunities` | 展示高但排名在 8 到 20 位的关键词与页面，自动映射到 WordPress 文章 ID |
| `gsc_cannibalization` | 同一关键词被多个页面分摊的情况 |
| `gsc_index_coverage` | 批量 URL 检查，汇总索引状态 |
| `page_audit` | 抓取任意 URL：title、描述、canonical、robots、标题结构、缺 alt 图片、内外链、字数、结构化数据、问题清单 |
| `pagespeed` | PageSpeed Insights：性能与 SEO 得分、Core Web Vitals 实验室与真实用户数据、优化建议（需 `PAGESPEED_API_KEY`） |
| `sitemap_check` | 拉取站点地图（支持索引与 gz），抽样或全量检查状态码 |
| `robots_check` | 解析 robots.txt，判断 URL 对指定 UA 是否可抓取 |
| `ai_crawler_access` | 检查 GPTBot、OAI-SearchBot、ClaudeBot、PerplexityBot、Google-Extended 等 AI 爬虫的 robots 规则和真实 UA 请求是否被拦 |
| `llms_txt_check` / `llms_txt_generate` | 检查 /llms.txt 的存在与格式、链接是否有效；从站点地图生成草稿 |
| `structured_data_audit` | 提取 JSON-LD，按类型校验必填/推荐字段，核对全站机构实体信息一致性 |
| `geo_page_score` | 单页 GEO 评分：首段直接回答、问句标题、FAQ、列表表格、可引用数据、作者日期、外部引用、结构化数据 |
| `eeat_audit` | 站点级 E-E-A-T 清单：关于/联系/隐私页、地址电话、机构 schema、评价 schema、作者页、文章署名与日期 |
| `gsc_question_queries` | 筛出已有展示的问句关键词，按页面分组并检查页面是否有对应标题和 FAQ schema |
| `gsc_rich_results_report` | 按搜索外观类型（富媒体、FAQ、评价、视频等）统计点击展示与对应页面 |
| `indexnow_submit` | 向 Bing/Yandex 推送变更 URL（需 `INDEXNOW_KEY` 及站点根目录密钥文件） |
| `ai_citation_check` | 用 Perplexity API 问一个问题，看引用来源里有没有你的域名（需 `PERPLEXITY_API_KEY`，付费） |
| `schema_generate` / `schema_validate` | 从现有页面生成 FAQPage、BlogPosting、面包屑的 JSON-LD 草稿；发布前校验 |
| `site_crawl` | 全站爬取审计：状态码、断链、重定向链、重复标题描述、缺 H1、noindex、薄内容、孤立页、入链数、点击深度 |
| `hreflang_check` | 多语言互引、自引用、x-default、canonical 冲突核对 |
| `compare_pages` | 与竞品页面并排对比字数、标题结构、schema，并给出内容差距词 |
| `social_preview_check` | OG 与 Twitter 卡片校验，含图片尺寸与比例 |
| `keyword_suggest` | Google 联想词扩展，含问句前缀与字母扩展 |
| `gsc_site_snapshot` | 一次调用给全貌：与上一周期对比的总量、Top 关键词与页面、设备国家分布、涨跌页面、每日曲线 |
| `gsc_ctr_opportunities` | 已在首页但点击率低于基准的关键词与页面，估算改标题能多拿的点击 |
| `migration_check` | 迁移前安全网：把 Search Console 有流量的 URL 和旧站点地图逐个拿到新站测，分类 OK、重定向、跳首页、404 |
| `cross_site_links` | 两个 Search Console 资源的关键词交叉比对，建议互链并检测是否已链接 |
| `content_refresh_candidates` | 点击下滑且长期未更新的页面，附丢失的关键词 |
| `knowledge_graph_check` | Wikidata 与 Google 知识图谱里是否存在该实体（后者需启用 Knowledge Graph Search API） |
| `crux_history` | Chrome 真实用户 Core Web Vitals 周走势（需启用 Chrome UX Report API） |
| `brand_mentions` | 全网品牌提及及是否已链接（需 `BRAVE_API_KEY`，免费额度） |
| `reviews_snapshot` | Google 商家评分与最新评论（需 `GOOGLE_PLACES_API_KEY`，需开结算） |
| `github_get_file` / `github_list_dir` / `github_search_code` / `github_list_commits` / `github_commit_files` | 读写 GitHub 仓库，一次提交多个文件，静态站可从任何客户端修改（用 `GITHUB_TOKEN` 或本机 `gh` 登录） |

日期参数支持 `YYYY-MM-DD`、`today`、`yesterday`、`28daysAgo` 这类写法。

## 1. Google Cloud 准备

1. 打开 <https://console.cloud.google.com/> 新建（或选择）一个项目。
2. 在「API 和服务 → 库」中启用以下三个 API：
   - **Google Search Console API**
   - **Google Analytics Data API**
   - **Google Analytics Admin API**（仅用于 `ga_list_properties`，可选）
3. 选择一种凭据方式（见下一节）。

## 2. 授权方式

### 方式 A：服务账号（推荐用于服务器 24 小时运行）

1. 「IAM 和管理 → 服务账号」创建一个服务账号，下载 JSON 密钥。
2. 把服务账号的邮箱（`xxx@yyy.iam.gserviceaccount.com`）添加为：
   - Search Console 资源的用户（设置 → 用户和权限，「完整」权限才能提交站点地图）；
   - GA4 媒体资源的用户（管理 → 媒体资源访问权限管理，「查看者」即可）。
3. 设置环境变量 `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`。

### 方式 B：用自己的 Google 账号 OAuth 授权（本机方便）

1. 「API 和服务 → 凭据」创建 **OAuth 客户端 ID**，类型选「桌面应用」，下载 `client_secret.json`。
   首次使用需要在「OAuth 同意屏幕」把自己的邮箱加为测试用户。
2. 运行一次：
   ```bash
   npm run auth -- --client-secret ./client_secret.json
   ```
   浏览器完成授权后，凭据会写到 `~/.config/google-seo-mcp/credentials.json`，服务启动时自动读取。
3. 如果要放到服务器上，把这个 `credentials.json` 拷过去，并用
   `GOOGLE_APPLICATION_CREDENTIALS` 指向它即可（无需在服务器上开浏览器）。

凭据查找顺序：`GOOGLE_CREDENTIALS_JSON`（内联 JSON）→ `GOOGLE_APPLICATION_CREDENTIALS`
→ `~/.config/google-seo-mcp/credentials.json` → gcloud 默认凭据。

## 3. 本机使用

```bash
npm install
npm run build
```

Claude Code：

```bash
claude mcp add google-seo -- node /绝对路径/Google-SEO-MCP/dist/index.js   # 密钥从项目 .env 读取
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "google-seo": {
      "command": "node",
      "args": ["/绝对路径/Google-SEO-MCP/dist/index.js"]
    }
  }
}
```

Codex、Cursor、VS Code、Gemini CLI 的接法见下文「连接客户端」，本机 stdio 同样只需要启动命令。

调试：`npm run inspector` 会打开 MCP Inspector。

## 4. 部署到 Linux 服务器（24 小时运行）

### systemd（推荐）

```bash
# 服务器上
sudo useradd -r -s /usr/sbin/nologin seo
sudo mkdir -p /opt/google-seo-mcp /etc/google-seo-mcp
sudo rsync -a --exclude node_modules --exclude dist ./ /opt/google-seo-mcp/   # 或 git clone
cd /opt/google-seo-mcp && sudo npm ci && sudo npm run build
sudo chown -R seo:seo /opt/google-seo-mcp

# 凭据与环境变量
sudo cp service-account.json /etc/google-seo-mcp/
sudo cp deploy/google-seo-mcp.env.example /etc/google-seo-mcp.env
sudo nano /etc/google-seo-mcp.env        # 填 MCP_AUTH_TOKEN（openssl rand -hex 32）和凭据路径
sudo chown -R seo:seo /etc/google-seo-mcp /etc/google-seo-mcp.env
sudo chmod 600 /etc/google-seo-mcp/* /etc/google-seo-mcp.env

# 启动
sudo cp deploy/google-seo-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now google-seo-mcp
sudo systemctl status google-seo-mcp
curl http://127.0.0.1:8080/healthz
```

服务默认只监听 `127.0.0.1:8080`。对外访问请用 Caddy 或 Nginx 反向代理并开启 HTTPS，
示例见 `deploy/Caddyfile.example` 和 `deploy/nginx.conf.example`（Nginx 必须关闭 `proxy_buffering`）。
`/healthz` 不带令牌时只返回 `{"ok":true}`，带 Bearer 令牌时附带版本号和凭据来源。

### Docker

```bash
cp service-account.json credentials.json
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

### 连接客户端（Claude、Codex、Cursor、VS Code、Gemini CLI 或任何 MCP 客户端）

服务走的是标准 MCP 协议，不只给 Claude 用。远程接法对所有客户端都一样：URL 填 `https://mcp.example.com/mcp`，请求头加 `Authorization: Bearer <MCP_AUTH_TOKEN>`。

**Claude Code**

```bash
claude mcp add --transport http google-seo https://mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Desktop / claude.ai / 手机 App**：设置 → 连接器 → 添加自定义连接器，URL 填上面的地址，认证选「无」，在「Request headers」里加 `Authorization: Bearer <MCP_AUTH_TOKEN>`。

**OpenAI Codex**（`~/.codex/config.toml`；令牌从环境变量读，先在 shell 配置里 `export GOOGLE_SEO_MCP_TOKEN=…`）：

```toml
[mcp_servers.google-seo]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "GOOGLE_SEO_MCP_TOKEN"
tool_timeout_sec = 600          # pagespeed、site_crawl 会超过 Codex 默认的 60 秒

# 本机 stdio 写法
# [mcp_servers.google-seo]
# command = "node"
# args = ["/绝对路径/Google-SEO-MCP/dist/index.js"]
```

**Cursor**（`~/.cursor/mcp.json`，或项目内的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "google-seo": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

**VS Code**（Copilot 代理模式；`.vscode/mcp.json` 或用户级 mcp.json）：

```json
{
  "servers": {
    "google-seo": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

**Gemini CLI**（`~/.gemini/settings.json`；`httpUrl` 表示 Streamable HTTP，`timeout` 单位是毫秒）：

```json
{
  "mcpServers": {
    "google-seo": {
      "httpUrl": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" },
      "timeout": 600000
    }
  }
}
```

**其他 MCP 客户端**：填同样的 URL 和请求头即可（Streamable HTTP，无状态，每次调用都是一个 POST，没有会话要维持），或者本机用 stdio 启动 `node dist/index.js`。命令行快速验证：

```bash
curl -s https://mcp.example.com/mcp -H "Authorization: Bearer <MCP_AUTH_TOKEN>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

两点注意：`pagespeed`、`site_crawl`、`gsc_index_coverage` 这类工具会跑几分钟（期间有进度通知），客户端的单工具超时若默认 60 秒要调大；ChatGPT 的自定义连接器目前只接受 OAuth，填不了固定令牌，暂时接不上。

## WordPress 工具（可选）

通过 SSH 在主机上执行 WP-CLI，让 Claude 直接读改 WordPress 内容和 Yoast SEO 字段。
需要主机装有 WP-CLI，并且本机能免密 SSH 登录。

配置环境变量 `WP_SITES`（JSON 数组，支持多个站）：

```json
[{"name":"mysite","host":"1.2.3.4","port":22,"user":"ssh_user","path":"domains/example.com/public_html","identityFile":"~/.ssh/id_ed25519"}]
```

或单站简写：`WP_SSH_HOST`、`WP_SSH_PORT`、`WP_SSH_USER`、`WP_PATH`、`WP_SSH_KEY`。未配置时这组工具不会注册。

| 工具 | 作用 |
|---|---|
| `wp_site_info` | WP 版本、站点 URL、固定链接、启用插件、Yoast 分隔符 |
| `wp_list_posts` | 列文章/页面（ID、标题、slug、状态、URL），支持搜索、按 slug 精确查找、分页 |
| `wp_get_post` | 读单篇：正文、摘要、URL，以及 Yoast 的 SEO 标题、描述、焦点关键词、canonical、noindex |
| `wp_update_post` | 改标题、slug、摘要、正文、状态 |
| `wp_update_seo` | 改 Yoast SEO 字段，改完自动重建 Yoast 索引并清页面缓存 |
| `wp_builder_list_items` | BeTheme（Muffin Builder）站点：列出页面构建器里的标题、正文块、图片等可编辑项 |
| `wp_builder_update` | 改构建器项的文本字段，自动重新生成 SEO 副本、重建 Yoast 索引、清缓存 |
| `wp_builder_check` | 只读检查构建器数据能否无损往返 |
| `wp_seo_status` | 全站文章的 Yoast 标题、描述、关键词状态，找出缺失项 |
| `wp_bulk_update_seo` | 批量写 Yoast SEO 字段 |
| `wp_list_media` / `wp_update_media` | 媒体库图片及 alt 文本的读写，可只列缺 alt 的 |
| `wp_list_terms` / `wp_update_term` | 分类、标签及其 Yoast SEO 字段的读写 |
| `wp_internal_link_suggestions` | 按关键词找出应该链向目标文章的其他文章 |
| `wp_list_redirects` / `wp_add_redirect` / `wp_delete_redirect` | Yoast Premium 重定向管理 |
| `wp_set_schema` / `wp_get_schema` | 把 JSON-LD 发布到某篇文章的 head（首次使用自动安装一个 mu-plugin） |
| `wp_run` | 执行任意 WP-CLI 命令 |

构建器工具依赖 `scripts/mfn-builder.php`，其余批量与 Yoast 操作依赖 `scripts/wp-helper.php`，首次使用时会自动上传到主机的 `~/.google-seo-mcp/`。
缓存清理支持 WP Rocket、WP Super Cache、W3 Total Cache、LiteSpeed。

## 运行模式

- **只读模式**：`--read-only` 或 `SEO_MCP_READ_ONLY=1`，所有写入类工具不注册。
- **工具集筛选**：`--toolsets=gsc,ga4,web` 或 `SEO_MCP_TOOLSETS`，可选 `gsc`、`ga4`、`web`、`geo`、`analysis`、`wordpress`、`github`。80 个工具的定义约 2.2 万 token，只用部分功能时可以裁剪。
- 每个工具都带 `readOnlyHint` / `destructiveHint` 注解，服务器在初始化时返回 instructions 说明用法与安全约定。
- `npm test` 运行单元测试、冒烟测试（含工具清单快照，`UPDATE_SNAPSHOT=1 npm test` 刷新）和 README 计数校验。
- 所有写入类工具和 `github_commit_files` 支持 `dryRun: true`，只返回当前值与将要做的改动，不落地。
- 单次返回超过 `SEO_MCP_MAX_RESULT_CHARS`（默认 12 万字符）时自动截断数组并提示如何缩小范围。

## 5. 环境变量

推荐把所有变量写在项目根目录的 `.env`（参考 `.env.example`），服务启动时自动读取，客户端配置里只需要启动命令。也可以在客户端配置的 `env` 里传，已存在的环境变量优先于 `.env`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | 设为 `http` 等同于 `--http` |
| `MCP_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `MCP_PORT` | `8080` | HTTP 端口 |
| `MCP_PATH` | `/mcp` | HTTP 路径 |
| `MCP_AUTH_TOKEN` | 无 | Bearer Token；非回环地址监听时务必设置 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 无 | 服务账号或 authorized_user JSON 路径 |
| `GOOGLE_CREDENTIALS_JSON` | 无 | 直接内联凭据 JSON（适合容器平台的 secret） |
| `GOOGLE_OAUTH_CLIENT_SECRET_FILE`（或 `--client-secret`）、`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`、`GOOGLE_OAUTH_PORT` | 端口 `53682` | 只有 `npm run auth` 用：自己账号 OAuth 授权的客户端信息与本机回调端口 |
| `WP_SITES` | 无 | WordPress 站点 SSH 配置 JSON 数组，见 WordPress 工具一节 |
| `PAGESPEED_API_KEY` | 无 | PageSpeed Insights API 密钥；不设则用公共匿名配额，经常已耗尽 |
| `INDEXNOW_KEY` / `INDEXNOW_KEY_LOCATION` | 无 | IndexNow 密钥及密钥文件 URL |
| `PERPLEXITY_API_KEY` | 无 | Perplexity Sonar API 密钥，仅 `ai_citation_check` 需要 |
| `GOOGLE_API_KEY` / `CRUX_API_KEY` | 无 | 知识图谱与 CrUX 的密钥，未设时复用 `PAGESPEED_API_KEY` |
| `BRAVE_API_KEY` | 无 | Brave Search，仅 `brand_mentions` |
| `GOOGLE_PLACES_API_KEY` | 无 | Places API (New)，仅 `reviews_snapshot` |
| `GITHUB_TOKEN` | 无 | GitHub 工具；未设时尝试 `gh auth token` |
| `SEO_MCP_READ_ONLY` / `SEO_MCP_TOOLSETS` | 无 | 见运行模式 |
| `SEO_MCP_MAX_RESULT_CHARS` | `120000` | 单次工具结果的字符上限，超出时截断最长的数组并提示如何缩小范围 |

空值一律视为未设置，包括 Docker 从 env 文件原样传入的 `KEY=`。

## 6. 常见问题

- **403 PERMISSION_DENIED**：服务账号邮箱没有被加到 Search Console / GA4 的用户列表，或者 API 未启用。
- **Search Console 最近两三天没数据**：官方数据有延迟，`dataState: "all"` 可以拿到未最终确认的新鲜数据。
- **URL 检查配额**：每个资源每天约 2000 次，不要批量扫全站。
- **OAuth 没返回 refresh_token**：到 <https://myaccount.google.com/permissions> 移除该应用后重新 `npm run auth`。

## 使用示例（对 Claude 说）

- 「看一下过去 28 天和前 28 天相比，哪些页面点击掉得最多」→ `gsc_compare_periods`
- 「检查 https://example.com/pricing 是否被索引」→ `gsc_inspect_url`
- 「GA4 里过去 7 天自然搜索流量最高的落地页，带跳出率」→ `ga_run_report`，
  `dimensions: ["landingPage"]`, `metrics: ["sessions","bounceRate"]`,
  `dimensionFilters: [{ field: "sessionDefaultChannelGroup", value: "Organic Search" }]`
