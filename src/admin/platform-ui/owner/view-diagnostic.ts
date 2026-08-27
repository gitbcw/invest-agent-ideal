// Owner 视图 F：运行诊断（全链路）。
// 消费 WP3 的 /api/platform/audit/run-diagnostic：从入口 ID（trace/message/conversation/
// run/task/delivery）反查一次运行的九段链路节点；缺失关联显式标红；
// 只用显式 ID 关联、不使用时间邻近（契约 docs/run-diagnostic-view-contract.md）。

export const DIAGNOSTIC_JS = `
let DIAG=null;
let DIAG_PENDING=null;
function ensureDiagnosticLoaded(){
  if(DIAG_PENDING){
    const p=DIAG_PENDING;DIAG_PENDING=null;
    const byEl=document.getElementById('diagBy');const idEl=document.getElementById('diagId');
    if(byEl)byEl.value=p.by;if(idEl)idEl.value=p.id;
    loadDiagnostic();
    return;
  }
  if(document.getElementById('diagId')?.value)loadDiagnostic();
}
async function loadDiagnostic(){
  const by=document.getElementById('diagBy')?.value||'traceId';
  const id=String(document.getElementById('diagId')?.value||'').trim();
  const root=document.getElementById('diagResult');
  if(!root)return;
  if(!id){root.innerHTML='<div class="empty">请先输入要追查的入口 ID</div>';return;}
  root.innerHTML='<div class="loading">正在反查链路...</div>';
  document.getElementById('diagSummary').textContent='';
  try{
    DIAG=await platformJson('/api/platform/audit/run-diagnostic?by='+encodeURIComponent(by)+'&id='+encodeURIComponent(id));
    document.getElementById('diagUpdated').textContent='查询于 '+fmtTime(new Date().toISOString());
    renderDiagnostic();
  }catch(error){root.innerHTML='<div class="error" style="display:block">诊断查询失败: '+esc(error.message)+'</div>';}
}
const DIAG_MISSING_LABEL={
  tracesWithoutConversationId:'回合缺 conversation_id',
  tracesWithoutTraceId:'回合缺 trace_id',
  auditsWithoutTraceId:'服务审计缺 trace_id',
  scheduledRunsWithoutTraceLink:'调度 run 无 trace 反链',
  pushJobsWithoutOriginRun:'推送缺 origin run 关联',
  deliveriesWithoutPushJobLink:'投递记录缺 push_job 关联',
  artifactsWithoutMessageLink:'产物缺 message 关联'
};
function diagShort(text,max){const value=String(text??'').replace(/\\s+/g,' ').trim();if(!value)return '-';return value.length>max?value.slice(0,max-1)+'…':value;}
function diagStage(title,count,bodyHtml){
  return '<details class="diag-stage"'+(count>0?'':' data-empty="1"')+'><summary><strong>'+esc(title)+'</strong>'+badge(count+' 节点',count?'info':'gray')+'</summary><div class="diag-body">'+bodyHtml+'</div></details>';
}
function diagNa(text){return '<div class="diag-na">'+esc(text)+'</div>';}
function diagEmpty(){return diagNa('本链路中没有该节点的显式关联记录（不算缺口，也不推断）');}
function retryPair(row){if(row.retryable===1)return ['重试','retryable=true'];if(row.retryable===0)return ['重试','retryable=false'];return null;}
function toolCallCount(value){
  let calls=value;
  if(typeof calls==='string'){try{calls=JSON.parse(calls);}catch(e){return 0;}}
  return Array.isArray(calls)?calls.length:0;
}
function renderDiagnostic(){
  const root=document.getElementById('diagResult');
  if(!DIAG||!DIAG.ok){root.innerHTML='<div class="empty">暂无诊断结果</div>';return;}
  const d=DIAG;const nodes=d.nodes||{};
  const entry=d.entry||{};
  document.getElementById('diagSummary').innerHTML=(entry.resolved?badge('锚点已解析','ok'):badge('入口未命中任何记录','warn'))+' '+(d.scope?.userIds?.length?badge(d.scope.userIds.join(','),'gray'):'')+' '+(d.scope?.conversationIds||[]).map((cid)=>badge('会话 '+cid,'gray')).join('')+' '+(d.scope?.channels||[]).map((ch)=>badge(ch,'info')).join('');
  // 缺失关联：真实治理缺口（n.a. 不计），契约要求显式显示并进入覆盖率。
  let missingHtml='';
  const missingItems=[];
  for(const key of Object.keys(DIAG_MISSING_LABEL)){
    const value=Number((d.missingLinks||{})[key]||0);
    if(value>0)missingItems.push('<div class="diag-missing-item"><strong>'+fmtNumber(value)+'</strong><span>'+esc(DIAG_MISSING_LABEL[key])+'</span></div>');
  }
  missingHtml=missingItems.length
    ?'<div class="diag-missing"><div class="diag-missing-title">'+badge('存在关联缺口','warn')+'<span>以下为真实缺口计数：</span></div>'+missingItems.join('')+'</div>'
    :'<div class="diag-ok-note">'+badge('关联完整','ok')+'<span>本链路没有缺失关联计数。</span></div>';
  // ① 会话与消息
  const sessionRow=nodes.conversation?.session;
  const messages=(nodes.conversation?.messages||[]);
  let convBody=sessionRow?rowLine([['会话',sessionRow.conversationId||'-'],['创建',fmtTime(sessionRow.createdAt)]]):'';
  convBody+=messages.slice(-12).reverse().map((msg)=>rowLine([
    ['role',msg.role||'-'],
    msg.traceId?['trace',diagShort(msg.traceId,24)]:null,
    ['内容',diagShort(msg.content,90)],
    ['时间',fmtTime(msg.createdAt)],
  ].filter(Boolean))).join('');
  if(messages.length>12)convBody+='<div class="diag-more">仅显示最近 12 条（共 '+messages.length+' 条）</div>';
  // ② Agent 回合（success 也必须显示业务终态；error/timeout 显示错误内容）
  const traceRows=nodes.traces||[];
  const traceBody=traceRows.map((t)=>{
    const calls=toolCallCount(t.toolCalls);
    return rowLine([
      ['状态',t.status||'-'],
      ['模型',(t.agentBackend||'?')+'/'+(t.agentModel||'?')],
      ['耗时/Token',(t.elapsedMs??'-')+'ms / '+fmtNumber(t.totalTokens)],
      calls?['工具调用',calls+' 次']:null,
      t.errorMessage?['错误',diagShort(t.errorMessage,70)]:null,
      ['时间',fmtTime(t.createdAt)],
    ].filter(Boolean));
  }).join('');
  // ③ 外部 MCP 工具调用（观测面，无 applicable 标记；空=无记录而非缺口）
  const mcpRows=nodes.mcpToolCalls||[];
  const mcpBody=mcpRows.map((row)=>rowLine([
    ['server',diagShort(row.serverId,20)],
    ['tool',diagShort(row.toolName,26)],
    ['状态',row.status||'-'],
    ['耗时',(row.elapsedMs??'-')+'ms'],
    row.errorClass?['错误类',diagShort(row.errorClass,30)]:['I/O',(row.inputChars??'-')+'/'+(row.outputChars??'-')+' 字符'],
  ])).join('');
  // ④ 服务审计操作（确定性写操作证据；correlation 标注会话级还是回合级）
  const auditRows=nodes.audits||[];
  const auditBody=auditRows.map((row)=>rowLine([
    ['operation',diagShort(row.operation,28)],
    ['状态',row.status||'-'],
    ['关联',row.correlation==='conversation'?'correlation=conversation（会话级）':'correlation=trace'],
    ['资源',diagShort(row.resourceType+(row.resourceId?'#'+row.resourceId:''),34)],
    row.resultSummary?['结果',diagShort(row.resultSummary,60)]:null,
  ].filter(Boolean))).join('');
  // ⑤ 产物
  const artifactRows=nodes.artifacts||[];
  const artifactBody=artifactRows.map((row)=>rowLine([
    ['title',diagShort(row.title,30)],
    ['kind',row.kind+'/'+(row.source||'-')],
    ['文件',diagShort(row.fileName,30)],
    ['大小',fmtNumber(row.sizeBytes)+'B'],
    row.messageId?['message',diagShort(row.messageId,24)]:['message','⚠ 缺失'],
  ])).join('');
  // ⑥ 自动化运行（错误分类 + 是否可重试是契约必显项）
  const autoRows=nodes.automationRuns||[];
  const autoBody=autoRows.map((row)=>rowLine([
    ['task',diagShort(row.taskId,26)],
    ['run',diagShort(row.runId,26)],
    ['状态',row.status||'-'],
    ['origin',row.origin||'-'],
    row.deliveryStatus?['投递',row.deliveryStatus]:null,
    row.errorCategory?['错误类',row.errorCategory]:null,
    retryPair(row),
    ['时间',fmtTime(row.startedAt)+' → '+fmtTime(row.finishedAt)],
  ].filter(Boolean))).join('');
  // ⑦ 调度运行
  const schedRows=nodes.scheduledRuns||[];
  const schedBody=schedRows.map((row)=>rowLine([
    ['taskKey',diagShort(row.taskKey,32)],
    ['状态',row.status||'-'],
    ['type',row.taskType||'-'],
    row.errorClass?['错误类',diagShort(row.errorClass,40)]:row.errorMessage?['错误',diagShort(row.errorMessage,50)]:null,
    ['时间',fmtTime(row.createdAt)+' → '+fmtTime(row.finishedAt)],
  ].filter(Boolean))).join('');
  // ⑧ 推送任务（终态原因必须可见）
  const pushRows=nodes.pushJobs||[];
  const pushBody=pushRows.map((row)=>rowLine([
    ['pushJob',diagShort(row.id,26)],
    ['状态',row.status||'-'],
    ['source',row.source||'-'],
    row.terminalReason?['terminalReason',diagShort(row.terminalReason,36)]:null,
    row.lastError?['lastError',diagShort(row.lastError,60)]:null,
    ['attempts',String(Number(row.attempts||0))],
    ['入队',fmtTime(row.createdAt)],
    row.sentAt?['送达',fmtTime(row.sentAt)]:null,
  ].filter(Boolean))).join('');
  // ⑨ 微信投递尝试
  const deliveryRows=nodes.deliveries||[];
  const deliveryBody=deliveryRows.map((row)=>rowLine([
    ['attempt','#'+row.id],
    ['result',row.result||'-'],
    ['模式',row.probe?'probe 探测':'real 实发'],
    ['reason',diagShort(row.reason,44)],
    row.errorMessage?['错误',diagShort(row.errorMessage,60)]:null,
    ['时间',fmtTime(row.createdAt)],
  ].filter(Boolean))).join('');
  const apd=d.applicable||{};
  const html=''
    +missingHtml
    +'<div class="diag-flow">'
    +(apd.conversation===false&&!messages.length&&!sessionRow
      ?diagStage('① 会话与消息',0,diagNa('n.a. —— 无会话节点'))
      :diagStage('① 会话与消息',messages.length||(sessionRow?1:0),convBody||diagEmpty()))
    +diagStage('② Agent 回合',traceRows.length,traceBody||diagEmpty())
    +diagStage('③ 外部 MCP 工具调用',mcpRows.length,mcpBody||diagEmpty())
    +diagStage('④ 服务审计操作',auditRows.length,auditBody||diagEmpty())
    +(apd.artifacts===false&&!artifactRows.length
      ?diagStage('⑤ 产物写入',0,diagNa('n.a. —— 该运行不产生产物节点'))
      :diagStage('⑤ 产物写入',artifactRows.length,artifactBody||diagEmpty()))
    +(apd.automation===false&&!autoRows.length
      ?diagStage('⑥ 自动化运行',0,diagNa('n.a. —— 非自动化链路'))
      :diagStage('⑥ 自动化运行',autoRows.length,autoBody||diagEmpty()))
    +(apd.scheduler===false&&!schedRows.length
      ?diagStage('⑦ 调度运行',0,diagNa('n.a. —— 非调度链路'))
      :diagStage('⑦ 调度运行',schedRows.length,schedBody||diagEmpty()))
    +(apd.push===false&&!pushRows.length
      ?diagStage('⑧ 推送任务',0,diagNa('n.a. —— 无推送环节'))
      :diagStage('⑧ 推送任务',pushRows.length,pushBody||diagEmpty()))
    +diagStage('⑨ 微信投递尝试',deliveryRows.length,deliveryBody||diagNa('该推送没有投递尝试记录（尚未发出或未写入）'))
    +'</div>'
    +'<div class="diag-notes">'+(d.notes||[]).map((note)=>'<div>· '+esc(note)+'</div>').join('')+'</div>';
  root.innerHTML=html;
}
// 单条节点行：键值对横排小卡。pairs 为 [label, value]，value 已在调用侧截短。
function rowLine(pairs){return '<div class="diag-row">'+pairs.map((pair)=>'<span><b>'+esc(pair[0])+'</b>'+esc(String(pair[1]))+'</span>').join('')+'</div>';}
`;
