/**
 * 告知协议校验门禁冒烟测试
 *
 * 验证 src/services/indicator-acknowledgement.ts:
 *   1. stable + 无 data_source_notes → 无需告知,passed=true
 *   2. experimental + 未签 → passed=false,reasons 列出原因
 *   3. experimental + 已签 + via 白名单 → passed=true
 *   4. experimental + 已签 + via 不在白名单 → passed=false
 *   5. data_source_notes 非空 → 触发告知要求
 *   6. acknowledged_at 时间戳格式校验
 *   7. data_source_notes 模板生成
 *   8. L3a 和 L3b 配置都用同一接口校验
 *
 * 运行:npm run smoke:indicator-acknowledgement
 */

import {
  validateAcknowledgement,
  requiresAcknowledgement,
  buildDataSourceNotesTemplate,
} from "../dist/services/indicator-acknowledgement.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

// === 1. stable + 无 notes → 无需告知 ===
{
  const cfg = {
    key: "stable_no_notes",
    reliability: "stable",
    user_acknowledged: false,
  };
  const verdict = validateAcknowledgement(cfg);
  assert(verdict.passed === true, `stable 无 notes 应放行`);
  assert(verdict.requiresAcknowledgement === false, `不应要求告知`);
  assert(verdict.reasons.length === 0, `reasons 应为空`);
  console.log(`[OK] stable + 无 notes 放行`);
}

// === 2. experimental 未签 → 拒绝 ===
{
  const cfg = {
    key: "experimental_unsigned",
    reliability: "experimental",
    user_acknowledged: false,
  };
  const verdict = validateAcknowledgement(cfg);
  assert(verdict.passed === false, `experimental 未签应拒绝`);
  assert(verdict.requiresAcknowledgement === true, `应要求告知`);
  assert(
    verdict.reasons.some((r) => r.includes("user_acknowledged=false")),
    `应说明原因,实际: ${JSON.stringify(verdict.reasons)}`,
  );
  console.log(`[OK] experimental 未签拒绝: ${verdict.reasons[0]}`);
}

// === 3. experimental + 已签 + via 白名单 → 通过 ===
{
  const cfg = {
    key: "experimental_signed_properly",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22T10:00:00Z",
    acknowledged_via: "weixin-mobile",
  };
  const verdict = validateAcknowledgement(cfg);
  assert(verdict.passed === true, `已签 + via 白名单应通过`);
  assert(verdict.requiresAcknowledgement === true, `应仍标记需要告知(只是已通过)`);
  console.log(`[OK] experimental + 已签 + weixin-mobile 通过`);
}

// === 4. via 不在白名单 → 拒绝 ===
{
  const cfg = {
    key: "bad_via",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22",
    acknowledged_via: "sms",                // 不在白名单
  };
  const verdict = validateAcknowledgement(cfg);
  assert(verdict.passed === false, `via='sms' 应拒绝`);
  assert(
    verdict.reasons.some((r) => r.includes("不在白名单")),
    `应提示 via 不在白名单,实际: ${JSON.stringify(verdict.reasons)}`,
  );
  console.log(`[OK] via 不在白名单拒绝: ${verdict.reasons[0]}`);
}

// === 5. data_source_notes 非空 → 触发告知 ===
{
  const cfg = {
    key: "stable_with_notes",
    reliability: "stable",
    data_source_notes: ["[近似模型] 换手率按成交量 0.3 系数估算"],
    user_acknowledged: false,
  };
  assert(
    requiresAcknowledgement(cfg) === true,
    `data_source_notes 非空应触发告知要求`,
  );
  const verdict = validateAcknowledgement(cfg);
  assert(verdict.passed === false, `未签应拒绝`);
  console.log(`[OK] stable + notes 非空 触发告知要求`);
}

// === 6. acknowledged_at 格式校验 ===
{
  // 合法:仅日期
  const v1 = validateAcknowledgement({
    key: "date_only",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22",
    acknowledged_via: "dashboard",
  });
  assert(v1.passed === true, `日期格式 YYYY-MM-DD 应通过`);

  // 合法:完整 ISO
  const v2 = validateAcknowledgement({
    key: "full_iso",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22T15:30:00+08:00",
    acknowledged_via: "dashboard",
  });
  assert(v2.passed === true, `完整 ISO 应通过`);

  // 非法:垃圾字符串
  const v3 = validateAcknowledgement({
    key: "bad_ts",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "昨天",
    acknowledged_via: "dashboard",
  });
  assert(v3.passed === false, `非法时间戳应拒绝`);
  assert(
    v3.reasons.some((r) => r.includes("不是合法 ISO 时间")),
    `应说明时间戳非法,实际: ${JSON.stringify(v3.reasons)}`,
  );
  console.log(`[OK] acknowledged_at 格式校验`);
}

// === 7. 已签但缺 via → 拒绝 ===
{
  const v = validateAcknowledgement({
    key: "missing_via",
    reliability: "experimental",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22",
    // 缺 acknowledged_via
  });
  assert(v.passed === false, `缺 via 应拒绝`);
  assert(v.reasons.some((r) => r.includes("缺 acknowledged_via")), `应说明缺 via`);
  console.log(`[OK] 已签但缺 via 拒绝`);
}

// === 8. L3a 真实配置走一遍 ===
{
  // 模拟 templates/workspace/config/composite_indicators.yaml 第一条
  const l3aConfig = {
    key: "macd_volume_combo",
    name: "MACD 金叉且量比放大",
    reliability: "stable",
    user_acknowledged: true,
    acknowledged_at: "2026-06-22",
    acknowledged_via: "weixin-mobile",
  };
  const verdict = validateAcknowledgement(l3aConfig);
  assert(verdict.passed === true, `L3a stable 应直接通过`);
  console.log(`[OK] L3a stable 配置通过`);
}

// === 9. L3b 主力控盘(实验性 + 缺失数据源)走一遍 ===
{
  // 模拟客户要做的主力控盘指标
  const l3bConfig = {
    key: "main_force_control",
    name: "主力控盘度",
    reliability: "experimental",
    data_source_notes: [
      "[缺失数据源] 换手率历史未存储,按成交量系数 0.3 估算",
      "[近似模型] 筹码分布基于换手率衰减,精度有限",
      "[经验系数] ZLCM=WINNER(CLOSE)*70+... 含 0.3 等经验系数",
    ],
    user_acknowledged: true,
    acknowledged_at: "2026-06-22",
    acknowledged_via: "weixin-mobile",
  };
  const verdict = validateAcknowledgement(l3bConfig);
  assert(verdict.passed === true, `experimental + 完整告知应通过`);
  assert(verdict.requiresAcknowledgement === true, `应仍标记为需要告知`);
  console.log(`[OK] L3b 主力控盘 实验性 + 完整告知 通过`);
}

// === 10. L3b 主力控盘(未签)→ 拒绝 ===
{
  const l3bConfig = {
    key: "main_force_control",
    name: "主力控盘度",
    reliability: "experimental",
    data_source_notes: ["[缺失数据源] 换手率"],
    user_acknowledged: false,
  };
  const verdict = validateAcknowledgement(l3bConfig);
  assert(verdict.passed === false, `未签应拒绝`);
  assert(verdict.reasons.length >= 1, `应给出原因`);
  console.log(`[OK] L3b 实验性未签拒绝: ${verdict.reasons.length} 个原因`);
}

// === 11. buildDataSourceNotesTemplate ===
{
  const notes = buildDataSourceNotesTemplate(
    ["换手率历史未存储", "Level-2 盘口缺失"],
    ["筹码分布按换手率衰减近似"],
  );
  assert(notes.length === 3, `应生成 3 条 notes,实际 ${notes.length}`);
  assert(notes[0].includes("[缺失数据源]"), `第 1 条应标记缺失数据源`);
  assert(notes[2].includes("[近似模型]"), `第 3 条应标记近似模型`);
  console.log(`[OK] data_source_notes 模板: ${notes.length} 条`);
}

console.log("\n✅ 告知协议校验门禁冒烟测试通过");
