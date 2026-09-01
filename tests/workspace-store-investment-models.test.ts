import { test, describe, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beijingDateKey } from "../src/lib/market-calendar.js";

/**
 * WorkspaceStore 投资模型 CRUD 测试
 *
 * 投资模型是选股 → 交易 → 复盘 → 退出的组合容器,第一版落在
 * workspace/config/investment_models.yaml。
 */

const FAKE_USER = "test-investment-model-user";

let tempRoot: string;
let WorkspaceStore: typeof import("../src/lib/workspace-store.js").WorkspaceStore;
let config: typeof import("../src/lib/config.js").config;
let originalRoot: string;

before(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "ws-investment-model-test-"));
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
  const userDir = join(tempRoot, FAKE_USER);
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(userDir, "config"), { recursive: true });
  writeFileSync(join(userDir, "AGENTS.md"), "# test workspace\n");
});

describe("WorkspaceStore investment models - 空场景", () => {
  test("空 yaml → readInvestmentModels() 返回 []", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    const result = await store.readInvestmentModels();
    assert.deepEqual(result, []);
  });

  test("空 yaml → readInvestmentModelsConfig() 返回默认 key", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    const result = await store.readInvestmentModelsConfig();
    assert.equal(result.default_model_key, "user-default");
    assert.deepEqual(result.models, []);
  });
});

describe("WorkspaceStore investment models - 写入", () => {
  test("writeInvestmentModel 新增 → 再读能读出来", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeInvestmentModel({
      key: "logic-valuation-trend",
      name: "逻辑估值 + 趋势确认模型",
      status: "active",
      orientation: {
        primary_basis: "business_logic",
        entry_basis: "valuation",
        add_position_basis: "technical_confirmation",
        exit_basis: "logic_break_first",
      },
      methodology_refs: ["fundamental", "technical"],
      trading_strategy_refs: ["trend-continuation"],
      selection: { rules: ["逻辑正确", "估值合理"] },
      entry: { rules: ["相对低位买入"] },
      add_position: { rules: ["突破20日线后回踩5日不破"] },
      exit: { rules: ["逻辑破坏优先退出"] },
      review: { validation_questions: ["逻辑是否仍成立"] },
    });

    const configYaml = await store.readInvestmentModelsConfig();
    assert.equal(configYaml.default_model_key, "logic-valuation-trend");
    assert.equal(configYaml.models?.length, 1);
    assert.equal(configYaml.models?.[0].name, "逻辑估值 + 趋势确认模型");
    assert.deepEqual(configYaml.models?.[0].trading_strategy_refs, ["trend-continuation"]);
  });

  test("writeInvestmentModel 不传 created_at → 自动填今天", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeInvestmentModel({
      key: "technical-default",
      name: "默认技术模型",
      status: "active",
    });
    const list = await store.readInvestmentModels();
    const today = beijingDateKey();
    assert.equal(list[0].created_at, today);
    assert.equal(list[0].updated_at, today);
  });
});

describe("WorkspaceStore investment models - upsert", () => {
  test("同 key 调 writeInvestmentModel → upsert,字段覆盖,数量不增", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeInvestmentModel({
      key: "user-default",
      name: "默认投资模型",
      status: "active",
      selection: { rules: ["v1"] },
    });
    await store.writeInvestmentModel({
      key: "user-default",
      name: "默认投资模型改",
      status: "experimental",
      selection: { rules: ["v2"] },
    });

    const list = await store.readInvestmentModels();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "默认投资模型改");
    assert.equal(list[0].status, "experimental");
    assert.deepEqual(list[0].selection?.rules, ["v2"]);
  });
});

describe("WorkspaceStore investment models - 删除", () => {
  test("removeInvestmentModel 已存在 key → 返回 true,再读不含该 key", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    await store.writeInvestmentModel({ key: "a", name: "A" });
    await store.writeInvestmentModel({ key: "b", name: "B" });

    const removed = await store.removeInvestmentModel("a");
    assert.equal(removed, true);

    const configYaml = await store.readInvestmentModelsConfig();
    assert.equal(configYaml.default_model_key, "b");
    assert.deepEqual(configYaml.models?.map((m) => m.key), ["b"]);
  });

  test("removeInvestmentModel 不存在的 key → 不报错,返回 false", async () => {
    const store = new WorkspaceStore(FAKE_USER);
    const removed = await store.removeInvestmentModel("missing");
    assert.equal(removed, false);
  });
});
