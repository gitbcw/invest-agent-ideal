"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";

import { ArtifactCard } from "./ArtifactCard";
import { MarkdownLite } from "./MarkdownLite";
import { ToolCallTimeline } from "./ToolCallTimeline";
import { useTypewriter } from "./useTypewriter";
import { useWaitingHint } from "./useElapsedTime";
import { fetchAttachment, fetchTrace } from "./api";
import { base64ToBytes, formatBytes, formatExpiry, sha256Hex, svgToDataUrl, svgToPngBytes, triggerBrowserDownload } from "./media-helpers";
import type { ArtifactCardView, AttachmentView, ChatMessageView, InlineSvgVisual, TraceDetailView, WorkStepView } from "./types";
import type { AttachmentGetResult } from "@/lib/protocol";
import { toolDisplayName } from "./tool-display";

interface MessageBubbleProps {
  message: ChatMessageView;
  isLastAssistant: boolean;
  shouldAnimate: boolean;
  isWaiting: boolean;
  waitingStartedAt: number | null;
  onRetry?: (message: ChatMessageView) => void;
  /** 重新生成（owner 2026-08-26）：最后一条已送达回答不满意时重放该轮。 */
  onRegenerate?: (message: ChatMessageView) => void;
  /**
   * 【喜欢/不喜欢】标注（owner 2026-08-26）：再次点击同一按钮 = 撤销。
   * owner 2026-08-28 点踩弹窗：comment 缺省 = 按钮 toggle；显式传入（含 null）
   * = 设置语义（弹窗提交时 dislike 已生效，不能再走 toggle）。
   */
  onFeedback?: (message: ChatMessageView, rating: "like" | "dislike", comment?: string | null) => void;
  onArtifactOpen?: (artifact: ArtifactCardView) => void;
  onArtifactSave?: (artifact: ArtifactCardView) => Promise<{ ok: boolean; message?: string }>;
  onArtifactLegacyPath?: (relativePath: string, messageId: string, conversationId: string) => void;
  /** When true the connector advertises attachment.get; cards become clickable. */
  attachmentGetEnabled?: boolean;
  /** Opened when the user clicks an active image attachment. */
  onAttachmentImageOpen?: (attachmentId: string, title: string) => void;
  /** artifactIds the user deleted from the library tree; their cards render "文件已删除". */
  deletedArtifactIds?: Set<string>;
  /** T-199：当前等待轮的实时工作过程事件（由 ChatShell 订阅传入）。 */
  liveSteps?: WorkStepView[];
}

export function MessageBubble({
  message,
  isLastAssistant,
  shouldAnimate,
  isWaiting,
  waitingStartedAt,
  onRetry,
  onRegenerate,
  onFeedback,
  onArtifactOpen,
  onArtifactSave,
  onArtifactLegacyPath,
  attachmentGetEnabled = false,
  onAttachmentImageOpen,
  deletedArtifactIds,
  liveSteps
}: MessageBubbleProps) {
  const [animationDone, setAnimationDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [traceDetail, setTraceDetail] = useState<TraceDetailView | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  // 点踩反馈弹窗（owner 2026-08-28）：点踩立即生效并弹窗，填不填都可以。
  const [dislikeDialogOpen, setDislikeDialogOpen] = useState(false);
  const [dislikeComment, setDislikeComment] = useState("");
  const copyResetTimer = useRef<number | null>(null);
  const animateMessage =
    shouldAnimate && isLastAssistant && message.role === "assistant" && !animationDone && !isWaiting;
  const typewriter = useTypewriter(message.content, {
    enabled: animateMessage,
    speedMs: 14,
    chunkSize: 2
  });
  const waiting = useWaitingHint(isWaiting && isLastAssistant, waitingStartedAt);

  // 当打字机跑完一次后,后续不再触发动画(避免每次切会话重新播放)
  useEffect(() => {
    if (animateMessage && !typewriter.isAnimating && typewriter.displayed === message.content) {
      setAnimationDone(true);
    }
  }, [animateMessage, typewriter.isAnimating, typewriter.displayed, message.content]);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!message.content) return;
    const didCopy = await copyText(message.content);
    if (!didCopy) return;
    setCopied(true);
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => {
      setCopied(false);
      copyResetTimer.current = null;
    }, 1600);
  }, [message.content]);

  // 点踩：未标注 → 标记 + 弹反馈框；已标注 → 撤销（toggle 语义在 ChatShell）。
  const handleDislikeClick = useCallback(() => {
    const wasActive = message.userFeedback === "dislike";
    onFeedback?.(message, "dislike");
    if (!wasActive) {
      setDislikeComment("");
      setDislikeDialogOpen(true);
    }
  }, [message, onFeedback]);

  // 弹窗提交（owner 2026-08-28）：设置语义——dislike 已在点踩那一下生效，
  // 这里只补交文字；空文本传 null = 显式无评论。
  const submitDislikeComment = useCallback(() => {
    setDislikeDialogOpen(false);
    if (message.userFeedback !== "dislike") return;
    onFeedback?.(message, "dislike", dislikeComment.trim() || null);
  }, [dislikeComment, message, onFeedback]);

  // 标注被撤销（再次点击踩按钮）时自动收起弹窗；Esc 也可关闭。
  useEffect(() => {
    if (dislikeDialogOpen && message.userFeedback !== "dislike") setDislikeDialogOpen(false);
  }, [dislikeDialogOpen, message.userFeedback]);
  useEffect(() => {
    if (!dislikeDialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDislikeDialogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dislikeDialogOpen]);

  // T-199 历史回看：点开时按需拉取 trace 摘要（工具时间线 + 计量）。
  const handleToggleTrace = useCallback(async () => {
    if (!message.traceId) return;
    const next = !traceOpen;
    setTraceOpen(next);
    if (next && !traceDetail && !traceLoading) {
      setTraceLoading(true);
      try {
        const detail = await fetchTrace(message.traceId).catch(() => null);
        setTraceDetail(detail);
      } finally {
        setTraceLoading(false);
      }
    }
  }, [message.traceId, traceDetail, traceLoading, traceOpen]);

  const traceSteps: WorkStepView[] | null = traceDetail
    ? traceDetail.toolCalls.map((call) => ({
        at: call.startedAt ?? traceDetail.createdAt,
        kind: (call.status === "error" ? "tool_result" : "tool_call") as WorkStepView["kind"],
        toolName: call.toolName,
        status: call.status,
        elapsedMs: call.elapsedMs,
        inputChars: call.inputChars,
        outputChars: call.outputChars,
        errorExcerpt: call.errorExcerpt
      }))
    : null;

  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end py-3">
        <div className="max-w-[80%] rounded-3xl bg-[#f4f4f4] px-5 py-3 text-[15px] leading-7 text-[#202123]">
          {message.content ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : null}
          <AttachmentList
            attachments={message.attachments}
            align="right"
            clickable={attachmentGetEnabled}
            onImageOpen={onAttachmentImageOpen}
          />
          {message.status === "failed" ? (
            <p className="mt-1 text-xs text-red-500">发送失败</p>
          ) : null}
        </div>
        {message.status === "sent" && message.content ? (
          <CopyMessageButton copied={copied} onClick={() => void handleCopy()} align="right" />
        ) : null}
      </div>
    );
  }

  if (message.role === "system") {
    return <div className="text-center text-xs text-ink-500">{message.content}</div>;
  }

  return (
    <div className="group py-4">
      <div className="min-w-0">
        <div className="chatgpt-prose text-[15px] text-[#202123]">
          {!isWaiting && message.status === "sent" && message.processedDurationMs !== undefined ? (
            <div className="mb-3 inline-flex items-center gap-1.5 text-xs text-[#8a918d]">
              <Check size={13} className="text-emerald-500" aria-hidden="true" />
              <span>处理完成 · 用时 {formatProcessedDuration(message.processedDurationMs)}</span>
            </div>
          ) : null}
            {isWaiting && waitingStartedAt ? (
              <>
                <WaitingBlock label={waiting.label} seconds={waiting.seconds} liveSteps={liveSteps} />
                {liveSteps && liveSteps.length > 0 ? (
                  <ToolCallTimeline steps={liveSteps} live />
                ) : null}
              </>
            ) : (
              <>
                <MarkdownLite
                  text={typewriter.displayed || message.content}
                  onLegacyReportPath={(relativePath) =>
                    onArtifactLegacyPath?.(relativePath, message.messageId, message.conversationId)
                  }
                />
                {/* 等正文打字机结束后再出现图示,避免图先出现再被文字往下推。 */}
                {!typewriter.isAnimating ? <InlineVisualList visuals={message.inlineVisuals} /> : null}
                <AttachmentList
                  attachments={message.attachments}
                  align="left"
                  clickable={attachmentGetEnabled}
                  onImageOpen={onAttachmentImageOpen}
                />
                {message.artifacts && message.artifacts.length > 0 ? (
                  <div className="mt-3 flex flex-col gap-2">
                    {message.artifacts.map((artifact) => (
                      <ArtifactCard
                        key={artifact.artifactId}
                        artifact={artifact}
                        onOpen={(item) => onArtifactOpen?.(item)}
                        onSave={onArtifactSave}
                        deleted={deletedArtifactIds?.has(artifact.artifactId) ?? false}
                      />
                    ))}
                    </div>
                  ) : null}
                {typewriter.isAnimating ? (
                  <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-accent-500 align-middle" />
                ) : null}
              </>
            )}
        </div>
        {message.status === "failed" && onRetry ? (
            <div className="mt-2 text-xs text-red-600">
              助手回复失败。{" "}
              <button type="button" className="underline" onClick={() => onRetry(message)}>
                点此重试
              </button>
            </div>
        ) : null}
        {!isWaiting && !typewriter.isAnimating && message.traceId ? (
            traceOpen && traceDetail ? (
              <div className="mt-1">
                <ToolCallTimeline steps={traceSteps ?? []} summary={traceDetail} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleToggleTrace()}
                className="mt-2 text-[11px] text-[#b4b4b8] underline-offset-2 transition-colors hover:text-slate-500 hover:underline"
              >
                {traceLoading ? "处理过程加载中…" : "查看处理过程"}
              </button>
            )
        ) : null}
      </div>
      {!isWaiting && !typewriter.isAnimating && message.status === "sent" && message.content ? (
        <div className="relative mt-2 flex items-center gap-0.5">
          <ActionButton
            onClick={() => void handleCopy()}
            label={copied ? "已复制" : "复制"}
            active={false}
          >
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          </ActionButton>
          {onFeedback ? (
            <>
              {message.userFeedback !== "dislike" ? (
                <ActionButton
                  onClick={() => onFeedback(message, "like")}
                  label={message.userFeedback === "like" ? "已标喜欢" : "喜欢"}
                  active={message.userFeedback === "like"}
                  activeTone="accent"
                >
                  <ThumbsUp
                    size={15}
                    fill={message.userFeedback === "like" ? "currentColor" : "none"}
                    aria-hidden="true"
                  />
                </ActionButton>
              ) : null}
              {message.userFeedback !== "like" ? (
                <ActionButton
                  onClick={handleDislikeClick}
                  label={message.userFeedback === "dislike" ? "已标不喜欢" : "不喜欢"}
                  active={message.userFeedback === "dislike"}
                  activeTone="danger"
                >
                  <ThumbsDown
                    size={15}
                    fill={message.userFeedback === "dislike" ? "currentColor" : "none"}
                    aria-hidden="true"
                  />
                </ActionButton>
              ) : null}
              {dislikeDialogOpen ? (
                <>
                  {/* 透明遮罩：点击弹窗外任意位置收起，不阻断页面滚动。 */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setDislikeDialogOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-3rem)] rounded-xl border border-black/10 bg-white p-3 shadow-lg"
                    role="dialog"
                    aria-label="不满意反馈"
                  >
                    <p className="text-xs font-medium text-[#343541]">告诉我们哪里不满意？（选填）</p>
                    <textarea
                      className="mt-2 w-full resize-none rounded-lg border border-black/10 px-2.5 py-2 text-sm text-[#202123] placeholder:text-[#b4b4b8] focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-300"
                      rows={3}
                      maxLength={500}
                      placeholder="写下具体问题，帮助我们改进…"
                      value={dislikeComment}
                      onChange={(e) => setDislikeComment(e.target.value)}
                      autoFocus
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-md px-2.5 py-1 text-xs text-[#8a918d] transition hover:bg-black/5 hover:text-[#202123]"
                        onClick={() => setDislikeDialogOpen(false)}
                      >
                        跳过
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-accent-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-accent-600"
                        onClick={submitDislikeComment}
                      >
                        提交
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          {isLastAssistant && onRegenerate ? (
            <ActionButton onClick={() => onRegenerate(message)} label="重新生成" active={false}>
              <RefreshCw size={15} aria-hidden="true" />
            </ActionButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 回复下方常显操作钮（owner 2026-08-26）：图标 + 悬停提示；active 时填充高亮。 */
function ActionButton({
  onClick,
  label,
  active,
  activeTone = "accent",
  children
}: {
  onClick: () => void;
  label: string;
  active: boolean;
  /** active 高亮色调：喜欢走主题色，不喜欢走红色以示负反馈。 */
  activeTone?: "accent" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition focus:outline-none focus:ring-2 focus:ring-accent-300 ${
        active
          ? activeTone === "danger"
            ? "bg-red-50 text-red-600"
            : "bg-accent-50 text-accent-600"
          : "text-[#b4b4b8] hover:bg-black/5 hover:text-[#202123]"
      }`}
    >
      {children}
    </button>
  );
}

function CopyMessageButton({
  copied,
  onClick,
  align
}: {
  copied: boolean;
  onClick: () => void;
  align: "left" | "right";
}) {
  return (
    <button
      type="button"
      className={`invisible mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8a918d] opacity-0 transition hover:bg-black/5 hover:text-[#202123] focus:outline-none focus:ring-2 focus:ring-accent-300 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${align === "right" ? "mr-1" : "ml-1"}`}
      onClick={onClick}
      aria-label={copied ? "已复制消息" : "复制消息"}
      title={copied ? "已复制" : "复制消息"}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const didCopy = document.execCommand("copy");
  textarea.remove();
  return didCopy;
}

function formatProcessedDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function InlineVisualList({ visuals }: { visuals?: InlineSvgVisual[] }) {
  const [zoomed, setZoomed] = useState<InlineSvgVisual | null>(null);
  if (!visuals?.length) return null;
  return (
    <>
      <div className="my-3 flex max-w-[680px] flex-col gap-3">
        {visuals.map((visual) => (
          <InlineSvgVisualCard key={visual.id} visual={visual} onZoom={() => setZoomed(visual)} />
        ))}
      </div>
      {zoomed ? <InlineSvgLightbox visual={zoomed} onClose={() => setZoomed(null)} /> : null}
    </>
  );
}

function InlineSvgVisualCard({ visual, onZoom }: { visual: InlineSvgVisual; onZoom: () => void }) {
  const src = useMemo(() => svgToDataUrl(visual.svg), [visual.svg]);
  const [downloading, setDownloading] = useState(false);
  return (
    <figure className="overflow-hidden rounded-lg border border-ink-200 bg-white p-2 shadow-sm dark:border-ink-700 dark:bg-white">
      <button
        type="button"
        className="block w-full cursor-zoom-in"
        onClick={onZoom}
        title="点击放大查看"
        aria-label={`放大查看：${visual.title}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="block h-auto w-full" src={src} alt={visual.alt} />
      </button>
      <div className="flex items-center justify-between gap-2 px-1 pt-2">
        <figcaption className="text-xs text-ink-600">{visual.title}</figcaption>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-ink-500 transition hover:bg-black/5 hover:text-ink-700 disabled:opacity-50"
          disabled={downloading}
          onClick={() => void downloadInlineVisualPng(visual, setDownloading)}
          title="下载 PNG 图片"
        >
          {downloading ? "生成中…" : "下载"}
        </button>
      </div>
    </figure>
  );
}

/**
 * Zoomed preview for an inline SVG visual. The payload already lives in the
 * message metadata, so unlike ImageLightbox nothing is fetched from the
 * connector; the SVG is still rendered through an <img> data URL (never
 * inline DOM). Esc / overlay click / ✕ close.
 */
function InlineSvgLightbox({ visual, onClose }: { visual: InlineSvgVisual; onClose: () => void }) {
  const src = useMemo(() => svgToDataUrl(visual.svg), [visual.svg]);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={`图示预览：${visual.title}`}
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="min-w-0 truncate text-sm">{visual.title}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
            disabled={downloading}
            onClick={(e) => {
              e.stopPropagation();
              void downloadInlineVisualPng(visual, setDownloading);
            }}
            title="下载 PNG 图片"
          >
            {downloading ? "生成中…" : "下载"}
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="关闭 (Esc)"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        className="flex flex-1 items-center justify-center px-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={visual.alt}
          className="max-h-[82vh] max-w-full rounded bg-white object-contain"
        />
      </div>
    </div>
  );
}

/**
 * Downloads an inline SVG visual as a PNG (rasterized at 2x on a white
 * background) so it can be opened anywhere, including WeChat. Falls back to
 * the raw SVG if the browser cannot rasterize it.
 */
async function downloadInlineVisualPng(
  visual: InlineSvgVisual,
  setPending: (pending: boolean) => void
) {
  setPending(true);
  try {
    const png = await svgToPngBytes(visual.svg);
    triggerBrowserDownload(png, "image/png", svgFileName(visual, "png"));
  } catch {
    triggerBrowserDownload(new TextEncoder().encode(visual.svg), "image/svg+xml", svgFileName(visual, "svg"));
  } finally {
    setPending(false);
  }
}

function svgFileName(visual: InlineSvgVisual, ext: "png" | "svg") {
  const base = visual.title
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "inline-visual"}.${ext}`;
}

function AttachmentList({
  attachments,
  align,
  clickable,
  onImageOpen
}: {
  attachments?: AttachmentView[];
  align: "left" | "right";
  clickable: boolean;
  onImageOpen?: (attachmentId: string, title: string) => void;
}) {
  if (!attachments?.length) return null;
  return (
    <div className={`mt-2 flex flex-wrap gap-2 ${align === "right" ? "justify-end" : "justify-start"}`}>
      {attachments.map((item, index) => (
        <AttachmentCard
          key={item.attachmentId || item.id || `${item.fileName}-${index}`}
          attachment={item}
          clickable={clickable}
          onImageOpen={onImageOpen}
        />
      ))}
    </div>
  );
}

type CardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "active" }
  | { kind: "expired" }
  | { kind: "deleted" }
  | { kind: "error"; reason: string };

function AttachmentCard({
  attachment,
  clickable,
  onImageOpen
}: {
  attachment: AttachmentView;
  clickable: boolean;
  onImageOpen?: (attachmentId: string, title: string) => void;
}) {
  // Optimistically show "expired" if the card metadata's expiresAt is already
  // in the past, without round-tripping. The first click confirms the real
  // status via attachment.get. Once confirmed active/expired/deleted the
  // state sticks.
  const initiallyExpired = Boolean(
    attachment.expiresAt && Date.parse(attachment.expiresAt) <= Date.now()
  );
  const [state, setState] = useState<CardState>(initiallyExpired ? { kind: "expired" } : { kind: "idle" });

  const handleOpen = useCallback(async () => {
    if (!clickable || !attachment.attachmentId) return;
    if (state.kind === "deleted" || state.kind === "expired") return;
    setState({ kind: "loading" });
    const outcome = await fetchAttachment(attachment.attachmentId);
    if (!outcome.ok) {
      if (outcome.code === "ATTACHMENT_EXPIRED") {
        setState({ kind: "expired" });
        return;
      }
      if (outcome.code === "ATTACHMENT_DELETED") {
        setState({ kind: "deleted" });
        return;
      }
      setState({ kind: "error", reason: outcome.message || "无法读取附件" });
      return;
    }
    const data = outcome.data as AttachmentGetResult;
    if (data.status !== "active") {
      setState({ kind: data.status === "deleted" ? "deleted" : "expired" });
      return;
    }
    const bytes = base64ToBytes(data.base64);
    if (data.checksum) {
      const verify = await sha256Hex(bytes);
      if (verify !== data.checksum) {
        setState({ kind: "error", reason: "checksum mismatch" });
        return;
      }
    }
    setState({ kind: "active" });
    if (attachment.type === "image" && onImageOpen) {
      // Hand off to the Lightbox. The bytes are re-fetched inside the lightbox
      // via attachment.get so the object URL is owned and released there.
      onImageOpen(attachment.attachmentId, attachment.fileName);
      return;
    }
    // Documents: download-only (no Office/inline previewer in this version).
    triggerBrowserDownload(bytes, data.mimeType, data.fileName);
  }, [attachment, clickable, onImageOpen, state.kind]);

  const greyed = state.kind === "expired" || state.kind === "deleted";
  const statusLabel =
    state.kind === "expired"
      ? "附件已过期"
      : state.kind === "deleted"
        ? "附件已删除"
        : state.kind === "loading"
          ? "读取中…"
          : state.kind === "error"
            ? state.reason
            : null;

  return (
    <button
      type="button"
      disabled={!clickable || !attachment.attachmentId || greyed || state.kind === "loading"}
      onClick={() => void handleOpen()}
      className={`flex max-w-full items-center gap-2 rounded-xl border px-2 py-1.5 text-xs leading-4 transition ${
        greyed
          ? "cursor-not-allowed border-black/5 bg-[#f4f4f4] text-[#b4b4b8]"
          : clickable && attachment.attachmentId
            ? "border-black/10 bg-white/80 text-[#343541] hover:bg-black/5"
            : "cursor-default border-black/10 bg-white/80 text-[#343541]"
      }`}
      title={clickable && attachment.attachmentId && !greyed ? "点击查看/下载" : undefined}
    >
      {attachment.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={attachment.previewUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#f4f4f4] text-[10px] font-semibold text-[#5f6368]">
          {attachment.type === "image" ? "IMG" : extensionLabel(attachment.fileName)}
        </span>
      )}
      <span className="min-w-0">
        <span className="block max-w-[220px] truncate">{attachment.fileName}</span>
        <span className="block text-[11px] text-[#8e8ea0]">
          {greyed || statusLabel ? (
            statusLabel
          ) : (
            <>
              {attachment.type === "image" ? "图片" : "文档"} · {formatBytes(attachment.sizeBytes)}
              {attachment.expiresAt ? <span className="ml-1">· 保留至 {formatExpiry(attachment.expiresAt)}</span> : null}
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function extensionLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.slice(0, 4).toUpperCase();
  return ext || "FILE";
}

function WaitingBlock({ label, seconds, liveSteps }: { label: string; seconds: number; liveSteps?: WorkStepView[] }) {
  const latestTool = [...(liveSteps ?? [])].reverse().find((step) => step.toolName);
  const status = latestTool ? toolDisplayName(latestTool.toolName) : label;
  return (
    <div className="flex max-w-xl items-center gap-2 text-sm">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
      </span>
      <span className="truncate text-[#5f6368]">{status}</span>
      {seconds >= 1 ? (
        <span className="shrink-0 text-xs tabular-nums text-[#a0a4aa]">{seconds}s{seconds >= 30 ? " · 仍在处理" : ""}</span>
      ) : null}
    </div>
  );
}
