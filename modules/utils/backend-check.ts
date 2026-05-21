// ================================================================
// backend-check.ts — 检测后端 Agent 是否已安装
// ================================================================

import { execSync } from 'child_process';

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

function checkOne(b: Omit<BackendInfo, 'installed' | 'version'>): BackendInfo {
  try {
    let version: string | null = null;
    if (b.type === 'claude') {
      version = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else if (b.type === 'codex') {
      version = execSync('codex --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      version = execSync('opencode version', { encoding: 'utf-8', timeout: 5000 }).trim();
    }
    return { ...b, installed: true, version };
  } catch {
    return { ...b, installed: false, version: null };
  }
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
    // 用 bash -lc 加载用户 shell 环境（.bashrc/.zshrc），确保 npm 在 PATH 中
    const child = Bun.spawn(['bash', '-lc', b.installHint], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'inherit',
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
      return false;
    }

    // 安装完成后验证
    const info = checkOne(b);
    if (info.installed) {
      console.log(`\n✅ ${b.label} 安装成功! 版本: ${info.version}`);
      return true;
    } else {
      console.error(`\n❌ ${b.label} 安装后仍未检测到，请手动运行: ${b.installHint}`);
      return false;
    }
  } catch (e: any) {
    console.error(`\n❌ 安装 ${b.label} 时出错: ${e.message || e}`);
    return false;
  }
}
