/**
 * W7 前置：generic automation 上游端到端（W4 遗留边界补齐）。
 *
 * 从 runGenericAutomationTaskNow 完整上游生命周期（claim/lease → 绑定 →
 * staging → defaultExecutor → handleMessage 模型边界 → 记账）在 Agent Space
 * 装配模式启用下驱动，断言：
 * - basis 以 run:<runId>:basis 落库且 resolution 只含任务 pin 的方法版本；
 * - 真实模型请求的 system 注入装配段与固定版本方法正文；
 * - 未注册依赖的任务得到显式空集装配（skipped 原因可查），不是静默旧路径。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-w7-generic-e2e-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "w7.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.join(root, "templates");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scope = { userId: "w7-e2e-user", projectId: "invest-agent", instanceId: "w7-e2e-instance" };
const OWNER_TOKEN = "w7-e2e-owner-token";
const METHOD_BODY = Buffer.from("# W7 上游端到端方法\nE2E_METHOD_MARKER_V1\n规则：端到端验证。\n", "utf8");
const METHOD_CHK = createHash("sha256").update(METHOD_BODY).digest("hex");

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(OWNER_TOKEN);
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  await registerTestProject(scope);
  return {
    db,
    space: await import("../src/services/agent-space/index.js"),
    automation: await import("../src/services/automation-tasks.js"),
    runner: await import("../src/services/generic-automation-runner.js"),
    userAssets: await import("../src/services/user-assets.js"),
  };
})();

test("W7 前置：装配模式下 generic automation 上游端到端——固定方法注入真实模型上下文", async (t) => {
  const { db, space, automation, runner, userAssets } = await fixture;

  // 方法：真实字节资产 → draft → owner 授权 approve+adopt。
  const asset = await userAssets.createUserAsset({ ...scope, name: "w7-method", fileName: "w7-method.md", bytes: METHOD_BODY, source: "upload" });
  const assetVersionId = db.sqlite
    .prepare("SELECT current_version_id AS v FROM user_assets WHERE asset_id=?")
    .get(asset.assetId) as { v: string };
  const method = space.createMethod({ scope, name: "W7E2E方法", actor: "w7-test" });
  const version = space.addMethodVersion({
    scope, methodId: method.method_id,
    contentRef: { assetId: asset.assetId, assetVersionId: assetVersionId.v, contentChecksum: METHOD_CHK },
    actor: "w7-test",
  });
  space.approveMethodVersion({
    scope, methodId: method.method_id, versionId: version.version_id,
    approvedBy: "w7-owner", approvalRef: "owner-decision:w7-e2e", ownerToken: OWNER_TOKEN, adopt: true, actor: "w7-test",
  });
  const agent = space.createAgent({ scope, name: "W7E2E Agent", actor: "w7-test" });
  space.setAgentStatus(scope, agent.agent_id, "active", "w7-test");

  // 任务 A：注册方法依赖；任务 B：无依赖（显式空集对照）。
  const taskA = await automation.createAutomationTask({
    ...scope, taskId: "w7-e2e-task-a", name: "上游端到端A", instruction: "按方法输出摘要。",
    schedule: { frequency: "trading_days" as const, time: "14:30", timezone: "Asia/Shanghai", windows: ["14:30"] },
    output: { mode: "none" }, delivery: { mode: "none" as const },
  });
  await automation.activateAutomationTask({ ...scope, taskId: taskA.taskId, expectedRevision: 1 });
  space.upsertTaskDependency({ scope, taskId: taskA.taskId, kind: "method", refId: method.method_id, versionPolicy: "pinned", pinnedVersionId: version.version_id, actor: "w7-test" });
  const taskB = await automation.createAutomationTask({
    ...scope, taskId: "w7-e2e-task-b", name: "上游端到端B", instruction: "无依赖对照。",
    schedule: { frequency: "trading_days" as const, time: "14:35", timezone: "Asia/Shanghai", windows: ["14:35"] },
    output: { mode: "none" }, delivery: { mode: "none" as const },
  });
  await automation.activateAutomationTask({ ...scope, taskId: taskB.taskId, expectedRevision: 1 });

  // 本地假模型网关：捕获上游链最终发给模型的请求，返回结构化 JSON。
  const captured: Array<{ body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString(); });
    request.on("end", () => {
      captured.push({ body: JSON.parse(requestBody) as Record<string, unknown> });
      const payload = JSON.stringify({ summary: "上游端到端验证摘要", shouldNotify: false });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: {"id":"w7","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":${JSON.stringify(payload)}},"finish_reason":null}]}\n\n`);
      response.write('data: {"id":"w7","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  t.after(() => { server.close(); });

  const previousEnv = { ...process.env };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "w7-test-key";
  process.env.MASTRA_DEFAULT_MODEL = "w7-test-model";
  process.env.AGENT_SPACE_ASSEMBLY_MODE = `scope:${scope.userId}`;
  t.after(() => {
    for (const key of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "MASTRA_DEFAULT_MODEL", "AGENT_SPACE_ASSEMBLY_MODE"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  // 真实上游驱动（不注入 executor）：claim → 绑定 → staging → handleMessage。
  const resultA = await runner.runGenericAutomationTaskNow({ scope, taskId: taskA.taskId, origin: "manual", idempotencyKey: "w7-e2e-a-1" });
  assert.equal(resultA.run.status, "succeeded", `任务A上游运行应成功：${JSON.stringify(resultA.run)}`);

  const storedKey = (key: string) => `${scope.userId}|${scope.projectId}|${scope.instanceId}|${key}`;
  const basisRowA = db.sqlite
    .prepare("SELECT basis_key, basis_json FROM agent_space_run_basis WHERE basis_key=?")
    .get(storedKey(`run:${resultA.run.runId}:basis`)) as { basis_key: string; basis_json: string } | undefined;
  assert.ok(basisRowA, "任务A必须落 run basis");
  const basisA = JSON.parse(basisRowA.basis_json);
  assert.equal(basisA.entryKind, "generic_automation");
  assert.equal(basisA.methods.length, 1, "装配封闭于任务声明依赖");
  assert.equal(basisA.methods[0].versionId, version.version_id);
  assert.equal(basisA.methods[0].contentChecksum, METHOD_CHK);

  const lastCapture = captured[captured.length - 1]!;
  const messages = (lastCapture.body.messages ?? []) as Array<{ role: string; content: string }>;
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(system, /Agent Space 装配（generic_automation）/, "system 必须含装配段");
  assert.ok(system.includes("E2E_METHOD_MARKER_V1"), "system 必须注入固定版本方法正文");
  assert.ok(!system.includes(root), "system 不得携带本地 workspace 路径");

  // 对照：未注册依赖的任务得到显式空集（skipped 可查），不落静默旧路径。
  const resultB = await runner.runGenericAutomationTaskNow({ scope, taskId: taskB.taskId, origin: "manual", idempotencyKey: "w7-e2e-b-1" });
  assert.equal(resultB.run.status, "succeeded");
  const basisRowB = db.sqlite
    .prepare("SELECT basis_json FROM agent_space_run_basis WHERE basis_key=?")
    .get(storedKey(`run:${resultB.run.runId}:basis`)) as { basis_json: string } | undefined;
  assert.ok(basisRowB, "任务B同样落 basis（显式空集）");
  const basisB = JSON.parse(basisRowB.basis_json);
  assert.equal(basisB.methods.length, 0);
  assert.ok(
    basisB.skipped.some((s: { reason?: string }) => String(s.reason ?? "").includes("task-declares-no-dependencies")),
    "空装配必须携带显式 skipped 原因",
  );
});
