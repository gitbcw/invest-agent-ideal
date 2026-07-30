/**
 * 周/月复盘受控保存后端 (F2)
 *
 * 仿 dailyPlanBackend 的双轨模式，但以 (kind, reportKey) 寻址而非 planDate。
 * 当前实现为 workspace-only（reports/<kind>/<reportKey>.yaml），不建 DB 表（避免 migration）。
 * 存储带 publication metadata + summary，支持 runScheduledPeriodicReview 回读校验四元组。
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

function yamlFilePath(userId: string, kind: PeriodicReviewKind, reportKey: string): string {
  const wsRoot = resolveWorkspacePath(userId);
  return join(wsRoot, "reports", kind, `${reportKey}.yaml`);
}

/** 简易 yaml 序列化（结构扁平，字段固定）。 */
function serializeYaml(record: PeriodicReviewRecord): string {
  const dataJson = JSON.stringify(record.data ?? null);
  return [
    `kind: ${record.kind}`,
    `report_key: ${record.reportKey}`,
    `generated_at: ${record.generatedAt}`,
    `summary: ${record.summary ?? ""}`,
    `content: |`,
    ...String(record.content).split("\n").map((line) => `  ${line}`),
    `data: ${dataJson}`,
    "",
  ].join("\n");
}

/** 简易 yaml 反序列化（容忍格式偏差）。 */
function deserializeYaml(raw: string, kind: PeriodicReviewKind, reportKey: string): PeriodicReviewRecord | null {
  try {
    const lines = raw.split("\n");
    const getField = (key: string): string | null => {
      const line = lines.find((l) => l.startsWith(`${key}:`));
      return line ? line.slice(key.length + 1).trim() : null;
    };
    const contentMatch = raw.match(/^content: \|\n((?:  .*\n)*)/m);
    const content = contentMatch ? contentMatch[1].replace(/^  /gm, "").replace(/\n$/, "") : "";
    const dataRaw = getField("data");
    return {
      kind,
      reportKey,
      generatedAt: getField("generated_at") || "",
      summary: getField("summary") || null,
      content,
      data: dataRaw ? JSON.parse(dataRaw) : null,
    };
  } catch (error) {
    logger.warn(`periodicReviewBackend.deserializeYaml failed kind=${kind} key=${reportKey}: ${(error as Error).message}`);
    return null;
  }
}

export const periodicReviewBackend: PeriodicReviewBackend = {
  async upsert(userId, _instanceId, record) {
    if (!existsSync(resolveWorkspacePath(userId))) {
      await ensureWorkspace({ userId });
    }
    const filePath = yamlFilePath(userId, record.kind, record.reportKey);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, serializeYaml(record), "utf-8");
  },

  async get(userId, _instanceId, kind, reportKey) {
    const filePath = yamlFilePath(userId, kind, reportKey);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, "utf-8");
      return deserializeYaml(raw, kind, reportKey);
    } catch (error) {
      logger.warn(`periodicReviewBackend.get failed kind=${kind} key=${reportKey}: ${(error as Error).message}`);
      return null;
    }
  },
};

export { DEFAULT_USER_ID as _defaultUser, DEFAULT_INSTANCE_ID as _defaultInstance };
