import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_INFO } from "./server.js";
import { envValue } from "./env.js";
import { describeCredentialSource, runWithAuth } from "./google.js";
import { HOSTED_SERVER_OPTIONS, loadHosted } from "./hosted/index.js";

const PORT = Number(envValue("MCP_PORT") ?? 8080);
const HOST = envValue("MCP_HOST") ?? "127.0.0.1";
const PATH = envValue("MCP_PATH") ?? "/mcp";
const TOKEN = envValue("MCP_AUTH_TOKEN");

function bearer(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Operator token (or no token configured at all). */
function authorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const a = Buffer.from(bearer(req));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHttp() {
  const hosted = loadHosted();
  if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.error("WARNING: MCP_AUTH_TOKEN is not set while binding to a non-loopback host. Anyone reaching this port can query your Google data.");
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      // Liveness for proxies and deploy scripts; version and credential source only for callers that hold the token.
      json(res, 200, authorized(req) ? { ok: true, version: SERVER_INFO.version, credentials: describeCredentialSource() } : { ok: true });
      return;
    }
    if (url.pathname !== PATH) {
      if (hosted && (await hosted.handle(req, res, url))) return;
      json(res, 404, { error: "not found" });
      return;
    }
    // Operator token → full server with the operator's credentials; hosted user token → read-only server on that user's Google grant.
    const tenant = authorized(req) ? null : hosted?.resolve(bearer(req)) ?? null;
    if (!authorized(req) && !tenant) {
      res.setHeader("WWW-Authenticate", "Bearer");
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no standalone SSE stream and no session to delete.
      json(res, 405, { error: "method not allowed" });
      return;
    }

    // Stateless: a fresh server + transport per request, so a crash in one
    // request never affects others and there is nothing to leak over days of uptime.
    const server = createServer(tenant ? HOSTED_SERVER_OPTIONS : {});
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      if (tenant) await runWithAuth(tenant.auth, () => transport.handleRequest(req, res));
      else await transport.handleRequest(req, res);
    } catch (err) {
      console.error("request failed:", err);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });

  httpServer.keepAliveTimeout = 65_000;
  httpServer.listen(PORT, HOST, () => {
    console.error(`google-seo-mcp listening on http://${HOST}:${PORT}${PATH} (auth: ${TOKEN ? "bearer token" : "NONE"}, credentials: ${describeCredentialSource()}${hosted ? `, ${hosted.describe()}` : ""})`);
  });

  const shutdown = () => {
    console.error("shutting down");
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
