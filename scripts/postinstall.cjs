#!/usr/bin/env node
// ================================================================
// postinstall.cjs — npm 安装后引导
// ================================================================
// 参考 OpenClaw 的设计：postinstall 只做技术性维护，不做交互。
// 交互式配置由用户运行 `agent-gateway setup` 或 `agent-gateway` 触发。
// ================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DATA_DIR = path.join(HOME, ".agent-gateway");

try {
  const configExists = fs.existsSync(path.join(DATA_DIR, "config.json"));

  if (configExists) {
    console.log("");
    console.log("✅  agent-gateway upgraded successfully!");
    console.log("");
    console.log("   Data directory: " + DATA_DIR);
    console.log("   Configuration file kept as-is, no need to reconfigure.");
    console.log('   Run "agent-gateway start" to start the gateway.');
    console.log("");
  } else {
    console.log("");
    console.log("🎉  agent-gateway installed successfully!");
    console.log("");
    console.log("   For first-time use, run the following commands to complete initial setup:");
    console.log("");
    console.log('     agent-gateway setup      # Interactive configuration wizard');
    console.log('     agent-gateway            # Auto-detects when run with no command; enters wizard if not configured');
    console.log("");
    console.log("   After configuration, start the gateway:");
    console.log("");
    console.log("     agent-gateway start");
    console.log("");
  }
} catch (e) {
  // Silently fail, do not affect installation
}
