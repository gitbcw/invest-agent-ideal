"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Sidebar } from "@/components/chat/Sidebar";
import {
  createConversationLabel,
  deleteConversation,
  deleteConversationLabel,
  fetchConversationLabels,
  fetchConversations,
  fetchCurrentUser,
  logout,
  updateConversation,
  updateConversationLabel,
} from "@/components/chat/api";
import type { ConversationLabelView } from "@/components/chat/Sidebar";
import type { ConversationListItem } from "@/components/chat/types";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  conversationNavigationUrl
} from "@/components/chat/conversation-navigation";

type PortalSection = "automations" | "assets";

// Reuse the chat page's actual sidebar, including its conversation list and
// account actions, rather than maintaining a second navigation implementation.
export function PortalSidebar({ active }: { active: PortalSection }) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [labels, setLabels] = useState<ConversationLabelView[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasNext, setHasNext] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [username, setUsername] = useState("用户");
  const cursorRef = useRef<string | null>(null);

  const refreshConversations = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchConversations({ limit: 20, query: searchQuery, archived: false });
      setConversations(result.items);
      setHasNext(Boolean(result.nextCursor));
      cursorRef.current = result.nextCursor;
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  const refreshLabels = useCallback(async () => {
    setLabels(await fetchConversationLabels());
  }, []);

  useEffect(() => {
    void refreshConversations().catch(() => undefined);
  }, [refreshConversations]);

  useEffect(() => {
    void refreshLabels().catch(() => undefined);
    void fetchCurrentUser().then((user) => setUsername(user?.username || "用户")).catch(() => undefined);
  }, [refreshLabels]);

  const navigateToConversation = useCallback((conversationId: string) => {
    const href = conversationNavigationUrl(`${window.location.origin}/chat`, conversationId);
    try {
      window.sessionStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
    } catch {
      // ChatShell still receives the URL selection when storage is unavailable.
    }
    window.location.assign(href);
  }, []);

  const navigateToNewConversation = useCallback(() => {
    try {
      window.sessionStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    } catch {
      // Explicit `new=1` is also consumed by ChatShell when storage is blocked.
    }
    window.location.assign("/chat?new=1");
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursorRef.current) return;
    const result = await fetchConversations({ limit: 20, cursor: cursorRef.current, query: searchQuery, archived: false });
    setConversations((current) => [...current, ...result.items]);
    setHasNext(Boolean(result.nextCursor));
    cursorRef.current = result.nextCursor;
  }, [searchQuery]);

  const renameConversation = useCallback(async (conversation: ConversationListItem, title: string) => {
    if (!title || title === conversation.title) return;
    await updateConversation(conversation.conversationId, { title });
    await refreshConversations();
  }, [refreshConversations]);

  const removeConversation = useCallback(async (conversation: ConversationListItem) => {
    if (!window.confirm(`确认删除“${conversation.title || "新的对话"}”？删除后将不会在门户中显示。`)) return;
    await deleteConversation(conversation.conversationId);
    await refreshConversations();
  }, [refreshConversations]);

  return <Sidebar
    conversations={conversations}
    activeId={null}
    activeDestination={active}
    collapsed={collapsed}
    onToggleCollapsed={() => setCollapsed((value) => !value)}
    loading={loading}
    hasNext={hasNext}
    searchQuery={searchQuery}
    onSearchChange={setSearchQuery}
    onLoadMore={() => void loadMore().catch(() => undefined)}
    onSelect={navigateToConversation}
    onNewConversation={navigateToNewConversation}
    onRename={(conversation, title) => void renameConversation(conversation, title).catch(() => undefined)}
    onDelete={(conversation) => void removeConversation(conversation).catch(() => undefined)}
    labels={labels}
    onCreateLabel={(name) => void createConversationLabel(name).then(refreshLabels).catch(() => undefined)}
    onRenameLabel={(label, name) => void updateConversationLabel(label.label_id, { name }).then(refreshLabels).catch(() => undefined)}
    onDeleteLabel={(label) => {
      if (!window.confirm(`删除标签“${label.name}”？对话会回到未分类。`)) return;
      void deleteConversationLabel(label.label_id).then(() => Promise.all([refreshLabels(), refreshConversations()])).catch(() => undefined);
    }}
    onDropConversation={(conversation, labelId) => void updateConversation(conversation.conversationId, { labelId }).then(refreshConversations).catch(() => undefined)}
    onDropConversationOrder={(conversation, target) => {
      if (conversation.labelId !== target.labelId) return;
      void updateConversation(conversation.conversationId, { labelId: conversation.labelId ?? null, position: target.position ?? 0 }).then(refreshConversations).catch(() => undefined);
    }}
    username={username}
    onOpenAutomations={() => window.location.assign("/automations")}
    onOpenAssets={() => window.location.assign("/assets")}
    onOpenManual={() => window.location.assign("/manual")}
    onChangePassword={() => window.location.assign("/change-password")}
    onLogout={() => void logout().then(() => window.location.assign("/login"))}
  />;
}
