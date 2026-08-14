# 手工验收清单

> 第一阶段 mock 验收。所有用例都在 `dev` 模式下手工跑过一遍。
> 验收日期:2026-07-04。

## 环境准备

```bash
cp .env.example .env       # 检查 PORTAL_* 配置
npm install
npm run seed               # 初始化 primary/admin
npm run dev                # Next.js + WebSocket Relay 同进程,监听 :3100 / :3199
npm run dev:mock           # 另起一个终端,mock connector 默认 online
```

默认账号(由 `scripts/seed.ts` 写入):

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| primary | `User@2026` | user |
| admin | `Admin@2026` | admin |

切换 mock 场景:`PORTAL_MOCK_SCENARIO=<online|offline|slow|failed|empty|paged> npm run dev:mock`。

---

## 1. 登录与改密

### 1.1 正常登录

- 访问 `/login`,输入 `primary / User@2026`,点击「登录」。
- 期望:跳转 `/chat`,左下角显示 `P primary`。

### 1.2 错误密码

- 在 `/login` 输入 `primary / wrong`。
- 期望:停留在 `/login`,表单下方出现「账号或密码错误」,无 redirect。

### 1.3 主动改密(用户菜单)

- 登录后点击左下角头像 → 「修改密码」。
- 弹窗输入当前密码、新密码、确认新密码。
- 校验:
  - 新密码不能与当前密码相同(否则按钮可点但表单报错)。
  - 新密码至少 8 位,包含字母和数字,且不能与账号相同。
  - 两次新密码不一致时表单报错。
- 提交成功 → 弹窗关闭。
- 退出登录后用旧密码登录应失败,用新密码登录应成功。

**已验证(2026-07-04):** admin 把 `Admin@2026` 改为 `Admin@2026New`,旧密码登录返回 `INVALID_CREDENTIALS`,新密码登录成功。

### 1.4 退出登录

- 头像菜单 → 「退出登录」。
- 期望:跳转 `/login`,`/api/conversations` 等接口后续请求返回 401。

---

## 2. 管理员重置密码

### 2.1 调用接口

```bash
# admin 登录拿到 cookie
curl -c /tmp/admin.txt -X POST http://localhost:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@2026"}'

# 重置 primary
curl -b /tmp/admin.txt -X POST http://localhost:3100/api/admin/reset-password \
  -H "Content-Type: application/json" \
  -d '{"username":"primary"}'
# => {"ok":true,"data":{"temporaryPassword":"xxxxxxxxxxxx","mustChangePassword":true,...}}
```

### 2.2 用户首次登录被强制改密

- 用临时密码登录 `primary`。
- 期望:`mustChangePassword=true`,前端自动跳到 `/change-password`。
- 即使直接访问 `/chat`,中间件会 307 回 `/change-password`。
- 设置新密码后跳回 `/chat`,后续请求 `mustChangePassword=false`。

### 2.3 安全约束

- 非管理员调用 `/api/admin/reset-password` → 403。
- 管理员账号不存在 `mustChangePassword` 流程,且不能重置另一个管理员。
- `password_reset_audit` 表必须写入一条记录(operator/target/IP/UA)。

**已验证(2026-07-04):**
- admin 重置 primary 生成临时密码 `BY55bP8G4Ad3`,审计表写入 `admin|primary|temporary=1|127.0.0.1`。
- primary 用临时密码登录后访问 `/chat` 被 307 回 `/change-password`。
- 改密成功后 `password_change_audit` 写入一条 primary 的记录。

---

## 3. 聊天与历史

### 3.1 加载历史

- 登录 `primary`,左侧出现 3 条 fixture 会话(持仓风险快检 / 复盘最近一周 / 选股初筛)。
- 点击任一会话,右侧加载消息流;mock 在线时所有 fixture 消息可见。

### 3.2 发送新消息

- 选中会话,输入文本(Enter 或点击「发送」)。
- 期望:用户气泡立刻出现,~600ms 后助手气泡逐字渲染,带 `trace_mock_xxx`。
- 左侧会话被自动顶到最上,「X 条」计数 +2,最后一条预览更新。

### 3.3 新建会话

- 点击「+ 新建对话」,输入第一条消息发送。
- 期望:左侧立刻出现新条目,标题取首句。
- 刷新页面后会话仍在(mock 在线时由 mock 提供,mock 重启会丢内存数据)。

### 3.4 侧栏折叠

- 点击左上角「折叠侧栏」图标。
- 期望:侧栏收起,聊天区横向扩展。
- 再次点击展开,会话列表保持原状。

### 3.5 持久化(镜像)

- 发完几条消息后,检查 `data/portal.db`:
  ```bash
  sqlite3 data/portal.db "SELECT conversation_id, title, message_count FROM conversation_mirror;"
  sqlite3 data/portal.db "SELECT message_id, role, substr(content,1,40) FROM conversation_message_mirror LIMIT 10;"
  ```
- 期望:用户和助手的消息都已落库,刷新页面后从镜像读取,不依赖 mock。

---

## 4. 场景测试

切换 mock 场景前先 `kill` 旧的 mock 进程,再用对应 `npm run mock:<scenario>` 起新的。

### 4.1 online(默认)

- 助手状态:在线 · mock。
- 发消息 600ms 左右回。

### 4.2 slow

- `PORTAL_MOCK_SCENARIO=slow npm run dev:mock`。
- 助手仍显示在线,但单条消息要等 ~12s 才回。
- 适合验证前端 loading 态、用户耐心提示、超时配置。

**已验证(2026-07-04):** 一条消息 21:13:00 发出,大约 13s 后渲染回复。

### 4.3 failed

- `PORTAL_MOCK_SCENARIO=failed npm run dev:mock`。
- 用户消息会落地(显示「发送失败」),助手气泡显示「助手回复失败。」「点此重试」,trace 标记 `ACP_FAILED`。
- 重试按钮可点击,但 mock 仍 failed 时会再次失败。

### 4.4 offline(mock 进程关闭或 scenario=offline)

- 助手状态切换为「离线」,顶部出现提示条「助手暂时离线,可查看缓存历史,但无法发送消息」。
- 输入框被禁用,placeholder 变为「助手暂时离线,本地服务恢复后可继续」。
- 仍可点击侧栏查看镜像里的历史会话。
- 重启 mock(online)后,助手状态在 ~15s 内回到在线。

### 4.5 empty / paged

- `empty`:首次进入聊天页时,左侧没有任何会话,右侧显示空态文案。
- `paged`:测试 `nextCursor` 分页,首批返回 N 条,滚动/再次请求时拿到下一页。

---

## 5. 鉴权与越权

- 退出后访问 `/api/conversations` → 401 UNAUTHORIZED。
- 退出后访问 `/chat` → 307 回 `/login`。
- 用 admin 账号登录后访问 `/chat`,左侧看到的会话由 mock fixture 提供,但点击不属于 admin 的会话会被镜像层 403「无法访问该会话」拦下(`conv.user_id !== session.sub`)。

---

## 6. 已知限制

- Mock connector 的 fixture 完全在内存里,重启 mock 会丢新增的会话与消息;镜像 DB 中的内容仍然保留。
- Mock connector 与真实用户没有按 userId 强隔离;线上接入 `invest-agent-ideal` 后,每个用户应该跑自己的本地 connector,数据天然隔离。
- 当前没有管理员后台页面,重置密码通过 `POST /api/admin/reset-password` 调用。后续阶段会补 admin UI。
- 改密后页面跳转用 `router.replace("/chat")`,在个别 dev 热更新场景下可能停在「密码修改成功」提示页,直接刷新或重新打开 `/chat` 即可。

---

## 10. 文件生命周期与文档库（工作包 §13 桌面验收）

> 对应 `invest-agent-ideal` 仓库 `docs/portal-file-retention-and-library-governance-work-package.md` §13 的 11 项桌面浏览器验收。
> 验收日期：2026-07-25。所有用例在隔离 mock fixture 下跑过；桌面视口 1440×900 与 1920×1080。

### 环境准备

```bash
npm run seed                       # primary / admin
npm run dev                        # Next.js + Relay，:3100 / :3199
npm run dev:mock                   # 另一个终端，mock connector（online 场景）
```

mock connector 现在广播 `artifact.library.list` / `attachment.get` / `artifact.delete.prepare` / `artifact.delete.confirm` 能力，并提供 8 条精选文档库样例（覆盖日/周/月复盘、公司分析、指标图表 SVG、指标 CSV、记忆摘要、其他）、2 条附件样例（`mock_att_active` 活跃、`mock_att_expired` 已过期）以及内存版删除 token + 回收站。

### 已验证的协议契约（curl，against dev:mock）

| 断言 | 证据 |
| --- | --- |
| `GET /api/artifacts/library` 返回 8 条带 `category/downloadable/openRoute` 的项 | 200，items 覆盖 daily/weekly/monthly/company/metrics(×2)/memory/other |
| `GET /api/attachments/mock_att_expired` | 200，`status:"expired"`，无 `base64` |
| `GET /api/attachments/mock_att_active` | 200，`status:"active"`，含 `base64`+`storedAt`+`expiresAt` |
| `GET /api/attachments/unknown` | 404 `ATTACHMENT_NOT_FOUND` |
| `POST .../delete/prepare`（weekly） | 200，`impactNotes` 含「删除该复盘文件可能影响后续复盘的历史输入。」 |
| `POST .../delete/confirm`（有效 token） | 200，`deletedVersions:1`+`trashRelativePath`+`purgeAt` |
| 重放已完成的同一 token | 200，幂等返回首次删除结果 |
| 删除后 `artifact.library.list` | 该项不再出现 |
| 删除后 `GET /api/artifacts/<id>` | 410 `ARTIFACT_DELETED` |
| 未删除项 `GET /api/artifacts/<id>` | 200，含 `base64` |

### 11 项桌面浏览器验收步骤

1. **上传图片/文档，显示保留截止时间并可读取**：在 composer 上传一张图片并发送。助手回复后，用户消息的附件卡片显示「图片 · <size> · 保留至 <expiresAt>」。点击卡片 → `attachment.get` 返回字节，图片在 Lightbox 中打开（若为文档则触发下载）。
2. **跨过 7 天，附件卡片显示「已过期」，对话仍在**：mock 提供 `mock_att_expired`（已过期）。在任意会话构造一条 metadata 指向该 id 的消息，或直接在已过期的卡片上点击 → 卡片切到「附件已过期」灰态，移除查看/下载动作；对话消息正文与历史保留。
3. **文件树出现 backfill 的日/周/月、company、metrics、memory summary**：右侧文档工作区展开「文档库」树，应出现「日复盘/周复盘/月复盘/公司与财务分析/决策指标与图表/投资记忆摘要/其他产物」分组，含对应 mock 样例。
4. **文件树不出现 raw memory、financials、config、Skills、alerts 或用户附件**：树只列 mock fixture 的 8 项，没有任何 `memory/*.jsonl`、`financials/`、`config/`、`reports/alerts/` 或上传附件。
5. **打开 Markdown/HTML、多标签切换；AI 图片进 Lightbox；下载其他 durable 文件**：点击「2026-07-25 日复盘」→ 右侧打开标签；再点击「2026-07 月复盘」→ 第二个标签；点击标签栏切换，各标签滚动位置保留。点击「主力控盘指标图表」（image openRoute）→ 全屏 Lightbox。点击「决策指标数据表」（download openRoute）→ 触发下载，不新增标签。
6. **1 MiB 边界样本分别进入永久/临时路径**：由后端确定性分类（`DURABLE_LIBRARY_MAX_BYTES=1,048,576`，见 invest-agent-ideal `src/services/conversation-artifacts.ts`）。文件树中 `<=1 MiB` 的 curated 项可见；mock 暂未提供 >1 MiB 样例，边界分类已在后端 14 例测试中覆盖。
7. **删除一份非关键测试报告：确认弹窗、树/标签移除、历史卡片 deleted 状态**：在「其他产物示例」上点 ✕ → 弹窗显示 impactNotes；确认后该项从树消失、对应标签（若打开）关闭；若对话中有同 id 的 artifact 卡片，卡片变为「文件已删除」灰态。
8. **取消删除时没有任何状态变化**：点 ✕ 打开确认弹窗 → 点「取消」（或按 Esc）→ 树、标签、卡片均无变化；`deletedArtifactIds` 不变。
9. **删除周/月复盘类测试文件时显示「可能影响后续复盘」提示**：在「2026-W29 周复盘」上点 ✕ → 确认弹窗 impactNotes 中出现「删除该复盘文件可能影响后续复盘的历史输入。」。「公司与财务分析」类不出现该提示。
10. **connector 离线时删除禁用或明确失败，现有 UI 不永久 loading**：`PORTAL_MOCK_SCENARIO=offline npm run dev:mock` 重启 mock；`hasCapability` 因 `status.online=false` 返回 false → 文件树显示「文件目录暂时不可用」、删除按钮不出现、附件卡片不可点击；无 spinner 卡死。恢复 online → `refreshStatus` 重新拉取能力，树刷新。
11. **恢复 connector 后树刷新；跨 user/instance 看不到/删不了其他文件**：恢复 online 后右侧树重新加载 8 项。跨 scope 由后端强制：`artifact.delete.confirm` token 绑定 `user/instance/artifact/path/checksum`，伪造或跨用户 id 返回 `ATTACHMENT_NOT_FOUND`/`ARTIFACT_SCOPE_MISMATCH`（后端 `tests/file-retention.test.ts` 已覆盖）。

### 已知边界

- 本仓库无内置浏览器自动化测试框架。§13 的 11 项验收用三种互补证据覆盖：
  (a) 本节上面的手工步骤；
  (b) curl 级协议验证（见「已验证的协议契约」表）；
  (c) `scripts/acceptance-browser.mts` 无头 Chrome（playwright-core + 系统 Chrome）脚本，
      在 1440×900 与 1920×1080 两个桌面视口下驱动真实渲染页面逐项跑过第 1/2/3/4/5a/5b/5c/6/7/8/9/10/11 项
      （**28/28 子断言全 PASS**，2026-07-25；新增两种视口下的真实 CSV download 事件及“不新增标签”断言）。
      跑法：`npm run dev` + `npm run dev:mock`（online）→
      `npm run acceptance:browser`。
- 时间边界（7 天过期）通过 mock 的 `mock_att_expired` 固定样例完成，不依赖真实时钟。
- 1 MiB 边界（第 6 项）的永久/临时分类在后端 `tests/file-retention.test.ts` 用例 5 覆盖（精确到 `1,048,576` vs `1,048,577`）；浏览器侧通过文件树只展示 `<=1 MiB` curated 项间接体现。
- 生产只完成只读健康/schema 核查：Portal `/login` 返回 200，Runtime/Portal 与 111/dyk/mg connector 在线，相关 additive schema 已存在。
- 生产 Phase B 的 workspace/attachment backfill 尚未执行 `--apply`。2026-07-25 首次执行 `backfill --dry-run` 时发现旧 CLI 的 artifact 分类分支错误写入了 16 条分类；当前统计为 21 条、`durable=1`、`referenceOnly=20`、`unclassified=0`。该 dry-run 缺陷已在本地修复并补回归测试，但修复尚未发布。Phase C cleanup gate 仍为 disabled，cleanup/trash dry-run 均为 0；任何后续 apply 仍需运维另行确认。
- 当前生产代码来自未形成可复现提交的工作树；在 Runtime 与 Portal 的工作包改动分别形成可审查提交、从干净 release tree 发布前，不能把上述健康检查写成“工作包 release 已完成部署”。
