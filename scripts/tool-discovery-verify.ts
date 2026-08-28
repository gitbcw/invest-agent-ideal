/**
 * T-400 本地验证：两段式重组前后，交互轮工具面的实测体积对比。
 * 外部轨用真实 MCP 连接（.env）实测；服务轨用 TOOL_SPECS 声明估算
 * （真实工具构造依赖运行时初始化，封闭测试已覆盖其正确性）。
 * 只读，不发真实工具调用。用法：node --import tsx --env-file=.env scripts/tool-discovery-verify.ts
 */
import { resolveExternalMastraToolsets } from "../src/mastra/external-mcp.js";
import { applyInteractiveExternalToolDiscovery, INTERACTIVE_CORE_SERVICE_TOOLS } from "../src/mastra/tool-discovery.js";
import { TOOL_SPECS } from "../src/mastra/tools/registry.js";

async function main() {
  // 外部轨（真实连接）
  const external = await resolveExternalMastraToolsets("interactive");
  const observed = external.toolsets;
  const servers = Object.keys(observed);
  console.log(`已连接外部 MCP: ${servers.join(", ") || "(none)"}`);

  const slimExternal = await applyInteractiveExternalToolDiscovery(observed);
  let extFull = 0;
  let extFullCount = 0;
  for (const ts of Object.values(observed)) {
    const tools = ((ts as { tools?: Record<string, unknown> }).tools ?? ts) as Record<string, unknown>;
    for (const [n, t] of Object.entries(tools)) {
      extFullCount += 1;
      extFull += JSON.stringify({ name: n, description: (t as { description?: string }).description }).length;
    }
  }
  let extSlim = 0;
  let extSlimCount = 0;
  for (const ts of Object.values(slimExternal as Record<string, unknown>)) {
    const tools = ((ts as { tools?: Record<string, unknown> }).tools ?? ts) as Record<string, unknown>;
    for (const [n, t] of Object.entries(tools)) {
      extSlimCount += 1;
      extSlim += JSON.stringify({ name: n, description: (t as { description?: string }).description }).length;
    }
  }
  console.log(`外部轨(名+描述口径): ${extFullCount} 工具 ${extFull} chars -> ${extSlimCount} 工具 ${extSlim} chars`);

  for (const [sid, ts] of Object.entries(slimExternal as Record<string, unknown>)) {
    const tools = ((ts as { tools?: Record<string, unknown> }).tools ?? ts) as Record<string, unknown>;
    const catalog = Object.entries(tools).find(([n]) => n.endsWith(".catalog"));
    if (catalog) {
      const text = await (catalog[1] as { execute: () => Promise<string> }).execute();
      console.log(`${sid} 目录输出 ${text.length} chars，工具清单: ${Object.keys(tools).join(", ")}`);
    }
  }

  // 服务轨（声明估算：全量 vs 核心，schema 以参数名+描述近似）
  const core = new Set(INTERACTIVE_CORE_SERVICE_TOOLS);
  const svcFull = TOOL_SPECS.reduce((s, spec) => s + spec.description.length + Object.keys(spec.inputSchema).join(",").length + spec.id.length, 0);
  const svcSlim = TOOL_SPECS.filter((spec) => core.has(spec.id)).reduce((s, spec) => s + spec.description.length + Object.keys(spec.inputSchema).join(",").length + spec.id.length, 0) + 600; // +目录/壳描述
  console.log(`服务轨(声明口径): ${TOOL_SPECS.length} 工具 ~${svcFull} chars -> ${INTERACTIVE_CORE_SERVICE_TOOLS.length + 2} 工具 ~${svcSlim} chars`);

  const before = extFull + svcFull;
  const after = extSlim + svcSlim;
  console.log(`\n合计(估算): ~${before} chars (≈${Math.round(before / 3)} tok) -> ~${after} chars (≈${Math.round(after / 3)} tok)，降幅 ~${Math.round((1 - after / before) * 100)}%`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
