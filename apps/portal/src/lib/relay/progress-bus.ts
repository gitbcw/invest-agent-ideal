/**
 * T-199 轮内进度事件总线（进程内、尽力而为）。
 *
 * connector 在聊天轮执行中把 conversation.chat.progress envelope 推给
 * relay；relay 发布到本总线；SSE 路由按 assistant+conversation 订阅并转发
 * 给前端。事件丢失不影响聊天轮结果——最终响应才是权威。
 */

export interface ChatProgressEvent {
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

export interface ChatProgressPayload {
  conversationId: string;
  requestId?: string;
  event: ChatProgressEvent;
}

type Listener = (payload: ChatProgressPayload) => void;

interface ProgressBusState {
  listenersByAssistant: Map<string, Set<Listener>>;
}

// Next dev 与自定义 server 各自编译模块图——必须用 globalThis 单例，
// 否则 relay 的 publish 与 API route 的 subscribe 落在两个实例上（同
// relay/registry.ts 的 getGlobalRegistry 模式）。
const globalKey = Symbol.for("invest-agent-portal.progress-bus");
const globalState = globalThis as typeof globalThis & { [globalKey]?: ProgressBusState };
function busState(): ProgressBusState {
  if (!globalState[globalKey]) {
    globalState[globalKey] = { listenersByAssistant: new Map() };
  }
  return globalState[globalKey];
}

export function subscribeChatProgress(
  assistantId: string,
  conversationId: string,
  listener: Listener
): () => void {
  const state = busState();
  let set = state.listenersByAssistant.get(assistantId);
  if (!set) {
    set = new Set();
    state.listenersByAssistant.set(assistantId, set);
  }
  const scoped: Listener = (payload) => {
    if (payload.conversationId === conversationId) listener(payload);
  };
  set.add(scoped);
  return () => {
    set?.delete(scoped);
    if (set && set.size === 0) state.listenersByAssistant.delete(assistantId);
  };
}

export function publishChatProgress(assistantId: string, payload: ChatProgressPayload): void {
  const set = busState().listenersByAssistant.get(assistantId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(payload);
    } catch {
      // 单个订阅者异常不影响其他订阅者。
    }
  }
}
