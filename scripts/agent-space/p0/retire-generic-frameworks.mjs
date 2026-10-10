#!/usr/bin/env node
/** 2026-10-09 owner 裁决：分析方法归属技能域，投资框架只留用户个性化纪律。
 * 对镜像内所有用户的四个通用方法框架（基本面分析/技术面分析/宏观分析/
 * 风险控制，源自 templates/workspace/knowledge/methods 播种）做退役：
 *   - 当前版本内容与播种模板逐字节一致 → retire（可逆，审计留痕）
 *   - 内容被用户编辑过（与模板不一致）→ 跳过并报告，不删用户改动
 * 「策略规则」「控盘度*」等用户个性化框架不动。生产部署时对生产库另跑。
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(repoRoot, ".state", "production-mirror");
process.env.MASTRA_PROJECTS_ROOT = path.join(mirrorRoot, "projects");
process.env.DB_PATH = process.env.DB_PATH || path.join(mirrorRoot, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(mirrorRoot, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(mirrorRoot, "runtime");

const { sqlite } = await import(path.join(repoRoot, "src", "db", "index.ts"));
const methods = await import(path.join(repoRoot, "src", "services", "agent-space", "methods.ts"));

const TEMPLATE_BY_NAME = {
  "基本面分析": "fundamental.md",
  "技术面分析": "technical.md",
  "宏观分析": "macro.md",
  "风险控制": "risk.md",
};
const TEMPLATE_ROOT = path.join(repoRoot, "templates", "workspace", "knowledge", "methods");
const ACTOR = "ops:framework-dedup-20261009";

const templates = {};
for (const [name, file] of Object.entries(TEMPLATE_BY_NAME)) {
  templates[name] = await readFile(path.join(TEMPLATE_ROOT, file));
}

const scopes = sqlite.prepare(
  `SELECT DISTINCT user_id AS userId, project_id AS projectId, instance_id AS instanceId
   FROM agent_space_methods WHERE kind='framework' AND status='active'`,
).all();

let retired = 0;
const skipped = [];
for (const scope of scopes) {
  for (const [name] of Object.entries(TEMPLATE_BY_NAME)) {
    const row = sqlite.prepare(
      `SELECT method_id AS methodId, current_version_id AS versionId FROM agent_space_methods
       WHERE user_id=? AND project_id=? AND instance_id=? AND name=? AND kind='framework' AND status='active'`,
    ).get(scope.userId, scope.projectId, scope.instanceId, name);
    if (!row?.versionId) continue;
    let bytes;
    try {
      bytes = (await methods.readMethodVersionContent(scope, row.versionId)).bytes;
    } catch (error) {
      skipped.push(`${scope.userId}/${name}: 内容读取失败（${error.message}）`);
      continue;
    }
    if (!bytes.equals(templates[name])) {
      skipped.push(`${scope.userId}/${name}: 内容与模板不一致（疑有用户编辑），保留`);
      continue;
    }
    methods.retireMethod(scope, row.methodId, ACTOR);
    retired += 1;
    console.log(`retired: ${scope.userId}/${name} (${row.methodId})`);
  }
}
console.log(`\n完成：退役 ${retired} 个通用方法框架`);
if (skipped.length > 0) {
  console.log("跳过（需人工判断）：");
  for (const item of skipped) console.log("  - " + item);
}
process.exit(0);
