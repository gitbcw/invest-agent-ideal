/**
 * 微信通道共享内核（T-452）。
 *
 * 之前 bridge / mobile / account-store 各持一份逐字相同的分片函数与
 * DEFAULT_BASE_URL，错误分类靠三处独立的中文子串匹配——bridge 抛拼接
 * 错误串、mobile 与 platform 各自猜。现在：
 *   - bridge 是唯一抛错点，抛 WeixinPushError（带结构化 code）；
 *   - weixinErrorCode() 是唯一分类器，优先读 code，兼容历史错误串
 *     （旧 job 的 lastError 文本）；
 *   - 分片函数与默认 baseUrl 只此一份。
 */

export const WEIXIN_TEXT_CHUNK_LIMIT = Number(process.env.WEIXIN_TEXT_CHUNK_LIMIT) || 2000;

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";

export type WeixinErrorCode =
  /** errcode=-14 / session timeout：登录态失效，需要重新扫码连接。 */
  | "session_expired"
  /** ret=-2：会话上下文过期，推送挂起等待用户消息（T-414 awaiting_user 语义）。 */
  | "context_expired"
  /** 其余微信侧错误。 */
  | "wechat_api_error";

export class WeixinPushError extends Error {
  readonly code: WeixinErrorCode;
  constructor(code: WeixinErrorCode, message: string) {
    super(message);
    this.name = "WeixinPushError";
    this.code = code;
  }
}

/** 单一分类器：结构化 code 优先，历史错误串子串兜底。 */
export function weixinErrorCode(error: unknown): WeixinErrorCode {
  if (error instanceof WeixinPushError) return error.code;
  const text = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  if (text.includes("ret=-2")) return "context_expired";
  if (text.includes("errcode=-14") || text.includes("session timeout")) return "session_expired";
  return "wechat_api_error";
}

export function splitWeixinText(text: string, limit = WEIXIN_TEXT_CHUNK_LIMIT): string[] {
  const clean = String(text || "").trim();
  if (!clean) return ["处理完成"];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = findWeixinChunkCut(rest, limit);
    if (cut <= 0) cut = limit;
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

function findWeixinChunkCut(text: string, limit: number) {
  const slice = text.slice(0, limit);
  const boundaries = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(";"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" "),
  ].filter((index) => index > Math.floor(limit * 0.55));
  const best = boundaries.length > 0 ? Math.max(...boundaries) : -1;
  if (best < 0) return limit;
  return best + (slice[best] === "\n" || slice[best] === " " ? 0 : 1);
}
