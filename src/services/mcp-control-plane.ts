/**
 * MCP 控制面 (T-243 Phase 2)。
 *
 * 职责:把 per-server 的运行时启停覆盖 (mcp_server_overrides) 应用到 McpRegistry。
 *
 * 启停模型 (借鉴 ToolRegistry disable(name, reason) 语义):
 *   - env 是启动时基线 (由 activateIf 规则求值,registerExternalMcpServers 决定是否注册)。
 *   - DB 覆盖是运行时层,优先级高于 env 基线:存在覆盖行时按覆盖值启停,不存在时保持 env 基线。
 *   - 覆盖只作用于"已注册"的 server;未注册的 (env 未激活) 写覆盖无效 (避免凭空启用未配置的 server)。
 *
 * 安全约束:
 *   - 覆盖不得绕过 activation 的注册门:未注册的 server_id 拒绝写覆盖 (返回 false)。
 *   - 覆盖不影响 trustClass / 安全边界 (这些在注册时由 validateRegistration 固化)。
 */

import { sqlite } from "../db/index.js";
import { getMcpRegistry } from "../acp/mcp-registry.js";

export type McpServerOverride = {
  serverId: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
};

/**
 * 读取一条覆盖记录。不存在返回 null。
 * SQLite 存 INTEGER (0/1),这里转成 boolean。
 */
export function readMcpServerOverride(serverId: string): McpServerOverride | null {
  const row = sqlite
    .prepare("SELECT server_id AS serverId, enabled, reason, updated_at AS updatedAt FROM mcp_server_overrides WHERE server_id = ?")
    .get(serverId) as { serverId: string; enabled: number; reason: string | null; updatedAt: string } | undefined;
  if (!row) return null;
  return { serverId: row.serverId, enabled: row.enabled === 1, reason: row.reason, updatedAt: row.updatedAt };
}

/**
 * 读取全部覆盖记录 (UI 展示用)。
 */
export function readAllMcpServerOverrides(): McpServerOverride[] {
  const rows = sqlite
    .prepare("SELECT server_id AS serverId, enabled, reason, updated_at AS updatedAt FROM mcp_server_overrides ORDER BY updated_at DESC")
    .all() as Array<{ serverId: string; enabled: number; reason: string | null; updatedAt: string }>;
  return rows.map((row) => ({ serverId: row.serverId, enabled: row.enabled === 1, reason: row.reason, updatedAt: row.updatedAt }));
}

/**
 * 写一条覆盖 (upsert) 并立即应用到 registry。
 *
 * 返回值:
 *   - true: 覆盖已写入并应用。
 *   - false: server 未注册 (env 未激活),拒绝写覆盖 —— 启停不能凭空启用未配置的 server。
 *
 * reason 可选,记录启停理由 (审计);为空时存 null。
 */
export function applyMcpServerOverride(
  serverId: string,
  enabled: boolean,
  reason?: string,
): boolean {
  const registry = getMcpRegistry();
  const reg = registry.getRegistration(serverId);
  if (!reg) return false; // 未注册的 server 拒绝覆盖
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO mcp_server_overrides (server_id, enabled, reason, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(server_id) DO UPDATE SET enabled=excluded.enabled, reason=excluded.reason, updated_at=excluded.updated_at",
    )
    .run(serverId, enabled ? 1 : 0, reason?.trim() || null, now);
  // 立即应用到进程内 registry 单例
  registry.setEnabled(serverId, enabled);
  return true;
}

/**
 * 清除一条覆盖 (回到 env 基线)。
 * 清除后按 activation 规则重新求值并应用 —— 但 env 基线在进程启动时已固化,
 * 这里只把覆盖行删除,registry 的 enabled 字段保持当前值 (下次重启回归 env 基线)。
 */
export function clearMcpServerOverride(serverId: string): boolean {
  const result = sqlite.prepare("DELETE FROM mcp_server_overrides WHERE server_id = ?").run(serverId);
  return result.changes > 0;
}

/**
 * 启动时把 DB 覆盖应用到 registry 单例。
 * 在 getMcpRegistry() 构造 + registerExternalMcpServers 之后调用一次。
 * 幂等:每条覆盖只在 server 已注册时生效。
 */
export function applyMcpServerOverridesOnStartup(): void {
  const registry = getMcpRegistry();
  const overrides = readAllMcpServerOverrides();
  for (const override of overrides) {
    if (registry.getRegistration(override.serverId)) {
      registry.setEnabled(override.serverId, override.enabled);
    }
  }
}
