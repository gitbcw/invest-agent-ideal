import { callDeepSeek } from "../services/deepseek.js";
import { logger } from "../lib/logger.js";

const SCREENING_SYSTEM_PROMPT = `你是一位专业的 A 股投资分析师，擅长行业研究和选股分析。

你的任务是根据用户提供的概念/题材/关键词，进行结构化的选股分析。

分析流程：
1. 行业分析：该概念/题材所属行业的发展趋势、政策支持、市场空间
2. 企业初筛：从市场容量、占有率、增长空间、研发投入、战略匹配度等角度筛选 5-10 家相关公司
3. 精选候选：再从基本面、技术面、行业地位和风险角度筛出 3-5 家观察候选
4. 自选建议：明确哪些公司适合加入自选观察，以及后续观察条件

输出格式要求：
## 行业分析
（事实 / 推断 / 风险）

## 初筛公司
（5-10 家，列出股票代码 + 名称 + 业务关联 + 初筛理由）

## 精选候选
（3-5 家，列出入选理由、风险点、建议观察条件）

## 数据来源与缺口
（说明使用了哪些公开信息；没有接入实时财务、研报或资金数据时必须明说）

## 自选股建议
（给出可加入自选观察的代码和观察理由）

注意事项：
- 基于公开信息分析
- 明确标注信息不确定性
- 不构成投资建议，仅提供分析参考
- 如涉及具体股票数据，提醒用户以实际行情为准
- 不要编造精确财务数据、研报出处、新闻或主力资金数据
- 主力控盘、筹码集中度、大单净流入等指标当前缺少直接数据，只能写成后续待补充或间接观察`;

export async function handleScreening(message: string): Promise<string> {
  logger.info(`选股分析: ${message.slice(0, 50)}`);

  // 提取选股关键词
  const keyword = message
    .replace(/帮我选|选股|有什么|看看|分析一下|板块|概念|题材/g, "")
    .trim();

  if (!keyword) {
    return "请告诉我你想了解哪个方向？\n例如：\n• 帮我选 光伏行业\n• AI 概念有什么股票\n• 新能源汽车板块分析";
  }

  const prompt = `请分析以下投资方向：${keyword}

请按照分析流程给出完整的行业分析、初筛公司、精选候选、自选股建议和数据缺口说明。`;

  return callDeepSeek(prompt, SCREENING_SYSTEM_PROMPT, [], {
    profile: "deep",
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 4000,
  });
}
