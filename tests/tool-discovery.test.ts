import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod/v4";

import {
  EXTERNAL_CORE_TOOLS,
  INTERACTIVE_CORE_SERVICE_TOOLS,
  applyInteractiveExternalToolDiscovery,
  applyInteractiveServiceToolDiscovery,
  automationToolDiscoveryEnabled,
  interactiveToolDiscoveryEnabled,
} from "../src/mastra/tool-discovery.js";
import { TOOL_SPECS } from "../src/mastra/tools/registry.js";

/** mastra-tools.test 同款 fake bindings：createTool 原样返回（execute 可直接调）。 */
const fakeBindings = (async () => ({ createTool: (o: unknown) => o })) as unknown as Parameters<typeof applyInteractiveServiceToolDiscovery>[1];

function fakeTool(name: string, description = `${name} 的描述。第二句不进目录。`, params: string[] = ["symbol", "limit"]) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    tool: {
      id: name,
      description,
      inputSchema: { shape: Object.fromEntries(params.map((p) => [p, {}])) },
      execute: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { ok: true, tool: name, input };
      },
    },
    calls,
  };
}

test("interactive core service tool list stays in sync with TOOL_SPECS (parity guard)", () => {
  const registered = new Set(TOOL_SPECS.map((spec) => spec.id));
  for (const name of INTERACTIVE_CORE_SERVICE_TOOLS) {
    assert.ok(registered.has(name), `core list references unknown tool: ${name}`);
  }
  // 核心集必须显著小于全量（两段式的意义所在）。
  assert.ok(INTERACTIVE_CORE_SERVICE_TOOLS.length < TOOL_SPECS.length - 15, "core set must stay a strict subset");
  for (const [serverId, tools] of Object.entries(EXTERNAL_CORE_TOOLS)) {
    assert.ok(Array.isArray(tools), serverId);
  }
});

test("service track keeps core tools and exposes catalog + dispatch shell", async () => {
  const full: Record<string, unknown> = {};
  const spies = new Map<string, Array<Record<string, unknown>>>();
  for (const spec of TOOL_SPECS) {
    const { tool, calls } = fakeTool(spec.id);
    full[spec.id] = tool;
    spies.set(spec.id, calls);
  }
  const result = await applyInteractiveServiceToolDiscovery(full, fakeBindings);

  for (const name of INTERACTIVE_CORE_SERVICE_TOOLS) {
    assert.ok(result[name], `core tool must stay: ${name}`);
  }
  assert.ok(result["svc.catalog"], "catalog tool must be injected");
  assert.ok(result["svc.call"], "dispatch shell must be injected");
  // 长尾不再出现在公开清单。
  assert.equal(result["automation.create"], undefined);
  assert.equal(result["portfolio.apply_changes"], undefined);

  // 目录：一次返回全部长尾行（含工具名与参数）。
  const catalog = await (result["svc.catalog"] as { execute: () => Promise<string> }).execute();
  assert.ok(catalog.includes("automation.create"), "catalog lists long-tail service tools");
  assert.ok(catalog.includes("portfolio.apply_changes"));
  assert.ok(!catalog.includes("- portfolio.read"), "core tools are not repeated in the catalog");
  assert.ok(catalog.includes("instruction"), "parameter names are included where available");

  // 壳：delegate 到被过滤工具的原对象（scope/审计继承由 delegate 结构保证）。
  const shell = result["svc.call"] as { execute: (i: Record<string, unknown>) => Promise<unknown> };
  const delegated = await shell.execute({ name: "automation.create", input: { title: "x" } }) as { ok: boolean; tool: string };
  assert.equal(delegated.tool, "automation.create");
  assert.equal(spies.get("automation.create")?.length, 1, "shell must delegate to the original tool object");

  // 未知工具：结构化错误 + 目录指引（不抛异常，模型可自纠）。
  const unknown = await shell.execute({ name: "no_such_tool" }) as { error: string };
  assert.equal(unknown.error, "TOOL_NOT_IN_CATALOG");
  assert.ok(String((unknown as { message: string }).message).includes("svc.catalog"));
});

test("external track keeps mdt top5 and routes long tail through the shell", async () => {
  const core = EXTERNAL_CORE_TOOLS["market-data-tool"];
  const longTail = ["get_board_fundflow_rank", "get_industry_fund_flow_matrix", "get_zt_pool", "aggregate_peer_basket"];
  const full: Record<string, unknown> = {};
  const spies = new Map<string, Array<Record<string, unknown>>>();
  for (const name of [...core, ...longTail]) {
    const { tool, calls } = fakeTool(name, `${name}：查询数据。`, ["start", "end"]);
    full[name] = tool;
    spies.set(name, calls);
  }
  const observed = { "market-data-tool": full, "qsse-qlib": { quant_screen: fakeTool("quant_screen", "量化选股。", ["expr"]).tool } };
  const result = await applyInteractiveExternalToolDiscovery(observed, fakeBindings);

  const mdt = result["market-data-tool"] as Record<string, unknown>;
  for (const name of core) assert.ok(mdt[name], `mdt core tool must stay: ${name}`);
  assert.equal(mdt["get_board_fundflow_rank"], undefined, "long tail must leave the manifest");
  assert.ok(mdt["mdt.catalog"], "catalog injected");
  assert.ok(mdt["mdt.call"], "shell injected");

  const catalog = await (mdt["mdt.catalog"] as { execute: () => Promise<string> }).execute();
  assert.ok(catalog.includes("get_board_fundflow_rank"));

  const qsseCatalog = await ((result["qsse-qlib"] as Record<string, unknown>)["qsse.catalog"] as { execute: () => Promise<string> }).execute();
  assert.ok(qsseCatalog.includes("quant_screen"), "qsse tools appear in their own server catalog");

  // 壳 delegate + serverId 前缀归一化（模型可能学到 market-data-tool__name 展平名）。
  const shell = mdt["mdt.call"] as { execute: (i: Record<string, unknown>) => Promise<unknown> };
  const viaPrefix = await shell.execute({ name: "market-data-tool__get_zt_pool", input: { date: "2026-08-28" } }) as { tool: string };
  assert.equal(viaPrefix.tool, "get_zt_pool");
  assert.equal(spies.get("get_zt_pool")?.length, 1);

  const unknown = await shell.execute({ name: "quant_screen" }) as { error: string };
  assert.equal(unknown.error, "TOOL_NOT_IN_CATALOG", "cross-server name must not resolve in mdt shell");

  // qsse：全走目录，无核心常驻。
  const qsse = result["qsse-qlib"] as Record<string, unknown>;
  assert.equal(Object.keys(qsceKeysWithoutDiscoveryTools(qsse)).length, 0, "qsse has no resident core tools");
  assert.ok(qsse["qsse.catalog"]);
  assert.ok(qsse["qsse.call"]);
});

test("catalog shell inputSchema must serialize to a JSON Schema with type object", async () => {
  // OpenAI 兼容网关严格校验 function schema：无 type 的 schema 会被整单 400
  // （2026-08-28 MG 17:30 复盘失败）。壳的 inputSchema 必须是 zod schema，
  // 空对象字面量 {} 序列化后没有 type 字段。
  const svcResult = await applyInteractiveServiceToolDiscovery({ "portfolio.read": fakeTool("portfolio.read").tool }, fakeBindings);
  const svcCatalog = (svcResult["svc.catalog"] as { inputSchema: z.ZodType }).inputSchema;
  assert.equal(z.toJSONSchema(svcCatalog).type, "object", "svc.catalog inputSchema must serialize with type object");

  const extResult = await applyInteractiveExternalToolDiscovery(
    { "market-data-tool": { get_realtime_quote: fakeTool("get_realtime_quote").tool } },
    fakeBindings,
  );
  const mdtCatalog = ((extResult["market-data-tool"] as Record<string, unknown>)["mdt.catalog"] as { inputSchema: z.ZodType }).inputSchema;
  assert.equal(z.toJSONSchema(mdtCatalog).type, "object", "mdt.catalog inputSchema must serialize with type object");
});

function qsceKeysWithoutDiscoveryTools(qsse: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(qsse).filter(([k]) => !k.includes(".")));
}

test("discovery switch defaults on and honours INTERACTIVE_TOOL_DISCOVERY=off", () => {
  assert.equal(interactiveToolDiscoveryEnabled({}), true);
  assert.equal(interactiveToolDiscoveryEnabled({ INTERACTIVE_TOOL_DISCOVERY: "on" }), true);
  assert.equal(interactiveToolDiscoveryEnabled({ INTERACTIVE_TOOL_DISCOVERY: "off" }), false);
});

test("automation external-track switch is independent of the interactive switch", () => {
  // 默认开；两个开关互不牵连（automation 回退不影响交互轮，反之亦然）。
  assert.equal(automationToolDiscoveryEnabled({}), true);
  assert.equal(automationToolDiscoveryEnabled({ AUTOMATION_TOOL_DISCOVERY: "off" }), false);
  assert.equal(automationToolDiscoveryEnabled({ INTERACTIVE_TOOL_DISCOVERY: "off" }), true);
  assert.equal(
    automationToolDiscoveryEnabled({ AUTOMATION_TOOL_DISCOVERY: "off", INTERACTIVE_TOOL_DISCOVERY: "on" }),
    false,
  );
});

test("automation dispatch path reuses the same external-track transformation (T-401)", async () => {
  // T-401 在 agent.ts 挂点对 automation 通道复用 applyInteractiveExternalToolDiscovery；
  // 这里锁定该函数对 market-watch 场景的行为契约：盯盘核心工具常驻、长尾进目录、
  // 壳 delegate 可用。挂点本身的通道判定是单行布尔，由上方开关测试 + 交互轨
  // 测试共同覆盖，不再造重型 handleMessage 集成测试。
  const core = EXTERNAL_CORE_TOOLS["market-data-tool"] as readonly string[];
  const watchTools = ["get_realtime_quote", "get_market_summary", "get_stock_news"];
  for (const name of watchTools) {
    assert.ok(core.includes(name), `market-watch staple must stay resident: ${name}`);
  }
  const full: Record<string, unknown> = {};
  for (const name of [...core, "get_dragon_tiger_list"]) {
    full[name] = fakeTool(name, `${name}：查询数据。`, ["date"]).tool;
  }
  const result = await applyInteractiveExternalToolDiscovery({ "market-data-tool": full }, fakeBindings);
  const mdt = result["market-data-tool"] as Record<string, unknown>;
  for (const name of watchTools) assert.ok(mdt[name], `resident tool must stay in manifest: ${name}`);
  assert.equal(mdt["get_dragon_tiger_list"], undefined, "long tail must leave the automation manifest");
  assert.ok(mdt["mdt.catalog"] && mdt["mdt.call"], "catalog + shell injected for automation track");
});
