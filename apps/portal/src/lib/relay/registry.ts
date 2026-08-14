import type { WebSocket } from "ws";

import type {
  ConnectorCapability,
  ConnectorMode,
  ConnectorStatus
} from "@/lib/protocol";

export interface ConnectorInfo {
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
  registeredAt: string;
  lastHeartbeatAt: string;
  lastActivityAt?: string;
  status: ConnectorStatus;
  activeRequests: number;
  socket: WebSocket;
}

function connectorPriority(connectorId: string): number {
  if (connectorId.startsWith("volcano-prod-")) return 100;
  return 0;
}

/**
 * Connector 注册表。
 *
 * 同一 assistantId 只允许一个 active connector。默认 reject_new；
 * 火山云生产 connector 可接管旧的低优先级本机 connector。
 */
export class ConnectorRegistry {
  private byAssistant = new Map<string, ConnectorInfo>();
  private byConnector = new Map<string, ConnectorInfo>();

  register(info: ConnectorInfo): {
    accepted: boolean;
    replaced?: ConnectorInfo;
    conflict?: { activeConnectorId: string; policy: "reject_new" | "takeover" };
  } {
    const existing = this.byAssistant.get(info.assistantId);
    if (existing && existing.connectorId !== info.connectorId) {
      if (connectorPriority(info.connectorId) > connectorPriority(existing.connectorId)) {
        this.unregister(existing.connectorId);
        this.byConnector.set(info.connectorId, info);
        this.byAssistant.set(info.assistantId, info);
        return { accepted: true, replaced: existing };
      }
      return {
        accepted: false,
        conflict: {
          activeConnectorId: existing.connectorId,
          policy: "reject_new"
        }
      };
    }
    this.byConnector.set(info.connectorId, info);
    this.byAssistant.set(info.assistantId, info);
    return { accepted: true };
  }

  heartbeat(connectorId: string, payload: { status: ConnectorStatus; activeRequests: number; lastActivityAt?: string }): boolean {
    const info = this.byConnector.get(connectorId);
    if (!info) return false;
    info.lastHeartbeatAt = new Date().toISOString();
    info.status = payload.status;
    info.activeRequests = payload.activeRequests;
    if (payload.lastActivityAt) info.lastActivityAt = payload.lastActivityAt;
    return true;
  }

  unregister(connectorId: string): ConnectorInfo | null {
    const info = this.byConnector.get(connectorId);
    if (!info) return null;
    this.byConnector.delete(connectorId);
    const current = this.byAssistant.get(info.assistantId);
    if (current && current.connectorId === connectorId) {
      this.byAssistant.delete(info.assistantId);
    }
    return info;
  }

  getByAssistant(assistantId: string): ConnectorInfo | null {
    return this.byAssistant.get(assistantId) ?? null;
  }

  getByConnector(connectorId: string): ConnectorInfo | null {
    return this.byConnector.get(connectorId) ?? null;
  }

  list(): ConnectorInfo[] {
    return Array.from(this.byConnector.values());
  }

  /**
   * 标记所有超时未心跳的 connector 为离线。
   * 返回被清理的 connectorId 列表。
   */
  reapStale(heartbeatIntervalMs: number, now = Date.now()): string[] {
    const stale: string[] = [];
    const maxGapMs = heartbeatIntervalMs * 3;
    for (const info of this.byConnector.values()) {
      const last = Date.parse(info.lastHeartbeatAt);
      if (Number.isFinite(last) && now - last > maxGapMs) {
        stale.push(info.connectorId);
      }
    }
    for (const id of stale) {
      this.unregister(id);
    }
    return stale;
  }
}

const GLOBAL_KEY = "__PORTAL_CONNECTOR_REGISTRY__";

interface GlobalWithRegistry {
  [GLOBAL_KEY]?: ConnectorRegistry;
}

function readGlobal(): ConnectorRegistry {
  const g = globalThis as unknown as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new ConnectorRegistry();
    console.log("[registry] new ConnectorRegistry instance created");
  }
  return g[GLOBAL_KEY]!;
}

/**
 * 通过 globalThis 单例化,避免在 Next.js dev 模式下 webpack 编译链路与主进程(esbuild/tsx)
 * 各自维护独立的模块实例。
 */
export function getGlobalRegistry(): ConnectorRegistry {
  return readGlobal();
}
