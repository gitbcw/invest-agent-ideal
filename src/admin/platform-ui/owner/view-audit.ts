// Owner 视图 D：日志审计（audit）。
// 含：对话/推送 scope 切换 + 用户/助手/条数筛选 + 时间线（原始 vs 清洗双列对比 + 技术字段 + token/cost badge）。

export const AUDIT_JS = `
function setAuditScope(scope){AUDIT_SCOPE=scope==='push'?'push':(scope==='automation'?'automation':'conversation');renderAuditScope();loadAudit();}
function renderAuditScope(){
  const segmented=document.querySelector('#auditScopePush')?.parentElement;
  if(segmented&&!document.getElementById('auditScopeAutomation')){const button=document.createElement('button');button.id='auditScopeAutomation';button.className='segment';button.textContent='自动化任务';button.onclick=()=>setAuditScope('automation');segmented.appendChild(button);}
  const isPush=AUDIT_SCOPE==='push';const isAutomation=AUDIT_SCOPE==='automation';
  document.getElementById('auditScopeConversation')?.classList.toggle('active',!isPush);
  document.getElementById('auditScopePush')?.classList.toggle('active',isPush);
  document.getElementById('auditScopeAutomation')?.classList.toggle('active',isAutomation);
  document.getElementById('auditScopeHint').textContent=isPush?'推送审计':(isAutomation?'自动化任务':'对话审计');
  document.getElementById('auditTimelineTitle').textContent=isPush?'推送时间线':(isAutomation?'自动化运行历史':'对话时间线');
  document.getElementById('auditHelp').textContent=isPush?'推送审计查看主动推送入队正文、调度任务状态和关联的 scheduler LLM trace。':(isAutomation?'自动化任务查看每次运行、失败分类、重试属性和交付状态。':'对话审计查看微信/Web 用户消息进入 Codex 后的原始回复、清洗回复和入站提示。');
}
async function loadAudit(){
  const userId=document.getElementById('auditUser')?.value||'';
  const instanceId=document.getElementById('auditInstance')?.value||'';
  const limit=document.getElementById('auditLimit')?.value||'30';
  const params=new URLSearchParams();if(userId)params.set('userId',userId);if(instanceId)params.set('instanceId',instanceId);params.set('limit',limit);params.set('scope',AUDIT_SCOPE);
  try{
    const res=await fetch((AUDIT_SCOPE==='automation'?'/api/platform/automation-runs?':'/api/platform/audit?')+params.toString());
    AUDIT=await res.json();
    if(!AUDIT.ok)throw new Error(AUDIT.error||'审计接口返回失败');
    AUDIT_SCOPE=AUDIT_SCOPE==='automation'?'automation':(AUDIT.filters?.scope==='push'?'push':'conversation');
    renderAuditScope();renderAuditControls();renderAuditTimeline();
  }catch(error){document.getElementById('auditTimeline').innerHTML='<div class="error" style="display:block">审计加载失败: '+esc(error.message)+'</div>';}
}
function initAuditFromSelection(){
  const item=selectedInstance();
  if(!document.getElementById('auditUser'))return;
  if(item){document.getElementById('auditUser').innerHTML='<option value="'+esc(item.owner?.id||'')+'">'+esc(item.owner?.displayName||item.owner?.id||'')+'</option>';document.getElementById('auditInstance').innerHTML='<option value="'+esc(item.instanceId)+'">'+esc(item.name||item.instanceId)+'</option>';}
  loadAudit();
}
function renderAuditControls(){
  const userSelect=document.getElementById('auditUser');const instanceSelect=document.getElementById('auditInstance');
  if(!userSelect||!instanceSelect)return;
  const selectedUser=AUDIT.filters?.userId||userSelect.value||'';
  const selectedInstance=AUDIT.filters?.instanceId||instanceSelect.value||'';
  userSelect.innerHTML='<option value="">全部用户</option>'+(AUDIT.users||[]).map((user)=>'<option value="'+esc(user.id)+'"'+(user.id===selectedUser?' selected':'')+'>'+esc(user.displayName||user.id)+' · '+esc(user.id)+'</option>').join('');
  instanceSelect.innerHTML='<option value="">全部用户助手</option>'+(AUDIT.instances||[]).map((item)=>'<option value="'+esc(item.instanceId)+'"'+(item.instanceId===selectedInstance?' selected':'')+'>'+esc(item.name||item.instanceId)+' · '+esc(item.instanceId)+'</option>').join('');
  document.getElementById('auditUpdated').textContent='更新于 '+fmtTime(AUDIT.updatedAt)+' · '+(AUDIT_SCOPE==='push'?'推送审计':'对话审计');
}
async function onAuditUserChange(){const instanceSelect=document.getElementById('auditInstance');if(instanceSelect)instanceSelect.value='';await loadAudit();}
function renderAuditTimeline(){
  const root=document.getElementById('auditTimeline');
  const items=AUDIT.items||[];
  AUDIT_ITEM_BY_ID=Object.fromEntries(items.map((item)=>[String(item.id),item]));
  if(!items.length){root.innerHTML='<div class="empty">暂无审计记录</div>';return;}
  root.innerHTML='<div class="audit-list">'+items.map(renderAuditItem).join('')+'</div>';
}
function kindBadge(kind){if(kind==='push_run')return badge('推送链路','info');if(kind==='trace')return badge(AUDIT_SCOPE==='push'?'调度追踪':'对话追踪','info');if(kind==='push')return badge('微信推送','ok');if(kind==='task')return badge('任务','gray');return badge(kind||'-','gray');}
function renderAuditItem(item){
  if(AUDIT_SCOPE==='automation')return renderAutomationItem(item);
  const when=formatAuditTime(item.createdAt);
  const statusKind=item.status==='success'||item.status==='sent'?'ok':(item.status==='error'||item.status==='dead'?'warn':'gray');
  const meta=[item.userId?['user',item.userId]:null,item.instanceId?['instance',item.instanceId]:null,item.conversationId?['conversation',item.conversationId]:null,item.elapsedMs?['elapsed',item.elapsedMs+'ms']:null,item.totalTokens?['tokens',fmtNumber(item.totalTokens)]:null,item.usageSource?['usage',item.usageSource]:null,item.pushJobId?['pushJob',item.pushJobId]:null].filter(Boolean);
  const primaryText=item.kind==='push'?item.replyTextSanitized:(item.replyTextRaw||item.replyTextSanitized||item.errorMessage||item.userText||'');
  const displayText=item.kind==='push_run'?(item.push?.replyTextSanitized||item.replyTextSanitized||item.errorMessage||item.userText||''):(item.kind==='trace'?(item.replyTextSanitized||item.replyTextRaw||item.errorMessage||item.userText||''):primaryText);
  const summary=summarizeAuditText(displayText||item.userText||item.errorMessage||'-');
  const visibleBody=renderAuditVisibleBody(item,primaryText);
  const details=renderAuditDetails(item,primaryText);
  return '<div class="audit-item"><div class="audit-rail"><div><div class="audit-time">'+esc(when.time)+'</div><div class="audit-date">'+esc(when.date)+'</div></div><div class="audit-status">'+kindBadge(item.kind)+badge(item.status||'-',statusKind)+'</div></div><div class="audit-main"><div class="audit-head"><div class="audit-title"><div class="audit-title-row"><strong>'+esc(auditItemTitle(item))+'</strong><span class="mono">'+esc(item.mode||'-')+'</span></div><div class="audit-summary">'+esc(summary)+'</div></div><div class="audit-meta">'+meta.map((pair)=>'<span title="'+esc(pair[0]+'='+pair[1])+'">'+esc(pair[0]+'='+pair[1])+'</span>').join('')+'</div></div>'+(item.errorMessage?auditSection('错误',item.errorMessage,'audit-error'):'')+visibleBody+renderAuditUsage(item)+details+'</div></div>';
}
function renderAutomationItem(item){const statusKind=item.status==='succeeded'?'ok':(item.status==='failed'?'warn':'gray');const meta=[['user',item.userId],['origin',item.origin],['attempt',item.attempt],['run',item.runId],item.deliveryStatus?['delivery',item.deliveryStatus]:null].filter(Boolean);const duration=item.startedAt&&item.finishedAt?Math.max(0,new Date(item.finishedAt)-new Date(item.startedAt))+'ms':'-';const summary=item.errorMessage||item.resultSummary||'运行完成';return '<div class="audit-item"><div class="audit-rail"><div><div class="audit-time">'+esc(formatAuditTime(item.createdAt).time)+'</div><div class="audit-date">'+esc(formatAuditTime(item.createdAt).date)+'</div></div><div class="audit-status">'+badge('自动化运行','info')+badge(item.status||'-',statusKind)+'</div></div><div class="audit-main"><div class="audit-head"><div class="audit-title"><div class="audit-title-row"><strong>'+esc(item.taskName||'自动化任务')+'</strong><span class="mono">'+esc(item.taskId||'-')+'</span></div><div class="audit-summary">'+esc(summary)+'</div></div><div class="audit-meta">'+meta.map((pair)=>'<span>'+esc(pair[0]+'='+pair[1])+'</span>').join('')+'</div></div><div class="audit-section"><div class="audit-section-title">运行详情</div><div class="audit-text primary">duration='+esc(duration)+'\nstarted='+esc(fmtTime(item.startedAt))+'\nfinished='+esc(fmtTime(item.finishedAt))+'\nerrorCategory='+esc(item.errorCategory||'-')+'\nretryable='+(item.retryable===1?'true':item.retryable===0?'false':'-')+'</div></div>'+(item.traceId?'<div class="audit-meta"><span>trace='+esc(item.traceId)+'</span></div>':'')+'</div></div>';}
function renderAuditUsage(item){if(!item.totalTokens&&!item.inputTokens&&!item.outputTokens&&!item.costAmount)return '';return '<div class="cost-source">'+badge('total '+fmtNumber(item.totalTokens||0),'info')+badge('in '+fmtNumber(item.inputTokens||0),'gray')+badge('out '+fmtNumber(item.outputTokens||0),'gray')+(item.thoughtTokens?badge('thought '+fmtNumber(item.thoughtTokens),'gray'):'')+(item.costAmount?badge(formatCost(item.costAmount),'ok'):'')+badge(item.usageSource||'unknown',item.usageSource==='actual'?'ok':'warn')+'</div>';}
function auditPrimaryLabel(kind){if(kind==='push_run')return '最终微信正文';if(kind==='push')return '入队准备发送给微信的正文';if(kind==='task')return '调度任务';return AUDIT_SCOPE==='push'?'Scheduler 清洗后回复 / 主要内容':'清洗后回复';}
function auditItemTitle(item){if(item.kind==='push_run')return '调度推送链路';if(item.kind==='push')return '微信推送正文';if(item.kind==='task')return '调度任务记录';return AUDIT_SCOPE==='push'?'推送生成 Trace':'对话 Trace';}
function auditSection(title,text,extraClass=''){return '<div class="audit-section"><div class="audit-section-title">'+esc(title)+'</div><div class="audit-text '+esc(extraClass)+'">'+esc(text||'-')+'</div></div>';}
function renderAuditVisibleBody(item,primaryText){
  if(item.kind==='push_run'){return '<div class="audit-columns">'+auditSection('模型实际输出（清洗后）',item.replyTextSanitized||'-','primary')+auditSection('最终微信正文',item.push?.replyTextSanitized||item.push?.replyTextRaw||'-','primary')+'</div>';}
  if(item.kind==='trace'&&AUDIT_SCOPE==='conversation'){return '<div class="audit-columns">'+auditSection('原始输入',item.userText,'primary')+auditSection('实际输出（清洗后回复）',item.replyTextSanitized||primaryText||'-','primary')+'</div>';}
  if(item.kind==='trace'){return '<div class="audit-columns">'+auditSection('实际输出（清洗后回复）',item.replyTextSanitized||primaryText||'-','primary')+auditSection('模型原始回复',item.replyTextRaw||primaryText||'-','primary')+'</div>';}
  return auditSection(auditPrimaryLabel(item.kind),primaryText||'-','primary');
}
function renderAuditDetails(item,primaryText){
  if(item.kind==='push_run'){return '<details class="audit-details"><summary>展开调度、任务输入与原始记录</summary><div class="audit-columns">'+auditSection('任务状态',renderPushRunTaskSummary(item))+auditSection('模型原始回复',item.replyTextRaw||'-')+'</div><div class="audit-columns">'+auditSection('任务输入',item.userText||'-')+auditSection('Prompt / 入站提示',item.promptText||'-')+'</div></details>';}
  if(item.kind!=='trace')return '';
  return '<details class="audit-details"><summary>'+(AUDIT_SCOPE==='push'?'展开任务输入与技术字段':'展开模型原始回复与技术字段')+'</summary><div class="audit-columns">'+auditSection(AUDIT_SCOPE==='push'?'任务输入':'模型原始回复',AUDIT_SCOPE==='push'?item.userText:(item.replyTextRaw||primaryText||'-'))+auditSection('Prompt / 入站提示',item.promptText||'-')+'</div></details>';
}
function renderPushRunTaskSummary(item){const lines=['task='+(item.task?.id||item.id||'-'),'taskStatus='+(item.task?.status||'-'),'pushJob='+(item.pushJobId||'-'),'pushStatus='+(item.push?.status||'-'),'finishedAt='+fmtTime(item.finishedAt||item.task?.finishedAt||'')];return lines.join('\\n');}
function summarizeAuditText(text){const value=String(text||'').replace(/\\s+/g,' ').trim();if(!value)return '-';return value.length>120?value.slice(0,120)+'...':value;}
function formatAuditTime(value){if(!value)return {date:'-',time:'-'};const date=new Date(value);if(Number.isNaN(date.getTime()))return {date:value,time:'-'};return {date:date.toLocaleDateString('zh-CN'),time:date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})};}
`;
