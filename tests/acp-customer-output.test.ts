import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ResponseCollector } from "../src/acp/stdio-agent.js";
import {
  dedupeRepeatedCustomerText,
  extractFinalCustomerReply,
  isAcpDiagnosticText,
  redactSensitiveText,
  sanitizeCustomerText,
  sanitizeWeixinCustomerText,
} from "../src/lib/customer-output.js";

const metadataWarning = "Model metadata for `gpt-5.6-terra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
const goalUpdate = "Goal updated (active): Process the user's onboarding portfolio confirmation and continue to the next onboarding step.";

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

  test("does not expose ACP goal lifecycle events as customer text", () => {
    const collector = new ResponseCollector();
    collector.handleUpdate(update("agent_message_chunk", "已加入初始配置草稿。") as never);
    collector.handleUpdate(update("usage_update") as never);
    collector.handleUpdate(update("agent_message_chunk", goalUpdate) as never);

    assert.equal(collector.toText(), "已加入初始配置草稿。");
    assert.equal(isAcpDiagnosticText(goalUpdate), true);
    assert.equal(sanitizeCustomerText(`已加入初始配置草稿。\n${goalUpdate}`), "已加入初始配置草稿。");
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

describe("customer output sanitization", () => {
  test("redacts internal commands, paths, tokens, and local URLs", () => {
    const output = sanitizeCustomerText([
      "我会把已确认的策略写入策略档案。",
      "curl -X POST http://localhost:22649/api/sandbox/watchlist/add",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz",
      "日志在 /Users/combo/project/logs/service.log，临时文件 /tmp/foo.log。",
    ].join("\n"));

    for (const pattern of [
      /localhost:\d+/i,
      /\bcurl\b/i,
      /\/Users\//i,
      /\/tmp\//i,
      /Bearer\s+[A-Za-z0-9_.-]+/i,
    ]) {
      assert.doesNotMatch(output, pattern);
    }
    assert.match(output, /我会把已确认的策略写入策略档案/);
    assert.match(output, /后台命令已隐藏/);
    assert.match(output, /内部文件/);

    const redacted = redactSensitiveText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz",
    );
    assert.match(redacted, /REDACTED/);
  });

  test("keeps customer-facing markdown and replaces raw market-data URLs for WeChat", () => {
    const markdownTable = sanitizeCustomerText([
      "| 类型 | 标的 | 仓位 |",
      "|---|---|---:|",
      "| 持仓 | 赛轮轮胎 | 30% |",
    ].join("\n"));
    assert.match(markdownTable, /\| 类型 \| 标的 \| 仓位 \|/);

    const weixinText = sanitizeWeixinCustomerText([
      "- 行情：https://qt.gtimg.cn/q=sh601058",
      "- 日K：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh601058,day,,,320,qfq",
      "- 新闻：https://np-listapi.eastmoney.com/comm/wap/getListInfo?client=wap&type=1",
      "- 公告：https://www.cninfo.com.cn/new/hisAnnouncement/query?stock=601058",
      "部分实时行情标记为 stale_market_time。",
    ].join("\n"));
    assert.doesNotMatch(weixinText, /https?:\/\//i);
    assert.match(weixinText, /腾讯行情/);
    assert.match(weixinText, /腾讯日K/);
    assert.match(weixinText, /东方财富新闻/);
    assert.match(weixinText, /巨潮资讯公告/);
    assert.match(weixinText, /stale_market_time/);
  });

  test("deduplicates repeated replies and extracts the explicit final reply", () => {
    const repeated = dedupeRepeatedCustomerText([
      "我先整理成建档草案，暂不写入：",
      "【持仓】",
      "1. 赛轮轮胎：30%",
      "请回复“确认写入”，我再保存。",
      "我先整理成建档草案，暂不写入：",
      "【持仓】",
      "1. 赛轮轮胎：30%",
      "请回复“确认写入”，我再保存。",
    ].join("\n"));
    assert.equal((repeated.match(/【持仓】/g) ?? []).length, 1);

    assert.equal(
      extractFinalCustomerReply("我先读取配置。\n最终回复：\n当前持仓已记录，但缺少成本价。"),
      "当前持仓已记录，但缺少成本价。",
    );
  });
});
