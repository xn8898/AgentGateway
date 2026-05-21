// ================================================================
// setup.ts — 交互式配置向导（v2）
// ================================================================
// 交互方式：
//   ↑↓ 或 空格 — 切换选项
//   回车 — 确认选择
//   ESC — 返回上一步
//
// 支持的 IM 平台：飞书 / Telegram / 企业微信 / 个人微信
// ================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDataDir, getPkgDir, getTemplatePath, getSoulDir, getBotKey } from '../utils/paths';
import { randomUUID } from 'crypto';
import { checkAllBackends, formatBackendStatus } from '../utils/backend-check';

// ================================================================
// 键盘输入（raw mode）
// ================================================================

const KEY = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  ENTER: '\r',
  SPACE: ' ',
  ESC: '\x1b',
  BACKSPACE: '\x7f',
};

/** 读取单个按键 */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData);
      const s = data.toString();
      if (s === '\x03') process.exit(130); // Ctrl+C
      resolve(s);
    };
    process.stdin.once('data', onData);
  });
}

// ================================================================
// 菜单选择（↑↓/空格 切换，回车确认）
// ================================================================

async function selectMenu(title: string, options: string[]): Promise<number> {
  let idx = 0;
  const linesAbove = options.length + 2;

  function render() {
    // 清除之前的输出
    process.stdout.write('\x1B[0G'); // 回到行首
    options.forEach((opt, i) => {
      const prefix = i === idx ? '▸ ' : '  ';
      process.stdout.write(`\x1B[0G${prefix}${opt}\x1B[0K\n`);
    });
  }

  // 显示标题
  console.log(title);
  render();

  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();

      if (key === KEY.UP || key === KEY.DOWN || key === KEY.SPACE) {
        // 移动光标
        idx = (idx + (key === KEY.UP ? -1 : 1) + options.length) % options.length;
        // 重绘所有选项
        process.stdout.write(`\x1B[${options.length}A`); // 上移 N 行
        render();
      } else if (key === KEY.ENTER) {
        break;
      } else if (key === KEY.ESC) {
        return -1; // ESC = 返回上一步
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  console.log(`\x1B[0G▸ ${options[idx]} ✓\n`);
  return idx;
}

// ================================================================
// 文本输入（回车确认，ESC 返回 -1）
// ================================================================

async function promptText(label: string, defaultValue = ''): Promise<string> {
  const buf: string[] = [];
  const defaultHint = defaultValue ? ` [${defaultValue}]` : '';

  process.stdout.write(`${label}${defaultHint}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();

      if (key === KEY.ENTER) {
        break;
      } else if (key === KEY.ESC) {
        process.stdout.write('\x1B[0K\n');
        return -1 as unknown as string; // 特殊返回值表示 ESC
      } else if (key === KEY.BACKSPACE) {
        if (buf.length > 0) {
          buf.pop();
          process.stdout.write('\x1B[1D \x1B[1D'); // 退格删除
        }
      } else if (key === KEY.UP || key === KEY.DOWN) {
        // 忽略方向键
      } else if (key.length === 1 && key !== KEY.SPACE) {
        // 普通字符（空格单独处理）
        buf.push(key);
        process.stdout.write(key);
      } else if (key === KEY.SPACE) {
        buf.push(' ');
        process.stdout.write(' ');
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  process.stdout.write('\n');
  const result = buf.join('').trim();
  return result || defaultValue;
}

// ================================================================
// 确认（Y/N，回车确认，ESC 返回 -1）
// ================================================================

async function confirm(label: string, defaultYes = true): Promise<boolean | -1> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  process.stdout.write(`${label} ${hint}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();
      if (key === KEY.ENTER) {
        process.stdout.write('\n');
        return defaultYes;
      } else if (key === KEY.ESC) {
        process.stdout.write('\x1B[0K\n');
        return -1;
      } else if (key.toLowerCase() === 'y') {
        process.stdout.write('Y\n');
        return true;
      } else if (key.toLowerCase() === 'n') {
        process.stdout.write('N\n');
        return false;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// ================================================================
// IM 平台配置定义
// ================================================================

const IM_PLATFORMS = [
  { value: 'feishu', label: '飞书', desc: 'WebSocket 长连接' },
  { value: 'telegram', label: 'Telegram', desc: '长轮询' },
  { value: 'wecom', label: '企业微信', desc: '扫码绑定 + WebSocket' },
  { value: 'wechat', label: '个人微信', desc: 'iLink + QR 扫码' },
];

/** 每种 IM 需要的凭证字段 */
const IM_FIELDS: Record<string, { key: string; label: string; required: boolean }[]> = {
  feishu: [
    { key: 'appId', label: '飞书 App ID (cli_...)', required: true },
    { key: 'appSecret', label: '飞书 App Secret', required: true },
  ],
  telegram: [
    { key: 'appId', label: 'Bot Token', required: true },
    { key: 'proxy', label: '代理地址（留空不使用）', required: false },
  ],
  wecom: [
    // 企业微信使用扫码绑定，无需预填凭证，启动时自动触发 QR 扫码
  ],
  wechat: [
    // 微信通过 iLink + QR 扫码认证，无需预填凭证
    { key: 'botId', label: 'iLink Bot ID（留空使用 QR 扫码）', required: false },
    { key: 'botToken', label: 'iLink Bot Token（留空使用 QR 扫码）', required: false },
  ],
};

// ================================================================
// 主流程
// ================================================================

export async function runSetupWizard(): Promise<void> {
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, 'config.json');

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   🚀  imtoagent 配置向导                     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n数据目录: ${dataDir}`);
  console.log(`操作提示: ↑↓/空格 切换  |  回车确认  |  ESC 返回\n`);

  // ===== Step 1: 检测已有配置 =====
  let existingConfig: any = null;
  let mergeMode = false;

  if (fs.existsSync(configPath)) {
    console.log('📋 检测到已有配置\n');
    const idx = await selectMenu('选择操作', ['覆盖现有配置', '合并（保留现有 Bot）', '退出']);
    if (idx === -1) return; // ESC
    if (idx === 2) { console.log('👋 已取消'); process.exit(0); }
    if (idx === 1) mergeMode = true;

    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.log('⚠️  现有配置文件解析失败，将重新生成');
      existingConfig = null;
      mergeMode = false;
    }
  }

  // ===== Step 2: 检测后端 =====
  console.log('\n📌 检测后端 Agent...\n');
  const backendStatus = checkAllBackends();
  console.log(formatBackendStatus(backendStatus));

  const installedBackends = backendStatus.filter(b => b.installed);
  if (installedBackends.length === 0) {
    console.log('\n⚠️  未检测到任何后端 Agent。');
    console.log('推荐安装:');
    console.log('  npm install -g @anthropic-ai/claude-agent-sdk   # Claude Code');
    console.log('  npm install -g @openai/codex                    # Codex');
    console.log('  npm install -g opencode                         # OpenCode');
    const r = await confirm('是否继续配置？（启动后发消息会报错，直到后端安装）', false);
    if (r === false || r === -1) { console.log('\n👋 安装后端后请重新运行 "imtoagent setup"'); process.exit(0); }
    console.log('\n⚠️  已跳过，你可以稍后安装后端。\n');
  } else {
    console.log(`\n✅ 已安装: ${installedBackends.map(b => b.label).join(', ')}\n`);
  }

  // ===== Step 3: 配置 Bot =====
  console.log('📌 Step 3: 配置 Bot\n');

  const bots: any[] = (mergeMode && existingConfig?.bots) ? [...existingConfig.bots] : [];

  let addingBots = true;
  while (addingBots) {
    console.log(`\n--- 添加新 Bot (已有 ${bots.length} 个) ---\n`);

    // 3a: 选择 IM 平台
    const imLabels = IM_PLATFORMS.map(p => `${p.label}  ${p.desc}`);
    const imIdx = await selectMenu('选择 IM 平台', imLabels);
    if (imIdx === -1) { if (bots.length === 0) return; break; } // ESC
    const imType = IM_PLATFORMS[imIdx].value;

    // 3b: 自动生成 Bot 名称，可自定义
    const defaultName = IM_PLATFORMS[imIdx].label + 'Bot';
    const nameInput = await promptText('Bot 名称', defaultName);
    if ((nameInput as any) === -1) { if (bots.length === 0) return; break; } // ESC
    const botName = nameInput || defaultName; // 留空用默认

    // 3c: 选择后端
    const backendLabels = backendStatus.map(b =>
      b.installed ? `${b.label} (v${b.version})` : `${b.label} ⚠️ 未安装`
    );
    const backendIdx = await selectMenu('选择后端', backendLabels);
    if (backendIdx === -1) continue; // ESC 返回重新选 IM
    const backend = backendStatus[backendIdx].type;
    const isBackendInstalled = backendStatus[backendIdx].installed;

    // 后端未安装 → 提示自动安装
    if (!isBackendInstalled) {
      const installCmd = backendStatus[backendIdx].installHint || '';
      console.log(`\n⚠️  ${backend} 未安装`);
      console.log(`   ${installCmd}\n`);
      const r = await confirm('是否现在自动安装?');
      if (r === true) {
        const { installBackend } = await import('../utils/backend-check');
        const ok = await installBackend(backend as 'claude' | 'codex' | 'opencode');
        if (ok) {
          console.log(`✅ ${backend} 已安装\n`);
        } else {
          console.log(`⚠️  安装失败，可稍后手动运行: ${installCmd}\n`);
          const r2 = await confirm('仍要继续配置此 Bot?');
          if (r2 === false) continue;
        }
      } else if (r === -1) {
        continue; // ESC 返回
      } else {
        console.log('跳过安装\n');
      }
    }

    // 3d: 根据 IM 类型收集凭证
    console.log(`\n--- ${IM_PLATFORMS.find(p => p.value === imType)?.label} 凭证 ---`);
    const fields = IM_FIELDS[imType] || [];
    const credentials: Record<string, string> = {};

    for (const field of fields) {
      const val = await promptText(field.label + (field.required ? '' : '（可选）'));
      if ((val as any) === -1) { credentials._escaped = 'true'; break; } // ESC
      credentials[field.key] = val;
    }
    if (credentials._escaped) continue; // ESC 返回重新选后端

    // 3e: 工作目录
    const cwd = await promptText('工作目录', os.homedir());
    if ((cwd as any) === -1) continue;

    // 生成唯一 ID（UUID，用于目录隔离，改名不影响）
    const botId = randomUUID();

    // 构建 Bot 配置（不同 IM 需要的字段不同）
    const bot: any = {
      id: botId,
      name: botName,
      backend,
      cwd: cwd || os.homedir(),
    };

    // 飞书需要 appId + appSecret
    if (imType === 'feishu') {
      bot.appId = credentials.appId || '';
      bot.appSecret = credentials.appSecret || '';
    }
    // Telegram 需要 appId（Bot Token），可选 proxy
    else if (imType === 'telegram') {
      bot.appId = credentials.appId || '';
      if (credentials.proxy) bot.proxy = credentials.proxy;
    }
    // 企业微信：扫码绑定，无需预填凭证（可选 botId/secret）
    else if (imType === 'wecom') {
      bot.im = 'wecom';
      if (credentials.botId) bot.botId = credentials.botId;
      if (credentials.secret) bot.secret = credentials.secret;
    }
    // 个人微信：可选 botId/botToken，留空则 QR 扫码
    else if (imType === 'wechat') {
      bot.im = 'wechat';
      if (credentials.botId) bot.botId = credentials.botId;
      if (credentials.botToken) bot.botToken = credentials.botToken;
      if (credentials.ilinkUserId) bot.ilinkUserId = credentials.ilinkUserId;
    }
    // 默认：非飞书平台加 im 字段
    else {
      bot.im = imType;
    }

    // 检查重名
    const existingIdx = bots.findIndex(b => b.name === botName);
    if (existingIdx >= 0) {
      bots[existingIdx] = bot;
      console.log(`✅ 已替换: ${name}`);
    } else {
      bots.push(bot);
      console.log(`✅ 已添加: ${name}`);
    }

    // 是否继续添加
    const r = await confirm('继续添加其他 Bot?', true);
    if (r === -1) addingBots = false; // ESC = 不添加了，进入下一步
    else addingBots = (r === true);
  }

  if (bots.length === 0) {
    console.log('\n⚠️  未配置任何 Bot。');
    const r = await confirm('至少配置一个 Bot 吗?');
    if (r === true) return runSetupWizard();
    console.log('\n⚠️  至少需要一个 Bot，配置已取消');
    return;
  }

  // ===== Step 4: 配置模型供应商 =====
  console.log('\n📌 Step 4: 配置模型供应商\n');

  const providers: Record<string, any> = {};
  if (mergeMode && existingConfig?.providers) {
    Object.assign(providers, existingConfig.providers);
    console.log(`✅ 已保留 ${Object.keys(providers).length} 个现有供应商\n`);
  }

  let addingProviders = true;
  while (addingProviders) {
    console.log('--- 添加新供应商 ---\n');
    const provName = await promptText('供应商名称 (如 deepseek, dashscope)');
    if ((provName as any) === -1) { addingProviders = false; continue; }
    if (!provName) { addingProviders = false; continue; }

    if (providers[provName]) {
      console.log(`⚠️  供应商 "${provName}" 已存在，将覆盖\n`);
    }

    const baseUrl = await promptText('Base URL (如 https://api.deepseek.com/v1)');
    if ((baseUrl as any) === -1) continue;
    const apiKey = await promptText('API Key');
    if ((apiKey as any) === -1) continue;
    const modelsStr = await promptText('模型列表 (逗号分隔，如 deepseek-v4-pro,deepseek-v4-flash)');
    if ((modelsStr as any) === -1) continue;
    const models = (modelsStr || '').split(',').map(s => s.trim()).filter(Boolean);

    const formatIdx = await selectMenu('API 格式', ['openai', 'anthropic']);
    if (formatIdx === -1) continue;
    const format = ['openai', 'anthropic'][formatIdx];

    const priceInput = await promptText('价格 (入/出 每百万 Token，如 0.55,2.19，留空跳过)');
    if ((priceInput as any) === -1) continue;

    const pricing: any = {};
    if (priceInput) {
      const parts = priceInput.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        pricing.inputPerMillion = parts[0];
        pricing.outputPerMillion = parts[1];
        pricing.currency = 'USD';
      }
    }

    providers[provName] = { baseUrl, apiKey, models, format, ...(Object.keys(pricing).length ? { pricing } : {}) };
    console.log(`✅ 已添加: ${provName}\n`);

    const r = await confirm('继续添加供应商?', false);
    if (r === -1) addingProviders = false;
    else addingProviders = (r === true);
  }

  if (Object.keys(providers).length === 0) {
    console.log('\n⚠️  未配置任何供应商。');
    const r = await confirm('至少配置一个供应商吗?');
    if (r === true) { addingProviders = true; }
  }

  // ===== Step 5: 选择默认模型 =====
  console.log('\n📌 Step 5: 选择默认模型\n');

  const allModels: string[] = [];
  for (const [provName, prov] of Object.entries(providers)) {
    for (const m of (prov as any).models || []) {
      allModels.push(`${provName}/${m}`);
    }
  }

  let defaultModel = '';
  if (allModels.length > 0) {
    const existingDefault = existingConfig?.defaultModel || allModels[0];
    const val = await promptText('默认模型', existingDefault);
    defaultModel = (val as any) === -1 ? existingDefault : (val || existingDefault);
  } else {
    defaultModel = await promptText('默认模型 (供应商/模型名)') || 'deepseek/deepseek-v4-pro';
    if ((defaultModel as any) === -1) defaultModel = 'deepseek/deepseek-v4-pro';
  }

  // ===== Step 6: 生成灵魂文件 =====
  console.log('\n📌 Step 6: 生成灵魂文件\n');

  for (const bot of bots) {
    const botSoulDir = getSoulDir(getBotKey(bot));
    const templateSoulDir = path.join(getPkgDir(), 'templates', 'soul.template');

    if (fs.existsSync(botSoulDir)) {
      const r = await confirm(`已存在 ${bot.name} 的灵魂文件，重新生成?`, false);
      if (r === -1 || r === false) {
        console.log(`⏭  跳过: ${bot.name}`);
        continue;
      }
    }

    fs.mkdirSync(botSoulDir, { recursive: true });

    const soulFiles = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
    for (const sf of soulFiles) {
      const tmplPath = path.join(templateSoulDir, sf);
      const destPath = path.join(botSoulDir, sf);

      if (fs.existsSync(destPath) && !fs.existsSync(tmplPath)) continue;

      if (fs.existsSync(tmplPath)) {
        let content = fs.readFileSync(tmplPath, 'utf-8');
        content = content.replace(/\{\{backend\}\}/g, bot.backend);
        content = content.replace(/\{\{cwd\}\}/g, bot.cwd || os.homedir());
        content = content.replace(/\{\{botName\}\}/g, bot.name);
        fs.writeFileSync(destPath, content);
      }
    }
    console.log(`✅ ${bot.name}: 灵魂文件 → ${botSoulDir}`);
  }

  // ===== Step 7: 写入配置文件 =====
  console.log('\n📌 Step 7: 写入配置文件\n');

  fs.mkdirSync(dataDir, { recursive: true });

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

  const providersFile: any = { providers, defaultModel, modelAliases: config.modelAliases };
  const providersPath = path.join(dataDir, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify(providersFile, null, 2) + '\n');
  console.log(`✅ ${providersPath}`);

  const opencodePath = path.join(dataDir, 'opencode.json');
  const opencodeTemplate = getTemplatePath('opencode.template.json');
  if (fs.existsSync(opencodeTemplate)) {
    fs.writeFileSync(opencodePath, fs.readFileSync(opencodeTemplate, 'utf-8'));
    console.log(`✅ ${opencodePath}`);
  }

  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  console.log('✅ 子目录已创建 (sessions/, logs/)');

  // ===== 完成 =====
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ✅ 配置完成！                              ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Bot: ${bots.map(b => b.name).join(', ')}`);
  console.log(`默认模型: ${defaultModel}`);
  console.log(`供应商: ${Object.keys(providers).join(', ') || '无'}`);
  console.log(`\n下一步:`);
  console.log(`  imtoagent start    启动网关`);
  console.log(`  imtoagent status   查看状态\n`);
}

// ================================================================
// 工具函数
// ================================================================

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
