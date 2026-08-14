import type { ArtifactLibraryItem } from "@/lib/protocol";

/**
 * In-memory fixtures that let the mock connector serve the file-retention
 * governance surface (curated library, attachment bytes, delete prepare/
 * confirm) without a real invest-agent-ideal runtime.
 *
 * Everything here is deterministic and scoped to the mock session; it never
 * touches a real workspace. The library covers every curated category plus
 * an `other` artifact, an image (Lightbox route), and a CSV (download route)
 * so the §13 browser acceptance can run end-to-end against the mock.
 */

const MARKDOWN_DAILY = `# 2026-07-25 日复盘

## 今日操作
- 未触发买卖

## 持仓观察
- 主力控盘位于阈值上方

## 下一步
1. 维持现持仓
2. 跟踪主力流入连续性
`;

const MARKDOWN_WEEKLY = `# 2026-W29 周复盘

本周市场震荡上行，组合净值为正。
`;

const MARKDOWN_MONTHLY = `# 2026-07 月复盘

月度收益 +2.3%，跑输沪深300。
`;

const MARKDOWN_COMPANY = `# 贵州茅台 公司与财务分析

毛利率长期 >90%，现金流稳定。
`;

const MARKDOWN_METRICS = `# 决策指标与图表

- ZZLKP: 75（高位）
- 主力净流入 5 日累计正向
`;

const MARKDOWN_MEMORY = `# 投资记忆摘要

生成时间：2026-07-25
数据截止：2026-07-24

本摘要由系统从 memory/*.jsonl 派生，不暴露原始事件流。
`;

const MARKDOWN_OTHER = `# 其他产物

正式 artifacts.publish 但不在精选目录的文件示例。
`;

/**
 * Computes the UTF-8 byte length of a string. Important: the runtime computes
 * `sizeBytes` from the actual file bytes (UTF-8), NOT from the JS string's
 * `.length` (UTF-16 code units). For CJK text these differ — `日复盘` is 3
 * code units but 9 UTF-8 bytes. The ArtifactViewer's checksum/size gate
 * (`bytes.length !== payload.sizeBytes`) would otherwise reject the payload,
 * so every mock sizeBytes must come from this helper to match the base64
 * bytes the mock also serves.
 */
function utf8ByteLength(s: string): number {
  return Buffer.from(s, "utf-8").length;
}

const SVG_CHART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#fafafa"/>
  <polyline points="20,160 80,120 140,140 200,80 260,100 300,60" fill="none" stroke="#10a37f" stroke-width="3"/>
</svg>`;

const CSV_DATA = `指标,数值,同比\nZZLKP,75,+5%\n主力净流入,12.4亿,+18%\n`;

/** Tiny 1x1 PNG used to back the attachment-bytes fixture. */
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const MOCK_LIBRARY_ITEMS: ArtifactLibraryItem[] = [
  {
    artifactId: "mock_art_daily_20260725",
    title: "2026-07-25 日复盘",
    fileName: "2026-07-25.md",
    displayPath: "daily/2026-07-25.md",
    directorySegments: ["daily"],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_DAILY),
    createdAt: "2026-07-25T16:00:00.000Z",
    updatedAt: "2026-07-25T16:00:00.000Z",
    checksum: undefined,
    category: "daily",
    downloadable: false,
    openRoute: "document"
  },
  {
    artifactId: "mock_art_weekly_2026w29",
    title: "2026-W29 周复盘",
    fileName: "2026-W29.md",
    displayPath: "weekly/2026-W29.md",
    directorySegments: ["weekly"],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_WEEKLY),
    createdAt: "2026-07-25T16:00:00.000Z",
    updatedAt: "2026-07-25T16:00:00.000Z",
    category: "weekly",
    downloadable: false,
    openRoute: "document"
  },
  {
    artifactId: "mock_art_monthly_202607",
    title: "2026-07 月复盘",
    fileName: "2026-07.md",
    displayPath: "monthly/2026-07.md",
    directorySegments: ["monthly"],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_MONTHLY),
    createdAt: "2026-07-25T16:00:00.000Z",
    updatedAt: "2026-07-25T16:00:00.000Z",
    category: "monthly",
    downloadable: false,
    openRoute: "document"
  },
  {
    artifactId: "mock_art_company_600519",
    title: "贵州茅台 公司与财务分析",
    fileName: "600519.md",
    displayPath: "company/600519.md",
    directorySegments: ["company"],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_COMPANY),
    createdAt: "2026-07-25T15:00:00.000Z",
    updatedAt: "2026-07-25T15:00:00.000Z",
    category: "company",
    downloadable: false,
    openRoute: "document"
  },
  {
    artifactId: "mock_art_metrics_main_force",
    title: "主力控盘指标图表",
    fileName: "main-force.svg",
    displayPath: "metrics/main-force.svg",
    directorySegments: ["metrics"],
    mimeType: "image/svg+xml",
    previewMode: "image",
    sizeBytes: utf8ByteLength(SVG_CHART),
    createdAt: "2026-07-25T15:30:00.000Z",
    updatedAt: "2026-07-25T15:30:00.000Z",
    category: "metrics",
    downloadable: false,
    openRoute: "image"
  },
  {
    artifactId: "mock_art_metrics_data",
    title: "决策指标数据表",
    fileName: "indicators.csv",
    displayPath: "metrics/indicators.csv",
    directorySegments: ["metrics"],
    mimeType: "text/csv",
    previewMode: "table",
    sizeBytes: utf8ByteLength(CSV_DATA),
    createdAt: "2026-07-25T15:30:00.000Z",
    updatedAt: "2026-07-25T15:30:00.000Z",
    category: "metrics",
    downloadable: true,
    openRoute: "download"
  },
  {
    artifactId: "mock_art_memory_summary",
    title: "投资记忆摘要",
    fileName: "summary.md",
    displayPath: "memory/summary.md",
    directorySegments: ["memory"],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_MEMORY),
    createdAt: "2026-07-25T14:00:00.000Z",
    updatedAt: "2026-07-25T14:00:00.000Z",
    category: "memory",
    downloadable: false,
    openRoute: "document"
  },
  {
    artifactId: "mock_art_other_adhoc",
    title: "其他正式产物示例",
    fileName: "adhoc.md",
    displayPath: "adhoc.md",
    directorySegments: [],
    mimeType: "text/markdown",
    previewMode: "markdown",
    sizeBytes: utf8ByteLength(MARKDOWN_OTHER),
    createdAt: "2026-07-25T13:00:00.000Z",
    updatedAt: "2026-07-25T13:00:00.000Z",
    category: "other",
    downloadable: false,
    openRoute: "document"
  }
];

/** Maps artifactId → base64 bytes for artifacts the mock can serve. */
export const MOCK_ARTIFACT_BYTES: Record<string, { mimeType: string; base64: string; fileName: string }> = {
  mock_art_daily_20260725: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_DAILY).toString("base64"), fileName: "2026-07-25.md" },
  mock_art_weekly_2026w29: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_WEEKLY).toString("base64"), fileName: "2026-W29.md" },
  mock_art_monthly_202607: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_MONTHLY).toString("base64"), fileName: "2026-07.md" },
  mock_art_company_600519: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_COMPANY).toString("base64"), fileName: "600519.md" },
  mock_art_metrics_main_force: { mimeType: "image/svg+xml", base64: Buffer.from(SVG_CHART).toString("base64"), fileName: "main-force.svg" },
  mock_art_metrics_data: { mimeType: "text/csv", base64: Buffer.from(CSV_DATA).toString("base64"), fileName: "indicators.csv" },
  mock_art_memory_summary: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_MEMORY).toString("base64"), fileName: "summary.md" },
  mock_art_other_adhoc: { mimeType: "text/markdown", base64: Buffer.from(MARKDOWN_OTHER).toString("base64"), fileName: "adhoc.md" }
};

/**
 * Attachment bytes the mock serves via attachment.get. `mock_att_active` is an
 * active 1x1 PNG; `mock_att_expired` is registered as already past its TTL so
 * the Portal can render the "附件已过期" card state without a real clock.
 */
export const MOCK_ATTACHMENT_BYTES: Record<
  string,
  { status: "active" | "expired" | "deleted"; mimeType: string; base64: string; fileName: string; sizeBytes: number; expiresAt: string }
> = {
  mock_att_active: {
    status: "active",
    mimeType: "image/png",
    base64: PNG_1x1_BASE64,
    fileName: "screenshot.png",
    sizeBytes: Buffer.from(PNG_1x1_BASE64, "base64").length,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  },
  mock_att_expired: {
    status: "expired",
    mimeType: "image/png",
    base64: PNG_1x1_BASE64,
    fileName: "old-screenshot.png",
    sizeBytes: Buffer.from(PNG_1x1_BASE64, "base64").length,
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  }
};

/** Impact notes the mock returns from delete.prepare, mirroring the runtime. */
export function mockDeleteImpactNotes(category: ArtifactLibraryItem["category"]): string[] {
  const notes = [
    "文件将立即从文档库和已打开标签中移除。",
    "系统保留 30 天恢复窗口，之后永久清除。"
  ];
  if (category === "weekly" || category === "monthly" || category === "daily") {
    notes.push("删除该复盘文件可能影响后续复盘的历史输入。");
  }
  return notes;
}
