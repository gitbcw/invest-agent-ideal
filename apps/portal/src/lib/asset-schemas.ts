import { z } from "zod";

export const assetFormatSchema = z.enum(["markdown", "html", "csv", "xlsx", "pdf", "png", "jpeg", "webp", "svg"]);
const singleAssetUploadSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(160).optional(),
  folderId: z.string().trim().max(300).nullable().optional(),
  base64: z.string().min(1).max(70_000_000),
  idempotencyKey: z.string().trim().min(1).max(500).optional(),
}).strict();
export const assetUploadSchema = z.union([
  singleAssetUploadSchema,
  z.object({ files: z.array(singleAssetUploadSchema).min(1).max(50) }).strict(),
]);
export const assetListQuerySchema = z.object({
  status: z.enum(["active", "archived", "all"]).optional(),
  search: z.string().trim().max(200).optional(),
  format: assetFormatSchema.optional(),
  source: z.enum(["upload", "conversation", "automation", "restore", "system"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  folderId: z.string().trim().max(300).optional(),
}).strict();
export const assetFolderCreateSchema = z.object({ name: z.string().trim().min(1).max(100), parentFolderId: z.string().trim().max(300).nullable().optional() }).strict();
export const assetFolderRenameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const assetMoveSchema = z.object({ folderId: z.string().trim().max(300).nullable() }).strict();
export const assetIdSchema = z.string().trim().min(1).max(300);
export const assetRenameSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const assetRestoreSchema = z.object({
  versionId: z.string().trim().min(1).max(300),
  expectedVersionId: z.string().trim().min(1).max(300).optional(),
  idempotencyKey: z.string().trim().min(1).max(500).optional(),
}).strict();
export const assetConvertToXlsxSchema = z.object({
  expectedVersionId: z.string().trim().min(1).max(300),
  confirmed: z.literal(true),
  idempotencyKey: z.string().trim().min(1).max(500),
}).strict();
