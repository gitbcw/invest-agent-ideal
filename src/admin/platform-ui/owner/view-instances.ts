// Owner 视图 A：用户助手（instances）。
// 含：搜索/统计/列表/详情/kv/操作按钮/投资状态摘要/微信面板/绑定/创建 Modal/门户凭证/重置测试实例。
// DOM 结构与原 platform-page.ts 完全对等，仅迁入模块。

export const INSTANCES_JS = `
function filteredInstances(){
  const keyword=document.getElementById('search').value.trim().toLowerCase();
  const instances=DATA.instances||[];
  if(!keyword)return instances;
  return instances.filter((item)=>[item.instanceId,item.projectId,item.name,item.owner?.id,item.owner?.displayName,item.backend,item.skillBundleId].some((value)=>String(value||'').toLowerCase().includes(keyword)));
}

function render(){
  const instances=filteredInstances();
  if(!instances.some((item)=>item.instanceId===selectedInstanceId)){selectedInstanceId=instances[0]?.instanceId||'';}
  const updatedEl=document.getElementById('updated')||document.getElementById('updatedAt');
  if(updatedEl)updatedEl.textContent='更新于 '+fmtTime(DATA.updatedAt);
  document.getElementById('instanceCount').textContent=instances.length+' 个用户助手';
  renderStats(DATA.instances||[]);
  renderList(instances);
  renderDetail((DATA.instances||[]).find((item)=>item.instanceId===selectedInstanceId));
}

function renderStats(instances){
  const active=instances.filter((item)=>item.status==='active').length;
  const wxBound=instances.filter((item)=>item.channelBindingCount>0).length;
  const conversations=instances.reduce((sum,item)=>sum+Number(item.traceCount||0),0);
  document.getElementById('stats').innerHTML=[
    stat(instances.length,'用户助手'),
    stat(active,'运行中'),
    stat(wxBound,'已绑定微信'),
    stat(conversations,'对话记录'),
  ].join('');
}

function renderList(instances){
  const root=document.getElementById('instanceList');
  if(!instances.length){root.innerHTML='<div class="empty">暂无用户助手</div>';return;}
  root.innerHTML='<div class="instance-list">'+instances.map((item)=>{
    const selected=item.instanceId===selectedInstanceId?' selected':'';
    return '<div class="instance-card'+selected+'" onclick="selectInstance(\\''+esc(item.instanceId)+'\\')">'+
      '<div class="row"><div><div class="name">'+esc(item.name)+'</div><div class="mono">'+esc(item.instanceId)+'</div></div>'+
      badge(item.status||'active',item.status==='active'?'ok':'warn')+'</div>'+
      '<div class="muted" style="margin-top:8px">用户 '+esc(item.owner?.displayName||item.owner?.id||'-')+' · '+esc(item.backend||'-')+'</div>'+
      '<div class="metrics">'+metric(item.holdingCount,'持仓')+metric(item.watchlistCount,'自选')+metric(item.alertRuleCount,'提醒')+'</div>'+
    '</div>';
  }).join('')+'</div>';
}

function selectInstance(instanceId){
  selectedInstanceId=instanceId;
  render();
  const item=selectedInstance();
  if(item&&document.getElementById('auditUser')){
    document.getElementById('auditUser').value=item.owner?.id||'';
    document.getElementById('auditInstance').value=item.instanceId;
    loadAudit();
  }
  if(item){selectedCostInstanceId=item.instanceId;if(ACTIVE_VIEW==='cost')loadCostPanel();}
}

function renderDetail(item){
  const root=document.getElementById('detail');
  document.getElementById('selectedHint').textContent=item?item.instanceId:'未选择';
  if(!item){root.innerHTML='<div class="empty">请选择一个用户助手</div>';return;}
  const isDefaultTestInstance=item.instanceId==='invest-agent-primary';
  root.innerHTML=
    '<dl class="kv">'+
      '<dt>助手名称</dt><dd>'+esc(item.name)+(isDefaultTestInstance?' '+badge('默认测试实例','warn'):'')+'</dd>'+
      '<dt>助手 ID</dt><dd class="mono">'+esc(item.instanceId)+'</dd>'+
      '<dt>用户</dt><dd>'+esc(item.owner?.displayName||'-')+' <span class="mono">'+esc(item.owner?.id||'')+'</span></dd>'+
      '<dt>项目类型</dt><dd>'+esc(item.projectType||'invest-agent')+'</dd>'+
      '<dt>后端</dt><dd>'+esc(item.backend||'-')+'</dd>'+
      '<dt>技能包</dt><dd class="mono">'+esc(item.skillBundleId||'-')+'</dd>'+
      '<dt>工作区</dt><dd>'+badge(item.workspace?.exists?'已创建':'缺失',item.workspace?.exists?'ok':'warn')+' <span class="mono">'+esc(item.workspace?.path||'-')+'</span></dd>'+
      '<dt>状态</dt><dd>'+badge(item.status||'active',item.status==='active'?'ok':'warn')+'</dd>'+
      '<dt>创建时间</dt><dd>'+esc(fmtTime(item.createdAt))+'</dd>'+
    '</dl>'+
    '<div class="ops">'+
      '<button class="btn btn-primary" onclick="provisionSelectedPortalCredential()">生成并复制门户登录信息</button>'+
      (item.workspace?.exists?'':'<button class="btn" onclick="ensureSelectedWorkspace()">补建工作区</button>')+
      (isDefaultTestInstance?'<button class="btn" onclick="showResetTestInstancePanel()">重置测试实例</button>':'<button class="btn" onclick="archiveSelectedInstance()">删除用户助手</button>')+
    '</div>'+
    (isDefaultTestInstance?renderResetTestInstancePanel():'')+
    '<div id="portalCredentialResult" class="item" style="display:none;margin-top:10px"></div>'+
    '<div class="section"><h3>运行概况</h3><div class="metrics">'+metric(item.planCount,'预案')+metric(item.traceCount,'对话')+metric(item.channelBindingCount,'微信绑定')+'</div></div>'+
    '<div class="section"><h3>投资状态摘要</h3><div id="investmentStatePanel" class="item"><span class="muted">加载中…</span></div></div>'+
    '<div class="section"><h3>微信扫码绑定</h3>'+renderWeixinPanel(item)+'</div>'+
    '<div class="section"><h3>微信绑定</h3>'+renderBindings(item.channelBindings||[])+'</div>';
  refreshWeixinStatus(item.instanceId);
  refreshInvestmentState(item.instanceId);
}

function refreshInvestmentState(instanceId){
  const panel=document.getElementById('investmentStatePanel');
  if(!panel)return;
  platformJson('/api/platform/instances/'+encodeURIComponent(instanceId)+'/investment-state')
    .then((data)=>renderInvestmentState(panel,instanceId,data))
    .catch((err)=>{panel.innerHTML='<span class="muted">投资状态加载失败:'+esc(err.message||'未知错误')+'</span>';});
}

function renderInvestmentState(panel,instanceId,data){
  if(instanceId!==selectedInstanceId)return;
  if(!data||data.ok===false){panel.innerHTML='<span class="muted">投资状态暂不可用</span>';return;}
  const summary=data.summary||{};
  if(data.workspaceReady===false){
    panel.innerHTML='<div class="muted" style="margin-bottom:6px">该实例尚未初始化工作区。用户首次发起对话或初始化工作区后,投资状态摘要才会出现。</div><div class="muted">更新于 '+esc(data.updatedAt||'-')+'。</div>';
    return;
  }
  const holdings=Array.isArray(data.holdings)?data.holdings:[];
  const watchlist=Array.isArray(data.watchlist)?data.watchlist:[];
  const plans=Array.isArray(data.plans)?data.plans:[];
  const reviews=Array.isArray(data.recentReviews)?data.recentReviews:[];
  const viewpoints=Array.isArray(data.viewpoints)?data.viewpoints:[];
  const holdingsRows=holdings.length?holdings.map((row)=>'<tr><td class="mono">'+esc(row.code)+'</td><td>'+esc(row.name)+'</td><td class="muted">'+esc(row.buyDate||'-')+'</td><td class="muted">'+(row.costPrice==null?'-':Number(row.costPrice).toFixed(2))+'</td></tr>').join(''):'<tr><td colspan="4" class="muted">空</td></tr>';
  const watchlistRows=watchlist.length?watchlist.map((row)=>'<tr><td class="mono">'+esc(row.code)+'</td><td>'+esc(row.name)+'</td><td class="muted">'+esc(row.reason||'-')+'</td></tr>').join(''):'<tr><td colspan="3" class="muted">空</td></tr>';
  const planRows=plans.length?plans.map((row)=>'<tr><td class="mono">'+esc(row.code)+'</td><td>'+esc(row.name)+'</td><td class="muted">'+(row.support==null?'-':Number(row.support).toFixed(2))+'</td><td class="muted">'+(row.resistance==null?'-':Number(row.resistance).toFixed(2))+'</td><td class="muted">'+(row.targetPrice==null?'-':Number(row.targetPrice).toFixed(2))+'</td></tr>').join(''):'<tr><td colspan="5" class="muted">空</td></tr>';
  const reviewRows=reviews.length?reviews.map((row)=>'<tr><td class="muted">'+esc(row.date||'-')+'</td><td>'+esc(row.summary||'(无摘要)')+'</td><td class="muted">'+esc(row.generatedAt||'-')+'</td></tr>').join(''):'<tr><td colspan="3" class="muted">无最近复盘</td></tr>';
  const viewpointRows=viewpoints.length?viewpoints.map((row)=>'<tr><td class="muted">'+esc(row.sourceDate||'-')+'</td><td>'+esc(row.view||'-')+'</td><td class="muted">'+esc(row.status||'-')+'</td></tr>').join(''):'<tr><td colspan="3" class="muted">无</td></tr>';
  panel.innerHTML=
    '<div class="metrics" style="margin-bottom:8px">'+metric(summary.holdingCount,'持仓')+metric(summary.watchlistCount,'自选')+metric(summary.planCount,'预案')+metric(summary.activeWatchRuleCount+'/'+summary.totalWatchRuleCount,'生效规则')+metric(summary.latestReviewDate||'-','最近复盘')+metric(summary.openViewpointCount,'待复盘观点')+'</div>'+
    '<details><summary>持仓明细(最多 12 条)</summary><table class="kv-table"><thead><tr><th>代码</th><th>名称</th><th>买入日</th><th>成本价</th></tr></thead><tbody>'+holdingsRows+'</tbody></table></details>'+
    '<details><summary>自选明细(最多 12 条)</summary><table class="kv-table"><thead><tr><th>代码</th><th>名称</th><th>备注</th></tr></thead><tbody>'+watchlistRows+'</tbody></table></details>'+
    '<details><summary>预案明细(最多 12 条)</summary><table class="kv-table"><thead><tr><th>代码</th><th>名称</th><th>支撑</th><th>阻力</th><th>目标</th></tr></thead><tbody>'+planRows+'</tbody></table></details>'+
    '<details><summary>最近复盘产物(最多 5 条)</summary><table class="kv-table"><thead><tr><th>日期</th><th>摘要</th><th>生成时间</th></tr></thead><tbody>'+reviewRows+'</tbody></table></details>'+
    '<details><summary>最近复盘观点(最多 5 条)</summary><table class="kv-table"><thead><tr><th>来源日</th><th>观点</th><th>状态</th></tr></thead><tbody>'+viewpointRows+'</tbody></table></details>'+
    '<div class="muted" style="margin-top:6px">更新于 '+esc(data.updatedAt||'-')+'。数据修改请通过用户对话 + MCP 确认流程。</div>';
}

function renderResetTestInstancePanel(){
  return '<div class="item" id="resetTestInstancePanel" style="display:none;margin-top:10px">'+
    '<div class="item-line"><strong>重置默认测试实例</strong><span class="muted">保留实例，清空测试数据</span></div>'+
    '<div class="muted" style="margin-top:6px">会清空微信绑定、业务数据、对话 trace、任务和 workspace，并重新套用模板。请输入 RESET 后执行。</div>'+
    '<div class="ops"><input id="resetTestInstanceInput" class="input" placeholder="输入 RESET 确认" /><button class="btn btn-primary" onclick="resetSelectedTestInstance()">确认重置</button><button class="btn" onclick="hideResetTestInstancePanel()">取消</button></div>'+
    '<div id="resetTestInstanceError" class="error" style="display:none;margin-top:8px"></div></div>';
}
function showResetTestInstancePanel(){const panel=document.getElementById('resetTestInstancePanel');if(!panel)return;panel.style.display='block';const input=document.getElementById('resetTestInstanceInput');if(input){input.value='';input.focus();}}
function hideResetTestInstancePanel(){const panel=document.getElementById('resetTestInstancePanel');if(panel)panel.style.display='none';const error=document.getElementById('resetTestInstanceError');if(error)error.style.display='none';}

function renderWeixinPanel(item){
  const id=esc(item.instanceId);
  return '<div class="item">'+
    '<div class="item-line"><strong id="wxStage-'+id+'">加载中</strong><span id="wxUpdated-'+id+'">-</span></div>'+
    '<div class="muted" id="wxMessage-'+id+'" style="margin-top:6px">正在读取微信状态...</div>'+
    '<div class="ops"><button class="btn btn-primary" onclick="wxConnectSelected()">连接微信</button><button class="btn" onclick="wxListenSelected()">启动监听</button><button class="btn" onclick="wxTestSelected()">测试推送</button><button class="btn" onclick="wxStopSelected()">断开</button><button class="btn" onclick="refreshWeixinStatus(\\''+id+'\\')">刷新</button></div>'+
    '<div class="qr-box" id="wxQrBox-'+id+'"><div class="muted">请使用微信扫码，并在微信中确认登录。</div><img id="wxQrImg-'+id+'" alt="微信登录二维码" /><div class="mono" id="wxQrLink-'+id+'"></div></div>'+
    '<div class="log" id="wxLog-'+id+'" style="margin-top:10px">-</div></div>';
}

function renderBindings(rows){
  if(!rows.length)return '<div class="empty">暂无微信绑定；用户先给该助手对应微信发消息后会出现绑定。</div>';
  return '<div class="list">'+rows.map((row)=>'<div class="item"><div class="item-line"><strong>'+esc(row.channel||'-')+'</strong><span>'+esc(fmtTime(row.updatedAt))+'</span></div><div class="muted" style="margin-top:6px">外部账号 '+esc(row.externalAccountId||'-')+' · 用户尾号 '+esc(row.externalUserIdSuffix||'-')+'</div></div>').join('')+'</div>';
}

function openCreateModal(){document.getElementById('createError').style.display='none';document.getElementById('createModal').style.display='flex';setTimeout(()=>document.getElementById('createUserId').focus(),50);}
function closeCreateModal(){document.getElementById('createModal').style.display='none';}

async function createInstance(){
  const error=document.getElementById('createError');
  error.style.display='none';
  const userId=document.getElementById('createUserId').value.trim();
  const displayName=document.getElementById('createDisplayName').value.trim();
  const instanceName=document.getElementById('createInstanceName').value.trim();
  try{
    const res=await fetch('/api/platform/instances',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,displayName,instanceName})});
    const data=await res.json();
    if(!data.ok)throw new Error(data.error||'创建失败');
    selectedInstanceId=data.instance.instanceId;
    closeCreateModal();
    await loadPlatform();
    if(data.portalCredential){await copyPortalCredential(data.portalCredential);alert('用户助手已创建，门户登录信息已复制到剪贴板。');}
  }catch(err){error.textContent=err.message;error.style.display='block';}
}

function portalChatUrl(){const baseUrl=String(PLATFORM_CONFIG.portalPublicUrl||'http://localhost:3100').replace(/\\/+$/,'');return baseUrl.endsWith('/chat')?baseUrl:baseUrl+'/chat';}
function portalCredentialText(credential){return ['你的投资助手门户已开通：','访问地址：'+portalChatUrl(),'账号：'+(credential.username||''),'临时密码：'+(credential.temporaryPassword||''),'首次登录后请按页面提示修改密码。'].join('\\n');}
async function copyText(text){if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}const textarea=document.createElement('textarea');textarea.value=text;textarea.setAttribute('readonly','true');textarea.style.position='fixed';textarea.style.left='-9999px';document.body.appendChild(textarea);textarea.select();document.execCommand('copy');document.body.removeChild(textarea);}
async function copyPortalCredential(credential){await copyText(portalCredentialText(credential));}

async function provisionSelectedPortalCredential(){
  const item=selectedInstance();
  if(!item)return;
  const box=document.getElementById('portalCredentialResult');
  if(box){box.style.display='block';box.innerHTML='<div class="muted">正在生成门户临时密码...</div>';}
  try{
    const data=await platformJson('/api/platform/instances/'+encodeURIComponent(item.instanceId)+'/portal/credential',{method:'POST'});
    await copyPortalCredential(data.portalCredential);
    if(box){box.innerHTML='<div class="item-line"><strong>门户登录信息已复制</strong><span>'+esc(fmtTime(data.updatedAt))+'</span></div><div class="muted" style="margin-top:6px">账号 '+esc(data.portalCredential.username)+' · 临时密码已生成；再次点击会重置为新的临时密码。</div><pre class="log" style="margin-top:8px">'+esc(portalCredentialText(data.portalCredential))+'</pre>';}
  }catch(err){if(box){box.innerHTML='<div class="error" style="display:block;margin:0">'+esc(err.message)+'</div>';}else{alert(err.message);}}
}

async function archiveSelectedInstance(){
  const item=selectedInstance();
  if(!item)return;
  if(item.instanceId==='invest-agent-primary'){alert('默认测试实例不能删除；请使用“重置测试实例”。');return;}
  const ok=confirm('确认删除用户助手「'+item.name+'」？\\n\\n这会删除该用户助手的数据库记录、微信绑定、业务数据和工作区。默认测试实例不能删除，只能重置。');
  if(!ok)return;
  await platformJson('/api/platform/instances/'+encodeURIComponent(item.instanceId),{method:'DELETE'});
  selectedInstanceId='';
  await loadPlatform();
}

async function resetSelectedTestInstance(){
  const item=selectedInstance();
  if(!item)return;
  const error=document.getElementById('resetTestInstanceError');
  if(error)error.style.display='none';
  if(item.instanceId!=='invest-agent-primary'){if(error){error.textContent='目前只有默认测试实例支持重置。';error.style.display='block';}return;}
  const typed=(document.getElementById('resetTestInstanceInput')?.value||'').trim();
  if(typed!=='RESET'){if(error){error.textContent='请输入 RESET 确认重置。';error.style.display='block';}return;}
  try{
    await platformJson('/api/platform/instances/'+encodeURIComponent(item.instanceId)+'/reset-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'RESET_DEFAULT_TEST_INSTANCE'})});
    selectedInstanceId=item.instanceId;
    await loadPlatform();
  }catch(err){if(error){error.textContent=err.message;error.style.display='block';}}
}

async function ensureSelectedWorkspace(){const item=selectedInstance();if(!item)return;await platformJson('/api/platform/instances/'+encodeURIComponent(item.instanceId)+'/workspace/ensure',{method:'POST'});await loadPlatform();}

function wxIds(instanceId){return {stage:document.getElementById('wxStage-'+instanceId),updated:document.getElementById('wxUpdated-'+instanceId),message:document.getElementById('wxMessage-'+instanceId),qrBox:document.getElementById('wxQrBox-'+instanceId),qrImg:document.getElementById('wxQrImg-'+instanceId),qrLink:document.getElementById('wxQrLink-'+instanceId),log:document.getElementById('wxLog-'+instanceId)};}
function renderWeixinState(instanceId,state){if(instanceId!==selectedInstanceId)return;const els=wxIds(instanceId);if(!els.stage)return;els.stage.textContent=(state.stage||'-')+(state.listenerRunning?' · 监听中':'');els.updated.textContent=state.updatedAt||'-';const delivery=state.delivery||{};const window=delivery.observedContextWindow;const windowText=window?.firstContextRejectedAfterInboundMs!=null?('context 在 '+formatDuration(window.firstContextRejectedAfterInboundMs)+' 后首次被拒绝'):window?.lastAcceptedAfterInboundMs!=null?('context 已验证至少 '+formatDuration(window.lastAcceptedAfterInboundMs)+' 可用'):'';els.message.textContent=[state.message||'-',state.accountId?'账号 '+state.accountId:'',state.pushReady?'可主动推送':'等待该微信先发一条消息后可推送',delivery.lastInboundAt?'最近入站 '+delivery.lastInboundAt:'尚无入站会话',delivery.estimatedExpiryAt?'预计窗口截止 '+delivery.estimatedExpiryAt:'',delivery.latestAttempt?('最近投递 '+delivery.latestAttempt.result+'/'+delivery.latestAttempt.reason):'',windowText].filter(Boolean).join(' · ');if(state.qrcodeUrl){els.qrBox.style.display='grid';els.qrImg.src=state.qrcodeDataUrl||'';els.qrLink.textContent=state.qrcodeUrl;}else{els.qrBox.style.display='none';els.qrImg.src='';els.qrLink.textContent='';}els.log.textContent=JSON.stringify(state,null,2);}
function formatDuration(ms){const minutes=Math.floor(Number(ms||0)/60000);if(minutes<60)return minutes+' 分钟';const hours=Math.floor(minutes/60);return hours+' 小时'+(minutes%60?(minutes%60)+' 分':'');}
async function refreshWeixinStatus(instanceId=selectedInstanceId){if(!instanceId)return;try{const state=await platformJson('/api/platform/instances/'+encodeURIComponent(instanceId)+'/weixin/status');renderWeixinState(instanceId,state);}catch(err){const els=wxIds(instanceId);if(els.log)els.log.textContent=err.message;}}
async function wxAction(path,options={}){const item=selectedInstance();if(!item)return;const state=await platformJson('/api/platform/instances/'+encodeURIComponent(item.instanceId)+'/weixin/'+path,options);renderWeixinState(item.instanceId,state.state||state);}
async function wxConnectSelected(){await wxAction('connect/start',{method:'POST'});}
async function wxListenSelected(){await wxAction('listener/start',{method:'POST'});}
async function wxStopSelected(){await wxAction('connect/stop',{method:'POST'});}
async function wxTestSelected(){await wxAction('push/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});}
`;
