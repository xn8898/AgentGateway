#!/usr/bin/env node
// ================================================================
// postinstall.cjs — npm 安装后引导
// ================================================================
// 参考 OpenClaw 的设计：postinstall 只做技术性维护，不做交互。
// 交互式配置由用户运行 `imtoagent setup` 或 `imtoagent` 触发。
// ================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DATA_DIR = path.join(HOME, ".imtoagent");

try {
  const configExists = fs.existsSync(path.join(DATA_DIR, "config.json"));

  if (configExists) {
    console.log("");
    console.log("✅  imtoagent 升级成功！");
    console.log("");
    console.log("   数据目录: " + DATA_DIR);
    console.log("   配置文件保持不变，无需重新配置。");
    console.log('   运行 "imtoagent start" 启动网关。');
    console.log("");
  } else {
    console.log("");
    console.log("🎉  imtoagent 安装成功！");
    console.log("");
    console.log("   首次使用，请运行以下命令完成初始化配置：");
    console.log("");
    console.log('     imtoagent setup      # 交互式配置向导');
    console.log('     imtoagent            # 无命令时自动检测，未配置也会进入向导');
    console.log("");
    console.log("   配置完成后启动网关：");
    console.log("");
    console.log("     imtoagent start");
    console.log("");
  }
} catch (e) {
  // 静默失败，不影响安装
}
