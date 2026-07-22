import { existsSync } from "node:fs";
import { deleteInvestAgentInstance } from "../../../../src/platform/project-registry.ts";
import { sqlite } from "../../../../src/db/index.ts";
import { resolveWorkspacePath } from "../../../../src/lib/workspace.ts";

type EvalInstance = {
  userId: string;
  instanceId: string;
  name: string;
  status: string;
  createdAt: string;
};

function usage(): never {
  throw new Error("Usage: manage-eval-instance.ts <list|inspect|delete> [eval-user-id-or-instance-id] [--confirm]");
}

function resolveTarget(target: string): EvalInstance {
  const row = sqlite.prepare(`
    select u.id as userId, i.id as instanceId, i.name, i.status, i.created_at as createdAt
    from ai_instances i
    inner join users u on u.id = i.owner_user_id
    where (u.id = ? or i.id = ?) and u.id like 'eval-%'
  `).get(target, target) as EvalInstance | undefined;
  if (!row) throw new Error("EVAL_INSTANCE_NOT_FOUND_OR_NOT_SCOPED");
  return row;
}

function evidence(instance: EvalInstance) {
  const count = (table: string) => Number(
    (sqlite.prepare(`select count(*) as n from ${table} where user_id = ? or instance_id = ?`)
      .get(instance.userId, instance.instanceId) as { n: number }).n,
  );
  return {
    workspaceExists: existsSync(resolveWorkspacePath(instance.userId)),
    sessions: count("conversation_sessions"),
    messages: count("conversation_messages"),
    traces: count("codex_acp_traces"),
    audits: count("sandbox_audit_logs"),
  };
}

async function main() {
  const [command, target, ...flags] = process.argv.slice(2);
  if (command === "list") {
    if (target) usage();
    const rows = sqlite.prepare(`
      select u.id as userId, i.id as instanceId, i.name, i.status, i.created_at as createdAt
      from ai_instances i inner join users u on u.id = i.owner_user_id
      where u.id like 'eval-%' order by i.created_at desc
    `).all() as EvalInstance[];
    console.log(JSON.stringify(rows.map((row) => ({ ...row, evidence: evidence(row) })), null, 2));
    return;
  }
  if (!target || (command !== "inspect" && command !== "delete")) usage();

  const instance = resolveTarget(target);
  const before = evidence(instance);
  if (command === "inspect") {
    console.log(JSON.stringify({ instance, evidence: before, retained: true }, null, 2));
    return;
  }
  if (!flags.includes("--confirm")) {
    throw new Error("DELETE_REQUIRES_EXPLICIT_CONFIRM");
  }

  const deleted = await deleteInvestAgentInstance(instance.instanceId);
  const after = {
    workspaceExists: existsSync(resolveWorkspacePath(instance.userId)),
    instanceCount: (sqlite.prepare("select count(*) as n from ai_instances where id = ?").get(instance.instanceId) as { n: number }).n,
    userCount: (sqlite.prepare("select count(*) as n from users where id = ?").get(instance.userId) as { n: number }).n,
    sessionCount: (sqlite.prepare("select count(*) as n from conversation_sessions where user_id = ? or instance_id = ?").get(instance.userId, instance.instanceId) as { n: number }).n,
    messageCount: (sqlite.prepare("select count(*) as n from conversation_messages where user_id = ? or instance_id = ?").get(instance.userId, instance.instanceId) as { n: number }).n,
    traceCount: (sqlite.prepare("select count(*) as n from codex_acp_traces where user_id = ? or instance_id = ?").get(instance.userId, instance.instanceId) as { n: number }).n,
    auditCount: (sqlite.prepare("select count(*) as n from sandbox_audit_logs where user_id = ? or instance_id = ?").get(instance.userId, instance.instanceId) as { n: number }).n,
  };
  const clean = !after.workspaceExists && Object.entries(after).every(([key, value]) => key === "workspaceExists" || value === 0);
  console.log(JSON.stringify({ instance, before, deleted, after, clean }, null, 2));
  if (!clean) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
