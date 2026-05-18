#!/usr/bin/env bun
// ================================================================
// postinstall.ts — npm 安装后引导脚本
// ================================================================
// package.json 中 "scripts": { "postinstall": "bun run scripts/postinstall.ts" }
// 安装后自动运行，检测是否需要初始化配置
// ================================================================

import * as fs from 'fs';
import * as path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const DATA_DIR = path.join(HOME, '.imtoagent');

try {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🎉  imtoagent 安装成功！                               ║
║                                                          ║
║   首次使用请先运行配置向导：                              ║
║                                                          ║
║     imtoagent setup                                      ║
║                                                          ║
║   然后启动网关：                                          ║
║                                                          ║
║     imtoagent start                                      ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
  } else {
    console.log(`
✅ imtoagent 升级成功！
   数据目录: ${DATA_DIR}
   配置文件保持不变，无需重新配置。
   运行 "imtoagent start" 启动网关。
`);
  }
} catch (e: any) {
  // 静默失败，不影响安装
  console.error(`[postinstall] 提示失败: ${e.message}`);
}
