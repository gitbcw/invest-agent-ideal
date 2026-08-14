import type { PortalEnvelope, PortalResponse } from "./envelope";

/**
 * 通道:微信端用 weixin-mobile,网页端用 web。
 */
export type ConversationChannel = "web" | "weixin-mobile";

export type ConversationRole = "user" | "assistant" | "system";

export type ConversationMessageStatus = "pending" | "sent" | "failed";

export type ConnectorStatus = "online" | "busy" | "degraded";

export type ConnectorMode = "real" | "mock";

export type ConnectorCapability =
  | "conversation.chat"
  | "conversation.cancel"
  | "conversation.list"
  | "conversation.get"
  | "conversation.sync"
  | "conversation.attachments"
  | "report.asset.get"
  | "report.mapping.get"
  | "artifact.get"
  | "artifact.publish.legacy"
  | "artifact.event"
  | "dashboard.snapshot"
  // Historical curated-library compatibility. Current real connectors and UI
  // use workspace.file.list/get; the mock retains this for archived scenarios.
  | "artifact.library.list"
  | "attachment.get"
  | "workspace.file.list"
  | "workspace.file.get"
  | "automation.list"
  | "automation.get"
  | "automation.create"
  | "automation.update"
  | "automation.activate"
  | "automation.pause"
  | "automation.batch_action"
  | "automation.run_now"
  | "automation.runs.list"
  | "automation.run.get"
  | "automation.asset.get"
  | "automation.continue_in_chat"
  | "asset.list"
  | "asset.folder.list"
  | "asset.folder.create"
  | "asset.folder.rename"
  | "asset.folder.delete"
  | "asset.move"
  | "asset.get"
  | "asset.version.get"
  | "asset.versions.list"
  | "asset.upload"
  | "asset.conversation.save"
  | "asset.rename"
  | "asset.archive"
  | "asset.delete"
  | "asset.restore_version"
  | "asset.convert_to_xlsx"
  | "asset.references.list";

export interface ConnectorRegisterPayload {
  connectorId: string;
  assistantId: string;
  instanceId: string;
  userId: string;
  projectId: string;
  displayName?: string;
  version: string;
  startedAt: string;
  capabilities: ConnectorCapability[];
  mode: ConnectorMode;
}

export interface ConnectorRegisterResult {
  accepted: boolean;
  active: boolean;
  conflict?: {
    activeConnectorId: string;
    policy: "reject_new" | "takeover";
  };
  serverTime: string;
  heartbeatIntervalMs: number;
}

export interface ConnectorHeartbeatPayload {
  connectorId: string;
  assistantId: string;
  status: ConnectorStatus;
  activeRequests: number;
  lastActivityAt?: string;
}

export interface ConnectorHeartbeatResult {
  acknowledgedAt: string;
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  channel: ConversationChannel;
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  labelId?: string;
  position?: number;
}

export interface ConversationListRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  channel?: ConversationChannel;
  cursor?: string;
  limit: number;
}

export interface ConversationListResult {
  items: ConversationSummary[];
  nextCursor?: string;
}

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  userId: string;
  assistantId: string;
  instanceId: string;
  channel: ConversationChannel;
  role: ConversationRole;
  content: string;
  status: ConversationMessageStatus;
  traceId?: string;
  requestId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PortalAttachmentInput {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64?: string;
  downloadUrl?: string;
}

export interface ConversationGetRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  conversationId: string;
  cursor?: string;
  limit: number;
}

export interface ConversationGetResult {
  conversationId: string;
  title: string;
  messages: ConversationMessage[];
  nextCursor?: string;
}

export interface ConversationChatRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  conversationId: string;
  userMessageId: string;
  text?: string;
  attachments?: PortalAttachmentInput[];
  idempotencyKey: string;
  clientSentAt: string;
}

/** Cancel the active turn for a conversation. Scope comes from connector registration. */
export interface ConversationCancelRequest {
  conversationId: string;
}

export interface ConversationCancelResult {
  conversationId: string;
  status: "cancelled" | "no_active";
}

export interface ConversationChatResult {
  conversationId: string;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  traceId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ReportAssetGetRequest {
  relativePath: string;
}

export interface ReportAssetGetResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

export type ArtifactKind = "report" | "chart" | "data" | "document";
export type ArtifactPreviewMode =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "text"
  | "table"
  | "unsupported";

export interface ArtifactDescriptor {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ArtifactKind;
  previewMode: ArtifactPreviewMode;
  createdAt: string;
  checksum?: string;
  /** The runtime has already promoted this artifact to the user's long-term file library. */
  savedToMyFiles?: boolean;
  /** Workspace-relative location when this artifact is visible in the read-only browser. */
  workspacePath?: string;
}

export interface ArtifactGetRequest {
  artifactId: string;
}

export interface ArtifactGetResult extends ArtifactDescriptor {
  base64: string;
  sanitized: boolean;
}

export interface ArtifactPublishLegacyRequest {
  relativePath: string;
  conversationId?: string;
}

export interface ArtifactPublishLegacyResult extends ArtifactDescriptor {}

export type ArtifactEventName = "open" | "success" | "failure" | "download";

export interface ArtifactEventRequest {
  artifactId: string;
  event: ArtifactEventName;
  status?: "success" | "failure" | "denied";
  reason?: string;
}

export interface ArtifactEventResult {
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// File-retention governance (added 2026-07-25)
//
// These types mirror the runtime contract documented in
// `docs/portal-file-retention-and-library-governance-work-package.md` and
// `docs/user-portal-protocol.md` §"Attachment Get" / §"Artifact Delete".
// The browser only ever submits ids / tokens; scope (userId/instanceId) is
// injected by the connector from the authenticated session.
// ---------------------------------------------------------------------------

/**
 * Curated library category, derived by the runtime from the fixed curated
 * directories. Lets the Portal file tree group items without re-deriving the
 * mapping. `other` covers formal `artifacts.publish` files outside the fixed
 * curated directories.
 */
export type ArtifactLibraryCategory =
  | "daily"
  | "weekly"
  | "monthly"
  | "company"
  | "metrics"
  | "memory"
  | "other";

/**
 * One entry in the curated, read-only document library. The runtime builds
 * this from the authoritative artifact index — it is NOT a workspace
 * directory listing. Only `durable_library` + `visibility=library` + non-deleted
 * rows are returned, and only for files that still exist and stay within the
 * reports root after realpath (no symlink escape).
 */
export interface ArtifactLibraryItem {
  artifactId: string;
  title: string;
  fileName: string;
  /** Safe display path under `reports/`, without the `reports/` prefix. */
  displayPath: string;
  directorySegments: string[];
  mimeType: string;
  previewMode: ArtifactPreviewMode;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  checksum?: string;
  category: ArtifactLibraryCategory;
  /** True for PDF/TXT/JSON/CSV — Portal offers download only, no preview tab. */
  downloadable: boolean;
  /**
   * Routing hint: `document` opens a tab in the document workspace, `image`
   * opens the Lightbox, `download` is download-only (no new previewer).
   */
  openRoute: "document" | "image" | "download";
}

export interface ArtifactLibraryListRequest {
  cursor?: string;
  limit?: number;
}

export interface ArtifactLibraryListResult {
  items: ArtifactLibraryItem[];
  nextCursor?: string;
}

export type WorkspaceFilePreviewMode = ArtifactPreviewMode;

export interface WorkspaceFileItem {
  fileId: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  previewMode: WorkspaceFilePreviewMode;
  downloadable: boolean;
}

export interface WorkspaceFileListResult {
  items: WorkspaceFileItem[];
}

export interface WorkspaceFileGetResult extends WorkspaceFileItem {
  base64: string;
  checksum: string;
}

// ---------------------------------------------------------------------------
// Automation task protocol
//
// Scope (user/instance/project) is deliberately absent from browser request
// contracts. The authenticated Portal route forwards only these fields and
// the registered connector injects the authoritative scope before dispatch.
// Response records are also sanitized by the Portal route before reaching the
// browser; relative asset paths are task-owned paths, never absolute paths.
// ---------------------------------------------------------------------------

export type AutomationTaskStatus = "paused" | "active" | "needs_attention" | "archived";
export type AutomationTaskRunOrigin = "manual" | "scheduled";
export type AutomationTaskRunStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type AutomationTaskAssetRole = "source" | "working";

export interface AutomationSchedule {
  frequency: "daily" | "trading_days" | "weekdays" | "weekly";
  /** Local wall-clock time in HH:mm form. */
  time: string;
  /** IANA timezone, for example Asia/Shanghai. */
  timezone: string;
  /** ISO weekday numbers (1 Monday .. 7 Sunday) for weekly schedules. */
  weekdays?: number[];
}

export interface AutomationAssetUpload {
  fileName: string;
  mimeType?: string;
  /** Browser uploads use base64; the connector validates bytes and type. */
  base64: string;
}

export interface AutomationTaskAsset {
  assetId: string;
  taskId: string;
  revisionId?: string | null;
  assetRole: AutomationTaskAssetRole;
  fileName: string;
  relativePath: string;
  mimeType: string;
  extension: ".csv" | ".xlsx";
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskRevision {
  revisionId: string;
  taskId: string;
  revision: number;
  name: string;
  description?: string | null;
  schedule: AutomationSchedule;
  instruction?: string;
  inputs?: AutomationAssetBinding[];
  output?: AutomationOutputPolicy;
  delivery?: AutomationDeliveryPolicy;
  sourceAssetId?: string | null;
  workingAssetId?: string | null;
  createdAt: string;
}

export interface AutomationTask {
  taskId: string;
  status: AutomationTaskStatus;
  currentRevision: number;
  currentRevisionId?: string | null;
  nextRunAt?: string | null;
  consecutiveFailures: number;
  revision: AutomationTaskRevision;
  sourceAsset?: AutomationTaskAsset | null;
  workingAsset?: AutomationTaskAsset | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: {
    runId: string;
    status: AutomationTaskRunStatus;
    origin: AutomationTaskRunOrigin;
    finishedAt?: string | null;
    resultSummary?: string | null;
    errorMessage?: string | null;
    attempt?: number;
  };
}

export interface AutomationTaskRun {
  runId: string;
  taskId: string;
  revisionId: string;
  origin: AutomationTaskRunOrigin;
  idempotencyKey: string;
  attempt?: number;
  /** Revision number captured by this run, not the task's current revision. */
  revision?: number;
  scheduledFor?: string | null;
  status: AutomationTaskRunStatus;
  claimedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputAssetId?: string | null;
  inputVersions?: Array<{ assetId: string; versionId: string; fileName?: string }>;
  outputAssetId?: string | null;
  outputVersionId?: string | null;
  deliveryStatus?: "not_requested" | "pending" | "sent" | "suppressed" | "failed" | null;
  outputChecksum?: string | null;
  resultSummary?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
  conversationId?: string | null;
  taskName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationListResult {
  items: AutomationTask[];
  nextCursor?: string;
}

export interface AutomationRunsListResult {
  items: AutomationTaskRun[];
  nextCursor?: string;
}

export interface AutomationListQuery {
  query?: string;
  statuses?: AutomationTaskStatus[];
  frequencies?: AutomationSchedule["frequency"][];
  deliveryModes?: AutomationDeliveryPolicy["mode"][];
  outputModes?: AutomationOutputPolicy["mode"][];
  cursor?: string;
  limit?: number;
}

export interface AutomationBatchActionRequest {
  action: "pause" | "activate" | "archive";
  items: Array<{ taskId: string; expectedRevision: number }>;
  idempotencyKey: string;
}

export type AutomationBatchActionResultItem =
  | { taskId: string; ok: true; task: AutomationTask }
  | { taskId: string; ok: false; error: { code: string; message: string; retryable: boolean } };

export interface AutomationBatchActionResult {
  results: AutomationBatchActionResultItem[];
  correlationId: string;
}

export interface AutomationRunNowResult {
  run: AutomationTaskRun;
  conversationId?: string;
  assistantMessage?: ConversationMessage;
  task: AutomationTask;
}

export interface AutomationContinueInChatResult {
  conversationId: string;
  run: AutomationTaskRun;
  task: AutomationTask;
}

export interface AutomationAssetGetResult extends AutomationTaskAsset {
  base64: string;
}

export type AutomationAssetFormat = "markdown" | "html" | "csv" | "xlsx" | "pdf" | "png" | "jpeg" | "webp" | "svg";
export type AutomationVersionPolicy = "latest" | "fixed";
export interface AutomationAssetBinding {
  assetId: string;
  role: "input" | "update_target";
  versionPolicy: AutomationVersionPolicy;
  versionId?: string;
}
export type AutomationOutputPolicy =
  | { mode: "none" }
  | { mode: "agent" }
  | { mode: "create"; format: AutomationAssetFormat; fileName: string; titleTemplate?: string }
  | { mode: "update"; assetId: string; versionPolicy: "latest"; expectedVersionId?: string };
export type AutomationDeliveryPolicy =
  | { mode: "none" }
  | { mode: "wechat_summary" }
  | { mode: "wechat_on_condition"; conditionVersion: 1 };

export interface UserAssetVersion {
  versionId: string;
  assetId: string;
  versionNumber: number;
  fileName: string;
  format: AutomationAssetFormat;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  source: "upload" | "conversation" | "automation" | "restore" | "system";
  conversationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  createdAt: string;
}
export interface UserAsset {
  assetId: string;
  name: string;
  folderId: string | null;
  status: "active" | "archived";
  currentVersionId: string | null;
  currentVersion: UserAssetVersion | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}
export interface UserAssetVersionPayload extends UserAssetVersion { base64: string; }
export interface StorageUsage { usedBytes: number; reservedBytes: number; limitBytes: number; availableBytes: number; }
export interface ReportAssetMapping { mappingId: string; reportId: string; title: string; fileName: string; mimeType: string; sizeBytes: number; backingAssetId: string | null; backingVersionId: string | null; createdAt: string; }
export interface UserAssetCatalogItem extends UserAsset {
  catalogId: string;
  catalogKind: "asset" | "report";
  sources: Array<"upload" | "conversation" | "automation" | "report" | "restore" | "system">;
  reportMappingId?: string;
  reportId?: string;
  reportReadPath?: string | null;
}
export interface UserAssetFolder { folderId: string; parentFolderId: string | null; name: string; createdAt: string; updatedAt: string; }
export interface UserAssetListResult { items: UserAsset[]; folders?: UserAssetFolder[]; catalog?: UserAssetCatalogItem[]; reportMappings?: ReportAssetMapping[]; storageUsage?: StorageUsage; }
export interface UserAssetUploadBatchResult { items: Array<{ index: number; fileName: string; ok: true; asset: UserAsset } | { index: number; fileName: string; ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }>; }
export interface UserAssetVersionsResult { items: UserAssetVersion[]; }
export interface UserAssetReferencesResult {
  taskBindings: Array<{ bindingId: string; taskId: string; revisionId: string; role: string; versionPolicy: string; versionId: string | null; createdAt: string }>;
  provenance: UserAssetVersion[];
}

// Runtime-facing aliases retained for callers that share the service type
// vocabulary (`*Record` / `*Payload`) while keeping the browser contract
// free of scope columns.
export type AutomationTaskRecord = AutomationTask;
export type AutomationTaskRevisionRecord = AutomationTaskRevision;
export type AutomationTaskAssetRecord = AutomationTaskAsset;
export type AutomationTaskRunRecord = AutomationTaskRun;
export type AutomationTaskAssetPayload = AutomationAssetGetResult;
export type AutomationTaskRunResult = AutomationRunNowResult;
export type AutomationTaskRunListResult = AutomationRunsListResult;

export interface AutomationCreateRequest {
  name: string;
  description?: string | null;
  schedule: AutomationSchedule;
  instruction?: string;
  inputs?: AutomationAssetBinding[];
  output?: AutomationOutputPolicy;
  delivery?: AutomationDeliveryPolicy;
  sourceAsset?: AutomationAssetUpload;
}

export interface AutomationUpdateRequest {
  taskId: string;
  expectedRevision?: number;
  name?: string;
  description?: string | null;
  schedule?: AutomationSchedule;
  instruction?: string;
  inputs?: AutomationAssetBinding[];
  output?: AutomationOutputPolicy;
  delivery?: AutomationDeliveryPolicy;
  sourceAsset?: AutomationAssetUpload;
}

export interface AutomationTaskActionRequest {
  taskId: string;
  expectedRevision?: number;
}

export interface AutomationRunNowRequest {
  taskId: string;
  idempotencyKey?: string;
}

export interface AutomationRunsListRequest {
  taskId?: string;
  query?: string;
  statuses?: AutomationTaskRunStatus[];
  origins?: AutomationTaskRunOrigin[];
  deliveryStatuses?: string[];
  hasOutput?: boolean;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface AutomationRunGetRequest {
  runId: string;
}

export interface AutomationAssetGetRequest {
  assetId: string;
}

export interface AutomationContinueInChatRequest {
  runId: string;
}

export type AutomationListEnvelope = PortalEnvelope<Record<string, never>>;
export type AutomationListResponse = PortalResponse<AutomationListResult>;
export type AutomationGetResponse = PortalResponse<AutomationTask>;
export type AutomationCreateResponse = PortalResponse<AutomationTask>;
export type AutomationUpdateResponse = PortalResponse<AutomationTask>;
export type AutomationActionResponse = PortalResponse<AutomationTask>;
export type AutomationRunNowResponse = PortalResponse<AutomationRunNowResult>;
export type AutomationRunsListResponse = PortalResponse<AutomationRunsListResult>;
export type AutomationRunGetResponse = PortalResponse<AutomationTaskRun>;
export type AutomationAssetGetResponse = PortalResponse<AutomationAssetGetResult>;
export type AutomationContinueInChatResponse = PortalResponse<AutomationContinueInChatResult>;

export interface AttachmentGetRequest {
  attachmentId: string;
}

/**
 * Active attachment read: bytes are returned. The Portal must verify the
 * checksum (when present) against the decoded bytes, exactly like artifact
 * reads. `expiresAt` is the authoritative 7-day boundary; reading never
 * extends it.
 */
export interface AttachmentGetActiveResult {
  attachmentId: string;
  status: "active";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum?: string;
  storedAt: string;
  expiresAt: string;
  base64: string;
}

/**
 * Expired / deleted attachment read: bytes are NOT returned. The card keeps
 * the metadata so the Portal can render the right state ("附件已过期" /
 * "附件已删除") without a perpetual loading spinner.
 */
export interface AttachmentGetStatusResult {
  attachmentId: string;
  status: "expired" | "deleted";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string;
}

export type AttachmentGetResult = AttachmentGetActiveResult | AttachmentGetStatusResult;

export interface ArtifactDeletePrepareRequest {
  artifactId: string;
}

/**
 * Step 1 of the two-step delete flow. `tokenId` is single-use, short-lived
 * (10 minutes) and bound to user/instance/artifact/path/checksum. The Portal
 * MUST surface every entry of `impactNotes` in its confirmation dialog.
 * `expiresAt` here is the token expiry, NOT the file TTL.
 */
export interface ArtifactDeletePrepareResult {
  tokenId: string;
  artifactId: string;
  title: string;
  fileName: string;
  displayPath: string;
  sizeBytes: number;
  category: ArtifactLibraryCategory;
  expiresAt: string;
  impactNotes: string[];
}

export interface ArtifactDeleteConfirmRequest {
  tokenId: string;
}

/**
 * Step 2 of the delete flow. The file has been moved into the hidden trash
 * area (`.trash/artifacts/<opaque-id>/...`) and every same-path version has
 * been tombstoned. The Portal should close matching tabs and refresh the
 * library tree. `purgeAt` is the 30-day hidden-recovery window boundary.
 */
export interface ArtifactDeleteConfirmResult {
  artifactId: string;
  deletedVersions: number;
  trashRelativePath: string;
  purgeAt: string;
}

export interface ConversationSyncPayload {
  assistantId: string;
  instanceId: string;
  userId: string;
  conversations: ConversationSummary[];
  messages: ConversationMessage[];
  syncCursor?: string;
  fullSnapshot: boolean;
}

export interface DashboardSnapshotRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
}

export interface DashboardSnapshotResult {
  assistantOnline: boolean;
  latestReviewAt?: string;
  pendingAlertCount?: number;
  recentConversationCount?: number;
}

export type RegisterEnvelope = PortalEnvelope<ConnectorRegisterPayload>;
export type RegisterResponse = PortalResponse<ConnectorRegisterResult>;
export type HeartbeatEnvelope = PortalEnvelope<ConnectorHeartbeatPayload>;
export type HeartbeatResponse = PortalResponse<ConnectorHeartbeatResult>;
export type ListEnvelope = PortalEnvelope<ConversationListRequest>;
export type ListResponse = PortalResponse<ConversationListResult>;
export type GetEnvelope = PortalEnvelope<ConversationGetRequest>;
export type GetResponse = PortalResponse<ConversationGetResult>;
export type ChatEnvelope = PortalEnvelope<ConversationChatRequest>;
export type ChatResponse = PortalResponse<ConversationChatResult>;
export type CancelEnvelope = PortalEnvelope<ConversationCancelRequest>;
export type CancelResponse = PortalResponse<ConversationCancelResult>;
export type SyncEnvelope = PortalEnvelope<ConversationSyncPayload>;
export type DashboardEnvelope = PortalEnvelope<DashboardSnapshotRequest>;
export type DashboardResponse = PortalResponse<DashboardSnapshotResult>;
