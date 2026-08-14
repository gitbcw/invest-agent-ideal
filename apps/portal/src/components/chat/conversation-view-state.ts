import type { ChatMessageView } from "./types";

export interface ConversationViewState {
  messages: ChatMessageView[];
  loading: boolean;
  waiting: boolean;
  waitingStartedAt: number | null;
  animatingAssistantMessageId: string | null;
}

export const EMPTY_CONVERSATION_VIEW: ConversationViewState = {
  messages: [],
  loading: false,
  waiting: false,
  waitingStartedAt: null,
  animatingAssistantMessageId: null
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
