// IM 能力 → Agent Prompt + 输出解析
// Agent 产出文本 → 网关解析为结构化块 → IM 原生渲染

import type { IMCapabilities } from './types';

export type UnifiedBlock =
  | { type: 'text'; content: string }
  | { type: 'code_block'; code: string; language: string; title?: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'card'; title: string; content: string; color?: string; buttons?: { label: string; url?: string }[] }
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { type: 'file'; url: string; filename: string }
  | { type: 'audio'; url: string; filename: string; duration?: number }
  | { type: 'divider' };

// ================================================================
// System Prompt：告诉 Agent 可用的输出格式
// ================================================================
// 设计原则：
//   只告诉 Agent 它能通过 markdown 语法表达的能力。
//   IMCapabilities 里 capability=true 但 parseToBlocks 没有对应语法
//   → 不生成提示词，避免 Agent 误以为能输出。
// ================================================================

export function buildCapabilityPrompt(caps: IMCapabilities): string {
  const lines: string[] = [];

  // 总览
  lines.push('## IM 客户端环境');
  lines.push('你通过飞书（Lark）即时通讯与用户对话。你的回复会被网关解析为飞书原生消息格式。');
  lines.push('');

  // 文本限制
  lines.push(`**文本限制**：单条消息最多 ${caps.maxTextLength} 字符，超长会自动截断。`);

  // ========== 只能生成 parseToBlocks 支持的能力 ==========

  // 代码 — ``` 语法
  if (caps.codeBlock) {
    lines.push('**代码输出**：当输出代码时，使用标准 markdown 代码块（\\```语言\\n代码\\n\\```）。');
    lines.push('⚠️ 注意：飞书对代码块的渲染有限，长代码建议使用折叠面板或分段输出，避免单条消息过长。');
  }

  // 图片 — ![]() 语法
  if (caps.imageSend) {
    lines.push('**图片**：可以使用 markdown 图片语法 `![描述](URL)` 发送图片。支持本地 file:// 路径（如图表截图）和远程 URL。网关会自动渲染，无需额外上传步骤。');
  }

  // 表格 + 卡片 — | 语法（需要 cardMessage 容器来渲染）
  if (caps.cardMessage) {
    lines.push('**表格**：可以使用标准 markdown 表格语法来展示结构化数据。');
    lines.push('```');
    lines.push('| 列A | 列B |');
    lines.push('| --- | --- |');
    lines.push('| 数据1 | 数据2 |');
    lines.push('```');
    lines.push('**卡片消息**：可以使用富文本卡片（多块内容会自动组合为一张卡片消息）。');
  }

  // 文件发送 — fileSend + 本地路径语法
  if (caps.fileSend) {
    lines.push('**文件发送**：如果你生成了文件（如图表、CSV、代码文件等），在回复中直接使用以下语法即可发送，网关会自动完成上传和投递，你不需要调用任何额外工具：');
    lines.push('`📎 [文件名](file:///本地绝对路径)`');
    lines.push('例如：`📎 [分析结果.csv](file:///tmp/result.csv)`');
  }


  // 语音发送 — audioSend + 本地路径语法
  if (caps.audioSend) {
    lines.push('**语音/音频**：如果你生成了音频文件（如语音合成、录音等），在回复中直接使用以下语法即可发送，网关会自动处理：');
    lines.push('`🎙️ [文件名](file:///本地绝对路径)`');
    lines.push('例如：`🎙️ [语音播报.mp3](file:///tmp/tts-output.mp3)`');
  }

  // 注：buttonAction 有 IM 能力但无 markdown 语法，不生成提示词

  lines.push('');
  lines.push('### 行为规则');
    lines.push('- 不要在回复中提及或尝试调用 lark-cli、feishu 等第三方上传工具——网关会自动解析 📎 和 ![图片]() 语法并完成发送');
  lines.push('- **每次修改/创建/删除文件后，必须简要汇报结果**（如"已修改 xxx.ts，修复了 YYY 问题"），不要默默完成就结束');
  lines.push('- 任务完成后用一两句话总结做了什么');
  lines.push('');
  lines.push('### 格式转换规则');
  lines.push('- 你的回复会被按 markdown 格式解析为多个块（文本、代码、图片、卡片等）');
  lines.push('- 每个块会被渲染为对应的飞书原生元素');
  lines.push('- 不要提及这些技术细节，直接使用对应格式即可');

  return lines.join('\n');
}

// ================================================================
// 输出解析：Agent 文本 → UnifiedBlock[]
// ================================================================

export function parseToBlocks(text: string, caps: IMCapabilities): UnifiedBlock[] {
  const blocks: UnifiedBlock[] = [];

  // 构建所有匹配模式
  type MatchDef = { regex: RegExp; make: (m: RegExpExecArray) => UnifiedBlock };
  const patterns: MatchDef[] = [];
  if (caps.codeBlock) {
    patterns.push({
      regex: /```(\w*)\n([\s\S]*?)```/g,
      make: (m) => ({ type: 'code_block', code: m[2].trim(), language: m[1] || '' }),
    });
  }
  if (caps.audioSend) {
    patterns.push({
      regex: /🎙️\s*\[([^\]]*)\]\((file:\/\/[^)]+)\)/g,
      make: (m) => ({ type: 'audio', url: m[2], filename: m[1] }),
    });
  }
  if (caps.imageSend) {
    patterns.push({
      regex: /!\[([^\]]*)\]\(([^)]+)\)/g,
      make: (m) => ({ type: 'image', alt: m[1], url: m[2] }),
    });
  }
  if (caps.fileSend) {
    patterns.push({
      regex: /📎\s*\[([^\]]*)\]\((file:\/\/[^)]+)\)/g,
      make: (m) => ({ type: 'file', url: m[2], filename: m[1] }),
    });
  }
  if (caps.audioSend) {
    patterns.push({
      regex: /🎙️\s*\[([^\]]*)\]\((file:\/\/[^)]+)\)/g,
      make: (m) => ({ type: 'audio', url: m[2], filename: m[1] }),
    });
  }

  // 表格：仅在有 cardMessage 能力时解析
  // 匹配 markdown 表格：表头行 | 分隔行 | 数据行...
  const tableRegex = caps.cardMessage
    ? /(?:^[^\n]*\n)?\|[^|\n]+\|[^|\n]*\|\n\|[-: |]+\|\n(?:\|[^|\n]+\|[^|\n]*\|\n?)+/gm
    : null;

  // 第一遍：收集表格匹配位置（标记为"占位"，避免被其他正则误匹配）
  type TableMatch = { index: number; end: number; block: UnifiedBlock };
  const tableMatches: TableMatch[] = [];
  const tableMasked = text; // 保存原文本用于表格内容提取
  if (tableRegex) {
    tableRegex.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tableRegex.exec(text)) !== null) {
      const lines = tm[0].split('\n').filter(l => l.startsWith('|'));
      if (lines.length < 3) continue; // 至少需要 header + separator + 1 row
      const headerCells = lines[0].split('|').map(c => c.trim()).filter(Boolean);
      const rows = lines.slice(2).map(l =>
        l.split('|').map(c => c.trim()).filter(Boolean)
      );
      if (headerCells.length === 0 || rows.length === 0) continue;
      tableMatches.push({
        index: tm.index,
        end: tm.index + tm[0].length,
        block: { type: 'table', headers: headerCells, rows },
      });
    }
  }

  if (patterns.length === 0 && tableMatches.length === 0) return [{ type: 'text', content: text }];

  // 收集所有匹配，按位置排序
  const hits: { index: number; end: number; block: UnifiedBlock }[] = [];
  for (const p of patterns) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      hits.push({ index: m.index, end: m.index + m[0].length, block: p.make(m) });
    }
  }
  hits.push(...tableMatches);
  hits.sort((a, b) => a.index - b.index);

  // 去重（重叠匹配只保留第一个，表格优先因为可能更长）
  const deduped: typeof hits = [];
  for (const h of hits) {
    if (deduped.length > 0 && h.index < deduped[deduped.length - 1].end) continue;
    deduped.push(h);
  }

  // 按位置切分
  let lastIndex = 0;
  for (const h of deduped) {
    const before = text.slice(lastIndex, h.index).trim();
    if (before) blocks.push({ type: 'text', content: before });
    blocks.push(h.block);
    lastIndex = h.end;
  }
  const after = text.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', content: after });
  if (blocks.length === 0) blocks.push({ type: 'text', content: text });

  return blocks;
}
