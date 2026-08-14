import type { AutomationCreateRequest } from "@/lib/protocol";

export type AutomationTemplateCategory = "information" | "review" | "asset";
export type AutomationTemplateRequirement = "wechat" | "input_asset" | "update_asset";

export interface AutomationTemplate {
  templateId: string;
  version: number;
  name: string;
  summary: string;
  icon: string;
  category: AutomationTemplateCategory;
  preset: Partial<AutomationCreateRequest>;
  requirements: AutomationTemplateRequirement[];
}

const schedule = { frequency: "trading_days" as const, time: "08:30", timezone: "Asia/Shanghai" as const };

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    templateId: "daily-market-information",
    version: 1,
    name: "每日市场重要信息推送",
    summary: "整理当天影响投资判断的市场、政策和公司重要信息。",
    icon: "📣",
    category: "information",
    preset: { name: "每日市场重要信息", description: "每天整理市场上值得关注的重要信息，并说明它可能影响哪些投资判断。", instruction: "请整理当天影响投资判断的市场、政策、行业和公司重要信息，去重后按重要程度输出简明摘要。", schedule, delivery: { mode: "wechat_on_condition", conditionVersion: 1 } },
    requirements: ["wechat"],
  },
  {
    templateId: "industry-major-dynamics",
    version: 1,
    name: "行业重大动态跟踪",
    summary: "持续关注指定行业的政策、供需、竞争和事件变化。",
    icon: "🔎",
    category: "information",
    preset: { name: "行业重大动态跟踪", description: "持续关注我关心的行业，只推送真正可能改变判断的重要变化。", instruction: "请跟踪我指定行业的政策、供需、竞争格局和重大事件，只保留会改变投资判断的变化，并说明影响。", schedule: { frequency: "daily", time: "09:00", timezone: "Asia/Shanghai" }, delivery: { mode: "wechat_on_condition", conditionVersion: 1 } },
    requirements: ["wechat"],
  },
  {
    templateId: "portfolio-company-announcements",
    version: 1,
    name: "持仓公司公告摘要",
    summary: "将持仓公司的重要公告压缩成可快速阅读的摘要。",
    icon: "🏢",
    category: "information",
    preset: { name: "持仓公司公告摘要", description: "每天检查持仓公司的公告，出现需要关注的内容时告诉我重点。", instruction: "请检查持仓公司的最新公告，提炼业绩、经营、风险、股东和资本动作等重要内容，并标记需要进一步关注的事项。", schedule: { ...schedule, time: "18:30" }, delivery: { mode: "wechat_summary" } },
    requirements: ["wechat"],
  },
  {
    templateId: "weekly-watchlist-review",
    version: 1,
    name: "每周观察池复盘",
    summary: "每周回顾观察池变化，沉淀本周新信息和下周关注点。",
    icon: "🗂️",
    category: "review",
    preset: { name: "每周观察池复盘", description: "每周复盘观察池，告诉我哪些公司发生了变化、下一步看什么。", instruction: "请每周复盘观察池公司的价格表现、基本面变化和最新催化剂，区分事实与判断，给出下周观察重点。", schedule: { frequency: "weekly", time: "17:30", timezone: "Asia/Shanghai", weekdays: [5] }, output: { mode: "agent" }, delivery: { mode: "wechat_summary" } },
    requirements: ["wechat"],
  },
  {
    templateId: "update-investment-tracker",
    version: 1,
    name: "定期更新投资跟踪表",
    summary: "根据任务说明和附件，定期整理、更新你的投资跟踪表。",
    icon: "📊",
    category: "asset",
    preset: { name: "定期更新投资跟踪表", description: "根据附件里的投资跟踪表，按我的说明定期补充和整理内容。", instruction: "请根据我上传的投资跟踪表和任务说明，补充最新信息、检查异常并保持原有表格结构；完成后说明做了哪些更新。", schedule: { frequency: "daily", time: "20:00", timezone: "Asia/Shanghai" }, output: { mode: "agent" } },
    requirements: ["update_asset"],
  },
  {
    templateId: "weekly-research-digest",
    version: 1,
    name: "每周研究资料汇总",
    summary: "把一周新增研究资料整理成有重点、可回看的摘要。",
    icon: "📝",
    category: "review",
    preset: { name: "每周研究资料汇总", description: "每周整理我新增的研究资料，告诉我本周有哪些重要结论和待验证问题。", instruction: "请汇总本周新增研究资料，按主题整理关键事实、不同观点、尚未验证的问题和下一步建议，避免重复堆砌原文。", schedule: { frequency: "weekly", time: "17:00", timezone: "Asia/Shanghai", weekdays: [5] }, output: { mode: "agent" } },
    requirements: ["input_asset"],
  },
];

export function findAutomationTemplate(templateId: string | null | undefined): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((template) => template.templateId === templateId);
}
