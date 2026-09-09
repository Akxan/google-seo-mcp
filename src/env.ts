/**
 * Load <package root>/.env into process.env at startup (existing variables win).
 * Tiny parser, no dependency: KEY=VALUE, optional quotes, # comments, blank lines.
 * Resolved relative to this file so it works no matter which directory the client starts the server from.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function loadDotEnv(): string | null {
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  if (!fs.existsSync(file)) return null;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (value === "") continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return file;
}
