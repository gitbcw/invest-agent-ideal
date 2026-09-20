#!/usr/bin/env node
/**
 * 版本对照测试（owner 2026-09-12 授权「用 mgreplay 用户做小型版本对照」）：
 * 行业复盘「8-26 前旧版任务逻辑（mg at_60d62fcb rev14 忠实复刻）」vs「当前 rev24」，
 * 同一批回放日期（2026-09-08/09/10）各跑三轮，四维度盲评（按时产出/可用数据/
 * 易读可用/失败诚实）。两版共用同一部署代码与同一模型自动链，被测差异=
 * 任务逻辑层（指令语义 + expectedSchema/列规则/口径行 vs 纯自然语言）。
 *
 * 盲评纪律：任务代号 X1/X2，与新旧映射只记录在本地密封文件，不进任何产出材料。
 * 环境安全：mgreplay 独立 scope、两本空白隔离工作簿、delivery=none、mgreplay 无
 * 推送渠道绑定（失败通知自动跳过）；不动 mgreplay-industry-chain-test 与任何真实任务。
 *
 * 用法（在生产 /home/claude/invest-agent-mastra 下执行）：
 *   node scripts/mgreplay-ab-version-compare.mjs setup
 *   node scripts/mgreplay-ab-version-compare.mjs set-round 2
 *   node scripts/mgreplay-ab-version-compare.mjs run-one mgreplay-industry-ab-x1 1
 *   node scripts/mgreplay-ab-version-compare.mjs collect
 *   node scripts/mgreplay-ab-version-compare.mjs pause
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const OUT_DIR = "data/mgreplay-ab-20260912";
const SCOPE = { userId: "mgreplay", projectId: "invest-agent", instanceId: "invest-agent-mgreplay" };
const TASK_X1 = "mgreplay-industry-ab-x1";
const TASK_X2 = "mgreplay-industry-ab-x2";
const FILE_NAME = "2026年09月行业复盘表_序号分段版.xlsx";
const ROLLOVER = { kind: "monthly", fileNamePattern: "{YYYY}年{MM}月行业复盘表_序号分段版.xlsx" };
const SCHEDULE = { frequency: "trading_days", time: "19:30", timezone: "Asia/Shanghai" };

// —— rev14（2026-08-25，8-26 前最后一版）逐字复刻；仅末句月份按当前月适配（8月→9月）。
const REV14_CORE = `每个交易日19:30执行行业复盘。读取并更新当前绑定工作簿的最新版本，只维护第一个工作表《行业复盘》；不得新增、维护或另行写入第二个表格《个股明细》，个股层面的内容必须直接写入《行业复盘》的对应字段。沿用现有日期与序号格式，在表尾追加当日行业复盘，不覆盖、不删除、不重排任何历史内容；工作表字段统一采用新口径：将“行业内领涨公司”改为“涨停公司”，有可靠涨停池证据时仅记录该行业当日涨停公司名单，行业内无涨停记录时写“无涨停”；删除“涨幅”字段及其数据，不再写入行业内公司涨幅。若一个行业当日有超过2家涨停公司，必须在同一单元格内按序号分段记录，例如“1. 公司A；2. 公司B；3. 公司C”。“公司主力净流入”“趋势判断”“主要原因”必须写在《行业复盘》同一行的对应字段中，并使用与涨停公司完全一致的序号，对每家涨停公司逐一对应记录，不得错位、合并成无法对应的总括描述或把行业合计值冒充公司值。若只有1家涨停公司，可直接记录；若无涨停，涨停公司及后三个对应字段记录“无涨停”或“不适用”。写入前检查工作簿中是否已存在当日记录；如已存在，只补充确实缺失的当日内容，避免重复行。对历史记录进行兼容迁移时，将原“行业内领涨公司”列按可取得的当日涨停池证据改为涨停公司名单，无法核验时写“未取得可靠涨停池证据”，不得把涨幅靠前公司名单继续保留为涨停公司；删除原涨幅列；如存在历史《个股明细》工作表，不再追加新内容，后续个股信息全部并入《行业复盘》。复盘范围包括已取得的行业或相关ETF资金流向、涨停公司、资金流入较强公司、行业趋势及原因；只写入本轮有可靠证据的数据，保留来源、数据截止时间、核验说明和缺失项，不以推断值填补空缺，不把有限返回结果表述为全市场完整排名。保持清晰表头、冻结表头、筛选和适合阅读的列宽。文件按月份固定命名：当前9月使用《2026年09月行业复盘表_序号分段版.xlsx》；进入新月份时切换到对应月份的同规则工作簿后再继续追加，不在文件名中增加每日日期。`;

// —— rev24（当前）逐字复刻。
const REV24_CORE = `每个交易日19:30完成行业复盘：仅选取当日涨幅前10个行业，连续追加至当月工作簿《行业复盘》；同一交易日不得重复。个股层面内容直接写入《行业复盘》，不新建或追加《个股明细》。
每日仅记录当日涨幅前 10 个行业。
只维护《行业复盘》，不新建或追加《个股明细》。
每个行业一行，个股内容写在“涨停公司、公司主力净流入、趋势判断、主要原因”四列。
多家涨停公司时，四列均在各自单元格内按相同编号逐行换行记录，确保一一对应。
无涨停时填写“无涨停 / 不适用”。
不再写入普通领涨公司或涨幅字段。
自动任务改为始终读取工作簿最新版本，并要求每次成功执行必须提交有效的更新结果，避免再次因未交付新版表格而失败。
行业名称口径由你按当日复盘主线判断：申万一级或二级粒度均可，同一交易日内保持粒度一致；必须使用数据源的完整行业名，禁止截断、简写或自造合并名。`;

// —— 回放轮共用前置段（两版逐字一致，中性表述，缺失标注措辞留给各自指令语义）。
const BACKFILL_PREAMBLE = `本次为补录任务：为 2026-09-08、2026-09-09、2026-09-10 三个交易日各追加「当日涨幅前 10 名行业」的复盘行到绑定工作簿表尾（每个日期一组，严格沿用现有表头与列序）。历史数据口径：行业资金流用行业资金流矩阵的对应日期窗口；涨停公司用涨停池按日期回查；板块涨幅榜历史快照可取每日头部行业。某列历史值确实不可得时该单元格如实标注缺失，禁止用其他日期的值冒充当日值。`;

// —— 8-25 真实旧表（asset_525fcfd v9）的 17 列表头，逐字复刻。
const OLD_HEADERS = ["序号", "复盘日期", "行业代码", "行业名称", "当日涨跌幅(%)", "主力净流入(亿元)", "5日主力净流入(亿元)", "成交额(亿元)", "涨跌家数", "领涨公司", "领涨公司涨幅(%)", "资金流入最强公司", "公司主力净流入(亿元)", "趋势判断", "主要原因", "验证条件/风险", "来源与时间"];
// —— 当前 9 月表（rev24 契约）的 17 列表头。
const NEW_HEADERS = ["序号", "复盘日期", "行业代码", "行业名称", "当日涨跌幅(%)", "主力净流入(亿元)", "5日主力净流入(亿元)", "成交额(亿元)", "涨跌家数", "涨停公司", "已删除：公司涨幅(%)", "资金流入较强公司", "公司主力净流入(亿元)", "趋势判断", "主要原因", "验证条件/风险", "来源与时间"];

const coreFor = (task) => (task === TASK_X1 ? REV14_CORE : REV24_CORE);
const instructionFor = (task, round) => (round === 2 ? coreFor(task) : `${BACKFILL_PREAMBLE}\n${coreFor(task)}`);

const { sqlite } = await import("../dist/db/index.js");
const { createAutomationTask, updateAutomationTask, activateAutomationTask, pauseAutomationTask } = await import("../dist/services/automation-tasks.js");
const { createUserAsset, readCurrentUserAsset } = await import("../dist/services/user-assets.js");
const { snapshotWorkbookSchema } = await import("../dist/services/automation-spreadsheet.js");
const { runGenericAutomationTaskNow } = await import("../dist/services/generic-automation-runner.js");

const statePath = path.join(OUT_DIR, "state.json");
const loadState = () => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; } };
const saveState = (state) => { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2)); };
const latestRevision = (taskId) => sqlite.prepare("SELECT MAX(revision) AS r FROM automation_task_revisions WHERE task_id = ?").get(taskId).r;

async function buildWorkbook(kind) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  if (kind === "old") {
    const ws = wb.addWorksheet("行业复盘");
    ws.getRow(1).values = OLD_HEADERS;
  } else {
    const ws = wb.addWorksheet("数据");
    ws.getCell(1, 1).value = "2026年09月行业复盘表_序号分段版";
    ws.mergeCells(1, 1, 1, NEW_HEADERS.length);
    ws.getRow(2).values = NEW_HEADERS;
  }
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const asset = await createUserAsset({
    ...SCOPE, name: `行业复盘（对照·${kind === "old" ? "X1" : "X2"}）`, fileName: FILE_NAME,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes, source: "system",
  });
  return asset.assetId;
}

async function setup() {
  const rules = JSON.parse(readFileSync(new URL("./industry-review-column-rules.json", import.meta.url), "utf8"));
  if (rules["4"]?.kind !== "text") { console.error("[ab] rules JSON col4 is not kind=text — refusing (stale rules file)"); process.exit(2); }
  mkdirSync(OUT_DIR, { recursive: true });
  const assetX1 = await buildWorkbook("old");
  const assetX2 = await buildWorkbook("new");
  const snapshot = await snapshotWorkbookSchema((await readCurrentUserAsset({ ...SCOPE, assetId: assetX2 })).bytes);
  if (snapshot.columnCount !== 17 || snapshot.headerRow !== 2) { console.error(`[ab] X2 snapshot unexpected: ${JSON.stringify(snapshot)}`); process.exit(2); }
  const defs = {
    [TASK_X1]: {
      output: { mode: "update", assetId: assetX1, versionPolicy: "latest", rollover: ROLLOVER },
      inputs: [{ assetId: assetX1, role: "input", versionPolicy: "latest" }],
    },
    [TASK_X2]: {
      output: { mode: "update", assetId: assetX2, versionPolicy: "latest", rollover: ROLLOVER, expectedSchema: { ...snapshot, columnRules: rules } },
      inputs: [{ assetId: assetX2, role: "input", versionPolicy: "latest" }, { assetId: assetX2, role: "update_target", versionPolicy: "latest" }],
    },
  };
  const state = { createdAt: new Date().toISOString(), assets: { [TASK_X1]: assetX1, [TASK_X2]: assetX2 }, tasks: {} };
  for (const [taskId, def] of Object.entries(defs)) {
    const created = await createAutomationTask({
      ...SCOPE, taskId, name: `行业复盘对照·${taskId.endsWith("x1") ? "X1" : "X2"}`,
      instruction: instructionFor(taskId, 1), schedule: SCHEDULE,
      inputs: def.inputs, output: def.output, delivery: { mode: "none" },
      editSource: "script", editSourceRef: "mgreplay-ab-version-compare-20260912",
    });
    await activateAutomationTask({ ...SCOPE, taskId, expectedRevision: created.currentRevision });
    state.tasks[taskId] = { revision: latestRevision(taskId) };
    console.log(`[ab] created ${taskId} rev${latestRevision(taskId)} asset=${def.output.assetId}`);
  }
  saveState(state);
  console.log(`[ab] setup done → ${statePath}`);
}

async function setRound(round) {
  const state = loadState();
  if (!state) { console.error("[ab] no state — run setup first"); process.exit(2); }
  for (const taskId of [TASK_X1, TASK_X2]) {
    const rev = sqlite.prepare("SELECT revision, name, schedule_json, inputs_json, output_json, delivery_json FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(taskId);
    const updated = await updateAutomationTask({
      ...SCOPE, taskId, expectedRevision: rev.revision,
      name: rev.name, instruction: instructionFor(taskId, round),
      schedule: JSON.parse(rev.schedule_json || "{}"),
      inputs: JSON.parse(rev.inputs_json || "[]"),
      output: JSON.parse(rev.output_json || "{}"),
      delivery: JSON.parse(rev.delivery_json || "{}"),
      editSource: "script", editSourceRef: `mgreplay-ab-set-round-${round}`,
    });
    console.log(`[ab] ${taskId} round ${round} instruction set at rev${updated.currentRevision}`);
  }
}

async function runOne(taskId, round) {
  const started = Date.now();
  const result = await runGenericAutomationTaskNow({
    scope: SCOPE, taskId, origin: "manual",
    idempotencyKey: `mgreplay-ab-${taskId.slice(-2)}-r${round}-${new Date().toISOString().slice(0, 16)}`,
  });
  const run = result.run;
  const record = {
    taskId, round, runId: run.runId, status: run.status, deliveryStatus: run.deliveryStatus,
    durationSec: Math.round((Date.now() - started) / 1000),
    errorMessage: run.errorMessage ?? null, errorCategory: run.errorCategory ?? null,
    resultSummary: run.resultSummary ?? null, outputAssetId: run.outputAssetId ?? null,
    outputVersionId: run.outputVersionId ?? null, revisionNumber: run.revisionNumber ?? null,
    finishedAt: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, `run-${taskId.slice(-2)}-r${round}.json`), JSON.stringify(record, null, 2));
  console.log(`[ab] ${taskId} r${round}: ${record.status} in ${record.durationSec}s err=${(record.errorMessage ?? "none").slice(0, 160)}`);
  console.log(`[ab] summary: ${(record.resultSummary ?? "none").slice(0, 500)}`);
}

async function collect() {
  const state = loadState();
  const ExcelJS = (await import("exceljs")).default;
  const out = { collectedAt: new Date().toISOString(), variants: {} };
  for (const taskId of [TASK_X1, TASK_X2]) {
    const rev = sqlite.prepare("SELECT output_json FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(taskId);
    const output = JSON.parse(rev.output_json || "{}");
    const current = await readCurrentUserAsset({ ...SCOPE, assetId: output.assetId });
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(current.bytes);
    await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const sheets = wb.worksheets.map((ws) => {
      // 原样转储所有非空行（含表头行），不在采集侧预设结构——是否建对表头本身是被测行为。
      const rows = [];
      for (let r = 1; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const cells = [];
        for (let c = 1; c <= ws.columnCount; c += 1) {
          const v = row.getCell(c).value;
          cells.push(v === null || v === undefined ? "" : (typeof v === "object" && v.richText ? v.richText.map((t) => t.text).join("") : (typeof v === "object" && v.result !== undefined ? String(v.result) : String(v))));
        }
        if (cells.some((t) => t.trim() !== "")) rows.push(cells);
      }
      return { sheet: ws.name, columnCount: ws.columnCount, nonEmptyRows: rows.length, rows };
    });
    const runs = sqlite.prepare("SELECT run_id, status, started_at, finished_at, result_summary, error_message, error_category, output_version_id FROM automation_task_runs WHERE task_id = ? ORDER BY started_at").all(taskId)
      .map((r) => ({ ...r, durSec: r.started_at && r.finished_at ? Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000) : null }));
    out.variants[taskId] = { assetId: output.assetId, sheets, runs };
  }
  writeFileSync(path.join(OUT_DIR, "collect.json"), JSON.stringify(out, null, 2));
  console.log(`[ab] collected → ${path.join(OUT_DIR, "collect.json")}`);
  for (const [taskId, v] of Object.entries(out.variants)) {
    for (const s of v.sheets) console.log(`[ab] ${taskId} sheet=${s.sheet} rows=${s.rowCount}`);
    for (const r of v.runs) console.log(`[ab] ${taskId} run ${r.runId} ${r.status} ${r.durSec}s err=${(r.error_message ?? "none").slice(0, 80)}`);
  }
}

async function pause() {
  for (const taskId of [TASK_X1, TASK_X2]) {
    try {
      await pauseAutomationTask({ ...SCOPE, taskId });
      console.log(`[ab] paused ${taskId}`);
    } catch (e) { console.log(`[ab] pause ${taskId}: ${String(e).slice(0, 120)}`); }
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "setup") await setup();
else if (cmd === "set-round") await setRound(Number(args[0]));
else if (cmd === "run-one") await runOne(args[0], Number(args[1]));
else if (cmd === "collect") await collect();
else if (cmd === "pause") await pause();
else { console.error("usage: setup | set-round <1|2|3> | run-one <taskId> <round> | collect | pause"); process.exit(2); }
process.exit(0);
