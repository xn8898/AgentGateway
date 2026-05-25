// ================================================================
// backend-check.ts — 检测后端 Agent 是否已安装
// ================================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
  { type: 'opencode', label: 'OpenCode',   installHint: 'curl -fsSL https://opencode.ai/install | bash' },
];

// ================================================================
// 获取 npm 全局 bin 目录
// 解决 PATH 未包含 npm global bin 时的检测失败问题
// ================================================================

let _cachedNpmBin: string | null | undefined = undefined;

export function getNpmGlobalBin(): string | null {
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
    // PATH 中找不到，继续尝试 fallback
  }

  // fallback 1: npm global bin
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

  // fallback 2: OpenCode custom install path
  if (b.type === 'opencode') {
    const opencodePath = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
    try {
      if (fs.existsSync(opencodePath)) {
        const version = execSync(`"${opencodePath}" version`, { encoding: 'utf-8', timeout: 5000 }).trim();
        return { ...b, installed: true, version };
      }
    } catch {}
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
// Shell config helpers — auto-add paths for user
// ================================================================

function getShellConfigFile(): string | null {
  const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile'];
  const home = os.homedir();
  for (const name of candidates) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) return p;
  }
  // fallback: create .zshrc on macOS
  if (process.platform === 'darwin') {
    return path.join(home, '.zshrc');
  }
  return null;
}

function ensurePathInConfig(configPath: string, binDir: string): void {
  const exportLine = `export PATH="${binDir}:$PATH"`;
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      // Skip if already present
      if (content.includes(binDir)) return;
    }
    fs.appendFileSync(configPath, `\n# Added by imtoagent setup\n${exportLine}\n`);
    // Also update current process.env for immediate detection
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  } catch {}
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
    console.error(`❌ Unknown backend type: ${type}`);
    return false;
  }

  console.log(`\n📦 Installing ${b.label}...`);
  console.log(`   Command: ${b.installHint}\n`);

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
      console.error(`\n❌ ${b.label} installation failed (exit code: ${exitCode})`);
      console.error(`   Run manually: ${b.installHint}`);
      return false;
    }

    // 安装完成后验证 — 按优先级依次检查
    // 1) npm global bin
    if (npmBinDir) {
      const binPath = path.join(npmBinDir, b.type);
      try {
        if (fs.existsSync(binPath)) {
          const version = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
          console.log(`\n✅ ${b.label} installed successfully! Version: ${version}`);
          return true;
        }
      } catch {}
    }

    // 2) OpenCode custom install path
    if (type === 'opencode') {
      const opencodeBinDir = path.join(os.homedir(), '.opencode', 'bin');
      const opencodePath = path.join(opencodeBinDir, 'opencode');
      if (fs.existsSync(opencodePath)) {
        try {
          const version = execSync(`"${opencodePath}" version`, { encoding: 'utf-8', timeout: 5000 }).trim();
          // 自动配置 PATH（如果 shell 配置文件存在且未包含该行）
          const shellConfig = getShellConfigFile();
          if (shellConfig) {
            ensurePathInConfig(shellConfig, opencodeBinDir);
          }
          console.log(`\n✅ ${b.label} installed successfully! Version: ${version}`);
          return true;
        } catch {}
      }
    }

    // 3) via PATH
    const info = checkOne(b);
    if (info.installed) {
      console.log(`\n✅ ${b.label} installed successfully! Version: ${info.version}`);
      return true;
    } else {
      console.error(`\n❌ ${b.label} not detected after installation`);
      if (npmBinDir) {
        console.error(`   npm global bin: ${npmBinDir}`);
        console.error(`   Consider adding it to PATH, or run manually: ${b.installHint}`);
      } else {
        console.error(`   Run manually: ${b.installHint}`);
      }
      return false;
    }
  } catch (e: any) {
    console.error(`\n❌ Error installing ${b.label}: ${e.message || e}`);
    return false;
  }
}
