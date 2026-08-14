import { z } from "zod";

export const AUTOMATION_TIMEZONE = "Asia/Shanghai" as const;
export const AUTOMATION_FILE_EXTENSIONS = [".csv", ".xlsx"] as const;
export const AUTOMATION_FILE_ACCEPT = AUTOMATION_FILE_EXTENSIONS.join(",");
export const AUTOMATION_SUPPORTED_FILE_LABEL = "CSV、XLSX（Excel）";

export const AUTOMATION_INPUT_FILE_EXTENSIONS = [
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".csv",
  ".xlsx",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
] as const;
export const AUTOMATION_INPUT_FILE_ACCEPT = AUTOMATION_INPUT_FILE_EXTENSIONS.join(",");
export const AUTOMATION_INPUT_SUPPORTED_FILE_LABEL = "文档、表格、PDF 和图片";

export function isSupportedAutomationFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return AUTOMATION_FILE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function isSupportedAutomationInputFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return AUTOMATION_INPUT_FILE_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

export const automationScheduleSchema = z.object({
  frequency: z.enum(["daily", "trading_days", "weekdays", "weekly"]),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "执行时间必须是 HH:mm"),
  timezone: z.literal(AUTOMATION_TIMEZONE),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
}).strict().superRefine((schedule, ctx) => {
  if (schedule.frequency === "weekly" && (!schedule.weekdays || schedule.weekdays.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "每周任务至少选择一天" });
  }
  if (schedule.frequency !== "weekly" && schedule.weekdays && schedule.weekdays.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "仅每周任务可设置星期" });
  }
});

export const automationAssetUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(180).refine(isSupportedAutomationFileName, "仅支持 CSV 或 XLSX 文件"),
  mimeType: z.string().trim().max(160).optional(),
  base64: z.string().min(1).max(40_000_000),
}).strict();

export const automationAssetBindingSchema = z.object({
  assetId: z.string().trim().min(1).max(300),
  role: z.enum(["input", "update_target"]),
  versionPolicy: z.enum(["latest", "fixed"]),
  versionId: z.string().trim().min(1).max(300).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.versionPolicy === "fixed" && !value.versionId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["versionId"], message: "fixed 版本必须指定 versionId" });
  if (value.versionPolicy === "latest" && value.versionId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["versionId"], message: "latest 不应携带 versionId" });
});

const automationOutputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("agent") }).strict(),
  z.object({
    mode: z.literal("create"),
    format: z.enum(["markdown", "html", "csv", "xlsx", "pdf", "png", "jpeg", "webp", "svg"]),
    fileName: z.string().trim().min(1).max(255),
    titleTemplate: z.string().max(500).optional(),
  }).strict(),
  z.object({
    mode: z.literal("update"),
    assetId: z.string().trim().min(1).max(300),
    versionPolicy: z.literal("latest"),
    expectedVersionId: z.string().trim().min(1).max(300).optional(),
  }).strict(),
]);

const automationDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("wechat_summary") }).strict(),
  z.object({ mode: z.literal("wechat_on_condition"), conditionVersion: z.literal(1) }).strict(),
]);

const automationDefinitionFields = {
  instruction: z.string().trim().min(1).max(12_000).optional(),
  inputs: z.array(automationAssetBindingSchema).max(8).optional(),
  output: automationOutputSchema.optional(),
  delivery: automationDeliverySchema.optional(),
};

export const automationCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(12_000).nullable().optional(),
  schedule: automationScheduleSchema,
  ...automationDefinitionFields,
  sourceAsset: automationAssetUploadSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.sourceAsset && !value.instruction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instruction"], message: "无输入文件的任务必须填写任务指令" });
});

export const automationUpdateSchema = z.object({
  taskId: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(12_000).nullable().optional(),
  schedule: automationScheduleSchema.optional(),
  ...automationDefinitionFields,
  sourceAsset: automationAssetUploadSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined || value.schedule !== undefined || value.instruction !== undefined || value.inputs !== undefined || value.output !== undefined || value.delivery !== undefined || value.sourceAsset !== undefined, "至少修改一项任务设置");

export const automationActionSchema = z.object({
  taskId: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().positive().optional(),
}).strict();

export const automationRunNowSchema = z.object({
  taskId: z.string().trim().min(1).max(160),
  idempotencyKey: z.string().trim().min(1).max(500).optional(),
}).strict();

const listValue = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
  z.array(schema).max(20).optional(),
);

export const automationListQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  statuses: listValue(z.enum(["paused", "active", "needs_attention", "archived"])),
  frequencies: listValue(z.enum(["daily", "trading_days", "weekdays", "weekly"])),
  deliveryModes: listValue(z.enum(["none", "wechat_summary", "wechat_on_condition"])),
  outputModes: listValue(z.enum(["none", "agent", "create", "update"])),
  cursor: z.string().trim().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const automationRunsListQuerySchema = z.object({
  taskId: z.string().trim().min(1).max(160).optional(),
  query: z.string().trim().max(200).optional(),
  statuses: listValue(z.enum(["running", "succeeded", "failed", "skipped", "cancelled"])),
  origins: listValue(z.enum(["manual", "scheduled"])),
  deliveryStatuses: listValue(z.enum(["not_requested", "pending", "sent", "suppressed", "failed"])),
  hasOutput: z.preprocess((value) => {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  }, z.boolean().optional()),
  from: z.string().trim().max(80).optional(),
  to: z.string().trim().max(80).optional(),
  cursor: z.string().trim().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const automationBatchActionSchema = z.object({
  action: z.enum(["pause", "activate", "archive"]),
  items: z.array(z.object({
    taskId: z.string().trim().min(1).max(160),
    expectedRevision: z.number().int().positive(),
  }).strict()).min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(500),
}).strict();
