// ================================================================
// setup.ts — 交互式配置向导
// ================================================================
// 零依赖，使用 Bun 原生 prompt()
// 通过 `imtoagent setup` 调用
// ================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDataDir, getPkgDir, getTemplatePath, getTemplateSoulPath, getSoulDir } from '../utils/paths';
import { checkAllBackends, formatBackendStatus, checkBackend } from '../utils/backend-check';

// ================================================================
// 主流程
// ================================================================
export async function runSetupWizard(): Promise<void> {
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, 'config.json');
  const providersPath = path.join(dataDir, 'providers.json');
  const opencodePath = path.join(dataDir, 'opencode.json');

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   🚀  imtoagent 配置向导                     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`数据目录: ${dataDir}\n`);

  // ===== Step 1: 检测已有配置 =====
  let existingConfig: any = null;
  if (fs.existsSync(configPath)) {
    console.log('📋 检测到已有配置。');
    console.log('   [1] 覆盖现有配置');
    console.log('   [2] 合并（保留现有 bot，添加新的）');
    console.log('   [3] 退出');

    const choice = await prompt('请选择 (1/2/3): ');
    if (choice === '3' || choice.toLowerCase() === 'exit') {
      console.log('👋 已取消');
      process.exit(0);
    }

    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.log('⚠️  现有配置文件解析失败，将重新生成');
      existingConfig = null;
    }
  }

  // ===== Step 1.5: 检测后端安装状态 =====
  console.log('📌 检测后端 Agent...\n');
  const backendStatus = checkAllBackends();
  console.log(formatBackendStatus(backendStatus));

  const installedBackends = backendStatus.filter(b => b.installed);
  if (installedBackends.length === 0) {
    console.log('\n⚠️  未检测到任何后端 Agent。');
    console.log('你需要先安装至少一个后端 Agent 才能使用 imtoagent。');
    console.log('\n推荐安装:');
    console.log('  npm install -g @anthropic-ai/claude-agent-sdk   # Claude Code');
    console.log('  npm install -g @openai/codex                    # Codex');
    console.log('  npm install -g opencode                         # OpenCode');
    const proceed = await promptChoice('暂不配置 Bot，先退出?', ['Y', 'N']);
    if (proceed === 'Y') {
      console.log('\n👋 安装后端后请重新运行 "imtoagent setup"');
      process.exit(0);
    }
    console.log('\n⚠️  你可以继续配置 Bot，但启动网关后发消息会报错，直到后端安装完成。\n');
  } else {
    console.log(`\n✅ 已安装 ${installedBackends.length} 个后端: ${installedBackends.map(b => b.label).join(', ')}\n`);
  }

  // ===== Step 2: 配置 Bot =====
  console.log('📌 Step 2: 配置 Bot\n');

  const bots: any[] = existingConfig?.bots && (await promptChoice('保留现有 Bot?', ['Y', 'N'])) !== 'N'
    ? [...existingConfig.bots]
    : [];

  let addMore = true;
  while (addMore) {
    console.log(`\n--- 添加新 Bot (已有 ${bots.length} 个) ---`);

    const name = await prompt('Bot 名称 (如 ClaudeBot): ');
    if (!name) { addMore = false; continue; }

    const imType = await promptChoice('IM 平台', ['feishu', 'telegram']);

    // 后端选项：优先推荐已安装的，未安装的标 ⚠️
    const backendOptions = backendStatus.map(b => {
      const label = b.installed ? `${b.label} (v${b.version})` : `${b.label} ⚠️ 未安装`;
      return { value: b.type, label };
    });
    const backendLabels = backendOptions.map(o => o.label);
    const backendChoice = await promptChoice('后端', backendLabels);
    const backend = backendOptions.find(o => o.label === backendChoice)?.value || 'claude';
    const isBackendInstalled = backendStatus.find(b => b.type === backend)?.installed;

    if (!isBackendInstalled) {
      const installCmd = backendStatus.find(b => b.type === backend)?.installHint || '';
      console.log(`\n⚠️  ${backend} 尚未安装。请先运行：`);
      console.log(`   ${installCmd}`);
      const confirm = await promptChoice('仍要继续配置?', ['Y', 'N']);
      if (confirm !== 'Y') {
        addMore = (await promptChoice('继续添加其他 Bot?', ['Y', 'N'])) !== 'Y';
        continue;
      }
    }

    let appId = '', appSecret = '', proxy = '', cwd = '';

    if (imType === 'feishu') {
      appId = await prompt('飞书 App ID (cli_...): ');
      appSecret = await prompt('飞书 App Secret: ');
    } else {
      appId = await prompt('Telegram Bot Token: ');
      proxy = await prompt('代理地址 (留空不使用代理): ') || '';
    }

    cwd = await prompt('工作目录 (如 /Users/keyi/Desktop，留空用默认): ') || os.homedir();

    const bot: any = {
      name,
      appId,
      appSecret,
      backend,
      im: imType === 'feishu' ? undefined : 'telegram',
      cwd,
    };
    if (proxy) bot.proxy = proxy;

    // 检查重名
    const existing = bots.findIndex(b => b.name === name);
    if (existing >= 0) {
      bots[existing] = bot;
      console.log(`✅ 已替换: ${name}`);
    } else {
      bots.push(bot);
      console.log(`✅ 已添加: ${name}`);
    }

    addMore = (await promptChoice('继续添加 Bot?', ['Y', 'N'])) === 'Y';
  }

  if (bots.length === 0) {
    console.log('\n⚠️  未配置任何 Bot。');
    if ((await promptChoice('至少配置一个 Bot 吗?', ['Y', 'N'])) === 'Y') {
      return runSetupWizard(); // 重新开始
    }
  }

  // ===== Step 3: 配置模型供应商 =====
  console.log('\n📌 Step 3: 配置模型供应商\n');

  const providers: Record<string, any> = {};
  let existingProviders = existingConfig?.providers || {};
  const keepProviders = Object.keys(existingProviders).length > 0
    && (await promptChoice('保留现有供应商?', ['Y', 'N'])) !== 'N';

  if (keepProviders) {
    Object.assign(providers, existingProviders);
  }

  let addProvider = true;
  while (addProvider) {
    console.log('\n--- 添加新供应商 ---');
    const provName = await prompt('供应商名称 (如 deepseek, dashscope): ');
    if (!provName) { addProvider = false; continue; }

    if (providers[provName]) {
      console.log(`⚠️  供应商 "${provName}" 已存在，将覆盖`);
    }

    const baseUrl = await prompt('Base URL (如 https://api.deepseek.com/v1): ');
    const apiKey = await prompt('API Key: ');
    const modelsStr = await prompt('模型列表 (逗号分隔，如 deepseek-v4-pro,deepseek-v4-flash): ');
    const models = modelsStr.split(',').map(s => s.trim()).filter(Boolean);
    const format = await promptChoice('API 格式', ['openai', 'anthropic']);

    const pricing: any = {};
    const priceInput = await prompt('价格 (入/出 每百万 Token，如 0.55,2.19，留空跳过): ');
    if (priceInput) {
      const parts = priceInput.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        pricing.inputPerMillion = parts[0];
        pricing.outputPerMillion = parts[1];
        pricing.currency = 'USD';
      }
    }

    providers[provName] = { baseUrl, apiKey, models, format, ...(Object.keys(pricing).length ? { pricing } : {}) };
    console.log(`✅ 已添加: ${provName}`);

    addProvider = (await promptChoice('继续添加供应商?', ['Y', 'N'])) === 'Y';
  }

  // ===== Step 4: 选择默认模型 =====
  console.log('\n📌 Step 4: 选择默认模型\n');

  const allModels: string[] = [];
  for (const [provName, prov] of Object.entries(providers)) {
    for (const m of (prov as any).models || []) {
      allModels.push(`${provName}/${m}`);
    }
  }

  let defaultModel = '';
  if (allModels.length > 0) {
    const existingDefault = existingConfig?.defaultModel || allModels[0];
    const defaultChoice = await prompt(`默认模型 [${existingDefault}]: `);
    defaultModel = defaultChoice || existingDefault;
  } else {
    defaultModel = await prompt('默认模型 (供应商/模型名): ') || 'deepseek/deepseek-v4-pro';
  }

  // ===== Step 5: 生成灵魂文件 =====
  console.log('\n📌 Step 5: 生成灵魂文件\n');

  for (const bot of bots) {
    const botSoulDir = getSoulDir(bot.name);
    const templateSoulDir = path.join(getPkgDir(), 'templates', 'soul.template');

    if (fs.existsSync(botSoulDir) && (await promptChoice(`已存在 ${bot.name} 的灵魂文件，重新生成?`, ['Y', 'N'])) !== 'Y') {
      console.log(`⏭  跳过: ${bot.name}`);
      continue;
    }

    fs.mkdirSync(botSoulDir, { recursive: true });

    const soulFiles = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
    for (const sf of soulFiles) {
      const tmplPath = path.join(templateSoulDir, sf);
      const destPath = path.join(botSoulDir, sf);

      if (fs.existsSync(destPath) && !fs.existsSync(tmplPath)) {
        continue; // 已有且无模板，保留
      }

      if (fs.existsSync(tmplPath)) {
        let content = fs.readFileSync(tmplPath, 'utf-8');
        // 替换模板变量
        content = content.replace(/\{\{backend\}\}/g, bot.backend);
        content = content.replace(/\{\{cwd\}\}/g, bot.cwd || os.homedir());
        content = content.replace(/\{\{botName\}\}/g, bot.name);
        fs.writeFileSync(destPath, content);
      }
    }
    console.log(`✅ ${bot.name}: 灵魂文件已生成 → ${botSoulDir}`);
  }

  // ===== Step 6: 写入配置文件 =====
  console.log('\n📌 Step 6: 写入配置文件\n');

  // 确保数据目录存在
  fs.mkdirSync(dataDir, { recursive: true });

  // config.json
  const config: any = {
    system: existingConfig?.system || {
      defaultProjectDir: os.homedir(),
      idleTimeoutMinutes: 30,
      maxReplyLength: 140000,
    },
    providers,
    defaultModel,
    modelAliases: existingConfig?.modelAliases || buildDefaultAliases(defaultModel),
    execServer: existingConfig?.execServer || {
      enabled: true,
      startupTimeoutMs: 15000,
      fallbackToExec: true,
    },
    codex: existingConfig?.codex || {
      reportedModel: 'gpt-5.5',
      model: defaultModel.split('/')[1] || 'deepseek-v4-pro',
      upstream: (providers[defaultModel.split('/')[0]]?.baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions',
    },
    opencode: existingConfig?.opencode || {
      serverUrl: 'http://localhost:4096',
      defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    },
    rateLimit: existingConfig?.rateLimit || {
      enabled: true,
      maxRequests: 30,
      windowMs: 60000,
    },
    shutdown: existingConfig?.shutdown || {
      gracePeriodMs: 5000,
    },
    bots,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`✅ ${configPath}`);

  // providers.json
  const providersFile: any = {
    providers,
    defaultModel,
    modelAliases: config.modelAliases,
  };
  fs.writeFileSync(providersPath, JSON.stringify(providersFile, null, 2) + '\n');
  console.log(`✅ ${providersPath}`);

  // opencode.json（从模板复制）
  const opencodeTemplate = getTemplatePath('opencode.template.json');
  if (fs.existsSync(opencodeTemplate)) {
    const opencodeContent = fs.readFileSync(opencodeTemplate, 'utf-8');
    fs.writeFileSync(opencodePath, opencodeContent);
    console.log(`✅ ${opencodePath}`);
  }

  // 创建必要的子目录
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  console.log('✅ 子目录已创建 (sessions/, logs/)');

  // ===== Step 7: 完成 =====
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ✅ 配置完成！                              ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Bot: ${bots.map(b => b.name).join(', ')}`);
  console.log(`默认模型: ${defaultModel}`);
  console.log(`供应商: ${Object.keys(providers).join(', ')}`);
  console.log(`\n下一步:`);
  console.log(`  imtoagent start    启动网关`);
  console.log(`  imtoagent status   查看状态`);
  console.log();
}

// ================================================================
// 工具函数
// ================================================================

/** 构建默认模型别名 */
function buildDefaultAliases(defaultModel: string): Record<string, string> {
  return {
    default: defaultModel,
    sonnet: defaultModel,
    opus: defaultModel,
    haiku: defaultModel,
    best: defaultModel,
    opencode: defaultModel,
  };
}

/** 交互式 prompt（Bun 原生） */
async function prompt(question: string): Promise<string> {
  // Bun 环境使用原生 prompt
  if (typeof Bun !== 'undefined' && typeof Bun.stdin !== 'undefined') {
    // 尝试使用 readline
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // fallback
  console.error('⚠️  无法读取用户输入，请检查运行环境');
  return '';
}

/** 选项选择（Y/N 或自定义选项） */
async function promptChoice(question: string, options: string[]): Promise<string> {
  const optStr = options.join('/');
  const answer = await prompt(`${question} [${optStr}]: `);
  const upper = answer.toUpperCase();

  // 精确匹配（全大写比较，返回原始值）
  const exact = options.find(o => o.toUpperCase() === upper);
  if (exact) return exact;

  // 简写匹配（首字母）
  if (upper.length === 1) {
    const short = options.find(o => o[0].toUpperCase() === upper);
    if (short) return short;
  }

  // 默认返回第一个
  if (!answer && options.length > 0) return options[0];
  return upper || options[0];
}
