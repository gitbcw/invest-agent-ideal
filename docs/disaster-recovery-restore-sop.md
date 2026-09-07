# 灾备恢复 SOP（纯用户数据备份格式）

T-415 于 2026-09-07 用当日快照 `2026-09-07T010004+0800` 首次真实演练验证通过后沉淀。演练证据见本机 `~/MyFile/my-data/backups/invest-agent/recovery-drills/T-415/20260907T004208Z/drill-record.md`。

## 1. 适用范围与前提

- 备份格式：2026-08-28 大修后的「纯用户数据」模式（代码通道已裁撤）。每份日全量 = `databases/`（runtime.db + legacy-portal.db）+ `workspaces/`（111/dyk/mg）+ `reviews/` + `runtime-data/`（用户与运维数据部分）+ `sensitive/`（加密敏感包）+ `manifest.sha256` + `metadata.txt` + `COMPLETE`
- 备份位置：本机 Mac mini `~/MyFile/my-data/backups/invest-agent/disaster-recovery/full/<ts>/`，`latest-full` 指针只指向校验通过的快照；滚动保留 7 个日全量（2026-08-28 用户裁决，`prune_snapshots 7`），RPO = 24 小时
- 解密私钥：`~/MyFile/my-data/keys/invest-agent-dr/private.pem`（已双备份：本目录 + 用户密码管理器）。**私钥丢失 = 敏感包永久不可解**，这是整个恢复链的单点
- 代码不在备份内：代码灾备 = git（生产基线 main 已推 GitHub）。恢复 = 新机部署代码 + 备份落位用户数据
- 备份运维细节（allowlist、排除项、加密算法）见 [workspace-backup-operations.md](./workspace-backup-operations.md) 与固定副本脚本 `~/Library/Application Support/InvestAgent/disaster-recovery/scripts/`

## 2. 恢复总体路径

灾备假设为火山云生产机全损。顺序不可颠倒：先代码、后数据、再敏感、最后验收切流。

```text
① 选定快照并校验 → ② 新机准备与代码部署 → ③ 数据库落位
→ ④ 工作区与 reviews/runtime-data 落位 → ⑤ 敏感包解密落位
→ ⑥ 数据级验收 → ⑦ 服务级验收 → ⑧ 切流（人工授权）
```

**恢复门禁（继承 workspace-backup-operations.md，写生产前必须全部满足）**：未经审阅不得把备份直接同步回生产；若目标是有残留数据的存量环境，必须先对现行数据另行备份；rsync 落位前先 `--dry-run` 确认新增/覆盖/删除范围；冻结写入并取得用户人工确认；完成后跑 Workspace preflight 和真实链路单点验收。

## 3. 逐步操作

### ① 选定快照并校验

```bash
readlink ~/MyFile/my-data/backups/invest-agent/disaster-recovery/latest-full   # 选最新或指定时点
L=~/MyFile/my-data/backups/invest-agent/disaster-recovery/full/<ts>
cat "$L/metadata.txt"          # 必须 status=complete 且有 COMPLETE 标记
cat "$L/sqlite-checks.txt"     # 备份时远端/本地 quick_check 双向记录
cd "$L" && shasum -a 256 -c manifest.sha256 --status && echo MANIFEST_OK     # 2026-09-07 实测 2627 文件 1.6s
```

任何一步失败即止损：换上一份快照，不得带病恢复。

### ② 新机准备与代码部署

按 `.codex/skills/volcano-ops/references/server-deployment.md` 走标准部署：node/pm2 环境 → `deploy-volcano.sh` 从 main 同步构建产物并拉起 runtime + portal。此阶段不落任何用户数据。

### ③ 数据库落位

目标位置（生产布局）：`/home/claude/invest-agent-mastra/data/runtime.db`（门户共用同一库，`PORTAL_DB_PATH` 即它）。

```bash
# 本机先做隔离副本验证（禁止直接开生产文件）
mkdir -p <演练目录> && cp "$L/databases/runtime.db" "$L/databases/legacy-portal.db" <演练目录>/
node -e "const db=require('better-sqlite3')('<演练目录>/runtime.db',{readonly:true}); \
  console.log(db.pragma('integrity_check',{simple:true})); \
  console.log(db.prepare(\"SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").get().c)"
```

验收基准（2026-09-07 快照口径）：`integrity_check=ok`、76 张表。legacy-portal.db 是遗留镜像库（9 表），落位于同目录仅作审计，不参与服务。

停写后落位：`rsync -av --checksum` 到目标路径，属主 claude。**先停 pm2 再落位 DB，落位后才启动。**

### ④ 工作区与 reviews/runtime-data 落位

```bash
rsync -av "$L/workspaces/snapshots/<ts>/111/" claude@<host>:/home/claude/invest-agent-data/workspaces/111/   # dyk/mg 同理，逐用户
rsync -av "$L/reviews/"   claude@<host>:/home/claude/invest-agent-mastra/data/reviews/
rsync -av "$L/runtime-data/" claude@<host>:/home/claude/invest-agent-mastra/data/   # 注意先 --dry-run，见下
```

- 工作区快照内 `.sandbox-token`、`.codex/auth.json`、`logs_2.sqlite*`、tmp 目录按设计不在备份内：sandbox token 由服务层重新签发（`.sandbox-secret` 在敏感包），auth.json 在敏感包
- `runtime-data/` 落位到 `data/` 前必须 dry-run 看清范围：内含 projects/mastra-projects/archives/runtime 与运维 JSON，也含历史一次性 `.bak`（如 `runtime.db.bak-20260831*`），**严禁覆盖现行 runtime.db**——dry-run 输出里出现 runtime.db 即中止核对路径

### ⑤ 敏感包解密落位（微信绑定恢复）

```bash
K=~/MyFile/my-data/keys/invest-agent-dr
openssl pkey -in "$K/private.pem" -pubout -outform DER | shasum -a 256   # 须 == "$L/encryption-key-fingerprint.txt"
openssl pkeyutl -decrypt -inkey "$K/private.pem" -in "$L/sensitive/data-key.enc" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -out data-key.hex
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:data-key.hex \
  -in "$L/sensitive/sensitive.tar.gz.enc" | tar tzf -    # 先列表核对
# 确认范围后解包到目标机对应绝对路径（tar 内为 / 起始的绝对布局）：
#   .env、.state/（微信绑定状态，含 project-weixin/*/openclaw-weixin/accounts*）、
#   data/.sandbox-secret、apps/portal/.env、~claude/.codex/{auth.json,config.toml,installation_id}
rm -f data-key.hex   # 明文密钥即用即毁
```

实测解密链路耗时毫秒级（RSA 6ms + AES/tar 37ms）。`.state` 落位后微信通道随服务启动恢复；若绑定状态过期需按渠道侧重新登录，属业务层恢复动作。

### ⑥ 数据级验收（本节即 T-415 演练清单）

| 项 | 通过标准 |
|---|---|
| manifest 校验 | 全部哈希一致，0 失败 |
| runtime.db | `integrity_check=ok`；users=活跃用户数；三用户 messages/sessions 与预期量级一致；`mastra_portfolio_states` 三用户各 1 行且 portfolio_json 可读——这是 Mastra 模式持仓权威载体（服务层写入，链路见 [table-ownership.md](./table-ownership.md)），工作区 `config/portfolio.yaml` 随工作区恢复一并核验；`portfolio`/`watchlist` 等旧冻结表为空属正常 |
| 工作区 | 111/dyk/mg 目录文件数量级正确（2026-09-07：490/513/513）；各自 AGENTS.md 在位；`.codex/{goals,state,memories}_*.sqlite` 可读；skills/sessions 在位 |
| reviews | 文件数与备份 manifest 一致（2026-09-07：44） |
| 敏感包 | 指纹匹配、解密成功、列表含 `.env`/`.state`/`.sandbox-secret`/portal `.env`/codex 三件套 |
| 条数交叉核对 | 若源库仍可读，逐表对比快照 vs 源库；差异应完全落在快照时间点之后的增量（RPO 24h 预期） |

### ⑦ 服务级验收与 ⑧ 切流

pm2 拉起后：Platform/Portal 页面可登录、三用户工作区路径与持仓摘要可见、会话历史可读、微信通道在线；按 [workspace-compatibility.md](./workspace-compatibility.md) 跑 Workspace preflight 与单点验收。切流（DNS/端口/上游切换）为人工授权动作，不在本 SOP 自动化范围内。

## 4. 故障排查速查

| 症状 | 首查 |
|---|---|
| manifest 校验失败 | 网络传输损伤 or 磁盘位腐；换 `latest-full` 指向的上一份完整快照 |
| data-key 解不开 | 指纹不匹配 = 拿错私钥；私钥文件损坏则用密码管理器副本 |
| DB 打开报错 | 是否落位了 `.bak` 覆盖现行库；是否带 `-wal` 残留（备份不含 wal，正常） |
| 微信不在线 | `.state` 是否落位到运行目录；渠道侧登录态是否过期 |
| 工作区权限异常 | rsync 是否丢了属主/权限位（用 `-pgo`）；`.sandbox-token` 缺失属预期，由服务层重签 |

## 5. 已知事实与口径

- 滚动保留 7 个日全量（2026-08-28 用户裁决；T-252 时代的 14 天政策已被其取代）；快照总量 2026-09 口径约 250–430MB/晚，本机备份根 ~1.2GB
- 快照含测试/eval 用户数据（112/113/eval-*/mgreplay 等）——与生产库一致，清理属生产数据治理议题
- `runtime-data/` 同步已排除 `*.db.bak-*`（2026-09-07 起，一次性恢复前副本不再逐晚入快照；文件本体留在服务器，dry-run 验证生效）
- 每晚 01:00 的备份任务只做「备份+校验」，不做恢复（T-252 后运维政策）

## 6. RTO 口径与再演练触发条件

- 数据级恢复（本机备份 → 可验证数据）：分钟级。2026-09-07 实测：manifest 全量校验 1.6s、DB 复制 0.06s、解密链路 <0.1s
- 全量 RTO = 新机准备 + 代码部署 + 数据传输（423MB，取决于下行带宽）+ 落位与验收；参照 T-252 旧格式实测，恢复段（备份可用 → 验收通过）≈15 分钟，全链路含排障 <1 小时量级
- 服务级演练未在纯用户数据格式下执行过（T-415 为数据级）。触发再演练的条件（T-252 政策沿用）：备份格式、恢复步骤、schema 兼容性或部署运行时发生重大变化，或完整性信号出现疑点
