/**
 * MinerU 文档解析 (T-235)。直连 MinerU REST API,把附件解析为 Markdown。
 *
 * 链路:读附件字节 → 申请上传 URL → PUT 上传 → 轮询任务 → 返回 full.md 文本。
 * 数据上云:文件上传到 MinerU 云端 (上海 AI Lab OpenDataLab,国内),用户已确认接受。
 *
 * 本模块是 service-tools file.parse 工具的实现层,不走 MCP 注册表
 * (MinerU 本质是异步 REST API,直连比包 MCP 更轻量)。
 *
 * 配置 (env):
 *   - MINERU_API_TOKEN: 必填,留空则本模块不可用 (file.parse 工具会拒绝调用)。
 *   - MINERU_API_BASE: 可选,默认 https://mineru.net/api/v4。
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BASE = "https://mineru.net/api/v4";

function apiBase(): string {
  return (process.env.MINERU_API_BASE || DEFAULT_BASE).replace(/\/$/, "");
}

function token(): string | null {
  const t = process.env.MINERU_API_TOKEN?.trim();
  return t || null;
}

/** MinerU 是否可用 (token 已配置)。工具层据此决定是否暴露 file.parse。 */
export function isMineruAvailable(): boolean {
  return token() !== null;
}

type FetchOptions = {
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Uint8Array | string;
};

async function mineruFetch(endpoint: string, opts: FetchOptions): Promise<{ status: number; buf: Buffer }> {
  const url = endpoint.startsWith("http") ? endpoint : `${apiBase()}${endpoint}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.method !== "PUT") headers["Authorization"] = `Bearer ${token()}`;
  if (opts.body !== undefined && opts.method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    // MinerU 服务端要求显式 Content-Length,否则请求体不被接收。
    if (typeof opts.body === "string") {
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    } else {
      headers["Content-Length"] = String(opts.body.length);
    }
  }
  const res = await fetch(url, { method: opts.method, headers, body: opts.body as BodyInit });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf };
}

/**
 * 解析一个附件,返回 Markdown 文本。
 *
 * @param input.attachmentId  附件 id
 * @param input.userId         用户 id (附件 scope 校验)
 * @param input.instanceId     实例 id (附件 scope 校验)
 * @param input.fileName       文件名 (含扩展名,决定 MinerU 识别格式)
 * @param input.bytes          文件字节
 * @param input.language       文档语言 (默认 ch),影响 OCR 准确度
 */
export async function parseAttachmentWithMineru(input: {
  attachmentId: string;
  userId: string;
  instanceId: string;
  fileName: string;
  bytes: Buffer;
  language?: string;
}): Promise<{ markdown: string; fullZipUrl: string; taskId: string }> {
  if (!token()) throw new Error("MINERU_API_TOKEN 未配置,file.parse 不可用");
  const language = input.language || "ch";

  // Step 1: 申请上传 URL (batch 接口,给文件名,返回预签名 PUT url + batch_id)
  const step1Body = JSON.stringify({
    enable_formula: true,
    enable_table: true,
    language,
    model_version: "vlm",
    files: [{ name: input.fileName, data_id: input.attachmentId }],
  });
  const step1 = await mineruFetch("/file-urls/batch", { method: "POST", body: step1Body });
  const s1 = JSON.parse(step1.buf.toString("utf8"));
  if (s1.code !== 0 || !s1.data?.file_urls?.[0]) {
    throw new Error(`MinerU 申请上传 URL 失败: ${JSON.stringify(s1).slice(0, 200)}`);
  }
  const uploadUrl = s1.data.file_urls[0] as string;
  const batchId = s1.data.batch_id as string;

  // Step 2: PUT 上传文件字节到预签名 URL (不带 Authorization,URL 自带签名)
  const mimeGuess = guessMime(input.fileName);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeGuess, "Content-Length": String(input.bytes.length) },
    body: new Uint8Array(input.bytes) as BodyInit,
  });
  if (!uploadRes.ok) {
    throw new Error(`MinerU 上传文件失败: HTTP ${uploadRes.status}`);
  }

  // Step 3: 轮询 batch 结果,直到全部任务 done
  const markdown = await pollBatchForMarkdown(batchId);
  return { markdown: markdown.text, fullZipUrl: markdown.fullZipUrl, taskId: batchId };
}

async function pollBatchForMarkdown(batchId: string): Promise<{ text: string; fullZipUrl: string }> {
  const maxAttempts = 60; // 最多 60 次 × 3s = 3 分钟
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(3000);
    const res = await mineruFetch(`/extract-results/batch/${batchId}`, { method: "GET" });
    if (res.status === 404) continue; // 结果未就绪
    const data = JSON.parse(res.buf.toString("utf8"));
    if (data.code !== 0) {
      throw new Error(`MinerU 查询 batch 结果失败: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const results = data.data?.extract_result || [];
    if (results.length === 0) continue;
    // 找第一个 done 的任务
    const done = results.find((r: { state: string }) => r.state === "done" || r.state === "running_done");
    if (done && done.full_zip_url) {
      return { text: await downloadAndExtractMarkdown(done.full_zip_url), fullZipUrl: done.full_zip_url };
    }
    // 有失败的任务则报错
    const failed = results.find((r: { state: string }) => r.state === "failed");
    if (failed) throw new Error(`MinerU 解析失败: ${failed.err_msg || "unknown error"}`);
  }
  throw new Error(`MinerU 解析超时 (batch ${batchId} 超过 3 分钟未完成)`);
}

async function downloadAndExtractMarkdown(zipUrl: string): Promise<string> {
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`下载 MinerU 结果 zip 失败: HTTP ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  // 用系统 unzip 解压 (Node 无内置 zip,与项目现有 probe 脚本一致用系统命令)
  const tmpDir = mkdtempSync(path.join(tmpdir(), "mineru-result-"));
  const tmpZip = path.join(tmpDir, "result.zip");
  writeFileSync(tmpZip, zipBuf);
  try {
    execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { stdio: "ignore" });
    // full.md 是 MinerU 固定输出文件名
    const mdPath = path.join(tmpDir, "full.md");
    if (!existsSync(mdPath)) {
      // 兜底:找任意 .md
      const mdFiles = execSync(`find "${tmpDir}" -name "*.md" -maxdepth 1`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      if (mdFiles.length === 0) throw new Error("MinerU 结果 zip 中未找到 markdown 文件");
      return readFileSync(mdFiles[0], "utf8");
    }
    return readFileSync(mdPath, "utf8");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function guessMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return map[ext] || "application/octet-stream";
}
