import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The WordPress helpers run on the site through WP-CLI, so a PHP bug ships silently: these check
// them before they are uploaded. Skipped locally when php is missing; in CI (CI=true) a missing
// php fails instead, so the check cannot quietly stop running.
const hasPhp = spawnSync("php", ["-v"]).status === 0;
const skip = !hasPhp && !process.env.CI ? "php is not installed" : false;

test("WordPress helper scripts have no PHP syntax errors", { skip }, () => {
  for (const f of ["scripts/wp-helper.php", "scripts/mfn-builder.php"]) {
    const r = spawnSync("php", ["-l", f], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stdout}${r.stderr}`);
  }
});

test("WordPress helper pure logic (social profiles, builder paths)", { skip }, () => {
  const r = spawnSync("php", ["test/php/helpers.test.php"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^ok \d+ checks/);
});
