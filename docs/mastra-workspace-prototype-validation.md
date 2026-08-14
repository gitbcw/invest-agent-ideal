# Mastra Workspace 原型验证记录

日期：2026-08-13
分支：`feat/mastra-migration`
范围：只验证 Mastra Workspace 能力，不接入 `23655` 请求路径，不读取或修改真实 Workspace、生产数据库、生产微信状态。

## 验证内容

脚本 [`scripts/mastra-workspace-prototype-check.mjs`](../scripts/mastra-workspace-prototype-check.mjs) 在临时目录中创建两个隔离用户：`alpha`、`beta`。每个用户拥有独立目录、私有文件和同名但内容不同的 `private-method` Skill。

验证项目：

1. Agent 的动态 `workspace` resolver 按 `RequestContext.userId` 绑定不同目录。
2. Workspace filesystem 可以读写用户目录。
3. `contained: true` 阻断 `../` 路径穿越。
4. Agent Skill 按用户动态加载，`alpha` 不会拿到 `beta` 的 Skill 内容，反之亦然。
5. Workspace 文件读写、列目录、命令执行工具会自动注入 Agent；删除工具可以按配置禁用。
6. 命令在绑定的用户目录中执行。
7. 探测 macOS Seatbelt 的真实目录隔离范围；禁止仅凭 provider 名称假设它能隔离多用户目录。
8. 没有用户 scope 时，resolver fail-closed。

## 运行方式

```bash
node scripts/mastra-workspace-prototype-check.mjs
```

脚本结束时会销毁 Workspace 并删除临时根目录；不会留下测试用户目录。

## 结论

Mastra 原生支持“每请求绑定不同用户 Workspace”的目标形态。当前 `@mastra/core@1.57.0` 提供：

- `Workspace` 的 filesystem/sandbox/skills 组合；
- 动态 filesystem 和动态 sandbox resolver；
- Agent 的动态 `workspace` 配置；
- Workspace 工具级 `enabled`、`requireApproval`、`requireReadBeforeWrite` 和 hooks；
- `LocalFilesystem` 的根目录 containment；
- `LocalSandbox` 的 macOS Seatbelt / Linux bubblewrap 隔离入口。

这证明 Mastra 具备保留“用户项目目录”所需的底层能力，但不证明当前迁移分支已经完成接入。当前迁移分支的 `createMastraAgent` 仍只传入模型、instructions 和服务工具；Workspace 需要后续作为独立阶段接入。

## 设计含义

验证支持以下方向：

- 保留受控用户 Workspace，承载报告、研究文件、模板、用户方法和自定义产物。
- 持仓、调度、确认、审计等强约束状态继续使用服务工具和数据库。
- Skill 可以从用户目录加载，但权限不能由 Skill 文件扩大。
- 用户脚本可以作为文件保存；执行必须走受控 sandbox，并按工具配置要求确认。
- 不应把在线生产 Workspace 直接绑定到本地测试服务；正式接入要先做 Workspace root registry、scope 校验、生命周期、备份、审计和回滚设计。

## 已知限制

- `LocalSandbox` 的 `isolation: "none"` 是主机执行，只适合可信本地开发。
- 本机实际探针显示：即使 macOS Seatbelt 被检测为可用，`LocalSandbox` 当前配置仍可读取同级用户目录和项目目录。因此它也不能作为多用户或不可信代码的最终执行隔离边界。生产候选必须使用每次运行的 staging 副本配合容器/微虚机/远程 sandbox，并且不要把持久用户 Workspace 以可写形式直接挂载进去。
- 动态 Skill resolver 在没有 request context 时必须返回空集合或固定系统 Skills，不能猜测用户目录。
- Workspace 文件操作使用 Workspace 相对路径；不应把主机绝对路径暴露给模型。
- `createWorkspaceTools` 只提供工具和配置机制，业务层仍需负责用户身份、目录注册、审计、配额和发布策略。
