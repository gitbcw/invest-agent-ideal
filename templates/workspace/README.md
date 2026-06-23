# 投资助手工作空间模板

> 本目录是 **模板**。真实用户工作空间由平台在用户接入时复制本目录得到,
> 路径形如 `<WORKSPACE_ROOT>/<userId>/`。

## 模板结构

```text
.
├── AGENTS.md                    # 工作空间模型、边界、原则(中文)
├── README.md                    # 本文件
├── config/                      # 21 份用户可改的 yaml 协议
│   ├── tenant.yaml              # 空间身份、Codex 兜底、路由层、任务幂等
│   ├── paths.yaml               # 全部文件位置锚点
│   ├── data_contracts.yaml      # 数据字段和事件类型契约
│   ├── decision_policy.yaml     # 操作建议和确认规则
│   ├── evidence_policy.yaml     # 证据等级和来源冲突
│   ├── risk_taxonomy.yaml       # 风险分类和 P0/P1/P2 口径
│   ├── interaction_policy.yaml  # 微信交互和低打扰
│   ├── notification.yaml        # 通知策略和工作时间
│   ├── schedules.yaml           # 日/周/月/财报/盯盘调度
│   ├── portfolio.yaml           # 持仓、现金、观察仓、账户
│   ├── strategy.yaml            # 投资风格、规则、边界
│   ├── watch.yaml               # 智能盯盘规则
│   ├── selection.yaml           # 观察池和选股产品策略
│   ├── observation_pool.yaml    # 候选观察池
│   ├── style_packs.yaml         # 默认风格包
│   ├── skills.yaml              # 各 skill 启用和必须遵守的协议
│   ├── sources.yaml             # 信息源和可靠性
│   ├── privacy.yaml             # 隐私、安全和审计
│   ├── onboarding.yaml          # 冷启动分层
│   ├── product_metrics.yaml     # 产品成功指标
│   └── mvp.yaml                 # MVP 优先级
├── knowledge/                   # 协议文档和方法骨架
│   ├── decision_protocol.md     # 决策记录和复盘协议
│   ├── watch_protocol.md        # 盯盘协议
│   ├── selection_protocol.md    # 选股协议
│   ├── source_audit.md          # 来源审计协议
│   ├── privacy_and_tenant_isolation.md
│   ├── product_metrics_protocol.md
│   └── methods/                 # 方法骨架(占位,用户后续补充)
│       ├── fundamental.md
│       ├── technical.md
│       ├── macro.md
│       └── risk.md
├── memory/                      # 事件流(完全空的 jsonl)
│   ├── audit_events.jsonl
│   ├── behavior_events.jsonl
│   ├── change_log.jsonl
│   ├── decisions.jsonl          # 观点记录(供周/月复盘回看)
│   ├── feedback.jsonl
│   ├── method_changes.jsonl
│   ├── source_events.jsonl
│   └── task_runs.jsonl
├── reports/                     # 报告产物(目录占位)
│   ├── daily/
│   ├── weekly/
│   ├── monthly/
│   ├── company/
│   ├── alerts/
│   └── metrics/
├── financials/                  # 公司财报缓存(目录占位)
│   └── companies/
└── schemas/                     # JSON Schema(用于 jsonl 校验)
    └── jsonl/
        ├── audit_event.schema.json
        ├── behavior_event.schema.json
        ├── decision_record.schema.json
        ├── source_event.schema.json
        └── task_run.schema.json
```

## 与 jr-backend 模板的差异

- **`config/tenant.yaml`**:删除 Hermes 段(主链路已退出),新增 `codex` 段(复杂推理兜底)和 `routing` 段(国产模型路由层 + 边界控制)。
- **`config/paths.yaml`**:新增 `runtime` 段,声明 `invest-agent-ideal` 长驻服务的职责边界(模板不再内嵌 Python 内核)。
- **`knowledge/methods/*.md`**:全部为占位骨架,用户后续通过微信或确认单补充。
- **`memory/*.jsonl`**:完全空,无页眉。
- **不复用**:原模板的 `skills/`、`.codex/skills/`、`src/invest_assistant/`、`pyproject.toml`、`requirements.txt` — 这些在本项目已有等价物。

## 谁来实例化

`invest-agent-ideal` 服务在用户首次接入时调用 `ensureWorkspace(userId)`,把本目录复制到 `<WORKSPACE_ROOT>/<userId>/`,然后注入用户身份字段(workspace.tenant_id / user_id / project_id)。

具体 API 见工作包 0b(`src/lib/workspace.ts`)。
