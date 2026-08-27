import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";
process.env.NODE_ENV = "test";

/**
 * 微信轮附件卡片绑定契约（2026-08-27 mg 实盘案例：Excel 已生成但卡片成孤儿，
 * 网页端会话历史看不到也存不进【我的文件】）。
 *
 * 微信桥与 web 路径对齐后应满足：
 * 1. 活动轮内（markTurnStart）发布的 artifact 记录 turn_id；
 * 2. 助手消息落库后 attachArtifactsToAssistantMessage 按 turn_id 绑定卡片，
 *    message_id 回写 + metadata.artifacts 描述符合并；
 * 3. CONVERSATION_GET（网页端会话历史数据源）能读到卡片元数据；
 * 4. 助手行与 user 行共用 requestId，入站去重查询可命中；
 * 5. 轮结束后发布的 artifact 保持 turn_id 为空，不被误绑。
 */
test("微信轮发布的 artifact 绑定到助手消息并可从会话历史读出", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "weixin-artifact-binding-"));
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { mastraWorkspaceRegistry, resolveRegisteredMastraProjectRoot } = await import("../src/mastra/workspace-registry.js");
    const {
      appendConversationMessage,
      attachArtifactsToAssistantMessage,
      getAssistantMessageByRequestId,
      getConversation,
    } = await import("../src/services/conversation-log.js");
    const { markTurnEnd, markTurnStart } = await import("../src/services/conversation-turns.js");
    const { publishConversationArtifact } = await import("../src/services/conversation-artifacts.js");

    initDb();
    const userId = "weixin-binding-user";
    const projectId = "invest-agent";
    const instanceId = "invest-agent-weixin-binding-user";
    await mastraWorkspaceRegistry.bootstrap({ userId, projectId, instanceId });
    const projectRoot = await resolveRegisteredMastraProjectRoot({ userId, projectId, instanceId });
    assert.ok(projectRoot, "project root must be registered");

    const conversationId = "o9ctest@im.wechat";
    const turnId = "weixin-inbound:test-account:m1";
    const scope = { userId, projectId, instanceId, assistantId: instanceId };

    markTurnStart({ userId, instanceId, conversationId, turnId });

    const deliveriesDir = path.join(projectRoot, "deliveries");
    await mkdir(deliveriesDir, { recursive: true });
    // 绑定契约与文件类型无关；xlsx 会触发 Office Open XML 校验，用 txt 即可。
    const xlsxPath = path.join(deliveriesDir, "测试表格.txt");
    await writeFile(xlsxPath, "fake-xlsx-bytes");
    const published = await publishConversationArtifact({
      userId,
      instanceId,
      relativePath: "deliveries/测试表格.txt",
      kind: "data",
      scope: { projectId, assistantId: instanceId, conversationId, source: "artifacts.publish" },
    });
    assert.equal(published.turnId, turnId, "活动轮内发布必须记录 turn_id");

    const userMessage = appendConversationMessage({
      scope,
      conversationId,
      channel: "weixin-mobile",
      role: "user",
      content: "帮我生成一张表格",
      requestId: turnId,
      idempotencyKey: turnId,
    });
    const assistantMessage = appendConversationMessage({
      scope,
      conversationId,
      channel: "weixin-mobile",
      role: "assistant",
      content: "表格已生成",
      requestId: turnId,
    });

    const bound = attachArtifactsToAssistantMessage({
      conversationId,
      assistantMessageId: assistantMessage.messageId,
      userId,
      instanceId,
      turnId,
    });
    assert.equal(bound?.length, 1, "本发布的 artifact 必须绑到本条助手消息");
    assert.equal(bound?.[0]?.artifactId, published.artifactId);

    const artifactRow = sqlite
      .prepare("SELECT message_id AS mid, turn_id AS tid FROM conversation_artifacts WHERE artifact_id = ?")
      .get(published.artifactId) as { mid: string | null; tid: string | null };
    assert.equal(artifactRow.mid, assistantMessage.messageId);
    assert.equal(artifactRow.tid, turnId);

    const storedRow = sqlite
      .prepare("SELECT metadata FROM conversation_messages WHERE message_id = ?")
      .get(assistantMessage.messageId) as { metadata?: string };
    const storedMetadata = JSON.parse(storedRow.metadata || "{}") as {
      artifacts?: Array<{ artifactId: string; savedToMyFiles: boolean }>;
    };
    assert.equal(storedMetadata.artifacts?.[0]?.artifactId, published.artifactId);
    assert.equal(storedMetadata.artifacts?.[0]?.savedToMyFiles, false, "用户未点保存前必须保持未入库态");

    // CONVERSATION_GET 走 getConversation：网页端会话历史读得到卡片元数据。
    const history = getConversation({ userId, instanceId, projectId, conversationId });
    const assistantFromHistory = history.messages.find((message) => message.messageId === assistantMessage.messageId);
    const historyArtifacts = assistantFromHistory?.metadata?.artifacts as
      | Array<{ artifactId: string; workspacePath?: string }>
      | undefined;
    assert.equal(historyArtifacts?.[0]?.artifactId, published.artifactId);

    // 入站去重契约：助手行与 user 行共用 requestId，重复投递按 requestId 命中。
    assert.equal(
      getAssistantMessageByRequestId({ conversationId, requestId: turnId })?.messageId,
      assistantMessage.messageId,
    );

    // 轮结束后：发布不再记 turn_id，attach 不会把轮外 artifact 误绑进历史。
    markTurnEnd({ userId, instanceId, conversationId, turnId });
    const outsideTurnPath = path.join(deliveriesDir, "轮外文件.txt");
    await writeFile(outsideTurnPath, "outside-turn");
    const orphan = await publishConversationArtifact({
      userId,
      instanceId,
      relativePath: "deliveries/轮外文件.txt",
      scope: { projectId, assistantId: instanceId, conversationId, source: "artifacts.publish" },
    });
    assert.equal(orphan.turnId ?? null, null, "轮外发布必须保持 turn_id 为空");

    attachArtifactsToAssistantMessage({
      conversationId,
      assistantMessageId: assistantMessage.messageId,
      userId,
      instanceId,
      turnId,
    });
    const orphanRow = sqlite
      .prepare("SELECT message_id AS mid FROM conversation_artifacts WHERE artifact_id = ?")
      .get(orphan.artifactId) as { mid: string | null };
    assert.equal(orphanRow.mid, null, "轮外 artifact 不得被绑定");
    assert.equal(
      storedMetadata.artifacts?.length,
      1,
      "重复 attach 只重放已绑定卡片，不得把轮外 artifact 带进消息元数据",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
  }
});
