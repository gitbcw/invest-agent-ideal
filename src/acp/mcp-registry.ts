/**
 * 配置型 MCP 注册表 (WP1)
 *
 * 把 ACP 会话能接入的 MCP server 从 `buildInvestAgentMcpServers` 的硬编码
 * 单服务器改为受控注册表。首版只配置、不建表、不图形管理后台。
 *
 * 设计要点:
 *   - 注册项只存 secret 引用名 (envRefs / headerRefs),解析后的明文只进入
 *     对应子进程或传输请求,绝不进入 manifest 摘要、trace 或用户可见输出。
 *   - service-scoped 注册项必须由 invest-agent 拥有;external-readonly 注册项
 *     永不获得 service scope 环境引用 (DB_PATH / Workspace / sandbox secret 等)。
 *   - external-readonly stdio server 通过声明式的 `<env:NAME>` 模板描述启动命令与
 *     参数。解析只做纯字符串替换 (Node 端直接 spawn(command, args)),绝不调用
 *     shell 或对命令替换求值。新增第二个外部 server 只需声明注册项,核心解析
 *     逻辑不再出现 server-specific 分支。
 *   - http transport 只有在 ACP 初始化声明 mcp_capabilities.http=true 时才装配;
 *     capability 缺失时 fail closed。
 */

import path from "node:path";
import { logger } from "../lib/logger.js";
import {
  buildExternalRegistrations,
  isExternalRegistrationActivated,
} from "./external-mcp-registrations.js";

// ─── 注册模型 ──────────────────────────────────────────────────────

/**
 * Transport 对齐 ACP SDK 0.16.1 实际类型 (http/sse/stdio)。SDK 无 streamable-http 概念。
 *
 * stdio command / args 支持两种写法:
 *   - 字面量值 (如 "-m"、"run"):原样使用。
 *   - `<env:VARIABLE_NAME>` 模板:解析时用同名环境变量的值做纯字符串替换。
 *     模板绝不触发 shell;值直接作为 spawn(command, args) 的对应元素。
 * requiredEnvRefs 声明所有必须在解析时存在的引用名 (含模板里出现的变量),
 * 缺任一即该外部 server unavailable (fail closed, 仅跳过该 server)。
 * envRefs 声明要注入子进程环境的引用名 (envRefs ⊇ requiredEnvRefs 通常成立,
 * 但并非强制:启动专用值可不进 child env)。
 */
export type McpHttpHeaderRef = {
  name: string;
  envRef: string;
  prefix?: string;
};

export type McpTransport =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      envRefs?: string[];
      requiredEnvRefs?: string[];
    }
  | {
      kind: "http";
      url: string;
      headerRefs?: string[];
      headers?: McpHttpHeaderRef[];
      requiredEnvRefs?: string[];
    };

export type McpTrustClass = "service-scoped" | "external-readonly";
export type McpOwner = "invest-agent" | "external";
export type McpSessionKind = "interactive" | "scheduled-read" | "evaluation";

export interface McpServerRegistration {
  id: string;
  owner: McpOwner;
  enabled: boolean;
  trustClass: McpTrustClass;
  transport: McpTransport;
  versionPolicy?: { expected?: string; allowedRange?: string };
  sessionKinds: McpSessionKind[];
}

// ─── service-scoped 环境引用名 ────────────────────────────────────
//
// 这些引用名描述 service-scoped server 需要的 env 变量类别。
// external-readonly server 永远拿不到这一组引用 —— 它是 service 与外部 MCP
// 之间的安全边界。引用名由 manifest resolver 解析成实际值。
//
// 区分两类:
//   - scope refs: 从 UserContext 派生,随用户/实例/任务变化
//   - passthrough refs: 从 process.env 读取,全局不变 (含凭据)
export const SERVICE_SCOPE_ENV_REFS = [
  // scope refs (从 UserContext 派生)
  "INVEST_AGENT_MCP_USER_ID",
  "INVEST_AGENT_MCP_INSTANCE_ID",
  "INVEST_AGENT_MCP_WORKSPACE_PATH",
  "INVEST_AGENT_MCP_CONVERSATION_ID",
  "INVEST_AGENT_MCP_ALLOWED_TOOLS",
  "INVEST_AGENT_MCP_EXPECTED_REVIEW_KIND",
  "INVEST_AGENT_MCP_EXPECTED_REVIEW_KEY",
  // passthrough refs (从 env 读 + projectRoot resolve)
  "INVEST_AGENT_PROJECT_ROOT",
  "DB_PATH",
  "WORKSPACE_ROOT",
  "WORKSPACE_TEMPLATE_PATH",
  "WORKSPACE_BACKEND",
  "RUNTIME_DATA_ROOT",
  "REVIEWS_ROOT",
  // 可选凭据透传 (passthrough, 仅 service-scoped)
  "INVEST_AGENT_SANDBOX_SECRET",
  "INVEST_AGENT_SANDBOX_SECRET_FILE",
  "TUSHARE_TOKEN",
  "TDX_MCP_API_KEY",
  "TDX_MCP_URL",
  "TDX_MCP_FUNDAMENTALS_TOOL",
  "EXTERNAL_WEB_SEARCH_SEARXNG_URL",
] as const;

/** external-readonly server 被禁止引用的 scope 名 (安全边界护栏)。 */
const FORBIDDEN_EXTERNAL_REFS = new Set<string>(SERVICE_SCOPE_ENV_REFS);

// ─── <env:NAME> 模板工具 ───────────────────────────────────────────
//
// 模板形式严格限定为 `<env:VARIABLE_NAME>`。VARIABLE_NAME 必须是合法的环境
// 变量名 (字母/数字/下划线,首字符非数字)。替换是纯字符串操作,绝不调用 shell。

const ENV_TOKEN_RE = /<env:([A-Za-z_][A-Za-z0-9_]*)>/g;
// 仅用于在校验阶段报告"看起来像模板但 token 名非法"的情况
const MALFORMED_TOKEN_RE = /<env:([^>]*)>/g;

function isEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** 提取字符串中所有合法 `<env:NAME>` 引用的变量名 (去重)。 */
function extractEnvRefs(value: string): string[] {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  ENV_TOKEN_RE.lastIndex = 0;
  while ((m = ENV_TOKEN_RE.exec(value)) !== null) {
    refs.add(m[1]);
  }
  return Array.from(refs);
}

/** 检测形如 `<env:...>` 但变量名非法的 token,返回首个非法原始片段。 */
function findMalformedEnvToken(value: string): string | null {
  let m: RegExpExecArray | null;
  MALFORMED_TOKEN_RE.lastIndex = 0;
  while ((m = MALFORMED_TOKEN_RE.exec(value)) !== null) {
    const raw = m[1];
    if (!isEnvVarName(raw)) return `<env:${raw}>`;
  }
  return null;
}

/**
 * 纯字符串替换 `<env:NAME>` → env[NAME] (env 中缺失或空串时替换为空串)。
 * 返回替换后的字符串。绝不调用 shell、绝不求值命令替换。
 */
function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_TOKEN_RE, (_, name: string) => env[name] ?? "");
}

// ─── 校验 ──────────────────────────────────────────────────────────

export class McpRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

export function validateRegistration(reg: McpServerRegistration): string | null {
  if (!reg.id || typeof reg.id !== "string") return "registration id is required";
  if (!/^[a-zA-Z0-9_.-]+$/.test(reg.id)) return `invalid registration id: ${reg.id}`;
  if (reg.trustClass === "service-scoped" && reg.owner !== "invest-agent") {
    return `service-scoped server must be owned by invest-agent: ${reg.id}`;
  }
  if (reg.trustClass === "external-readonly" && reg.owner === "invest-agent") {
    return `external-readonly server should not be owned by invest-agent: ${reg.id}`;
  }
  if (!Array.isArray(reg.sessionKinds) || reg.sessionKinds.length === 0) {
    return `sessionKinds must be non-empty: ${reg.id}`;
  }
  // transport 一致性
  if (reg.transport.kind === "stdio") {
    if (!reg.transport.command) return `stdio server missing command: ${reg.id}`;
    if (!Array.isArray(reg.transport.args)) return `stdio server missing args: ${reg.id}`;

    // 模板 token 校验 (仅 stdio)
    const { command, args, envRefs = [], requiredEnvRefs = [] } = reg.transport;

    // 1) 非法 token 名 (如 `<env:not a valid name>`)
    for (const candidate of [command, ...args]) {
      const malformed = findMalformedEnvToken(candidate);
      if (malformed) {
        return `invalid env token in transport for ${reg.id}: ${malformed}`;
      }
    }

    // 2) 所有模板里出现的变量必须声明在 requiredEnvRefs 里
    const templateRefs = new Set<string>();
    for (const candidate of [command, ...args]) {
      for (const ref of extractEnvRefs(candidate)) templateRefs.add(ref);
    }
    const declared = new Set(requiredEnvRefs);
    const undeclared = Array.from(templateRefs).filter((r) => !declared.has(r));
    if (undeclared.length) {
      return (
        `transport template references missing requiredEnvRefs for ${reg.id}: ${undeclared.join(", ")}`
      );
    }

    // 3) required/env refs 呻必须是合法变量名
    for (const ref of [...requiredEnvRefs, ...envRefs]) {
      if (!isEnvVarName(ref)) {
        return `invalid env reference name for ${reg.id}: ${ref}`;
      }
    }
  } else if (reg.transport.kind === "http") {
    if (!reg.transport.url) return `http server missing url: ${reg.id}`;
    const refs = [
      ...(reg.transport.headerRefs || []),
      ...(reg.transport.headers || []).map((header) => header.envRef),
      ...(reg.transport.requiredEnvRefs || []),
    ];
    for (const ref of refs) {
      if (!isEnvVarName(ref)) return `invalid env reference name for ${reg.id}: ${ref}`;
    }
    const malformed = findMalformedEnvToken(reg.transport.url);
    if (malformed) return `invalid env token in transport for ${reg.id}: ${malformed}`;
    const templateRefs = extractEnvRefs(reg.transport.url);
    const declared = new Set(reg.transport.requiredEnvRefs || []);
    const undeclared = templateRefs.filter((ref) => !declared.has(ref));
    if (undeclared.length) {
      return `transport template references missing requiredEnvRefs for ${reg.id}: ${undeclared.join(", ")}`;
    }
    const duplicateHeaders = new Set<string>();
    for (const header of reg.transport.headers || []) {
      if (!header.name || !header.envRef) return `http header ref is incomplete: ${reg.id}`;
      if (duplicateHeaders.has(header.name.toLowerCase())) {
        return `duplicate http header: ${reg.id} ${header.name}`;
      }
      duplicateHeaders.add(header.name.toLowerCase());
    }
  }
  // external-readonly 安全边界:不得引用 forbidden scope
  if (reg.trustClass === "external-readonly") {
    if (reg.transport.kind === "stdio") {
      const refs = [...(reg.transport.envRefs || []), ...(reg.transport.requiredEnvRefs || [])];
      const leaked = refs.filter((r) => FORBIDDEN_EXTERNAL_REFS.has(r));
      if (leaked.length) {
        return `external-readonly server ${reg.id} must not reference service scope env: ${leaked.join(", ")}`;
      }
    } else {
      const refs = [
        ...(reg.transport.headerRefs || []),
        ...(reg.transport.headers || []).map((header) => header.envRef),
        ...(reg.transport.requiredEnvRefs || []),
      ];
      const leaked = refs.filter((r) => FORBIDDEN_EXTERNAL_REFS.has(r));
      if (leaked.length) {
        return `external-readonly server ${reg.id} must not reference service scope env: ${leaked.join(", ")}`;
      }
    }
  }
  return null;
}

// ─── 注册表 ────────────────────────────────────────────────────────

/**
 * 构建内建 `invest-agent-service-tools` 注册项。
 *
 * command / dist 路径在 resolve 时解析 (传入 projectRoot + execPath),
 * 因为它们依赖运行时进程上下文,注册项本身保持可序列化的引用形态。
 */
export function buildBuiltinServiceToolsRegistration(): McpServerRegistration {
  return {
    id: "invest-agent-service-tools",
    owner: "invest-agent",
    enabled: true,
    trustClass: "service-scoped",
    transport: {
      kind: "stdio",
      // 运行时解析:resolve 时替换为 process.execPath
      command: "<runtime:exec-path>",
      // 运行时解析:resolve 时拼出 dist/mcp/invest-agent-service-tools.js
      args: ["<runtime:dist-mcp-path>"],
      envRefs: [...SERVICE_SCOPE_ENV_REFS],
    },
    sessionKinds: ["interactive", "scheduled-read", "evaluation"],
  };
}

export class McpRegistry {
  private readonly registrations = new Map<string, McpServerRegistration>();

  constructor(builtins: McpServerRegistration[] = [buildBuiltinServiceToolsRegistration()]) {
    for (const reg of builtins) {
      this.register(reg);
    }
  }

  /** 注册一项。重复 id 或校验失败抛 McpRegistryError (fail closed)。 */
  register(reg: McpServerRegistration): void {
    const err = validateRegistration(reg);
    if (err) throw new McpRegistryError(err, "invalid_registration");
    if (this.registrations.has(reg.id)) {
      throw new McpRegistryError(`duplicate server id: ${reg.id}`, "duplicate_id");
    }
    this.registrations.set(reg.id, { ...reg });
  }

  getRegistration(id: string): McpServerRegistration | undefined {
    return this.registrations.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const reg = this.registrations.get(id);
    if (!reg) throw new McpRegistryError(`unknown server id: ${id}`, "unknown_id");
    reg.enabled = enabled;
  }

  /** 列出全部注册项 (含禁用)。 */
  listRegistrations(): McpServerRegistration[] {
    return Array.from(this.registrations.values());
  }

  /** 列出已启用的注册项,可选按 sessionKind 过滤。 */
  listEnabledRegistrations(sessionKind?: McpSessionKind): McpServerRegistration[] {
    return this.listRegistrations().filter(
      (reg) => reg.enabled && (!sessionKind || reg.sessionKinds.includes(sessionKind)),
    );
  }
}

// ─── 全局单例 ──────────────────────────────────────────────────────
//
// 首版使用进程内单例;不引入数据库后台。测试可通过 createMcpRegistry() 构造独立实例。

let globalRegistry: McpRegistry | undefined;

export function getMcpRegistry(): McpRegistry {
  if (!globalRegistry) {
    globalRegistry = new McpRegistry();
    // 外部只读 MCP 按各自 activation 开关接入 (默认关闭)。
    // activation 判断由 external-mcp-registrations.ts 拥有,本模块不含 server-specific 逻辑。
    registerExternalMcpServers(globalRegistry);
  }
  return globalRegistry;
}

/**
 * 把外部只读 MCP 注册项接入注册表并启用。
 * 每个 registration 自带 isActivated() 判断 (env 开关),只有激活的才注册+启用。
 * 幂等:已注册的 id 跳过。
 */
export function registerExternalMcpServers(
  registry: McpRegistry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // 延迟导入避免循环依赖
  for (const reg of buildExternalRegistrations()) {
    if (registry.getRegistration(reg.id)) continue;
    // 仅注册并启用声明了 activation=true 的项;其余跳过 (零行为回归)
    if (!isExternalRegistrationActivated(reg, env)) continue;
    registry.register(reg);
    registry.setEnabled(reg.id, true);
  }
}

export function createMcpRegistry(builtins?: McpServerRegistration[]): McpRegistry {
  return new McpRegistry(builtins);
}

/** 仅供测试重置全局单例。 */
export function resetMcpRegistryForTest(): void {
  globalRegistry = undefined;
}

/**
 * 运行时把 service-scoped 注册项中的 `<runtime:*>` 占位符解析成实际路径/命令。
 *
 * 仅处理 service-scoped 的 `<runtime:exec-path>` 与 `<runtime:dist-mcp-path>`。
 * external-readonly server 的 `<env:NAME>` 模板由 resolveExternalServer 处理,
 * 不在这里展开 —— 两条解析路径独立,避免把外部 server 的环境推导耦合进 service scope。
 */
export function resolveRuntimePlaceholders(
  reg: McpServerRegistration,
  ctx: { projectRoot: string; execPath: string },
): McpServerRegistration {
  if (reg.transport.kind !== "stdio") return reg;
  return {
    ...reg,
    transport: {
      ...reg.transport,
      command: reg.transport.command.replace("<runtime:exec-path>", ctx.execPath),
      args: reg.transport.args.map((arg) =>
        arg.replace(
          "<runtime:dist-mcp-path>",
          path.join(ctx.projectRoot, "dist/mcp/invest-agent-service-tools.js"),
        ),
      ),
    },
  };
}

// ─── external-readonly stdio readiness / resolve ──────────────────
//
// 用结构化、不含 secret 的结果替换原先的 boolean 健康检查。caller 可记录
// "缺少哪个引用名",但绝不会记录对应值。

export type ExternalStdioReadiness =
  | { ok: true }
  | {
      ok: false;
      code: "missing_required_env" | "invalid_template" | "empty_command";
      missingRefs: string[];
    };

/**
 * 评估一个 external-readonly stdio server 是否就绪可启动。
 *
 * 顺序:
 *   1. 非法模板 token → invalid_template
 *   2. requiredEnvRefs 中任一缺失/空 → missing_required_env (missingRefs 列出名字)
 *   3. 解析后 command 为空 → empty_command
 * 返回值只含引用名,绝不含环境变量值。
 *
 * 非 external-readonly / 非 stdio 的注册项恒为 ok (由其它路径处理)。
 */
export function checkExternalStdioReadiness(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv,
): ExternalStdioReadiness {
  if (reg.trustClass !== "external-readonly" || reg.transport.kind !== "stdio") return { ok: true };

  const { command, args, requiredEnvRefs = [] } = reg.transport;

  // 1) 模板 token 名合法性 (与校验阶段一致的双保险)
  for (const candidate of [command, ...args]) {
    const malformed = findMalformedEnvToken(candidate);
    if (malformed) {
      return { ok: false, code: "invalid_template", missingRefs: [malformed] };
    }
  }

  // 2) 必需引用必须存在且非空
  const missing = requiredEnvRefs.filter((ref) => !env[ref] || env[ref] === "");
  if (missing.length) {
    return { ok: false, code: "missing_required_env", missingRefs: [...missing] };
  }

  // 3) 解析后 command 不能为空 (字面量 command 自然非空;模板替换后可能为空)
  const resolvedCommand = interpolateEnv(command, env);
  if (!resolvedCommand) {
    return { ok: false, code: "empty_command", missingRefs: [] };
  }

  return { ok: true };
}

/**
 * 解析 external-readonly server 的 stdio 启动配置。
 *
 *   1. checkExternalStdioReadiness 先判断;不就绪返回 null (caller skip 该 server)。
 *   2. 用纯字符串替换展开 command/args 中的 `<env:NAME>` (绝不调 shell)。
 *   3. 从声明的 envRefs 构造 child env,双保险过滤 forbidden service scope。
 *
 * 返回的 env 数组只含声明过且当前 env 中存在的引用;secret 值只进入子进程,
 * 绝不进入 manifest / 日志 / 指纹。
 */
export function resolveExternalServer(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: Array<{ name: string; value: string }> } | null {
  if (reg.transport.kind !== "stdio") return null;
  const readiness = checkExternalStdioReadiness(reg, env);
  if (!readiness.ok) return null;

  const command = interpolateEnv(reg.transport.command, env);
  const args = reg.transport.args.map((arg) => interpolateEnv(arg, env));

  const serverEnv: Array<{ name: string; value: string }> = [];
  for (const ref of reg.transport.envRefs || []) {
    if (FORBIDDEN_EXTERNAL_REFS.has(ref)) continue; // 双保险:安全边界
    const value = env[ref];
    if (value !== undefined && value !== "") {
      serverEnv.push({ name: ref, value });
    }
  }

  return { command, args, env: serverEnv };
}

export type ResolvedExternalHttpServer = {
  url: string;
  headers: Array<{ name: string; value: string }>;
};

/** Resolve an external HTTP MCP URL and its declared secret headers. */
export function resolveExternalHttpServer(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv,
): ResolvedExternalHttpServer | null {
  if (reg.transport.kind !== "http") return null;
  // 注册时已校验；这里再 fail closed，保证直接调用该解析器时也不会把 service scope
  // 作为外部 HTTP 请求的 URL、required ref 或 header 传出。
  if (reg.trustClass === "external-readonly") {
    const refs = [
      ...(reg.transport.headerRefs || []),
      ...(reg.transport.headers || []).map((header) => header.envRef),
      ...(reg.transport.requiredEnvRefs || []),
      ...extractEnvRefs(reg.transport.url),
    ];
    if (refs.some((ref) => FORBIDDEN_EXTERNAL_REFS.has(ref))) return null;
  }
  const required = reg.transport.requiredEnvRefs || [];
  const missing = required.filter((ref) => !env[ref] || env[ref] === "");
  if (missing.length) return null;
  const url = interpolateEnv(reg.transport.url, env);
  if (!url) return null;
  const headers: Array<{ name: string; value: string }> = [];
  for (const ref of reg.transport.headerRefs || []) {
    const value = env[ref];
    if (value) headers.push({ name: "Authorization", value: `Bearer ${value}` });
  }
  for (const header of reg.transport.headers || []) {
    const value = env[header.envRef];
    if (value) headers.push({ name: header.name, value: `${header.prefix || ""}${value}` });
  }
  return { url, headers };
}

/** 调试用:导出安全边界引用集。 */
export function isForbiddenExternalRef(ref: string): boolean {
  return FORBIDDEN_EXTERNAL_REFS.has(ref);
}

export { logger as _registryLogger };
