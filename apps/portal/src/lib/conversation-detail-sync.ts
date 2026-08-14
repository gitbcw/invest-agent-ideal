import type { ConversationGetResult } from "@/lib/protocol";
import {
  ConversationScopeMismatchError,
  type ConversationMirrorRepository
} from "@/lib/db/conversations";

type RemoteConversationPage =
  | { ok: true; data: ConversationGetResult }
  | { ok: false; code: string; message: string };

export interface ConversationDetailSyncResult {
  complete: boolean;
  reconciled?: boolean;
  error?: { code: string; message: string };
}

export async function syncConversationDetail(input: {
  repo: ConversationMirrorRepository;
  conversationId: string;
  userId: string;
  assistantId: string;
  instanceId: string;
  requestPage: (cursor: string | undefined, limit: number) => Promise<RemoteConversationPage>;
  pageSize?: number;
  maxPages?: number;
}): Promise<ConversationDetailSyncResult> {
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 100;
  const scope = {
    userId: input.userId,
    assistantId: input.assistantId,
    instanceId: input.instanceId
  };
  const existing = input.repo.getConversation(input.conversationId);
  const pending = input.repo.getReconciliation({ ...scope, conversationId: input.conversationId });
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pendingUserRequestId: string | undefined;
  let pendingAssistantFound = false;
  let pendingTurnSeen = false;
  let pendingTurnClosed = false;

  for (let page = 0; page < maxPages; page += 1) {
    const remote = await input.requestPage(cursor, pageSize);
    if (!remote.ok) {
      if (pending) {
        input.repo.recordReconciliationError({
          ...scope,
          conversationId: input.conversationId,
          error: `${remote.code}: ${remote.message}`
        });
      }
      return { complete: false, error: { code: remote.code, message: remote.message } };
    }
    if (remote.data.conversationId !== input.conversationId) {
      return {
        complete: false,
        error: { code: "INVALID_RESPONSE", message: "助手返回了不匹配的会话" }
      };
    }

    for (const message of remote.data.messages) {
      if (
        message.conversationId !== input.conversationId ||
        message.assistantId !== input.assistantId ||
        message.instanceId !== input.instanceId
      ) {
        return {
          complete: false,
          error: { code: "SCOPE_MISMATCH", message: "助手返回了其他作用域的会话消息" }
        };
      }
      if (pending?.userMessageId && message.messageId === pending.userMessageId) {
        pendingTurnSeen = true;
        pendingUserRequestId = message.requestId;
      }
      if (
        pending &&
        pendingTurnSeen &&
        message.role === "user" &&
        message.messageId !== pending.userMessageId
      ) {
        pendingTurnClosed = true;
      }
      if (
        pending &&
        message.role === "assistant" &&
        message.status !== "pending" &&
        !pendingTurnClosed &&
        (
          (Boolean(message.requestId) && message.requestId === pendingUserRequestId) ||
          (Boolean(message.requestId) && message.requestId === pending.requestId) ||
          pendingTurnSeen
        )
      ) {
        pendingAssistantFound = true;
      }
    }

    const firstMessage = remote.data.messages[0];
    const lastMessage = remote.data.messages[remote.data.messages.length - 1];
    if (page === 0) {
      try {
        input.repo.upsertConversation({
          conversationId: remote.data.conversationId,
          userId: input.userId,
          assistantId: input.assistantId,
          instanceId: input.instanceId,
          channel: firstMessage?.channel ?? existing?.channel ?? "web",
          title: remote.data.title || existing?.title || "新对话",
          createdAt: firstMessage?.createdAt ?? existing?.created_at,
          updatedAt: lastMessage?.createdAt ?? existing?.updated_at
        });
      } catch (error) {
        if (error instanceof ConversationScopeMismatchError) {
          return {
            complete: false,
            error: { code: "SCOPE_MISMATCH", message: "会话作用域不匹配" }
          };
        }
        throw error;
      }
    }
    for (const message of remote.data.messages) {
      try {
        input.repo.upsertMessage({
          ...message,
          // Runtime and Portal may use different opaque user IDs. The
          // authenticated conversation scope remains authoritative in Portal.
          userId: input.userId
        });
      } catch (error) {
        if (error instanceof ConversationScopeMismatchError) {
          return {
            complete: false,
            error: { code: "SCOPE_MISMATCH", message: "消息作用域不匹配" }
          };
        }
        throw error;
      }
    }

    if (!remote.data.nextCursor) {
      const reconciled = !pending || pendingAssistantFound;
      if (reconciled) {
        input.repo.clearReconciliation({ ...scope, conversationId: input.conversationId });
      }
      return { complete: true, reconciled };
    }
    if (seenCursors.has(remote.data.nextCursor)) {
      return {
        complete: false,
        error: { code: "INVALID_RESPONSE", message: "助手返回了重复的会话游标" }
      };
    }
    seenCursors.add(remote.data.nextCursor);
    cursor = remote.data.nextCursor;
  }

  return {
    complete: false,
    error: { code: "SYNC_LIMIT_EXCEEDED", message: "会话历史超过同步安全上限" }
  };
}

export async function reconcilePendingConversations(input: {
  repo: ConversationMirrorRepository;
  assistantId: string;
  requestPage: (
    scope: { userId: string; assistantId: string; instanceId: string },
    conversationId: string,
    cursor: string | undefined,
    limit: number
  ) => Promise<RemoteConversationPage>;
  pageSize?: number;
  maxPages?: number;
}): Promise<void> {
  const pending = input.repo.listPendingReconciliations({ assistantId: input.assistantId });
  for (const item of pending) {
    const scope = {
      userId: item.userId,
      assistantId: item.assistantId,
      instanceId: item.instanceId
    };
    try {
      await syncConversationDetail({
        repo: input.repo,
        conversationId: item.conversationId,
        ...scope,
        requestPage: (cursor, limit) =>
          input.requestPage(scope, item.conversationId, cursor, limit),
        pageSize: input.pageSize,
        maxPages: input.maxPages
      });
    } catch (error) {
      input.repo.recordReconciliationError({
        ...scope,
        conversationId: item.conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
