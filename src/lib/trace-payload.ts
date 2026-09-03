import { redactSensitiveText } from "./customer-output.js";

/**
 * T-459 TRACE 载荷落盘的截断策略：自动化 run 的工具输入/输出选择性持久化，
 * 单载荷上限 32KB；超限时保留头 75% + 尾 25% 与总量标记，绝不静默丢弃后
 * 声称已落盘（反作弊条款）。
 */
export const TRACE_PAYLOAD_MAX_CHARS = 32_768;

export type TracePayloadText = {
  text: string;
  truncated: boolean;
  totalChars: number;
};

export function serializeTracePayload(value: unknown, maxChars: number = TRACE_PAYLOAD_MAX_CHARS): TracePayloadText {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const text = redactSensitiveText(raw);
  if (text.length <= maxChars) {
    return { text, truncated: false, totalChars: text.length };
  }
  const headChars = Math.floor(maxChars * 0.75);
  const marker = `\n…[trace-payload truncated: total ${text.length} chars, kept head+tail ≈${maxChars}]…\n`;
  const tailChars = Math.max(0, maxChars - headChars - marker.length);
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`,
    truncated: true,
    totalChars: text.length,
  };
}
