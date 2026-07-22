import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ResponseCollector } from "../src/acp/stdio-agent.js";
import { isAcpDiagnosticText, sanitizeCustomerText } from "../src/lib/customer-output.js";

const metadataWarning = "Model metadata for `gpt-5.6-terra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

function update(sessionUpdate: string, text?: string) {
  return {
    sessionId: "test-session",
    update: text === undefined
      ? { sessionUpdate }
      : { sessionUpdate, content: { type: "text", text } },
  };
}

describe("ACP customer reply diagnostics", () => {
  test("keeps the last business segment when a metadata warning arrives afterward", () => {
    const collector = new ResponseCollector();
    collector.handleUpdate(update("agent_message_chunk", "持仓和观察仓已保存。") as never);
    collector.handleUpdate(update("usage_update") as never);
    collector.handleUpdate(update("agent_message_chunk", metadataWarning) as never);
    collector.handleUpdate(update("usage_update") as never);

    assert.equal(collector.toText(), "持仓和观察仓已保存。");
  });

  test("keeps business chunks when a diagnostic segment has no separating newline", () => {
    const collector = new ResponseCollector();
    collector.handleUpdate(update("agent_message_chunk", "持仓") as never);
    collector.handleUpdate(update("agent_message_chunk", "已保存。") as never);
    collector.handleUpdate(update("usage_update") as never);
    collector.handleUpdate(update("agent_message_chunk", metadataWarning) as never);

    assert.equal(collector.toText(), "持仓已保存。");
  });

  test("returns no customer reply when the only segment is diagnostic text", () => {
    const collector = new ResponseCollector();
    collector.handleUpdate(update("agent_message_chunk", metadataWarning) as never);
    collector.handleUpdate(update("usage_update") as never);

    assert.equal(collector.toText(), "");
  });

  test("removes diagnostic lines accidentally mixed into customer text", () => {
    const cleaned = sanitizeCustomerText(`持仓已保存。\n${metadataWarning}\n下一步请选择投资风格。`);

    assert.equal(cleaned, "持仓已保存。\n下一步请选择投资风格。");
    assert.equal(isAcpDiagnosticText(metadataWarning), true);
    assert.equal(isAcpDiagnosticText("这是正常的用户回复。"), false);
  });

  test("removes metadata diagnostics prefixed to a customer reply in the same chunk", () => {
    assert.equal(
      sanitizeCustomerText(`${metadataWarning}盘中简报将使用默认时段。`),
      "盘中简报将使用默认时段。"
    );
  });
});
