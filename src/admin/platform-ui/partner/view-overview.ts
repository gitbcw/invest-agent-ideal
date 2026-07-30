// Partner 视图：经营总览。
// 数据源：GET /api/platform/partner/overview
// 现状对等：4 统计卡 + 今日经营信号（6 项）+ 需要关注异常列表 + 「不含投资明细」声明。
// 增强（设计方案 §5.2）：异常区排序条（按 affectedCustomers 排序的可视化条）。

// 视图 DOM 骨架（服务端拼装，客户端填充 #partner-overview）。
export const OVERVIEW_HTML = `
<section class="view active" id="view-overview">
  <div id="partner-overview"><div class="loading">正在读取运营数据...</div></div>
</section>`;

// 客户端渲染逻辑字符串，注入页面后由 partner-app 的 loadView('overview') 调用。
export const OVERVIEW_JS = `
const loadOverview=async()=>{
  const data=await json('/api/platform/partner/overview');
  finishUpdated(data);
  const m=data.metrics||{};
  const cards=[['customersTotal','客户总数'],['activeCustomers7d','近 7 日活跃'],['onboardingCompleted','已完成初始配置'],['conversationCountToday','今日对话',true]].map(([k,label,signal])=>statCard(m[k],label,signal?{signal:true}:null)).join('');
  const signals=[['conversationSuccessRateToday','对话成功率',pct],['responseP50MsToday','响应 P50',formatMs],['responseP95MsToday','响应 P95',formatMs],['reviewCoverageToday','今日复盘覆盖率',pct],['pushDeliveryRateToday','推送送达率',pct],['qualityExceptionCountToday','质量异常',formatNum]];
  const signalList=signals.map(([k,label,fmt])=>'<div class="metric-row"><span>'+label+'</span><strong>'+fmt(m[k])+'</strong></div>').join('');
  // 需要关注：排序条（按 affectedCustomers 降序）。口径不变（取现有 exceptions[] 字段）。
  const exceptions=(data.exceptions||[]).slice().sort((a,b)=>(b.affectedCustomers||0)-(a.affectedCustomers||0));
  const total=exceptions.reduce((s,x)=>s+(x.affectedCustomers||0),0);
  const EXC_LABEL={onboarding_stuck:'初始化停滞',onboarding_exception:'初始化异常',push_failed:'推送失败',inactive_7d:'近 7 日无活跃'};
  const exceptHtml=exceptions.length?exceptions.map((item)=>{const dot=DOTS[item.type]||'<span class="ui-dot ui-dot-warn"></span>';return exceptBar(EXC_LABEL[item.type]||item.type,item.affectedCustomers||0,total,dot);}).join(''):'<div class="empty">暂无异常</div>';
  document.getElementById('partner-overview').innerHTML=
    '<div class="stats">'+cards+'</div>'+
    '<div class="grid">'+
      '<div class="panel"><div class="panel-head"><h2>今日运营信号</h2><span class="sub">'+escape(data.timeRange?.timezone||'Asia/Shanghai')+'</span></div><div class="panel-body"><div class="metric-list">'+signalList+'</div></div></div>'+
      '<div class="panel"><div class="panel-head"><h2>需要关注</h2></div><div class="panel-body">'+exceptHtml+'</div></div>'+
    '</div>';
};`;
