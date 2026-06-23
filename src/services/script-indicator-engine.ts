/**
 * L3b 沙箱脚本指标引擎
 *
 * 流程:
 *   1. compile(scriptPath):
 *      - 读源文件,算 hash
 *      - 若 cache/build/<base>.<hash>.js 存在,直接复用
 *      - 否则用 esbuild bundle:把 `invest-agent-runtime` 解析到 sandbox-runtime.ts,
 *        输出可在 isolate 内运行的纯 CJS
 *   2. run(scriptPath, ctx):
 *      - 创建 isolate(内存限制 memoryLimitMB)
 *      - 注入 ctx(ExternalCopy 深拷贝)
 *      - 加载 bundle + 调用 compute(ctx)
 *      - 超时 timeoutMs 熔断
 *      - 返回结果(深拷贝回 host)
 *
 * @see docs/composite-indicator-system.md 第 8 节
 */

import ivm from "isolated-vm";
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";

import type { IndicatorContext, IndicatorResult } from "./sandbox-runtime.js";

const DEFAULT_MEMORY_LIMIT_MB = 64;
const DEFAULT_TIMEOUT_MS = 5000;

export interface ScriptIndicatorEngineOptions {
  /** 工作空间根目录,缓存默认落到 <workspaceRoot>/cache/build */
  workspaceRoot: string;
  /** 自定义缓存目录(默认 <workspaceRoot>/cache/build) */
  cacheDir?: string;
  /** isolate 内存上限(MB),默认 64 */
  memoryLimitMB?: number;
  /** 单次执行超时(ms),默认 5000 */
  timeoutMs?: number;
}

export interface CompileResult {
  hash: string;
  compiledPath: string;
  fromCache: boolean;
}

const RUNTIME_MODULE_NAME = "invest-agent-runtime";

export class ScriptIndicatorEngine {
  private readonly cacheDir: string;
  private readonly memoryLimitMB: number;
  private readonly timeoutMs: number;
  private readonly runtimeModulePath: string;

  constructor(options: ScriptIndicatorEngineOptions) {
    this.cacheDir = options.cacheDir ?? join(options.workspaceRoot, "cache", "build");
    this.memoryLimitMB = options.memoryLimitMB ?? DEFAULT_MEMORY_LIMIT_MB;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // sandbox-runtime.js 与本文件同目录(编译后都在 dist/services/)
    this.runtimeModulePath = resolve(__dirname, "sandbox-runtime.js");
  }

  /**
   * 编译用户脚本为可缓存的可执行 JS
   */
  async compile(scriptPath: string): Promise<CompileResult> {
    const source = await readFile(scriptPath, "utf8");
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const scriptBase = basename(scriptPath, extname(scriptPath));
    const compiledPath = join(this.cacheDir, `${scriptBase}.${hash}.js`);

    if (existsSync(compiledPath)) {
      return { hash, compiledPath, fromCache: true };
    }

    await mkdir(this.cacheDir, { recursive: true });

    const resolverPlugin: Plugin = {
      name: "invest-agent-runtime-resolver",
      setup: (build) => {
        build.onResolve({ filter: new RegExp(`^${RUNTIME_MODULE_NAME}$`) }, () => ({
          path: this.runtimeModulePath,
        }));
      },
    };

    await build({
      entryPoints: [scriptPath],
      bundle: true,
      format: "cjs",
      target: "es2022",
      platform: "neutral",
      outfile: compiledPath,
      logLevel: "silent",
      plugins: [resolverPlugin],
    });

    return { hash, compiledPath, fromCache: false };
  }

  /**
   * 编译并执行脚本
   */
  async run(scriptPath: string, ctx: IndicatorContext): Promise<IndicatorResult> {
    const { compiledPath } = await this.compile(scriptPath);
    const code = await readFile(compiledPath, "utf8");

    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMB });
    const context = isolate.createContextSync();

    // 注入 ctx(深拷贝进 isolate)
    context.global.setSync("ctx", new ivm.ExternalCopy(ctx).copyInto());

    // 在 isolate 内加载用户模块 + 调用 compute(ctx)
    // 把 bundle 包进 IIFE 是为了隔离作用域——用户脚本顶层的
    // `const compute`/`function compute` 不能与外层标识符冲突。
    const wrapper = `
(async () => {
  const userExports = (function () {
    const module = { exports: {} };
    const exports = module.exports;
    ${code}
    return module.exports;
  })();
  const computeFn = userExports.compute;
  if (typeof computeFn !== 'function') {
    throw new Error('Script must export compute(ctx) function');
  }
  return computeFn(ctx);
})()
`;

    try {
      const result = (await context.eval(wrapper, {
        timeout: this.timeoutMs,
        copy: true,
        promise: true,
      })) as IndicatorResult;

      if (!result || typeof result !== "object" || !result.values) {
        throw new Error("Script compute(ctx) must return { values: {...} }");
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("execution timed out")) {
        throw new Error(
          `ScriptIndicatorEngine: execution timed out after ${this.timeoutMs}ms (script=${basename(scriptPath)})`,
        );
      }
      if (message.includes("array buffer allocation failed")) {
        throw new Error(
          `ScriptIndicatorEngine: memory limit exceeded ${this.memoryLimitMB}MB (script=${basename(scriptPath)})`,
        );
      }
      throw new Error(`ScriptIndicatorEngine: script error in ${basename(scriptPath)}: ${message}`);
    } finally {
      isolate.dispose();
    }
  }
}
