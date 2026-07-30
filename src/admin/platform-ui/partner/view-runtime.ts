// Partner 视图：运行与触达。
// 数据源：GET /api/platform/partner/runtime-health
// 现状对等：metric-list（3 项运行触达状态）+ 「不含消息正文/账号标识/管理操作」声明。
// 增强（设计方案 §5.2）：顶部汇总卡行（可触达/推送失败/行情数据异常），口径取 items[] 现有字段。

export const RUNTIME_HTML = `
<section class="view" id="view-runtime">
  <div id="runtimeSummary"></div>
  <div class="panel">
    <div class="panel-head"><h2>运行与触达</h2><span class="sub">当前运行状态摘要</span></div>
    <div class="panel-body" id="partner-runtime"><div class="loading">正在读取运行状态...</div></div>
  </div>
</section>`;

export const RUNTIME_JS = `
const loadRuntime=async()=>{
  const data=await json('/api/platform/partner/runtime-health');
  finishUpdated(data);
  const items=data.items||[];
  const byType={};items.forEach((it)=>{byType[it.type]=it;});
  const find=(t)=>byType[t]||{};
  // 顶部汇总卡：wechat_reachability count / push_delivery count(失败) / market_data count。
  const summary='<div class="stats">'+
    statCard(find('wechat_reachability').count??'-','微信可触达')+
    statCard(find('push_delivery').count??'-','推送失败')+
    statCard(find('market_data').count??'-','行情数据异常')+
  '</div>';
  document.getElementById('runtimeSummary').innerHTML=summary;
  document.getElementById('partner-runtime').innerHTML=listMetrics(data)+'<p class="note">这里只展示运行与触达状态摘要，不包含消息正文、账号标识或管理操作。</p>';
};`;
