const ACTIVE_LOGIN_TTL_MS = 5 * 60 * 1000;
const QR_LONG_POLL_TIMEOUT_MS = 35 * 1000;

export interface WeixinLoginSession {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  refreshCount: number;
}

export type WeixinLoginQrResult =
  | {
      status: "wait";
    }
  | {
      status: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };

export function isLoginFresh(session: WeixinLoginSession) {
  return Date.now() - session.startedAt < ACTIVE_LOGIN_TTL_MS;
}

export async function fetchWeixinQRCode(apiBaseUrl: string, botType = "3") {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`获取微信二维码失败: ${response.status} ${body}`);
  }
  return (await response.json()) as {
    qrcode: string;
    qrcode_img_content: string;
  };
}

export async function pollWeixinQRStatus(apiBaseUrl: string, qrcode: string): Promise<WeixinLoginQrResult> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`轮询二维码状态失败: ${response.status} ${body}`);
    }
    return (await response.json()) as Exclude<WeixinLoginQrResult, { status: "wait" }>;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}
