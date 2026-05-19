#!/usr/bin/env bun
// ================================================================
// postinstall.ts — npm 安装后引导脚本
// ================================================================
// package.json 中 "scripts": { "postinstall": "bun run scripts/postinstall.ts" }
// 安装后自动运行，检测是否需要初始化配置
// 如果是全新安装且终端交互，自动引导进入 setup
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const DATA_DIR = path.join(HOME, '.imtoagent');

try {
  const configExists = fs.existsSync(path.join(DATA_DIR, 'config.json'));

  if (configExists) {
    console.log(`
✅ imtoagent 升级成功！
   数据目录: ${DATA_DIR}
   配置文件保持不变，无需重新配置。
   运行 "imtoagent start" 启动网关。
`);
  } else {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🎉  imtoagent 安装成功！                               ║
║                                                          ║
║   首次使用需要配置 IM 凭证和模型供应商                    ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);

    // 检测是否为交互式终端，是则自动引导进入 setup
    if (process.stdin.isTTY) {
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question('是否立即运行配置向导？[Y/n]: ', resolve);
      });
      rl.close();

      const yes = answer.trim().toLowerCase();
      if (yes === '' || yes === 'y' || yes === 'yes') {
        console.log('\n🚀 启动配置向导...\n');
        // 调用 setup 向导
        const pkgDir = path.resolve(import.meta.dirname, '..');
        execSync('bun run bin/imtoagent setup', {
          cwd: pkgDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
      } else {
        console.log('\n稍后运行 "imtoagent setup" 即可开始配置。');
      }
    } else {
      console.log('   运行 "imtoagent setup" 开始配置');
      console.log('   然后运行 "imtoagent start" 启动网关\n');
    }
  }
} catch (e: any) {
  // 静默失败，不影响安装
  if (e.message && !e.message.includes('readline')) {
    console.error(`[postinstall] 提示失败: ${e.message}`);
  }
}
