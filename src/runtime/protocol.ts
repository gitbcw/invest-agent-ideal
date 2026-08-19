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

/**
 * T-199 AI 工作过程事件：聊天轮内按发生顺序发出，供 Portal 实时展示。
 * 尽力而为投递——事件丢失不影响正确性，最终响应才是权威结果。
 * AgentMessage.context._onProgress 携带回调，通道与调用方自行决定转发方式。
 */
export interface AgentTurnProgressEvent {
  kind: "turn_start" | "first_token" | "tool_call" | "tool_result" | "model_fallback" | "turn_end";
  at: string;
  seq: number;
  conversationId?: string;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
  errorExcerpt?: string;
  message?: string;
}

export type AgentTurnProgressCallback = (event: AgentTurnProgressEvent) => void;

/** 创建文本响应 */
export function textResponse(text: string, finished = true, data?: Record<string, unknown>): AgentResponse {
  return {
    content: { type: "text", text },
    finished,
    ...(data ? { data } : {}),
  };
}
