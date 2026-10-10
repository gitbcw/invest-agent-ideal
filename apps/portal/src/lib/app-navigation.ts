"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * 应用内软导航（2026-10-09 owner 裁决）：门户页之间的跳转一律走 Next
 * 客户端路由，不整页刷新。此前侧栏菜单用 window.location.assign，跳页会
 * 掐断聊天页在途的 fetch（同步等待轮次回复），用户看到「处理中」闪没、
 * 会话像被清空。软导航只卸载页面组件，轮次在服务端照常完成，回来由
 * turnActive 恢复状态。
 *
 * 仍需 window.location 的场景：登出、会话失效跳 /login（要彻底重置客户端
 * 状态）——这些保留在各调用点，不经过本 hook。
 */
export function useAppNavigate() {
  const router = useRouter();
  return useCallback((href: string) => {
    router.push(href);
  }, [router]);
}
