# ADR: Mastra Runtime 与 Portal 同仓

状态：Accepted；当前生产发布源为 `feat/mastra-migration`

## 决策

Mastra 正式候选最终采用单仓多应用结构：

```text
apps/runtime/        Mastra Agent、HTTP、scheduler、微信、Platform connector
apps/portal/         当前正式 Next.js Portal 与 Relay
packages/protocol/   versioned envelope、capability、error schema
packages/contracts/  无存储实现的共享 DTO
```

同仓不意味着同进程。runtime 与 portal 保持独立端口、独立进程、独立数据库和独立部署单元；根目录只统一 Git 历史、依赖管理、协议测试和本地启动命令。

## 原因

- 当前 Portal 与 runtime 分仓维护相同 protocol union、错误码和 capability，容易漂移。
- Mastra 版本不再需要 Workspace ACP 项目边界，runtime + portal 是更直接的产品形态。
- 同仓可以对同一 fixture 同时运行 Portal HTTP、Relay 和 runtime connector 验收。
- 独立应用结构避免把 Portal 数据库与 runtime 服务表耦合成一个数据库。

## 不采用的方案

- 保持永久分仓：发布职责清晰，但协议和测试持续漂移，无法满足新的统一 Git 管理目标。
- 将 Portal 编译进 runtime 单进程：故障域、扩缩容、Next.js 构建和 secret boundary 混在一起，不采用。
- 从 `test-projects/` 复制 Portal：违反项目事实源约束，不采用。

## 导入批次

1. 冻结当前 Portal commit、测试结果和 protocol matrix。
2. 建立 workspace package manager 和根脚本，但暂不移动 runtime 文件。
3. 先导入 `packages/protocol`，让两边适配共享 schema，保留协议版本兼容测试。
4. 将正式 Portal 历史按可追溯方式导入 `apps/portal`，验证 43 项测试及浏览器 acceptance。
5. 将现有 runtime 移至 `apps/runtime`，仅在目录重组已明确带来收益时进行；当前根 `src/` runtime + `apps/portal/` 已满足同仓、独立进程和独立状态边界，不以无价值移动制造 churn。
6. 增加根级 `dev`, `build`, `test`, `acceptance` 命令和独立应用命令。
7. Portal 的 Workspace tree 改为 asset library 后，移除 `workspace.file.*` 当前依赖。

## 验收条件

- runtime 与 portal 可分别构建、测试和启动。
- 根命令可同时启动二者，端口与状态根显式且互不覆盖。
- shared protocol fixture 对 Portal 和 runtime 都通过；capability 未分类差异为 0。
- Portal 43 项现有测试、runtime 全套测试和 browser acceptance 通过。
- Portal 不读取 runtime SQLite/文件根；runtime 不读取 Portal session DB。
- 生产发布源切换需单独批准；在此之前 `/Users/combo/MyFile/projects/invest-agent-portal` 仍是正式 Portal 唯一发布源。

## 风险

- 大规模目录移动造成无关 churn：必须分批提交，先共享协议、后移动应用。
- 两套 `better-sqlite3`/Node 依赖版本冲突：使用应用级 package 边界，不强制一次性统一。
- 协议错误码变更破坏旧 connector：Portal 暂时同时识别 `ACP_FAILED` 和 `AGENT_RUNTIME_FAILED`，待旧正式 runtime 下线后清理。

## 交互复用边界（2026-08-15 用户裁决，D23）

重构的主战场是 **runtime**（Mastra 内核、服务层、数据架构、调度）。Portal 交互层是**已实现的资产，直接复用，不重设计**：

- 新的 runtime 能力必须**优先映射到 Portal 既有交互契约**（artifact 附件卡片、文件预览面板、自动化工作区、资产库、对话流），而不是发明新交付形态。G22 的教训：`spreadsheet.create` 交付在前两轮被做成"回复内链接 + 门户端下载路由/点击拦截"的自创交互，第四轮回归官方 artifact 卡片管线后撤销，`apps/portal/src` 恢复与正式仓字节对齐。
- 只有当能力**本质需要新交互面**时才新增 UI，且必须作为显式批准的工作包立项（先例：新 onboarding 向导，D15）。
- **架构驱动的交互演进是预期内的例外**：为承接重构后 runtime 的新能力（如按回合模型选择），交互层会有受控改变——首个在途实例是模型选择器（正式仓 WIP `local/ea43db2` 分支 commit `4dd6d0d`：对话框模型下拉，`model` 经 `conversation.chat` 协议透传；runtime 侧 model-gateway 按回合选择已就绪，仅差交互合入）。此类改变按"显式立项 → 合入正式仓 → 导入候选"路径走，不走顺手改。
- 边界校验手段：`diff -rq /Users/combo/MyFile/projects/invest-agent-portal/src apps/portal/src`，预期差异仅限已批准工作包；出现未登记差异即视为越界，回滚或补立项。

## 暂停门

`apps/portal/` 已从授权的正式 Portal 仓库以可追溯方式导入，并通过独立构建与测试；本 ADR 不批准改变正式 Portal 发布源、部署生产服务、生产数据迁移或分支合并。
