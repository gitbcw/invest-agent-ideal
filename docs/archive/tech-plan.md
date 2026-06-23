# 投资选股智能体 - 技术方案

> 创建时间：2026-05-23
> 状态：已归档（2026-05-27）
> 归档原因：基于旧关键词路由架构，与当前 Codex + ACP + skills 方向不一致。当前入口见 docs/README.md 和 docs/15-next-phase-roadmap.md。

## 1. 系统架构

```
客户微信 ←→ OpenClaw（微信通道）
                ↕ ACP 协议
           invest-agent（火山云:22648）
              ├── DeepSeek AI（选股问答 / 复盘分析）
              ├── 行情数据服务（腾讯股票 API）
              ├── 数据库（SQLite）
              ├── 定时任务（每 5 分钟巡检）
              └── 复盘文档（Markdown 文件）
```

微信通道由 OpenClaw 负责，智能体通过 ACP 协议与 OpenClaw 通信。
智能体本身可替换——未来可换用其他 ACP 兼容的开源 Agent。

参考：
- OpenClaw 官方微信通道文档：https://docs.openclaw.ai/zh-CN/channels/wechat
- Weixin-Agent-SDK（ACP 桥接）：https://github.com/zhayujie/CowAgent
- ACP 协议介绍：https://www.phodal.com/blog/agent-acp-in-practise/

## 2. 技术选型

| 层面 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js + TypeScript | 熟悉，ACP SDK 支持 |
| Agent 框架 | 自研 ACP Agent | 轻量，不依赖特定平台 |
| AI | DeepSeek API (deepseek-chat) | 成本低，中文强 |
| 行情数据 | 腾讯股票 API（主）+ AKShare（备） | 免费，A 股覆盖全 |
| 数据库 | SQLite | 单客户，零运维 |
| ORM | Drizzle | 轻量，TS 友好 |
| 定时任务 | node-cron | 简单可靠 |
| 部署 | PM2 + systemd | 现有火山云方案成熟 |
| 复盘存储 | Markdown 文件 | 可读性好，方便归档 |

## 3. 核心模块

### 3.1 ACP 通信层（ACP Adapter）

- 实现 ACP 协议的 Agent 端
- 接收 OpenClaw 转发的微信消息
- 返回结构化/非结构化响应
- 支持消息类型：文本、图片（K线图/报告截图）

### 3.2 消息路由（Message Router）

```
ACP 消息 → 解析意图 → 路由到 Handler
```

意图识别：
- 持仓：「录入持仓」「我的持仓」「清仓 XXX」
- 自选股：「加入自选」「自选列表」「移除 XXX」
- 选股：「帮我选 XX 行业的股票」「XX 概念有什么股」
- 提醒：「设置提醒」「今天有什么提醒」
- 复盘：「每日复盘」「本周复盘」「本月复盘」
- 通用问答：兜底走 DeepSeek 对话

### 3.3 持仓管理（Portfolio）

- 录入：股票代码 + 买入价 + 数量 + 日期
- 查询：当前持仓 + 自选股，关联实时行情计算盈亏
- 自选股：独立于持仓的观察列表，可从选股流程直接加入

### 3.4 选股问答（Stock Screening）

```
用户输入概念/题材/关键词
  → AI 分析行业发展趋势
  → 筛选有投资价值的公司（3-5 家）
  → 生成对比报告（基本面 + 技术面 + 理由 + 资料来源）
  → 用户选择加入自选股（闭环）
```

Prompt 链式设计：
1. 行业分析 prompt — 输入关键词，输出行业判断
2. 公司筛选 prompt — 输入行业 + 行情数据，输出候选公司
3. 对比报告 prompt — 输入候选公司详情，输出结构化报告

### 3.5 技术指标体系

初期三大类指标：

**趋势类**
- MA（5/10/20/60 日均线）
- MACD（金叉/死叉、红绿柱变化）
- 均线多头/空头排列判断

**量能类**
- 成交量异动（对比 5 日/20 日均量）
- 量价配合判断（放量涨/缩量跌等）
- 换手率异常

**主力控盘类**
- 大单净流入/流出
- 筹码集中度（获利比例、平均成本）
- 主力持仓变化趋势

### 3.6 日提醒（Daily Alert）

**检查频率**：A 股开盘期间每 5 分钟（9:30-11:30, 13:00-15:00）

**触发条件**：
- 自选股涨跌幅 > 3%
- 成交量突破 5 日均量 2 倍
- 技术指标触发（MACD 金叉/死叉、突破均线等）
- 主力资金大幅流入/流出

**提醒内容**：
- 股票名称 + 当前价 + 涨跌幅
- 触发指标说明
- 简要操作建议（仅客观分析，不构成投资建议）

**开盘前提醒**（9:15）：
- 隔夜外盘影响
- 自选股盘前异动
- 昨日复盘要点回顾

### 3.7 复盘机制（Review）

| 周期 | 动作 | 输出 |
|------|------|------|
| 日复盘 | 汇总当天操作 + 行情变化 + 决策回顾 | `reviews/2026-05-23.md` |
| 周复盘 | 对比指标判断 vs 实际走势，计算准确率 | `reviews/2026-W21.md` |
| 月复盘 | 综合评估指标体系有效性，调整策略 | `reviews/2026-05.md` |

复盘文档格式（Markdown）：
```markdown
# 2026-05-23 每日复盘

## 今日操作
- 买入 XXX，原因：...
- 卖出 XXX，原因：...

## 自选股表现
| 股票 | 今日涨跌 | 指标信号 | 判断正确性 |
|------|---------|---------|-----------|

## 市场总结
- 大盘：...
- 板块：...

## 明日关注
- ...

## AI 分析
（DeepSeek 生成）
```

## 4. 数据模型

```sql
-- 配置
settings
  key TEXT PRIMARY KEY
  value TEXT

-- 自选股
watchlist
  stock_code TEXT
  stock_name TEXT
  added_at DATETIME
  reason TEXT

-- 持仓
portfolio
  stock_code TEXT
  stock_name TEXT
  buy_price REAL
  quantity INTEGER
  buy_date DATE
  sell_price REAL    -- NULL 表示未卖出
  sell_date DATE

-- 提醒配置
alerts
  stock_code TEXT
  indicator TEXT     -- trend / volume / mainforce
  threshold TEXT     -- JSON: 具体阈值配置
  enabled BOOLEAN

-- 对话记录
chat_history
  id INTEGER PRIMARY KEY
  role TEXT          -- user / assistant
  content TEXT
  created_at DATETIME
```

## 5. ACP 接口设计

智能体通过 ACP 协议暴露的能力：

```typescript
// ACP Agent 注册的能力列表
const capabilities = [
  "chat",           // 通用对话
  "portfolio",      // 持仓管理
  "watchlist",      // 自选股管理
  "screening",      // 选股分析
  "alert",          // 提醒管理
  "review",         // 复盘查询
  "market_data",    // 行情查询
]
```

ACP 消息格式（示意）：
```json
{
  "method": "chat",
  "params": {
    "message": "帮我看看今天光伏板块有什么机会",
    "context": { "user_id": "default" }
  }
}
```

## 6. 目录结构

```
invest-agent/
├── src/
│   ├── index.ts                — 入口
│   ├── acp/
│   │   ├── agent.ts            — ACP Agent 实现
│   │   └── protocol.ts         — ACP 协议处理
│   ├── router/
│   │   └── message.ts          — 消息路由 & 意图识别
│   ├── handlers/
│   │   ├── chat.ts             — 通用对话
│   │   ├── portfolio.ts        — 持仓管理
│   │   ├── watchlist.ts        — 自选股
│   │   ├── screening.ts        — 选股问答
│   │   ├── alert.ts            — 提醒管理
│   │   └── review.ts           — 复盘
│   ├── services/
│   │   ├── deepseek.ts         — DeepSeek API
│   │   ├── stock.ts            — 腾讯行情 API
│   │   └── indicators.ts       — 技术指标计算
│   ├── db/
│   │   ├── schema.ts           — Drizzle schema
│   │   └── index.ts            — 数据库连接
│   ├── scheduler/
│   │   ├── alert-check.ts      — 每 5 分钟巡检
│   │   ├── pre-market.ts       — 开盘前提醒
│   │   └── review.ts           — 复盘定时任务
│   ├── prompts/
│   │   ├── screening-chain.md  — 选股 prompt 链
│   │   ├── review-daily.md     — 日复盘 prompt
│   │   ├── review-weekly.md    — 周复盘 prompt
│   │   └── alert-analysis.md   — 提醒分析 prompt
│   └── lib/
│       ├── logger.ts           — 日志
│       └── config.ts           — 配置
├── reviews/                    — 复盘 Markdown 文件
├── ecosystem.config.js         — PM2 配置
├── tsconfig.json
├── package.json
└── .env                        — API keys
```

## 7. 部署方案

```bash
# 火山云：claude@118.145.115.197:22648

# ecosystem.config.js
module.exports = {
  apps: [{
    name: 'invest-agent',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 22648,
      DEEPSEEK_API_KEY: '...',
      STOCK_API: 'tencent'
    },
    autorestart: true,
    max_memory_restart: '500M'
  }]
}
```

部署流程：
1. `rsync -avz --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='*.lock'`
2. `npm install && npm run build`
3. `pm2 start ecosystem.config.js`
4. `curl http://118.145.115.197:22648/health`

## 8. 开发分期

### P0 - 能对话（打通链路）
- [ ] 项目脚手架 + TypeScript + PM2 部署
- [ ] ACP Agent 基础实现（接收消息 + 返回响应）
- [ ] DeepSeek 对话接入
- [ ] OpenClaw 微信通道对接测试
- [ ] 部署到火山云 :22648

### P1 - 能用（核心功能）
- [ ] 消息路由 & 意图识别
- [ ] 持仓录入 + 自选股管理
- [ ] 腾讯行情 API 接入
- [ ] 技术指标计算（趋势 + 量能 + 主力控盘）
- [ ] 选股问答流程（prompt 链）
- [ ] SQLite 数据持久化

### P2 - 能提醒（定时任务）
- [ ] 每 5 分钟行情巡检 + 提醒推送
- [ ] 开盘前提醒（9:15）
- [ ] 指标阈值触发提醒

### P3 - 能复盘（闭环）
- [ ] 日复盘自动生成（Markdown）
- [ ] 周复盘 + 指标准确率统计
- [ ] 月复盘 + 策略调整建议
- [ ] 复盘文档查询

### P4 - 能进化（优化）
- [ ] Prompt 精调（基于实际使用反馈）
- [ ] 趋势/量能/主力指标参数可调
- [ ] 多客户隔离（如有需要）
- [ ] 数据库迁移到 MySQL（如有需要）
