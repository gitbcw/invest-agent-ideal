# W2：用户方法与数据资产路径

依赖：W1。只改方法/资产领域服务、版本与绑定读模型和隔离测试；不做 Skill 市场、调度或真实迁移。

方法内容仍以 `user_assets`/版本链为 canonical bytes；Method 记录体系/分支、采用状态、版本引用、来源、Diff/恢复关系。批准且生效才产生正式版本；草稿不进入正式历史。多方法可并存，Agent/Task 必须绑定明确版本。历史默认不可发现，被 run/task/commitment 引用的版本必须可重现。去重/差异压缩不得影响逐版本读取。

验收：隔离库可创建、批准、更新、回退；小改动也形成正式版本；草稿不注入；固定版本读值正确；运行可回指版本；不通过 Workspace list/grep 选择方法；hash 变化、缺版本、冲突分支有明确失败或 degraded 结果。

交接 canonical source、读取模式、版本固定证据；W3/W4 只能引用 Method version，不复制正文。
