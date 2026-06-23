export interface SkillBundleSkill {
  id: string;
  path: string;
  purpose: string;
}

export interface SkillBundle {
  id: string;
  displayName: string;
  mode: "dedicated" | "shared";
  description: string;
  skills: SkillBundleSkill[];
  constraints: string[];
}

export interface SkillBundlePromptSummary {
  id: string;
  displayName: string;
  mode: string;
  projectType: string;
  description: string;
  skills: SkillBundleSkill[];
  constraints: string[];
}

export const INVEST_AGENT_SKILL_BUNDLE_ID = "invest-agent-default";
export const INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE_ID = "invest-agent-primary-custom";
export const INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE_ID = "invest-agent-mg-custom";
export const INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE_ID = "invest-agent-jr-ideal";
export const DIET_RECOMMENDATION_SKILL_BUNDLE_ID = "diet-recommendation-default";

const INVEST_AGENT_METHOD_REFERENCE_SKILL: SkillBundleSkill = {
  id: "invest-agent-jr-method-reference",
  path: ".codex/skills/invest-agent-jr-ideal-operating-model/SKILL.md",
  purpose: "把 jr-backend 中有价值的低打扰、强确认、复盘闭环、观点追踪和方法进化纪律作为 Invest Agent 的方法论参考层；不把 jr-backend 文件当运行时存储。",
};

const INVEST_AGENT_MIDDLE_TREND_STRATEGY_SKILL: SkillBundleSkill = {
  id: "invest-agent-strategy-middle-trend",
  path: ".codex/skills/invest-agent-strategy-middle-trend/SKILL.md",
  purpose: "中线趋势投资实践的策略 Skill 工程体；包含受保护骨架、实例展开、复盘/选股/提醒规则和确认式进化边界。",
};

const INVEST_AGENT_BASE_SKILLS: SkillBundleSkill[] = [
  INVEST_AGENT_METHOD_REFERENCE_SKILL,
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

const INVEST_AGENT_JR_IDEAL_SKILLS: SkillBundleSkill[] = [
  ...INVEST_AGENT_BASE_SKILLS,
  INVEST_AGENT_MIDDLE_TREND_STRATEGY_SKILL,
];

const INVEST_AGENT_BASE_CONSTRAINTS = [
  "JR 方法只作为投资工作法参考层；正式事实源是当前实例服务数据、审计日志和保存的复盘。",
  "投资方法主承载是 strategy skill：受保护骨架 + 当前实例展开；profile 只作为运行时兼容摘要和快速索引。",
  "Hermes 记忆只用于对话连续性和短中期上下文；不得把 Hermes 记忆里的投资偏好直接当成已确认策略。",
  "任何会改变投资风格、方法论、通知策略、买卖规则、仓位规则或观察条件的长期状态，都必须形成草案并走确认；实例只能更新实例展开或业务表，不能修改受保护骨架。",
  "只处理当前投资助手实例的数据，不跨用户或跨实例读取、写入或推断。",
  "需要确定性数据时优先使用 invest-agent-service-tools，并通过 sandbox token 调用用户态接口。",
  "不承诺收益，不暗示自动交易；缺数据时说明缺口，不编造事实。",
  "客户回复中不暴露 skill 名称、文件路径、localhost、端口、API、Codex、Hermes、ACP 或调试过程。",
];

const INVEST_AGENT_SKILL_BUNDLE: SkillBundle = {
  id: INVEST_AGENT_SKILL_BUNDLE_ID,
  displayName: "投资助手默认技能包",
  mode: "dedicated",
  description: "面向单个投资助手实例的投资工作流技能包，覆盖巡检、复盘、选股问答和确定性服务工具调用。",
  skills: INVEST_AGENT_BASE_SKILLS,
  constraints: INVEST_AGENT_BASE_CONSTRAINTS,
};

const INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE: SkillBundle = {
  id: INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE_ID,
  displayName: "主用户投资助手定制技能包",
  mode: "dedicated",
  description: "面向主用户投资助手实例的个人定制技能包；当前继承默认投资工作流，后续可追加主用户专属方法论、节奏和偏好 skill。",
  skills: INVEST_AGENT_BASE_SKILLS,
  constraints: [
    "这是主用户个人定制投资助手实例；回答和写入必须严格限定在主用户实例内。",
    "优先遵循主用户的投资方法论、复盘纪律和自选/持仓管理习惯；若专属 skill 尚未存在，先使用默认投资技能包规则。",
    ...INVEST_AGENT_BASE_CONSTRAINTS,
  ],
};

const INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE: SkillBundle = {
  id: INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE_ID,
  displayName: "明光投资助手定制技能包",
  mode: "dedicated",
  description: "面向明光投资助手实例的个人定制技能包；当前继承默认投资工作流，后续可追加明光专属策略、节奏和偏好 skill。",
  skills: INVEST_AGENT_BASE_SKILLS,
  constraints: [
    "这是明光个人定制投资助手实例；回答和写入必须严格限定在明光实例内。",
    "优先遵循明光的投资偏好和后续专属方法论；若专属 skill 尚未存在，先使用默认投资技能包规则。",
    ...INVEST_AGENT_BASE_CONSTRAINTS,
  ],
};

const INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE: SkillBundle = {
  id: INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE_ID,
  displayName: "JR 方法参考实验技能包",
  mode: "dedicated",
  description: "面向 JR 方法参考实验的投资助手技能包；验证 jr-backend 的输出纪律和闭环设计能否作为 Invest Agent 方法论参考层工作，而不是作为第二套运行框架。",
  skills: INVEST_AGENT_JR_IDEAL_SKILLS,
  constraints: [
    "这是 JR 方法参考实验实例；目标是验证 jr-backend 的方法纪律能否融入当前 Invest Agent 架构，而不是验证原始文档工作区是否能原样运行。",
    "JR 实验实例可使用中线趋势策略 Skill 的实例展开层；单用户实例只能提出或确认实例展开更新，不能直接修改受保护的基础策略骨架。",
  "jr-backend 的 config/knowledge/memory/reports 不参与运行时读写；实时事实、方法、记忆和审计必须落在当前实例服务、strategy skill、Hermes 对话上下文和 sandbox 机制各自的边界内。",
  "如果 JR 参考材料、Hermes 记忆、profile 兼容摘要、strategy skill 或业务数据互相冲突，优先采用当前实例服务数据和确认过的 strategy skill 展开，并把冲突暴露为待确认问题。",
    ...INVEST_AGENT_BASE_CONSTRAINTS,
  ],
};

const DIET_RECOMMENDATION_SKILL_BUNDLE: SkillBundle = {
  id: DIET_RECOMMENDATION_SKILL_BUNDLE_ID,
  displayName: "饮食推荐共享技能包",
  mode: "shared",
  description: "面向共享饮食推荐项目的多用户技能包，同一套饮食建议流程服务多个微信用户。",
  skills: [
    {
      id: "diet-recommendation-assistant",
      path: ".codex/skills/diet-recommendation-assistant/SKILL.md",
      purpose: "根据用户目标、忌口、过敏、口味、预算、时间和执行条件给出实用饮食建议。",
    },
  ],
  constraints: [
    "同一项目可服务多个微信用户，但每个用户的偏好、目标和对话上下文必须互相隔离。",
    "不使用投资助手的持仓、自选、交易预案、提醒、复盘等工具和数据。",
    "不做医疗诊断，不承诺治疗或减重结果；疾病、孕期、儿童、严重过敏、用药冲突等场景建议咨询专业人士。",
    "客户回复中不暴露 skill 名称、文件路径、localhost、端口、API、Codex、Hermes、ACP 或调试过程。",
  ],
};

const bundles = new Map<string, SkillBundle>([
  [INVEST_AGENT_SKILL_BUNDLE.id, INVEST_AGENT_SKILL_BUNDLE],
  [INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE.id, INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE],
  [INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE.id, INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE],
  [INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE.id, INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE],
  [DIET_RECOMMENDATION_SKILL_BUNDLE.id, DIET_RECOMMENDATION_SKILL_BUNDLE],
]);

export function getSkillBundle(bundleId?: string | null) {
  return bundles.get(bundleId || "") || INVEST_AGENT_SKILL_BUNDLE;
}

export function summarizeSkillBundle(bundleId?: string | null): SkillBundlePromptSummary {
  const bundle = getSkillBundle(bundleId);
  return {
    id: bundle.id,
    displayName: bundle.displayName,
    mode: bundle.mode,
    projectType: bundle.id.startsWith("diet-recommendation") ? "diet-recommendation" : "invest-agent",
    description: bundle.description,
    skills: bundle.skills.map((skill) => ({ ...skill })),
    constraints: [...bundle.constraints],
  };
}

export function listSkillBundles(projectType?: string | null) {
  const summaries = Array.from(bundles.values()).map((bundle) => summarizeSkillBundle(bundle.id));
  if (!projectType) return summaries;
  return summaries.filter((bundle) => bundle.projectType === projectType);
}

export function renderSkillBundlePrompt(bundleId?: string | null) {
  const bundle = summarizeSkillBundle(bundleId);
  const skillLines = bundle.skills
    .map((skill) => `- ${skill.id}: ${skill.purpose} (${skill.path})`)
    .join("\n");
  const constraintLines = bundle.constraints.map((item) => `- ${item}`).join("\n");
  return [
    `当前项目绑定的 Skill Bundle：${bundle.id}（${bundle.displayName}，${bundle.mode}）`,
    bundle.description,
    "本轮只能优先使用该 bundle 内的技能说明；如 runtime 支持 skill discovery，请按这些技能的描述触发；如不支持，也必须按下面的用途和约束执行。",
    "允许/推荐技能：",
    skillLines,
    "关键约束：",
    constraintLines,
  ].join("\n");
}
