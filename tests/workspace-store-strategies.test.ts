import { test, describe, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WorkspaceStore 交易策略 CRUD 测试
 *
 * 测试目标:覆盖 docs/trading-strategy-design.md §10.2 列出的 6 个用例。
 * 用 os.tmpdir() 真实写盘,不 mock fs。
 */

const FAKE_USER = "test-strategy-user";

let tempRoot: string;
let WorkspaceStore: typeof import("../src/lib/workspace-store.js").WorkspaceStore;
let config: typeof import("../src/lib/config.js").config;
let originalRoot: string;

before(async () => {
  // 临时 workspaces 根目录
  tempRoot = mkdtempSync(join(tmpdir(), "ws-strategy-test-"));
  // 动态 import,以便先改 config
  ({ WorkspaceStore } = await import("../src/lib/workspace-store.js"));
  ({ config } = await import("../src/lib/config.js"));
  originalRoot = config.workspace.root;
  config.workspace.root = tempRoot;
});

after(() => {
  config.workspace.root = originalRoot;
  rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例独立的 user 目录
  const userDir = join(tempRoot, FAKE_USER);
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(userDir, "config"), { recursive: true });
  // AGENTS.md 是 ensureReady 的标志文件
  writeFileSync(join(userDir, "AGENTS.md"), "# test workspace\n");
});

describe("WorkspaceStore trading strategies - 空场景", () => {
  test("空 yaml → readTradingStrategies() 返回 []", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    const result = await store.readTradingStrategies();
    assert.deepEqual(result, []);
  });
});

describe("WorkspaceStore trading strategies - 写入", () => {
  test("writeTradingStrategy 新增 → 再读能读出来", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeTradingStrategy({
      key: "breakout-pullback",
      name: "突破回踩",
      applicability: "主板趋势股",
      body: "突破 20 日线进场",
      enabled: true,
    });

    const list = await store.readTradingStrategies();
    assert.equal(list.length, 1);
    assert.equal(list[0].key, "breakout-pullback");
    assert.equal(list[0].name, "突破回踩");
    assert.equal(list[0].body, "突破 20 日线进场");
  });

  test("writeTradingStrategy 不传 created_at → 自动填今天", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeTradingStrategy({
      key: "value-reversal",
      name: "价值反转",
      body: "PE < 10 进场",
      enabled: true,
    });
    const list = await store.readTradingStrategies();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(list[0].created_at, today);
    assert.equal(list[0].updated_at, today);
  });
});

describe("WorkspaceStore trading strategies - upsert", () => {
  test("同 key 调 writeTradingStrategy → upsert,字段覆盖,数量不增", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeTradingStrategy({
      key: "breakout-pullback",
      name: "突破回踩",
      body: "v1",
      enabled: true,
    });
    await store.writeTradingStrategy({
      key: "breakout-pullback",
      name: "突破回踩改",
      body: "v2-更新",
      enabled: true,
    });

    const list = await store.readTradingStrategies();
    assert.equal(list.length, 1, "数量不应增加");
    assert.equal(list[0].name, "突破回踩改");
    assert.equal(list[0].body, "v2-更新");
  });
});

describe("WorkspaceStore trading strategies - 删除", () => {
  test("removeTradingStrategy 已存在 key → 返回 true,再读不含该 key", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeTradingStrategy({
      key: "breakout-pullback",
      name: "突破回踩",
      body: "...",
      enabled: true,
    });
    const removed = await store.removeTradingStrategy("breakout-pullback");
    assert.equal(removed, true);
    const list = await store.readTradingStrategies();
    assert.equal(list.length, 0);
  });

  test("removeTradingStrategy 不存在的 key → 不报错,返回 false", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    const removed = await store.removeTradingStrategy("non-existent-key");
    assert.equal(removed, false);
  });
});
