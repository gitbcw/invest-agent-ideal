// 成本统计（cost）视图。
// Owner：时间筛选 + 双 Tab（总览/各用户）+ Token 与费用汇总 + 按实例/日期表（含费用列）。
// Partner：仅总览统计（费用大盘），不渲染「各用户统计」Tab 与按客户拆分表（保护脱敏边界）。
// 费用口径见 pricing.ts：输入$5/输出$30/推理$5/Cache$0.5 每Mtok。
// IS_PARTNER 由 unified-app 注入（partner=true / owner=false）。

export const COST_JS = `
function initCostFromSelection(){const item=selectedInstance();selectedCostInstanceId=selectedCostInstanceId||item?.instanceId||'';if(ACTIVE_VIEW==='cost')loadCostPanel();}
async function loadCostPanel(){
  const days=document.getElementById('costDays')?.value||COST_FILTERS.days||'30';
  COST_FILTERS={days:String(days)};
  const root=document.getElementById('costPanel');
  if(root)root.innerHTML='<div class="empty">正在加载成本统计...</div>';
  try{
    const base=new URLSearchParams();base.set('days',days);
    // Partner 只取全平台总览（不带 instanceId/userId，不按客户拆）。
    if(IS_PARTNER){
      const platform=await platformJson('/api/platform/audit/usage?'+base.toString());
      COST={platform,scoped:platform,byInstance:null};
    }else{
      const selectedCostInstance=costInstanceById(selectedCostInstanceId);
      const userId=selectedCostInstance?.owner?.id||'';
      const instanceId=selectedCostInstance?.instanceId||'';
      const scoped=new URLSearchParams(base);if(userId)scoped.set('userId',userId);if(instanceId)scoped.set('instanceId',instanceId);
      const [platform,scopedUsage,byInstance]=await Promise.all([
        platformJson('/api/platform/audit/usage?'+base.toString()),
        platformJson('/api/platform/audit/usage?'+scoped.toString()),
        platformJson('/api/platform/audit/usage?'+withParam(base,'groupBy','instance')),
      ]);
      COST={platform,scoped:scopedUsage,byInstance};
    }
    renderCostPanel();
  }catch(error){document.getElementById('costPanel').innerHTML='<div class="error" style="display:block">成本统计加载失败: '+esc(error.message)+'</div>';}
}
function withParam(params,key,value){const next=new URLSearchParams(params);next.set(key,value);return next.toString();}
function costInstanceById(instanceId){return (DATA.instances||[]).find((item)=>item.instanceId===instanceId)||null;}
async function selectCostAssistant(instanceId){selectedCostInstanceId=instanceId||'';COST_TAB='users';await loadCostPanel();}
function renderCostPanel(){
  const platform=COST.platform;const scoped=COST.scoped;const root=document.getElementById('costPanel');
  if(!root||!platform||!scoped)return;
  document.getElementById('costUpdated').textContent='更新于 '+fmtTime(scoped.updatedAt);
  const filters=scoped.filters||{};
  const costScopeHint=document.getElementById('costScopeHint');
  if(costScopeHint)costScopeHint.textContent='最近 '+(filters.days||30)+' 天 · Codex 原生日志 · '+fmtRate(PRICING_RATES.input)+'/输出'+fmtRate(PRICING_RATES.output);
  if(IS_PARTNER){
    // Partner：强制总览，无 Tab、无按客户拆分。
    COST_TAB='overview';
    root.innerHTML=renderCostToolbar()+renderCostOverviewView(platform,scoped);
    return;
  }
  const selectedAssistant=costInstanceById(filters.instanceId||selectedCostInstanceId);
  const scopedTitle=selectedAssistant?'当前用户助手 Codex 用量：'+(selectedAssistant.owner?.displayName||selectedAssistant.owner?.id||selectedAssistant.name||selectedAssistant.instanceId):'当前用户助手 Codex 用量';
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
  const t=platform.codexUsage?.totals||{};
  return '<div class="section" style="margin-top:0"><h3>费用与 Token 用量</h3>'+
    '<div class="cost-summary">'+stat(fmtCost(totalCost(t)),'总费用')+stat(costOf(t.inputTokens,PRICING_RATES.input),'输入费用')+stat(costOf(t.outputTokens,PRICING_RATES.output),'输出费用')+stat(costOf(t.cachedReadTokens,PRICING_RATES.cacheRead),'Cache 费用')+'</div>'+
    '<div class="cost-source">'+badge('输入 '+fmtRate(PRICING_RATES.input),'info')+badge('输出 '+fmtRate(PRICING_RATES.output),'info')+badge('推理 '+fmtRate(PRICING_RATES.thought),'info')+badge('Cache '+fmtRate(PRICING_RATES.cacheRead)+'(输入1/10)','ok')+'</div>'+
    '<div class="cost-summary" style="margin-top:10px">'+renderCodexUsageSummary(t)+'</div>'+
    renderCodexUsageSource(t)+'</div>'+
    '<div class="section"><h3>Codex 原生日志按日期</h3>'+renderCodexUsageTable(platform.codexUsage?.groups||[],'日期')+'</div>';
}
function renderCostUsersView(scopedTitle,scoped){
  const t=scoped.codexUsage?.totals||{};
  return '<div class="section" style="margin-top:0"><h3>各用户助手 Codex 原生日志</h3>'+renderCodexAssistantTable(COST.byInstance?.codexUsage?.groups||[])+'</div>'+
    '<div class="section"><h3>'+esc(scopedTitle)+'</h3>'+
    '<div class="cost-summary">'+stat(fmtCost(totalCost(t)),'总费用')+stat(costOf(t.inputTokens,PRICING_RATES.input),'输入费用')+stat(costOf(t.outputTokens,PRICING_RATES.output),'输出费用')+stat(costOf(t.cachedReadTokens,PRICING_RATES.cacheRead),'Cache 费用')+'</div>'+
    '<div class="cost-summary" style="margin-top:10px">'+renderCodexUsageSummary(t)+'</div>'+renderCodexUsageSource(t)+'</div>'+
    '<div class="section"><h3>当前筛选 Codex 按日期</h3>'+renderCodexUsageTable(scoped.codexUsage?.groups||[],'日期')+'</div>';
}
function renderCodexAssistantTable(rows){if(!rows.length)return '<div class="empty">暂无 Codex 原生日志用量</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>用户助手</th><th>用户</th><th>事件数</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>缓存读取</th><th>费用</th></tr></thead><tbody>'+rows.map((row)=>{const assistant=costInstanceById(row.bucket);const selected=row.bucket===selectedCostInstanceId?' style="background:var(--brand-soft)"':'';const label=assistant?(assistant.name||assistant.instanceId):row.bucket;const userLabel=assistant?(assistant.owner?.displayName||assistant.owner?.id||'-'):'-';return '<tr'+selected+' onclick="selectCostAssistant(\\''+esc(row.bucket||'')+'\\')" style="cursor:pointer"><td><strong>'+esc(label||'-')+'</strong><div class="mono">'+esc(row.bucket||'-')+'</div></td><td>'+esc(userLabel)+'</td><td>'+esc(fmtNumber(row.calls))+'</td><td>'+esc(fmtNumber(row.totalTokens))+'</td><td>'+esc(fmtNumber(row.inputTokens))+'</td><td>'+esc(fmtNumber(row.outputTokens))+'</td><td>'+esc(fmtNumber(row.thoughtTokens))+'</td><td>'+esc(fmtNumber(row.cachedReadTokens))+'</td><td class="tnum"><strong>'+fmtCost(totalCost(row))+'</strong></td></tr>';}).join('')+'</tbody></table></div>';}
function renderCodexUsageSummary(totals){return [stat(fmtNumber(totals.totalTokens),'Codex 总 Token'),stat(fmtNumber(totals.inputTokens),'输入 Token'),stat(fmtNumber(totals.outputTokens),'输出 Token'),stat(fmtNumber(totals.thoughtTokens),'推理 Token'),stat(fmtNumber(totals.cachedReadTokens),'缓存读取')].join('');}
function renderCodexUsageSource(totals){return '<div class="cost-source">'+badge('token_count events '+fmtNumber(totals.calls||0),'ok')+badge('来源 模型会话日志','info')+badge('不区分对话/推送','warn')+'</div>';}
function renderCodexUsageTable(rows,firstLabel){if(!rows.length)return '<div class="empty">暂无 Codex 原生日志用量</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>'+esc(firstLabel)+'</th><th>事件数</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>缓存读取</th><th>费用</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td class="mono">'+esc(row.bucket||'-')+'</td><td>'+esc(fmtNumber(row.calls))+'</td><td>'+esc(fmtNumber(row.totalTokens))+'</td><td>'+esc(fmtNumber(row.inputTokens))+'</td><td>'+esc(fmtNumber(row.outputTokens))+'</td><td>'+esc(fmtNumber(row.thoughtTokens))+'</td><td>'+esc(fmtNumber(row.cachedReadTokens))+'</td><td class="tnum"><strong>'+fmtCost(totalCost(row))+'</strong></td></tr>').join('')+'</tbody></table></div>';}
`;
