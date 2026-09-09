/**
 * One-time OAuth authorization helper.
 *
 *   npm run auth -- --client-secret ./client_secret.json
 *   # or
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run auth
 *
 * Opens a browser, asks you to grant Search Console + Analytics read access,
 * and writes ~/.config/google-seo-mcp/credentials.json (authorized_user format)
 * which the MCP server picks up automatically.
 */
import { loadDotEnv } from "./env.js";
loadDotEnv();
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { DEFAULT_CREDENTIALS_PATH, SCOPES } from "./google.js";

const PORT = Number(process.env.GOOGLE_OAUTH_PORT ?? 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

function loadClient(): { clientId: string; clientSecret: string } {
  const idx = process.argv.indexOf("--client-secret");
  const file = idx >= 0 ? process.argv[idx + 1] : process.env.GOOGLE_OAUTH_CLIENT_SECRET_FILE;
  if (file) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const c = json.installed ?? json.web ?? json;
    if (!c.client_id || !c.client_secret) throw new Error(`No client_id/client_secret found in ${file}`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Provide OAuth client credentials via --client-secret <file.json> or GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars.",
    );
  }
  return { clientId, clientSecret };
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* user can open the URL manually */
  }
}

async function main() {
  const { clientId, clientSecret } = loadClient();
  const oauth2 = new OAuth2Client(clientId, clientSecret, REDIRECT);
  const url = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(err ? `<h2>授权失败: ${err}</h2>` : "<h2>授权成功，可以关闭此页面。</h2>");
      server.close();
      if (err || !c) reject(new Error(err ?? "no code")); else resolve(c);
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log("\n请在浏览器中打开以下链接完成授权：\n\n" + url + "\n");
      openBrowser(url);
    });
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("No refresh_token returned. Remove the app from https://myaccount.google.com/permissions and run again.");
  }
  const out = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? DEFAULT_CREDENTIALS_PATH;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ type: "authorized_user", client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token }, null, 2),
    { mode: 0o600 },
  );
  console.log(`已保存凭据到 ${out}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
