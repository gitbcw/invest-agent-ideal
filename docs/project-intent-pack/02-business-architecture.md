# Business Architecture

```yaml
business_architecture:
  core_objects:
    - name: "workspace"
      responsibility: "承载用户私有投资方法、策略、复盘、记忆与配置"
    - name: "investment_model"
      responsibility: "承载用户完整投资闭环的主容器"
    - name: "trading_strategy"
      responsibility: "承载具体可执行的进出场规则"
    - name: "stock_plan"
      responsibility: "承载单只股票的落地预案与溯源"
    - name: "review_artifact"
      responsibility: "承载日/周/月复盘结果与观点验证"
    - name: "alert_rule / signal"
      responsibility: "承载巡检与触发条件"
  modules:
    - name: "WeChat bridge"
      business_role: "入口与路由"
      required: true
      replaceable_implementation: false
    - name: "workspace-scoped ACP agent"
      business_role: "复杂判断与工作流执行"
      required: true
      replaceable_implementation: true
    - name: "deterministic service APIs"
      business_role: "行情、落库、巡检、提醒、沙箱与查询"
      required: true
      replaceable_implementation: true
    - name: "workspace skills"
      business_role: "投资方法、复盘方法、筛选方法与输出纪律"
      required: true
      replaceable_implementation: true
    - name: "scheduler / push"
      business_role: "定时巡检与主动提醒"
      required: true
      replaceable_implementation: true
  flows:
    - name: "筛选到自选"
      steps:
        - "识别行业/题材/公司问题"
        - "做行业判断与候选收敛"
        - "输出理由、风险、观察条件"
        - "用户决定是否加入自选"
    - name: "持仓到预案"
      steps:
        - "读取持仓与行情"
        - "按策略或投资模型起草预案"
        - "先确认策略匹配，再确认预案草案"
        - "确认后才落库"
    - name: "预案到提醒到复盘"
      steps:
        - "巡检触发盘中提醒"
        - "收盘判断是否命中"
        - "日/周/月复盘验证前序观点"
        - "修正方法与策略"
  boundaries:
    in_scope:
      - "投资判断与工作流"
      - "事实、推断、确认分离"
      - "用户私有策略与模型沉淀"
    out_of_scope:
      - "自动交易"
      - "服务层固定写死投资方法"
      - "把旧代码结构当作未来业务结构"
```
