/**
 * 对话评估集执行器
 *
 * 用法:
 *   npm run eval:conversation           # 跑全部 case
 *   npm run eval:conversation -- --only=portfolio-001    # 只跑某条
 *   npm run eval:conversation -- --dry-run                # 只解析+列出 case,不真跑
 *
 * 输出:
 *   eval-reports/<YYYY-MM-DD>/results.md   — 单文件,按 case 分段
 *   eval-reports/<YYYY-MM-DD>/results.json — 同内容机器可读版,供 AI 评估时引用
 *
 * 通道:
 *   直接调 AcpAgent.handleMessage(),走真实 Codex ACP + triage + 工具层。
 *   测试用户独立工作空间(userId=eval),与 primary 用户数据隔离。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const casesPath = resolve(__dirname, "cases.yaml");

// 解析 CLI 参数
const args = process.argv.slice(2);
const onlyId = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const dryRun = args.includes("--dry-run");

const raw = parse(readFileSync(casesPath, "utf-8"));
const testUser = raw.test_user;
const allCases = raw.cases;

if (!testUser || !Array.isArray(allCases)) {
  console.error("cases.yaml 格式错误:缺少 test_user 或 cases");
  process.exit(1);
}

const cases = onlyId ? allCases.filter((c) => c.id === onlyId) : allCases;

if (cases.length === 0) {
  console.error(`未找到匹配的 case (--only=${onlyId})`);
  process.exit(1);
}

console.log(`=== 对话评估集 ===`);
console.log(`测试用户: ${testUser.userId} / ${testUser.instanceId}`);
console.log(`待跑 case: ${cases.length} / ${allCases.length}`);
if (dryRun) console.log(`[dry-run] 只解析,不真跑通道`);
console.log("");

if (dryRun) {
  for (const c of cases) {
    console.log(`- ${c.id} [${c.scenario}]`);
    console.log(`  输入: ${c.user_input}`);
    console.log(`  must_contain: ${(c.expected?.must_contain ?? []).join(" / ")}`);
    console.log(`  must_not_contain: ${(c.expected?.must_not_contain ?? []).join(" / ")}`);
    console.log("");
  }
  process.exit(0);
}

// 动态加载(避免顶层 import 失败时无法 --dry-run)
const { ensureDefaultProjectForUser } = await import("../../src/platform/project-registry.ts");
const { hermesWeixinMobileManager } = await import("../../src/channels/weixin-mobile.ts");

// 1. 确保测试用户绑定到 invest-agent project(拿到正确的 projectType / skillBundleId / 等),
//    否则 prompt-context-builder 不会加载 invest-agent 相关 SKILL,行为跟真实微信不一致。
await ensureDefaultProjectForUser(testUser.userId, "codex", "评估测试用户");

// 2. 跑批:走真实微信通道(hermesWeixinMobileManager → HermesWeixinMobileBridge.chat)。
//    注意:必须用 hermesWeixinMobileManager 而不是 weixinMobileManager ——
//    实际线上微信 trace 显示,简单意图都走 fast-admin 路径直接落库(DeepSeek 判意图 + 工具直调),
//    而 fast-admin 只在 HermesWeixinMobileBridge.chat 里有。
//    weixinMobileManager(InvestAgentMobileBridge)跳过 fast-admin,直接进 Codex,行为完全不一样。
const accountId = `eval-account-${testUser.userId}`;
const results = [];

for (const c of cases) {
  process.stdout.write(`▶ ${c.id} [${c.scenario}] ... `);
  const startedAt = Date.now();
  let actual = "";
  let error = null;
  try {
    const response = await hermesWeixinMobileManager.simulateIncomingText({
      text: c.user_input,
      conversationId: testUser.conversationId,
      accountId,
    });
    actual = response.text ?? "";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = Date.now() - startedAt;
  results.push({
    id: c.id,
    scenario: c.scenario,
    user_input: c.user_input,
    expected: c.expected ?? {},
    actual_output: actual,
    error,
    elapsed_ms: elapsedMs,
    ran_at: new Date().toISOString(),
  });
  if (error) {
    console.log(`ERROR (${elapsedMs}ms): ${error}`);
  } else {
    const preview = actual.slice(0, 60).replace(/\n/g, " ");
    console.log(`OK (${elapsedMs}ms): ${preview}...`);
  }
}

// 3. 落结果
const today = new Date().toISOString().slice(0, 10);
const outDir = resolve(__dirname, "..", "..", "eval-reports", today);
mkdirSync(outDir, { recursive: true });

// markdown 报告
const mdLines = [];
mdLines.push(`# 对话评估报告 ${today}`);
mdLines.push("");
mdLines.push(`- 测试用户: \`${testUser.userId}\` / \`${testUser.instanceId}\``);
mdLines.push(`- conversationId: \`${testUser.conversationId}\``);
mdLines.push(`- 通道: api (AcpAgent.handleMessage 直调)`);
mdLines.push(`- 跑批时间: ${new Date().toISOString()}`);
mdLines.push(`- case 总数: ${results.length}`);
mdLines.push(`- 出错数: ${results.filter((r) => r.error).length}`);
mdLines.push("");
mdLines.push(`> 评估说明: 本报告只记录实际输出,不含 AI 评分。`);
mdLines.push(`> 由 AI(Claude/Codex)读这份报告后,逐条对照 expected 判断语义匹配度,`);
mdLines.push(`> 找出缺漏 / 越界 / 风格问题,给出修复建议。`);
mdLines.push("");
mdLines.push("---");
mdLines.push("");

for (const r of results) {
  mdLines.push(`## ${r.id} [${r.scenario}]`);
  mdLines.push("");
  mdLines.push(`**输入**:`);
  mdLines.push(`> ${r.user_input}`);
  mdLines.push("");
  mdLines.push(`**预期**:`);
  if (r.expected.must_contain?.length) {
    mdLines.push(`- 必须包含:`);
    for (const m of r.expected.must_contain) mdLines.push(`  - ${m}`);
  }
  if (r.expected.must_not_contain?.length) {
    mdLines.push(`- 不能包含:`);
    for (const m of r.expected.must_not_contain) mdLines.push(`  - ${m}`);
  }
  if (r.expected.style_notes) {
    mdLines.push(`- 风格: ${r.expected.style_notes}`);
  }
  mdLines.push("");
  mdLines.push(`**实际输出** (${r.elapsed_ms}ms${r.error ? " / ERROR" : ""}):`);
  mdLines.push("");
  if (r.error) {
    mdLines.push(`\`\`\``);
    mdLines.push(`[ERROR] ${r.error}`);
    mdLines.push(`\`\`\``);
  } else {
    mdLines.push(`> ${r.actual_output.replace(/\n/g, "\n> ")}`);
  }
  mdLines.push("");
  mdLines.push("---");
  mdLines.push("");
}

writeFileSync(resolve(outDir, "results.md"), mdLines.join("\n"));

// json 报告(给 AI 评估时结构化引用)
writeFileSync(
  resolve(outDir, "results.json"),
  JSON.stringify({ ran_at: new Date().toISOString(), test_user: testUser, results }, null, 2),
);

console.log("");
console.log(`=== 完成 ===`);
console.log(`Markdown: eval-reports/${today}/results.md`);
console.log(`JSON:     eval-reports/${today}/results.json`);
