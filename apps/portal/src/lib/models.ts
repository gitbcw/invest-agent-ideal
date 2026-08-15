/**
 * 网关可选模型列表。
 *
 * 来源：gateway 中转站 /v1/models 接口。
 * 下拉不设"默认"项：初始直接选中服务端当前默认档 gpt-5.6-terra。
 */
export interface ModelOption {
  /** 网关上的模型 id，传给 conversation.chat payload 的 model 字段 */
  value: string;
  /** UI 显示名 */
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { value: "doubao-seed-2-1-turbo-260628", label: "豆包 Seed 2.1 Turbo" },
];
