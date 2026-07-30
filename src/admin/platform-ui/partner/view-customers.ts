// Partner 视图：客户与助手。
// 数据源：GET /api/platform/partner/customers + /customers/:key/operations
// 现状对等：表格（7 列）+ limit=50 游标分页「加载更多」+ 「查看运营摘要」展开 12 项脱敏指标
//          + 「只显示运营状态，不含投资明细」声明。
// 增强（设计方案 §5.2）：顶部汇总卡组（健康度分布 / 初始配置分布 / 触达可达率），
//   口径=前端在已分页拉取的 state.customers 上按 health/onboardingStatus/wechatBound&pushReachable 计数。
//   全量拉取性能按待确认项①默认保留现状（与原实现一致，不优化）。

export const CUSTOMERS_HTML = `
<section class="view" id="view-customers">
  <div id="customersSummary"></div>
  <div class="panel">
    <div class="panel-head"><h2>客户与助手</h2><span class="sub">只显示运营状态，不含投资明细</span></div>
    <div class="panel-body" id="partner-customers"><div class="loading">正在读取客户状态...</div></div>
  </div>
  <div id="customerDetail" class="detail"></div>
</section>`;

export const CUSTOMERS_JS = `
const loadCustomers=async(cursor=null,append=false)=>{
  const data=await json('/api/platform/partner/customers?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  finishUpdated(data);
  state.customers=append?state.customers.concat(data.customers||[]):(data.customers||[]);
  // 前端聚合汇总卡（基于已加载的 state.customers）。
  const arr=state.customers;
  const healthBuckets={healthy:0,watch:0,critical:0,other:0};
  const onboardBuckets={completed:0,drafting:0,exception:0,other:0};
  let reachable=0;
  arr.forEach((it)=>{const h=healthBuckets[it.health]!=null?it.health:'other';healthBuckets[h]++;const o=onboardBuckets[it.onboardingStatus]!=null?it.onboardingStatus:'other';onboardBuckets[o]++;if(it.wechatBound&&it.pushReachable)reachable++;});
  const reachPct=arr.length?Math.round(reachable/arr.length*100):null;
  const total=arr.length||1;
  const summary='<div class="stats">'+
    statCard(arr.length,'已加载客户')+
    '<div class="stat"><span class="stat-value">'+escape(arr.length?Math.round(reachable/total*100)+'%':'-')+'</span><span class="stat-label">触达可达率</span></div>'+
    '<div class="stat"><span class="stat-value">'+escape(healthBuckets.healthy+'/'+healthBuckets.watch+'/'+healthBuckets.critical)+'</span><span class="stat-label">健康/关注/异常</span></div>'+
    '<div class="stat"><span class="stat-value">'+escape(onboardBuckets.completed+'/'+(onboardBuckets.drafting+onboardBuckets.other))+'</span><span class="stat-label">已配置/配置中</span></div>'+
  '</div>';
  document.getElementById('customersSummary').innerHTML=summary;
  const rows=state.customers.map((item,index)=>'<tr><td>'+escape(item.customerLabel)+'</td><td>'+statusBadge(item.onboardingStatus)+'</td><td>'+statusBadge(item.health)+'</td><td>'+escape(item.notificationPreference)+'</td><td class="tnum">'+escape(item.conversationCount7d)+'</td><td>'+statusBadge(item.lastPushStatus)+'</td><td><button class="link" data-customer="'+index+'">查看运营摘要</button></td></tr>').join('');
  const next=data.page?.nextCursor;
  document.getElementById('partner-customers').innerHTML=rows?
    '<div class="table-wrap"><table><thead><tr><th>客户</th><th>初始配置</th><th>健康度</th><th>通知偏好</th><th class="tnum">近 7 日对话</th><th>最近推送</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    (next?'<div class="pagination"><button class="btn btn-small" id="loadMoreCustomers">加载更多客户</button></div>':'')
    :'<div class="empty">暂无客户数据</div>';
  document.querySelectorAll('[data-customer]').forEach((button)=>button.addEventListener('click',()=>loadCustomerDetail(state.customers[Number(button.dataset.customer)])));
  document.getElementById('loadMoreCustomers')?.addEventListener('click',()=>loadCustomers(next,true));
};
const loadCustomerDetail=async(item)=>{
  if(!item)return;
  const data=await json('/api/platform/partner/customers/'+encodeURIComponent(item.customerKey)+'/operations');
  const c=data.customer||{},s=data.setup||{},u=data.usage||{},d=data.delivery||{},q=data.quality||{};
  const cells=[['初始配置',statusBadge(s.onboardingStatus)],['通知偏好',escape(s.notificationPreference)],['启用规则',escape(s.enabledRuleCount)],['近 7 日对话',escape(u.conversationCount7d)],['近 30 日复盘',escape(u.reviewCount30d)],['近 7 日推送',escape(u.pushCount7d)],['微信绑定',d.wechatBound?'已绑定':'未绑定'],['推送可达',d.pushReachable?'可达':'不可达'],['最近推送',statusBadge(d.lastPushStatus)],['超时',escape(q.timeoutCount7d)],['错误',escape(q.errorCount7d)],['重复确认',escape(q.repeatConfirmationCount7d)]];
  document.getElementById('customerDetail').innerHTML='<div class="panel"><div class="panel-head"><h2>'+escape(c.customerLabel)+'</h2><span class="sub">运营摘要</span></div><div class="panel-body"><div class="detail-grid">'+cells.map(([label,value])=>'<div class="detail-item"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</div></div></div>';
};`;
