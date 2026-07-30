// Owner 视图 E：规则巡检（rule-alerts）。
// 含：用户/助手/条数筛选 + 运行总览 + 最近运行表 + 最近命中事件表 + 启用规则表。

export const RULES_JS = `
async function loadRuleAlerts(){
  const userId=document.getElementById('ruleAlertUser')?.value||'';
  const instanceId=document.getElementById('ruleAlertInstance')?.value||'';
  const limit=document.getElementById('ruleAlertLimit')?.value||'30';
  const params=new URLSearchParams();if(userId)params.set('userId',userId);if(instanceId)params.set('instanceId',instanceId);params.set('limit',limit);
  try{
    RULE_ALERTS=await platformJson('/api/platform/rule-alerts?'+params.toString());
    if(!RULE_ALERTS.ok)throw new Error(RULE_ALERTS.error||'规则巡检接口返回失败');
    renderRuleAlertControls();renderRuleAlertPanel();
  }catch(error){document.getElementById('ruleAlertPanel').innerHTML='<div class="error" style="display:block">规则巡检加载失败: '+esc(error.message)+'</div>';}
}
function initRuleAlertsFromSelection(){
  const item=selectedInstance();
  if(!document.getElementById('ruleAlertUser'))return;
  if(item){document.getElementById('ruleAlertUser').innerHTML='<option value="'+esc(item.owner?.id||'')+'">'+esc(item.owner?.displayName||item.owner?.id||'')+'</option>';document.getElementById('ruleAlertInstance').innerHTML='<option value="'+esc(item.instanceId)+'">'+esc(item.name||item.instanceId)+'</option>';}
  if(ACTIVE_VIEW==='rule-alerts')loadRuleAlerts();
}
function renderRuleAlertControls(){
  const userSelect=document.getElementById('ruleAlertUser');const instanceSelect=document.getElementById('ruleAlertInstance');
  if(!userSelect||!instanceSelect)return;
  const selectedUser=RULE_ALERTS.filters?.userId||userSelect.value||'';
  const selectedInstance=RULE_ALERTS.filters?.instanceId||instanceSelect.value||'';
  userSelect.innerHTML='<option value="">全部用户</option>'+(RULE_ALERTS.users||[]).map((user)=>'<option value="'+esc(user.id)+'"'+(user.id===selectedUser?' selected':'')+'>'+esc(user.displayName||user.id)+' · '+esc(user.id)+'</option>').join('');
  instanceSelect.innerHTML='<option value="">全部用户助手</option>'+(RULE_ALERTS.instances||[]).map((item)=>'<option value="'+esc(item.instanceId)+'"'+(item.instanceId===selectedInstance?' selected':'')+'>'+esc(item.name||item.instanceId)+' · '+esc(item.instanceId)+'</option>').join('');
  document.getElementById('ruleAlertUpdated').textContent='更新于 '+fmtTime(RULE_ALERTS.updatedAt);
  document.getElementById('ruleAlertScopeHint').textContent='采样间隔 '+(RULE_ALERTS.intervalMinutes||'-')+' 分钟';
}
async function onRuleAlertUserChange(){const instanceSelect=document.getElementById('ruleAlertInstance');if(instanceSelect)instanceSelect.value='';await loadRuleAlerts();}
function renderRuleAlertPanel(){
  const root=document.getElementById('ruleAlertPanel');
  if(!root||!RULE_ALERTS.ok)return;
  const summary=RULE_ALERTS.summary||{};
  root.innerHTML=
    '<div class="section" style="margin-top:0"><h3>运行总览</h3><div class="cost-summary">'+stat(fmtNumber(RULE_ALERTS.intervalMinutes),'采样间隔(分钟)')+stat(fmtNumber(summary.enabledRules),'启用规则')+stat(fmtNumber(summary.todayRuns),'今日运行')+stat(fmtNumber(summary.todayHits),'今日命中')+stat(fmtNumber(summary.todayErrors),'今日错误')+'</div><div class="cost-source">'+badge('独立确定性任务','info')+badge('只判断采样当刻价格/事实','ok')+badge('不依赖定时简报','warn')+'</div></div>'+
    '<div class="section"><h3>最近运行</h3>'+renderRuleAlertTaskTable(RULE_ALERTS.tasks||[])+'</div>'+
    '<div class="section"><h3>最近命中事件</h3>'+renderRuleAlertEventTable(RULE_ALERTS.events||[])+'</div>'+
    '<div class="section"><h3>启用规则</h3>'+renderRuleAlertRuleTable(RULE_ALERTS.rules||[])+'</div>';
}
function renderRuleAlertTaskTable(rows){if(!rows.length)return '<div class="empty">暂无独立规则巡检运行记录；服务启动后会按采样间隔生成。</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>时间</th><th>用户</th><th>助手</th><th>采样槽</th><th>状态</th><th>推送</th><th>错误</th></tr></thead><tbody>'+rows.map((row)=>{const statusKind=row.status==='success'?'ok':(row.status==='error'?'warn':'gray');return '<tr><td>'+esc(fmtTime(row.createdAt))+'</td><td class="mono">'+esc(row.userId||'-')+'</td><td class="mono">'+esc(row.instanceId||'-')+'</td><td class="mono">'+esc(row.scheduledFor||'-')+'</td><td>'+badge(row.status||'-',statusKind)+'</td><td class="mono">'+esc(row.pushJobId||'-')+'</td><td>'+esc(row.errorMessage||'-')+'</td></tr>';}).join('')+'</tbody></table></div>';}
function renderRuleAlertEventTable(rows){if(!rows.length)return '<div class="empty">暂无规则命中事件</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>时间</th><th>用户</th><th>股票</th><th>规则</th><th>价格</th><th>级别</th><th>状态</th><th>消息</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td>'+esc(fmtTime(row.createdAt))+'</td><td class="mono">'+esc(row.userId||'-')+'</td><td><strong>'+esc(row.stockName||'-')+'</strong><div class="mono">'+esc(row.stockCode||'-')+'</div></td><td class="mono">'+esc(row.signalKey||'-')+'</td><td>'+esc(row.price==null?'-':row.price)+'</td><td>'+badge(row.severity||'-',row.severity==='high'?'warn':'gray')+'</td><td>'+esc(row.status||'-')+'</td><td>'+esc(row.message||'-')+'</td></tr>').join('')+'</tbody></table></div>';}
function renderRuleAlertRuleTable(rows){if(!rows.length)return '<div class="empty">暂无规则实例</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>规则</th><th>用户</th><th>股票</th><th>条件</th><th>参数</th><th>去重</th><th>启用</th><th>更新时间</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td><strong>#'+esc(row.id)+'</strong><div class="mono">'+esc(row.indicatorKey||'-')+'</div></td><td class="mono">'+esc(row.userId||'-')+'</td><td><strong>'+esc(row.stockName||'-')+'</strong><div class="mono">'+esc(row.stockCode||'-')+'</div></td><td class="mono">'+esc(row.condition||'-')+'</td><td class="mono">'+esc(row.params||'{}')+'</td><td class="mono">'+esc(row.dedupePolicy||'{}')+'</td><td>'+badge(row.enabled?'启用':'停用',row.enabled?'ok':'gray')+'</td><td>'+esc(fmtTime(row.updatedAt))+'</td></tr>').join('')+'</tbody></table></div>';}
`;
