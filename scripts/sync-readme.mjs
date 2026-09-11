/**
 * Keep tool counts in README.md, README.zh-CN.md and package.json in sync with test/tools.snap.json.
 *   node scripts/sync-readme.mjs          # rewrite files
 *   node scripts/sync-readme.mjs --check  # exit 1 if anything is stale (used by `npm test`)
 * Group counts come from toolsetOf() in dist/server.js, so build first.
 */
import fs from "node:fs";
import { toolsetOf } from "../dist/server.js";

const check = process.argv.includes("--check");
const names = JSON.parse(fs.readFileSync(new URL("../test/tools.snap.json", import.meta.url), "utf8"));
const total = names.length;
const counts = {};
for (const n of names) counts[toolsetOf(n)] = (counts[toolsetOf(n)] ?? 0) + 1;

const groupLabels = {
  "**Search Console**": "gsc",
  "**Google Analytics 4**": "ga4",
  "**Page & site audits**": "web",
  "**GEO**": "geo",
  "**Analysis**": "analysis",
  "**WordPress**": "wordpress",
  "**GitHub**": "github",
  "**Gmail**": "gmail",
};

const edits = [];
function sync(file, fn) {
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after !== before) { edits.push(file); if (!check) fs.writeFileSync(file, after); }
}

sync("README.md", (s) => {
  s = s.replace(/\b\d+ tools\b/g, `${total} tools`);
  s = s.replace(/\(\d+ definitions/g, `(${total} definitions`);
  for (const [label, set] of Object.entries(groupLabels)) {
    const re = new RegExp(`\\| ${label.replace(/[*&]/g, "\\$&")} \\(\\d+(, optional)?\\) \\|`);
    s = s.replace(re, (m, opt) => `| ${label} (${counts[set] ?? 0}${opt ?? ""}) |`);
  }
  return s;
});
sync("README.zh-CN.md", (s) => s.replace(/\d+ 个工具/g, `${total} 个工具`));
sync("package.json", (s) => s.replace(/\b\d+ tools\b/g, `${total} tools`));

// Every tool must be mentioned by name in both READMEs (the count sync cannot catch a missing row).
const missing = {};
for (const file of ["README.md", "README.zh-CN.md"]) {
  const text = fs.readFileSync(file, "utf8");
  const absent = names.filter((n) => !text.includes("`" + n + "`"));
  if (absent.length) missing[file] = absent;
}
if (Object.keys(missing).length) {
  for (const [file, absent] of Object.entries(missing)) console.error(`${file} does not mention: ${absent.join(", ")}`);
  process.exit(1);
}

if (check) {
  if (edits.length) { console.error(`README counts are stale (${edits.join(", ")}); run: npm run docs:sync`); process.exit(1); }
  console.log(`docs in sync: ${total} tools`, counts);
} else {
  console.log(edits.length ? `updated ${edits.join(", ")}` : "already in sync", `(${total} tools)`, counts);
}
