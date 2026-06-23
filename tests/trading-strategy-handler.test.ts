import { test, describe, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 交易策略 CRUD 工具层测试。
 *
 * 工具层只是 WorkspaceStore 的薄包装,所以测试聚焦:
 *   - 文本回显格式
 *   - operation 路由正确
 *   - 默认 ctx(单用户试用)能工作
 */

const FAKE_USER = "test-strategy-tool-user";

let tempRoot: string;
let handleTradingStrategyTool: typeof import("../src/handlers/trading-strategy.js").handleTradingStrategyTool;
let config: typeof import("../src/lib/config.js").config;
let originalRoot: string;

before(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "ws-strategy-tool-test-"));
  ({ handleTradingStrategyTool } = await import("../src/handlers/trading-strategy.js"));
  ({ config } = await import("../src/lib/config.js"));
  originalRoot = config.workspace.root;
  config.workspace.root = tempRoot;
});

after(() => {
  config.workspace.root = originalRoot;
  rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const userDir = join(tempRoot, FAKE_USER);
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(userDir, "config"), { recursive: true });
  writeFileSync(join(userDir, "AGENTS.md"), "# test workspace\n");
});

describe("handleTradingStrategyTool - query operation", () => {
  test("空列表 → 返回友好提示", async () => {
    const out = await handleTradingStrategyTool({ operation: "query" }, { userId: FAKE_USER });
    assert.match(out, /当前没有交易策略|暂无/);
  });

  test("有策略 → 列表展示 key 和 name", async () => {
    await handleTradingStrategyTool(
      { operation: "set", key: "breakout-pullback", name: "突破回踩", body: "..." },
      { userId: FAKE_USER },
    );
    const out = await handleTradingStrategyTool({ operation: "query" }, { userId: FAKE_USER });
    assert.match(out, /突破回踩/);
    assert.match(out, /breakout-pullback/);
  });
});

describe("handleTradingStrategyTool - set operation", () => {
  test("新建 → 返回已新增,且能查到", async () => {
    const out = await handleTradingStrategyTool(
      { operation: "set", key: "value-reversal", name: "价值反转", body: "PE<10 进场" },
      { userId: FAKE_USER },
    );
    assert.match(out, /已(新增|保存|设置)/);
    const query = await handleTradingStrategyTool(
      { operation: "get", key: "value-reversal" },
      { userId: FAKE_USER },
    );
    assert.match(query, /价值反转/);
    assert.match(query, /PE<10/);
  });

  test("同 key set 第二次 → 走 upsert,数量不增", async () => {
    await handleTradingStrategyTool(
      { operation: "set", key: "k", name: "v1", body: "b1" },
      { userId: FAKE_USER },
    );
    await handleTradingStrategyTool(
      { operation: "set", key: "k", name: "v2", body: "b2" },
      { userId: FAKE_USER },
    );
    const query = await handleTradingStrategyTool({ operation: "query" }, { userId: FAKE_USER });
    // 列表里只出现一次 v2,不出现 v1
    const v1Count = (query.match(/v1/g) ?? []).length;
    assert.equal(v1Count, 0, "旧 name 不应保留");
  });
});

describe("handleTradingStrategyTool - remove operation", () => {
  test("已存在 key → 删除成功", async () => {
    await handleTradingStrategyTool(
      { operation: "set", key: "tmp", name: "临时", body: "..." },
      { userId: FAKE_USER },
    );
    const out = await handleTradingStrategyTool(
      { operation: "remove", key: "tmp" },
      { userId: FAKE_USER },
    );
    assert.match(out, /已(删除|移除)/);
  });

  test("不存在 key → 返回未找到提示,不报错", async () => {
    const out = await handleTradingStrategyTool(
      { operation: "remove", key: "non-existent" },
      { userId: FAKE_USER },
    );
    assert.match(out, /不存在|未找到|无/);
  });
});

describe("handleTradingStrategyTool - 输入校验", () => {
  test("set 缺 key → 提示需要 key", async () => {
    const out = await handleTradingStrategyTool(
      { operation: "set", name: "无 key", body: "..." } as never,
      { userId: FAKE_USER },
    );
    assert.match(out, /key|标识/);
  });

  test("set 缺 name → 提示需要 name", async () => {
    const out = await handleTradingStrategyTool(
      { operation: "set", key: "x", body: "..." } as never,
      { userId: FAKE_USER },
    );
    assert.match(out, /name|名称/);
  });
});
