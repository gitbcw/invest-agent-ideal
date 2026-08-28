import type { ChatMessageView } from "./types";

export interface ConversationViewState {
  messages: ChatMessageView[];
  loading: boolean;
  waiting: boolean;
  waitingStartedAt: number | null;
  animatingAssistantMessageId: string | null;
  /** 更早一页消息的入口；null 表示已加载到最早或未加载。 */
  beforeCursor: string | null;
  loadingEarlier: boolean;
}

export const EMPTY_CONVERSATION_VIEW: ConversationViewState = {
  messages: [],
  loading: false,
  waiting: false,
  waitingStartedAt: null,
  animatingAssistantMessageId: null,
  beforeCursor: null,
  loadingEarlier: false
};

export function updateConversationViewRecord(
  current: Record<string, ConversationViewState>,
  conversationId: string,
  update: (view: ConversationViewState) => ConversationViewState
): Record<string, ConversationViewState> {
  return {
    ...current,
    [conversationId]: update(current[conversationId] ?? EMPTY_CONVERSATION_VIEW)
  };
}

export function consumeConversationAnimation(view: ConversationViewState): ConversationViewState {
  return view.animatingAssistantMessageId === null
    ? view
    : { ...view, animatingAssistantMessageId: null };
}
