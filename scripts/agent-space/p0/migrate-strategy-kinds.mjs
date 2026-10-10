#!/usr/bin/env node
/** 两层裁决迁移 v2（2026-10-08）：存量方法对象标注 kind——
 * 系统预置方法论（策略规则/四件套/控盘度系）→ framework（整体常驻，解除绑定）；
 * 用户创建的执行规则（均线+放量突破策略）→ strategy，唯一者绑定为主策略。
 * 幂等可重跑。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(REPO_ROOT, ".state", "production-mirror");
process.env.DB_PATH = path.join(root, "runtime.db");
// 镜像脚本必须钉住 projects 根：漏设会把新写文件落到仓库开发目录（2026-10-08 恢复脚本教训）。
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
const dbModule = await import("../../../src/db/index.ts");
(dbModule.default ?? dbModule).initDb();
const { sqlite } = dbModule.default ?? dbModule;

const FRAMEWORK_NAMES = ["策略规则", "基本面分析", "技术面分析", "宏观分析", "风险控制", "控盘度综合评分", "控盘度指标V1.0（历史定位）"];
const STRATEGY_NAMES = ["均线+放量突破策略"];

const results = [];
// 1) 标注 framework
for (const name of FRAMEWORK_NAMES) {
  const updated = sqlite.prepare("UPDATE agent_space_methods SET kind='framework', updated_at=? WHERE name=? AND kind != 'framework'").run(new Date().toISOString(), name);
  if (updated.changes > 0) results.push({ name, kind: "framework", changed: updated.changes });
}
// 2) 标注 strategy + 唯一者绑主
for (const name of STRATEGY_NAMES) {
  const updated = sqlite.prepare("UPDATE agent_space_methods SET kind='strategy', updated_at=? WHERE name=? AND kind != 'strategy'").run(new Date().toISOString(), name);
  if (updated.changes > 0) results.push({ name, kind: "strategy", changed: updated.changes });
}
// 3) framework 解除绑定（含主策略绑定）；strategy 若无主策略绑定且 scope 恰一个 active agent → 绑主
sqlite.prepare("UPDATE agent_space_agent_method_bindings SET status='superseded', updated_at=? WHERE method_id IN (SELECT method_id FROM agent_space_methods WHERE kind='framework') AND status='active'").run(new Date().toISOString());
const strategyScopes = sqlite.prepare(
  `SELECT DISTINCT m.user_id AS userId, m.project_id AS projectId, m.instance_id AS instanceId
   FROM agent_space_methods m WHERE m.kind='strategy' AND m.status='active'`,
).all();
const { bindMethod } = await import("../../../src/services/agent-space/agents.ts");
for (const scope of strategyScopes) {
  const hasPrimary = sqlite.prepare(
    `SELECT 1 AS hit FROM agent_space_agent_method_bindings b
     JOIN agent_space_methods m ON m.method_id=b.method_id
     WHERE b.user_id=? AND b.project_id=? AND b.instance_id=? AND b.status='active' AND m.kind='strategy'`,
  ).get(scope.userId, scope.projectId, scope.instanceId);
  if (hasPrimary) { results.push({ userId: scope.userId, primary: "already-set" }); continue; }
  const soleAgent = sqlite.prepare(
    "SELECT agent_id AS agentId FROM agent_space_agents WHERE user_id=? AND project_id=? AND instance_id=? AND status='active' LIMIT 2",
  ).all(scope.userId, scope.projectId, scope.instanceId);
  if (soleAgent.length !== 1) { results.push({ userId: scope.userId, primary: "skipped: agents != 1" }); continue; }
  const firstStrategy = sqlite.prepare(
    `SELECT method_id AS methodId FROM agent_space_methods
     WHERE user_id=? AND project_id=? AND instance_id=? AND kind='strategy' AND status='active' AND current_version_id IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId);
  if (firstStrategy) {
    bindMethod({ scope, agentId: soleAgent[0].agentId, methodId: firstStrategy.methodId, versionPolicy: "current", actor: "two-layer-migration" });
    results.push({ userId: scope.userId, primary: firstStrategy.methodId });
  }
}
// 其余未标注的存量（若有）保持默认 strategy
console.log(JSON.stringify({ results }, null, 1));
sqlite.close();
