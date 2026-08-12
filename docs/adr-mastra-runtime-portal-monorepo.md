# ADR: Mastra Runtime 与 Portal 同仓

状态：Proposed，等待实现阶段确认

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
5. 将现有 runtime 移至 `apps/runtime`，保持 23655、状态根和启动行为不变。
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

## 暂停门

本 ADR 当前只批准设计，不批准移动 Portal 源码、改变正式 Portal 发布源或部署生产服务。
