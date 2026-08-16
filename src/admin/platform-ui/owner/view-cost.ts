// 成本统计（cost）视图。
// Owner：时间筛选 + 双 Tab（总览/各用户）+ Token 与费用汇总 + 按实例/日期/模型表。
// Partner：仅总览统计（费用大盘），不渲染「各用户统计」Tab 与按客户拆分明细（保护脱敏边界）。
// 费用口径（E10）：全部读服务端聚合的 costAmount（trace 写入时按 model-pricing 注册表计价落库）；
// 当前生效费率由 usage API 的 pricing 摘要下发，本视图不含任何客户端费率表。

export const COST_JS = `
function initCostFromSelection(){const item=selectedInstance();selectedCostInstanceId=selectedCostInstanceId||item?.instanceId||'';if(ACTIVE_VIEW==='cost')loadCostPanel();}
async function loadCostPanel(){
  const days=document.getElementById('costDays')?.value||COST_FILTERS.days||'30';
  COST_FILTERS={days:String(days)};
  const root=document.getElementById('costPanel');
  if(root)root.innerHTML='<div class="empty">正在加载成本统计...</div>';
  try{
    const base=new URLSearchParams();base.set('days',days);
    // Partner：总览 + 按客户脱敏拆分（cus_xxx，不暴露 instanceId）。
    if(IS_PARTNER){
      const [platform,byInstance,byModel]=await Promise.all([
        platformJson('/api/platform/audit/usage?'+base.toString()),
        platformJson('/api/platform/audit/usage?'+withParam(base,'groupBy','instance')),
        platformJson('/api/platform/audit/usage?'+withParam(base,'groupBy','model')),
      ]);
      COST={platform,scoped:platform,byInstance,byModel};
    }else{
      const selectedCostInstance=costInstanceById(selectedCostInstanceId);
      const userId=selectedCostInstance?.owner?.id||'';
      const instanceId=selectedCostInstance?.instanceId||'';
      const scoped=new URLSearchParams(base);if(userId)scoped.set('userId',userId);if(instanceId)scoped.set('instanceId',instanceId);
      const [platform,scopedUsage,byInstance,byModel]=await Promise.all([
        platformJson('/api/platform/audit/usage?'+base.toString()),
        platformJson('/api/platform/audit/usage?'+scoped.toString()),
        platformJson('/api/platform/audit/usage?'+withParam(base,'groupBy','instance')),
        platformJson('/api/platform/audit/usage?'+withParam(base,'groupBy','model')),
      ]);
      COST={platform,scoped:scopedUsage,byInstance,byModel};
    }
    renderCostPanel();
  }catch(error){document.getElementById('costPanel').innerHTML='<div class="error" style="display:block">成本统计加载失败: '+esc(error.message)+'</div>';}
}
function withParam(params,key,value){const next=new URLSearchParams(params);next.set(key,value);return next.toString();}
function costInstanceById(instanceId){return (DATA.instances||[]).find((item)=>item.instanceId===instanceId)||null;}
async function selectCostAssistant(instanceId){selectedCostInstanceId=instanceId||'';COST_TAB='users';await loadCostPanel();}
function fmtCost(v){return '¥'+Number(v||0).toFixed(2);}
function pricingBadges(pricing){
  if(!pricing)return '';
  const tierOf=(t)=>'输入 '+fmtRate(t.input)+' · 输出 '+fmtRate(t.output)+' · 推理 '+fmtRate(t.thought)+' · 缓存读 '+fmtRate(t.cacheRead);
  const parts=pricing.models.map((m)=>badge(esc(m.model)+': '+tierOf(m.tier),'info')).join('');
  return '<div class="cost-source">'+parts+badge('其他模型兜底: '+tierOf(pricing.defaultTier)+'（人民币计价）','ok')+'</div>';
}
function fmtRate(r){return '¥'+Number(r)+'/M';}
function renderCostPanel(){
  const platform=COST.platform;const scoped=COST.scoped;const root=document.getElementById('costPanel');
  if(!root||!platform||!scoped)return;
  document.getElementById('costUpdated').textContent='更新于 '+fmtTime(scoped.updatedAt);
  const filters=scoped.filters||{};
  const costScopeHint=document.getElementById('costScopeHint');
  if(costScopeHint)costScopeHint.textContent='最近 '+(filters.days||30)+' 天 · trace 费用为写入时按模型计价落库（服务端口径）';
  if(IS_PARTNER){
    COST_TAB='overview';
    root.innerHTML=renderCostToolbar()+renderCostOverviewView(platform,scoped)+'<div class="section"><h3>按模型</h3>'+renderAgentUsageTable(COST.byModel?.agentUsage?.groups||[],'模型')+'</div><div class="section"><h3>按客户费用分摊</h3>'+renderPartnerCostByCustomer(COST.byInstance?.agentUsage?.groups||[])+'</div>';
    return;
  }
  const selectedAssistant=costInstanceById(filters.instanceId||selectedCostInstanceId);
  const scopedTitle=selectedAssistant?'当前用户助手 Agent 用量：'+(selectedAssistant.owner?.displayName||selectedAssistant.owner?.id||selectedAssistant.name||selectedAssistant.instanceId):'当前用户助手 Agent 用量';
  root.innerHTML=renderCostToolbar()+renderCostTabs()+(COST_TAB==='users'?renderCostUsersView(scopedTitle,scoped):renderCostOverviewView(platform,scoped));
}
function renderCostToolbar(){
  const days=String(COST_FILTERS.days||COST.scoped?.filters?.days||'30');
  return '<div class="cost-toolbar"><div class="field"><label>时间</label><select id="costDays" class="select" onchange="loadCostPanel()">'+costOption('7','最近 7 天',days)+costOption('30','最近 30 天',days)+costOption('90','最近 90 天',days)+costOption('365','最近 365 天',days)+'</select></div><button class="btn btn-primary" onclick="loadCostPanel()">刷新</button><div class="muted">'+(IS_PARTNER?'全平台 Token 与费用大盘':'统计当前有效用户；用户助手切换在“各用户统计”中完成。')+'</div></div>';
}
function costOption(value,label,current){return '<option value="'+esc(value)+'"'+(String(value)===String(current)?' selected':'')+'>'+esc(label)+'</option>';}
function setCostTab(tab){COST_TAB=tab==='users'?'users':'overview';renderCostPanel();}
function renderCostTabs(){return '<div class="tabs"><button class="tab '+(COST_TAB==='overview'?'active':'')+'" onclick="setCostTab(\\'overview\\')">总览统计</button><button class="tab '+(COST_TAB==='users'?'active':'')+'" onclick="setCostTab(\\'users\\')">各用户统计</button></div>';}
function renderCostOverviewView(platform,scoped){
  const t=platform.agentUsage?.totals||{};
  return '<div class="section" style="margin-top:0"><h3>费用与 Token 用量</h3>'+
    '<div class="cost-summary">'+stat(fmtCost(t.costAmount),'总费用')+stat(fmtNumber(t.calls),'回合数')+stat(fmtNumber(t.inputTokens),'输入 Token')+stat(fmtNumber(t.outputTokens),'输出 Token')+stat(fmtNumber(t.cachedReadTokens),'缓存读取')+'</div>'+
    pricingBadges(platform.agentUsage?.pricing)+
    '<div class="cost-summary" style="margin-top:10px">'+renderAgentUsageSummary(t)+'</div>'+
    renderAgentUsageSource(t)+'</div>'+
    '<div class="section"><h3>Agent trace 按日期</h3>'+renderAgentUsageTable(platform.agentUsage?.groups||[],'日期')+'</div>'+
    '<div class="section"><h3>Agent trace 按模型</h3>'+renderAgentUsageTable(COST.byModel?.agentUsage?.groups||[],'模型')+'</div>';
}
function renderCostUsersView(scopedTitle,scoped){
  const t=scoped.agentUsage?.totals||{};
  return '<div class="section" style="margin-top:0"><h3>各用户助手 Agent trace</h3>'+renderAgentAssistantTable(COST.byInstance?.agentUsage?.groups||[])+'</div>'+
    '<div class="section"><h3>'+esc(scopedTitle)+'</h3>'+
    '<div class="cost-summary">'+stat(fmtCost(t.costAmount),'总费用')+stat(fmtNumber(t.inputTokens),'输入 Token')+stat(fmtNumber(t.outputTokens),'输出 Token')+stat(fmtNumber(t.cachedReadTokens),'缓存读取')+'</div>'+
    pricingBadges(scoped.agentUsage?.pricing)+
    '<div class="cost-summary" style="margin-top:10px">'+renderAgentUsageSummary(t)+'</div>'+renderAgentUsageSource(t)+'</div>'+
    '<div class="section"><h3>当前筛选 Agent trace 按日期</h3>'+renderAgentUsageTable(scoped.agentUsage?.groups||[],'日期')+'</div>';
}
// Shared usage renderers (restored 2026-08-15: the eade549 codex→agent
// rename sweep deleted these definitions while renaming the call sites,
// leaving the cost panel broken; cost column now reads the server-side
// trace cost instead of client-side token math).
function renderAgentAssistantTable(rows){if(!rows.length)return '<div class="empty">暂无 Agent trace 用量</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>用户助手</th><th>用户</th><th>事件数</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>缓存读取</th><th>费用</th></tr></thead><tbody>'+rows.map((row)=>{const assistant=costInstanceById(row.bucket);const selected=row.bucket===selectedCostInstanceId?' style="background:var(--brand-soft)"':'';const label=assistant?(assistant.name||assistant.instanceId):row.bucket;const userLabel=assistant?(assistant.owner?.displayName||assistant.owner?.id||'-'):'-';return '<tr'+selected+' onclick="selectCostAssistant(\\''+esc(row.bucket||'')+'\\')" style="cursor:pointer"><td><strong>'+esc(label||'-')+'</strong><div class="mono">'+esc(row.bucket||'-')+'</div></td><td>'+esc(userLabel)+'</td><td>'+esc(fmtNumber(row.calls))+'</td><td>'+esc(fmtNumber(row.totalTokens))+'</td><td>'+esc(fmtNumber(row.inputTokens))+'</td><td>'+esc(fmtNumber(row.outputTokens))+'</td><td>'+esc(fmtNumber(row.thoughtTokens))+'</td><td>'+esc(fmtNumber(row.cachedReadTokens))+'</td><td class="tnum"><strong>'+fmtCost(row.costAmount)+'</strong></td></tr>';}).join('')+'</tbody></table></div>';}
function renderAgentUsageSummary(totals){return [stat(fmtNumber(totals.totalTokens),'Agent 总 Token'),stat(fmtNumber(totals.inputTokens),'输入 Token'),stat(fmtNumber(totals.outputTokens),'输出 Token'),stat(fmtNumber(totals.thoughtTokens),'推理 Token'),stat(fmtNumber(totals.cachedReadTokens),'缓存读取')].join('');}
function renderAgentUsageSource(totals){return '<div class="cost-source">'+badge('agent traces '+fmtNumber(totals.calls||0),'ok')+badge('来源 agent_traces','info')+(totals.unpricedCalls?badge('未入册模型 '+fmtNumber(totals.unpricedCalls)+' 回合（兜底费率）','warn'):'')+(totals.estimatedCalls?badge('估算回合 '+fmtNumber(totals.estimatedCalls),'warn'):'')+'</div>';}
function renderAgentUsageTable(rows,firstLabel){if(!rows.length)return '<div class="empty">暂无 Agent trace 用量</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>'+esc(firstLabel)+'</th><th>事件数</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>缓存读取</th><th>费用</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td class="mono">'+esc(row.bucket||'-')+'</td><td>'+esc(fmtNumber(row.calls))+'</td><td>'+esc(fmtNumber(row.totalTokens))+'</td><td>'+esc(fmtNumber(row.inputTokens))+'</td><td>'+esc(fmtNumber(row.outputTokens))+'</td><td>'+esc(fmtNumber(row.thoughtTokens))+'</td><td>'+esc(fmtNumber(row.cachedReadTokens))+'</td><td class="tnum"><strong>'+fmtCost(row.costAmount)+'</strong></td></tr>').join('')+'</tbody></table></div>';}
// Partner 专属：按客户脱敏的费用分摊表（cus_xxx 标识，无明文 instanceId/用户）。
function renderPartnerCostByCustomer(rows){
  if(!rows.length)return '<div class="empty">暂无按客户的费用分摊数据</div>';
  const totalCostAll=rows.reduce((s,r)=>s+Number(r.costAmount||0),0);
  return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>客户</th><th>总 Token</th><th>输入</th><th>输出</th><th>缓存读取</th><th>费用</th><th>占比</th></tr></thead><tbody>'+
    rows.map((row)=>{
      const pct=totalCostAll>0?(Number(row.costAmount||0)/totalCostAll*100).toFixed(1)+'%':'-';
      return '<tr><td><strong>'+esc(row.customerLabel||row.bucket||'-')+'</strong><div class="mono">'+esc(row.bucket||'-')+'</div></td><td>'+esc(fmtNumber(row.totalTokens))+'</td><td>'+esc(fmtNumber(row.inputTokens))+'</td><td>'+esc(fmtNumber(row.outputTokens))+'</td><td>'+esc(fmtNumber(row.cachedReadTokens))+'</td><td class="tnum"><strong>'+fmtCost(row.costAmount)+'</strong></td><td class="tnum">'+pct+'</td></tr>';
    }).join('')+'</tbody></table></div>';
}
`;
