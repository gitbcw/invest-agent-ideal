"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 打字机效果 hook。
 * 把一段完整文本按字符逐步显示出来,模拟流式回复。
 */
export function useTypewriter(text: string, opts: { speedMs?: number; chunkSize?: number; enabled?: boolean }) {
  const speedMs = opts.speedMs ?? 16;
  const chunkSize = opts.chunkSize ?? 2;
  const enabled = opts.enabled ?? true;
  const [displayed, setDisplayed] = useState(() => (enabled ? "" : text));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!enabled) {
      setDisplayed(text);
      return;
    }
    let index = 0;
    setDisplayed("");
    timerRef.current = setInterval(() => {
      index += chunkSize;
      if (index >= text.length) {
        setDisplayed(text);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } else {
        setDisplayed(text.slice(0, index));
      }
    }, speedMs);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [text, enabled, speedMs, chunkSize]);

  return { displayed, isAnimating: displayed.length < text.length };
}
