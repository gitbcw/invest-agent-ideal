"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 用于显示"发送后已等待多少秒",分阶段切换提示文案。
 *
 * 0-2s  : 正在思考...
 * 2-10s : 正在分析你的问题...
 * 10-30s: 任务还在执行,可能涉及工作空间或行情数据查询。
 * 30s+  : 已等待较久,你可以继续等待或稍后回来。
 */
export function useWaitingHint(active: boolean, startedAt: number | null) {
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active || startedAt === null) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setSeconds(0);
      return;
    }
    if (timerRef.current) return;
    const tick = () => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    tick();
    timerRef.current = setInterval(tick, 500);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, startedAt]);

  let label = "正在思考...";
  if (seconds >= 30) {
    label = "已等待较久,你可以继续等待或稍后回来看回复。";
  } else if (seconds >= 10) {
    label = "任务还在执行,可能涉及工作空间或行情数据查询。";
  } else if (seconds >= 2) {
    label = "正在分析你的问题...";
  }

  return { seconds, label };
}
