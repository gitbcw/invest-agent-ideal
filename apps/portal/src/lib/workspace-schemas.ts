import { z } from "zod";

/**
 * 工作空间（方法/Skill）浏览器载荷 schema（T-538）。
 *
 * 全部 `.strict()`：浏览器提交 userId/instanceId/projectId 等 scope 字段
 * 会在 schema 层被拒绝——scope 只能由 runtime connector 从注册 scope 派生。
 */

const idField = z.string().min(1).max(100);

export const methodCreateSchema = z
  .object({
    name: z.string().trim().min(1, "请填写方法名称").max(200),
    description: z.string().trim().max(2000).optional(),
    text: z.string().min(1, "请填写方法正文").max(256 * 1024),
    adoptionNote: z.string().trim().max(2000).optional(),
    adoptionConstraints: z.array(z.string().max(40)).max(6).optional(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const methodAddVersionSchema = z
  .object({
    text: z.string().min(1, "请填写方法正文").max(256 * 1024),
    fileName: z.string().max(200).optional(),
    adoptionNote: z.string().trim().max(2000).optional(),
    adoptionConstraints: z.array(z.string().max(40)).max(6).optional(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const methodAdoptSchema = z
  .object({
    versionId: idField,
    mode: z.enum(["adopt", "readopt"]).default("adopt"),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const methodWorkingCopySaveSchema = z
  .object({
    draftText: z.string().min(1, "工作副本不能为空").max(256 * 1024),
    baseVersionId: z.string().min(1).max(100).optional(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const skillCreateSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-_.]{1,120}$/, "标识只能用小写字母、数字、-、_ 或 .（2-121 位）"),
    name: z.string().trim().min(1, "请填写 Skill 名称").max(200),
    description: z.string().trim().max(2000).optional(),
    text: z.string().min(1, "请填写 Skill 正文").max(256 * 1024),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const skillEditSchema = z
  .object({
    text: z.string().min(1, "请填写 Skill 正文").max(256 * 1024),
    fileName: z.string().max(200).optional(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const skillEnableSchema = z
  .object({
    versionId: idField,
    enabled: z.literal(true),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const skillInstallSchema = z
  .object({
    releaseId: z.string().max(100).optional(),
    versionId: z.string().max(100).optional(),
    agentId: z.string().max(100).optional(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();

export const skillStatusSchema = z
  .object({
    enabled: z.boolean(),
    idempotencyKey: z.string().max(500).optional(),
  })
  .strict();
