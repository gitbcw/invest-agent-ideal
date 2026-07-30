/**
 * 周/月复盘受控保存后端 (F2/R1)
 *
 * 仿 dailyPlanBackend 的双轨模式，但以 (kind, reportKey) 寻址而非 planDate。
 * 当前实现为 workspace-only（reports/<kind>/<reportKey>.yaml），不建 DB 表。
 *
 * R1 安全加固:
 *   - report-key 严格校验：weekly 只接受 YYYY-MM-DD_weekly，monthly 只接受 YYYY-MM；
 *     拒绝 / \ .. 绝对路径和编码变体。
 *   - 路径 containment：写入前用 resolve + relative 验证文件在 reports/<kind>/ 下。
 *   - 使用 yaml 库（非手写 parser），保证多行 Markdown/冒号/井号/Unicode 原样往返。
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { parse, stringify } from "yaml";
import { ensureWorkspace, resolveWorkspacePath } from "./workspace.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "./user-context.js";
import { logger } from "./logger.js";

export type PeriodicReviewKind = "weekly" | "monthly";

export interface PeriodicReviewRecord {
  kind: PeriodicReviewKind;
  reportKey: string;
  generatedAt: string;
  summary: string | null;
  content: string;
  /** 结构化元数据，含 publication（conversationId/scheduled）。 */
  data: unknown;
}

export interface PeriodicReviewBackend {
  upsert(userId: string, instanceId: string, record: PeriodicReviewRecord): Promise<void>;
  get(userId: string, instanceId: string, kind: PeriodicReviewKind, reportKey: string): Promise<PeriodicReviewRecord | null>;
}

/** R1: weekly 键格式 YYYY-MM-DD_weekly；monthly 键格式 YYYY-MM */
const WEEKLY_KEY_RE = /^\d{4}-\d{2}-\d{2}_weekly$/;
const MONTHLY_KEY_RE = /^\d{4}-\d{2}$/;

/**
 * R1: 校验 reportKey 是否符合 kind 的规范格式，且不含路径逃逸字符。
 * 返回 null 表示合法，否则返回错误描述。
 */
export function validateReportKey(kind: PeriodicReviewKind, reportKey: string): string | null {
  if (!reportKey || typeof reportKey !== "string") return "reportKey is required";
  // 通用路径逃逸防护
  if (/[/\\]|\.\.|^\.|[\x00-\x1f]/.test(reportKey)) {
    return `reportKey contains forbidden path characters: ${reportKey}`;
  }
  if (kind === "weekly" && !WEEKLY_KEY_RE.test(reportKey)) {
    return `weekly reportKey must match YYYY-MM-DD_weekly, got: ${reportKey}`;
  }
  if (kind === "monthly" && !MONTHLY_KEY_RE.test(reportKey)) {
    return `monthly reportKey must match YYYY-MM, got: ${reportKey}`;
  }
  return null;
}

/**
 * R1: 路径 containment 验证——确保目标文件在 reports/<kind>/ 目录下。
 * 返回 true 表示安全（contained），false 表示逃逸。
 */
function isPathContained(wsRoot: string, kind: PeriodicReviewKind, reportKey: string, ext: string): boolean {
  const expectedDir = resolve(wsRoot, "reports", kind);
  const targetFile = resolve(expectedDir, `${reportKey}${ext}`);
  const rel = relative(expectedDir, targetFile);
  // rel 不以 .. 开头且不含 .. 段 = contained
  return !rel.startsWith("..") && !rel.includes(`${resolve("")}..`);
}

function yamlFilePath(userId: string, kind: PeriodicReviewKind, reportKey: string): string {
  const wsRoot = resolveWorkspacePath(userId);
  return join(wsRoot, "reports", kind, `${reportKey}.yaml`);
}

export const periodicReviewBackend: PeriodicReviewBackend = {
  async upsert(userId, _instanceId, record) {
    // R1: 校验 reportKey
    const keyError = validateReportKey(record.kind, record.reportKey);
    if (keyError) throw new Error(`periodicReviewBackend.upsert rejected: ${keyError}`);

    if (!existsSync(resolveWorkspacePath(userId))) {
      await ensureWorkspace({ userId });
    }
    const wsRoot = resolveWorkspacePath(userId);
    // R1: 路径 containment 验证
    if (!isPathContained(wsRoot, record.kind, record.reportKey, ".yaml")) {
      throw new Error(`periodicReviewBackend.upsert rejected: path escapes reports/${record.kind}/`);
    }
    if (!isPathContained(wsRoot, record.kind, record.reportKey, ".md")) {
      throw new Error(`periodicReviewBackend.upsert rejected: md path escapes reports/${record.kind}/`);
    }

    const filePath = yamlFilePath(userId, record.kind, record.reportKey);
    await mkdir(join(filePath, ".."), { recursive: true });
    // R1: 使用 yaml 库序列化（非手写 parser）
    const yamlContent = stringify({
      kind: record.kind,
      report_key: record.reportKey,
      generated_at: record.generatedAt,
      summary: record.summary ?? "",
      content: record.content,
      data: record.data ?? null,
    });
    await writeFile(filePath, yamlContent, "utf-8");
  },

  async get(userId, _instanceId, kind, reportKey) {
    // R1: 校验 reportKey（读取也要防逃逸）
    const keyError = validateReportKey(kind, reportKey);
    if (keyError) return null;

    const filePath = yamlFilePath(userId, kind, reportKey);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        kind,
        reportKey,
        generatedAt: String(parsed.generated_at ?? ""),
        summary: parsed.summary ? String(parsed.summary) : null,
        content: String(parsed.content ?? ""),
        data: parsed.data ?? null,
      };
    } catch (error) {
      logger.warn(`periodicReviewBackend.get failed kind=${kind} key=${reportKey}: ${(error as Error).message}`);
      return null;
    }
  },
};

export { DEFAULT_USER_ID as _defaultUser, DEFAULT_INSTANCE_ID as _defaultInstance };
