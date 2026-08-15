# R1 发布方案（Mastra 候选并行上线）

状态：执行中（2026-08-15，用户授权"开始吧"）
分支：`feat/mastra-mastra`（候选，460 测试 0 失败 + portal 43/43）
前置：H1 已过、真实数据迁移验证已过、E1-E10 收口、服务器加固完成（4G swap / OpenClaw 清零 / 可用 5.9G）

## 1. 部署形态

**并行服务，零触碰现有生产**：

| 项 | 现有生产（不动） | 新候选（本次） |
| --- | --- | --- |
| 目录 | /home/claude/invest-agent（+ -portal） | /home/claude/invest-agent-mastra |
| runtime | 127.0.0.1:22655 | 127.0.0.1:**23655** |
| Portal | :22649（公网） | :**23657**（公网，新地址） |
| Relay | :22650 | :**23658**（回环） |
| 数据 | 既有 SQLite/Workspace | 全新独立 SQLite + projects 根（本阶段零迁移） |
| PM2 | invest-agent / invest-agent-portal | invest-agent-mastra / mastra-portal |
| 微信 | 现网绑定不动 | **不接**（WEIXIN_AUTO_START=false） |

## 2. 资源纪律（针对 2026-08-15 死机教训）

- **本地构建、服务器零编译**：dist 与 .next（200M）本地构建后 rsync 上传；服务器只做 `npm ci --omit=dev`（runtime）与 `npm ci`（portal，tsx 在 devDeps）
- **严格串行**：runtime 依赖装完 → portal 依赖装 → 单进程启动，每步之间 `free -m` 检查，可用 <2G 即中止
- 两进程 `max_memory_restart: 500M`；预估合计峰值 <1G，当前可用 5.9G+4G swap
- 网关密钥服务端直取（/home/claude/.codex/），不落本地、不打印

## 3. 执行步骤

1. ✅ 本地构建 runtime dist + portal .next
2. rsync 上传：根（dist/package.json/lock/scripts/ecosystem）+ apps/portal（源码+.next，排除 node_modules/dev 产物）
3. 服务器端串行安装依赖（盯内存）
4. 服务端生成两份 .env（fresh secrets：JWT/connector token 匹配对；网关从 ~/.codex 提取）
5. bootstrap 默认项目（node dist）→ seed 测试账号（primary/User@2026）
6. PM2 启动 runtime → 127.0.0.1:23655/health → 启动 portal → :23657 健康检查
7. `pm2 save`；公网冒烟（登录/对话/自动化/巡检页）

## 4. 本阶段明确不做（等用户逐项授权）

- 微信连接与扫码（候选不启微信进程）
- 真实用户数据迁移（mg/dyk/111 的数据仍在生产侧）
- 生产切换/端口回收/旧服务下线

## 5. 验收标准

- :23657 公网可访问、登录成功
- runtime health ok、connector 注册、对话链路通（含表格生成→附件卡片）
- 自动化任务列表 4 类 active、巡检页可建规则
- 服务器 load/内存在启动后 30 分钟内平稳（可用内存 >3G）
