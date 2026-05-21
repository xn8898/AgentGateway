// ================================================================
// Prompt Builder — 统一的 Agent 系统提示词构建层
// ================================================================
// 职责：
//   1. 加载 Soul（用户自定义指令）
//   2. 构建 IM 能力说明
//   3. 组合成完整 system prompt
//
// 设计原则：
//   - 单一入口：所有 Agent 路径都调用 buildSystemPrompt()
//   - 与 Agent 类型无关：Claude / Codex / 未来任何 Agent 都用同一套
//   - 与 IM 类型无关：通过 IMCapabilities 接口抽象，飞书/微信/Telegram 都行
//   - 无重复：loadSoul、fallback caps、构建逻辑只有一份
// ================================================================

import type { IMCapabilities } from './types';
import { buildCapabilityPrompt } from './capabilities';
import { getSoulDir } from './utils/paths';

// ================================================================
// 默认终端能力（无 IM 模块时的 fallback）
// 唯一数据源 — 所有模块都用这个
// ================================================================
export const DEFAULT_TERMINAL_CAPS: IMCapabilities = {
  text: true,
  codeBlock: true,
  cardMessage: false,
  fileSend: false,
  imageSend: false,
  buttonAction: false,
  maxTextLength: 50000,
};

// ================================================================
// Soul 加载
// ================================================================
// 从 ~/Desktop/imtoagent/soul/{botName}/ 按顺序加载
// 加载顺序：rules → identity → profile → workspace → skills
// ================================================================
export function loadSoul(botKey: string): string {
  const soulDir = getSoulDir(botKey);
  const soulOrder = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
  const parts: string[] = [];
  try {
    const fs = require('fs');
    if (!fs.existsSync(soulDir)) return '';
    for (const file of soulOrder) {
      const fp = soulDir + '/' + file;
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (content) parts.push(content);
      }
    }
  } catch {}
  return parts.join('\n\n');
}

// ================================================================
// 上下文接口
// ================================================================
export interface PromptBuilderContext {
  /** IM 模块实例，用于动态获取当前能力 */
  imModule?: { getCapabilities(): IMCapabilities } | null;
  /** 当 imModule 不可用时，手动指定的能力 */
  caps?: IMCapabilities | null;
  /** Bot 名称，用于加载 Soul */
  botKey: string;
  /** Agent 特有的额外系统提示（如工具使用指南、工作目录约束等） */
  agentInstructions?: string;
}

// ================================================================
// 主入口：构建完整 system prompt
// ================================================================
// 组合顺序（从上到下，优先级递减）：
//   1. Agent 特有指令（最高优先级，Agent 最关心）
//   2. IM 能力说明（告诉 Agent 输出格式约束）
//   3. Soul / 用户自定义指令（长期人格和规则）
// ================================================================
export function buildSystemPrompt(ctx: PromptBuilderContext): string {
  const sections: string[] = [];

  // 1. Agent 特有指令
  if (ctx.agentInstructions) {
    sections.push(ctx.agentInstructions.trim());
  }

  // 2. IM 能力
  const caps = ctx.imModule?.getCapabilities() ?? ctx.caps ?? DEFAULT_TERMINAL_CAPS;
  const capSection = buildCapabilityPrompt(caps);
  sections.push('# 当前对接 IM 能力\n\n' + capSection);

  // 3. 网关运行日志（Agent 可主动查询）
  sections.push(`# 网关运行日志

网关运行日志: ~/.imtoagent/logs/imtoagent.log

你可以通过查看日志来了解网关状态、排查问题、感知重启事件：
- \`tail -n 30 ~/.imtoagent/logs/imtoagent.log\` — 最近 30 行
- \`grep -i "restart\|reload\|shutdown\|SIGTERM" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — 重启/关闭记录
- \`grep -i "error\|fail\|crash" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — 错误记录
- \`grep -i "online\|connected\|disconnected" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — Bot 连接状态

注意：你启动后第一条消息的对话记忆可能已丢失（如果网关重启过），请先检查日志了解上下文。`);

  // 4. Soul
  const soul = loadSoul(ctx.botName);
  if (soul) {
    sections.push('# 用户自定义指令 (IMtoAgent Soul)\n\n' + soul);
  }

  return sections.join('\n\n---\n\n');
}

// ================================================================
// 便捷函数：直接获取能力（消除各处 inline fallback）
// ================================================================
export function resolveCapabilities(
  imModule?: { getCapabilities(): IMCapabilities } | null,
  fallback?: IMCapabilities | null
): IMCapabilities {
  return imModule?.getCapabilities() ?? fallback ?? DEFAULT_TERMINAL_CAPS;
}
