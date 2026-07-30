// Platform UI 内联图标。纯 SVG 字符串，无外部依赖。
// 仅用于标题栏点缀、状态点、导航箭头等；不承载信息（信息由文字保证）。

// 24x24 stroke 图标，currentColor 继承。
export function icon(name: string, size = 16): string {
  const path = ICON_PATHS[name];
  if (!path) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// 状态点：彩色小圆点，用于统计卡趋势位 / 异常条。
export function dot(name: "ok" | "warn" | "danger" | "info" | "muted"): string {
  const color: Record<string, string> = {
    ok: "var(--ok)",
    warn: "var(--warn)",
    danger: "var(--danger)",
    info: "var(--info)",
    muted: "var(--muted)",
  };
  return `<span class="ui-dot ui-dot-${name}" style="--dot:${color[name]}"></span>`;
}

const ICON_PATHS: Record<string, string> = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  gauge:
    '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
