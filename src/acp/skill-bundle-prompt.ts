const INVEST_AGENT_BASE_SKILLS = [
  {
    id: "invest-agent-jr-method-reference",
    path: ".codex/skills/invest-agent-jr-ideal-operating-model/SKILL.md",
    purpose: "把 jr-backend 中有价值的低打扰、强确认、复盘闭环、观点追踪和方法进化纪律作为 Invest Agent 的方法论参考层；不把 jr-backend 文件当运行时存储。",
  },
  {
    id: "invest-agent-service-tools",
    path: ".codex/skills/invest-agent-service-tools/SKILL.md",
    purpose: "调用 Invest Agent 服务的确定性能力；读写业务数据时必须遵守 sandbox 和当前实例边界。",
  },
  {
    id: "invest-agent-daily-review",
    path: ".codex/skills/invest-agent-daily-review/SKILL.md",
    purpose: "生成日复盘、收盘复盘和明日关注，要求事实、推断、行动、验证点分开。",
  },
  {
    id: "invest-agent-weekly-review",
    path: ".codex/skills/invest-agent-weekly-review/SKILL.md",
    purpose: "汇总一周的复盘、提醒、计划变化和观点验证结果。",
  },
  {
    id: "invest-agent-monthly-review",
    path: ".codex/skills/invest-agent-monthly-review/SKILL.md",
    purpose: "汇总月度表现、策略问题和下月计划。",
  },
  {
    id: "invest-agent-stock-screening-qa",
    path: ".codex/skills/invest-agent-stock-screening-qa/SKILL.md",
    purpose: "回答行业、概念、公司、候选股、自选转换、风险和技术位置相关问题，并按需调用选股子技能。",
  },
  {
    id: "invest-agent-industry-outlook-analysis",
    path: ".codex/skills/invest-agent-industry-outlook-analysis/SKILL.md",
    purpose: "分析行业/主题前景、政策支持、空间、阶段和竞争结构。",
  },
  {
    id: "invest-agent-company-value-analysis",
    path: ".codex/skills/invest-agent-company-value-analysis/SKILL.md",
    purpose: "评估公司价值质量、盈利、现金流、效率和估值。",
  },
  {
    id: "invest-agent-competitive-moat-analysis",
    path: ".codex/skills/invest-agent-competitive-moat-analysis/SKILL.md",
    purpose: "评估竞争位置、产品力和护城河。",
  },
  {
    id: "invest-agent-technical-entry-analysis",
    path: ".codex/skills/invest-agent-technical-entry-analysis/SKILL.md",
    purpose: "评估技术位置、支撑压力、趋势、量能和观察条件。",
  },
  {
    id: "invest-agent-risk-assessment",
    path: ".codex/skills/invest-agent-risk-assessment/SKILL.md",
    purpose: "评估下行风险、安全边际、拥挤度、数据缺口和不适合关注的原因。",
  },
];

const INVEST_AGENT_BASE_CONSTRAINTS = [
  "JR 方法只作为投资工作法参考层；正式事实源是当前实例服务数据、审计日志和保存的复盘。",
  "投资方法主承载是 strategy skill：受保护骨架 + 当前实例展开；profile 只作为运行时兼容摘要和快速索引。",
  "任何会改变投资风格、方法论、通知策略、买卖规则、仓位规则或观察条件的长期状态，都必须形成草案并走确认；实例只能更新实例展开或业务表，不能修改受保护骨架。",
  "只处理当前投资助手实例的数据，不跨用户或跨实例读取、写入或推断。",
  "需要确定性数据时优先使用 invest-agent-service-tools，并通过 sandbox token 调用用户态接口。",
  "不承诺收益，不暗示自动交易；缺数据时说明缺口，不编造事实。",
  "客户回复中不暴露 skill 名称、文件路径、localhost、端口、API、Codex、Hermes、ACP 或调试过程。",
];

export function renderInvestAgentSkillPrompt() {
  const skillLines = INVEST_AGENT_BASE_SKILLS
    .map((skill) => `- ${skill.id}: ${skill.purpose} (${skill.path})`)
    .join("\n");
  const constraintLines = INVEST_AGENT_BASE_CONSTRAINTS.map((item) => `- ${item}`).join("\n");
  return [
    "当前项目绑定的 Skill Bundle：invest-agent-default（投资助手默认技能包，dedicated）",
    "面向单个投资助手实例的投资工作流技能包，覆盖巡检、复盘、选股问答和确定性服务工具调用。",
    "本轮只能优先使用该 bundle 内的技能说明；如 runtime 支持 skill discovery，请按这些技能的描述触发；如不支持，也必须按下面的用途和约束执行。",
    "允许/推荐技能：",
    skillLines,
    "关键约束：",
    constraintLines,
  ].join("\n");
}
