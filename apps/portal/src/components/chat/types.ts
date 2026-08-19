import type {
  ArtifactDescriptor,
  ArtifactKind,
  ArtifactPreviewMode,
  ConversationChannel,
  ConversationMessage,
} from "@/lib/protocol";

export interface InlineSvgVisual {
  version: 1;
  id: string;
  kind: "svg";
  title: string;
  alt: string;
  svg: string;
}

export interface AttachmentView {
  id?: string;
  type: "image" | "document";
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  source?: string;
  relativePath?: string;
  previewUrl?: string;
  /**
   * Authoritative attachment id used to read bytes via `attachment.get`. For
   * legacy messages written before the retention table this may be absent;
   * the card then falls back to its existing (non-clickable) display.
   */
  attachmentId?: string;
  /**
   * Server-side 7-day expiry timestamp (ISO). The card renders a "保留至 …"
   * countdown; once it has passed, the card shows "附件已过期" without a
   * read/download affordance until the status is confirmed by attachment.get.
   */
  expiresAt?: string;
}

export interface ArtifactCardView {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ArtifactKind;
  previewMode: ArtifactPreviewMode;
  createdAt: string;
  checksum?: string;
  savedToMyFiles?: boolean;
  messageId: string;
  conversationId: string;
  /** Present for read-only workspace browser entries instead of indexed artifacts. */
  workspacePath?: string;
}

export interface ConversationListItem {
  conversationId: string;
  title: string;
  channel: ConversationChannel;
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  processing?: boolean;
  labelId?: string;
  position?: number;
}

export interface ChatMessageView {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "sent" | "failed" | "streaming";
  traceId?: string;
  createdAt: string;
  attachments?: AttachmentView[];
  artifacts?: ArtifactCardView[];
  inlineVisuals?: InlineSvgVisual[];
  /** Duration from the user's request to this completed assistant response. */
  processedDurationMs?: number;
  /** 本地未持久化的临时消息(乐观插入) */
  isLocal?: boolean;
}

export function toView(msg: ConversationMessage): ChatMessageView {
  const attachments = normalizeAttachments(msg.metadata?.attachments);
  const artifacts = normalizeArtifacts(msg.metadata?.artifacts, msg);
  const inlineVisuals = normalizeInlineVisuals(msg.metadata?.inlineVisuals);
  return {
    messageId: msg.messageId,
    conversationId: msg.conversationId,
    role: msg.role,
    content: msg.content,
    status: msg.status,
    traceId: msg.traceId,
    createdAt: msg.createdAt,
    attachments,
    artifacts,
    inlineVisuals,
  };
}

/** The runtime is the security authority; this only rejects malformed relay data. */
export function normalizeInlineVisuals(value: unknown): InlineSvgVisual[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const visuals = value.flatMap((item): InlineSvgVisual[] => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    const title = typeof data.title === "string" ? data.title : "";
    const alt = typeof data.alt === "string" ? data.alt : title;
    const svg = typeof data.svg === "string" ? data.svg : "";
    if (
      data.version !== 1 || data.kind !== "svg" || !id || !title || !alt ||
      svg.length === 0 || svg.length > 64 * 1024 || !/^<svg\b/i.test(svg.trim())
    ) return [];
    return [{ version: 1, id, kind: "svg", title, alt, svg }];
  });
  return visuals.length > 0 ? visuals.slice(0, 3) : undefined;
}

export function normalizeAttachments(value: unknown): AttachmentView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    const fileName = typeof data.fileName === "string" ? data.fileName : "";
    const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
    const sizeBytes = Number(data.sizeBytes || 0);
    const rawType = typeof data.type === "string" ? data.type : "";
    const type: AttachmentView["type"] = rawType === "image" ? "image" : "document";
    if (!fileName || !mimeType || !Number.isFinite(sizeBytes)) return [];
    return [{
      id: typeof data.id === "string" ? data.id : undefined,
      type,
      mimeType,
      fileName,
      sizeBytes,
      source: typeof data.source === "string" ? data.source : undefined,
      relativePath: typeof data.relativePath === "string" ? data.relativePath : undefined,
      previewUrl: typeof data.previewUrl === "string" ? data.previewUrl : undefined,
      // Backwards-compatible: older messages predate the retention table and
      // have no attachmentId/expiresAt; the card simply renders as before.
      attachmentId:
        typeof data.attachmentId === "string" ? data.attachmentId :
        typeof data.id === "string" ? data.id : undefined,
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Parses `metadata.artifacts` into typed ArtifactCardView descriptors. We
 * deliberately re-filter by message id/conversation id at click time, not
 * here, so a stale descriptor that leaks across conversation boundaries
 * cannot be opened from the wrong chat.
 */
export function normalizeArtifacts(
  value: unknown,
  msg: ConversationMessage
): ArtifactCardView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validKinds = new Set(["report", "chart", "data", "document"]);
  const validModes = new Set(["markdown", "html", "image", "pdf", "text", "table", "unsupported"]);
  const items = value.flatMap((item): ArtifactCardView[] => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    const artifactId = typeof data.artifactId === "string" ? data.artifactId : "";
    const fileName = typeof data.fileName === "string" ? data.fileName : "";
    const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
    const title = typeof data.title === "string" ? data.title : fileName;
    const sizeBytes = Number(data.sizeBytes || 0);
    const kind = typeof data.kind === "string" && validKinds.has(data.kind) ? (data.kind as ArtifactKind) : "document";
    const previewMode =
      typeof data.previewMode === "string" && validModes.has(data.previewMode)
        ? (data.previewMode as ArtifactPreviewMode)
        : "unsupported";
    const createdAt = typeof data.createdAt === "string" ? data.createdAt : msg.createdAt;
    const checksum = typeof data.checksum === "string" ? data.checksum : undefined;
    if (!artifactId || !fileName || !mimeType || !Number.isFinite(sizeBytes)) return [];
    return [
      {
        artifactId,
        title,
        fileName,
        mimeType,
        sizeBytes,
        kind,
        previewMode,
        createdAt,
        checksum,
        savedToMyFiles: data.savedToMyFiles === true,
        messageId: msg.messageId,
        conversationId: msg.conversationId,
        // Newer runtime records may carry an explicit workspace-relative
        // location. It lets the Portal reveal and focus the matching tree item
        // instead of treating it as an unrelated conversation artifact.
        workspacePath: typeof data.workspacePath === "string" ? data.workspacePath : undefined
      }
    ];
  });
  return items.length > 0 ? items : undefined;
}

export type { ArtifactDescriptor };

/** T-199 工作过程：单条时间线项（历史 trace 与实时事件统一形态）。 */
export interface WorkStepView {
  at: string;
  kind: "turn_start" | "first_token" | "tool_call" | "tool_result" | "model_fallback" | "turn_end";
  toolName?: string;
  status?: string;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
  errorExcerpt?: string;
  message?: string;
}

/** T-199 历史回看：trace.get 返回的摘要。 */
export interface TraceDetailView {
  traceId: string;
  createdAt: string;
  model: string | null;
  status: string;
  elapsedMs: number | null;
  firstTokenMs: number | null;
  totalTokens: number | null;
  cost: number | null;
  errorMessage: string | null;
  toolCalls: Array<{
    toolCallId?: string;
    toolName?: string;
    status?: string;
    startedAt?: string;
    elapsedMs?: number;
    inputChars?: number;
    outputChars?: number;
    errorExcerpt?: string;
  }>;
}

/** T-199 实时进度事件（SSE）。 */
export interface ProgressEventView {
  kind: "subscribed" | "progress";
  conversationId?: string;
  event?: WorkStepView;
}
