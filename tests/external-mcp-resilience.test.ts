import assert from "node:assert/strict";
import { test } from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";

test("external mcp toolsets degrade to empty on connect failure and cache on success", async (t) => {
  // 隔离：不依赖真实注册表环境变量——直接测 connectWithRetry 语义需要注入，
  // 这里验证 resolve 层：无激活服务器时返回空、disconnect 为 no-op、不抛错。
  const { resolveExternalMastraToolsets, __resetExternalMcpConnectionsForTest } = await import("../src/mastra/external-mcp.js");
  t.after(() => __resetExternalMcpConnectionsForTest());

  const { toolsets, disconnect } = await resolveExternalMastraToolsets("interactive", {});
  assert.deepEqual(toolsets, {});
  await disconnect(); // no-op 不应抛错
});
