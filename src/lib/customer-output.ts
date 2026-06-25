const INTERNAL_TERMS: Array<[RegExp, string]> = [
  [/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "授权信息"],
  [/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "授权信息"],
  [/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "授权信息"],
  [/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "授权信息"],
  [/\b[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{32,}\b/g, "授权信息"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "授权信息"],
  [/^我会按[^\n]*(?:技能|上下文|接口|工具)[^\n]*\n*/g, ""],
  [/```(?:bash|sh|shell|zsh|console|terminal)\s*[\s\S]*?```/gi, "后台流程已处理"],
  [/curl\s+[^\n]+/gi, "后台流程已处理"],
  [/\b(?:POST|GET|PUT|PATCH|DELETE)\s+\/(?:api|admin|acp|\.well-known)\/[^\s，。；、)）]*/gi, "后台操作"],
  [/\/(?:api|admin|acp|\.well-known)\/[A-Za-z0-9/_?.=&%-]*/g, "后台操作"],
  [/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?/gi, "后台系统"],
  [/\blocalhost:\d+\b/gi, "后台系统"],
  [/\b127\.0\.0\.1:\d+\b/gi, "后台系统"],
  [/\bport\s*\d+\b/gi, "后台系统"],
  [/端口\s*\d+/g, "后台系统"],
  [/[A-Za-z]:\\[^\s，。；、）)]+/g, "内部文件"],
  [/\/Users\/[^\s，。；、）)]+/g, "内部文件"],
  [/\/tmp\/[^\s，。；、）)]+/g, "内部文件"],
  [/file:\/\/[^\s，。；、）)]+/gi, "内部文件"],
  [/src\/[^\s，。；、）)]+/g, "内部模块"],
  [/docs\/[^\s，。；、）)]+/g, "内部文档"],
  [/dist\/[^\s，。；、）)]+/g, "内部模块"],
  [/scripts\/[^\s，。；、）)]+/g, "内部脚本"],
  [/logs\/[^\s，。；、）)]+/g, "内部日志"],
  [/data\/[^\s，。；、）)]+/g, "内部数据"],
  [/node_modules\/[^\s，。；、）)]+/g, "内部依赖"],
  [/\.env(?:\.[A-Za-z0-9_-]+)?/g, "内部配置"],
  [/\.codex\/[^\s，。；、）)]+/g, "内部流程"],
  [/(?:^|[\s，。；、（(])\.?\/?\.state\/[^\s，。；、）)]+/g, " 内部状态"],
  [/~\/\.openclaw[^\s，。；、）)]*/g, "内部状态"],
  [/openclaw-weixin/gi, "微信连接状态"],
  [/OpenClaw/gi, "微信连接服务"],
  [/weixin-agent-sdk/gi, "微信连接服务"],
  [/Hermes/gi, "智能分析服务"],
  [/codex-acp|Codex ACP|ACP/gi, "智能分析服务"],
  [/Codex/g, "智能分析服务"],
  [/Claude Code/gi, "智能分析服务"],
  [/\bMCP\b/g, "工具服务"],
  [/invest-agent-daily-review\s*skill/gi, "日复盘流程"],
  [/invest-agent-[A-Za-z0-9_-]+/g, "内部流程"],
  [/plan\s*:\s*null/gi, "暂无交易预案"],
  [/\bquoteAvailable\b/g, "行情可用状态"],
  [/\bchangePercent\b/g, "涨跌幅"],
  [/可能暂时无法正常触发/g, "需要巡检计算确认"],
  [/触发可能延迟或条件未满足/g, "需要后续巡检确认条件是否满足"],
  [/\bskill\b/gi, "流程"],
  [/\bskills\b/gi, "流程"],
  [/Skill/g, "流程"],
  [/日复盘技能/g, "日复盘流程"],
  [/确定性上下文/g, "已整理的数据"],
  [/观察池/g, "自选池"],
  [/Dashboard\s*或\s*reviews\s*目录查看/g, "后续可以继续让我展开"],
  [/Dashboard/g, "管理页面"],
  [/reviews\s*目录/g, "复盘记录"],
  [/invest-agent service:\s*后台系统/gi, ""],
  [/channel:\s*\S+/gi, ""],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?[A-Za-z0-9:_-]+[^\n]*/gi, "后台流程已处理"],
  [/\b(?:launchctl|pm2|node|tsx|tsc|sqlite3)\s+[^\n]*/gi, "后台流程已处理"],
  [/\bat\s+[A-Za-z0-9_.$/<>-]+\s*\([^)]+\)/g, "内部执行栈"],
  [/Error:\s*[^\n]+/g, "处理异常"],
  [/(?:服务|系统)(?:已经|已)?重启(?:完成)?/g, "后台流程已处理"],
  [/(?:服务|系统)没有响应/g, "这次处理没有完成"],
  [/(?:确认|检查)(?:一下)?(?:服务|系统)状态/g, "如需我继续处理，可以再试一次"],
];

const INTERNAL_CODE_FENCE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "terminal",
]);

export function redactSensitiveText(text: string) {
  return String(text || "")
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{32,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]");
}

export function sanitizeCustomerText(text: string) {
  let cleaned = preserveCustomerCodeFences(extractCustomerVisibleText(redactSensitiveText(String(text || ""))));
  for (const [pattern, replacement] of INTERNAL_TERMS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  return cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function preserveCustomerCodeFences(text: string) {
  return text.replace(/```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g, (full, rawLang: string, body: string) => {
    const lang = rawLang.toLowerCase();
    if (INTERNAL_CODE_FENCE_LANGS.has(lang) || looksLikeInternalCommandBlock(body)) {
      return full;
    }
    return body.trim();
  });
}

function looksLikeInternalCommandBlock(body: string) {
  return body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) =>
      /^(?:curl|npm|pnpm|yarn|node|tsx|tsc|sqlite3|launchctl|pm2)\b/.test(line) ||
      /\b(?:localhost|127\.0\.0\.1):\d+\b/.test(line)
    );
}

function extractCustomerVisibleText(text: string) {
  const trimmed = text.trim();
  const finalStart = findFinalAnswerStart(trimmed);
  if (finalStart >= 0) {
    return trimmed.slice(finalStart);
  }

  return trimmed
    .split(/\n{2,}/)
    .filter((block) => !isInternalProgressBlock(block))
    .join("\n\n")
    || trimmed
      .split(/\n+/)
      .filter((line) => !isInternalProgressBlock(line))
      .join("\n");
}

function findFinalAnswerStart(text: string) {
  const markers = [
    /【\d{4}-\d{2}-\d{2}[^】]*复盘摘要】/,
    /【\d{4}-\d{2}-\d{2}[^】]*完整复盘】/,
    /【\d{4}-\d{2}-\d{2}[^】]*复盘】/,
    /当前持有\s*\d+\s*只[，,][^\n]*(?:涨跌|变化|如下)/,
    /已(?:经)?(?:加到|加入|添加到|添加进)自选(?:股|池)?[:：]?/,
    /已(?:经)?添加[\s\S]{0,80}?到自选(?:股|池)?[:：]?/,
    /已(?:经)?(?:完成|处理完成|更新|保存|设置|删除|移除)[:：]?/,
    /处理结果[:：]/,
    /结论[:：]/,
  ];

  const starts = markers
    .map((marker) => {
      const match = text.match(marker);
      return match?.index;
    })
    .filter((index): index is number => typeof index === "number");

  return starts.length > 0 ? Math.min(...starts) : -1;
}

function isInternalProgressBlock(block: string) {
  const compact = block.replace(/\s+/g, "");
  if (!compact) return false;

  return [
    /^我(?:会|先|正在|再|还在|已经确认|继续|重新|直接处理|核对|排查)/,
    /(?:服务|系统).*(?:没有响应|未响应|不可用|连不上|启动|重启|恢复|健康检查|端口|占用)/,
    /(?:请求|写入|提交).*(?:失败|等待返回|没有完成|未完成|重试|重新提交)/,
    /(?:curl|localhost|127\.0\.0\.1|端口|健康检查|服务入口|可用进程)/i,
  ].some((pattern) => pattern.test(compact));
}
