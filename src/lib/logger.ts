import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "app.log");

let logStreamReady = false;
try {
  mkdirSync(LOG_DIR, { recursive: true });
  logStreamReady = true;
} catch {
  // 日志目录创建失败，仅输出到 stdout
}

function serializeLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    return JSON.stringify({
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    });
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function toFile(level: string, msg: string, ...args: unknown[]) {
  if (!logStreamReady) return;
  const suffix = args.length ? ` ${args.map(serializeLogArg).join(" ")}` : "";
  try {
    appendFileSync(LOG_FILE, `[${level}] ${new Date().toISOString()} ${msg}${suffix}\n`);
  } catch {
    // 写入失败不阻塞主流程
  }
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => {
    console.log(`[INFO] ${new Date().toISOString()} ${msg}`, ...args);
    toFile("INFO", msg, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args);
    toFile("ERROR", msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args);
    toFile("WARN", msg, ...args);
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args);
      toFile("DEBUG", msg, ...args);
    }
  },
};
