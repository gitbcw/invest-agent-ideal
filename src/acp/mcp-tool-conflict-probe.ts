/**
 * MCP 工具名冲突检测探针 (F5)
 *
 * codex-acp 是平面命名空间——不自动给工具名加 server 前缀。如果两个 MCP server
 * 暴露同名工具，后注册的会覆盖前者（行为不确定）。本探针在会话装配前连接各 server，
 * 枚举 tools/list，对跨 server 重名 fail closed。
 *
 * 由于 service-tools 的工具名要到 spawn 子进程 + MCP 握手后才知道，本探针是运行时的
 * （不是配置阶段的）。它返回冲突报告；调用方决定是否拒绝装配冲突 server。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../lib/logger.js";
import type { AcpMcpServer } from "./mcp-session-manifest.js";

export interface ToolConflict {
  toolName: string;
  servers: string[];
}

export interface ToolConflictReport {
  /** 无冲突时为空数组。 */
  conflicts: ToolConflict[];
  /** 每个成功探针的 server → 工具名列表。 */
  serverTools: Map<string, string[]>;
  /** 探针失败的 server → 错误信息。 */
  failedServers: Map<string, string>;
}

/**
 * 对已装配的 MCP server 做工具名冲突检测。
 * 连接每个 server（stdio），执行 initialize → tools/list，收集工具名，检测跨 server 重名。
 *
 * service-owned server 的工具名优先级最高：如果外部 server 与 service server 冲突，
 * 外部 server 应被拒绝（service write tools 永远不能被外部遮蔽）。
 */
export async function probeToolConflicts(servers: AcpMcpServer[]): Promise<ToolConflictReport> {
  const serverTools = new Map<string, string[]>();
  const failedServers = new Map<string, string>();

  for (const server of servers) {
    try {
      const tools = await probeServerTools(server);
      serverTools.set(server.name, tools);
    } catch (error) {
      failedServers.set(server.name, (error as Error).message);
      logger.warn(`[TOOL_CONFLICT_PROBE] server=${server.name} probe failed: ${(error as Error).message}`);
    }
  }

  // 检测跨 server 重名
  const toolToServers = new Map<string, string[]>();
  for (const [serverName, tools] of serverTools) {
    for (const tool of tools) {
      const existing = toolToServers.get(tool) ?? [];
      existing.push(serverName);
      toolToServers.set(tool, existing);
    }
  }

  const conflicts: ToolConflict[] = [];
  for (const [toolName, serverList] of toolToServers) {
    if (serverList.length > 1) {
      conflicts.push({ toolName, servers: serverList.sort() });
    }
  }

  return { conflicts, serverTools, failedServers };
}

/** 连接单个 stdio MCP server，执行 initialize → tools/list，返回工具名列表。 */
async function probeServerTools(server: AcpMcpServer, timeoutMs = 10_000): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const { name, value } of server.env) env[name] = value;

    const childEnv: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
      if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }
    Object.assign(childEnv, env);

    const child = spawn(server.command, server.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv,
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let id = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    function send(method: string, params: unknown): Promise<unknown> {
      const msgId = ++id;
      return new Promise((res, rej) => {
        pending.set(msgId, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
      });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id)!;
          pending.delete(msg.id);
          msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`probe process exited before completion code=${code ?? "-"} signal=${signal ?? "-"}`));
    });

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tool-conflict-probe", version: "1.0.0" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listResult = await send("tools/list", {}) as { tools?: Array<{ name: string }> };
        clearTimeout(timer);
        child.kill();
        resolve((listResult.tools ?? []).map((t) => t.name));
      } catch (err) {
        clearTimeout(timer);
        child.kill();
        reject(err as Error);
      }
    })();
  });
}

/**
 * 判断冲突报告是否阻断会话装配。
 * service-owned server 永远不能被外部遮蔽：如果冲突涉及 service server，阻断。
 * 纯外部 server 间冲突也阻断（fail closed，不静默覆盖）。
 */
export function shouldBlockSessionOnConflict(report: ToolConflictReport, serviceServerName: string): boolean {
  if (report.conflicts.length === 0) return false;
  // 任何冲突都阻断（fail closed）
  return true;
}
