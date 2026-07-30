// Platform UI 设计令牌层 · 澜策品牌配色。
// 意象映射：天空蓝（主色/天空弧线）/ 金色（灯塔信号/AI 判断）/ 水波青（市场周期/趋势）/ 墨蓝（灯塔稳重/文字）。
// 所有色彩/间距/圆角/阴影只在此定义，视图层只用 var(--xxx)。

// :root CSS 变量，嵌入 <style> 顶部。Owner 与 Partner 共享同一套。
export const TOKENS_CSS = `:root{
  color-scheme:light;
  /* 墨蓝文字（灯塔稳重）*/
  --ink:#0e2236;
  --ink-soft:#334e68;
  --muted:#627d98;
  /* 天空表面（天空弧线底色）*/
  --surface:#f0f5fb;
  --surface-raised:#ffffff;
  --surface-sunken:#f7faff;
  --surface-inset:#f1f6fc;
  /* 线 */
  --line:#d6e1ef;
  --line-soft:#e8eff8;
  --line-strong:#b9cbe0;
  /* 天空蓝（主色）*/
  --brand:#2c7be5;
  --brand-strong:#1665c1;
  --brand-soft:#e6f0fc;
  --brand-hover:#eef5fd;
  --brand-ring:rgba(44,123,229,.16);
  /* 金色（灯塔信号/AI 判断）—克制使用，仅关键指标与重点信号 */
  --signal:#e0a82e;
  --signal-strong:#b8860b;
  --signal-soft:#fbf0d6;
  /* 水波青（市场周期/趋势）*/
  --wave:#2c8f9b;
  --wave-soft:#dff1f3;
  /* 状态 */
  --ok:#1a7d4c;--ok-soft:#dcf2e3;
  --warn:#9a6a00;--warn-soft:#fbf0d6;
  --danger:#c0392b;--danger-soft:#fbe1de;
  --info:#2c7be5;--info-soft:#e6f0fc;
  /* 形状与节奏 */
  --radius:9px;--radius-sm:7px;--radius-lg:10px;
  --shadow-sm:0 1px 2px rgba(14,34,54,.06);
  --shadow-md:0 14px 40px rgba(14,34,54,.10);
  --gap:14px;--gap-sm:9px;--gap-lg:24px;
}`;

// 全局重置与 body 基线。
export const RESET_CSS = `*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
a{color:inherit;text-decoration:none}
button,input,select{font:inherit}
:focus-visible{outline:none}`;
