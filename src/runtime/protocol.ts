/**
 * Runtime message definitions.
 *
 * Channels adapt their payloads to this neutral application contract.
 */

/** Runtime message */
export interface AgentMessage {
  /** 消息 ID */
  id: string;
  /** 消息来源 */
  from: string;
  /** 消息时间戳 */
  timestamp: number;
  /** 消息内容 */
  content: AgentContent;
  /** 上下文信息 */
  context?: Record<string, unknown>;
}

/** Runtime content */
export interface AgentContent {
  /** 内容类型 */
  type: "text" | "image" | "file";
  /** 文本内容 */
  text?: string;
  /** 图片 URL */
  url?: string;
}

/** Runtime response */
export interface AgentResponse {
  /** 回复内容 */
  content: AgentContent;
  /** 是否结束对话轮次 */
  finished: boolean;
  /** 附带数据 */
  data?: Record<string, unknown>;
}

/** 创建文本响应 */
export function textResponse(text: string, finished = true, data?: Record<string, unknown>): AgentResponse {
  return {
    content: { type: "text", text },
    finished,
    ...(data ? { data } : {}),
  };
}
