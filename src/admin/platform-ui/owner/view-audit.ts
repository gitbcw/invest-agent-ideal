// Owner 视图 D：日志审计。
// 三层信息架构：① 健康总览条（异常计数 + 链路覆盖率，消费 trace-coverage API）
// ② 可筛选时间线（scope 静态三键 + 时间范围 + 仅异常 + 页内搜索）
// ③ 卡片增强（工具调用 / 上下文占用 / 缓存 token / 可点击 ID 徽章跳转运行诊断）。

export const AUDIT_JS = `
let AUDIT_HEALTH=null;
const SINCE_LABEL={'1d':'近24小时','3d':'近3天','7d':'近7天','30d':'近30天','':'全部时间'};
function setAuditScope(scope){AUDIT_SCOPE=scope==='push'?'push':(scope==='automation'?'automation':'conversation');renderAuditScope();loadAudit();}
function renderAuditScope(){
  const isPush=AUDIT_SCOPE==='push';const isAutomation=AUDIT_SCOPE==='automation';
  document.getElementById('auditScopeConversation')?.classList.toggle('active',!isPush&&!isAutomation);
  document.getElementById('auditScopePush')?.classList.toggle('active',AUDIT_SCOPE==='push');
  document.getElementById('auditScopeAutomation')?.classList.toggle('active',AUDIT_SCOPE==='automation');
  document.getElementById('auditScopeHint').textContent=isPush?'推送审计':(isAutomation?'自动化任务':'对话审计');
  document.getElementById('auditTimelineTitle').textContent=isPush?'推送时间线':(isAutomation?'自动化运行历史':'对话时间线');
  document.getElementById('auditHelp').textContent=isPush?'推送审计查看主动推送入队正文、调度任务状态和关联的 scheduler LLM trace。':(isAutomation?'自动化任务查看每次运行的状态、失败分类、重试属性，以及该次运行关联的 LLM 任务输入与模型输出。':'对话审计查看微信/Web 用户消息进入 Mastra runtime 后的原始回复、清洗回复和入站提示（自动化任务执行不在此列）。卡片上的 T/M/C/R/P 徽章分别可跳转 trace/message/conversation/run/pushJob 全链路诊断。');
}
async function loadAudit(){
  const userId=document.getElementById('auditUser')?.value||'';
  const instanceId=document.getElementById('auditInstance')?.value||'';
  const limit=document.getElementById('auditLimit')?.value||'60';
  const since=document.getElementById('auditSince')?.value||'7d';
  const issuesOnly=document.getElementById('auditIssuesOnly')?.value||'';
  const params=new URLSearchParams();if(userId)params.set('userId',userId);if(instanceId)params.set('instanceId',instanceId);
  params.set('limit',limit);params.set('scope',AUDIT_SCOPE);if(since)params.set('since',since);if(issuesOnly)params.set('issuesOnly',issuesOnly);
  try{
    const res=await fetch((AUDIT_SCOPE==='automation'?'/api/platform/automation-runs?':'/api/platform/audit?')+params.toString());
    AUDIT=await res.json();
    if(!AUDIT.ok)throw new Error(AUDIT.error||'审计接口返回失败');
    renderAuditControls();renderAuditTimeline();
  }catch(error){document.getElementById('auditTimeline').innerHTML='<div class="error" style="display:block">审计加载失败: '+esc(error.message)+'</div>';}
}
async function loadAuditHealth(){
  try{
    const res=await fetch('/api/platform/audit/trace-coverage?days=30&healthDays=7');
    AUDIT_HEALTH=await res.json();
    if(!AUDIT_HEALTH.ok)throw new Error(AUDIT_HEALTH.error||'健康接口返回失败');
    renderAuditHealth();
  }catch(error){
    const root=document.getElementById('auditHealth');
    if(root)root.innerHTML='<div class="empty">健康数据加载失败: '+esc(error.message)+'</div>';
  }
}
// 总览条异常卡 → 一键应用对应 scope 的「仅异常」筛选。presetScope=null 表示不可点击。
function applyIssuePreset(scope){
  const issuesEl=document.getElementById('auditIssuesOnly');if(issuesEl)issuesEl.value='true';
  if(scope&&scope!==AUDIT_SCOPE)setAuditScope(scope);else loadAudit();
}
function issueStat(value,label,sub,presetScope,warnWhenZero){
  const cls=value>0?'warn':(warnWhenZero?'muted':'ok');
  const clickable=presetScope!==null;
  const click=clickable?' onclick="applyIssuePreset(\\''+presetScope+'\\')" style="cursor:pointer"':'';
  const title=clickable?'点击查看这些异常记录':'无时间线视图；完整流水见全链路诊断的「服务审计操作」节点';
  return '<div class="health-card is-'+cls+'"'+click+' title="'+title+'"><strong>'+fmtNumber(value)+'</strong><span>'+esc(label)+'</span>'+(sub?'<em>'+esc(sub)+'</em>':'')+'</div>';
}
function pctText(num,den){den=Number(den||0);if(!den)return '-';return Math.round(10000*Number(num)/den)/100+'%';}
function renderAuditHealth(){
  const updated=document.getElementById('auditHealthUpdated');
  if(updated)updated.textContent='平台全局 · 更新于 '+fmtTime(AUDIT_HEALTH.updatedAt);
  const root=document.getElementById('auditHealth');if(!root)return;
  const h=AUDIT_HEALTH.health||{};const cov=AUDIT_HEALTH.coverage||{};const dc=AUDIT_HEALTH.diagnosticCoverage||{};
  const pushIssues=(h.pushes?.failed||0)+(h.pushes?.dead||0)+(h.pushes?.expired||0);
  const opIssues=(h.serviceOps?.denied||0)+(h.serviceOps?.error||0);
  const cards=[
    issueStat((h.traces?.error||0),'对话错误（'+(h.traces?.total||0)+' 回合）','超时 '+(h.traces?.timeout||0)+' 次','',false),
    issueStat(pushIssues,'推送终态失败','失败 '+(h.pushes?.failed||0)+' · dead '+(h.pushes?.dead||0)+' · 过期 '+(h.pushes?.expired||0),'push',true),
    issueStat(h.automationRuns?.failed||0,'自动化运行失败','其中可重试 '+(h.automationRuns?.retryableFailures||0)+' 次 · 共 '+(h.automationRuns?.total||0)+' 次运行','automation',true),
    issueStat(opIssues,'服务操作 denied/error','共 '+(h.serviceOps?.total||0)+' 条服务审计',null,true),
  ].join('');
  const covRow='<div class="health-cov">'
    +metric(pctText(dc.auditsWithTraceId,dc.auditsTotal),'服务审计带 trace_id（缺 '+fmtNumber(dc.auditsWithoutTraceId)+'）')
    +metric(pctText(dc.scheduledRunsWithTraceLink,dc.scheduledRunsTotal),'调度 run 有 trace 反链')
    +metric(cov.toolCallCoverage==null?'-':pctText(Math.round(cov.toolCallCoverage*cov.completed),cov.completed),'回合含工具调用记录')
    +(cov.missing&&cov.missing.traceId?metric(fmtNumber(cov.missing.traceId),'旧数据缺 traceId'):'')
    +'</div>';
  root.innerHTML='<div class="health-cards-row">'+cards+'</div>'+covRow;
}
function initAuditFromSelection(){
  const item=selectedInstance();
  if(!document.getElementById('auditUser'))return;
  if(item){document.getElementById('auditUser').innerHTML='<option value="'+esc(item.owner?.id||'')+'">'+esc(item.owner?.displayName||item.owner?.id||'')+'</option>';document.getElementById('auditInstance').innerHTML='<option value="'+esc(item.instanceId)+'">'+esc(item.name||item.instanceId)+'</option>';}
  loadAudit();loadAuditHealth();
}
function renderAuditControls(){
  const userSelect=document.getElementById('auditUser');const instanceSelect=document.getElementById('auditInstance');
  if(!userSelect||!instanceSelect)return;
  const selectedUser=(AUDIT.filters?.userId)||(userSelect.value||'');
  const selectedInstance=(AUDIT.filters?.instanceId)||(instanceSelect.value||'');
  userSelect.innerHTML='<option value="">全部用户</option>'+(AUDIT.users||[]).map((user)=>'<option value="'+esc(user.id)+'"'+(user.id===selectedUser?' selected':'')+'>'+esc(user.displayName||user.id)+' · '+esc(user.id)+'</option>').join('');
  instanceSelect.innerHTML='<option value="">全部用户助手</option>'+(AUDIT.instances||[]).map((item)=>'<option value="'+esc(item.instanceId)+'"'+(item.instanceId===selectedInstance?' selected':'')+'>'+esc(item.name||item.instanceId)+' · '+esc(item.instanceId)+'</option>').join('');
  const since=document.getElementById('auditSince')?.value||'';const issuesOnly=document.getElementById('auditIssuesOnly')?.value||'';
  document.getElementById('auditUpdated').textContent='更新于 '+fmtTime(AUDIT.updatedAt)+' · '+(SINCE_LABEL[since]||since)+(issuesOnly?' · 仅异常':'');
}
async function onAuditUserChange(){const instanceSelect=document.getElementById('auditInstance');if(instanceSelect)instanceSelect.value='';await loadAudit();}
function onAuditSearchInput(){renderAuditTimeline();}
function auditFilterNote(total,shown,q){
  if(q)return '<div class="audit-note">页内搜索 "'+esc(q)+'" 命中 <strong>'+shown+'</strong> / 共 '+total+' 条已加载记录</div>';
  return '';
}
function renderAuditTimeline(){
  const root=document.getElementById('auditTimeline');
  let items=AUDIT.items||[];
  AUDIT_ITEM_BY_ID=Object.fromEntries(items.map((item)=>[String(item.id),item]));
  // 汇总条在最前面渲染：空数据时看到全 0 计数也是审计信息。
  const summaryStrip=AUDIT_SCOPE==='automation'?renderAutomationSummaryStrip():'';
  if(!items.length){root.innerHTML=summaryStrip+'<div class="empty">暂无审计记录</div>';return;}
  const q=String(document.getElementById('auditSearch')?.value||'').trim().toLowerCase();
  let shown=items;
  if(q){
    shown=items.filter((item)=>JSON.stringify(item).toLowerCase().includes(q));
  }
  if(!shown.length){root.innerHTML=summaryStrip+auditFilterNote(items.length,0,q)+'<div class="empty">'+(q?'没有匹配的审计记录':'暂无审计记录')+'</div>';return;}
  root.innerHTML=summaryStrip+auditFilterNote(items.length,shown.length,q)+'<div class="audit-list">'+shown.map(renderAuditItem).join('')+'</div>';
}
function renderAutomationSummaryStrip(){
  const s=AUDIT.summary;if(!s)return '';
  return '<div class="cost-source autom-summary">'
    +badge('总数 '+fmtNumber(s.total),'gray')+badge('成功 '+fmtNumber(s.succeeded),'ok')
    +(s.failed?badge('失败 '+fmtNumber(s.failed),'warn'):badge('失败 0','gray'))
    +(s.retryableFailures?badge('可重试 '+fmtNumber(s.retryableFailures),'warn'):'')
    +badge('进行中 '+fmtNumber(s.running),'info')+badge('取消 '+fmtNumber(s.cancelled),'gray')+badge('跳过 '+fmtNumber(s.skipped),'gray')
    +'</div>';
}
function parseToolCalls(value){
  if(typeof value==='string'){try{return JSON.parse(value);}catch(e){return [];}}
  return Array.isArray(value)?value:[];
}
function fmtCtxWindow(item){
  const used=Number(item.contextWindowUsed||0);const size=Number(item.contextWindowSize||0);
  if(!used||!size)return '';
  const ratio=Math.min(100,Math.round(100*used/size));
  const high=ratio>=80?'high':'';
  return '<div class="ctxbar"><div class="ctxbar-fill '+high+'" style="width:'+ratio+'%"></div><span>上下文 '+ratio+'%（'+fmtNumber(used)+'/'+fmtNumber(size)+'）</span></div>';
}
function idChip(by,id,label,long){
  if(!id)return '';
  return '<button class="id-chip" data-diag="'+esc(by)+'" data-id="'+esc(String(id))+'" title="点击进入全链路诊断（'+esc(by)+'='+esc(String(id))+'）" onclick="openDiagFromElement(this)"><b>'+esc(label||by)+'</b>'+esc(long?(String(id).length>26?String(id).slice(0,25)+'…':String(id)):String(id))+'</button>';
}
function openDiagFromElement(el){const by=el.getAttribute('data-diag');const id=el.getAttribute('data-id');if(!by||!id)return;DIAG_PENDING={by,id};setView('diagnostics');}
function kindBadge(kind){if(kind==='push_run')return badge('推送链路','info');if(kind==='trace')return badge(AUDIT_SCOPE==='push'?'调度追踪':'对话追踪','info');if(kind==='push')return badge('微信推送','ok');if(kind==='task')return badge('任务','gray');return badge(kind||'-','gray');}
function renderAuditItem(item){
  if(AUDIT_SCOPE==='automation')return renderAutomationItem(item);
  const when=formatAuditTime(item.createdAt);
  const statusKind=item.status==='success'||item.status==='sent'?'ok':(item.status==='error'||item.status==='dead'||item.status==='failed'||item.status==='expired'?'warn':'gray');
  const meta=[item.userId?['user',item.userId]:null,item.instanceId?['instance',item.instanceId]:null,item.conversationId?['conversation',item.conversationId]:null,item.elapsedMs?['elapsed',item.elapsedMs+'ms']:null,item.totalTokens?['tokens',fmtNumber(item.totalTokens)]:null,item.usageSource?['usage',item.usageSource]:null,item.agentModel?['model',item.agentModel]:null].filter(Boolean);
  const primaryText=item.kind==='push'?item.replyTextSanitized:(item.replyTextRaw||item.replyTextSanitized||item.errorMessage||item.userText||'');
  const displayText=item.kind==='push_run'?(item.push?.replyTextSanitized||item.replyTextSanitized||item.errorMessage||item.userText||''):(item.kind==='trace'?(item.replyTextSanitized||item.replyTextRaw||item.errorMessage||item.userText||''):primaryText);
  const summary=summarizeAuditText(displayText||item.userText||item.errorMessage||'-');
  const visibleBody=renderAuditVisibleBody(item,primaryText);
  const details=renderAuditDetails(item,primaryText);
  const tech=renderAuditTechExtras(item);
  return '<div class="audit-item"><div class="audit-rail"><div><div class="audit-time">'+esc(when.time)+'</div><div class="audit-date">'+esc(when.date)+'</div></div><div class="audit-status">'+kindBadge(item.kind)+badge(item.status||'-',statusKind)+'</div></div><div class="audit-main"><div class="audit-head"><div class="audit-title"><div class="audit-title-row"><strong>'+esc(auditItemTitle(item))+'</strong><span class="mono">'+esc(item.mode||'-')+'</span></div><div class="audit-summary">'+esc(summary)+'</div></div><div class="audit-meta">'+meta.map((pair)=>'<span title="'+esc(pair[0]+'='+pair[1])+'">'+esc(pair[0]+'='+pair[1])+'</span>').join('')+'</div></div>'+(item.errorMessage?auditSection('错误',item.errorMessage,'audit-error'):'')+visibleBody+tech+renderAuditUsage(item)+renderAuditIds(item)+details+'</div></div>';
}
// 卡片新增技术区块：工具调用清单（可折叠）+ 上下文窗口占用条。
function renderAuditTechExtras(item){
  if(item.kind!=='trace'&&item.kind!=='push_run')return fmtCtxWindow(item);
  const calls=parseToolCalls(item.toolCalls);
  const ctx=fmtCtxWindow(item);
  let callsHtml='';
  if(calls.length){
    const byName={};
    for(const call of calls){const name=String(call?.toolName||call?.name||'unknown')+(call?.isError||call?.status==='error'?' ⚠':'');byName[name]=(byName[name]||0)+1;}
    const lines=Object.keys(byName).sort().map((name)=>name+(byName[name]>1?' ×'+byName[name]:'')).join('\\n');
    callsHtml='<details class="audit-details"><summary>工具调用 '+calls.length+' 次</summary><div class="audit-text">'+esc(lines)+'</div></details>';
  }
  return callsHtml+ctx;
}
function renderAutomationItem(item){
  const statusKind=item.status==='succeeded'?'ok':(item.status==='failed'?'warn':'gray');
  const deliveryKind=!item.deliveryStatus?'gray':(['sent','delivered'].includes(item.deliveryStatus)?'ok':(['dead','failed','expired'].includes(item.deliveryStatus)?'warn':'gray'));
  const meta=[['user',item.userId],['origin',item.origin],['attempt',item.attempt],['run',item.runId],item.agentModel?['model',item.agentModel]:null,item.deliveryStatus?['delivery',item.deliveryStatus]:null].filter(Boolean);
  const duration=item.startedAt&&item.finishedAt?Math.max(0,new Date(item.finishedAt)-new Date(item.startedAt))+'ms':'-';
  const summary=item.traceReplyText?summarizeAuditText(item.traceReplyText):(item.errorMessage||item.resultSummary||'运行完成');
  const detail=['duration='+duration,'started='+fmtTime(item.startedAt),'finished='+fmtTime(item.finishedAt),'errorCategory='+(item.errorCategory||'-'),'retryable='+(item.retryable===1?'true':item.retryable===0?'false':'-')].join('\\n');
  const hasTrace=Boolean(item.traceUserText||item.traceReplyText);
  const traceBody=hasTrace?'<div class="audit-columns">'+auditSection('任务输入（进入模型的 prompt）',item.traceUserText||'-')+auditSection('模型输出（清洗后）',item.traceReplyText||item.traceRawReplyText||'-','primary')+'</div>':(item.errorMessage?auditSection('错误',item.errorMessage,'audit-error'):'');
  const traceDetails=hasTrace?'<details class="audit-details"><summary>展开模型原始回复与技术字段</summary><div class="audit-columns">'+auditSection('模型原始回复',item.traceRawReplyText||'-')+auditSection('Prompt / 入站提示',item.tracePromptText||'-')+'</div></details>':'';
  return '<div class="audit-item"><div class="audit-rail"><div><div class="audit-time">'+esc(formatAuditTime(item.createdAt).time)+'</div><div class="audit-date">'+esc(formatAuditTime(item.createdAt).date)+'</div></div><div class="audit-status">'+badge('自动化运行','info')+badge(item.status||'-',statusKind)+(item.deliveryStatus?badge('投递 '+item.deliveryStatus,deliveryKind):'')+'</div></div><div class="audit-main"><div class="audit-head"><div class="audit-title"><div class="audit-title-row"><strong>'+esc(item.taskName||'自动化任务')+'</strong><span class="mono">'+esc(item.taskId||'-')+'</span></div><div class="audit-summary">'+esc(summary)+'</div></div><div class="audit-meta">'+meta.map((pair)=>'<span>'+esc(pair[0]+'='+pair[1])+'</span>').join('')+'</div></div><div class="audit-section"><div class="audit-section-title">运行详情</div><div class="audit-text primary">'+esc(detail)+'</div></div>'+traceBody+renderAuditUsage(item)+renderAuditIds(item)+traceDetails+'</div></div>';
}
function renderAuditUsage(item){if(!item.totalTokens&&!item.inputTokens&&!item.outputTokens&&!item.costAmount)return '';return '<div class="cost-source">'+badge('total '+fmtNumber(item.totalTokens||0),'info')+badge('in '+fmtNumber(item.inputTokens||0),'gray')+badge('out '+fmtNumber(item.outputTokens||0),'gray')+(item.thoughtTokens?badge('thought '+fmtNumber(item.thoughtTokens),'gray'):'')+((Number(item.cachedReadTokens)||0)?badge('cache读 '+fmtNumber(item.cachedReadTokens),'gray'):'')+((Number(item.cachedWriteTokens)||0)?badge('cache写 '+fmtNumber(item.cachedWriteTokens),'gray'):'')+(item.costAmount?badge(formatCost(item.costAmount),'ok'):'')+badge(item.usageSource||'unknown',item.usageSource==='actual'?'ok':'warn')+'</div>';}
// 关联 ID 徽章：全部可直接跳进「运行诊断」反查整条链路。
function renderAuditIds(item){
  const chips=[];
  if(item.kind==='trace'){
    chips.push(idChip('traceId',item.traceId,'T'));
    chips.push(idChip('messageId',item.messageId,'M'));
    chips.push(idChip('conversationId',item.conversationId,'C',true));
    chips.push(idChip('runId',item.runId,'R'));
  }else if(item.kind==='push_run'){
    chips.push(idChip('runId',item.taskKey||item.id,'R'));
    chips.push(idChip('deliveryId',item.pushJobId||item.push?.id,'P'));
  }else if(item.kind==='push'){
    chips.push(idChip('deliveryId',item.id,'P'));
  }else if(item.kind==='task'){
    chips.push(idChip('runId',item.taskKey||item.id,'R'));
    chips.push(idChip('deliveryId',item.pushJobId,'P'));
  }
  if(AUDIT_SCOPE==='automation'){
    chips.push(idChip('taskId',item.taskId,'K'));
    chips.push(idChip('runId',item.runId,'R'));
    chips.push(idChip('traceId',item.traceId,'T'));
    chips.push(idChip('deliveryId',item.pushJobId,'P'));
  }
  const unique=[];
  const seen=new Set();
  for(const chip of chips){if(chip&&!seen.has(chip)){seen.add(chip);unique.push(chip);}}
  if(!unique.length)return '';
  return '<div class="audit-ids"><div class="audit-section-title">链路诊断入口</div><div class="cost-source">'+unique.join('')+'</div></div>';
}
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
