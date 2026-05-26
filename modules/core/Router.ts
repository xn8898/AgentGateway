import type { RouteResult, AgentInstanceConfig } from "./types.js";

export class Router {
  private agents: Map<string, AgentInstanceConfig>;
  private defaultAgent: string;

  constructor(agents: AgentInstanceConfig[], defaultAgent: string) {
    this.agents = new Map(agents.map(a => [a.id, a]));
    this.defaultAgent = defaultAgent;
  }

  /**
   * 解析用户消息，返回路由结果
   * 支持格式：
   *   @别名 消息       → 精确匹配实例
   *   @机器:类型 消息   → 按机器+类型匹配
   *   @类型 消息       → 唯一直接路由，多个提示选择
   *   /command ...     → 系统指令
   *   消息（无前缀）   → 默认 Agent
   */
  parse(text: string): RouteResult {
    const trimmed = text.trim();

    // 系统指令
    if (trimmed.startsWith("/")) {
      return { target: "__system__", message: trimmed };
    }

    // @前缀路由
    const atMatch = trimmed.match(/^@(\S+)\s+([\s\S]+)$/);
    if (atMatch) {
      const [, alias, message] = atMatch;
      return this.resolveAlias(alias, message);
    }

    // 无前缀 → 默认 Agent
    return { target: this.defaultAgent, message: trimmed };
  }

  private resolveAlias(alias: string, message: string): RouteResult {
    // 格式1: 直接匹配实例别名
    if (this.agents.has(alias)) {
      return { target: alias, message };
    }

    // 格式2: @machine:agent
    const colonIdx = alias.indexOf(":");
    if (colonIdx > 0) {
      const machine = alias.substring(0, colonIdx);
      const type = alias.substring(colonIdx + 1);
      for (const [id, agent] of this.agents) {
        if (agent.type === type && this.hostMatchesMachine(agent.host, machine)) {
          return { target: id, message };
        }
      }
    }

    // 格式3: @类型（匹配所有该类型的实例）
    const typeMatches = Array.from(this.agents.values()).filter(a => a.type === alias);
    if (typeMatches.length === 1) {
      return { target: typeMatches[0].id, message };
    }
    if (typeMatches.length > 1) {
      const list = typeMatches.map(a => `  @${a.id} (${a.host})`).join("\n");
      return {
        target: "__ambiguous__",
        message: `找到多个 ${alias} 实例：\n${list}\n请用 @别名 指定`
      };
    }

    // 未找到
    return { target: "__not_found__", message: `未找到 @${alias}，用 /list 查看可用 Agent` };
  }

  private hostMatchesMachine(host: string, machine: string): boolean {
    const hostname = host.split(":")[0];
    return hostname === machine || hostname.startsWith(machine + ".");
  }

  /** 获取所有已注册的 Agent 实例 */
  getAllAgents(): AgentInstanceConfig[] {
    return Array.from(this.agents.values());
  }

  /** 根据 ID 获取 Agent */
  getAgent(id: string): AgentInstanceConfig | undefined {
    return this.agents.get(id);
  }
}
