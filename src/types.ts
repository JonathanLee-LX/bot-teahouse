/** 多 Agent 协作系统 MVP 的核心类型 */

export interface AgentPermissions {
  /** 能否做审批（通过/驳回需要用户确认的事项） */
  approve: boolean;
  /** 能否产生费用 / 调用付费能力 */
  spend: boolean;
}

/** Agent 定位卡：职责分工的唯一依据 */
export interface AgentCard {
  /** 唯一 id（slug） */
  id: string;
  /** 显示名 */
  name: string;
  /** 职责一句话 */
  role: string;
  /** 可用工具（描述性列表） */
  tools: string[];
  /** 可访问资源（描述性列表） */
  resources: string[];
  permissions: AgentPermissions;
  /** 创建者：用户创建为 "user"，agent 创建则为创建者 id */
  parent: string;
  createdAt: string;
}

export interface HandoffRecord {
  from: string;
  to: string;
  task: string;
  progress: string;
  reason: string;
  nextStep: string;
  at: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}
