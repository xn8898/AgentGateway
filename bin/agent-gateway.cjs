#!/usr/bin/env node
// agent-gateway CLI wrapper — finds bun and delegates
"use strict";
var path = require("path");
var fs = require("fs");
var spawn = require("child_process").spawn;

var candidates = [
  process.env.BUN_BIN,
  path.join(process.env.HOME || "", ".bun", "bin", "bun"),
  "/usr/local/bin/bun",
  "/opt/homebrew/bin/bun",
];
try {
  var r = require("child_process").spawnSync("which", ["bun"]);
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
  console.error("❌ bun not found, please install: https://bun.sh");
  console.error("   curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}

var pkgDir = path.resolve(__dirname, "..");
var real = path.join(pkgDir, "bin", "agent-gateway-real");
var child = spawn(bunPath, [real].concat(process.argv.slice(2)), {
  stdio: "inherit",
  env: Object.assign({}, process.env),
});

child.on("exit", function (code) {
  process.exit(code || 0);
});

child.on("error", function (err) {
  console.error("❌ Failed to start agent-gateway:", err.message);
  process.exit(1);
});
