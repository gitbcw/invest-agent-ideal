export interface StockSectorTheme {
  stockCode: string;
  stockName: string;
  industry: Array<SectorThemeTag>;
  concepts: Array<SectorThemeTag>;
  tags: Array<SectorThemeTag>;
  updatedAt: string;
}

export interface SectorThemeTag {
  code: string;
  name: string;
  rank: number | null;
  precise: boolean | null;
  reason: string;
  sourceType: "industry" | "concept" | "tag";
}

interface CoreConceptionItem {
  SECURITY_CODE?: string;
  SECURITY_NAME_ABBR?: string;
  BOARD_CODE?: string | number;
  BOARD_NAME?: string;
  BOARD_RANK?: string | number | null;
  IS_PRECISE?: string | number | null;
  SELECTED_BOARD_REASON?: string | null;
}

interface CoreConceptionResponse {
  ssbk?: CoreConceptionItem[];
}

function secCode(code: string): string {
  const pure = code.replace(/^(sh|sz|SH|SZ)/, "").replace(/\.(sh|sz|SH|SZ)$/, "");
  const suffix = pure.startsWith("6") || pure.startsWith("5") ? "SH" : "SZ";
  return `${suffix}${pure}`;
}

export async function getStockSectorTheme(code: string): Promise<StockSectorTheme | null> {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${secCode(code)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://emweb.securities.eastmoney.com/",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as CoreConceptionResponse;
  const rows = Array.isArray(json.ssbk) ? json.ssbk : [];
  if (rows.length === 0) return null;

  const stockCode = String(rows[0]?.SECURITY_CODE || code.replace(/\D/g, "").slice(-6));
  const stockName = String(rows[0]?.SECURITY_NAME_ABBR || stockCode);
  const mapped = rows
    .map(mapTag)
    .filter((item): item is SectorThemeTag => Boolean(item))
    .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));

  return {
    stockCode,
    stockName,
    industry: mapped.filter((item) => item.sourceType === "industry"),
    concepts: mapped.filter((item) => item.sourceType === "concept"),
    tags: mapped.filter((item) => item.sourceType === "tag"),
    updatedAt: new Date().toISOString(),
  };
}

function mapTag(item: CoreConceptionItem): SectorThemeTag | null {
  const name = String(item.BOARD_NAME || "").trim();
  if (!name) return null;
  const rank = Number(item.BOARD_RANK);
  const preciseRaw = item.IS_PRECISE == null ? "" : String(item.IS_PRECISE);
  return {
    code: normalizeBoardCode(item.BOARD_CODE),
    name,
    rank: Number.isFinite(rank) ? rank : null,
    precise: preciseRaw === "" ? null : preciseRaw === "1",
    reason: String(item.SELECTED_BOARD_REASON || "").trim(),
    sourceType: classifyTag(name, Number.isFinite(rank) ? rank : null, String(item.SELECTED_BOARD_REASON || "")),
  };
}

function normalizeBoardCode(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("BK") ? raw : `BK${raw.padStart(4, "0")}`;
}

function classifyTag(name: string, rank: number | null, reason: string): SectorThemeTag["sourceType"] {
  if (rank != null && rank <= 3) return "industry";
  if (reason.trim()) return "concept";
  if (/(概念|电池|新能源|人工智能|芯片|机器人|储能|光伏|算力|低空|固态)/.test(name)) return "concept";
  return "tag";
}
