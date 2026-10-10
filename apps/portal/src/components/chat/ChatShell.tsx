"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Fragment } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { nanoid } from "nanoid";

import { Sidebar } from "./Sidebar";
import { MessageComposer, type ComposerAttachment, type ComposerSendResult } from "./MessageComposer";
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
  fetchConversationMessagesBefore,
  fetchConversations,
  fetchConversationLabels,
  createConversationLabel,
  updateConversationLabel,
  deleteConversationLabel,
  fetchCurrentUser,
  cancelConversation,
  deleteConversation,
  logout as apiLogout,
  publishLegacyArtifact,
  recordArtifactEvent,
  sendMessage,
  regenerateMessage,
  sendFeedback,
  subscribeConversationProgress,
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
import { toView, type ArtifactCardView, type ChatMessageView, type ConversationListItem, type WorkStepView } from "./types";
import { useAppNavigate } from "../../lib/app-navigation";
import { DEFAULT_MODEL_VALUE } from "@/lib/models";

interface ChatShellProps {
  initialUser: {
    id: string;
    username: string;
    role: "user" | "admin";
    assistantId: string;
    instanceId: string;
  };
}

function buildComposerDraftKey(user: ChatShellProps["initialUser"], conversationId: string | null) {
  return [user.instanceId, user.id, user.assistantId, conversationId ?? "new-conversation"].join(":");
}

export function ChatShell({ initialUser }: ChatShellProps) {
  const appNavigate = useAppNavigate();
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
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
  // T-448: the search box is typed into; a request per keystroke (plus the
  // effect re-run below rebuilding the 15s interval) made list typing janky.
  // Queries run against the debounced value only.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeArtifact, setActiveArtifact] = useState<ArtifactCardView | null>(null);
  const [artifactLightbox, setArtifactLightbox] = useState<ArtifactCardView | null>(null);
  const [artifactPanelClosed, setArtifactPanelClosed] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  // Attachment opened from a message card via attachment.get → image Lightbox.
  const [attachmentLightbox, setAttachmentLightbox] = useState<{ attachmentId: string; title: string } | null>(null);
  // 按回合模型选择（D25）：GPT-5.6 Terra/Luna 临时禁用（owner 2026-10-04），默认自动路由。
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_VALUE);
  // Historical artifact cards still accept a deleted-id set, but the current
  // read-only Portal never mutates it.
  const deletedArtifactIds = useMemo(() => new Set<string>(), []);
  const cursorRef = useRef<string | null>(null);
  // T-199：当前等待轮的实时工作过程事件（按 conversationId 分组，尽力而为）。
  const [liveSteps, setLiveSteps] = useState<Record<string, WorkStepView[]>>({});
  // 引导式新建技能：开场白确定，本地渲染不调模型。
  const [guidedStart, setGuidedStart] = useState<string | null>(null);
  const [guidedPrompt, setGuidedPrompt] = useState<string | null>(null);
  const [guidedAutoSend, setGuidedAutoSend] = useState<string | null>(null);
  // 待处理「AI分析」进入的既有会话：选中并加载完成后自动发送一次分析请求。
  const [pendingAttentionAutosend, setPendingAttentionAutosend] = useState<string | null>(null);
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

  const guidedView = guidedStart && !activeId
    ? {
        ...EMPTY_CONVERSATION_VIEW,
        messages: [
          {
            messageId: "guided_opening",
            conversationId: "guided",
            role: "assistant" as const,
            content: guidedPrompt ? `${GUIDE_OPENINGS[guidedStart] ?? ""}\n\n你可以直接从这个问题开始：\n“${guidedPrompt}”` : GUIDE_OPENINGS[guidedStart] ?? "",
            status: "sent" as const,
            createdAt: new Date().toISOString(),
            isLocal: true,
          },
        ],
      }
    : null;
  const activeView = activeId ? conversationViews[activeId] ?? EMPTY_CONVERSATION_VIEW : (guidedView ?? EMPTY_CONVERSATION_VIEW);
  const messages = activeView.messages;
  const loadingMessages = activeView.loading;
  const waiting = activeView.waiting || Boolean(activeId && processingConversations[activeId]);
  const waitingStartedAt = activeView.waitingStartedAt;
  const animatingAssistantMessageId = activeView.animatingAssistantMessageId;
  const composerDraftKey = useMemo(
    () => buildComposerDraftKey(initialUser, activeId),
    [activeId, initialUser.assistantId, initialUser.id, initialUser.instanceId]
  );

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

  // ---- 初始化引导状态（2026-10-08）：未完成初始化时顶部常驻引导 ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/status", { cache: "no-store" });
        const payload = (await res.json()) as { ok?: boolean; data?: { needsOnboarding?: boolean } };
        if (!cancelled) setNeedsOnboarding(Boolean(res.ok && payload?.data?.needsOnboarding));
      } catch {
        // 查询失败不展示横幅。
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
      const res = await fetchConversations({ limit: 20, query: debouncedSearch, archived: false });
      setConversations(res.items);
      // 服务端活动轮 → 「处理中」对账（2026-10-09 mirror 回归）。
      // 双信号：turnActive 是运行时活动轮权威；processing 是 mirror 上
      // pending 用户消息无终态回复的兜底（relay 响应丢失时 turnActive 可能
      // 先消失而轮次结果未回）。对列表内会话以服务端为准（清除陈旧徽标 +
      // 恢复活动徽标），但不清除本地视图仍在等待的乐观标记——发送到服务端
      // 接管之间有约 1s 窗口，那时的 turn_active 还没写。列表外的会话
      //（分页外）保持原值不动。
      setProcessingConversations((current) => {
        const next: Record<string, boolean> = {};
        const listedIds = new Set(res.items.map((item) => item.conversationId));
        for (const [id, value] of Object.entries(current)) {
          if (!value) continue;
          if (!listedIds.has(id)) {
            next[id] = true;
            continue;
          }
          if (conversationViewsRef.current[id]?.waiting === true) {
            next[id] = true;
          }
        }
        for (const item of res.items) {
          if (item.turnActive || item.processing) next[item.conversationId] = true;
        }
        processingConversationsRef.current = next;
        return next;
      });
      setHasNextConversations(Boolean(res.nextCursor));
      cursorRef.current = res.nextCursor;
    } catch (err) {
      setFatalError((err as Error).message);
    } finally {
      setLoadingConversations(false);
    }
  }, [debouncedSearch]);

  const refreshLabels = useCallback(async () => {
    try { setLabels(await fetchConversationLabels()); } catch (err) { setFatalError((err as Error).message); }
  }, []);

  // Search debounce: typing updates the input immediately; the list query
  // fires 300ms after the last keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // Session/heartbeat loop must survive search changes: it no longer depends
  // on refreshConversations (whose identity changes with the search query).
  useEffect(() => {
    void ensureSessionMatchesPage().then((ok) => {
      if (ok) void refreshStatus();
    });
    const id = window.setInterval(() => {
      void ensureSessionMatchesPage().then((ok) => {
        if (ok) void refreshStatus();
      });
    }, 15_000);
    return () => window.clearInterval(id);
  }, [ensureSessionMatchesPage, refreshStatus]);

  useEffect(() => {
    void refreshConversations();
    void refreshLabels();
  }, [refreshConversations, refreshLabels]);

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
  const loadConversation = useCallback(async (conversationId: string, showLoading = false, syncDepth: "full" | "first" = "full"): Promise<{ processing: boolean }> => {
    if (showLoading) {
      updateConversationView(conversationId, (current) => ({ ...current, loading: true }));
    }
    let conversationMissing = false;
    const wasProcessing = processingConversationsRef.current[conversationId] === true;
    const storedProcessingStartedAt = readProcessingStartedAt(conversationId);
    try {
      const data = await fetchConversation(conversationId, { syncDepth });
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
      updateConversationView(conversationId, (current) => {
        // 首屏只拉最新一页；用户已「加载更早」的消息在刷新（轮询/重进）时
        // 保留，按 messageId 去重后拼在最新窗口前面，避免又翻一遍。
        // 只保留严格早于最新窗口的消息——在途/失败的本地乐观消息交给
        // 服务端窗口或 POST 回调处理，否则会与新窗口重复。
        // T-448: 未变的消息复用旧引用，1s 轮询 tick 只重渲真正变化的气泡
        //（配合 MessageBubble 的 memo），而不是整个消息列表。
        const currentById = new Map(current.messages.map((message) => [message.messageId, message]));
        const freshMessages = withProcessingPlaceholder(
          conversationId,
          withProcessedDurations(data.messages.map(toView)).map((message) =>
            reuseUnchangedMessage(message, currentById.get(message.messageId))
          ),
          processing
        );
        const freshIds = new Set(freshMessages.map((message) => message.messageId));
        const freshEarliest = freshMessages.length > 0
          ? new Date(freshMessages[0].createdAt).getTime()
          : Number.POSITIVE_INFINITY;
        const earlierMessages = current.messages.filter((message) =>
          !freshIds.has(message.messageId)
          && new Date(message.createdAt).getTime() < freshEarliest
        );
        return {
          ...current,
          waiting: processing ? current.waiting : false,
          messages: processing && current.waiting
            ? current.messages
            : [...earlierMessages, ...freshMessages],
          beforeCursor: current.beforeCursor ?? data.beforeCursor,
          waitingStartedAt: processing && current.waiting
            ? current.waitingStartedAt ?? processingStartedAt
            : processingStartedAt
        };
      });
      return { processing };
    } catch (err) {
      if (err instanceof PortalApiError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) {
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

  const loadEarlierMessages = useCallback(async (conversationId: string) => {
    const view = conversationViewsRef.current[conversationId];
    const before = view?.beforeCursor;
    if (!before || view?.loadingEarlier) return;
    updateConversationView(conversationId, (current) => ({ ...current, loadingEarlier: true }));
    try {
      const page = await fetchConversationMessagesBefore(conversationId, before);
      updateConversationView(conversationId, (current) => {
        const existingIds = new Set(current.messages.map((message) => message.messageId));
        const older = page.items.map(toView).filter((message) => !existingIds.has(message.messageId));
        return {
          ...current,
          messages: [...older, ...current.messages],
          beforeCursor: page.beforeCursor,
          loadingEarlier: false
        };
      });
    } catch (err) {
      updateConversationView(conversationId, (current) => ({ ...current, loadingEarlier: false }));
      setFatalError((err as Error).message);
    }
  }, [setFatalError, updateConversationView]);

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
      // Shallow sync per tick: the poll only waits for the newest message,
      // and a full remote walk every second amplified writes on the shared
      // portal db (T-448).
      const result = await loadConversation(conversationId, false, "first");
      const stillWaiting = conversationViewsRef.current[conversationId]?.waiting === true;
      if (!cancelled && (result.processing || stillWaiting)) timer = window.setTimeout(() => void poll(), 1_000);
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeId, loadConversation, processingConversations]);

  // 实时步骤流订阅（集中式，2026-10-09）：活动会话处于处理中即订阅 SSE——
  // 无论这轮是本机发起（发送/重新生成）还是切页/刷新后从服务端状态恢复。
  // 此前订阅只在发送路径创建，恢复场景只能看到静态「已等待较久」文案，
  // 没有展开式步骤流。轮次结束（processing 翻 false）时自动断开。
  useEffect(() => {
    if (!activeId || processingConversations[activeId] !== true) return;
    const conversationId = activeId;
    const stopProgress = subscribeConversationProgress(conversationId, (step) => {
      setLiveSteps((current) => {
        const existing = current[conversationId] ?? [];
        return { ...current, [conversationId]: [...existing, step].slice(-200) };
      });
    });
    return stopProgress;
  }, [activeId, processingConversations]);

  // URL selection wins over sessionStorage. `new=1` is an explicit reset and
  // must clear both recovery sources before the blank chat is shown.
  useEffect(() => {
    if (navigationInitializedRef.current) return;
    navigationInitializedRef.current = true;
    // 引导式入口：技能试用可携带一个真实示例问题；技能创建仍只展示引导，
    // 避免把用户尚未填写的内容误发给模型。
    try {
      const url = new URL(window.location.href);
      // autosend=attention-analysis（待处理「AI分析」按钮）：一次性自动发送
      // 标记，挂载时立即从 URL 清除，刷新/回退不会重复发送。
      const autosendConversationId = url.searchParams.get("autosend") === "attention-analysis"
        && url.searchParams.get("conversationId");
      if (url.searchParams.has("autosend")) {
        url.searchParams.delete("autosend");
        window.history.replaceState(window.history.state, "", url.toString());
      }
      if (autosendConversationId) setPendingAttentionAutosend(autosendConversationId);
      const guide = url.searchParams.get("guide");
      if (url.searchParams.get("new") === "1" && guide && GUIDE_OPENINGS[guide]) {
        setGuidedStart(guide);
        const prompt = url.searchParams.get("prompt");
        setGuidedPrompt(prompt);
        if (url.searchParams.get("auto") === "1" && guide === GUIDE_SKILL_TRY && prompt?.trim()) {
          setGuidedAutoSend(prompt.trim());
        }
        url.searchParams.delete("new");
        url.searchParams.delete("guide");
        url.searchParams.delete("prompt");
        window.history.replaceState(window.history.state, "", url.toString());
        activeIdRef.current = null;
        setActiveId(null);
        syncConversationNavigation(null);
        return;
      }
    } catch { /* 引导参数缺失时按普通新建会话处理 */ }
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
    activeIdRef.current = null;
    setActiveId(null);
    // 不再整体清空 processingConversations（2026-10-09 回归）：处理中标记以
    // 服务端 turnActive 为权威，切到新聊天不该把其它会话的「处理中」徽标
    // 一起抹掉；陈旧标记由 refreshConversations 的对账逻辑纠正。
    setStoppingConversations({});
    syncConversationNavigation(null);
    setActiveArtifact(null);
    setArtifactPanelClosed(true);
  }, [syncConversationNavigation]);

  const handleOpenArtifact = useCallback(async (artifact: ArtifactCardView) => {
    void recordArtifactEvent(artifact.artifactId, "open");
    if (artifact.previewMode === "image" || artifact.mimeType.startsWith("image/")) {
      setArtifactLightbox(artifact);
      return;
    }
    setActiveArtifact(artifact);
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
    setArtifactPanelClosed((prev) => !prev);
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
      };
      void handleOpenArtifact(cardView);
    },
    [handleOpenArtifact]
  );

  // ---- 发送消息 ----
  const handleSend = useCallback(
    async (text: string, attachments: ComposerAttachment[] = []): Promise<ComposerSendResult> => {
      if (guidedStart) {
        setGuidedStart(null);
        text = `${GUIDE_SEND_PREFIXES[guidedStart] ?? ""}${text}`;
      }
      const offline = status && !status.online;
      if (offline) return { ok: false, draftKey: buildComposerDraftKey(initialUser, activeId) };
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
      // 新一轮开始前清掉上一轮残留的实时步骤（集中式订阅见下方 effect）。
      setLiveSteps((current) => {
        if (!(conversationId in current)) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });

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
          ? { ...toView(result.assistantMessage), traceId: result.traceId ?? undefined, processedDurationMs: Date.now() - Date.parse(clientSentAt) }
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
        return { ok: result.ok, draftKey: buildComposerDraftKey(initialUser, conversationId) };
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
        return { ok: false, draftKey: buildComposerDraftKey(initialUser, conversationId) };
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
        window.setTimeout(() => {
          setLiveSteps((current) => {
            if (!(conversationId in current)) return current;
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
        }, 1200);
      }
    },
    [activeId, guidedStart, initialUser.assistantId, initialUser.id, initialUser.instanceId, selectedModel, setConversationProcessing, status, syncConversationNavigation, updateConversationView, writeProcessingStartedAt]
  );

  useEffect(() => {
    if (!guidedAutoSend || guidedStart !== GUIDE_SKILL_TRY) return;
    setGuidedAutoSend(null);
    setGuidedPrompt(null);
    void handleSend(guidedAutoSend);
  }, [guidedAutoSend, guidedStart, handleSend]);

  // 待处理「AI分析」：等会话选中且首屏加载完成（不在处理中）再发送；
  // 若正有轮次在跑，等它结束后由轮询触发的视图更新再补发。
  useEffect(() => {
    if (!pendingAttentionAutosend || activeId !== pendingAttentionAutosend) return;
    const view = conversationViews[activeId];
    if (!view || view.loading || view.waiting) return;
    setPendingAttentionAutosend(null);
    void handleSend("请分析这次任务失败的原因，并给出处理建议。");
  }, [activeId, conversationViews, pendingAttentionAutosend, handleSend]);

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

  // ---- 重新生成（owner 2026-08-26）：最后一条已送达回答不满意时重放该轮 ----
  const handleRegenerate = useCallback(
    (assistantMessage: ChatMessageView) => {
      if (!activeId) return;
      const offline = status && !status.online;
      if (offline) return;
      const clientSentAt = new Date().toISOString();
      const processingStartedAt = Date.parse(clientSentAt);
      const pendingMessage: ChatMessageView = {
        messageId: `regen_${nanoid(8)}`,
        conversationId: activeId,
        role: "assistant",
        content: "",
        status: "pending",
        createdAt: clientSentAt,
        isLocal: true
      };
      updateConversationView(activeId, (current) => ({
        ...current,
        messages: [...current.messages.filter((m) => m.messageId !== assistantMessage.messageId), pendingMessage],
        waiting: true,
        waitingStartedAt: processingStartedAt,
        animatingAssistantMessageId: null
      }));
      setConversationProcessing(activeId, true);
      writeProcessingStartedAt(activeId, processingStartedAt);
      setLiveSteps((current) => {
        if (!(activeId in current)) return current;
        const next = { ...current };
        delete next[activeId];
        return next;
      });
      void (async () => {
        try {
          const result = await regenerateMessage(activeId, assistantMessage.messageId, selectedModel || undefined);
          const assistantView = result.ok && result.assistantMessage
            ? { ...toView(result.assistantMessage), traceId: result.traceId ?? undefined, processedDurationMs: Date.now() - processingStartedAt }
            : null;
          updateConversationView(activeId, (current) => {
            const next: ChatMessageView[] = current.messages.map((m) => {
              if (m.messageId === pendingMessage.messageId && assistantView) return assistantView;
              if (m.messageId === pendingMessage.messageId && !result.ok) {
                return {
                  messageId: `failed_${nanoid(8)}`,
                  conversationId: activeId,
                  role: "assistant",
                  content: result.error?.message ?? "重新生成失败，请稍后重试。",
                  status: "failed",
                  createdAt: new Date().toISOString()
                };
              }
              return m;
            });
            return { ...current, messages: next, animatingAssistantMessageId: assistantView?.messageId ?? null };
          });
          if (result.ok) writeProcessingStartedAt(activeId, null);
        } catch (err) {
          updateConversationView(activeId, (current) => ({
            ...current,
            messages: current.messages.map((m) => m.messageId === pendingMessage.messageId
              ? { ...m, messageId: `failed_${nanoid(8)}`, content: (err as Error).message || "重新生成失败，请稍后重试。", status: "failed" as const }
              : m)
          }));
        } finally {
          setConversationProcessing(activeId, false);
        }
      })();
    },
    [activeId, status, selectedModel, updateConversationView, setConversationProcessing, writeProcessingStartedAt]
  );

  // ---- 【喜欢/不喜欢】标注（owner 2026-08-26）：再次点击同一按钮撤销 ----
  // comment（owner 2026-08-28 点踩弹窗）：undefined = 按钮点击走 toggle；
  // 显式传入（含 null）= 设置语义——弹窗提交时 dislike 已在点踩那一下生效，
  // 若再走 toggle 会被当成撤销。
  const handleFeedback = useCallback(
    (feedbackMessage: ChatMessageView, rating: "like" | "dislike", comment?: string | null) => {
      if (!activeId) return;
      const next = comment === undefined && feedbackMessage.userFeedback === rating ? null : rating;
      // 乐观更新；失败静默回滚（下次刷新以 runtime 为准）。
      const previous = feedbackMessage.userFeedback;
      updateConversationView(activeId, (current) => ({
        ...current,
        messages: current.messages.map((m) => m.messageId === feedbackMessage.messageId
          ? { ...m, userFeedback: next ?? undefined }
          : m)
      }));
      void sendFeedback(activeId, feedbackMessage.messageId, next, next === null ? undefined : comment)
        .then((updated) => {
          updateConversationView(activeId, (current) => ({
            ...current,
            messages: current.messages.map((m) => m.messageId === updated.messageId
              ? { ...toView(updated), processedDurationMs: m.processedDurationMs }
              : m)
          }));
        })
        .catch(() => {
          updateConversationView(activeId, (current) => ({
            ...current,
            messages: current.messages.map((m) => m.messageId === feedbackMessage.messageId
              ? { ...m, userFeedback: previous }
              : m)
          }));
        });
    },
    [activeId, updateConversationView]
  );

  // ---- 加载更多会话 ----
  const handleLoadMore = useCallback(async () => {
    if (!cursorRef.current) return;
    try {
      const res = await fetchConversations({ limit: 20, cursor: cursorRef.current, query: debouncedSearch, archived: false });
      setConversations((prev) => [...prev, ...res.items]);
      cursorRef.current = res.nextCursor;
      setHasNextConversations(Boolean(res.nextCursor));
    } catch (err) {
      setFatalError((err as Error).message);
    }
  }, [debouncedSearch]);

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

  // Portal consumes attachments through a read-only connector capability.
  // Browser-side file mutation capabilities are intentionally ignored.
  const capabilities = useMemo(
    () => ({
      attachmentGet: hasCapability(status, "attachment.get")
    }),
    [status]
  );

  // Keep an opened workspace mounted after its one-shot artifact request is
  // consumed. Otherwise a transient capability refresh could tear it down and
  // discard its tabs before the user explicitly closes the panel.
  const workspaceVisible = !artifactPanelClosed || Boolean(activeArtifact);

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
        onOpenAutomations={() => appNavigate("/automations")}
        onOpenAssets={() => appNavigate("/assets")}
        onOpenManual={() => appNavigate("/manual")}
        onOpenUsage={() => appNavigate("/usage")}
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
        </div>
          <div className="flex items-center gap-2">
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
        {needsOnboarding ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f3e8c8] bg-[#fdf8ec] px-4 py-2 sm:px-6">
            <p className="text-xs text-[#8a6d3b]">
              还差一步：完成初始化（录入持仓、选择初始策略，约 2 分钟），分析、复盘和提醒就会围绕你的真实持仓展开。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => appNavigate("/onboarding")}
                className="h-7 rounded-md bg-[#365b40] px-3 text-xs font-medium text-white transition hover:bg-[#2c4c35]"
              >
                开始初始化
              </button>
              <button
                type="button"
                onClick={() => setNeedsOnboarding(false)}
                className="h-7 rounded-md px-2 text-xs text-[#8a6d3b] transition hover:bg-[#f6ecd6]"
                aria-label="暂不提示"
                title="本次会话不再提示"
              >
                暂不
              </button>
            </div>
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
                {!loadingMessages && activeView.beforeCursor ? (
                  <div className="pb-2 text-center">
                    <button
                      type="button"
                      className="rounded-md px-3 py-1.5 text-xs text-[#6b7280] transition hover:bg-black/5 hover:text-[#202123] disabled:opacity-60"
                      disabled={activeView.loadingEarlier}
                      onClick={() => { if (activeId) void loadEarlierMessages(activeId); }}
                    >
                      {activeView.loadingEarlier ? "加载中..." : "加载更早消息"}
                    </button>
                  </div>
                ) : null}
                {messages.map((message, idx) => {
                  const isLast =
                    idx === messages.length - 1 && message.role === "assistant";
                  const isWaiting =
                    isLast &&
                    waiting &&
                    (message.status === "pending" || message.content === "");
                  const showDateDivider = idx === 0
                    || localDayKey(messages[idx - 1].createdAt) !== localDayKey(message.createdAt);
                  return (
                    <Fragment key={message.messageId}>
                      {showDateDivider ? (
                        <div className="flex items-center justify-center py-3">
                          <span className="rounded-full bg-black/[0.04] px-3 py-1 text-xs text-[#6e766f]">{localDayLabel(message.createdAt)}</span>
                        </div>
                      ) : null}
                      <MessageBubble
                      message={message}
                      isLastAssistant={isLast && message.role === "assistant"}
                      shouldAnimate={message.messageId === animatingAssistantMessageId}
                      isWaiting={Boolean(isWaiting)}
                      waitingStartedAt={waitingStartedAt}
                      onRetry={handleRetry}
                      onRegenerate={handleRegenerate}
                      onFeedback={handleFeedback}
                        onArtifactOpen={handleOpenArtifact}
                        onArtifactSave={handleSaveArtifact}
                      onArtifactLegacyPath={handleArtifactLegacyPath}
                      attachmentGetEnabled={capabilities.attachmentGet}
                      onAttachmentImageOpen={handleAttachmentImageOpen}
                      deletedArtifactIds={deletedArtifactIds}
                      liveSteps={isWaiting && message.role === "assistant" && message.status === "pending" ? liveSteps[message.conversationId] : undefined}
                    />
                    </Fragment>
                  );
                })}
              </div>
            </div>
          </div>
          <MessageComposer
            disabled={offline}
            disabledReason={disabledReason ?? (waiting ? "正在等待助手回复..." : undefined)}
            processing={waiting}
            stopping={Boolean(activeId && stoppingConversations[activeId])}
            draftKey={composerDraftKey}
            initialDraft={guidedPrompt ?? undefined}
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

/**
 * T-448: keep the previous message object when nothing observable changed, so
 * a poll tick produces a stable reference for unchanged rows and the memoized
 * MessageBubble skips re-rendering them. Card arrays compare by length: rows
 * with the same messageId are immutable history except for the in-flight
 * assistant row, whose content/status changes are compared above.
 */
function reuseUnchangedMessage(fresh: ChatMessageView, current: ChatMessageView | undefined): ChatMessageView {
  if (!current) return fresh;
  if (
    current.messageId === fresh.messageId &&
    current.role === fresh.role &&
    current.content === fresh.content &&
    current.status === fresh.status &&
    current.createdAt === fresh.createdAt &&
    current.traceId === fresh.traceId &&
    current.userFeedback === fresh.userFeedback &&
    current.processedDurationMs === fresh.processedDurationMs &&
    current.executionDurationMs === fresh.executionDurationMs &&
    (current.attachments?.length ?? 0) === (fresh.attachments?.length ?? 0) &&
    (current.artifacts?.length ?? 0) === (fresh.artifacts?.length ?? 0) &&
    (current.inlineVisuals?.length ?? 0) === (fresh.inlineVisuals?.length ?? 0)
  ) {
    return current;
  }
  return fresh;
}

function withProcessedDurations(messages: ChatMessageView[]): ChatMessageView[] {
  let lastUserCreatedAt: number | null = null;
  return messages.map((message) => {
    if (message.role === "user") {
      const timestamp = Date.parse(message.createdAt);
      lastUserCreatedAt = Number.isFinite(timestamp) ? timestamp : null;
      return message;
    }
    if (message.role !== "assistant" || message.status !== "sent") return message;
    // 服务端记录的轮真实时长优先：重新生成不新插 user 行，按时间戳推算会跨到原提问。
    if (typeof message.executionDurationMs === "number" && message.executionDurationMs >= 0) {
      return { ...message, processedDurationMs: message.executionDurationMs };
    }
    if (lastUserCreatedAt === null) return message;
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

/** 日期分割线：按本地日历日跨日分组，长会话的时间脉络一眼可辨。 */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function localDayLabel(iso: string): string {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
}

function latestUserTimestamp(messages: Array<{ role: string; createdAt: string }>): number | null {  for (let index = messages.length - 1; index >= 0; index -= 1) {
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

/** 引导式新建：对用户使用“技能”语言；内部仍由系统技能负责整理和确认。 */
const GUIDE_SKILL_CREATE = "skill-create";
const GUIDE_SKILL_TRY = "skill-try";
/** 引导式新建策略（2026-10-09 owner 裁决：对齐技能管理的 agent 式创建，
 * 不再手填表单）：开场白引导用户口述规则，由 agent 整理方案、确认后
 * strategy.create 保存。 */
const GUIDE_STRATEGY_CREATE = "strategy-create";
const GUIDE_OPENINGS: Record<string, string> = {
  [GUIDE_SKILL_CREATE]: "我们来新建一个技能。请告诉我：\n\n1. **名称**（暂定即可）\n2. **用途与触发场景**：它解决什么问题，什么情况下该用它\n3. **核心规则/步骤要点**\n\n如果还没想好，直接描述你想长期采用的做法。我会先帮你判断是否值得保存为技能，再整理成一份易读的方案给你确认；确认后才会生效。",
  [GUIDE_SKILL_TRY]: "我们来试试这个技能。请直接描述一个你想解决的问题，或给出一只股票、一个行业和你想了解的方向；助手会根据当前技能给你一个实际示例。",
  [GUIDE_STRATEGY_CREATE]: "我们来新建一个策略。请告诉我：\n\n1. **名称**（暂定即可）\n2. **这是哪类规则**：买卖条件、仓位或风控纪律、观察口径……\n3. **具体规则**：什么条件下做什么，越明确越好（比如「跌破 20 日均线减半」）\n\n如果还没想清楚，直接用大白话描述你的做法。我会帮你整理成一份明确的策略方案给你确认，确认后才保存生效；第一个保存的策略会成为主策略，之后随时可以调整。",
};
const GUIDE_SEND_PREFIXES: Record<string, string> = {
  [GUIDE_SKILL_CREATE]: "新建技能：",
  [GUIDE_SKILL_TRY]: "技能试用：",
  [GUIDE_STRATEGY_CREATE]: "新建策略：",
};

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
