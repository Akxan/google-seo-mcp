/**
 * Smoke test: starts the server over stdio, lists tools, checks annotations and instructions,
 * and compares the tool name list against test/tools.snap.json.
 *   node test/smoke.mjs            # verify
 *   UPDATE_SNAPSHOT=1 node test/smoke.mjs   # refresh snapshot after intentionally adding/removing tools
 * No network calls to Google/WordPress are made (WP_SITES is set to a dummy so wp_* tools register).
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SNAP = new URL("./tools.snap.json", import.meta.url);
const env = { ...process.env, WP_SITES: JSON.stringify([{ name: "dummy", host: "127.0.0.1", user: "x", path: "/tmp" }]) };
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "pipe" }));
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const failures = [];
for (const t of tools) {
  if (!t.description || t.description.length < 40) failures.push(`${t.name}: description too short`);
  if (!t.annotations || typeof t.annotations.readOnlyHint !== "boolean") failures.push(`${t.name}: missing annotations`);
  if (!/^[a-z0-9_]+$/.test(t.name)) failures.push(`${t.name}: bad name`);
}
if (!client.getInstructions()) failures.push("server instructions missing");
const bytes = JSON.stringify(tools).length;
if (process.env.UPDATE_SNAPSHOT) { fs.writeFileSync(SNAP, JSON.stringify(names, null, 2) + "\n"); console.log(`snapshot updated: ${names.length} tools`); }
else if (fs.existsSync(SNAP)) {
  const prev = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const added = names.filter((n) => !prev.includes(n)), removed = prev.filter((n) => !names.includes(n));
  if (added.length || removed.length) failures.push(`tool list changed: +${added.join(",") || "-"} / -${removed.join(",") || "-"} (run UPDATE_SNAPSHOT=1 to accept)`);
} else failures.push("no snapshot; run with UPDATE_SNAPSHOT=1");
// a no-network tool call must work end to end
const r = await client.callTool({ name: "schema_validate", arguments: { jsonld: { "@context": "https://schema.org", "@type": "WebSite", name: "x", url: "https://x.test" } } });
if (r.isError) failures.push("schema_validate call failed");
await client.close();
console.log(`${names.length} tools, ${Math.round(bytes / 1024)} KB of definitions (~${Math.round(bytes / 4)} tokens)`);
if (failures.length) { console.error("FAILURES:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("smoke test passed");
