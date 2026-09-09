#!/usr/bin/env node
import { loadDotEnv } from "./env.js";
loadDotEnv();
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { describeCredentialSource } from "./google.js";

const mode = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http" ? "http" : "stdio";

if (mode === "http") {
  const { startHttp } = await import("./http.js");
  startHttp();
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`google-seo-mcp ready on stdio (credentials: ${describeCredentialSource()})`);
}
