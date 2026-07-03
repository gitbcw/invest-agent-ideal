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

export function redactSensitiveText(text: string) {
  let redacted = String(text || "");
  for (const [pattern, replacement] of UNSAFE_OUTPUT_REPLACEMENTS.slice(0, 6)) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function sanitizeCustomerText(text: string) {
  let cleaned = String(text || "");
  for (const [pattern, replacement] of UNSAFE_OUTPUT_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  return cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
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
