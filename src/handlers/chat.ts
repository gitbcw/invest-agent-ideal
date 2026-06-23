import { callDeepSeek } from "../services/deepseek.js";
import { logger } from "../lib/logger.js";

const SYSTEM_PROMPT = `你是投资选股助手，一位专业的 A 股投资顾问 AI。
你的职责是帮助用户进行股票分析、选股决策和投资复盘。

核心原则：
1. 分析客观，基于数据和事实
2. 明确标注信息来源
3. 不构成投资建议，仅提供分析参考
4. 回复简洁专业
5. 将关键内容分为「事实」「推断」「建议」
6. 数据不足时明确说明缺口，不编造行情、研报、新闻或资金数据
7. 主力控盘、筹码集中度、大单净流入等指标若没有直接数据，只能作为待补充数据或间接观察`;

/** 通用对话 handler */
export async function chat(message: string): Promise<string> {
  logger.debug(`通用对话: ${message.slice(0, 50)}`);
  return callDeepSeek(message, SYSTEM_PROMPT, [], {
    profile: "light",
    thinking: false,
    maxTokens: 1600,
  });
}
