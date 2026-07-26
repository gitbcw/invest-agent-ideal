/**
 * ACP (Agent Communication Protocol) 消息定义
 *
 * ACP 是智能体与客户端之间的标准化通信协议。
 * OpenClaw 通过 Weixin-Agent-SDK 将微信消息转为 ACP 格式转发给智能体。
 */

/** ACP 消息类型 */
export interface AcpMessage {
  /** 消息 ID */
  id: string;
  /** 消息来源 */
  from: string;
  /** 消息时间戳 */
  timestamp: number;
  /** 消息内容 */
  content: AcpContent;
  /** 上下文信息 */
  context?: Record<string, unknown>;
}

/** ACP 内容 */
export interface AcpContent {
  /** 内容类型 */
  type: "text" | "image" | "file";
  /** 文本内容 */
  text?: string;
  /** 图片 URL */
  url?: string;
}

/** ACP 响应 */
export interface AcpResponse {
  /** 回复内容 */
  content: AcpContent;
  /** 是否结束对话轮次 */
  finished: boolean;
  /** 附带数据 */
  data?: Record<string, unknown>;
}

/** 创建文本响应 */
export function textResponse(text: string, finished = true, data?: Record<string, unknown>): AcpResponse {
  return {
    content: { type: "text", text },
    finished,
    ...(data ? { data } : {}),
  };
}
