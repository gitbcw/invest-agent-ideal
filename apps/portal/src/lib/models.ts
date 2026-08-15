/**
 * 网关可选模型列表。
 *
 * 来源：gateway 中转站 /v1/models 接口。
 * 空字符串 model = "" 表示用服务端默认模型（config.llm.defaultModel）。
 * UI 下拉的"默认"选项对应空字符串，让服务端决定。
 */
export interface ModelOption {
  /** 网关上的模型 id，传给 conversation.chat payload 的 model 字段 */
  value: string;
  /** UI 显示名 */
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "", label: "默认" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { value: "doubao-seed-2-1-turbo-260628", label: "豆包 Seed 2.1 Turbo" },
];
