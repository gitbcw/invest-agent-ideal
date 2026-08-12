#!/usr/bin/env node
/**
 * MCP 注册表离线 contract 校验 (T-243 Phase 2 接入门禁)。
 *
 * 用途:新外部 MCP server 接入前后,离线校验注册项契约 —— 不依赖 live endpoint、
 * 不需要真实 token。可作为 pre-commit / CI 门禁。
 *
 * 校验项 (对应五道门的 Gate 1/2 离线部分):
 *   1. 每个注册项通过 validateRegistration (id 格式 / trustClass 一致性 / 模板 token / 安全边界)。
 *   2. 每个 external-readonly 注册项声明了 activateIf 规则 (未声明的 fail-closed)。
 *   3. activateIf 引用的 env 名都是合法变量名。
 *   4. external-readonly 注册项不引用任何 service scope env (安全边界)。
 *   5. 内建 service-tools 注册项 owner=invest-agent + service-scoped。
 *   6. 注册项 id 全局唯一。
 *
 * 退出码:全过 0,任一失败 1。
 *
 * 用法:npm run mcp:check
 */

import {
  buildBuiltinServiceToolsRegistration,
  getMcpRegistry,
  isForbiddenExternalRef,
  validateRegistration,
  type McpServerRegistration,
} from "../src/mcp/mcp-registry.js";
import { buildExternalRegistrations } from "../src/mcp/external-mcp-registrations.js";

type CheckResult = { name: string; passed: boolean; detail: string };

function check(name: string, fn: () => string | null): CheckResult {
  try {
    const detail = fn();
    return { name, passed: detail === null, detail: detail ?? "ok" };
  } catch (error) {
    return { name, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function collectAllRegistrations(): McpServerRegistration[] {
  const builtin = buildBuiltinServiceToolsRegistration();
  const external = buildExternalRegistrations();
  return [builtin, ...external];
}

function runChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const regs = collectAllRegistrations();

  // 1. 每个注册项通过 validateRegistration
  for (const reg of regs) {
    results.push(
      check(`validateRegistration: ${reg.id}`, () => validateRegistration(reg)),
    );
  }

  // 2. 每个 external-readonly 声明 activateIf (未声明的 activation 永远 fail-closed,等同于不可用)
  for (const reg of regs) {
    if (reg.trustClass !== "external-readonly") continue;
    results.push(
      check(`activateIf declared: ${reg.id}`, () =>
        reg.activateIf ? null : "external-readonly server 未声明 activateIf (将永远 fail-closed 无法激活)",
      ),
    );
  }

  // 3. activateIf refs 合法变量名 (validateRegistration 已覆盖,这里冗余但显式)
  for (const reg of regs) {
    if (!reg.activateIf) continue;
    results.push(
      check(`activateIf refs non-empty: ${reg.id}`, () =>
        reg.activateIf!.refs.length > 0 ? null : "activateIf.refs 不能为空",
      ),
    );
  }

  // 4. external-readonly 安全边界:不引用 service scope env
  for (const reg of regs) {
    if (reg.trustClass !== "external-readonly") continue;
    const refs: string[] = [];
    if (reg.transport.kind === "stdio") {
      refs.push(...(reg.transport.envRefs || []), ...(reg.transport.requiredEnvRefs || []));
    } else {
      refs.push(
        ...(reg.transport.headerRefs || []),
        ...(reg.transport.headers || []).map((h) => h.envRef),
        ...(reg.transport.requiredEnvRefs || []),
      );
    }
    const leaked = refs.filter((r) => isForbiddenExternalRef(r));
    results.push(
      check(`no service-scope leak: ${reg.id}`, () =>
        leaked.length === 0 ? null : `external-readonly 引用了 service scope env: ${leaked.join(", ")}`,
      ),
    );
  }

  // 5. 内建 service-tools 契约
  const builtin = regs.find((r) => r.id === "invest-agent-service-tools");
  results.push(
    check("builtin service-tools present", () =>
      builtin ? null : "缺少内建 invest-agent-service-tools 注册项",
    ),
    check("builtin service-tools owner=invest-agent", () =>
      builtin?.owner === "invest-agent" ? null : `owner 应为 invest-agent,实际 ${builtin?.owner}`,
    ),
    check("builtin service-tools trustClass=service-scoped", () =>
      builtin?.trustClass === "service-scoped" ? null : `trustClass 应为 service-scoped,实际 ${builtin?.trustClass}`,
    ),
  );

  // 6. id 唯一
  const ids = regs.map((r) => r.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  results.push(
    check("registration ids unique", () =>
      dupes.length === 0 ? null : `重复的注册项 id: ${dupes.join(", ")}`,
    ),
  );

  // 7. registry 单例可正常构造 (触发 getMcpRegistry 完整链路)
  results.push(
    check("registry singleton constructs", () => {
      const registry = getMcpRegistry();
      const list = registry.listRegistrations();
      return list.length >= 1 ? null : "registry 构造后为空";
    }),
  );

  return results;
}

function main() {
  const results = runChecks();
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    const line = r.passed ? `${mark} ${r.name}` : `${mark} ${r.name}\n    → ${r.detail}`;
    console.log(line);
  }

  console.log("");
  console.log(`MCP 注册表 contract 校验: ${passed}/${results.length} 通过`);

  if (failed.length > 0) {
    console.error(`\n失败 ${failed.length} 项:`);
    for (const f of failed) console.error(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
