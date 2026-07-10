type IncomingMedia = {
  type: "image" | "audio" | "video" | "file";
  filePath: string;
  mimeType: string;
  fileName?: string;
};

type ChatRequest = {
  conversationId: string;
  text: string;
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

function requestChat(request: ChatRequest): Promise<{ text?: string }> {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error("微信监听 worker 已与主进程断开"));
  }
  const requestId = `${process.pid}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingChats.set(requestId, { resolve, reject });
    process.send?.({ type: "chat", requestId, request });
  });
}

function stop() {
  abortController.abort();
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
});

process.on("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

async function main() {
  const { start } = await import("weixin-agent-sdk");
  await start({ chat: requestChat }, {
    accountId,
    abortSignal: abortController.signal,
    log: (message) => process.send?.({ type: "log", message }),
  });
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
