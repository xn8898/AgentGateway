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
