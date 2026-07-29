import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcpEvalRunId } from "./acp-eval-run-id.mjs";

const PROJECT_ROOT = process.cwd();
const EXPECTED_MODEL = "gpt-5.6-sol";
const CASE_TIMEOUT_MS = 10 * 60 * 1000;
const CASE_RUNTIME_TIMEOUT_MS = Number(process.env.ACP_EVAL_CASE_TIMEOUT_MS) || CASE_TIMEOUT_MS;
const args = new Set(process.argv.slice(2));
const keepRuntime = args.has("--keep-runtime");
const requiredSearchProvider = process.env.ACP_EVAL_REQUIRED_SEARCH_PROVIDER?.trim() || undefined;
const fixtureArg = process.argv.find((value) => value.startsWith("--fixture="));
const caseArg = process.argv.find((value) => value.startsWith("--case="));
const fixturePath = path.resolve(PROJECT_ROOT, fixtureArg?.slice("--fixture=".length) || "tests/fixtures/acp-data-quality/core-v1.json");

if (process.env.CODEX_COMPLEX_MODEL !== EXPECTED_MODEL) {
  throw new Error(`ACP data-quality evaluation requires CODEX_COMPLEX_MODEL=${EXPECTED_MODEL}; received ${process.env.CODEX_COMPLEX_MODEL || "(unset)"}`);
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.ok(
  ["acp-data-quality-core", "acp-best-effort-answering"].includes(fixture.suite),
  `unsupported ACP evaluation suite: ${fixture.suite}`,
);
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, "fixture must contain cases");
const selectedCases = caseArg
  ? fixture.cases.filter((definition) => definition.id === caseArg.slice("--case=".length))
  : fixture.cases;
assert.ok(selectedCases.length > 0, `no fixture case matches ${caseArg || "the requested suite"}`);

const runId = createAcpEvalRunId();
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `${runId}-`));
const reportDir = path.join(PROJECT_ROOT, "data", "eval-results");
const runStartedAt = new Date().toISOString();

// These must be set before importing any compiled service module, since config is resolved at module load.
Object.assign(process.env, {
  NODE_ENV: "test",
  DB_PATH: path.join(runtimeRoot, "invest-agent.db"),
  WORKSPACE_ROOT: path.join(runtimeRoot, "workspaces"),
  RUNTIME_DATA_ROOT: path.join(runtimeRoot, "runtime-data"),
  REVIEWS_ROOT: path.join(runtimeRoot, "reviews"),
  INVEST_AGENT_SANDBOX_SECRET_FILE: path.join(runtimeRoot, ".sandbox-secret"),
  INVEST_AGENT_PROJECT_ROOT: PROJECT_ROOT,
  CODEX_ACP_TIMEOUT_MS: String(CASE_TIMEOUT_MS),
  ACP_EVAL_CASE_TIMEOUT_MS: String(CASE_RUNTIME_TIMEOUT_MS),
  ACP_EVAL_DISABLE_INHERITED_MCP: "true",
});

const { initDb, sqlite } = await import("../dist/db/index.js");
const { createInvestAgentInstance, deleteInvestAgentInstance } = await import("../dist/platform/project-registry.js");
const { disposeAcpForWorkspace } = await import("../dist/acp/stdio-agent.js");
const { chatViaConversationLog, getConversation } = await import("../dist/services/conversation-log.js");
const { config } = await import("../dist/lib/config.js");
initDb();

const manifest = {
  runId,
  suite: fixture.suite,
  fixtureVersion: fixture.version,
  startedAt: runStartedAt,
  gitSha: gitSha(),
  model: process.env.CODEX_COMPLEX_MODEL,
  caseTimeoutMs: CASE_TIMEOUT_MS,
  caseRuntimeTimeoutMs: CASE_RUNTIME_TIMEOUT_MS,
  runtime: {
    isolated: true,
    inheritedMcpDisabled: process.env.ACP_EVAL_DISABLE_INHERITED_MCP === "true",
    searxngConfigured: Boolean(process.env.EXTERNAL_WEB_SEARCH_SEARXNG_URL),
    requiredSearchProvider: requiredSearchProvider || null,
  },
};
const cases = [];
let automaticFailureCount = 0;

try {
  for (const definition of selectedCases) {
    const result = await runCase(definition);
    cases.push(result);
    if (result.automaticStatus === "fail") automaticFailureCount += 1;
  }
} finally {
  sqlite.close();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true });
}

const report = {
  manifest: { ...manifest, finishedAt: new Date().toISOString(), runtimeRoot: keepRuntime ? runtimeRoot : "cleaned" },
  summary: {
    caseCount: cases.length,
    automaticPass: cases.filter((entry) => entry.automaticStatus === "pass").length,
    automaticFail: automaticFailureCount,
    pendingSemanticReview: cases.filter((entry) => entry.semanticStatus === "pending_review").length,
    elapsedMs: Date.now() - new Date(runStartedAt).getTime(),
  },
  cases,
};

await mkdir(reportDir, { recursive: true });
const jsonPath = path.join(reportDir, `${runId}.json`);
const markdownPath = path.join(reportDir, `${runId}.md`);
await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
await writeFile(markdownPath, renderMarkdown(report), "utf8");
console.log(JSON.stringify({ runId, jsonPath, markdownPath, summary: report.summary }, null, 2));

// ACP transports can retain idle handles after their final session is disposed.
// The evidence packet is already durable, so terminate this CLI deterministically.
await new Promise((resolve) => setImmediate(resolve));
process.exit(automaticFailureCount > 0 ? 1 : 0);

async function runCase(definition) {
  const caseId = definition.id;
  const userId = `eval-${runId.slice(-8)}-${caseId}`.slice(0, 64);
  const conversationId = `${runId}:${caseId}`;
  const created = await createInvestAgentInstance({
    userId,
    displayName: `ACP quality eval ${caseId}`,
    instanceName: `ACP quality ${caseId}`,
    backend: "codex",
  });
  const instanceId = created.instanceId;
  const workspacePath = path.join(process.env.WORKSPACE_ROOT, userId);
  const identity = {
    runId,
    userId,
    instanceId,
    conversationId,
    workspacePath,
    retention: keepRuntime ? "retain" : "cleanup",
  };
  const allowedTools = definition.allowedTools.join(",");
  const previousAllowedTools = process.env.ACP_EVAL_MCP_ALLOWED_TOOLS;
  process.env.ACP_EVAL_MCP_ALLOWED_TOOLS = allowedTools;
  const startedAt = Date.now();

  try {
    const prompts = Array.isArray(definition.turns) && definition.turns.length > 0
      ? definition.turns
      : [definition.prompt];
    const replies = [];
    const turnEvidence = [];
    let auditCursor = 0;
    for (const [index, prompt] of prompts.entries()) {
      const response = await chatViaConversationLog({
        userId,
        instanceId,
        projectId: instanceId,
        assistantId: instanceId,
        conversationId,
        userMessageId: `${runId}:${caseId}:${index + 1}`,
        idempotencyKey: `${runId}:${caseId}:${index + 1}`,
        text: prompt,
      });
      const reply = response.assistantMessage.content;
      replies.push(reply);
      const currentAudits = readAudits(userId, instanceId, conversationId);
      const turnAudits = currentAudits.slice(auditCursor);
      auditCursor = currentAudits.length;
      turnEvidence.push({
        turn: index + 1,
        prompt,
        reply,
        operations: turnAudits.map((entry) => entry.operation),
        audits: turnAudits,
        trace: readLatestTrace(userId, instanceId, conversationId),
      });
    }
    const elapsedMs = Date.now() - startedAt;
    const trace = readLatestTrace(userId, instanceId, conversationId);
    const audits = readAudits(userId, instanceId, conversationId);
    const telemetry = await readTelemetry(userId);
    const operations = audits.map((entry) => entry.operation);
    const expectedOperationMode = definition.expectedOperationMode === "any" ? "any" : "all";
    const missingOperations = expectedOperationMode === "any"
      ? definition.expectedOperations.some((name) => operations.includes(name)) ? [] : definition.expectedOperations
      : definition.expectedOperations.filter((name) => !operations.includes(name));
    const writeOperations = operations.filter(isWriteOperation);
    const searchAudits = audits.filter((entry) => entry.operation === "research.web_search");
    const unexpectedSearchProviders = requiredSearchProvider
      ? searchAudits.filter((entry) => !entry.resultSummary?.includes(`provider=${requiredSearchProvider}`))
      : [];
    const operationCountOverages = Object.entries(definition.maxOperationCounts || {}).flatMap(([operation, maximum]) => {
      const observed = operations.filter((entry) => entry === operation).length;
      return observed > maximum ? [{ operation, maximum, observed }] : [];
    });
    const missingOperationsByTurn = (definition.expectedOperationsPerTurn || []).map((expected, index) => ({
      turn: index + 1,
      missing: expected.filter((operation) => !turnEvidence[index]?.operations.includes(operation)),
    })).filter((entry) => entry.missing.length > 0);
    const unauditedUrlTurns = definition.urlEvidenceOperations
      ? turnEvidence.filter((turn) => containsUrl(turn.reply)
        && !definition.urlEvidenceOperations.some((operation) => turn.operations.includes(operation)))
        .map((turn) => turn.turn)
      : [];
    const conversation = getConversation({ userId, instanceId, projectId: instanceId, assistantId: instanceId, conversationId });
    const assertions = {
      traceSucceeded: trace?.status === "success",
      withinTenMinutes: elapsedMs < CASE_TIMEOUT_MS,
      expectedOperationsObserved: missingOperations.length === 0,
      noWriteOperations: writeOperations.length === 0,
      withinToolBudget: operations.length <= definition.maxToolCalls,
      withinOperationBudgets: operationCountOverages.length === 0,
      requiredSearchProviderObserved: unexpectedSearchProviders.length === 0,
      expectedOperationsPerTurnObserved: missingOperationsByTurn.length === 0,
      urlEvidenceAuditedPerTurn: unauditedUrlTurns.length === 0,
      assistantReplyPersisted: Boolean(conversation?.messages.some((message) => message.role === "assistant")),
    };
    const failedAssertions = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
    return {
      id: caseId,
      identity,
      domain: definition.domain,
      automaticStatus: failedAssertions.length === 0 ? "pass" : "fail",
      semanticStatus: trace?.status === "success" ? "pending_review" : "not_reviewable",
      allowedTools: definition.allowedTools,
      expectedOperations: definition.expectedOperations,
      expectedOperationMode,
      observedOperations: operations,
      missingOperations,
      missingOperationsByTurn,
      unauditedUrlTurns,
      operationCountOverages,
      unexpectedSearchProviders,
      writeOperations,
      maxToolCalls: definition.maxToolCalls,
      assertions,
      failedAssertions,
      elapsedMs,
      prompts,
      replies,
      turnEvidence,
      reply: replies.at(-1),
      trace,
      audits,
      telemetry,
      goldFacts: definition.goldFacts,
      requiredEvidence: definition.requiredEvidence,
      forbiddenClaims: definition.forbiddenClaims,
      environmentUnavailable: definition.environmentUnavailable || [],
      reviewNotes: definition.reviewNotes,
    };
  } catch (error) {
    return {
      id: caseId,
      identity,
      domain: definition.domain,
      automaticStatus: "fail",
      semanticStatus: "not_reviewable",
      allowedTools: definition.allowedTools,
      expectedOperations: definition.expectedOperations,
      expectedOperationMode: definition.expectedOperationMode === "any" ? "any" : "all",
      observedOperations: [],
      missingOperations: definition.expectedOperations,
      missingOperationsByTurn: [],
      unauditedUrlTurns: [],
      operationCountOverages: [],
      writeOperations: [],
      maxToolCalls: definition.maxToolCalls,
      assertions: { runnerCompleted: false },
      failedAssertions: ["runnerCompleted"],
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      goldFacts: definition.goldFacts,
      requiredEvidence: definition.requiredEvidence,
      forbiddenClaims: definition.forbiddenClaims,
      environmentUnavailable: definition.environmentUnavailable || [],
      reviewNotes: definition.reviewNotes,
    };
  } finally {
    if (previousAllowedTools === undefined) delete process.env.ACP_EVAL_MCP_ALLOWED_TOOLS;
    else process.env.ACP_EVAL_MCP_ALLOWED_TOOLS = previousAllowedTools;
    if (keepRuntime) disposeAcpForWorkspace(workspacePath);
    else await deleteInvestAgentInstance(instanceId).catch(() => undefined);
  }
}

function readLatestTrace(userId, instanceId, conversationId) {
  return sqlite.prepare(`
    SELECT status, elapsed_ms AS elapsedMs, reply_text_sanitized AS replyText, error_message AS errorMessage,
           input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens
    FROM codex_acp_traces
    WHERE user_id = ? AND instance_id = ? AND conversation_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, instanceId, conversationId);
}

function readAudits(userId, instanceId, conversationId) {
  return sqlite.prepare(`
    SELECT operation, resource_type AS resourceType, result_summary AS resultSummary, status
    FROM sandbox_audit_logs
    WHERE user_id = ? AND instance_id = ? AND conversation_id = ?
    ORDER BY created_at ASC
  `).all(userId, instanceId, conversationId);
}

async function readTelemetry(userId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const telemetryPath = path.join(config.runtimeData.sourceTelemetryDir, `${dateKey}.jsonl`);
  return readFile(telemetryPath, "utf8")
    .then((text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.userId === userId))
    .catch(() => []);
}

function isWriteOperation(operation) {
  return /^(confirmations\.request|onboarding\.|watchlist\.add|plans\.|method_changes\.|watch_rules\.create|reviews\.save|artifacts\.publish)/.test(operation);
}

function containsUrl(value) {
  return /https?:\/\/[^\s)\]]+/i.test(value);
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function renderMarkdown(result) {
  const lines = [
    "# ACP Data-Quality Evaluation",
    "",
    `- Run: \`${result.manifest.runId}\``,
    `- Model: \`${result.manifest.model}\``,
    `- Fixture: \`${result.manifest.fixtureVersion}\``,
    `- Git SHA: \`${result.manifest.gitSha}\``,
    `- Automatic: ${result.summary.automaticPass}/${result.summary.caseCount} passed; ${result.summary.automaticFail} failed`,
    `- Semantic review: ${result.summary.pendingSemanticReview} cases pending`,
    "",
    "## Cases",
    "",
    "| Case | Automatic | Elapsed | MCP operations | Semantic |",
    "| --- | --- | ---: | --- | --- |",
  ];
  for (const entry of result.cases) {
    lines.push(`| ${entry.id} | ${entry.automaticStatus} | ${entry.elapsedMs} ms | ${(entry.observedOperations || []).join(", ") || "none"} | ${entry.semanticStatus} |`);
  }
  for (const entry of result.cases) {
    lines.push("", `## ${entry.id}`, "", "### Customer-visible reply", "", entry.reply || "(no reply)", "", "### Review packet", "", "```json", JSON.stringify({
      goldFacts: entry.goldFacts,
      requiredEvidence: entry.requiredEvidence,
      forbiddenClaims: entry.forbiddenClaims,
      missingOperations: entry.missingOperations,
      missingOperationsByTurn: entry.missingOperationsByTurn,
      unauditedUrlTurns: entry.unauditedUrlTurns,
      operationCountOverages: entry.operationCountOverages,
      failedAssertions: entry.failedAssertions,
      turnEvidence: entry.turnEvidence,
      trace: entry.trace,
      audits: entry.audits,
      telemetry: entry.telemetry,
    }, null, 2), "```");
  }
  return lines.join("\n") + "\n";
}
