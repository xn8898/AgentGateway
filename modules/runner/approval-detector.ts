// ================================================================
// Approval Detector — 检测 Agent 输出中的确认提示
// ================================================================
// 支持 Claude Code、Hermes、OpenCode 的确认模式
// ================================================================

import type { ApprovalDetection } from '../core/types';

/**
 * 检测 CLI 输出中是否包含确认提示
 * 返回 null 表示未检测到，否则返回检测结果
 */
export function detectApprovalPrompt(output: string): ApprovalDetection | null {
  // Claude Code: "Allow this command? [y/n/a/d]"
  const claudeMatch = output.match(
    /(?:Allow|Execute|Run|Use)\s+(?:this\s+)?(?:command|tool|action|file)\s*\?[\s\S]*?\[(\w)\/(\w)(?:\/(\w))?(?:\/(\w))?\]/i
  );
  if (claudeMatch) {
    return {
      prompt: output.split("\n").filter(l => l.trim()).pop() || "Confirm?",
      options: claudeMatch.slice(1).filter(Boolean),
      detail: extractCommandFromOutput(output)
    };
  }

  // Hermes: "Approve this action? (y/n)"
  const hermesMatch = output.match(
    /(?:Approve|Confirm)\s+(?:this\s+)?(?:action|command)\s*\?\s*\((\w)\/(\w)\)/i
  );
  if (hermesMatch) {
    return {
      prompt: output.split("\n").filter(l => l.trim()).pop() || "Approve?",
      options: [hermesMatch[1], hermesMatch[2]],
      detail: extractCommandFromOutput(output)
    };
  }

  // 通用: 包含 [y/n] 的提示
  const genericMatch = output.match(/([\s\S]*?\S.*?)\[(\w)\/(\w)\]\s*$/);
  if (genericMatch) {
    return {
      prompt: genericMatch[1].trim().split("\n").pop() || "Confirm?",
      options: [genericMatch[2], genericMatch[3]],
      detail: ""
    };
  }

  return null;
}

/**
 * 从输出中提取待确认的命令文本
 */
function extractCommandFromOutput(output: string): string {
  const codeBlock = output.match(/```(?:bash|sh)?\n([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim().split("\n")[0];

  const dollarLine = output.match(/\$\s+(.+)/);
  if (dollarLine) return dollarLine[1];

  return "";
}
