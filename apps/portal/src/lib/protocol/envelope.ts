import type { PortalProtocolVersion } from "./version";

/**
 * Connector <-> Relay 的统一消息信封(见协议 §Envelope)。
 *
 * 任何方向(请求、响应、事件、错误)都走 Envelope,通过 `type` 区分语义。
 */
export interface PortalEnvelope<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  sentAt: string;
  payload: T;
}

export interface PortalResponse<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  ok: boolean;
  sentAt: string;
  data?: T;
  error?: PortalError;
}

export type PortalErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONNECTOR_CONFLICT"
  | "CONNECTOR_OFFLINE"
  | "ASSISTANT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "INVALID_REQUEST"
  | "TIMEOUT"
  | "CONCURRENT_TASK_LIMIT"
  | "ACP_FAILED"
  | "INTERNAL_ERROR"
  | "ARTIFACT_INVALID_PATH"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_UNSUPPORTED"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_UNSAFE"
  | "ARTIFACT_SCOPE_MISMATCH"
  | "REPORT_ASSET_INVALID_PATH"
  | "REPORT_ASSET_NOT_FOUND"
  | "REPORT_ASSET_UNSUPPORTED"
  | "REPORT_ASSET_TOO_LARGE"
  // File-retention governance (added 2026-07-25). All additive: existing
  // connectors keep working, the Portal gates the new features on capability.
  | "ATTACHMENT_NOT_FOUND"
  // Legacy compatibility only. Current attachment.get returns ok:true with
  // status=expired/deleted for normal lifecycle states.
  | "ATTACHMENT_EXPIRED"
  | "ATTACHMENT_DELETED"
  | "ARTIFACT_INVALID_CURSOR"
  | "ARTIFACT_EXPIRED"
  | "ARTIFACT_DELETED"
  | "ARTIFACT_NOT_DELETABLE"
  | "ARTIFACT_DELETE_CONFIRMATION_REQUIRED"
  | "ARTIFACT_DELETE_CONFIRMATION_EXPIRED"
  | "ARTIFACT_DELETE_CONFLICT"
  | "WORKSPACE_FILE_INVALID_PATH"
  | "WORKSPACE_FILE_NOT_FOUND"
  | "WORKSPACE_FILE_FORBIDDEN"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_FILE_LIMIT_EXCEEDED"
  // Automation task errors are returned by the runtime connector. Keep the
  // public union additive so Portal routes can preserve connector error codes.
  | "AUTOMATION_INVALID_SCOPE"
  | "AUTOMATION_SCOPE_MISMATCH"
  | "AUTOMATION_TASK_NOT_FOUND"
  | "AUTOMATION_TASK_EXISTS"
  | "AUTOMATION_REVISION_NOT_FOUND"
  | "AUTOMATION_REVISION_CONFLICT"
  | "AUTOMATION_INVALID_TASK_ID"
  | "AUTOMATION_INVALID_NAME"
  | "AUTOMATION_INVALID_DESCRIPTION"
  | "AUTOMATION_INVALID_SCHEDULE"
  | "AUTOMATION_ASSET_REQUIRED"
  | "AUTOMATION_ASSET_INVALID_PATH"
  | "AUTOMATION_ASSET_UNSUPPORTED_TYPE"
  | "AUTOMATION_ASSET_TOO_LARGE"
  | "AUTOMATION_ASSET_MIME_MISMATCH"
  | "AUTOMATION_ASSET_INVALID_CONTENT"
  | "AUTOMATION_ASSET_EXISTS"
  | "AUTOMATION_ASSET_SOURCE_IMMUTABLE"
  | "AUTOMATION_ASSET_NOT_FOUND"
  | "AUTOMATION_ASSET_UNSAFE"
  | "AUTOMATION_ASSET_CHECKSUM_MISMATCH"
  | "AUTOMATION_WORKSPACE_NOT_FOUND"
  | "AUTOMATION_RUN_NOT_FOUND"
  | "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT"
  | "AUTOMATION_RUN_ALREADY_FINISHED"
  | "AUTOMATION_RUN_STATUS_INVALID"
  | "AUTOMATION_RUN_LEASE_LOST"
  | "AUTOMATION_TASK_BUSY"
  | "AUTOMATION_TASK_NOT_ACTIVE"
  | "AUTOMATION_TASK_NEEDS_ATTENTION"
  | "AUTOMATION_TASK_ARCHIVED"
  | "AUTOMATION_BATCH_INVALID"
  | "AUTOMATION_INVALID_CURSOR"
  | "AUTOMATION_DATA_CORRUPT"
  | "ASSET_INVALID_SCOPE"
  | "ASSET_NOT_FOUND"
  | "ASSET_SCOPE_MISMATCH"
  | "ASSET_UNSUPPORTED_FORMAT"
  | "ASSET_TOO_LARGE"
  | "ASSET_MIME_MISMATCH"
  | "ASSET_INVALID_CONTENT"
  | "ASSET_ARCHIVED"
  | "ASSET_VERSION_CONFLICT"
  | "ASSET_IDEMPOTENCY_CONFLICT"
  | "ASSET_COMMIT_FAILED"
  | "ASSET_PATH_UNSAFE"
  | "ASSET_CONFIRMATION_REQUIRED"
  | "ASSET_FOLDER_NOT_FOUND"
  | "ASSET_FOLDER_NAME_CONFLICT"
  | "ASSET_FOLDER_DEPTH_EXCEEDED"
  | "ASSET_FOLDER_NOT_EMPTY"
  | "UPLOAD_REQUEST_TOO_LARGE"
  | "USER_STORAGE_QUOTA_EXCEEDED"
  | "REPORT_MAPPING_NOT_FOUND";

export interface PortalError {
  code: PortalErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export const PORTAL_TYPES = {
  REGISTER: "connector.register",
  HEARTBEAT: "connector.heartbeat",
  UNREGISTER: "connector.unregister",
  CONVERSATION_LIST: "conversation.list",
  CONVERSATION_GET: "conversation.get",
  CONVERSATION_CHAT: "conversation.chat",
  CONVERSATION_CANCEL: "conversation.cancel",
  REPORT_ASSET_GET: "report.asset.get",
  REPORT_MAPPING_GET: "report.mapping.get",
  ARTIFACT_GET: "artifact.get",
  ARTIFACT_PUBLISH_LEGACY: "artifact.publish.legacy",
  ARTIFACT_EVENT: "artifact.event",
  CONVERSATION_SYNC: "conversation.sync",
  DASHBOARD_SNAPSHOT: "dashboard.snapshot",
  // Attachment reads remain current. Artifact library list is retained for
  // historical mock/schema compatibility; the current tree uses workspace.*.
  ATTACHMENT_GET: "attachment.get",
  ARTIFACT_LIBRARY_LIST: "artifact.library.list",
  WORKSPACE_FILE_LIST: "workspace.file.list",
  WORKSPACE_FILE_GET: "workspace.file.get",
  AUTOMATION_LIST: "automation.list",
  AUTOMATION_GET: "automation.get",
  AUTOMATION_CREATE: "automation.create",
  AUTOMATION_UPDATE: "automation.update",
  AUTOMATION_ACTIVATE: "automation.activate",
  AUTOMATION_PAUSE: "automation.pause",
  AUTOMATION_BATCH_ACTION: "automation.batch_action",
  AUTOMATION_RUN_NOW: "automation.run_now",
  AUTOMATION_RUNS_LIST: "automation.runs.list",
  RULE_PATROL_STATUS: "rule_patrol.status",
  MODELS_STATE: "models.state",
  USAGE_SUMMARY: "usage.summary",
  USAGE_RECORDS: "usage.records",
  RULE_PATROL_RUN_NOW: "rule_patrol.run_now",
  RULE_PATROL_RULES_LIST: "rule_patrol.rules.list",
  RULE_PATROL_RULES_CREATE: "rule_patrol.rules.create",
  RULE_PATROL_RULES_UPDATE: "rule_patrol.rules.update",
  RULE_PATROL_RULES_DELETE: "rule_patrol.rules.delete",
  RULE_PATROL_RULES_DRY_RUN: "rule_patrol.rules.dry_run",
  AUTOMATION_RUN_GET: "automation.run.get",
  AUTOMATION_ASSET_GET: "automation.asset.get",
  AUTOMATION_CONTINUE_IN_CHAT: "automation.continue_in_chat",
  ASSET_LIST: "asset.list",
  ASSET_FOLDER_LIST: "asset.folder.list",
  ASSET_FOLDER_CREATE: "asset.folder.create",
  ASSET_FOLDER_RENAME: "asset.folder.rename",
  ASSET_FOLDER_DELETE: "asset.folder.delete",
  ASSET_MOVE: "asset.move",
  ASSET_GET: "asset.get",
  ASSET_VERSION_GET: "asset.version.get",
  ASSET_VERSIONS_LIST: "asset.versions.list",
  ASSET_UPLOAD: "asset.upload",
  ASSET_CONVERSATION_SAVE: "asset.conversation.save",
  ASSET_RENAME: "asset.rename",
  ASSET_ARCHIVE: "asset.archive",
  ASSET_DELETE: "asset.delete",
  ASSET_RESTORE_VERSION: "asset.restore_version",
  ASSET_CONVERT_TO_XLSX: "asset.convert_to_xlsx",
  ASSET_REFERENCES_LIST: "asset.references.list",
  // Retained only so old route modules can return a deterministic disabled
  // response during the Portal read-only migration. The connector no longer
  // advertises or handles these commands.
  ARTIFACT_DELETE_PREPARE: "artifact.delete.prepare",
  ARTIFACT_DELETE_CONFIRM: "artifact.delete.confirm"
} as const;

export type PortalType = (typeof PORTAL_TYPES)[keyof typeof PORTAL_TYPES];
