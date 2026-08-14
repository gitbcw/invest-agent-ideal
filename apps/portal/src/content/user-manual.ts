import manual from "./user-manual.json";

export type ManualContent = typeof manual;

export const userManual: ManualContent = manual;

export function buildManualMarkdown(content: ManualContent = userManual): string {
  const lines = [
    `# ${content.title}`,
    "",
    content.subtitle,
    "",
    `**最终目标：**${content.finalGoal}`,
    "",
    `更新日期：${content.updatedAt}`,
    "",
    "## 核心优势",
    ""
  ];

  content.strengths.forEach((strength) => {
    lines.push(`### ${strength.title}`, "", strength.description, "");
  });

  lines.push(
    `## ${content.onboarding.title}`,
    ""
  );

  content.onboarding.steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title}`, "", step.description, "");
  });

  lines.push("## 最终为您实现", "");
  content.outcomes.forEach((outcome) => {
    lines.push(`- **${outcome.title}：**${outcome.description}`);
  });
  lines.push("");

  content.notes.forEach((note) => lines.push(`- ${note}`));
  lines.push("");

  return lines.join("\n");
}
