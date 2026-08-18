type IncomingMedia = {
  type: "image" | "audio" | "video" | "file";
  filePath: string;
  mimeType: string;
  fileName?: string;
};

type ChatRequest = {
  conversationId: string;
  text: string;
  messageId?: string;
  contextToken?: string;
  media?: IncomingMedia;
};

type ParentMessage =
  | { type: "chat-result"; requestId: string; response?: { text?: string }; error?: string }
  | { type: "stop" };

const accountId = process.env.INVEST_AGENT_WEIXIN_ACCOUNT_ID?.trim();
if (!accountId) {
  throw new Error("微信监听 worker 缺少账号 ID");
}

const abortController = new AbortController();
let requestSequence = 0;
const pendingChats = new Map<string, {
  resolve: (response: { text?: string }) => void;
  reject: (error: Error) => void;
}>();

// W6 修复（2026-08-18）：发布 SIGINT 时主进程会优雅排空在途轮次（最长 240s），
// 但本 worker 原先收到信号立即 abort 并退出，导致在途轮即使跑完也无法把回复
// 送回微信。现在停止接收新消息后，等待在途 chat 完成并送达，再退出；宽限期
// 与主进程排空预算对齐。
const SHUTDOWN_PENDING_GRACE_MS = Math.max(0, Number(process.env.INVEST_AGENT_WEIXIN_SHUTDOWN_GRACE_MS ?? 240_000));
let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;

function requestChat(request: ChatRequest): Promise<{ text?: string }> {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error("微信监听 worker 已与主进程断开"));
  }
  if (stopping) {
    // 停止后不再接新轮次：给用户一个明确回执，而不是让消息静默丢失。
    return Promise.resolve({ text: "系统正在发布更新，请稍后重新发送这条消息。" });
  }
  const requestId = `${process.pid}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingChats.set(requestId, { resolve, reject });
    process.send?.({ type: "chat", requestId, request });
  });
}

function settlePendingAndMaybeExit() {
  if (!stopping || pendingChats.size > 0) return;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  abortController.abort();
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (pendingChats.size === 0) {
    abortController.abort();
    return;
  }
  shutdownTimer = setTimeout(() => abortController.abort(), SHUTDOWN_PENDING_GRACE_MS);
}

process.on("message", (message: ParentMessage) => {
  if (message.type === "stop") {
    stop();
    return;
  }
  if (message.type !== "chat-result") return;
  const pending = pendingChats.get(message.requestId);
  if (!pending) return;
  pendingChats.delete(message.requestId);
  if (message.error) {
    pending.reject(new Error(message.error));
  } else {
    pending.resolve(message.response ?? {});
  }
  settlePendingAndMaybeExit();
});

// 主进程已退出时在途轮不可能再有结果，立即退出而不是等宽限期。
process.on("disconnect", () => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  process.exit(0);
});
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

async function main() {
  const { start } = await import("weixin-agent-sdk");
  await start({ chat: requestChat }, {
    accountId,
    abortSignal: abortController.signal,
    log: (message: string) => process.send?.({ type: "log", message }),
  });
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
