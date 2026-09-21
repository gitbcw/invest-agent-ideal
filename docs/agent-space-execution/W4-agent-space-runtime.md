# W4：Agent 空间控制面与运行时装配

依赖：W1-W3；W5 可先用接口桩。实现 Agent 配置读模型、resolver、run-basis 和最小查询面；分别覆盖交互、generic automation、其他 scheduled 入口；不得真实切换或删除旧 Workspace。

装配顺序：认证 scope → 固定已安装 Skill/Method/asset grant 版本 → 按任务 dependencies 收窄 → 取得预算 State Packet → 记录 Agent、版本、资产、状态、输入输出、写入、交付及裁剪/跳过原因。

新模式不得默认挂载、list、grep 或 discover 旧 Workspace；`history/` 目录名不等于退出。兼容读取必须显式、按需、可观察并写入 run-basis。

验收：每个覆盖入口有可解释 run-basis；并发更新不替换本轮版本；未绑定/禁用/跨 scope 内容不进入上下文；长内容分页/预算有截断记录；关闭旧 default-load 后新对象仍提供依赖。
