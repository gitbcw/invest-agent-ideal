# 用户产物库与通用自动化契约

> 状态：WP0 冻结版
>
> 契约版本：`2026-08-05`
>
> Portal 当前生产兼容协议仍为 `2026-07-04`。本文件冻结的是下一版资产/通用自动化协议；在 WP3 完成 Runtime、Relay、Portal 对齐前，不得把本文件中的新命令视为已经上线。

### 独立验收 v2 · 2026-08-06

- 验收范围：`user-asset-library-and-general-automation-tasks.md` 的 WP0-WP8，以及本契约冻结的通用自动化与资产版本语义。
- [auto] Runtime 全量验证：通过。`npm run verify` exit 0，381 tests / 17 suites 通过，包含数据库 migration、MCP/connector scope、资产版本、通用 runner、推送回写和旧任务迁移测试。
- [auto] Portal 构建验证：通过。`npm test` 20/20、`npm run typecheck` 和 `npm run build` 均 exit 0。
- [checklist] 三元 scope、受控版本存储、不可变历史版本、MCP 确认边界、connector 脱敏和通用任务输出：通过。独立代码检查与对应自动测试均有证据。
- [checklist] WP7 迁移后可持续运行：不通过。`src/services/automation-task-migration.ts:60` 将迁移瞬间的 head 写入 immutable revision 的 `output.expectedVersionId`；`src/services/generic-automation-runner.ts:204` 优先使用该固定值，`src/services/generic-automation-runner.ts:332` 每次提交都以其作 optimistic-concurrency 条件。第一次成功提交后 asset head 改变，下一次运行必然得到 `ASSET_VERSION_CONFLICT`，不能持续维护迁移后的资产。
- [checklist] Portal 可配置完整投递策略：不通过。契约定义的 `wechat_on_condition` 已在 API schema 中存在，但 `src/components/automation/AutomationShell.tsx:47` 和 `:178` 将编辑器状态及请求固定为 `none | wechat_summary`，用户无法在 Portal 创建或编辑条件推送任务。
- [checklist] 已登录 Portal 的真实上传、下载、历史版本恢复交互：无法判定。独立验收浏览器只有登录页，未持有可用测试会话；不使用或猜测用户凭据。现有自动测试覆盖了服务及 connector 合同，但不能替代该 UI smoke。
- 结论：不通过。
- 路由建议：执行问题。先修正 WP7 的 update-head 语义并补“迁移后连续两次成功更新”的隔离测试；随后补齐 Portal 的 `wechat_on_condition` 配置控件、请求映射和交互测试。使用授权隔离账号补上传、下载、v2 恢复和手动运行跳转对话的浏览器 smoke 后重新验收。

本文件是 `user-asset-library-and-general-automation-design.md` 与 WP0 任务的执行基线。下游实现必须按本文件实现；发现冲突时先停在契约评审，不得在 schema、MCP、connector、Portal 各自解释。

关键词 `MUST`、`MUST NOT`、`SHOULD` 和 `MAY` 分别表示必须、禁止、建议和可选。所有时间使用 ISO-8601；任务调度和用户界面使用北京时间 `Asia/Shanghai`。

## 1. 冻结范围

本期冻结以下公共语义：

- `asset`、`asset version`、自动化绑定、`task`、`task revision`、`run` 的 descriptor 和字段归属。
- 资产、版本、任务、运行的状态机。
- `(userId, instanceId, projectId)` scope、Portal connector 注册 scope、MCP/ACP 权限边界。
- 首期格式、canonical MIME、上传/预览/下载/自动化 create/update 上限和校验规则。
- 版本提交、恢复、归档、幂等、并发、lease、失败回滚和审计语义。
- `conversation_artifacts`、`automation_task_assets`、Workspace 文件协议和旧 Portal artifact 命令的兼容边界。

本期不授权：修改生产 SQLite、真实 Workspace、真实微信状态、现有代码/schema/UI，或批量迁移真实用户资产和旧任务。

## 2. Scope 与权限

### 2.1 规范 scope

所有新资产和通用自动化资源的唯一授权 scope 是：

```ts
interface ResourceScope {
  userId: string;
  instanceId: string;
  projectId: string;
}
```

三项必须同时匹配。`assistantId` 是 connector 路由和对话归属字段，不替代上述三元 scope；它可记录在 provenance，但不是资产跨实例授权条件。

- Portal relay 发送新命令时，scope 取 connector 注册时的 `userId`、`instanceId`、`projectId`。
- 新命令 payload 不得声明 scope；若携带 `userId`、`assistantId`、`instanceId` 或 `projectId`，服务必须拒绝 `INVALID_REQUEST`，不得使用 payload 覆盖注册值。
- MCP/ACP 读取 `ServiceToolContext` 的 scope。`workspacePath`、Skill 文本、提示词和用户输入都不能授予额外权限。
- 任务运行只有任务 revision 中声明的输入版本、输出模式和目标资产权限。启用任务是对该声明的持久化授权，不是任意服务写权限。
- 普通对话保存长期资产必须有明确用户意图，并由 Portal 操作或服务确认绑定；后台任务只可提交自己 revision 声明的输出。
- 任何只知道 `assetId`、`versionId`、`taskId`、`runId` 或路径的请求，都不能跨 scope 读取、预览、下载、更新、恢复、归档、运行或写 telemetry。

### 2.2 权限矩阵

| 主体 | 允许 | 禁止 |
| --- | --- | --- |
| 当前 scope 的用户/Portal | 查看、预览、下载 active/archived 资产；上传；重命名；归档；恢复历史版本；创建/编辑/启停自己的任务；查看自己的运行和引用 | 访问其他 scope；提交任意 Workspace 路径；修改不可变历史版本；用上传覆盖而不提供期望 head |
| 普通对话 ACP | 读取当前对话明确绑定的资产版本；在确认后保存当前生成物为资产版本 | 按路径浏览资产库；绕过确认长期保存；修改资产或投资确定性状态；读取未绑定资产 |
| 已启用任务 runner | 读取 revision 绑定的实际输入版本；按 output policy 创建一个资产或提交目标资产新版本；写运行/投递审计 | 改变任务定义；访问未绑定资产；改变其他资产 head；调用任意 shell/webhook；修改持仓、规则、策略、配置 |
| 服务/MCP/connector | 强制 scope、校验、租约、审计、原子提交和投递 | 把 Skill/提示词当作安全边界；把裸路径传给 Portal 或 ACP |
| 架构/运维迁移工具 | 仅在隔离 fixture 或逐任务、备份、可回退流程中运行 | 自动迁移真实 Workspace、批量覆盖或删除旧任务资产 |

scope 不匹配的已存在资源统一返回域错误而不是成功降级；Portal HTTP 映射为 `403`。未知资源返回 `404`。

## 3. Descriptor

### 3.1 Asset descriptor

资产是稳定的逻辑对象；重命名、归档和新增版本都不改变 `assetId`。

```ts
type AssetStatus = "active" | "archived";
type AssetFormat =
  | "markdown" | "html" | "csv" | "xlsx" | "pdf"
  | "png" | "jpeg" | "webp" | "svg";

interface AssetDescriptor {
  assetId: string;
  name: string;                 // 1..200 个 Unicode 字符；用户可见
  status: AssetStatus;
  currentVersionId: string;    // active/archived 资产都必须有 head
  currentVersionNumber: number;
  format: AssetFormat;         // currentVersion 的 canonical format
  mimeType: string;             // currentVersion 的 canonical MIME
  sizeBytes: number;            // currentVersion 的字节数
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  // Portal/connector response 不返回以下内部字段：
  // userId, instanceId, projectId, absolutePath, storageKey, workspacePath
}
```

服务内部行必须带完整 `ResourceScope`。Portal 可以展示来源摘要和引用数量，但不得泄露内部 Workspace 路径、staging 路径、绝对路径、Skill、日志或调试文件。

### 3.2 Asset version descriptor

版本是不可变内容快照。版本号在单个 asset 内从 `1` 递增；`versionId` 是跨请求使用的 opaque ID。

```ts
type AssetVersionSource = "upload" | "conversation" | "automation" | "restore" | "system";

interface AssetVersionDescriptor {
  versionId: string;
  assetId: string;
  versionNumber: number;
  fileName: string;             // 仅 basename，最长 255；服务重新校验
  format: AssetFormat;
  mimeType: string;             // canonical MIME
  sizeBytes: number;
  checksum: string;              // sha256 lowercase hex, 64 chars
  source: AssetVersionSource;
  sourceRef?: {
    conversationId?: string;
    taskId?: string;
    runId?: string;
    parentVersionId?: string;   // restore 必填
  };
  createdAt: string;
  // 服务内部保存相对存储 key；不作为 Portal 请求参数返回。
}
```

`source` 与 `sourceRef` 的约束：`upload` 可无 ref；`conversation` 必须绑定当前 conversation/turn；`automation` 必须同时绑定 task revision 和 run；`restore` 必须绑定被恢复的版本；`system` 仅用于受控 backfill/repair。版本来源不能由模型自由填写，服务根据调用入口写入。

### 3.3 Automation task descriptor

任务定义是版本化的；对已有任务的编辑永远插入新 revision，不原地修改历史 revision。

```ts
type TaskStatus = "paused" | "active" | "needs_attention" | "archived";
type VersionPolicy = "latest" | "fixed";

interface AssetBinding {
  assetId: string;
  role: "input" | "update_target";
  versionPolicy: VersionPolicy;
  versionId?: string;         // fixed 必填；latest 禁止携带
}

interface TaskSchedule {
  frequency: "daily" | "weekdays" | "weekly";
  time: string;               // HH:mm
  timezone: "Asia/Shanghai";
  weekdays?: number[];        // Sunday=0 ... Saturday=6；weekly 必填
}

type OutputPolicy =
  | { mode: "none" }
  | { mode: "create"; format: AssetFormat; fileName: string; titleTemplate?: string }
  | { mode: "update"; assetId: string; versionPolicy: "latest"; expectedVersionId?: string };

type DeliveryPolicy =
  | { mode: "none" }
  | { mode: "wechat_summary" }
  | { mode: "wechat_on_condition"; conditionVersion: 1 };

interface AutomationTaskRevisionDescriptor {
  revisionId: string;
  taskId: string;
  revision: number;
  name: string;
  description?: string | null;
  instruction: string;         // 1..12,000 个字符
  schedule: TaskSchedule;
  inputs: AssetBinding[];      // 0..8；可为空
  output: OutputPolicy;        // 每次最多一个新/更新资产
  delivery: DeliveryPolicy;
  createdAt: string;
}

interface AutomationTaskDescriptor {
  taskId: string;
  status: TaskStatus;
  currentRevisionId: string;
  currentRevision: number;
  revision: AutomationTaskRevisionDescriptor;
  nextRunAt?: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}
```

`output.mode = "none"` 且 `inputs = []` 是合法任务，适用于仅推送或仅记录结果的任务。`wechat_on_condition` 只接受结构化结果中的 `shouldNotify: boolean` 和受长度限制的 `summary`，自由文本不得触发推送。

### 3.4 Automation run descriptor

运行记录实际使用的输入版本和输出版本，不能只保存“latest”这个解析策略。

```ts
type RunOrigin = "manual" | "scheduled";
type RunStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";

interface AutomationRunInput {
  assetId: string;
  versionId: string;
}

interface AutomationRunOutput {
  assetId: string;
  versionId: string;
}

interface AutomationRunDescriptor {
  runId: string;
  taskId: string;
  revisionId: string;
  origin: RunOrigin;
  idempotencyKey: string;
  attempt: number;
  status: RunStatus;
  inputs: AutomationRunInput[];
  outputs: AutomationRunOutput[];
  resultSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  delivery?: { status: "not_requested" | "pending" | "sent" | "suppressed" | "failed"; pushJobId?: string };
  conversationId?: string | null; // manual run/continue-in-chat
  lease: { token: string; expiresAt: string };
  claimedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

运行 descriptor 中的 `inputs`、`outputs` 是新协议的权威字段。旧表格任务可继续返回 `inputAssetId`、`outputAssetId`，由兼容 adapter 映射为单项引用；新任务不得依赖旧字段。

### 3.5 字段 owner、来源与兼容策略

| 字段/语义 | owner | 来源 | 兼容策略 |
| --- | --- | --- | --- |
| `assetId`/`versionId`/`taskId`/`runId` | 服务 | 服务生成 opaque ID | 不能由 Portal/ACP 指定或跨 scope 复用 |
| scope 三元组 | 服务/connector/MCP | connector 注册或 MCP context | payload scope 永不覆盖；旧命令保持旧协议行为 |
| `name`、`description`、`instruction` | 服务校验，用户提供 | Portal 表单或已确认对话输入 | revision 保存完整快照；历史 revision 不变 |
| `format`、`mimeType`、`sizeBytes`、`checksum` | 服务 | 文件名提示 + 内容校验 + 服务计算 | 客户端声明不具权威；canonical MIME 返回 |
| `source`、`sourceRef` | 服务 | 调用入口、当前 turn/task/run | 禁止模型自由伪造；旧 artifact provenance 不改写 |
| `currentVersionId`/head | 服务 SQLite | 成功版本提交事务 | 只有成功提交可推进；失败不改变 |
| schedule/output/delivery | 服务 | 任务 revision 请求 | update 生成新 paused revision；旧 revision 可重放 |
| `inputs`/`outputs` | 绑定服务/runner | revision 绑定和运行提交 | 运行落地实际 versionId；不以裸路径替代 |
| lease、幂等键、审计 | 服务 | claim/commit/delivery | requestId 仅传输关联，不替代持久幂等键 |

## 4. 状态机

### 4.1 Asset 与 version

```text
asset:   active --asset.archive--> archived
         active --asset.upload(existing asset)--> active (new head)
         archived --read-only--> archived

version submission (internal only): staging -> committed
                                      staging -> rejected/aborted
committed is immutable; failed/rejected/aborted is never visible as a version.
```

- 新上传先创建 `active` asset 和 v1；创建 asset 与初始版本必须在同一服务操作中完成。
- `asset.upload` 带已有 `assetId` 时，必须同时提供 `expectedVersionId` 和幂等键；它是显式新增版本，不是覆盖旧版本。
- 归档是软删除：不物理删除字节、不删除版本、不删除引用和审计。归档 asset 默认不在列表和新任务选择器出现。
- 归档 asset 仍允许 `asset.get`、历史版本列表、预览和下载，禁止新绑定、新上传版本、自动化 update 和 `restore_version`。首期没有硬删除和 Portal 取消归档命令。
- 版本恢复不会把旧版本改成 current，而是复制并校验被恢复内容，创建新的 `source=restore` 版本并推进 head。

### 4.2 Task

```text
create        -> paused
paused        -> active              (activate)
active        -> paused              (pause)
active        -> needs_attention     (连续 3 次 failed)
needs_attention -> paused            (pause 或人工处理后暂停)
needs_attention -> active            (显式 activate)
paused|active|needs_attention -> archived (受控归档入口；首期 Portal 不提供)
archived      -> terminal/read-only

update(active|paused|needs_attention) -> new revision + paused
```

- 计划运行只拾取 `active`；手动运行可在 `paused`、`active`、`needs_attention` 执行，不能运行 `archived`。
- update 不会保留旧的 active 状态，必须再次 activate；期望 revision 不匹配返回冲突。
- failed 累加 `consecutiveFailures`；成功/跳过/取消清零。`needs_attention` 的成功手动运行不会静默重新启用计划，服务将其保持为 `paused`，等待显式 activate。
- 首期不实现任务删除、任务跨任务编排、多输出 fan-out、任意 cron、webhook 或执行任意服务写操作。

### 4.3 Run

```text
claim -> running -> succeeded
              \-> failed
              \-> skipped
              \-> cancelled
```

- `queued` 不作为持久状态；未 claim 的计划项只存在于 scheduler 的 due 查询中。
- ACP、格式校验、scope、lease、提交前任一失败都进入 `failed`，不产生可见输出版本。
- lease 过期由服务回收为 `failed`，错误码为 `AUTOMATION_RUN_LEASE_LOST` 或内部过期原因；旧进程不能继续 finish。
- 输出版本提交、run 成功标记和 head 推进必须由服务在同一逻辑提交闭环中完成；推送失败只改变 delivery 状态，不重新执行 ACP 或重新生成版本。
- manual run 创建专用 Portal conversation；scheduled run 不污染普通 conversation。`continue_in_chat` 新建对话，只带运行摘要和只读版本引用，不恢复后台上下文、不自动再次写入。

## 5. 格式、MIME 与大小矩阵

### 5.0 配额与上传边界（2026-08-06）

- 单个用户文件原始字节上限为 `10 MiB`；一次上传请求的原始文件合计上限为 `20 MiB`，服务端按解码后的字节计算。
- 每个 `(userId, instanceId, projectId)` scope 的长期资产版本实际字节总量上限为 `200 MiB`。所有保留版本均计费，归档不释放空间；临时聊天附件、staging、缩略图和预览缓存不计费。
- `asset.list` 返回可选的 `storageUsage: { usedBytes, reservedBytes, limitBytes, availableBytes }`；超限统一返回 `USER_STORAGE_QUOTA_EXCEEDED`，并携带 `limitBytes`、`usedBytes`、`requestedBytes`。
- 聊天附件只有显式“保存到我的文件”才创建 `conversation` 来源资产；自动化声明保存的输出按同一配额计费。
- 图片 `<=1 MiB` 原样保存；大于 `1 MiB` 才进入服务端 normalization，最终 canonical MIME/大小仍须满足 `<=10 MiB`。
- 发布前可运行 `npm run storage:reconcile` 生成只读 usage 审计报告；该命令不回填、不移动或改写旧报告和真实 Workspace。

大小按原始字节计，`MiB = 1,048,576 bytes`。所有上传、恢复和自动化输出都经过同一服务校验；扩展名和客户端 MIME 只是输入提示。

| format | accepted extension | canonical MIME | upload/store | preview | download | automation create | automation update |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `markdown` | `.md`, `.markdown` | `text/markdown` | <= 10 MiB；UTF-8、无 NUL | 允许，<= 10 MiB | 允许，<= 10 MiB | 允许，完整 Markdown 替换 | 允许，仅完整替换生成 |
| `html` | `.html`, `.htm` | `text/html` | <= 10 MiB；静态文档校验 | 允许，隔离 sandbox；不得同源执行 | 允许，<= 10 MiB | 允许，静态新产物 | 禁止 |
| `csv` | `.csv` | `text/csv` | <= 10 MiB；UTF-8、无 NUL、引号结构完整 | 允许表格预览 <= 10 MiB | 允许，<= 10 MiB | 允许，服务校验结构化 CSV | 允许，仅结构化行/列维护 |
| `xlsx` | `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | <= 10 MiB；OOXML/ExcelJS 可读且至少一个 sheet | 首期禁止 inline 预览，显示 download-only | 允许，<= 10 MiB | 允许，必须生成可读工作簿 | 允许，仅结构化 workbook/cell/row 维护 |
| `pdf` | `.pdf` | `application/pdf` | <= 10 MiB；PDF magic bytes | 首期 download-only，不承诺浏览器 PDF 渲染 | 允许，<= 10 MiB | 允许，作为新文件 | 禁止 |
| `png` | `.png` | `image/png` | <= 10 MiB；PNG magic bytes | 允许图片预览 | 允许，<= 10 MiB | 允许，作为新文件 | 禁止 |
| `jpeg` | `.jpg`, `.jpeg` | `image/jpeg` | <= 10 MiB；JPEG magic bytes | 允许图片预览 | 允许，<= 10 MiB | 允许，作为新文件 | 禁止 |
| `webp` | `.webp` | `image/webp` | <= 10 MiB；RIFF/WEBP magic bytes | 允许图片预览 | 允许，<= 10 MiB | 允许，作为新文件 | 禁止 |
| `svg` | `.svg` | `image/svg+xml` | <= 10 MiB；UTF-8、XML 文本、服务 sanitizer 通过 | 允许，服务清洗后隔离呈现 | 允许，<= 10 MiB | 允许，必须通过 sanitizer | 禁止 |

规则补充：

- response 永远返回 canonical MIME。CSV 输入可兼容 `text/plain` 或 `application/csv`，但扩展名、内容和最终 MIME 必须是 `text/csv`；`application/octet-stream` 不能单独证明格式。XLSX 不接受其他 MIME 别名。
- Markdown/HTML/CSV/SVG 必须是有效 UTF-8；文本包含 NUL、二进制 magic 或无法完成安全校验时拒绝。PNG/JPEG/WebP/PDF 必须 magic bytes 与 MIME 一致。
- `preview` 是受控服务能力，不等于把原始 HTML/SVG 当同源 DOM 执行。HTML 使用隔离 sandbox；SVG 先 sanitizer，再以静态资源呈现。
- `download` 返回经过 scope、路径、大小、checksum 校验的字节；不返回绝对路径。
- `create` 是自动化的“创建新资产/新版本”能力，不允许模型指定物理路径。`update` 的允许性只按本表，且 Markdown 必须完整替换、CSV/XLSX 必须结构化维护。
- `asset.get`/`asset.versions.list` 总是允许返回安全元数据；不支持 preview 的格式仍可安全下载。

### 5.1 首期排除格式

资产库首期拒绝并返回 `ASSET_UNSUPPORTED_FORMAT`：TXT、JSON、YAML、JSONL、TSV、CSS、JS/TS、Python/其他源码、GIF、TIFF、BMP、DOC/DOCX、PPT/PPTX、ODS、ZIP/RAR/7z、数据库文件、音频、视频、可执行文件、未知扩展名以及任何仅靠客户端 MIME 声明的格式。

这不删除旧 Workspace/artifact 对这些格式的既有只读兼容；它们不能通过 `asset.upload` 进入用户产物库，也不能作为首期通用任务的 output `create/update`。

## 6. 操作与提交语义

### 6.1 Asset 命令

首期新 connector 命令固定为：

```text
asset.list
asset.get
asset.version.get
asset.versions.list
asset.upload
asset.rename
asset.archive
asset.restore_version
asset.references.list
```

约束：

- `asset.list` 默认 active，可显式 `status=active|archived|all`；搜索/格式/来源筛选只作用于安全元数据。不会列出 Workspace 目录。
- `asset.get` 返回 asset descriptor 和 current version descriptor；`asset.version.get` 返回指定版本的元数据，按 `mode=preview|download` 决定是否返回字节。
- `asset.upload` 无 `assetId` 创建 v1；带 `assetId` 必须 active、带 `expectedVersionId`，创建新版本。禁止隐式覆盖和直接写 Workspace。
- `asset.rename` 只改变逻辑资产名称，不创建版本、不改变 checksum/fileName；仅 active 资产可改名，幂等重放返回相同 descriptor。
- `asset.archive` 只做 active -> archived 软归档；不删除历史字节、引用、审计。首期不提供硬删除/取消归档。
- `asset.restore_version` 只对 active 资产可用；必须指定同 scope 的 `versionId`，创建新的 restore 版本。它不是把 head 指针回拨。
- `asset.references.list` 返回同 scope 的任务 revision、run、conversation 关联摘要，不返回其他用户、绝对路径或内部 prompt。

### 6.2 Version submit

所有新版本，无论来源是 upload、conversation、automation 或 restore，都经过同一 `submitVersion` 语义：

1. 服务根据注册 scope 和 resource ID 读取目标；不接受绝对路径或用户提供的 storage key。
2. 在当前用户 Workspace 的受控 staging 下写入临时 bytes，staging 不属于 Workspace 浏览器可见面。
3. 校验文件名 basename、格式/MIME、大小、内容结构、路径真实位置和 checksum；校验失败清理 staging，写失败审计，不创建可见版本。
4. 将 staging 文件移动到 `assets/<assetId>/versions/<versionId>/<safe-file-name>`；禁止 symlink、绝对路径、`.`、`..`、空 path segment 和跨 Workspace 引用。
5. 在 SQLite 事务中插入不可变 version、更新 asset head、写 provenance/audit；目标 head 与 `expectedVersionId` 不匹配则整次提交失败。
6. DB 事务失败时清理新文件并保持旧 head；若出现无法即时清理的 orphan，只能由服务 repair job 处理，不能通过 Portal 可见。

`versionId`、`versionNumber`、checksum 和 fileName 在提交后不可修改。内容相同也必须通过幂等键判断；不同幂等键会产生不同版本，除非业务操作是恢复且服务明确记录 `parentVersionId`。

### 6.3 Restore 与 archive

- restore 是复制内容的新提交，`source=restore`，`parentVersionId` 指向历史版本；旧版本和旧 head 不变，成功后新版本成为 head。
- restore 必须校验目标 asset active、历史 version 同 scope 且未损坏；历史文件缺失或 checksum 不一致返回 `ASSET_CHECKSUM_MISMATCH`，不推进 head。
- archive 是状态写入，不创建 version。重复 archive 是幂等成功；在归档状态上进行 upload(existing)、restore 或 automation update 返回 `ASSET_ARCHIVED`。

### 6.4 Automation output commit

- `none`：只保存 run 摘要和 delivery 结果；`outputs=[]`。
- `create`：每次成功 run 最多创建一个新的逻辑 asset 和 v1，或在任务明确声明的 collection 语义下创建一个新资产；本期不做多输出 collection，故实际只允许一个。
- `update`：目标 asset 必须 active、同 scope，目标格式必须按矩阵支持；run claim 时解析当前版本，commit 时再次用 `expectedVersionId` 检查，冲突返回 `ASSET_VERSION_CONFLICT`，旧 head 保持不变。
- ACP 必须返回结构化 staged output descriptor（format、MIME、fileName、bytes/staging token、summary、condition）；普通文本不能冒充成功文件。
- 版本 commit 成功前，run 不能标记 `succeeded`；commit 成功后 delivery 可以独立失败和重试，不得重新执行 ACP 或生成第二个版本。

## 7. 幂等、并发与 lease

### 7.1 幂等键

- 所有资源写操作和 run claim 使用调用方提供的 `idempotencyKey`；trim 后长度 `1..500`。Portal `requestId` 只在未提供 run key 时作为 connector 兼容默认值，并不跨不同业务入口复用。
- 幂等键在 `(scope, operation, target)` 内生效。服务保存规范化请求 fingerprint。
- 同一 key + 同一 fingerprint：返回首次成功/当前进行中的同一结果，不新建 asset、version、run、push job。
- 同一 key + 不同 fingerprint：返回 `ASSET_IDEMPOTENCY_CONFLICT`、`AUTOMATION_RUN_IDEMPOTENCY_CONFLICT` 或相应域错误，绝不覆盖旧请求。
- 运行 lease 过期后的恢复尝试保留原始 key 的逻辑关联，但 stale attempt 使用内部 archive key；新 attempt 递增 `attempt`，最终查询原 key 返回最新 attempt 和历史关联。

### 7.2 Task mutex 与 lease

- 同一 scope、同一 task 同时最多一个 `running` run；不同 origin（manual/scheduled）也不能重叠。
- claim 持久化 `runId`、随机 `leaseToken`、`leaseExpiresAt` 和 `attempt`。默认 lease 为 15 分钟，服务可通过受控配置改变，但必须有上限并在 descriptor/audit 中记录实际到期时间。
- 服务可在 ACP 正常工作时内部续租；续租必须校验原 token。Portal/ACP 不得自行延长或伪造 lease。
- 失去 lease、token 不匹配、任务锁被其他 attempt 接管或目标 head 已变化，都禁止提交版本和 finish 成功，返回可重试 `AUTOMATION_RUN_LEASE_LOST` 或 `ASSET_VERSION_CONFLICT`。
- stale runner 即使稍后返回，也不能清除新 attempt 的 lock、head 或 run 状态；token 是 fencing boundary。
- 同 key 的 in-flight replay 返回原 run；不同 key 在有效 run 存在时返回可重试 `AUTOMATION_TASK_BUSY`，不排队、不重复执行。

## 8. Error code

Envelope 继续使用：

```ts
interface PortalError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

新错误码冻结如下；HTTP 映射仅适用于未来的 authenticated asset routes，WebSocket 仍通过 envelope 返回同一 code。

| code | HTTP | retryable | 语义 |
| --- | ---: | :---: | --- |
| `INVALID_REQUEST` | 400 | no | 缺字段、未知字段、payload 形状错误 |
| `PROTOCOL_VERSION_UNSUPPORTED` | 400 | no | 双方未协商到同一协议版本 |
| `ASSET_INVALID_SCOPE` | 400 | no | scope/context 不完整或非法 |
| `ASSET_SCOPE_MISMATCH` | 403 | no | 资源存在但不属于当前 scope |
| `ASSET_NOT_FOUND` | 404 | no | 当前 scope 不存在该 asset/version |
| `ASSET_ARCHIVED` | 409 | no | 需要 active 资产的写操作命中了 archived |
| `ASSET_INVALID_NAME` | 422 | no | 名称为空或超过 200 |
| `ASSET_INVALID_PATH` | 400 | no | 文件名含路径、绝对路径、`.`/`..` 或非法字符 |
| `ASSET_UNSUPPORTED_FORMAT` | 415 | no | 首期白名单之外的格式 |
| `ASSET_MIME_MISMATCH` | 415 | no | 扩展名、声明 MIME、内容 magic 不一致 |
| `ASSET_TOO_LARGE` | 413 | no | 超出格式或 preview 上限 |
| `ASSET_INVALID_CONTENT` | 422 | no | UTF-8、CSV、XLSX、HTML、SVG 等结构校验失败 |
| `ASSET_PREVIEW_UNSUPPORTED` | 422 | no | 格式只允许 download，不允许 preview |
| `ASSET_PREVIEW_UNSAFE` | 422 | no | 预览 sanitizer/sandbox 校验失败；download 可独立尝试 |
| `ASSET_CHECKSUM_MISMATCH` | 422 | no | 字节与 descriptor checksum 不一致 |
| `ASSET_VERSION_CONFLICT` | 409 | yes | expected head 与当前 head 不一致 |
| `ASSET_IDEMPOTENCY_CONFLICT` | 409 | no | 同 key 请求 fingerprint 不一致 |
| `ASSET_SUBMISSION_FAILED` | 500 | yes | staging/DB 提交失败且未推进 head |
| `AUTOMATION_INVALID_SCOPE` | 400 | no | 任务 scope 非法 |
| `AUTOMATION_SCOPE_MISMATCH` | 403 | no | 任务、revision、run、旧 asset 跨 scope |
| `AUTOMATION_TASK_NOT_FOUND` | 404 | no | 任务不存在 |
| `AUTOMATION_TASK_ARCHIVED` | 409 | no | archived 任务禁止写/运行 |
| `AUTOMATION_TASK_BUSY` | 409 | yes | 同任务已有有效运行 |
| `AUTOMATION_INVALID_SCHEDULE` | 422 | no | 非法频率、时间、weekdays 或时区 |
| `AUTOMATION_INVALID_OUTPUT_POLICY` | 422 | no | output/delivery 与格式或绑定不匹配 |
| `AUTOMATION_ASSET_BINDING_INVALID` | 422 | no | 输入/目标资产不存在、不 active、版本策略非法 |
| `AUTOMATION_RUN_NOT_FOUND` | 404 | no | run 不存在 |
| `AUTOMATION_RUN_IDEMPOTENCY_CONFLICT` | 409 | no | 同 key 的 revision/origin/target 不同 |
| `AUTOMATION_RUN_ALREADY_FINISHED` | 409 | no | 已结束 run 被不同状态再次 finish |
| `AUTOMATION_RUN_LEASE_LOST` | 409 | yes | lease 过期、token fencing 或 stale attempt |
| `AUTOMATION_RUN_INVALID_RESULT` | 422 | no | ACP 没有合法结构化结果或输出 |
| `AUTOMATION_DELIVERY_FAILED` | 502 | yes | 资产已提交但投递失败；只重试 delivery |
| `CONCURRENT_TASK_LIMIT` | 429 | yes | connector/assistant 并发上限 |

现有域错误必须继续可识别：旧 automation 的 `AUTOMATION_ASSET_REQUIRED`、`AUTOMATION_ASSET_UNSUPPORTED_TYPE`、`AUTOMATION_ASSET_TOO_LARGE`、`AUTOMATION_ASSET_MIME_MISMATCH`、`AUTOMATION_ASSET_INVALID_CONTENT`、`AUTOMATION_ASSET_SOURCE_IMMUTABLE`、`AUTOMATION_ASSET_CHECKSUM_MISMATCH`、`AUTOMATION_WORKSPACE_NOT_FOUND`、`AUTOMATION_DATA_CORRUPT`，以及旧 artifact 的 `ARTIFACT_INVALID_PATH`、`ARTIFACT_NOT_FOUND`、`ARTIFACT_UNSUPPORTED`、`ARTIFACT_TOO_LARGE`、`ARTIFACT_UNSAFE`、`ARTIFACT_SCOPE_MISMATCH`、`ARTIFACT_EXPIRED`、`ARTIFACT_DELETED`、`ARTIFACT_INVALID_CURSOR`。它们只用于兼容面，不与新 asset code 混用。

## 9. Runtime 与 Portal 协议变更清单

### 9.1 Envelope 与 commands

目标版本 `2026-08-05` 保持现有 `PortalEnvelope`/`PortalResponse` 字段和 request/response `requestId` 关联，新增：

```text
asset.list
asset.get
asset.version.get
asset.versions.list
asset.upload
asset.rename
asset.archive
asset.restore_version
asset.references.list
```

现有 `automation.list/get/create/update/activate/pause/run_now/runs.list/run.get/continue_in_chat` 在目标版本返回新 task/revision/run descriptor；`automation.asset.get` 仅继续服务旧 `automation_task_assets`，不作为新资产读取面。

目标版本的自动化 payload 固定为：

- `automation.create`：`name`、`description?`、`instruction`、`schedule`、`inputs?`、`output`、`delivery`；`inputs=[]` 和 `output.mode=none` 合法。
- `automation.update`：`taskId`、`expectedRevision?` 加上述可变字段；永远创建新 paused revision。
- `automation.run_now`：`taskId`、`idempotencyKey?`；不接受路径、scope 或任意输出目标。
- `automation.continue_in_chat`：`runId`；只返回新 conversation 和只读引用。

旧 `sourceAsset`/`asset` payload 仅由兼容 adapter 送入旧任务模式；不得把它静默解释成新 output policy。

### 9.2 Conversation/MCP type changes

- 既有 `ConversationArtifactPayload` 增加可选 `assetId`、`versionId`、`assetStatus` 时必须保持旧字段和旧 base64 行为；旧客户端忽略新增可选字段即可。
- MCP 文件工具包括 `assets.list`、`assets.version.read`、`assets.version.commit`、`assets.conversation.save`、`assets.rename`、`assets.archive` 和 `assets.delete`。它们只接收 asset/version ID、受控字节和结构化 descriptor，不接收绝对路径。
- 普通对话可列出、读取、创建、更新、重命名和归档当前 user/project/instance scope 内的资产；版本提交仍推荐携带 `expectedVersionId` 以维持 compare-and-swap。定时自动化可列出和读取同 scope 资产，但写入仍限本次任务声明的附件或新建产物；归档和删除不向定时任务开放。
- `assets.delete` 永远需要由 `confirmations.request` 创建、并绑定当前对话与精确 assetId 的明确确认；删除未成功时不得声称已删除。
- `artifacts.publish` 继续是旧 Workspace artifact 发布工具，不得作为新资产库写入的隐式后门。
- MCP 返回错误必须保留稳定 code；普通对话不得在 `assets.conversation.save` 未成功时声称已保存。

### 9.3 Audit/provenance

asset upload/rename/archive/restore/version commit、task revision、run claim/finish、asset read/download/preview、delivery retry 都必须记录 scope、资源 ID、source、结果 code、checksum/size（不记录文件正文和绝对路径）。

## 10. 兼容矩阵

### 10.1 `conversation_artifacts`

| 现有入口/字段 | 现状与保持内容 | 与新 asset 的关系 |
| --- | --- | --- |
| `conversation_artifacts` 行 | 保留既有 `artifactId`、对话绑定、source、kind、previewMode、relativePath、retention 字段；不就地改成 asset/version | 可选 additive 关联 `assetId`/`versionId`；关联不改变旧 artifact 生命周期 |
| `artifact.get` | 继续按 `userId + instanceId` 读已登记 artifact，返回 base64、checksum、sanitized；绝对路径不返回 | 不读取新资产；新资产走 `asset.version.get` |
| `artifact.library.list` | 继续是 reports 虚拟库，不是 Workspace 全树；既有 cursor/limit/curated directory/<=1 MiB durable 规则保持 | 不能 alias 为 `asset.list`；新资产不自动进入旧 library |
| `artifact.publish.legacy` | 继续只接受受控 `reports/...` 相对路径，注册 legacy artifact；不创建 user asset | 旧报告链接不变；新长期产物不得用此命令替代正式保存 |
| `artifact.event` | `open/success/failure/download` telemetry 保持；scope 校验保持 | 未来可增加 asset 事件，但不把 artifact event 当版本提交 |
| `reviews.save` / `artifacts.publish` | 日/周/月复盘路径、推送、artifact 返回和确认语义保持 | 后续将复盘纳入 asset 需另立迁移决策；本期不自动提升 |
| retention | 旧 artifact 的 durable library <=1 MiB、transient generated 7 天、attachment 7 天 TTL 保持 | 对话附件不是资产库来源；资产库版本使用自己的 archive/retention 设计 |

### 10.2 `automation_task_assets`

| 现有入口/数据 | 兼容承诺 | 新模型边界 |
| --- | --- | --- |
| `automation_task_assets` | 保留 `source`/`working` role、`automations/<task-id>/source|working/` 相对路径、checksum、CSV/XLSX 结构校验和默认 25 MiB 上限 | 旧 task 继续走旧 runner；新 generic task 不新增这类私有文件 |
| `automation_task_revisions.sourceAssetId/workingAssetId` | 历史 revision 可读、运行和下载行为不变；source 不可覆盖，working 由服务原子替换 | 新 revision 使用 `inputs`/`output` 资产绑定；不得读取时静默迁移 |
| `automation.create/update` 的旧 payload | `sourceAsset`/`asset` 仍可创建或替换旧任务文件；create 当前强制 source，返回 paused | 目标协议允许无输入任务；旧 payload 只进入 legacy adapter |
| `automation.asset.get` | 继续返回旧任务 asset descriptor/base64，按旧 scope 校验 | 新 user asset 用 `asset.version.get` |
| 逐任务迁移 | 只能显式、备份、校验、写迁移审计并以 paused 新 revision 交付；失败回退旧 revision | 禁止批量迁移真实用户或删除旧 source/working |

### 10.3 Workspace 文件协议

| 入口 | 兼容语义 | 新资产约束 |
| --- | --- | --- |
| `workspace.file.list` | 仍为无筛选只读列表，最多 5,000 项；不返回绝对路径 | `assets/` 必须从列表排除，防止绕过版本/审计 |
| `workspace.file.get` | 仍只接受 relativePath；拒绝绝对路径、空段、`.`/`..`、symlink、隐藏目录、`.state`、`.trash`、`.git`、缓存/构建/运行目录、凭据；读取上限 15 MiB | `assets/...` 一律 `WORKSPACE_FILE_FORBIDDEN`；资产不得通过此协议读取或写入 |
| `report.asset.get` | 旧报告专用，继续只读 `reports/` 白名单 | 不扩展到 `assets/` |
| Workspace storage | 仍是用户隔离存储面 | 新资产只使用服务生成的 `assets/<assetId>/versions/<versionId>/...`；浏览器不得看到 storage key |

当前 Workspace 协议允许部分旧 MIME（如 YAML、JSON、TXT）作为技术文件浏览；这不等于它们进入资产库白名单。

### 10.4 旧 Portal artifact 路由与协议

| 旧面 | 当前协议/路由 | 保持/迁移策略 |
| --- | --- | --- |
| WebSocket envelope | `protocolVersion = "2026-07-04"`，request/response 复用 requestId/type | 旧命令继续可用；目标新命令使用 `2026-08-05`，不得在旧版本下伪装支持 |
| `artifact.get` | connector scope 下读取 artifact bytes | 保持；新 asset 不回退到 artifact |
| `artifact.library.list` | 仅 `{cursor?, limit?}`；多余字段 `INVALID_REQUEST` | 保持为旧报告库；资产列表使用 `asset.list` |
| `artifact.publish.legacy` | 仅 `reports/...` 相对路径 | 保持旧报告兼容；不得注册新资产 |
| `artifact.event` | open/success/failure/download | 保持 telemetry；版本提交由 asset 服务负责 |
| `report.asset.get` | 旧 `reports/` 白名单读取 | 保持；不承载资产版本 |
| `GET /api/portal/workspace/files` | 本地兼容 HTTP，query scope + 只读列表 | 保持为本地兼容面；云 Portal 不得绕 connector 使用 |
| `GET /api/portal/workspace/file` | 本地兼容 HTTP，relativePath + query scope | 保持旧行为；不增加 asset 写入或 `assets/` 读取 |
| conversation HTTP routes | `/api/portal/conversations*` 仍服务本地兼容调用 | 对话保存资产必须走新受控服务/MCP，不能靠 HTTP body scope 获得新权限 |

## 11. 首期任务边界

首期允许：

- 零输入、`none` 输出、微信摘要/条件推送的任务。
- 读取零至八个同 scope 资产输入，使用运行时最新版本或固定版本。
- 每次运行创建一个 Markdown/HTML/CSV/XLSX/PDF/PNG/JPEG/WebP/SVG 新资产，或更新一个 active CSV/XLSX/Markdown 目标。
- 手动 run 的专用 conversation、计划 run 历史、运行摘要、版本引用、继续对话入口。
- 任务级互斥、幂等 replay、lease recovery、失败不提交和投递独立重试。

首期排除：

- 任意 cron、用户自定义时区、webhook、第三方云盘、共享链接、多人协作、文件夹树、移动/重命名 Workspace 路径。
- 多输出 fan-out、跨任务依赖、任务触发任务、任意 shell、代码执行、任意 URL 抓取、动态工具白名单。
- 任务对持仓、策略、规则、配置、scope、权限、确认状态或其他确定性投资状态的后台写入。
- 旧 `source/working` 自动转资产、真实用户批量迁移、硬删除/物理清理和首期取消归档。
- TXT/JSON/YAML/Office 文档/压缩包/音视频/源码等排除格式的 upload、create、update。

## 12. 不变量与下游验收钩子

下游实现必须能证明：

1. 任意 scope 下 asset head 始终指向一个已校验、checksum 可回读的 committed version。
2. 失败、取消、格式错误、checksum 错误、scope 错误、lease 丢失和 head 冲突都不改变旧 head。
3. 同幂等 key 不产生重复 asset/version/run/push；不同 key 的并发运行不越过 task mutex。
4. 版本历史不可变；restore 总是新版本；archive 不物理删除。
5. Workspace browser、旧 artifact 和旧表格任务的兼容行为不被新资产入口改变。
6. 第二个 user/instance/project 无法读、预览、下载、更新、归档、恢复或引用第一个 scope 的资源。
7. 所有路径均为服务内部生成的相对存储 key；Portal/MCP/ACP 永不接收绝对路径作为业务参数。

### 修复验收 v3 · 2026-08-06

- 修复项 1：迁移任务不再把迁移时的 `expectedVersionId` 固化到新 revision；`latest` 运行基于实际读取到的当前 head 做 CAS 提交。隔离测试已验证迁移任务连续两次运行成功，工作资产从 v1 推进到 v3。
- 修复项 2：Portal 自动化编辑器新增“满足条件时推送”，并提交 `wechat_on_condition` 与 `conditionVersion: 1`；Portal schema 回归测试通过。
- 验证：Runtime `npm run verify` 通过（381 tests / 17 suites）；Portal `npm test` 20/20、`npm run typecheck`、`npm run build` 通过；本地 Runtime 22655 `/health` 返回 `status=ok`。
- 结论：本轮报告的两个 P1 缺陷已修复并通过自动验收。真实登录 Portal 的上传、下载、恢复和立即运行 UI smoke 仍需授权测试账号后补验，不以无会话浏览器结果替代。
