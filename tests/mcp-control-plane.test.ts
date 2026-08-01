import assert from "node:assert/strict";
import test from "node:test";
import { initDb, sqlite } from "../src/db/index.js";
import {
  applyMcpServerOverride,
  applyMcpServerOverridesOnStartup,
  clearMcpServerOverride,
  readAllMcpServerOverrides,
  readMcpServerOverride,
} from "../src/services/mcp-control-plane.js";
import {
  getMcpRegistry,
  registerExternalMcpServers,
  resetMcpRegistryForTest,
  buildBuiltinServiceToolsRegistration,
  type McpServerRegistration,
} from "../src/acp/mcp-registry.js";

// 控制面操作作用于全局 registry 单例。用一个隔离的 test server,每个 test 显式清理。
const TEST_SERVER_ID = "control-plane-test-server";

function ensureTestServerInGlobalRegistry(): void {
  resetMcpRegistryForTest();
  // 触发全局单例构造 (含 service-tools + 按 env 注册外部 server;此处 env 为空,外部不激活)
  registerExternalMcpServers(getMcpRegistry(), {});
  const registry = getMcpRegistry();
  if (!registry.getRegistration(TEST_SERVER_ID)) {
    const reg: McpServerRegistration = {
      id: TEST_SERVER_ID,
      owner: "external",
      enabled: true,
      trustClass: "external-readonly",
      transport: { kind: "http", url: "<env:TEST_MCP_URL>", requiredEnvRefs: ["TEST_MCP_URL"] },
      sessionKinds: ["interactive"],
    };
    registry.register(reg);
  }
}

function cleanupOverride(): void {
  sqlite.prepare("DELETE FROM mcp_server_overrides WHERE server_id = ?").run(TEST_SERVER_ID);
}

test("applyMcpServerOverride writes, persists, and applies to registry", () => {
  initDb();
  ensureTestServerInGlobalRegistry();
  cleanupOverride();
  try {
    const registry = getMcpRegistry();
    assert.equal(registry.getRegistration(TEST_SERVER_ID)?.enabled, true);

    const ok = applyMcpServerOverride(TEST_SERVER_ID, false, "禁用测试");
    assert.equal(ok, true);
    assert.equal(registry.getRegistration(TEST_SERVER_ID)?.enabled, false);

    const stored = readMcpServerOverride(TEST_SERVER_ID);
    assert.ok(stored);
    assert.equal(stored.enabled, false);
    assert.equal(stored.reason, "禁用测试");
  } finally {
    cleanupOverride();
    resetMcpRegistryForTest();
  }
});

test("applyMcpServerOverride rejects unregistered server id", () => {
  initDb();
  ensureTestServerInGlobalRegistry();
  cleanupOverride();
  try {
    // 未注册的 server_id 应拒绝写覆盖 (不能凭空启用未配置的 server)
    const ok = applyMcpServerOverride("nonexistent-server-xyz", true);
    assert.equal(ok, false);
    assert.equal(readMcpServerOverride("nonexistent-server-xyz"), null);
  } finally {
    cleanupOverride();
    resetMcpRegistryForTest();
  }
});

test("applyMcpServerOverride is idempotent (upsert) and updates reason", () => {
  initDb();
  ensureTestServerInGlobalRegistry();
  cleanupOverride();
  try {
    applyMcpServerOverride(TEST_SERVER_ID, false, "第一次");
    applyMcpServerOverride(TEST_SERVER_ID, true, "第二次");
    const stored = readMcpServerOverride(TEST_SERVER_ID);
    assert.ok(stored);
    assert.equal(stored.enabled, true);
    assert.equal(stored.reason, "第二次");
    // 只有一行 (upsert 不是 insert)
    assert.equal(readAllMcpServerOverrides().filter((o) => o.serverId === TEST_SERVER_ID).length, 1);
  } finally {
    cleanupOverride();
    resetMcpRegistryForTest();
  }
});

test("clearMcpServerOverride removes the row", () => {
  initDb();
  ensureTestServerInGlobalRegistry();
  cleanupOverride();
  try {
    applyMcpServerOverride(TEST_SERVER_ID, false, "待清除");
    assert.ok(readMcpServerOverride(TEST_SERVER_ID));
    const removed = clearMcpServerOverride(TEST_SERVER_ID);
    assert.equal(removed, true);
    assert.equal(readMcpServerOverride(TEST_SERVER_ID), null);
    // 再清一次返回 false
    assert.equal(clearMcpServerOverride(TEST_SERVER_ID), false);
  } finally {
    cleanupOverride();
    resetMcpRegistryForTest();
  }
});

test("applyMcpServerOverridesOnStartup applies stored overrides to registry on boot", () => {
  initDb();
  ensureTestServerInGlobalRegistry();
  cleanupOverride();
  try {
    // 先写一条 disable 覆盖,然后重置 registry (模拟重启后 registry 回到 enabled=true 基线)
    applyMcpServerOverride(TEST_SERVER_ID, false, "重启前禁用");
    // 手动把 registry 的 enabled 拨回 true (模拟 env 基线)
    getMcpRegistry().setEnabled(TEST_SERVER_ID, true);
    assert.equal(getMcpRegistry().getRegistration(TEST_SERVER_ID)?.enabled, true);

    // 启动时应用覆盖 → 应回到 disabled
    applyMcpServerOverridesOnStartup();
    assert.equal(getMcpRegistry().getRegistration(TEST_SERVER_ID)?.enabled, false);
  } finally {
    cleanupOverride();
    resetMcpRegistryForTest();
  }
});
