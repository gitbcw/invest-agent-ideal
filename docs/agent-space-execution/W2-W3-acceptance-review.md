# W2/W3 独立验收

日期：2026-09-20；提交W2=b3b7466、W3=de01155。结论：**两单元均Partial，暂不放行W4/W5接线。** 按各自范围定向返工，不重新实现W1，不部署、不迁移真实用户。

## 验证

- 重跑agent-space-domain.test.ts：25/25通过；未重复执行全仓715项/build，后者为执行方报告。
- 审查两提交、执行稿与交付文档；独立临时DB探针调用真实域服务复现下列三项，临时DB/模板/脚本均已清理。无生产操作。
- canonical user-assets读取、显式版本读模型、目录/安装/派生等有实质实现；测试通过不覆盖下面反例。

## W2-R1：历史定位被readopt绕过（P1，实测）

`methods.ts readoptMethodVersion`仅要求受约束版本由owner决定，却未像approve/resolve路径拒绝historical-not-default。

复现：建立正常current v1；添加v2并标historical-not-default；owner以adopt:false批准为历史正式版本；owner调用readopt(v2)。实际成功，current_version_id变为v2。后续运行resolver又拒绝它，导致当前方法不可运行。

修复：统一采用约束校验，history-only可以读取但不能成为current（owner通道也不能通过回退绕过）；失败时current/版本状态/凭证/审计均不变。测试普通授权和owner回退、正常历史恢复及幂等不受影响。不要靠恢复运行读取放行来修复。

## W3-R1：系统技能固定版本只有hash，没有固定字节（P1，实测）

`skills.ts readSkillVersionContentBytes`每次读取当前templates根下的system_template_path。发布与安装固定了versionId/hash，却未留存旧发布字节。

复现：s.md=old→发布默认v1→Agent安装v1；同路径改成new→发布v2；旧Agent读取已安装v1，实际AGENT_SPACE_VERSION_INVALID。checksum保护没有静默漂移，但旧版本不可继续使用，不满足已安装版本固定及默认升级不影响存量Agent。

修复：系统发布阶段形成不可变、受管理的内容引用（内容寻址或发布快照均可），模板仅为发布输入。保护被发布/安装/运行引用的字节，不要求每个Agent复制正文。测试更新原路径、删除原模板后旧安装仍读旧字节，新安装读新版本；快照篡改仍拒绝。增量迁移必须处理既有system_template版本，缺原字节明确阻塞，不能猜测重建。

## W3-R2：默认清单不是仅初始化（P1，实测）

`agents.ts applyDefaultSkillManifest`按每个skill是否曾安装判幂等，没有Agent级初始化完成标记或固定初始清单。

复现：Agent初始化仅默认S1；以后平台新增不同skillId的默认S2；对旧Agent重跑applyDefaultSkillManifest，新增1条安装记录，无用户授权。现有测试只覆盖同skill发布新版，漏了新增默认种类。

修复：初始分配为一次性的Agent配置事件/冻结清单，完成后新默认发布不能自动给存量Agent扩容；后续新增走明确授权安装。首次空清单也记录完成；初始化失败事务回滚，重试采用明确的一致语义；移除后不得复活。

## 非阻塞交接提醒

- W2当前diff是元数据级，不要对用户宣称已具备正文Diff界面。
- W3公共发布与task dependency的授权读取统一尚未完成，不把Skill能安装/读取升级为任务全链支持；W4前明确接线责任。
- 当前readSkillVersionContentBytes接受版本行对象，是内部底层函数；后续API不得直接把调用者构造的对象传入，应通过scoped安装/发布入口解析。

## 给执行Agent

> 分别修W2-R1、W3-R1/R2，保留现有通过的用例，增加三个真实反例及失败原子性断言；继续顺序窄提交，附迁移/存储与版本保留说明。不得改变用户已确认的历史/默认分配边界。独立验收通过后再进行W4/W5。

## 第二次验收：ee370dd（2026-09-20）

结论：**Pass with caveats；W2/W3本地服务阶段通过，放行W4，W5在W4接口稳定后推进。** 不授权生产发布、真实迁移或旧Workspace切换。

验证依据：

- 重跑域测试28/28通过；审查W2历史回退约束、内容存储与回填实现、Agent初始化标记/汇总审计事务。
- W2历史约束现在在事务内拒绝owner及普通授权回退；对应测试核对current、版本、凭证与审计不变，历史读取仍保留。
- 独立临时DB直接调用系统发布/安装/读取：同路径old→new发布，随后删除模板；旧Agent仍读old，新Agent读new。新增另一种默认技能后，存量Agent再初始化返回alreadyInitialized且零安装。已清理临时DB与文件。
- `npx tsc --noEmit`通过。全仓718项/build为执行方报告，本轮未重复执行。

三项前轮阻塞均关闭。保留以下阶段边界：

1. 内容存储为新增持久资产根，W6/W7须将其纳入备份、恢复和引用完整性验证；存在文件不等于hash正确，回填汇总不能单独替代逐版本读回验证。历史缺字节版本保持阻塞。
2. 默认分配完成标记已实现；W4创建Agent接线应保证一次初始化，迁入既有Agent不能因标记缺失重新扩容。失败重试以成功事务的默认集为准。
3. 公共发布授权与任务依赖解析仍需W4统一，不能把成功安装等同于任务装配已支持。底层内容读取函数只可由可信resolver调用。
4. 方法Diff当前为元数据级；不宣称正文Diff或Portal体验已经实现。W0待裁决项不因本次验收而获得采用授权。

下一阶段：按W4执行稿先固定交互/generic automation/其他scheduled的装配接口、运行依据与旧入口排除。W5可先提供显式空State Packet接口桩，需在证据中标明，不冒充状态闭环完成；W5随后按稳定契约接入。共享runtime/schema/core改动由同一负责人协调，不直接并行覆盖。
