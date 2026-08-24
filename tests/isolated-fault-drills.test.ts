import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * WP5 隔离故障演练（契约：docs/isolated-fault-drill-matrix.md）。
 * F1/F3 在本文件提供可重复注入 fixture；F2/F4 的可重复记录由
 * tests/external-mcp-resilience.test.ts、tests/external-mcp-observer.test.ts、
 * tests/push-queue-concurrency.test.ts 承担（见演练记录文档）。
 * 全部隔离：本地假网关 / 临时 DB，不触碰生产。
 */

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-fault-drills-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

test("F1a provider error: gateway 503 classifies the turn as a failed terminal state with zero side effects", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const userId = "fault-drill-f1a";
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "upstream unavailable", code: "model_overloaded" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const { runMastraTurn } = await import("../src/mastra/run-turn.js");
    const { createMastraToolMap } = await import("../src/mastra/tools/mastra-tools.js");
    const auditsBefore = sqlite.prepare("SELECT count(*) AS n FROM sandbox_audit_logs WHERE user_id = ?").get(userId) as { n: number };
    const messagesBefore = sqlite.prepare("SELECT count(*) AS n FROM conversation_messages WHERE user_id = ?").get(userId) as { n: number };
    const tools = await createMastraToolMap({ userId, instanceId: "fault-drill-f1a" });
    const startedAt = Date.now();
    await assert.rejects(
      () => runMastraTurn({ conversationId: "fault-drill-f1a", text: "fault drill", timeoutMs: 10_000 }, {
        gateway: { provider: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test-key", defaultModel: "test" },
        agentOptions: { tools },
      }),
      (error: unknown) => {
        // 明确失败终态：异常带可分类信息（HTTP 状态/上游错误），不是静默成功。
        const text = String((error as Error)?.message ?? error);
        assert.match(text, /503|unavailable|overloaded|error/i);
        return true;
      },
    );
    // 预算内失败：10 秒预算，503 立即失败，远小于预算。
    assert.ok(Date.now() - startedAt < 9_000, "provider error must fail inside the turn budget");
    assert.ok(requestCount >= 1, "the gateway actually saw the request");
    // 副作用检查：失败回合不产生任何服务审计/消息写入。
    const auditsAfter = sqlite.prepare("SELECT count(*) AS n FROM sandbox_audit_logs WHERE user_id = ?").get(userId) as { n: number };
    const messagesAfter = sqlite.prepare("SELECT count(*) AS n FROM conversation_messages WHERE user_id = ?").get(userId) as { n: number };
    assert.equal(auditsAfter.n, auditsBefore.n);
    assert.equal(messagesAfter.n, messagesBefore.n);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("F1b first-token hang: the turn times out within its budget and leaves no side effects", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const userId = "fault-drill-f1b";
  const server = http.createServer(() => {
    // 接受请求但永不响应：注入首字挂起。
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const { runMastraTurn } = await import("../src/mastra/run-turn.js");
    const { createMastraToolMap } = await import("../src/mastra/tools/mastra-tools.js");
    const tools = await createMastraToolMap({ userId, instanceId: "fault-drill-f1b" });
    const timeoutMs = 1_200;
    const startedAt = Date.now();
    await assert.rejects(
      () => runMastraTurn({ conversationId: "fault-drill-f1b", text: "fault drill hang", timeoutMs }, {
        gateway: { provider: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test-key", defaultModel: "test" },
        agentOptions: { tools },
      }),
    );
    const elapsed = Date.now() - startedAt;
    // 预算被尊重：在超时预算内收敛为明确失败，且有余量上限防挂死。
    assert.ok(elapsed >= timeoutMs - 400, `timeout should be near the budget (elapsed=${elapsed}ms)`);
    assert.ok(elapsed < 15_000, `timeout must not hang far beyond budget (elapsed=${elapsed}ms)`);
    const auditsAfter = sqlite.prepare("SELECT count(*) AS n FROM sandbox_audit_logs WHERE user_id = ?").get(userId) as { n: number };
    const messagesAfter = sqlite.prepare("SELECT count(*) AS n FROM conversation_messages WHERE user_id = ?").get(userId) as { n: number };
    assert.equal(auditsAfter.n, 0);
    assert.equal(messagesAfter.n, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("F3 connector: unknown commands and stale protocol replays end in explicit error envelopes, not hangs", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const { __test__ } = await import("../src/portal/connector.js");
  const scope = {
    userId: "fault-drill-f3",
    assistantId: "fault-drill-f3",
    instanceId: "fault-drill-f3",
    projectId: "invest-agent",
    connectorId: "fault-drill-connector",
    displayName: "fault drill",
  };
  const command = (type: string, protocolVersion: string) => ({
    protocolVersion,
    requestId: `fault-drill-${Math.random()}`,
    type,
    sentAt: new Date().toISOString(),
    payload: {},
  });

  // 未知命令：明确 error 信封（非 retryable），不挂起、不留半程状态。
  const unknown = await __test__.handleCommand(scope, command("conversation.nonsense", "2026-07-04"));
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error && typeof unknown.error.code === "string");
  assert.equal(unknown.error.retryable, false);

  // 旧协议客户端在重连后重放 asset 命令：协议门给出显式
  // PROTOCOL_VERSION_UNSUPPORTED，而不是静默执行或挂起——断连/重放路径有明确终态。
  const stale = await __test__.handleCommand(scope, command("asset.list", "1999-01-01"));
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "PROTOCOL_VERSION_UNSUPPORTED");
  assert.equal(stale.error?.retryable, false);

  // 副作用检查：两个失败信封均不产生会话/消息行。
  const sessions = sqlite.prepare("SELECT count(*) AS n FROM conversation_sessions WHERE user_id = ?").get(scope.userId) as { n: number };
  const messages = sqlite.prepare("SELECT count(*) AS n FROM conversation_messages WHERE user_id = ?").get(scope.userId) as { n: number };
  assert.equal(sessions.n, 0);
  assert.equal(messages.n, 0);

  // 取消/迟到结果/孤儿回合的一致性由 tests/portal-conversation-cancel.test.ts 覆盖；
  // 自动化重放幂等由 tests/automation-portal-contract.test.ts 与 automation 系列覆盖。
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});
