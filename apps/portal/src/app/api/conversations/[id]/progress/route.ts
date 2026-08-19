import { unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";
import { subscribeChatProgress } from "@/lib/relay/progress-bus";

/**
 * T-199 轮内进度订阅（SSE）。
 *
 * 前端在发起聊天 POST 之前订阅本端点，事件按 assistant+conversation 过滤；
 * 事件为尽力而为投递，断连后由前端重新订阅即可，聊天结果不受影响。
 */
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  const conversationId = params.id;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ kind: "subscribed", conversationId });
      const unsubscribe = subscribeChatProgress(session.assistantId, conversationId, (payload) => {
        send({ kind: "progress", ...payload });
      });
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已关闭。
        }
      };
      request.signal.addEventListener("abort", close);
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
