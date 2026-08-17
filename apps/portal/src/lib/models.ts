/**
 * 网关可选模型列表与「自动」选项。
 *
 * 静态数据为兜底展示；运行时会经 /api/models 提供实时路由状态与计价，
 * 拉取失败时回退到这里的快照。
 */
export interface ModelOption {
  /** 网关上的模型 id，传给 conversation.chat payload 的 model 字段 */
  value: string;
  /** UI 显示名 */
  label: string;
  /** 第二行灰字：一句话定位说明 */
  description: string;
  /** 价格展示（元/百万 tokens，输入/输出）；峰谷模型为当前时段生效价 */
  priceText: string;
  /** 峰谷计价标注 */
  tierNote?: string;
}

export const AUTO_MODEL_VALUE = "auto";

function beijingHour(): number {
  const now = new Date();
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(now));
}

function deepseekPrice(peak: { input: number; output: number }, offPeak: { input: number; output: number }): { priceText: string; tierNote: string } {
  const hour = beijingHour();
  const isPeak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  const tier = isPeak ? peak : offPeak;
  return { priceText: `¥${tier.input}/${tier.output}`, tierNote: isPeak ? "峰" : "闲" };
}

export function buildModelOption(value: string, label: string, description: string, price: { input: number; output: number } | null, timeTiered?: { peak: { input: number; output: number }; offPeak: { input: number; output: number } } | null): ModelOption {
  if (timeTiered) {
    const { priceText, tierNote } = deepseekPrice(timeTiered.peak, timeTiered.offPeak);
    return { value, label, description, priceText, tierNote };
  }
  return { value, label, description, priceText: price ? `¥${price.input}/${price.output}` : "" };
}

export const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  buildModelOption("gpt-5.6-terra", "GPT-5.6 Terra", "高质量均衡档，日常深度分析推荐", { input: 1.0, output: 6.0 }, null),
  buildModelOption("gpt-5.6-luna", "GPT-5.6 Luna", "轻量快速档，简单问答与高频调用", { input: 0.08, output: 0.48 }, null),
  buildModelOption("gpt-5.6-sol", "GPT-5.6 Sol", "旗舰质量，复杂分析与长推理首选，价格最高", { input: 2.0, output: 12.0 }, null),
  buildModelOption("gpt-5.5", "GPT-5.5", "上代旗舰，质量稳定，速度通常更快", { input: 2.0, output: 12.0 }, null),
  buildModelOption("deepseek-v4-pro", "DeepSeek V4 Pro", "深度思考档，中文与工具调用强", null, { peak: { input: 9.0, output: 27.0 }, offPeak: { input: 4.5, output: 13.5 } }),
  buildModelOption("deepseek-v4-flash", "DeepSeek V4 Flash", "极速性价比档，适合日常问答", null, { peak: { input: 3.0, output: 9.0 }, offPeak: { input: 1.5, output: 4.5 } }),
  buildModelOption("doubao-seed-2-1-turbo-260628", "豆包 Seed 2.1 Turbo", "多模态档，支持图片理解", { input: 6, output: 30 }, null),
];

/** 兼容旧引用的形状（仅 value/label）。 */
export const MODEL_OPTIONS = FALLBACK_MODEL_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }));
