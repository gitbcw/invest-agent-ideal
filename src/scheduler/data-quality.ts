/**
 * 数据质量汇总调度器。
 *
 * 行为:
 *   - 每分钟检查一次时间
 *   - 北京时间 15:30(收盘后)生成一份平台级数据质量日报
 *   - 跨进程抢锁:scheduled_task_runs 持久化
 *
 * 产物位于服务层 data/source-quality/,不写入用户 workspace。
 */

import { logger } from "../lib/logger.js";
import { claimScheduledTaskRun, finishScheduledTaskRun } from "../services/scheduled-task-runs.js";
import { beijingDateKey, beijingNow } from "../lib/schedules-loader.js";
import { generateDailyDataQualityReport } from "../handlers/data-quality-report.js";

export interface DataQualityScope {
  userId: string;
  instanceId: string;
  projectId?: string;
}

const TRIGGER_HOUR = 15;
const TRIGGER_MINUTE = 30;

let dataQualityIntervalId: ReturnType<typeof setInterval> | null = null;

export async function startDataQualityScheduler(): Promise<void> {
  stopDataQualityScheduler();

  dataQualityIntervalId = setInterval(async () => {
    const now = new Date();
    try {
      const bj = beijingNow(now);
      if (bj.getHours() !== TRIGGER_HOUR || bj.getMinutes() !== TRIGGER_MINUTE) return;

      const dateKey = beijingDateKey(now);
      const taskKey = `${dateKey}:data-quality:platform`;
      const claimed = await claimScheduledTaskRun({
        taskKey,
        taskType: "data-quality-summary",
        scheduledFor: dateKey,
        userId: "system",
        projectId: "platform",
        instanceId: "platform",
      }).catch((err) => {
        logger.warn(`data-quality.claim failed: ${(err as Error).message}`);
        return false;
      });
      if (!claimed) return;

      try {
        const result = await generateDailyDataQualityReport(dateKey);
        logger.info(
          `平台数据质量日报已生成 date=${dateKey} endpoints=${result.endpointsTouched} failures=${result.totalFailures}`,
        );
        await finishScheduledTaskRun(taskKey, { status: "success" });
      } catch (error) {
        await finishScheduledTaskRun(taskKey, {
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        logger.error(`平台数据质量日报失败 date=${dateKey}: ${error}`);
      }
    } catch (error) {
      logger.error(`数据质量调度循环失败: ${error}`);
    }
  }, 60 * 1000);

  logger.info(`数据质量汇总调度器已启动(每日 ${TRIGGER_HOUR}:${String(TRIGGER_MINUTE).padStart(2, "0")} 北京时间)`);
}

export function stopDataQualityScheduler(): void {
  if (dataQualityIntervalId !== null) {
    clearInterval(dataQualityIntervalId);
    dataQualityIntervalId = null;
  }
}
