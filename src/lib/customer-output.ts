const UNSAFE_OUTPUT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Authorization: Bearer [REDACTED]"],
  [/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Authorization: Bearer [REDACTED]"],
  [/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]"],
  [/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]"],
  [/\b[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{32,}\b/g, "[REDACTED_TOKEN]"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]"],
  [/```(?:bash|sh|shell|zsh|console|terminal)\s*[\s\S]*?```/gi, "后台命令已隐藏"],
  [/curl\s+[^\n]+/gi, "后台命令已隐藏"],
  [/\b(?:POST|GET|PUT|PATCH|DELETE)\s+\/(?:api|admin|acp|\.well-known)\/[^\s，。；、)）]*/gi, "后台接口"],
  [/\/(?:api|admin|acp|\.well-known)\/[A-Za-z0-9/_?.=&%-]*/g, "后台接口"],
  [/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?/gi, "后台地址"],
  [/\blocalhost:\d+\b/gi, "后台地址"],
  [/\b127\.0\.0\.1:\d+\b/gi, "后台地址"],
  [/[A-Za-z]:\\[^\s，。；、）)]+/g, "内部文件"],
  [/\/Users\/[^\s，。；、）)]+/g, "内部文件"],
  [/\/tmp\/[^\s，。；、）)]+/g, "内部文件"],
  [/file:\/\/[^\s，。；、）)]+/gi, "内部文件"],
  [/(?:^|[\s，。；、（(])\.?\/?\.state\/[^\s，。；、）)]+/g, " 内部状态"],
  [/~\/\.openclaw[^\s，。；、）)]*/g, "内部状态"],
];

const ACP_DIAGNOSTIC_LINE_PATTERNS = [
  /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/i,
  /^Unknown model .+ is used\. This will use fallback model metadata\.$/i,
  /^Model personality requested but model_messages is missing, falling back to base instructions\..*$/i,
  /^Goal updated \((?:active|paused|complete)\): .+$/i,
  /^Goal (?:cleared|paused|resumed)\.?$/i,
];

const ACP_DIAGNOSTIC_INLINE_PATTERNS = [
  /Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.?/gi,
  /Goal updated \((?:active|paused|complete)\): [^\n]+/gi,
  /Goal (?:cleared|paused|resumed)\.?/gi,
];

export function isAcpDiagnosticText(text: string) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => ACP_DIAGNOSTIC_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

function removeAcpDiagnosticLines(text: string) {
  let cleaned = String(text || "")
    .split(/\r?\n/)
    .filter((line) => !ACP_DIAGNOSTIC_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n");
  for (const pattern of ACP_DIAGNOSTIC_INLINE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned;
}

export function redactSensitiveText(text: string) {
  let redacted = String(text || "");
  for (const [pattern, replacement] of UNSAFE_OUTPUT_REPLACEMENTS.slice(0, 6)) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function sanitizeCustomerText(text: string) {
  let cleaned = removeAcpDiagnosticLines(text);
  for (const [pattern, replacement] of UNSAFE_OUTPUT_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  return cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function sanitizeWeixinCustomerText(text: string) {
  return replaceKnownSourceUrlsForWeixin(sanitizeCustomerText(text));
}

export function extractFinalCustomerReply(text: string) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return normalized;

  return extractAfterLastMarker(normalized, [
    "最终回复：",
    "最终回复:",
    "微信正文：",
    "微信正文:",
    "给用户的回复：",
    "给用户的回复:",
    "客户可见正文：",
    "客户可见正文:",
  ]) || normalized;
}

export function dedupeRepeatedCustomerText(text: string) {
  const normalized = String(text || "").trim();
  if (!normalized) return normalized;
  return dedupeAdjacentBlocks(dedupeRepeatedSuffix(normalized)).trim();
}

function extractAfterLastMarker(text: string, markers: string[]) {
  let bestIndex = -1;
  let bestMarker = "";
  for (const marker of markers) {
    const idx = text.lastIndexOf(marker);
    if (idx > bestIndex) {
      bestIndex = idx;
      bestMarker = marker;
    }
  }
  if (bestIndex < 0) return "";
  const candidate = text.slice(bestIndex + bestMarker.length).trim();
  return candidate.length >= 10 ? candidate : "";
}

function dedupeAdjacentBlocks(text: string) {
  const blocks = text.split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    const normalized = normalizeForDedupe(block);
    if (normalized && normalized === normalizeForDedupe(kept[kept.length - 1] ?? "")) {
      continue;
    }
    kept.push(block);
  }
  return kept.join("\n\n");
}

function dedupeRepeatedSuffix(text: string) {
  const compact = text.replace(/\r\n/g, "\n");
  for (let len = Math.floor(compact.length / 2); len >= 40; len -= 1) {
    const tail = compact.slice(-len);
    const beforeTail = compact.slice(0, -len);
    if (beforeTail.endsWith(tail)) {
      const prefix = beforeTail.slice(0, -len).trimEnd();
      return prefix ? `${prefix}\n\n${tail.trimStart()}` : tail.trimStart();
    }
    if (beforeTail.lastIndexOf(tail) >= 0) {
      return beforeTail.trimEnd();
    }
  }
  return text;
}

function normalizeForDedupe(value: string) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：,.!！?？]/g, "")
    .trim();
}

function replaceKnownSourceUrlsForWeixin(text: string) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (match, label, url) => {
      const source = sourceLabelForUrl(url);
      return source ? `${label}（${source}）` : match;
    })
    .replace(/`?(https?:\/\/[^\s`，。；、）)\]]+)`?/gi, (match, url) => {
      return sourceLabelForUrl(url) ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function sourceLabelForUrl(url: string): string | null {
  const value = String(url || "").toLowerCase();
  if (!value.startsWith("http://") && !value.startsWith("https://")) return null;
  if (value.includes("qt.gtimg.cn/q=")) return "腾讯行情";
  if (value.includes("web.ifzq.gtimg.cn/appstock/app/fqkline/get")) return "腾讯日K";
  if (value.includes("ifzq.gtimg.cn/appstock/app/kline/mkline")) return "腾讯分钟K";
  if (value.includes("smartbox.gtimg.cn")) return "腾讯证券搜索";
  if (value.includes("hq.sinajs.cn/list")) return "新浪行情";
  if (value.includes("money.finance.sina.com.cn") || value.includes("cn_marketdata.getklinedata")) return "新浪日K";
  if (value.includes("emdatah5.eastmoney.com")) return "东方财富资金流";
  if (value.includes("emweb.securities.eastmoney.com")) return "东方财富主题概念";
  if (value.includes("np-listapi.eastmoney.com")) return "东方财富新闻";
  if (value.includes("reportapi.eastmoney.com")) return "东方财富研报";
  if (value.includes("cninfo.com.cn")) return "巨潮资讯公告";
  return null;
}
