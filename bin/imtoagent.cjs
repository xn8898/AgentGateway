#!/usr/bin/env node
// imtoagent CLI wrapper — finds bun and delegates
"use strict";
var path = require("path");
var fs = require("fs");
var spawnSync = require("child_process").spawnSync;

var candidates = [
  process.env.BUN_BIN,
  path.join(process.env.HOME || "", ".bun", "bin", "bun"),
  "/usr/local/bin/bun",
  "/opt/homebrew/bin/bun",
];
try {
  var r = spawnSync("which", ["bun"]);
  if (r.status === 0) candidates.unshift(r.stdout.toString().trim());
} catch (e) {}

var bunPath = null;
for (var i = 0; i < candidates.length; i++) {
  if (candidates[i] && fs.existsSync(candidates[i])) {
    bunPath = candidates[i];
    break;
  }
}

if (!bunPath) {
  console.error("❌ bun 未找到，请先安装: https://bun.sh");
  console.error("   curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}

var pkgDir = path.resolve(__dirname, "..");
var real = path.join(pkgDir, "bin", "imtoagent-real");
var result = spawnSync(bunPath, [real].concat(process.argv.slice(2)), {
  stdio: "inherit",
  env: Object.assign({}, process.env),
});
process.exit(result.status || 0);
