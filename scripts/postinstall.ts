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
✅ imtoagent upgraded successfully!
   Data directory: ${DATA_DIR}
   Configuration file kept as-is, no need to reconfigure.
   Run "imtoagent start" to start the gateway.
`);
  } else {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🎉  imtoagent installed successfully!                  ║
║                                                          ║
║   First-time use requires configuring IM credentials and a model provider   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);

    // 检测是否为交互式终端，是则自动引导进入 setup
    if (process.stdin.isTTY) {
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question('Launch the configuration wizard now? [Y/n]: ', resolve);
      });
      rl.close();

      const yes = answer.trim().toLowerCase();
      if (yes === '' || yes === 'y' || yes === 'yes') {
        console.log('\n🚀 Launching configuration wizard...\n');
        // 调用 setup 向导
        const pkgDir = path.resolve(import.meta.dirname, '..');
        execSync('bun run bin/imtoagent setup', {
          cwd: pkgDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
      } else {
        console.log('\nRun "imtoagent setup" later to configure.');
      }
    } else {
      console.log('   Run "imtoagent setup" to start configuring');
      console.log('   Then run "imtoagent start" to start the gateway\n');
    }
  }
} catch (e: any) {
  // Silently fail, do not affect installation
  if (e.message && !e.message.includes('readline')) {
    console.error(`[postinstall] Failed to display message: ${e.message}`);
  }
}
