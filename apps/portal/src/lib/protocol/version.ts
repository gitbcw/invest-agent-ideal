/**
 * Portal 协议版本(见 user-portal-protocol.md §Versioning)。
 * 破坏性变更必须升级此版本。
 */
export const PORTAL_PROTOCOL_VERSION = "2026-08-05" as const;
export const LEGACY_PORTAL_PROTOCOL_VERSION = "2026-07-04" as const;

export type PortalProtocolVersion = typeof PORTAL_PROTOCOL_VERSION | typeof LEGACY_PORTAL_PROTOCOL_VERSION;
