/**
 * @deprecated 保留向后兼容,实际逻辑已迁移到 stdio-agent.ts 的注册中心。
 * 新代码请直接使用 src/acp/stdio-agent.ts 里的 getCurrentAcpAgent() 等函数。
 */

export {
  StdioAcpAgent,
  getCurrentAcpAgent,
  startDefaultAcp,
  disposeAllAcp,
  switchAcpBackend,
  listAcpBackends,
  loadCurrentBackendId,
  ACP_BACKENDS,
  type AcpBackendId,
  type AcpBackendDef,
  type AcpBackendStatus,
} from "./stdio-agent.js";

// 兼容旧导出。注意:startCodexAcp 不再启动 codex,而是启动当前选中的 backend(默认 kimi)。
export const startCodexAcp = async () => {
  const { startDefaultAcp } = await import("./stdio-agent.js");
  await startDefaultAcp();
};

export const disposeCodexAcp = () => {
  // disposeCodexAcp 历史语义是"退出时清理",我们清理全部实例。
  // 单独 dispose codex 的能力通过 switchAcpBackend 间接实现。
  void import("./stdio-agent.js").then(({ disposeAllAcp }) => disposeAllAcp());
};

export async function getCodexAcpStatus() {
  const { listAcpBackends } = await import("./stdio-agent.js");
  const { backends } = await listAcpBackends();
  return backends.find((b) => b.id === "codex") ?? null;
}
