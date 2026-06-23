# Experimental MVP 演示检查清单

本文档用于本地或微信联调前快速验证实验版本是否能跑通。

## 1. 基础验证

```bash
npm run smoke
```

该命令会：

- 编译 TypeScript。
- 使用独立的 `data/experimental-smoke.db`。
- 初始化数据库。
- 验证自选股来源字段。
- 验证每日预案、提醒事件、操作记录表。
- 验证部分卖出保护。
- 验证历史复盘查询优先级。

## 2. 启动服务

```bash
npm run build
npm start
```

健康检查：

```bash
curl http://localhost:22648/health
```

预期：

- `status` 为 `ok`。
- 返回 agent 信息、capabilities 和 pendingAlerts。

## 3. 本地对话演示

### 查询空状态

```bash
curl -X POST http://localhost:22648/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"我的持仓"}'
```

预期：提示当前无持仓。

### 录入持仓

```bash
curl -X POST http://localhost:22648/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"买入 000001 10.50 100"}'
```

预期：返回已录入持仓。

### 添加自选股和理由

```bash
curl -X POST http://localhost:22648/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"加入自选 000001 来自选股报告，理由是实验版候选"}'
```

预期：返回来源和关注理由。

### 查询自选股

```bash
curl -X POST http://localhost:22648/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"自选列表"}'
```

预期：展示自选股、行情、来源和理由。

### 生成每日复盘

```bash
curl -X POST http://localhost:22648/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"每日复盘"}'
```

预期：

- 生成 `reviews/YYYY-MM-DD.md`。
- 包含明日交易预案。
- 保存每日预案到数据库。
- 如果 DeepSeek 未配置，返回清晰的 AI 不可用降级内容。

### 手动触发提醒巡检

```bash
curl -X POST http://localhost:22648/api/alerts/check
```

预期：

- 非交易时间可能返回空提醒。
- 交易时间若触发，会写入提醒事件。

## 4. 微信联调路径

确认 OpenClaw 指向：

```text
POST /acp/message
GET /.well-known/agent.json
GET /acp/alerts
```

建议按以下微信消息顺序试用：

1. `我现在持有赣锋锂业、盛新锂能和赛轮轮胎`
2. `看一下我现在的持仓有哪些`
3. `再把这个池子里添加两个阳光电源和宁德时代`
4. `算了，把它移除吧`
5. `把宁德时代和阳光电源加入自选`
6. `自选列表`
7. `每日复盘`
8. `查看 YYYY-MM-DD 复盘`
9. `目前我做了哪些监控？监控指标是什么？`

## 5. 观察点

演示时重点观察：

- 回复是否能让用户理解下一步怎么做。
- 是否像 Agent，而不是要求用户记命令格式。
- 是否能正确理解“这个池子 / 它 / 这两个”等上下文指代。
- AI 是否明确标注数据缺口。
- 主力控盘相关内容是否避免编造。
- 复盘是否产生明日预案。
- 提醒是否说明与预案的关系。
- 自选股是否记录加入理由。

## 6. 当前不验证

- 完整行业信息源分析。
- PDF 或图片识别。
- 视频摘要。
- 订阅支付。
- 自动交易。
- 主力控盘直接数据。
