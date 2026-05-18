// IMtoAgent — Proxy Only 模式（用于 Claude Code CLI）
// 只启动 HTTP 代理，不含飞书 Bot

import * as fs from 'fs';
import * as path from 'path';
import { loadProviders, getProviderConfig, startAnthropicProxy, saveActiveModel, sharedState } from './modules/proxy/anthropic-proxy';

const CONFIG_PATH = path.join(import.meta.dir, 'config.json');

// 加载配置
const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
const cfg = JSON.parse(raw);

// 加载供应商
const { defaultModel } = loadProviders();

// 设置默认模型
const defaultCfg = getProviderConfig(defaultModel);
if (defaultCfg) {
  sharedState.activeConfig = defaultCfg;
  // 从 config.json 加载 modelAliases
  if (cfg.modelAliases) {
    sharedState.modelAliases = cfg.modelAliases;
  }
  console.log(`[Proxy] 默认模型: ${defaultModel}`);
} else {
  console.error(`❌ 无效默认模型: ${defaultModel}`);
  process.exit(1);
}

// 启动代理
const PORT = cfg.system?.proxyPort || 18899;
startAnthropicProxy(PORT).then((port: number) => {
  console.log(`\n🚀 IMtoAgent Proxy-Only 模式`);
  console.log(`   代理: http://localhost:${port}/v1/messages`);
  console.log(`   模型: ${defaultModel}`);
  console.log(`   模式: 格式转换 (Anthropic ↔ OpenAI)`);
  console.log(`\n✅ 可以用 Claude Code 了:`);
  console.log(`   ANTHROPIC_BASE_URL=http://localhost:${port} claude`);
});
