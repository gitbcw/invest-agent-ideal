export const ACTIVE_CONVERSATION_STORAGE_KEY = "invest-agent.portal.activeConversationId";

// A browser marker is only a recovery hint for an in-flight POST. It must not
// keep a terminal server conversation in a processing state indefinitely.
export const PROCESSING_MARKER_MAX_AGE_MS = 30 * 60 * 1000;

export function isReasonableProcessingMarker(
  startedAt: number,
  now = Date.now()
): boolean {
  return Number.isFinite(startedAt)
    && Number.isFinite(now)
    && startedAt > 0
    && startedAt <= now
    && now - startedAt <= PROCESSING_MARKER_MAX_AGE_MS;
}

export function resolveConversationProcessing(
  serverProcessing: boolean,
  localRequestPending: boolean,
  serverHasTerminalReply = false
): boolean {
  return serverProcessing || (localRequestPending && !serverHasTerminalReply);
}

export function hasTerminalReplyAfterLatestUser(
  messages: Array<{ role: string; status: string }>
): boolean {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    latestUserIndex = index;
    break;
  }
  if (latestUserIndex < 0) return false;
  return messages.slice(latestUserIndex + 1).some((message) =>
    message.role === "assistant" && (message.status === "sent" || message.status === "failed")
  );
}

export interface ConversationNavigationState {
  conversationId: string | null;
  isNew: boolean;
}

function cleanConversationId(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}

/** Resolve an initial chat selection without mutating the URL or storage. */
export function resolveConversationNavigation(
  href: string,
  storedConversationId?: string | null
): ConversationNavigationState {
  const url = new URL(href);
  if (url.searchParams.get("new") === "1") {
    return { conversationId: null, isNew: true };
  }
  return {
    conversationId: cleanConversationId(url.searchParams.get("conversationId"))
      ?? cleanConversationId(storedConversationId),
    isNew: false
  };
}

/** Build a same-page URL for a stable active conversation selection. */
export function conversationNavigationUrl(href: string, conversationId: string | null): string {
  const url = new URL(href);
  url.searchParams.delete("new");
  const cleaned = cleanConversationId(conversationId);
  if (cleaned) url.searchParams.set("conversationId", cleaned);
  else url.searchParams.delete("conversationId");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function consumeConversationId(href: string): {
  conversationId: string;
  nextUrl: string;
} | null {
  const url = new URL(href);
  const conversationId = url.searchParams.get("conversationId")?.trim();
  if (!conversationId) return null;

  url.searchParams.delete("conversationId");
  return {
    conversationId,
    nextUrl: `${url.pathname}${url.search}${url.hash}`
  };
}
