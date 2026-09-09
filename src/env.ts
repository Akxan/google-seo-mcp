/**
 * Load <package root>/.env into process.env at startup (existing variables win).
 * Tiny parser, no dependency: KEY=VALUE, optional quotes, # comments, blank lines.
 * Resolved relative to this file so it works no matter which directory the client starts the server from.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Parse dotenv text into key/value pairs (quotes stripped, inline `# comments` removed, empty values skipped). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (value === "") continue;
    out[m[1]] = value;
  }
  return out;
}

export function loadDotEnv(): string | null {
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  if (!fs.existsSync(file)) return null;
  for (const [k, v] of Object.entries(parseDotEnv(fs.readFileSync(file, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
  return file;
}

/**
 * Read an environment variable, treating empty or whitespace-only values as unset.
 * Docker's env_file passes `KEY=` through as "", which `??` would otherwise accept as a real value.
 */
export function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
