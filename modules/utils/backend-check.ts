// ================================================================
// backend-check.ts — 检测后端 Agent 是否已安装
// ================================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface BackendInfo {
  type: 'claude' | 'codex' | 'opencode';
  label: string;
  installed: boolean;
  version: string | null;
  installHint: string;
}

const BACKEND_DEFS: Omit<BackendInfo, 'installed' | 'version'>[] = [
  { type: 'claude', label: 'Claude Code', installHint: 'npm install -g @anthropic-ai/claude-agent-sdk' },
  { type: 'codex',  label: 'Codex',       installHint: 'npm install -g @openai/codex' },
  { type: 'opencode', label: 'OpenCode',   installHint: 'npm install -g opencode' },
];

// ================================================================
// 获取 npm 全局 bin 目录
// 解决 PATH 未包含 npm global bin 时的检测失败问题
// ================================================================

let _cachedNpmBin: string | null | undefined = undefined;

function getNpmGlobalBin(): string | null {
  if (_cachedNpmBin !== undefined) return _cachedNpmBin;
  try {
    const prefix = execSync('npm get prefix', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!prefix) {
      _cachedNpmBin = null;
      return null;
    }
    const binDir = path.join(prefix, 'bin');
    if (fs.existsSync(binDir)) {
      _cachedNpmBin = binDir;
      return binDir;
    }
    _cachedNpmBin = null;
    return null;
  } catch {
    _cachedNpmBin = null;
    return null;
  }
}

function checkOne(b: Omit<BackendInfo, 'installed' | 'version'>): BackendInfo {
  const versionCmd: Record<string, string> = {
    claude: 'claude --version',
    codex: 'codex --version',
    opencode: 'opencode version',
  };

  // 先尝试 PATH 中的命令
  try {
    const version = execSync(versionCmd[b.type], { encoding: 'utf-8', timeout: 5000 }).trim();
    return { ...b, installed: true, version };
  } catch {
    // PATH 中找不到，继续尝试 npm global bin
  }

  // fallback：直接从 npm global bin 目录运行
  const npmBin = getNpmGlobalBin();
  if (npmBin) {
    const binPath = path.join(npmBin, b.type);
    try {
      if (fs.existsSync(binPath)) {
        const version = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
        return { ...b, installed: true, version };
      }
    } catch {
      // bin 存在但执行失败，视为未安装
    }
  }

  return { ...b, installed: false, version: null };
}

export function checkAllBackends(): BackendInfo[] {
  return BACKEND_DEFS.map(checkOne);
}

export function checkBackend(type: 'claude' | 'codex' | 'opencode'): BackendInfo {
  const b = BACKEND_DEFS.find(x => x.type === type);
  if (!b) return { type, label: type, installed: false, version: null, installHint: '' };
  return checkOne(b);
}

export function formatBackendStatus(backends: BackendInfo[]): string {
  return backends.map(b => {
    const icon = b.installed ? '✅' : '❌';
    const ver = b.version ? ` v${b.version}` : '';
    const hint = b.installed ? '' : ` → ${b.installHint}`;
    return `  ${icon} ${b.label}${ver}${hint}`;
  }).join('\n');
}

// ================================================================
// 自动安装后端 CLI
// ================================================================

/**
 * 自动安装缺失的后端 CLI
 * 使用 bash -lc 加载用户 shell 环境，确保 npm 在 PATH 中
 * 流式输出安装进度，支持 Ctrl+C 中断
 */
export async function installBackend(
  type: 'claude' | 'codex' | 'opencode',
): Promise<boolean> {
  const b = BACKEND_DEFS.find((x) => x.type === type);
  if (!b) {
    console.error(`❌ 未知后端类型: ${type}`);
    return false;
  }

  console.log(`\n📦 正在安装 ${b.label}...`);
  console.log(`   命令: ${b.installHint}\n`);

  try {
    // 获取 npm 全局 bin 目录，用于安装后验证（复用 getNpmGlobalBin 缓存）
    const npmBinDir = getNpmGlobalBin();

    // 用 zsh -ic 加载用户 shell 环境（匹配 macOS 默认 shell）
    // 传入当前 PATH 环境变量，确保 npm 可执行文件可访问
    const child = Bun.spawn(['zsh', '-ic', b.installHint], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env },
    });

    const decoder = new TextDecoder();

    // 实时输出 stdout
    const stdoutReader = child.stdout.getReader();
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }

    // 实时输出 stderr
    const stderrReader = child.stderr.getReader();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      process.stderr.write(decoder.decode(value, { stream: true }));
    }

    const exitCode = await child.exited;

    if (exitCode !== 0) {
      console.error(`\n❌ ${b.label} 安装失败 (退出码: ${exitCode})`);
      console.error(`   可手动运行: ${b.installHint}`);
      return false;
    }

    // 安装完成后验证 — 优先用 npm bin 目录直接检查
    if (npmBinDir) {
      const binPath = path.join(npmBinDir, b.type);
      try {
        if (fs.existsSync(binPath)) {
          const version = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
          console.log(`\n✅ ${b.label} 安装成功! 版本: ${version}`);
          return true;
        }
      } catch {}
    }

    // fallback: 通过 PATH 查找
    const info = checkOne(b);
    if (info.installed) {
      console.log(`\n✅ ${b.label} 安装成功! 版本: ${info.version}`);
      return true;
    } else {
      console.error(`\n❌ ${b.label} 安装后仍未检测到`);
      if (npmBinDir) {
        console.error(`   npm 全局 bin 目录: ${npmBinDir}`);
        console.error(`   建议将该目录添加到 PATH，或手动运行: ${b.installHint}`);
      } else {
        console.error(`   请手动运行: ${b.installHint}`);
      }
      return false;
    }
  } catch (e: any) {
    console.error(`\n❌ 安装 ${b.label} 时出错: ${e.message || e}`);
    return false;
  }
}
