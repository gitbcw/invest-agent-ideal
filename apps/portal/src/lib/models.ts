/**
 * 网关可选模型列表与「自动」选项。
 *
 * 静态数据为兜底展示；运行时会经 /api/models 提供实时路由状态与计价，
 * 拉取失败时回退到这里的快照。
 * 展示口径（owner 2026-08-17）：输入/输出双价（元/百万 tokens），
 * 峰谷模型统一按峰值；luna 已禁用不进选择器。
 */
export interface ModelOption {
  /** 网关上的模型 id，传给 conversation.chat payload 的 model 字段 */
  value: string;
  /** UI 显示名 */
  label: string;
  /** 第二行灰字：一句话定位说明 */
  description: string;
  /** 每百万 tokens 输入价（元）；峰谷模型为峰值价 */
  inputPrice: number | null;
  /** 每百万 tokens 输出价（元）；峰谷模型为峰值价 */
  outputPrice: number | null;
}

export const AUTO_MODEL_VALUE = "auto";

/** 兜底快照（与 runtime 注册表同步维护，峰谷按峰值）。 */
export const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "旗舰质量，复杂分析与长推理首选", inputPrice: 2.0, outputPrice: 12.0 },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "高质量均衡档，日常深度分析推荐", inputPrice: 1.0, outputPrice: 6.0 },
  { value: "gpt-5.5", label: "GPT-5.5", description: "上代旗舰，质量稳定，速度通常更快", inputPrice: 2.0, outputPrice: 12.0 },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "深度思考档，中文与工具调用强", inputPrice: 9.0, outputPrice: 27.0 },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "极速性价比档，仅手动可选", inputPrice: 3.0, outputPrice: 9.0 },
  { value: "qwen3.7-flash", label: "Qwen3.7 Flash", description: "极速多模态档，支持图片理解，图片轮兜底", inputPrice: 0.6, outputPrice: 2.4 },
  { value: "doubao-seed-2-1-turbo-260628", label: "豆包 Seed 2.1 Turbo", description: "多模态档，支持图片理解，仅手动可选", inputPrice: 6, outputPrice: 30 },
];

/** 兼容旧引用的形状（仅 value/label）。 */
export const MODEL_OPTIONS = FALLBACK_MODEL_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }));
