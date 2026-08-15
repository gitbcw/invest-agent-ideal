"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { nanoid } from "nanoid";
import { Folder, FolderOpen } from "lucide-react";

import { Sidebar } from "./Sidebar";
import { MessageComposer, type ComposerAttachment } from "./MessageComposer";
import { MessageBubble } from "./MessageBubble";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { ImageLightbox } from "./ImageLightbox";
import { ChangePasswordModal } from "./ChangePasswordModal";
import {
  consumeConversationAnimation,
  EMPTY_CONVERSATION_VIEW,
  updateConversationViewRecord,
  type ConversationViewState
} from "./conversation-view-state";
import {
  fetchAssistantStatus,
  fetchConversation,
  fetchConversations,
  fetchConversationLabels,
  createConversationLabel,
  updateConversationLabel,
  deleteConversationLabel,
  fetchCurrentUser,
  fetchWorkspaceFiles,
  cancelConversation,
  deleteConversation,
  logout as apiLogout,
  publishLegacyArtifact,
  recordArtifactEvent,
  sendMessage,
  saveArtifactToAssets,
  updateConversation,
  PortalApiError,
  type AssistantStatus
} from "./api";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  conversationNavigationUrl,
  hasTerminalReplyAfterLatestUser,
  isReasonableProcessingMarker,
  resolveConversationProcessing,
  resolveConversationNavigation
} from "./conversation-navigation";
import { toView, type ArtifactCardView, type ChatMessageView, type ConversationListItem } from "./types";
import type { WorkspaceFileItem } from "@/lib/protocol";
import { MODEL_OPTIONS } from "@/lib/models";

interface ChatShellProps {
  initialUser: {
    id: string;
    username: string;
    role: "user" | "admin";
    assistantId: string;
    instanceId: string;
  };
}

export function ChatShell({ initialUser }: ChatShellProps) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [labels, setLabels] = useState<Array<{ label_id: string; name: string; position: number }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversationViews, setConversationViews] = useState<Record<string, ConversationViewState>>({});
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [hasNextConversations, setHasNextConversations] = useState(false);
  const [processingConversations, setProcessingConversations] = useState<Record<string, boolean>>({});
  const [stoppingConversations, setStoppingConversations] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeArtifact, setActiveArtifact] = useState<ArtifactCardView | null>(null);
  const [artifactLightbox, setArtifactLightbox] = useState<ArtifactCardView | null>(null);
  const [artifactPanelClosed, setArtifactPanelClosed] = useState(true);
  const [revealTreeNonce, setRevealTreeNonce] = useState(0);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  // Attachment opened from a message card via attachment.get → image Lightbox.
  const [attachmentLightbox, setAttachmentLightbox] = useState<{ attachmentId: string; title: string } | null>(null);
  // 按回合模型选择（D25）：空字符串 = 服务端默认模型。
  const [selectedModel, setSelectedModel] = useState<string>("");
  // Historical artifact cards still accept a deleted-id set, but the current
  // read-only Portal never mutates it.
  const deletedArtifactIds = useMemo(() => new Set<string>(), []);
  const cursorRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const processingConversationsRef = useRef<Record<string, boolean>>({});
  const navigationInitializedRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const conversationViewsRef = useRef<Record<string, ConversationViewState>>({});

  const updateConversationView = useCallback((
    conversationId: string,
    update: (current: ConversationViewState) => ConversationViewState
  ) => {
    setConversationViews((current) => {
      const next = updateConversationViewRecord(current, conversationId, update);
      conversationViewsRef.current = next;
      return next;
    });
  }, []);

  const setConversationProcessing = useCallback((conversationId: string, processing: boolean) => {
    setProcessingConversations((current) => {
      if (processing === Boolean(current[conversationId])) {
        processingConversationsRef.current = current;
        return current;
      }
      const next = { ...current };
      if (processing) next[conversationId] = true;
      else delete next[conversationId];
      processingConversationsRef.current = next;
      return next;
    });
  }, []);

  const syncConversationNavigation = useCallback((conversationId: string | null) => {
    const nextUrl = conversationNavigationUrl(window.location.href, conversationId);
    window.history.replaceState(window.history.state, "", nextUrl);
    try {
      if (conversationId) window.sessionStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
      else window.sessionStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    } catch {
      // Private browsing or blocked storage must not prevent chat navigation.
    }
  }, []);

  const readProcessingStartedAt = useCallback((conversationId: string): number | null => {
    try {
      const key = `${ACTIVE_CONVERSATION_STORAGE_KEY}:startedAt:${conversationId}`;
      const value = window.sessionStorage.getItem(key);
      if (!value) return null;
      const timestamp = Number(value);
      if (isReasonableProcessingMarker(timestamp)) return timestamp;
      window.sessionStorage.removeItem(key);
      return null;
    } catch {
      return null;
    }
  }, []);

  const writeProcessingStartedAt = useCallback((conversationId: string, startedAt: number | null) => {
    try {
      const key = `${ACTIVE_CONVERSATION_STORAGE_KEY}:startedAt:${conversationId}`;
      if (startedAt === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, String(startedAt));
    } catch {
      // Private browsing or blocked storage must not prevent chat navigation.
    }
  }, []);

  const activeView = activeId ? conversationViews[activeId] ?? EMPTY_CONVERSATION_VIEW : EMPTY_CONVERSATION_VIEW;
  const messages = activeView.messages;
  const loadingMessages = activeView.loading;
  const waiting = activeView.waiting || Boolean(activeId && processingConversations[activeId]);
  const waitingStartedAt = activeView.waitingStartedAt;
  const animatingAssistantMessageId = activeView.animatingAssistantMessageId;

  const clampRightPanelWidth = useCallback((requested: number) => {
    const sidebarWidth = collapsed ? 72 : 224;
    const available = Math.max(0, window.innerWidth - sidebarWidth);
    return Math.max(360, Math.min(requested, available * 0.6, available - 480));
  }, [collapsed]);

  useEffect(() => {
    if (rightPanelWidth !== null) return;
    setRightPanelWidth(clampRightPanelWidth(Number.POSITIVE_INFINITY));
  }, [clampRightPanelWidth, collapsed, rightPanelWidth]);

  useEffect(() => {
    const onResize = () => setRightPanelWidth((width) => width === null ? null : clampRightPanelWidth(width));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampRightPanelWidth]);

  const handleDividerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (moveEvent: PointerEvent) => setRightPanelWidth(clampRightPanelWidth(window.innerWidth - moveEvent.clientX));
    const finish = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
  }, [clampRightPanelWidth]);

  const handleDividerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rightPanelWidth === null) return;
    const step = event.shiftKey ? 48 : 16;
    let next = rightPanelWidth;
    if (event.key === "ArrowLeft") next += step;
    else if (event.key === "ArrowRight") next -= step;
    else if (event.key === "Home") next = 360;
    else if (event.key === "End") next = window.innerWidth;
    else return;
    event.preventDefault();
    setRightPanelWidth(clampRightPanelWidth(next));
  }, [clampRightPanelWidth, rightPanelWidth]);

  // ---- 初始化:加载会话列表 + 助手状态 ----
  const refreshStatus = useCallback(async () => {
    const s = await fetchAssistantStatus();
    setStatus(s);
    return s;
  }, []);

  const ensureSessionMatchesPage = useCallback(async () => {
    const user = await fetchCurrentUser();
    if (!user) {
      window.location.assign("/login");
      return false;
    }
    const sameSession =
      user.id === initialUser.id &&
      user.assistantId === initialUser.assistantId &&
      user.instanceId === initialUser.instanceId;
    if (!sameSession || user.mustChangePassword) {
      window.location.reload();
      return false;
    }
    return true;
  }, [initialUser.assistantId, initialUser.id, initialUser.instanceId]);

  const refreshConversations = useCallback(async () => {
    setLoadingConversations(true);
    try {
      const res = await fetchConversations({ limit: 20, query: searchQuery, archived: false });
      setConversations(res.items);
      setHasNextConversations(Boolean(res.nextCursor));
      cursorRef.current = res.nextCursor;
    } catch (err) {
      setFatalError((err as Error).message);
    } finally {
      setLoadingConversations(false);
    }
  }, [searchQuery]);

  const refreshLabels = useCallback(async () => {
    try { setLabels(await fetchConversationLabels()); } catch (err) { setFatalError((err as Error).message); }
  }, []);

  useEffect(() => {
    void refreshConversations();
    void refreshLabels();
    void ensureSessionMatchesPage().then((ok) => {
      if (ok) void refreshStatus();
    });
    const id = window.setInterval(() => {
      void ensureSessionMatchesPage().then((ok) => {
        if (ok) void refreshStatus();
      });
    }, 15_000);
    return () => window.clearInterval(id);
  }, [ensureSessionMatchesPage, refreshConversations, refreshLabels, refreshStatus]);

  const handleCreateLabel = useCallback(async (name: string) => {
    try { await createConversationLabel(name); await refreshLabels(); } catch (err) { setFatalError((err as Error).message); }
  }, [refreshLabels]);

  const handleRenameLabel = useCallback(async (label: { label_id: string; name: string }, name: string) => {
    if (name === label.name) return;
    try { await updateConversationLabel(label.label_id, { name }); await refreshLabels(); } catch (err) { setFatalError((err as Error).message); }
  }, [refreshLabels]);

  const handleDeleteLabel = useCallback(async (label: { label_id: string; name: string }) => {
    if (!window.confirm(`删除标签“${label.name}”？对话会回到未分类。`)) return;
    try { await deleteConversationLabel(label.label_id); await Promise.all([refreshLabels(), refreshConversations()]); } catch (err) { setFatalError((err as Error).message); }
  }, [refreshConversations, refreshLabels]);

  const handleDropConversation = useCallback(async (conversation: ConversationListItem, labelId: string | null) => {
    try { await updateConversation(conversation.conversationId, { labelId }); await refreshConversations(); } catch (err) { setFatalError((err as Error).message); }
  }, [refreshConversations]);

  const handleDropConversationOrder = useCallback(async (conversation: ConversationListItem, target: ConversationListItem) => {
    if (conversation.labelId !== target.labelId) return;
    try { await updateConversation(conversation.conversationId, { labelId: conversation.labelId ?? null, position: target.position ?? 0 }); await refreshConversations(); } catch (err) { setFatalError((err as Error).message); }
  }, [refreshConversations]);

  // ---- 选择会话 / 加载消息 ----
  const loadConversation = useCallback(async (conversationId: string, showLoading = false): Promise<{ processing: boolean }> => {
    if (showLoading) {
      updateConversationView(conversationId, (current) => ({ ...current, loading: true }));
    }
    let conversationMissing = false;
    const wasProcessing = processingConversationsRef.current[conversationId] === true;
    const storedProcessingStartedAt = readProcessingStartedAt(conversationId);
    try {
      const data = await fetchConversation(conversationId);
      const locallyWaiting = conversationViewsRef.current[conversationId]?.waiting === true;
      // Server processing is authoritative. A browser marker can help recover
      // a request after a remount, but it must never resurrect a terminal turn.
      // An unresolved POST in this mounted shell remains authoritative too:
      // conversation sync may mark its user message sent before the assistant
      // response arrives, creating a temporary server-side false negative.
      const processing = resolveConversationProcessing(
        Boolean(data.processing),
        locallyWaiting,
        hasTerminalReplyAfterLatestUser(data.messages),
      );
      setConversationProcessing(conversationId, processing);
      if (!processing && storedProcessingStartedAt !== null) {
        writeProcessingStartedAt(conversationId, null);
      }
      if (!processing) {
        setStoppingConversations((current) => {
          if (!current[conversationId]) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      }
      const processingStartedAt = processing
        ? parseTimestamp(data.processingStartedAt)
          ?? latestUserTimestamp(data.messages)
          ?? storedProcessingStartedAt
          ?? Date.now()
        : null;
      updateConversationView(conversationId, (current) => ({
        ...current,
        waiting: processing ? current.waiting : false,
        messages: processing && current.waiting
          ? current.messages
          : withProcessingPlaceholder(conversationId, withProcessedDurations(data.messages.map(toView)), processing),
        waitingStartedAt: processing && current.waiting
          ? current.waitingStartedAt ?? processingStartedAt
          : processingStartedAt
      }));
      return { processing };
    } catch (err) {
      if (err instanceof PortalApiError && err.code === "NOT_FOUND") {
        conversationMissing = true;
        setConversationProcessing(conversationId, false);
        setStoppingConversations((current) => {
          if (!current[conversationId]) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        writeProcessingStartedAt(conversationId, null);
        if (activeIdRef.current === conversationId) {
          activeIdRef.current = null;
          setActiveId(null);
          syncConversationNavigation(null);
          setActiveArtifact(null);
          setArtifactPanelClosed(true);
        }
        setConversationViews((current) => {
          const next = { ...current };
          delete next[conversationId];
          conversationViewsRef.current = next;
          return next;
        });
        void refreshConversations();
      } else {
        setFatalError((err as Error).message);
      }
      return { processing: wasProcessing };
    } finally {
      if (showLoading && !conversationMissing) {
        updateConversationView(conversationId, (current) => ({ ...current, loading: false }));
      }
    }
  }, [readProcessingStartedAt, refreshConversations, setConversationProcessing, syncConversationNavigation, updateConversationView, writeProcessingStartedAt]);

  const selectConversation = useCallback(async (conversationId: string) => {
    setFatalError(null);
    activeIdRef.current = conversationId;
    setActiveId(conversationId);
    syncConversationNavigation(conversationId);
    updateConversationView(conversationId, consumeConversationAnimation);
    setActiveArtifact(null);
    setArtifactPanelClosed(true);
    if (conversationViewsRef.current[conversationId]?.waiting) return;
    await loadConversation(conversationId, true);
  }, [loadConversation, syncConversationNavigation, updateConversationView]);

  // A processing conversation is authoritative on the server. Poll only the
  // active conversation and schedule the next request after the previous one
  // completes, so a slow response cannot create overlapping fetches.
  useEffect(() => {
    const conversationId = activeId;
    const localWaiting = conversationId
      ? conversationViewsRef.current[conversationId]?.waiting === true
      : false;
    if (!conversationId || (!processingConversations[conversationId] && !localWaiting)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const result = await loadConversation(conversationId);
      const stillWaiting = conversationViewsRef.current[conversationId]?.waiting === true;
      if (!cancelled && (result.processing || stillWaiting)) timer = window.setTimeout(() => void poll(), 1_000);
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeId, loadConversation, processingConversations]);

  // URL selection wins over sessionStorage. `new=1` is an explicit reset and
  // must clear both recovery sources before the blank chat is shown.
  useEffect(() => {
    if (navigationInitializedRef.current) return;
    navigationInitializedRef.current = true;
    let storedConversationId: string | null = null;
    try {
      storedConversationId = window.sessionStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    } catch {
      storedConversationId = null;
    }
    const navigation = resolveConversationNavigation(window.location.href, storedConversationId);
    if (navigation.isNew) {
      activeIdRef.current = null;
      setActiveId(null);
      syncConversationNavigation(null);
      return;
    }
    if (navigation.conversationId) void selectConversation(navigation.conversationId);
  }, [selectConversation, syncConversationNavigation]);

  const handleNewConversation = useCallback(() => {
    setFatalError(null);
    if (activeId) writeProcessingStartedAt(activeId, null);
    activeIdRef.current = null;
    setActiveId(null);
    setProcessingConversations({});
    processingConversationsRef.current = {};
    setStoppingConversations({});
    syncConversationNavigation(null);
    setActiveArtifact(null);
    setArtifactPanelClosed(true);
  }, [activeId, syncConversationNavigation, writeProcessingStartedAt]);

  const handleOpenArtifact = useCallback(async (artifact: ArtifactCardView) => {
    void recordArtifactEvent(artifact.artifactId, "open");
    if (artifact.previewMode === "image" || artifact.mimeType.startsWith("image/")) {
      setArtifactLightbox(artifact);
      return;
    }
    let resolvedArtifact = artifact;
    if (!artifact.workspacePath) {
      const workspaceFiles = await fetchWorkspaceFiles();
      if (workspaceFiles.ok) {
        const workspacePath = findUniqueWorkspacePath(artifact, workspaceFiles.data.items);
        if (workspacePath) resolvedArtifact = { ...artifact, workspacePath };
      }
    }
    setActiveArtifact(resolvedArtifact);
    setWorkspaceRefreshNonce((nonce) => nonce + 1);
    setArtifactPanelClosed(false);
  }, []);

  const handleSaveArtifact = useCallback(async (artifact: ArtifactCardView) => {
    const result = await saveArtifactToAssets(artifact.artifactId, artifact.title);
    if (result.ok) {
      setFatalError(null);
      return { ok: true };
    }
    return { ok: false, message: result.error };
  }, []);

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifact(null);
    setArtifactPanelClosed(true);
  }, []);

  const handleArtifactRequestConsumed = useCallback(() => {
    setActiveArtifact(null);
  }, []);

  const handleToggleArtifactPanel = useCallback(() => {
    setArtifactPanelClosed((prev) => {
      if (prev) {
        setRevealTreeNonce((nonce) => nonce + 1);
        setWorkspaceRefreshNonce((nonce) => nonce + 1);
      }
      return !prev;
    });
  }, []);

  // User clicked an active image attachment in a message → open the Lightbox.
  const handleAttachmentImageOpen = useCallback((attachmentId: string, title: string) => {
    setAttachmentLightbox({ attachmentId, title });
  }, []);

  // Restore scroll position when the panel collapses/expand toggles back open.

  // Resolve a legacy `/home/claude/.../reports/...` link to a first-class
  // artifact descriptor via the runtime's legacy publish path, then open the
  // same viewer used for first-class artifacts. Failure surfaces as a fatal
  // banner so the user can ask the assistant to regenerate the report.
  const handleArtifactLegacyPath = useCallback(
    async (relativePath: string, messageId: string, conversationId: string) => {
      const outcome = await publishLegacyArtifact(relativePath, conversationId);
      if (!outcome.ok) {
        setFatalError(
          outcome.code === "ARTIFACT_NOT_FOUND"
            ? "报告文件不存在或已过期,请让助手重新生成。"
            : outcome.code === "ARTIFACT_SCOPE_MISMATCH"
              ? "无权访问该报告。"
              : outcome.code === "ARTIFACT_UNSAFE"
                ? "报告未通过安全校验,无法预览。"
                : `无法打开报告: ${outcome.message}`
        );
        return;
      }
      const descriptor = outcome.descriptor;
      const cardView: ArtifactCardView = {
        artifactId: descriptor.artifactId,
        title: descriptor.title,
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
        kind: descriptor.kind,
        previewMode: descriptor.previewMode,
        createdAt: descriptor.createdAt,
        checksum: descriptor.checksum,
        messageId,
        conversationId,
        workspacePath: relativePath
      };
      void handleOpenArtifact(cardView);
    },
    [handleOpenArtifact]
  );

  // ---- 发送消息 ----
  const handleSend = useCallback(
    async (text: string, attachments: ComposerAttachment[] = []) => {
      const offline = status && !status.online;
      if (offline) return;
      const conversationId = activeId ?? `web_${nanoid(16)}`;
      const clientSentAt = new Date().toISOString();
      const processingStartedAt = Date.parse(clientSentAt);
      const displayText = text || attachmentOnlyText(attachments);
      const localUserMessage: ChatMessageView = {
        messageId: `local_${nanoid(8)}`,
        conversationId,
        role: "user",
        content: displayText,
        status: "pending",
        createdAt: clientSentAt,
        attachments: attachments.map((item) => ({
          type: item.kind === "image" ? "image" : "document",
          fileName: item.fileName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          previewUrl: item.previewUrl,
          source: "portal"
        })),
        isLocal: true
      };
      const localAssistantMessage: ChatMessageView = {
        messageId: `thinking_${nanoid(8)}`,
        conversationId,
        role: "assistant",
        content: "",
        status: "pending",
        createdAt: clientSentAt,
        isLocal: true
      };

      if (!activeId) {
        activeIdRef.current = conversationId;
        setActiveId(conversationId);
        syncConversationNavigation(conversationId);
        setConversations((current) => current.some((item) => item.conversationId === conversationId)
          ? current
          : [{
              conversationId,
              title: deriveLocalTitle(text, attachments),
              channel: "web",
              lastMessagePreview: displayText.slice(0, 80),
              messageCount: 1,
              createdAt: clientSentAt,
              updatedAt: clientSentAt
            }, ...current]);
      }
      updateConversationView(conversationId, (current) => ({
        ...current,
        messages: [...current.messages, localUserMessage, localAssistantMessage],
        waiting: true,
        waitingStartedAt: processingStartedAt,
        animatingAssistantMessageId: null
      }));
      setConversationProcessing(conversationId, true);
      writeProcessingStartedAt(conversationId, processingStartedAt);

      try {
        const result = await sendMessage(
          conversationId,
          {
            text,
            attachments: attachments.map(({ id: _id, previewUrl: _previewUrl, ...item }) => item),
            model: selectedModel || undefined
          },
          localUserMessage.messageId
        );
        const assistantView = result.ok && result.assistantMessage
          ? { ...toView(result.assistantMessage), processedDurationMs: Date.now() - Date.parse(clientSentAt) }
          : null;
        // 替换 user 消息为后端持久化版本
        updateConversationView(conversationId, (current) => {
          const next: ChatMessageView[] = current.messages.map((m) => {
            if (m.messageId === localUserMessage.messageId) {
              return {
                ...localUserMessage,
                messageId: result.userMessage?.messageId ?? localUserMessage.messageId,
                status: (result.ok ? "sent" : "failed") as ChatMessageView["status"],
                attachments: result.userMessage ? toView(result.userMessage).attachments ?? localUserMessage.attachments : localUserMessage.attachments
              };
            }
            if (m.messageId === localAssistantMessage.messageId && assistantView) {
              return assistantView;
            }
            if (m.messageId === localAssistantMessage.messageId && !result.ok) {
              return {
                messageId: `failed_${nanoid(8)}`,
                conversationId,
                role: "assistant",
                content: result.error?.message ?? "任务执行失败，请稍后重试。",
                status: "failed",
                createdAt: new Date().toISOString(),
                traceId: result.error?.code
              };
            }
            return m;
          });
          return {
            ...current,
            messages: next,
            animatingAssistantMessageId: assistantView?.messageId ?? null
          };
        });
        if (result.ok) {
          writeProcessingStartedAt(conversationId, null);
          setConversationProcessing(conversationId, false);
          setWorkspaceRefreshNonce((nonce) => nonce + 1);
        } else if (result.error?.code !== "TIMEOUT" && result.error?.code !== "CONNECTOR_OFFLINE") {
          writeProcessingStartedAt(conversationId, null);
          setConversationProcessing(conversationId, false);
        }

        setConversations((current) => {
          const exists = current.some((item) => item.conversationId === conversationId);
          const next = current.map((item) => item.conversationId === conversationId
            ? {
                ...item,
                lastMessagePreview: result.ok
                  ? result.assistantMessage?.content.slice(0, 80)
                  : result.error?.message ?? "助手回复失败",
                updatedAt: result.assistantMessage?.createdAt ?? new Date().toISOString(),
                messageCount: Math.max(item.messageCount, result.ok ? 2 : 1)
              }
            : item);
          if (exists || !result.ok) return next;
          return [{
            conversationId,
            title: deriveLocalTitle(text, attachments),
            channel: "web",
            lastMessagePreview: result.assistantMessage?.content.slice(0, 80),
            messageCount: 2,
            createdAt: clientSentAt,
            updatedAt: result.assistantMessage?.createdAt ?? clientSentAt
          }, ...next];
        });
      } catch (err) {
        writeProcessingStartedAt(conversationId, null);
        setConversationProcessing(conversationId, false);
        updateConversationView(conversationId, (current) => ({
          ...current,
          messages: current.messages.map((m) => {
            if (m.messageId === localUserMessage.messageId) {
              return { ...m, status: "failed" as const };
            }
            if (m.messageId === localAssistantMessage.messageId) {
              return {
                messageId: `failed_${nanoid(8)}`,
                conversationId,
                role: "assistant" as const,
                content: (err as Error).message || "任务执行失败，请稍后重试。",
                status: "failed" as const,
                createdAt: new Date().toISOString()
              };
            }
            return m;
          })
        }));
        setFatalError((err as Error).message);
      } finally {
        setStoppingConversations((current) => {
          if (!current[conversationId]) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        updateConversationView(conversationId, (current) => ({
          ...current,
          waiting: false,
          waitingStartedAt: null
        }));
      }
    },
    [activeId, selectedModel, setConversationProcessing, status, syncConversationNavigation, updateConversationView, writeProcessingStartedAt]
  );

  const handleCancelConversation = useCallback(async () => {
    const conversationId = activeIdRef.current ?? activeId;
    if (!conversationId || stoppingConversations[conversationId]) return;
    setStoppingConversations((current) => ({ ...current, [conversationId]: true }));
    setFatalError(null);
    try {
      // Do not mutate the local transcript or processing flag here. The
      // connector's response and the following authenticated GET establish
      // whether cancellation actually reached the active turn.
      await cancelConversation(conversationId);
      await loadConversation(conversationId);
    } catch (err) {
      setStoppingConversations((current) => {
        if (!current[conversationId]) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      setFatalError((err as Error).message || "停止处理失败");
      // Let the composer clear its local cancelling state as well. Keeping the
      // error local here would leave the control spinning after a rejected
      // cancellation request.
      throw err;
    }
  }, [activeId, loadConversation, stoppingConversations]);

  // ---- 重试 ----
  const handleRetry = useCallback(
    (failedAssistantMessage: ChatMessageView) => {
      // 找到它前一条 user 消息重新发送
      const idx = messages.findIndex((m) => m.messageId === failedAssistantMessage.messageId);
      if (idx <= 0) return;
      // 向前找一条 user 消息
      let userText: string | null = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userText = messages[i].content;
          break;
        }
      }
      if (!userText) return;
      // 删掉 failed assistant 消息
      if (!activeId) return;
      updateConversationView(activeId, (current) => ({
        ...current,
        messages: current.messages.filter((m) => m.messageId !== failedAssistantMessage.messageId)
      }));
      void handleSend(userText);
    },
    [activeId, messages, handleSend, updateConversationView]
  );

  // ---- 加载更多会话 ----
  const handleLoadMore = useCallback(async () => {
    if (!cursorRef.current) return;
    try {
      const res = await fetchConversations({ limit: 20, cursor: cursorRef.current, query: searchQuery, archived: false });
      setConversations((prev) => [...prev, ...res.items]);
      cursorRef.current = res.nextCursor;
      setHasNextConversations(Boolean(res.nextCursor));
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [searchQuery]);

  const handleRenameConversation = useCallback(async (conversation: ConversationListItem, nextTitle: string) => {
    if (!nextTitle || nextTitle === conversation.title) return;
    try {
      await updateConversation(conversation.conversationId, { title: nextTitle });
      await refreshConversations();
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [refreshConversations]);

  const handlePinConversation = useCallback(async (conversation: ConversationListItem) => {
    try {
      await updateConversation(conversation.conversationId, { pinned: !conversation.pinnedAt });
      await refreshConversations();
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [refreshConversations]);

  const handleArchiveConversation = useCallback(async (conversation: ConversationListItem) => {
    try {
      await updateConversation(conversation.conversationId, { archived: true });
      if (activeId === conversation.conversationId) handleNewConversation();
      await refreshConversations();
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [activeId, handleNewConversation, refreshConversations]);

  const handleDeleteConversation = useCallback(async (conversation: ConversationListItem) => {
    const confirmed = window.confirm(`确认删除“${conversation.title || "新的对话"}”？删除后将不会在门户中显示。`);
    if (!confirmed) return;
    try {
      await deleteConversation(conversation.conversationId);
      if (activeId === conversation.conversationId) {
        handleNewConversation();
      }
      await refreshConversations();
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [activeId, handleNewConversation, refreshConversations]);

  // ---- 折叠 / 滚动到底部 ----
  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages.length, waiting]);

  const offline = Boolean(status && !status.online);
  const disabledReason = offline
    ? status?.mode === "mock"
      ? "Mock connector 已离线(请检查 mock 进程是否启动)"
      : "助手暂时离线,本地服务恢复后可继续。"
    : undefined;

  // Portal consumes workspace files through a read-only connector capability.
  // Browser-side file mutation capabilities are intentionally ignored.
  const capabilities = useMemo(
    () => ({
      workspaceFileList: hasCapability(status, "workspace.file.list"),
      attachmentGet: hasCapability(status, "attachment.get")
    }),
    [status]
  );

  // Keep an opened workspace mounted after its one-shot artifact request is
  // consumed. Otherwise a transient capability refresh could tear it down and
  // discard its tabs before the user explicitly closes the panel.
  const workspaceVisible = capabilities.workspaceFileList || !artifactPanelClosed || Boolean(activeArtifact);

  const offlineBanner = useMemo(
    () =>
      offline ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-700 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-300">
          助手暂时离线,可查看缓存历史,但无法发送消息。
        </div>
      ) : null,
    [offline]
  );

  return (
    <div className="flex h-screen bg-white text-[#202123]">
      <Sidebar
        conversations={conversations.map((conversation) => ({
          ...conversation,
          processing: Boolean(
            conversation.processing
              || processingConversations[conversation.conversationId]
              || conversationViews[conversation.conversationId]?.waiting
          )
        }))}
        activeId={activeId}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        loading={loadingConversations}
        hasNext={hasNextConversations}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onLoadMore={handleLoadMore}
        onSelect={(id) => void selectConversation(id)}
        onNewConversation={handleNewConversation}
        onRename={(conversation, name) => void handleRenameConversation(conversation, name)}
        onDelete={(conversation) => void handleDeleteConversation(conversation)}
        labels={labels}
        onCreateLabel={(name) => void handleCreateLabel(name)}
        onRenameLabel={(label, name) => void handleRenameLabel(label, name)}
        onDeleteLabel={(label) => void handleDeleteLabel(label)}
        onDropConversation={(conversation, labelId) => void handleDropConversation(conversation, labelId)}
        onDropConversationOrder={(conversation, target) => void handleDropConversationOrder(conversation, target)}
        username={initialUser.username}
        onOpenAutomations={() => window.location.assign("/automations")}
        onOpenPatrol={() => window.location.assign("/patrol")}
        onOpenAssets={() => window.location.assign("/assets")}
        onOpenManual={() => window.location.assign("/manual")}
        onChangePassword={() => setChangePasswordOpen(true)}
        onLogout={() => void apiLogout().then(() => window.location.assign("/login"))}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex h-14 items-center justify-between border-b border-black/10 bg-white px-3 sm:px-5">
        <div className="flex items-center">
          {status ? (
            <span
                className={`flex items-center gap-1.5 px-1 text-[11px] font-medium ${
                status.online
                    ? "text-emerald-700"
                    : "text-zinc-500"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status.online ? "bg-emerald-500" : "bg-zinc-400"}`} aria-hidden="true" />
              {status.online ? "在线" : "离线"}
            </span>
          ) : null}
          <select
            className="ml-2 h-8 shrink-0 cursor-pointer rounded-md border border-black/10 bg-[#f7f7f8] px-2 text-xs text-[#5f6368] outline-none transition hover:bg-black/5 focus:border-[#7a8d83] disabled:opacity-50"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={offline}
            aria-label="选择模型"
            title="选择模型（当前会话发送时生效）"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
          <div className="flex items-center gap-2">
            {capabilities.workspaceFileList ? (
              <button
                type="button"
                className={`flex h-9 w-9 items-center justify-center rounded-md transition ${artifactPanelClosed ? "text-[#6b7280] hover:bg-black/5 hover:text-[#202123]" : "bg-[#f1f5f3] text-[#202123]"}`}
                aria-label={artifactPanelClosed ? "打开工作空间" : "收起文档工作区"}
                title={artifactPanelClosed ? "打开工作空间" : "收起文档工作区"}
                onClick={handleToggleArtifactPanel}
              >
                {artifactPanelClosed ? <Folder size={18} aria-hidden="true" /> : <FolderOpen size={18} aria-hidden="true" />}
              </button>
            ) : null}
            <div className="hidden text-xs text-[#8e8ea0] sm:block">
              {initialUser.role === "admin" ? "管理员" : "用户"} · {initialUser.username}
            </div>
          </div>
      </div>
      {offlineBanner}
      {fatalError ? (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {fatalError}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setFatalError(null)}
          >
            知道了
          </button>
        </div>
      ) : null}
        <section className="flex min-h-0 flex-1 flex-col">
          <div ref={messagesRef} className="flex-1 overflow-y-auto scrollbar-thin">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 pb-6 pt-6 sm:px-6">
              {messages.length === 0 && !loadingMessages ? (
                <EmptyConversation offline={offline} />
              ) : null}
              {loadingMessages ? (
                <div className="py-12 text-center text-sm text-[#8e8ea0]">加载消息...</div>
              ) : null}
              <div className="space-y-1">
                {messages.map((message, idx) => {
                  const isLast =
                    idx === messages.length - 1 && message.role === "assistant";
                  const isWaiting =
                    isLast &&
                    waiting &&
                    (message.status === "pending" || message.content === "");
                  return (
                      <MessageBubble
                      key={message.messageId}
                      message={message}
                      isLastAssistant={isLast && message.role === "assistant"}
                      shouldAnimate={message.messageId === animatingAssistantMessageId}
                      isWaiting={Boolean(isWaiting)}
                      waitingStartedAt={waitingStartedAt}
                      onRetry={handleRetry}
                        onArtifactOpen={handleOpenArtifact}
                        onArtifactSave={handleSaveArtifact}
                      onArtifactLegacyPath={handleArtifactLegacyPath}
                      attachmentGetEnabled={capabilities.attachmentGet}
                      onAttachmentImageOpen={handleAttachmentImageOpen}
                      deletedArtifactIds={deletedArtifactIds}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <MessageComposer
            key={activeId ?? "new-conversation"}
            disabled={offline}
            disabledReason={disabledReason ?? (waiting ? "正在等待助手回复..." : undefined)}
            processing={waiting}
            stopping={Boolean(activeId && stoppingConversations[activeId])}
            onSend={handleSend}
            onCancel={handleCancelConversation}
          />
        </section>
      </main>
      {workspaceVisible ? (
        <>
          {!artifactPanelClosed ? (
            <div
              className="group relative hidden w-2 shrink-0 cursor-col-resize touch-none lg:block"
              role="separator"
              tabIndex={0}
              aria-label="调整文档工作区宽度"
              aria-orientation="vertical"
              aria-valuemin={360}
              aria-valuemax={1200}
              aria-valuenow={Math.round(rightPanelWidth ?? 360)}
              onPointerDown={handleDividerPointerDown}
              onKeyDown={handleDividerKeyDown}
            >
              <div className="absolute inset-y-0 left-1/2 w-px bg-black/10 group-hover:bg-black/30 group-focus:bg-black/40" />
            </div>
          ) : null}
          {/* Keep the workspace mounted even when collapsed so loaded previews,
              object URLs, open tabs and scroll positions are preserved. The
              workspace sets `hidden` on its root when collapsed, so the wrapper
              stays w-0 / invisible without tearing down the component. */}
          <div
            className={`fixed inset-0 z-40 w-full overflow-hidden bg-white lg:static lg:z-auto lg:shrink-0 lg:transition-[width] lg:duration-200 lg:ease-out ${artifactPanelClosed ? "hidden lg:block lg:w-0" : "block lg:w-[var(--workspace-width)]"}`}
            style={artifactPanelClosed ? undefined : ({ "--workspace-width": `${rightPanelWidth ?? 560}px` } as CSSProperties)}
            aria-hidden={artifactPanelClosed ? "true" : undefined}
          >
            <DocumentWorkspace
              activeRequest={activeArtifact ? { view: activeArtifact } : null}
              onRequestConsumed={handleArtifactRequestConsumed}
              onClose={handleCloseArtifact}
              onCollapse={handleToggleArtifactPanel}
              collapsed={artifactPanelClosed}
              revealTreeNonce={revealTreeNonce}
              refreshNonce={workspaceRefreshNonce}
              capabilities={capabilities}
            />
          </div>
        </>
      ) : null}
      {attachmentLightbox ? (
        <ImageLightbox
          attachmentId={attachmentLightbox.attachmentId}
          title={attachmentLightbox.title}
          onClose={() => setAttachmentLightbox(null)}
        />
      ) : null}
      {artifactLightbox ? (
        <ImageLightbox
          artifactId={artifactLightbox.artifactId}
          title={artifactLightbox.title}
          onClose={() => setArtifactLightbox(null)}
        />
      ) : null}
      <ChangePasswordModal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
      />
    </div>
  );
}

function attachmentOnlyText(attachments: ComposerAttachment[]) {
  const imageCount = attachments.filter((item) => item.kind === "image").length;
  const documentCount = attachments.length - imageCount;
  if (imageCount > 0 && documentCount > 0) return `上传了 ${imageCount} 张图片和 ${documentCount} 份文档`;
  if (imageCount > 0) return `上传了 ${imageCount} 张图片`;
  if (documentCount > 0) return `上传了 ${documentCount} 份文档`;
  return "";
}

function deriveLocalTitle(text: string, attachments: ComposerAttachment[]) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, 24);
  return attachmentOnlyText(attachments) || "新的对话";
}

function withProcessedDurations(messages: ChatMessageView[]): ChatMessageView[] {
  let lastUserCreatedAt: number | null = null;
  return messages.map((message) => {
    if (message.role === "user") {
      const timestamp = Date.parse(message.createdAt);
      lastUserCreatedAt = Number.isFinite(timestamp) ? timestamp : null;
      return message;
    }
    if (message.role !== "assistant" || message.status !== "sent" || lastUserCreatedAt === null) return message;
    const completedAt = Date.parse(message.createdAt);
    if (!Number.isFinite(completedAt) || completedAt < lastUserCreatedAt) return message;
    return { ...message, processedDurationMs: completedAt - lastUserCreatedAt };
  });
}

function withProcessingPlaceholder(
  conversationId: string,
  messages: ChatMessageView[],
  processing: boolean
): ChatMessageView[] {
  if (!processing) return messages;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && (last.status === "pending" || last.content === "")) {
    return messages;
  }
  return [
    ...messages,
    {
      messageId: `restored-thinking-${conversationId}`,
      conversationId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: last?.createdAt ?? new Date().toISOString(),
      isLocal: true
    }
  ];
}

function latestUserTimestamp(messages: Array<{ role: string; createdAt: string }>): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const timestamp = Date.parse(messages[index].createdAt);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findUniqueWorkspacePath(artifact: ArtifactCardView, files: WorkspaceFileItem[]): string | undefined {
  const exactMatches = files.filter((file) =>
    file.fileName === artifact.fileName &&
    file.mimeType === artifact.mimeType &&
    file.sizeBytes === artifact.sizeBytes
  );
  if (exactMatches.length === 1) return exactMatches[0].relativePath;
  const sameNameAndType = files.filter((file) =>
    file.fileName === artifact.fileName && file.mimeType === artifact.mimeType
  );
  return sameNameAndType.length === 1 ? sameNameAndType[0].relativePath : undefined;
}

function EmptyConversation({ offline }: { offline: boolean }) {
  return (
    <div className="mx-auto flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <img src="/brand/lance-brand-mark-v4.svg" alt="澜策" className="h-14 w-14" />
      <h1 className="mt-5 text-xl font-semibold tracking-normal text-[#303632]">
        今天想研究什么？
      </h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-[#616862]">
        {offline
          ? "助手暂时离线。可先查看左侧历史,等本地服务恢复后再发送。"
          : "你可以直接问持仓、复盘、选股或提醒相关问题。"}
      </p>
    </div>
  );
}

/**
 * Capability gate. The assistant status carries the connector's advertised
 * capability list; a feature is enabled only when the capability is present
 * AND the connector is online. Used to safely degrade the file tree,
 * attachment preview and delete flows when an older or offline runtime is
 * connected.
 */
function hasCapability(
  status: AssistantStatus | null,
  cap: string
): boolean {
  if (!status || !status.online) return false;
  return Array.isArray(status.capabilities) && status.capabilities.includes(cap);
}
