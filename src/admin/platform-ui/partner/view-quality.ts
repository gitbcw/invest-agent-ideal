// Partner 视图：产品质量。
// 数据源：GET /api/platform/partner/quality
// 现状对等：metric-list（4 项质量指标，比率标注，部分可用标记）+ 「近 7 日聚合」声明。
// 增强（设计方案 §5.2）：顶部汇总卡行（成功/错误/超时/重复确认 count），口径取 items[] 现有字段。

export const QUALITY_HTML = `
<section class="view" id="view-quality">
  <div id="qualitySummary"></div>
  <div class="panel">
    <div class="panel-head"><h2>产品质量</h2><span class="sub">近 7 日聚合</span></div>
    <div class="panel-body" id="partner-quality"><div class="loading">正在读取质量指标...</div></div>
  </div>
</section>`;

export const QUALITY_JS = `
const loadQuality=async()=>{
  const data=await json('/api/platform/partner/quality');
  finishUpdated(data);
  const items=data.items||[];
  // 顶部汇总卡：按 type 取 count（口径不变，仅做汇总卡化）。
  const byType={};items.forEach((it)=>{byType[it.type]=it;});
  const find=(t)=>byType[t]||{};
  const summary='<div class="stats">'+
    statCard(find('conversation_success').count??'-','成功对话')+
    statCard(find('conversation_error').count??'-','错误')+
    statCard(find('conversation_timeout').count??'-','超时')+
    statCard(find('repeat_confirmation').count??'-','重复确认')+
  '</div>';
  document.getElementById('qualitySummary').innerHTML=summary;
  document.getElementById('partner-quality').innerHTML=listMetrics(data)+'<p class="note">指标按近 7 日聚合；数据缺失会标记为部分可用，不会以 0 代替。</p>';
};`;
