# Workspace 能力扩展协议

本协议约束投资助手如何在自己的隔离 Workspace 内按需扩展能力，以及何时必须停止并提出系统能力申请。

## 设计目标

- 模板保持轻量，用户的投资方法和分析流程可以按需生长。
- Workspace 只修改本用户空间内的资产，不干预 ACP 运行时、MCP、调度器或服务层。
- 所有长期变更先出草案、再由用户确认，并且可审计、可验证、可回滚。
- 只对已经验证的能力使用“已生效”“已创建”“已连接”等表述。

## 两条独立判断

先判断本轮如何帮助用户，再独立判断是否需要建设长期能力。两条判断可以同时成立，不能互相替代。

### 本轮回答覆盖等级

| 覆盖等级 | 处理方式 |
| :--- | :--- |
| `full` | 以已核验口径完成关键范围和字段。 |
| `partial` | 在同一口径下完成已覆盖部分，并说明未覆盖范围。 |
| `proxy` | 使用可解释的替代来源或指标，并明确替代口径。 |
| `representative` | 提供代表性样本或方向，不声称完整排名或扫描。 |
| `framework` | 没有足够动态事实，只给验证框架和待观察条件。 |
| `refuse` | 没有可信证据、用户要求严格对账，或触及产品红线。 |

### 长期能力处理结果

| 分类 | 处理方式 |
| :--- | :--- |
| `no_persistent_change` | 不创建长期能力。 |
| `workspace_extension` | 用户确认后，在当前 Workspace 内新增或修改方法、Skill、配置、模板、schema 或纯计算脚本。 |
| `supported_service_configuration` | 使用当前会话已经挂载的具名 MCP 工具，并遵守该工具的确认、权限和审计契约。 |
| `system_capability_gap` | 记录为长期产品缺口；不在 Workspace 内伪造实现，也不声称已经生效。 |

混合需求必须拆分。例如“新增一个估值分析方法并每天自动执行”：本轮仍先按可核验证据完成分析；估值方法可以是 Workspace 扩展；新的调度任务类型是系统能力缺口。只有服务已经支持对应任务类型时，才可以通过现有配置工具调整时间或开关。

## Workspace 可以扩展的内容

- `AGENTS.md` 中的用户级行为约束。
- `knowledge/` 中的投资方法、证据规则和分析口径。
- `.codex/skills/<skill-name>/SKILL.md` 中的 Codex 原生工作流。
- `config/` 中不冒充服务状态的用户级分析配置。
- `schemas/`、报告模板和 `reports/` 目录结构。
- 只依赖 Workspace 可访问输入的纯计算脚本。

Workspace Skill 必须写入 `.codex/skills/`。旧的 `skills/*/manifest.json` 和 `config/skills.yaml` 只可作为兼容说明目录，不能证明 Codex 已发现 Skill，更不能注册 MCP 工具。

## 系统拥有的能力

以下内容不能由 Workspace 自行安装或修改：

- MCP Server、MCP 工具、工具 schema 和会话挂载配置。
- 新的 scheduler 任务类型、后台 worker、进程、主动推送通道和执行器。
- 服务 API、SQLite 表、持久化写入、权限、确认和审计逻辑。
- 密钥、登录态、付费数据源、外部服务凭据和可信数据适配器。
- 运行时依赖安装、服务构建、部署、重启和跨用户修改。
- `.codex/config.toml`、`mcp.json` 和 Workspace 之外的文件。

缺少上述能力时，禁止通过 shell、localhost HTTP、隐藏接口、直接数据库访问或猜测 token 绕过。先完成不依赖该能力的子任务；普通分析只在末尾简要说明受影响范围。用户明确要求建设方案时，才展示系统能力缺口的实现要求。

## 扩展流程

1. 检查当前 Workspace、`.codex/skills/` 和已挂载的具名 MCP 工具。
2. 将本轮请求拆分为原子子任务，标注每项的证据状态和回答覆盖等级。
3. 判断是否需要持久化；能不持久化就不创建能力，并独立标注长期能力处理结果。
4. 对 Workspace 长期变更输出草案，等待用户明确确认。
5. 只实现用户确认过的 Workspace 部分。
6. 按实际层级验收，不把文件存在等同于运行时生效。
7. 将已确认变更写入 `memory/change_log.jsonl`。

## Workspace 扩展草案

```yaml
extension_name: ""
classification: "workspace_extension"
user_request_summary: ""
proposed_solution: ""
new_files: []
modified_files: []
data_requirements: []
memory_write_impact: []
risk_boundary: []
rollback_plan: []
acceptance_checks: []
confirmation_required: true
```

投资方法、交易规则、提醒规则、复盘逻辑、长期记忆结构和用户级自动化配置发生变化时，必须先展示草案。用户确认前不能落盘。

## 系统能力缺口说明

以下结构仅用于用户明确要求建设方案或内部产品沟通，不能替代本轮分析，也不能原样展示给普通分析用户。

```yaml
request_name: ""
classification: "system_capability_gap"
user_goal: ""
missing_runtime_capability: "mcp_tool/scheduler/service_api/data_adapter/permission/persistence/push"
workspace_part_ready: false
service_changes_required: []
scope_and_permission_requirements: []
confirmation_and_audit_requirements: []
deployment_required: true
acceptance_checks: []
current_status: "not_active"
```

系统能力缺口只是交付给系统工程侧的需求，不是安装结果。不得因为已经写下申请、脚本、manifest 或配置文件，就告诉用户工具、定时任务或数据源已经启用。

## 生效判定

- Workspace 方法或模板：目标文件存在，并能在一次代表性分析中被正确采用。
- Workspace Skill：位于 `.codex/skills/<name>/SKILL.md`，且新 Codex 会话能够发现并遵循。
- Workspace 脚本：在沙箱内完成一次代表性执行，并对缺失依赖或数据明确降级。
- MCP 工具：出现在运行时会话工具列表中，并完成一次正确 scope 的调用。
- 定时能力：服务层识别该任务类型，并产生一次可审计的实际运行记录。
- 持久化写入：具名工具、用户确认、scope 校验和服务审计全部成功。

无法达到对应判定标准时，只能说明“草案已准备”“Workspace 部分已完成”或“等待系统侧接入”，不能声称完整能力已经生效。

## 审计与回滚

Workspace 扩展成功后，在 `memory/change_log.jsonl` 记录：

```json
{
  "change_type": "workspace_capability_extension",
  "capability_name": "",
  "user_confirmed": true,
  "changed_files": [],
  "reason": "",
  "rollback_plan": "",
  "created_at": ""
}
```

回滚默认删除或恢复新增的 Workspace 方法、Skill、配置或脚本，但保留历史报告和审计记录。系统能力申请由服务工程侧单独管理，不允许 Workspace 自行回滚生产服务。
