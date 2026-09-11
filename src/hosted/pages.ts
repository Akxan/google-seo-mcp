/** HTML for hosted mode: landing, dashboard, legal pages. No client-side JS beyond copy buttons; inline CSS only. */

export type Lang = "en" | "zh";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{--bg:#fbfbf9;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e4df;--card:#fff;--accent:#1f5fbf;--accent-fg:#fff;--ok:#1f7a3f;--warn:#9a5b00;--code:#f3f3ee}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--line:#2c2c29;--card:#1c1c1a;--accent:#6ea2ff;--accent-fg:#0b1a33;--ok:#6fcf8f;--warn:#e0a84c;--code:#232321}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Noto Sans SC",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:24px 20px 64px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:8px 0 24px}
header.top .brand{font-weight:700;font-size:18px;color:var(--fg)}header.top nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:14px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:8px;font-weight:600;border:0;cursor:pointer;font-size:15px}
.btn:hover{text-decoration:none;filter:brightness(1.05)}.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.btn.danger{background:transparent;color:#b3261e;border:1px solid #b3261e}
.hero{padding:32px 0 24px}.hero h1{font-size:40px;line-height:1.15;margin:0 0 12px;letter-spacing:-.02em}.hero p.lead{font-size:19px;color:var(--muted);max-width:640px;margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:24px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}.card h3{margin:0 0 8px;font-size:17px}.card p{margin:0;color:var(--muted);font-size:15px}
.card .n{display:inline-block;width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-fg);text-align:center;line-height:28px;font-weight:700;margin-bottom:10px}
h2{font-size:24px;margin:40px 0 12px;letter-spacing:-.01em}h2:first-child{margin-top:0}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:8px 0 16px}
code{font:13.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:2px 5px;border-radius:4px}
pre code{background:none;padding:0}
table{width:100%;border-collapse:collapse;font-size:14.5px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.muted{color:var(--muted)}.small{font-size:14px}.ok{color:var(--ok)}.warn{color:var(--warn)}
.notice{border-left:4px solid var(--accent);background:var(--card);padding:12px 16px;border-radius:8px;margin:16px 0}
.token{font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;background:var(--code);border:1px dashed var(--accent);padding:12px;border-radius:8px}
form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input[type=text]{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:15px;min-width:220px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.tabs a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;font-size:14px;color:var(--fg)}.tabs a.on{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.avatar{width:40px;height:40px;border-radius:50%;vertical-align:middle;margin-right:10px}
@media(max-width:600px){.hero h1{font-size:30px}.hero p.lead{font-size:17px}}
`;

const T = {
  en: {
    tagline: "SEO & GEO tools for AI agents",
    signIn: "Sign in with Google",
    dashboard: "Dashboard",
    signOut: "Sign out",
    github: "GitHub",
    privacy: "Privacy",
    terms: "Terms",
    heroTitle: "Your Search Console and GA4, inside Claude, Codex, Cursor and any MCP agent.",
    heroLead: "Sign in with Google, copy one token, and your AI assistant can read your search performance, audit your pages and score them for AI search. Nothing to install, nothing to host.",
    how: "How it works",
    step1: "Sign in with Google", step1p: "Grant read-only access to Search Console and Google Analytics 4. You can revoke it at any time.",
    step2: "Copy your token", step2p: "The dashboard gives you a personal MCP endpoint and a bearer token, with ready-made snippets for each client.",
    step3: "Ask your agent", step3p: "\"Which pages lost clicks this month?\", \"Audit this URL for AI search\", \"Where am I ranking 8 to 20?\"",
    what: "What your agent gets",
    g1: "Search Console", g1p: "Queries, pages, countries, devices; striking-distance keywords, CTR gaps, cannibalization, question queries, index coverage, sitemaps and URL inspection.",
    g2: "Google Analytics 4", g2p: "Reports, pivots, funnels, real time, period comparison and a landing-page view that merges GA4 sessions with Search Console clicks.",
    g3: "Page & site audits", g3p: "On-page SEO, PageSpeed and Core Web Vitals, structured data, hreflang, robots and sitemaps, social previews, whole-site crawls.",
    g4: "GEO (AI search)", g4p: "AI crawler access, llms.txt, E-E-A-T signals, schema recommendations, a GEO score per page and a knowledge-graph check for your brand.",
    trust: "Read-only, and only your data",
    trustP: "The hosted service asks for read-only Google scopes. It never edits your site, never submits anything on your behalf, and each token sees exactly one Google account: yours. Tools that spend money (paid third-party APIs) and tools that write to a CMS are not available in the hosted service; they are in the open-source server you can run yourself.",
    openSource: "Open source",
    openSourceP: "This is the hosted edition of google-seo-mcp, an MIT-licensed MCP server with more than 80 tools. Self-host it for WordPress editing, GitHub commits and image pipelines.",
    // dashboard
    account: "Account",
    connectedOn: "Connected on",
    scopes: "Google scopes",
    tokens: "Tokens",
    tokensP: "Each token is a personal password for the MCP endpoint. Create one per client so you can revoke them separately. The full token is shown only once.",
    label: "Label (optional)",
    create: "Create token",
    revoke: "Revoke",
    noTokens: "No tokens yet. Create one to connect a client.",
    created: "Created", lastUsed: "Last used", calls: "Calls", never: "never",
    newToken: "Your new token",
    newTokenP: "Copy it now. For security it is not stored and cannot be shown again.",
    connect: "Connect a client",
    connectP: "Every client uses the same two values: the endpoint URL and the header",
    endpoint: "Endpoint",
    claudeApps: "Claude (web, desktop, mobile)",
    claudeAppsP: "Settings → Connectors → Add custom connector. Name it, paste the URL, leave authentication on None, and add a request header:",
    claudeCode: "Claude Code",
    codex: "OpenAI Codex", codexP: "in ~/.codex/config.toml; export the token as an environment variable first",
    cursor: "Cursor / VS Code / Gemini CLI", cursorP: "Cursor uses ~/.cursor/mcp.json (below); VS Code puts the same block under \"servers\" with \"type\": \"http\"; Gemini CLI uses \"httpUrl\".",
    tryIt: "Then try:",
    connections: "Connections",
    connectionsP: "Google is connected through your sign-in. Connect other services to unlock their tools for your tokens.",
    githubTitle: "GitHub",
    githubOff: "Not connected. Install the app on the repositories you want your agent to edit: files, in-place edits, images. Deploys happen through your host's CI (Cloudflare, Vercel, Netlify…).",
    githubOn: "Connected as",
    githubRepos: "Repositories",
    githubTools: "Your tokens now include the github_* tools (read, in-place edits, image commits). Every write tool has dryRun.",
    connectGithub: "Connect GitHub",
    manageGithub: "Manage repositories on GitHub",
    disconnectGithub: "Disconnect GitHub",
    disconnectGithubP: "Uninstalls the app from your GitHub account; tokens minted for it stop working immediately.",
    disconnect: "Disconnect Google account",
    disconnectP: "Revokes the Google grant, deletes your tokens and your account record on this server.",
    disconnectConfirm: "Yes, disconnect and delete",
    danger: "Danger zone",
    limits: "Limits",
    limitsP: "Shared PageSpeed, CrUX and Knowledge Graph API quotas; pagespeed and site_crawl can run for minutes, raise your client's tool timeout above 60 s. The service is provided as is, without uptime guarantees.",
    unverified: "While this app is pending Google verification, Google shows an \"unverified app\" screen during sign-in. Click Advanced → Go to the app to continue.",
  },
  zh: {
    tagline: "给 AI 助手用的 SEO 与 GEO 工具",
    signIn: "用 Google 登录",
    dashboard: "控制台",
    signOut: "退出登录",
    github: "GitHub",
    privacy: "隐私政策",
    terms: "服务条款",
    heroTitle: "把你的 Search Console 和 GA4 接进 Claude、Codex、Cursor 和任何 MCP 助手。",
    heroLead: "用 Google 登录，复制一个令牌，AI 助手就能读你的搜索表现、审计页面、评估 AI 搜索可见度。不用安装，不用自己部署。",
    how: "怎么用",
    step1: "用 Google 登录", step1p: "授权只读访问 Search Console 和 Google Analytics 4，随时可以撤销。",
    step2: "复制令牌", step2p: "控制台给你一个专属 MCP 地址和令牌，附带各客户端的现成配置。",
    step3: "直接问助手", step3p: "「这个月哪些页面掉了点击？」「审计这个 URL 的 AI 搜索表现」「哪些词排在 8 到 20 名？」",
    what: "助手能拿到什么",
    g1: "Search Console", g1p: "查询词、页面、国家、设备；临门一脚的关键词、CTR 缺口、关键词蚕食、疑问式查询、索引覆盖、站点地图和网址检查。",
    g2: "Google Analytics 4", g2p: "报表、透视、漏斗、实时、周期对比，以及把 GA4 会话和 Search Console 点击合并的落地页视图。",
    g3: "页面与站点审计", g3p: "页面 SEO、PageSpeed 和核心网页指标、结构化数据、hreflang、robots 与站点地图、社交预览、整站抓取。",
    g4: "GEO（AI 搜索）", g4p: "AI 爬虫可访问性、llms.txt、E-E-A-T 信号、schema 建议、每页 GEO 评分、品牌知识图谱检查。",
    trust: "只读，只看你自己的数据",
    trustP: "托管服务只申请只读的 Google 权限。它不会改你的网站，不会替你提交任何东西，每个令牌只对应一个 Google 账号：你自己的。会产生费用的工具（付费第三方 API）和会写入 CMS 的工具不在托管服务里，它们在开源版本中，你可以自己部署。",
    openSource: "开源",
    openSourceP: "这是 google-seo-mcp 的托管版。开源版本采用 MIT 许可，有 80 多个工具，自己部署可以获得 WordPress 编辑、GitHub 提交和图片流水线。",
    account: "账号",
    connectedOn: "连接时间",
    scopes: "Google 权限",
    tokens: "令牌",
    tokensP: "每个令牌相当于 MCP 端点的一个专属密码。建议每个客户端一个，方便单独撤销。完整令牌只显示一次。",
    label: "备注（可选）",
    create: "创建令牌",
    revoke: "撤销",
    noTokens: "还没有令牌。创建一个来连接客户端。",
    created: "创建", lastUsed: "最近使用", calls: "调用次数", never: "从未",
    newToken: "你的新令牌",
    newTokenP: "现在就复制。出于安全考虑它不会被保存，也无法再次显示。",
    connect: "连接客户端",
    connectP: "所有客户端都用同样两个值：端点地址和请求头",
    endpoint: "端点",
    claudeApps: "Claude（网页、桌面、手机）",
    claudeAppsP: "设置 → Connectors → Add custom connector。起个名字，粘贴地址，认证选 None，然后加一个请求头：",
    claudeCode: "Claude Code",
    codex: "OpenAI Codex", codexP: "写在 ~/.codex/config.toml；先把令牌导出为环境变量",
    cursor: "Cursor / VS Code / Gemini CLI", cursorP: "Cursor 用 ~/.cursor/mcp.json（如下）；VS Code 把同样的块放在 \"servers\" 下并加 \"type\": \"http\"；Gemini CLI 用 \"httpUrl\"。",
    tryIt: "然后试试：",
    connections: "连接",
    connectionsP: "Google 已通过登录连接。连接其他服务后，你的令牌会多出对应的工具。",
    githubTitle: "GitHub",
    githubOff: "未连接。把应用安装到你想让助手编辑的仓库上：整文件、局部修改、图片提交。部署由你的托管方 CI 完成（Cloudflare、Vercel、Netlify 等）。",
    githubOn: "已连接为",
    githubRepos: "仓库",
    githubTools: "你的令牌现在包含 github_* 工具（读取、局部修改、图片提交）。所有写入工具都支持 dryRun。",
    connectGithub: "连接 GitHub",
    manageGithub: "在 GitHub 上管理仓库",
    disconnectGithub: "断开 GitHub",
    disconnectGithubP: "从你的 GitHub 账号卸载应用；由它签发的令牌立即失效。",
    disconnect: "断开 Google 账号",
    disconnectP: "撤销 Google 授权，删除你的所有令牌和本服务器上的账号记录。",
    disconnectConfirm: "确认断开并删除",
    danger: "危险操作",
    limits: "限制",
    limitsP: "PageSpeed、CrUX、知识图谱 API 的配额是共享的；pagespeed 和 site_crawl 可能跑几分钟，把客户端的工具超时调到 60 秒以上。服务按现状提供，不保证在线率。",
    unverified: "本应用在等待 Google 验证期间，登录时 Google 会显示「未经验证的应用」提示，点 Advanced（高级）→ Go to（继续前往）即可。",
  },
} as const;

export type Strings = typeof T.en;
export function strings(lang: Lang): Strings { return T[lang] as Strings; }

export function pickLang(cookieLang: string | undefined, acceptLanguage: string | undefined, query: string | null): Lang {
  const v = (query ?? cookieLang ?? "").toLowerCase();
  if (v === "zh" || v === "en") return v;
  return /^zh|,zh/i.test(acceptLanguage ?? "") ? "zh" : "en";
}

export interface Shell { lang: Lang; title: string; user?: { email: string; picture: string | null } | null; repo: string; path: string }

export function layout(s: Shell, body: string): string {
  const t = strings(s.lang);
  const other = s.lang === "en" ? "zh" : "en";
  const sep = s.path.includes("?") ? "&" : "?";
  return `<!doctype html><html lang="${s.lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.title)}</title><meta name="description" content="${esc(t.heroLead)}"><style>${CSS}</style></head><body><div class="wrap">
<header class="top"><a class="brand" href="/">google-seo-mcp <span class="muted small">· ${esc(t.tagline)}</span></a>
<nav><a href="${esc(s.path)}${sep}lang=${other}">${other === "zh" ? "中文" : "English"}</a><a href="${esc(s.repo)}">${t.github}</a>${s.user ? `<a href="/dashboard">${t.dashboard}</a><form method="post" action="/logout" style="display:inline"><button class="btn ghost" style="padding:6px 12px;font-size:14px">${t.signOut}</button></form>` : `<a class="btn" href="/login">${t.signIn}</a>`}</nav></header>
${body}
<footer><a href="/privacy">${t.privacy}</a><a href="/terms">${t.terms}</a><a href="${esc(s.repo)}">${t.github}</a><span>© ${new Date().getFullYear()} google-seo-mcp · MIT</span></footer>
</div></body></html>`;
}

export function landingPage(s: Shell, opts: { toolCount: number; verified: boolean }): string {
  const t = strings(s.lang);
  return layout(s, `
<section class="hero"><h1>${t.heroTitle}</h1><p class="lead">${t.heroLead}</p>
<a class="btn" href="/login">${t.signIn}</a>${opts.verified ? "" : `<p class="small warn" style="margin-top:12px">${t.unverified}</p>`}</section>
<h2>${t.how}</h2>
<div class="grid"><div class="card"><span class="n">1</span><h3>${t.step1}</h3><p>${t.step1p}</p></div><div class="card"><span class="n">2</span><h3>${t.step2}</h3><p>${t.step2p}</p></div><div class="card"><span class="n">3</span><h3>${t.step3}</h3><p>${t.step3p}</p></div></div>
<h2>${t.what}</h2>
<div class="grid"><div class="card"><h3>${t.g1}</h3><p>${t.g1p}</p></div><div class="card"><h3>${t.g2}</h3><p>${t.g2p}</p></div><div class="card"><h3>${t.g3}</h3><p>${t.g3p}</p></div><div class="card"><h3>${t.g4}</h3><p>${t.g4p}</p></div></div>
<h2>${t.trust}</h2><p>${t.trustP}</p>
<h2>${t.openSource}</h2><p>${t.openSourceP.replace("google-seo-mcp", `<a href="${esc(s.repo)}">google-seo-mcp</a>`)}</p>`);
}

export interface DashboardData {
  user: { email: string; name: string | null; picture: string | null; createdAt: string; scopes: string[] };
  tokens: { hash: string; prefix: string; label: string | null; createdAt: string; lastUsedAt: string | null; calls: number }[];
  newToken?: string | null;
  endpoint: string;
  csrf: string;
  /** undefined = GitHub App not configured on this server; null = configured but not connected. */
  github?: { login: string; repos: string[]; manageUrl: string } | null;
  flashError?: string | null;
}

function snippets(endpoint: string, token: string) {
  const tk = esc(token);
  const ep = esc(endpoint);
  return {
    header: `Authorization: Bearer ${tk}`,
    claudeCode: `claude mcp add --transport http google-seo ${ep} --header "Authorization: Bearer ${tk}"`,
    codex: `export GOOGLE_SEO_MCP_TOKEN=${tk}\n\n[mcp_servers.google-seo]\nurl = "${ep}"\nbearer_token_env_var = "GOOGLE_SEO_MCP_TOKEN"\ntool_timeout_sec = 600`,
    cursor: `{\n  "mcpServers": {\n    "google-seo": {\n      "url": "${ep}",\n      "headers": { "Authorization": "Bearer ${tk}" }\n    }\n  }\n}`,
  };
}

export function dashboardPage(s: Shell, d: DashboardData): string {
  const t = strings(s.lang);
  const fmt = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : t.never);
  const sn = snippets(d.endpoint, d.newToken ?? "<token>");
  const rows = d.tokens.length
    ? d.tokens.map((k) => `<tr><td><code>${esc(k.prefix)}…</code>${k.label ? ` <span class="muted">${esc(k.label)}</span>` : ""}</td><td>${fmt(k.createdAt)}</td><td>${fmt(k.lastUsedAt)}</td><td>${k.calls}</td><td><form method="post" action="/tokens/revoke"><input type="hidden" name="csrf" value="${esc(d.csrf)}"><input type="hidden" name="hash" value="${esc(k.hash)}"><button class="btn danger" style="padding:4px 10px;font-size:13px">${t.revoke}</button></form></td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">${t.noTokens}</td></tr>`;
  return layout(s, `
<h2>${t.account}</h2>
<div class="card"><p>${d.user.picture ? `<img class="avatar" src="${esc(d.user.picture)}" alt="">` : ""}<strong>${esc(d.user.name ?? d.user.email)}</strong> <span class="muted">${esc(d.user.email)}</span></p>
<p class="small muted" style="margin-top:8px">${t.connectedOn} ${fmt(d.user.createdAt)} · ${t.scopes}: ${d.user.scopes.filter((x) => x.includes("googleapis")).map((x) => `<code>${esc(x.replace("https://www.googleapis.com/auth/", ""))}</code>`).join(" ")}</p></div>
${d.newToken ? `<div class="notice"><h3 style="margin:0 0 6px">${t.newToken}</h3><p class="small muted" style="margin:0 0 10px">${t.newTokenP}</p><div class="token">${esc(d.newToken)}</div></div>` : ""}
${d.github === undefined ? "" : `<h2>${t.connections}</h2><p class="muted small">${t.connectionsP}</p>
${d.flashError ? `<p class="notice warn">${esc(d.flashError)}</p>` : ""}
<div class="card"><h3 style="margin:0 0 6px">${t.githubTitle}</h3>${d.github
    ? `<p><span class="ok">●</span> ${t.githubOn} <strong>${esc(d.github.login)}</strong> · ${t.githubRepos}: ${d.github.repos.length ? d.github.repos.map((r) => `<code>${esc(r)}</code>`).join(" ") : "<span class=\"muted\">0</span>"}</p><p class="small muted" style="margin:8px 0 12px">${t.githubTools}</p><p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><a class="btn ghost" href="${esc(d.github.manageUrl)}">${t.manageGithub}</a><form method="post" action="/connect/github/disconnect" onsubmit="return confirm('${t.disconnectGithub}?')"><input type="hidden" name="csrf" value="${esc(d.csrf)}"><button class="btn danger">${t.disconnectGithub}</button></form></p><p class="small muted" style="margin:6px 0 0">${t.disconnectGithubP}</p>`
    : `<p class="muted small" style="margin:0 0 12px">${t.githubOff}</p><a class="btn" href="/connect/github">${t.connectGithub}</a>`}</div>`}
<h2>${t.tokens}</h2><p class="muted small">${t.tokensP}</p>
<table><thead><tr><th>Token</th><th>${t.created}</th><th>${t.lastUsed}</th><th>${t.calls}</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<form class="inline" method="post" action="/tokens" style="margin-top:16px"><input type="hidden" name="csrf" value="${esc(d.csrf)}"><input type="text" name="label" maxlength="40" placeholder="${t.label}"><button class="btn">${t.create}</button></form>
<h2>${t.connect}</h2><p>${t.connectP} <code>Authorization: Bearer &lt;token&gt;</code>.</p>
<p><strong>${t.endpoint}</strong></p><pre><code>${esc(d.endpoint)}</code></pre>
<h3>${t.claudeApps}</h3><p class="small muted">${t.claudeAppsP}</p><pre><code>${sn.header}</code></pre>
<h3>${t.claudeCode}</h3><pre><code>${sn.claudeCode}</code></pre>
<h3>${t.codex}</h3><p class="small muted">${t.codexP}</p><pre><code>${sn.codex}</code></pre>
<h3>${t.cursor}</h3><p class="small muted">${t.cursorP}</p><pre><code>${sn.cursor}</code></pre>
<p class="small muted">${t.tryIt} <em>"Give me a snapshot of my Search Console site for the last 28 days"</em> · <em>"Which queries rank between 8 and 20 with real impressions?"</em> · <em>"Audit https://example.com/page for AI search"</em></p>
<h2>${t.limits}</h2><p class="small muted">${t.limitsP}</p>
<h2>${t.danger}</h2><p class="small muted">${t.disconnectP}</p>
<form method="post" action="/disconnect" onsubmit="return confirm('${t.disconnectConfirm}?')"><input type="hidden" name="csrf" value="${esc(d.csrf)}"><button class="btn danger">${t.disconnect}</button></form>`);
}

export function privacyPage(s: Shell, operator: { contact: string; host: string }): string {
  const zh = s.lang === "zh";
  const body = zh ? `
<h2>隐私政策</h2><p class="muted small">适用于 ${esc(operator.host)} 上的托管服务。开源版本由你自己部署，不向我们发送任何数据。</p>
<h3>我们收集什么</h3><p>用 Google 登录时，我们保存你的 Google 账号标识、邮箱、显示名和头像地址，以及一个 OAuth 刷新令牌（加密存储）。我们不保存密码。为你创建的 MCP 令牌只保存哈希值，明文只显示一次。</p>
<h3>我们如何使用</h3><p>刷新令牌只用于在你的 AI 助手调用工具时代表你读取 Search Console 和 Google Analytics 4 数据。数据从 Google 取回后直接返回给你的助手，不在服务器上留存、不用于分析、不用于训练任何模型。</p>
<h3>访问日志</h3><p>服务器记录每次调用的时间、工具名、客户端类型和耗时，用于排障和防滥用，不记录参数和返回内容，30 天后自动删除。</p>
<h3>第三方</h3><p>页面审计类工具会代表你访问你提供的公开网址、Google PageSpeed Insights、Chrome UX Report 和 Google Knowledge Graph 接口。我们不向任何第三方出售或共享你的数据。</p>
<h3>保留与删除</h3><p>数据在你断开账号前一直保留。在控制台点「断开 Google 账号」会撤销 Google 授权并立即删除账号记录和全部令牌。你也可以在 <a href="https://myaccount.google.com/permissions">Google 账号权限页</a> 撤销授权。</p>
<h3>联系方式</h3><p>${esc(operator.contact)}</p>` : `
<h2>Privacy policy</h2><p class="muted small">Applies to the hosted service at ${esc(operator.host)}. The open-source server is self-hosted and sends nothing to us.</p>
<h3>What we collect</h3><p>When you sign in with Google we store your Google account ID, email address, display name and avatar URL, plus an OAuth refresh token (encrypted at rest). We never see your password. MCP tokens we create for you are stored as hashes; the clear text is shown once.</p>
<h3>How we use it</h3><p>The refresh token is used only to read Search Console and Google Analytics 4 data on your behalf when your AI assistant calls a tool. Results are returned straight to your assistant and are not retained, analysed or used to train any model.</p>
<h3>Access logs</h3><p>The server logs the time, tool name, client type and duration of each call for troubleshooting and abuse prevention. Arguments and results are not logged. Logs are deleted after 30 days.</p>
<h3>Third parties</h3><p>Audit tools fetch the public URLs you provide and call Google PageSpeed Insights, Chrome UX Report and Google Knowledge Graph on your behalf. We do not sell or share your data with anyone.</p>
<h3>Retention and deletion</h3><p>Data is kept until you disconnect. "Disconnect Google account" in the dashboard revokes the Google grant and deletes your record and all tokens immediately. You can also revoke access at <a href="https://myaccount.google.com/permissions">your Google account permissions</a>.</p>
<h3>Contact</h3><p>${esc(operator.contact)}</p>`;
  return layout(s, body);
}

export function termsPage(s: Shell, operator: { host: string }): string {
  const zh = s.lang === "zh";
  const body = zh ? `
<h2>服务条款</h2>
<p>${esc(operator.host)} 上的托管服务由 google-seo-mcp 项目提供，按「现状」提供，不承诺可用性、准确性或适用于特定目的。数据来自 Google 与第三方接口，以它们的口径为准。</p>
<p>你只能连接你有权访问的 Google 账号和网站，不得用本服务抓取他人网站到影响其正常运行的程度，不得尝试绕过配额或访问他人数据。</p>
<p>我们可能因滥用、成本或维护原因限制或终止服务；你可以随时在控制台断开账号并删除数据。本项目采用 MIT 许可开源，自行部署的版本不受本条款约束。</p>` : `
<h2>Terms of service</h2>
<p>The hosted service at ${esc(operator.host)} is offered by the google-seo-mcp project "as is", without any warranty of availability, accuracy or fitness for a particular purpose. Data comes from Google and third-party APIs and is subject to their terms.</p>
<p>Connect only Google accounts and websites you are entitled to access. Do not use the service to crawl other people's sites in a way that disrupts them, to circumvent quotas, or to reach data that is not yours.</p>
<p>We may limit or terminate the service for abuse, cost or maintenance reasons. You can disconnect your account and delete your data at any time from the dashboard. The project is open source under the MIT licence; a self-hosted copy is not covered by these terms.</p>`;
  return layout(s, body);
}
