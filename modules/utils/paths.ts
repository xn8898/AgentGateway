// ================================================================
// 路径解析模块 — npm 全局部署的核心地基
// ================================================================
// 职责：
//   1. 统一解析数据目录（~/.imtoagent/ 或开发时的 cwd）
//   2. 统一解析 npm 包安装目录（读取模板用）
//   3. 兼容旧开发模式（bun run index.ts 在旧项目目录）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';

// ===== 缓存 =====
let _dataDir: string | null = null;
let _pkgDir: string | null = null;

// ===== 数据目录解析 =====
/**
 * 返回 imtoagent 的用户数据目录（读写）。
 *
 * 优先级：
 *   1. IMTOAGENT_HOME 环境变量（最高优先级，测试/定制部署用）
 *   2. ~/.imtoagent/（存在时）
 *   3. cwd（如果 cwd 下有 config.json → 开发模式兼容）
 *   4. import.meta.dirname（npm 全局包安装目录，fallback）
 */
export function getDataDir(): string {
  if (_dataDir) return _dataDir;

  // 1. 环境变量
  const envHome = process.env.IMTOAGENT_HOME;
  if (envHome) {
    _dataDir = envHome;
    console.log(`[Paths] 数据目录: ${_dataDir} (IMTOAGENT_HOME)`);
    return _dataDir;
  }

  const home = process.env.HOME || (process.env.USERPROFILE && process.env.USERPROFILE.replace(/\\/g, '/')) || '';

  // 2. ~/.imtoagent/（存在时）
  const dotDir = path.join(home, '.imtoagent');
  if (fs.existsSync(dotDir)) {
    _dataDir = dotDir;
    console.log(`[Paths] 数据目录: ${_dataDir} (~/.imtoagent)`);
    return _dataDir;
  }

  // 3. cwd 探测（开发模式：在旧项目目录跑 bun run index.ts）
  const cwd = process.cwd();
  const cwdConfig = path.join(cwd, 'config.json');
  if (fs.existsSync(cwdConfig)) {
    _dataDir = cwd;
    console.log(`[Paths] 数据目录: ${_dataDir} (cwd 开发模式)`);
    return _dataDir;
  }

  // 4. npm 包安装目录（fallback）
  const pkgDir = getPkgDir();
  _dataDir = pkgDir;
  console.log(`[Paths] 数据目录: ${_dataDir} (包目录 fallback)`);
  return _dataDir;
}

/**
 * 返回 npm 包安装目录（只读，模板读取用）。
 *
 * import.meta.dirname 在 Bun/Node ESM 中返回当前文件所在目录。
 * 对于全局安装的包，这就是 /usr/local/lib/node_modules/imtoagent/。
 */
export function getPkgDir(): string {
  if (_pkgDir) return _pkgDir;

  // import.meta.dirname 是当前文件（paths.ts）所在目录 → modules/utils/
  // 向上两级就是包根目录
  _pkgDir = path.resolve(import.meta.dirname, '../..');
  return _pkgDir;
}

// ===== 便捷路径函数 =====

export function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

export function getProvidersPath(): string {
  return path.join(getDataDir(), 'providers.json');
}

export function getOpencodeConfigPath(): string {
  return path.join(getDataDir(), 'opencode.json');
}

export function getSessionsDir(): string {
  return path.join(getDataDir(), 'sessions');
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

export function getSoulDir(botName: string): string {
  return path.join(getDataDir(), 'soul', botName);
}

export function getRestoreMarkerPath(): string {
  return path.join(getSessionsDir(), '.restore');
}

export function getTemplatePath(relativePath: string): string {
  const tplPath = path.join(getPkgDir(), 'templates', relativePath);
  if (!fs.existsSync(tplPath)) console.warn(`⚠️  模板不存在: ${tplPath}`);
  return tplPath;
}

export function getTemplateSoulPath(filename: string): string {
  const tplPath = path.join(getPkgDir(), 'templates', 'soul.template', filename);
  if (!fs.existsSync(tplPath)) console.warn(`⚠️  灵魂模板不存在: ${tplPath}`);
  return tplPath;
}

// ===== 重置缓存（测试用） =====
export function resetPathCache(): void {
  _dataDir = null;
  _pkgDir = null;
}
