import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse } from "node-html-parser";
import { withSourceEvent, type ProviderName } from "./market-data-providers.js";

const EASTMONEY_SEARCH_ENDPOINT = "https://search-api-web.eastmoney.com/search/jsonp";
const SOGOU_SEARCH_ENDPOINT = "https://www.sogou.com/web";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const providerCircuits = new Map<string, { consecutiveFailures: number; openUntil: number }>();

export interface PublicNewsEvidenceItem {
  title: string;
  snippet: string;
  publishedAt: string;
  publisher: string;
  url: string;
}

export interface PublicNewsEvidenceResult {
  query: string;
  items: PublicNewsEvidenceItem[];
  source: {
    provider: "eastmoney_finance_search";
    fetchedAt: string;
    evidenceLevel: "secondary_evidence";
    usageBoundary: string;
    warnings: string[];
  };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ResolveHost = (hostname: string) => Promise<Array<{ address: string }>>;

export interface PublicWebSearchItem {
  title: string;
  snippet: string;
  url: string;
  rank: number;
}

export interface PublicWebSearchResult {
  query: string;
  items: PublicWebSearchItem[];
  source: {
    provider: "sogou_web_search" | "searxng_web_search";
    fetchedAt: string;
    evidenceLevel: "secondary_evidence";
    usageBoundary: string;
    warnings: string[];
  };
}

export interface PublicWebPageResult {
  requestedUrl: string;
  page: null | {
    url: string;
    title: string;
    text: string;
    contentType: string;
    fetchedAt: string;
    truncated: boolean;
  };
  source: {
    provider: "public_web_page";
    fetchedAt: string;
    evidenceLevel: "secondary_evidence";
    usageBoundary: string;
    warnings: string[];
  };
}

export async function searchPublicWeb(
  input: { query: string; limit?: number; userId?: string | null },
  dependencies: { fetchImpl?: FetchLike; now?: Date; searxngUrl?: string } = {},
): Promise<PublicWebSearchResult> {
  const query = normalizeQuery(input.query);
  if (!query) throw new Error("query is required");
  const limit = clampInteger(input.limit, 1, 10, 8);
  const fetchedAt = (dependencies.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  const searxngUrl = dependencies.searxngUrl ?? process.env.EXTERNAL_WEB_SEARCH_SEARXNG_URL?.trim();
  const provider = searxngUrl ? "searxng_web_search" : "sogou_web_search";
  let items: PublicWebSearchItem[] = [];

  try {
    items = await runEvidenceProvider(provider, provider, input.userId ?? null, () =>
      searxngUrl
        ? fetchSearxngResults({ query, limit, endpoint: searxngUrl, fetchImpl: dependencies.fetchImpl ?? fetch })
        : fetchSogouResults({ query, limit, fetchImpl: dependencies.fetchImpl ?? fetch }),
    );
  } catch (error) {
    warnings.push(`provider_failed:${provider}:${classifySearchError(error)}`);
  }
  if (items.length === 0 && warnings.length === 0) warnings.push("no_matching_web_results");

  return {
    query,
    items,
    source: {
      provider,
      fetchedAt,
      evidenceLevel: "secondary_evidence",
      usageBoundary: "网页搜索结果用于发现公开证据；标题和摘要不能替代原文、公告、正式财报或结构化行情，关键事实必须打开来源核验。",
      warnings,
    },
  };
}

export async function readPublicWebPage(
  input: { url: string; maxCharacters?: number; userId?: string | null },
  dependencies: { fetchImpl?: FetchLike; now?: Date; resolveHost?: ResolveHost } = {},
): Promise<PublicWebPageResult> {
  const requestedUrl = normalizePublicUrl(input.url);
  const fetchedAt = (dependencies.now ?? new Date()).toISOString();
  const maxCharacters = clampInteger(input.maxCharacters, 2_000, 50_000, 20_000);
  const warnings: string[] = [];
  try {
    const fetched = await runEvidenceProvider(`public_web_page:${requestedUrl.hostname}`, "public_web_page", input.userId ?? null, () =>
      fetchPublicPage(requestedUrl, dependencies.fetchImpl ?? fetch, dependencies.resolveHost ?? resolvePublicHost),
    );
    const extracted = extractReadablePage(fetched.text, fetched.contentType, maxCharacters);
    if (fetched.bodyTruncated || extracted.truncated) warnings.push("content_truncated");
    if (!extracted.title) warnings.push("title_unavailable");
    if (!extracted.text) warnings.push("page_text_unavailable");
    return {
      requestedUrl: requestedUrl.toString(),
      page: {
        url: fetched.url,
        title: extracted.title,
        text: extracted.text,
        contentType: fetched.contentType,
        fetchedAt,
        truncated: fetched.bodyTruncated || extracted.truncated,
      },
      source: {
        provider: "public_web_page",
        fetchedAt,
        evidenceLevel: "secondary_evidence",
        usageBoundary: "页面正文是公开网页的清洗快照；引用事实时保留原始 URL 和抓取时间，并优先核验公告、监管披露或官方数据。",
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("UNSAFE_URL")) throw error;
    warnings.push(`page_fetch_failed:${classifySearchError(error)}`);
    return {
      requestedUrl: requestedUrl.toString(),
      page: null,
      source: {
        provider: "public_web_page",
        fetchedAt,
        evidenceLevel: "secondary_evidence",
        usageBoundary: "页面读取失败时不得根据搜索摘要补造原文内容。",
        warnings,
      },
    };
  }
}

export async function searchPublicFinanceNews(
  input: { query: string; days?: number; limit?: number; userId?: string | null },
  dependencies: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<PublicNewsEvidenceResult> {
  const query = normalizeQuery(input.query);
  if (!query) throw new Error("query is required");
  const days = clampInteger(input.days, 1, 90, 14);
  const limit = clampInteger(input.limit, 1, 10, 8);
  const fetchedAt = (dependencies.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  let items: PublicNewsEvidenceItem[] = [];

  try {
    items = await withSourceEvent("eastmoney_finance_search", input.userId ?? null, () =>
      fetchEastmoneyFinanceNews({
        query,
        days,
        limit,
        now: dependencies.now ?? new Date(),
        fetchImpl: dependencies.fetchImpl ?? fetch,
      }),
    );
  } catch (error) {
    warnings.push(`provider_failed:eastmoney_finance_search:${classifySearchError(error)}`);
  }
  if (items.length === 0 && warnings.length === 0) warnings.push("no_matching_finance_news");

  return {
    query,
    items,
    source: {
      provider: "eastmoney_finance_search",
      fetchedAt,
      evidenceLevel: "secondary_evidence",
      usageBoundary: "公开财经新闻仅作事件线索和二级证据；重要事实应以公司公告、监管披露或结构化专业数据复核。",
      warnings,
    },
  };
}

async function fetchEastmoneyFinanceNews(input: {
  query: string;
  days: number;
  limit: number;
  now: Date;
  fetchImpl: FetchLike;
}): Promise<PublicNewsEvidenceItem[]> {
  const params = JSON.stringify({
    uid: "",
    keyword: input.query,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize: input.limit,
        preTag: "",
        postTag: "",
      },
    },
  });
  const url = `${EASTMONEY_SEARCH_ENDPOINT}?cb=cb&param=${encodeURIComponent(params)}`;
  const response = await input.fetchImpl(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; InvestAgent/1.0)",
      Referer: "https://so.eastmoney.com/",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  const parsed = parseJsonp(text);
  const rows = parsed?.result?.cmsArticleWebOld;
  if (!Array.isArray(rows)) throw new Error("INVALID_RESPONSE");

  const cutoff = new Date(input.now);
  cutoff.setDate(cutoff.getDate() - input.days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const seen = new Set<string>();
  const items: PublicNewsEvidenceItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const data = row as Record<string, unknown>;
    const publishedAt = String(data.date ?? "").trim();
    const title = stripMarkup(String(data.title ?? ""));
    const url = safeHttpUrl(String(data.url ?? ""));
    if (!title || !url || publishedAt.slice(0, 10) < cutoffDate) continue;
    const key = title.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      snippet: stripMarkup(String(data.content ?? "")).slice(0, 300),
      publishedAt,
      publisher: stripMarkup(String(data.mediaName ?? "")) || "未知媒体",
      url,
    });
    if (items.length >= input.limit) break;
  }
  return items.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

async function fetchSearxngResults(input: {
  query: string;
  limit: number;
  endpoint: string;
  fetchImpl: FetchLike;
}): Promise<PublicWebSearchItem[]> {
  const endpoint = normalizePublicUrl(input.endpoint);
  endpoint.searchParams.set("q", input.query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("categories", "general");
  endpoint.searchParams.set("language", "zh-CN");
  const response = await input.fetchImpl(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "InvestAgent/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readResponseText(response);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error("INVALID_RESPONSE"); }
  const rows = Array.isArray(parsed?.results) ? parsed.results : [];
  const items: PublicWebSearchItem[] = [];
  for (const row of rows) {
    const title = stripMarkup(String(row?.title ?? ""));
    const url = safeHttpUrl(String(row?.url ?? ""));
    if (!title || !url) continue;
    items.push({
      title,
      snippet: stripMarkup(String(row?.content ?? "")).slice(0, 500),
      url,
      rank: items.length + 1,
    });
    if (items.length >= input.limit) break;
  }
  return items;
}

async function fetchSogouResults(input: {
  query: string;
  limit: number;
  fetchImpl: FetchLike;
}): Promise<PublicWebSearchItem[]> {
  const url = new URL(SOGOU_SEARCH_ENDPOINT);
  url.searchParams.set("query", input.query);
  const response = await input.fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; InvestAgent/1.0)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const html = await readResponseText(response);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  if (/安全验证|请输入验证码|antispider/i.test(html)) throw new Error("UPSTREAM_CHALLENGE");
  const document = parse(html);
  const items: PublicWebSearchItem[] = [];
  const seen = new Set<string>();
  for (const heading of document.querySelectorAll("h3.vr-title")) {
    const anchor = heading.querySelector("a[href]");
    if (!anchor) continue;
    const title = normalizeVisibleText(anchor.textContent);
    const container = heading.closest(".vrwrap") || heading.parentNode?.parentNode;
    const directUrl = container?.querySelector("[data-url]")?.getAttribute("data-url") || "";
    const url = safeHttpUrl(directUrl || new URL(anchor.getAttribute("href") || "", SOGOU_SEARCH_ENDPOINT).toString());
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const snippetNode = container?.querySelector(".space-txt")
      || container?.querySelector(".str-text-info")
      || container?.querySelector(".text-layout p");
    const snippet = normalizeVisibleText(snippetNode?.textContent ?? "").slice(0, 500);
    items.push({ title, snippet, url, rank: items.length + 1 });
    if (items.length >= input.limit) break;
  }
  return items;
}

async function fetchPublicPage(url: URL, fetchImpl: FetchLike, resolveHost: ResolveHost) {
  let current = new URL(url);
  const deadline = Date.now() + 15_000;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("REQUEST_TIMEOUT");
    await assertPublicUrl(current, resolveHost);
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        "User-Agent": "Mozilla/5.0 (compatible; InvestAgent/1.0)",
      },
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("INVALID_REDIRECT");
      current = normalizePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const contentType = (response.headers.get("content-type") || "text/plain").toLowerCase();
    if (!isReadableContentType(contentType)) throw new Error("UNSUPPORTED_CONTENT_TYPE");
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
    const body = await readResponseBytes(response, MAX_RESPONSE_BYTES);
    const decoded = decodeResponseBytes(body.bytes, contentType);
    const clientRedirect = contentType.includes("html") ? extractClientRedirect(decoded, current) : null;
    if (clientRedirect) {
      current = normalizePublicUrl(clientRedirect.toString());
      continue;
    }
    return {
      url: current.toString(),
      contentType,
      text: decoded,
      bodyTruncated: body.truncated,
    };
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

async function readResponseText(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  const body = await readResponseBytes(response, MAX_RESPONSE_BYTES);
  if (body.truncated) throw new Error("RESPONSE_TOO_LARGE");
  return decodeResponseBytes(body.bytes, response.headers.get("content-type") || "text/plain");
}

async function readResponseBytes(response: Response, limitBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        total = limitBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

function extractReadablePage(value: string, contentType: string, maxCharacters: number) {
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    const text = normalizeVisibleText(value);
    return { title: "", text: text.slice(0, maxCharacters), truncated: text.length > maxCharacters };
  }
  const document = parse(value);
  const title = normalizeVisibleText(
    document.querySelector("meta[property='og:title']")?.getAttribute("content")
      || document.querySelector("title")?.textContent
      || document.querySelector("h1")?.textContent
      || "",
  );
  for (const selector of ["script", "style", "noscript", "svg", "form", "nav", "footer", "header", "aside"]) {
    for (const node of document.querySelectorAll(selector)) node.remove();
  }
  const preferred = document.querySelector("article") || document.querySelector("main") || document.querySelector("body") || document;
  const text = normalizeVisibleText(preferred.textContent);
  return { title, text: text.slice(0, maxCharacters), truncated: text.length > maxCharacters };
}

function decodeResponseBytes(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] || "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

function isReadableContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType.includes("application/xhtml+xml")
    || contentType.includes("application/json")
    || contentType.includes("application/xml");
}

function extractClientRedirect(value: string, baseUrl: URL): URL | null {
  const candidates = [
    /window\.location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i.exec(value)?.[1],
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*['"]?([^'";>]+)[^"']*["']/i.exec(value)?.[1],
    /<meta[^>]+content=["'][^"']*url\s*=\s*['"]?([^'";>]+)[^"']*["'][^>]+http-equiv=["']?refresh["']?/i.exec(value)?.[1],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return new URL(candidate.trim(), baseUrl); } catch { continue; }
  }
  return null;
}

function normalizePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("UNSAFE_URL:invalid"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname || url.toString().length > 2048) {
    throw new Error("UNSAFE_URL:only credential-free HTTP(S) URLs are allowed");
  }
  return url;
}

async function assertPublicUrl(url: URL, resolveHost: ResolveHost): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("UNSAFE_URL:private hostname");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveHost(hostname).catch(() => []);
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error("UNSAFE_URL:host must resolve only to public addresses");
  }
}

async function resolvePublicHost(hostname: string): Promise<Array<{ address: string }>> {
  return lookup(hostname, { all: true, verbatim: true });
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized));
}

function normalizeVisibleText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

async function runEvidenceProvider<T>(
  circuitKey: string,
  provider: ProviderName,
  userId: string | null,
  task: () => Promise<T>,
): Promise<T> {
  const state = providerCircuits.get(circuitKey);
  if (state && state.openUntil > Date.now()) throw new Error("CIRCUIT_OPEN");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await withSourceEvent(provider, userId, task);
      providerCircuits.delete(circuitKey);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !isRetryableEvidenceError(error)) break;
    }
  }
  const failures = (state?.consecutiveFailures ?? 0) + 1;
  providerCircuits.set(circuitKey, {
    consecutiveFailures: failures,
    openUntil: failures >= CIRCUIT_FAILURE_THRESHOLD ? Date.now() + CIRCUIT_OPEN_MS : 0,
  });
  throw lastError;
}

function isRetryableEvidenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|HTTP_429|HTTP_5\d\d/i.test(message);
}

function parseJsonp(text: string): any {
  const trimmed = text.trim();
  if (!trimmed.startsWith("cb(") || !trimmed.endsWith(")")) throw new Error("INVALID_RESPONSE");
  try {
    return JSON.parse(trimmed.slice(3, -1));
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
}

function normalizeQuery(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function classifySearchError(error: unknown): string {
  const message = errorChainMessage(error);
  if (message.includes("timeout") || message.includes("Timeout")) return "timeout";
  if (/unable to verify|certificate|SELF_SIGNED|CERT_/i.test(message)) return "tls_certificate_untrusted";
  if (/HTTP_\d+/.test(message)) return message.toLowerCase();
  if (["INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "UNSUPPORTED_CONTENT_TYPE", "TOO_MANY_REDIRECTS", "UPSTREAM_CHALLENGE", "CIRCUIT_OPEN"].includes(message)) return message.toLowerCase();
  return "upstream_error";
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(": ");
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
