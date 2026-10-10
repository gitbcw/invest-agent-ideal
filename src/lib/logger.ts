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

// T-586 防倾倒（2026-09 事故：Mastra SDK 错误对象整对象经 console 透传给 pm2，
// 一次事故 2.8 万行元数据倾倒淹没真实签名）。所有出口共用同一序列化：
// console 不再透传原始对象，且单参数长度封顶。
const MAX_LOG_ARG_CHARS = 2_000;

function serializeLogArg(arg: unknown): string {
  let text: string;
  if (typeof arg === "string") {
    text = arg;
  } else if (arg instanceof Error) {
    text = JSON.stringify({
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    });
  } else {
    try {
      text = JSON.stringify(arg);
    } catch {
      text = String(arg);
    }
  }
  if (text.length <= MAX_LOG_ARG_CHARS) return text;
  return `${text.slice(0, MAX_LOG_ARG_CHARS)}…[truncated ${text.length} chars]`;
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

function toConsole(method: "log" | "error" | "warn", prefix: string, msg: string, ...args: unknown[]) {
  const serialized = args.map(serializeLogArg);
  console[method](`${prefix} ${new Date().toISOString()} ${msg}`, ...serialized);
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => {
    toConsole("log", "[INFO]", msg, ...args);
    toFile("INFO", msg, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    toConsole("error", "[ERROR]", msg, ...args);
    toFile("ERROR", msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    toConsole("warn", "[WARN]", msg, ...args);
    toFile("WARN", msg, ...args);
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV === "development") {
      toConsole("log", "[DEBUG]", msg, ...args);
      toFile("DEBUG", msg, ...args);
    }
  },
};
