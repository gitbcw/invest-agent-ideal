// Owner 视图 C：MCP 工具状态 + 数据源质量（历史）。
// MCP 工具状态 (T-243) 消费 /api/platform/mcp-tools/status,把 observer 写入的
// external_mcp_tool_calls 接通成可见 (此前该表只写不读)。
// 数据源质量 (历史) 消费 /api/platform/source-quality;service-owned 数据源已 retired。

export const SOURCE_JS = `
async function loadMcpToolsStatus(){
  const root=document.getElementById('mcpToolsPanel');
  if(root)root.innerHTML='<div class="empty">正在加载 MCP 工具状态...</div>';
  try{const res=await platformJson('/api/platform/mcp-tools/status?days=7');MCP_TOOLS=res;renderMcpToolsStatus();}
  catch(error){document.getElementById('mcpToolsPanel').innerHTML='<div class="error" style="display:block">MCP 工具状态加载失败: '+esc(error.message)+'</div>';}
}
function renderMcpToolsStatus(){
  const root=document.getElementById('mcpToolsPanel');
  if(!root||!MCP_TOOLS)return;
  document.getElementById('mcpToolsUpdated').textContent='更新于 '+fmtTime(MCP_TOOLS.updatedAt);
  const regs=MCP_TOOLS.registrations||[];
  const stats=MCP_TOOLS.stats||[];
  const activeCount=regs.filter((r)=>r.activated).length;
  const totalCalls=stats.reduce((sum,s)=>sum+s.totalCalls,0);
  const totalFailed=stats.reduce((sum,s)=>sum+s.failed,0);
  const overallRate=totalCalls>0?(((totalCalls-totalFailed)/totalCalls)*100).toFixed(1):'-';
  root.innerHTML=
    '<div class="section" style="margin-top:0"><h3>MCP 工具概览</h3><div class="cost-summary">'+stat(fmtNumber(regs.length),'已声明工具')+stat(fmtNumber(activeCount),'当前激活')+stat(fmtNumber(totalCalls),'窗口内调用')+stat(overallRate==='-'?'-':(overallRate+'%'),'整体成功率')+'</div><div class="cost-source">'+badge('窗口: '+MCP_TOOLS.days+' 天','info')+badge('数据源 external_mcp_tool_calls','gray')+'</div></div>'+
    '<div class="section"><h3>已接入 MCP Server</h3>'+renderMcpRegistrationsTable(regs)+'</div>'+
    '<div class="section"><h3>工具调用统计</h3>'+renderMcpStatsTable(stats)+'</div>';
}
function renderMcpRegistrationsTable(rows){
  if(!rows.length)return '<div class="empty">暂无已声明的外部 MCP server</div>';
  return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>Server</th><th>信任级别</th><th>会话场景</th><th>激活</th></tr></thead><tbody>'+rows.map((r)=>'<tr><td class="mono"><strong>'+esc(r.id)+'</strong></td><td>'+badge(r.trustClass==='external-readonly'?'外部只读':r.trustClass,r.trustClass==='external-readonly'?'info':'gray')+'</td><td class="muted">'+esc((r.sessionKinds||[]).join(', ')||'-')+'</td><td>'+badge(r.activated?'已激活':'未激活',r.activated?'ok':'gray')+'</td></tr>').join('')+'</tbody></table></div>';
}
function renderMcpStatsTable(rows){
  if(!rows.length)return '<div class="empty">窗口内暂无外部 MCP 工具调用记录;冷启动或外部 MCP 未启用时为正常状态。</div>';
  return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>Server</th><th>工具</th><th>调用</th><th>成功</th><th>失败</th><th>失败率</th><th>P95延迟(ms)</th><th>最近成功</th><th>最近失败</th><th>最近错误</th></tr></thead><tbody>'+rows.map((r)=>{const rateKind=r.failureRate>=0.2?'warn':(r.failureRate>0?'info':'ok');return '<tr><td class="mono">'+esc(r.serverId)+'</td><td class="mono">'+esc(r.toolName)+'</td><td>'+esc(fmtNumber(r.totalCalls))+'</td><td>'+esc(fmtNumber(r.completed))+'</td><td>'+esc(fmtNumber(r.failed))+'</td><td>'+badge((r.failureRate*100).toFixed(1)+'%',rateKind)+'</td><td>'+(r.latencyP95Ms==null?'-':fmtNumber(r.latencyP95Ms))+'</td><td>'+esc(fmtTime(r.lastCompletedAt))+'</td><td>'+esc(fmtTime(r.lastFailedAt))+'</td><td class="mono">'+esc(r.lastErrorClass||'-')+'</td></tr>';}).join('')+'</tbody></table></div>';
}
async function loadSourceQuality(){
  const root=document.getElementById('sourceQualityPanel');
  if(root)root.innerHTML='<div class="empty">正在加载数据源质量...</div>';
  try{SOURCE_QUALITY=await platformJson('/api/platform/source-quality');renderSourceQuality();}
  catch(error){document.getElementById('sourceQualityPanel').innerHTML='<div class="error" style="display:block">数据源质量加载失败: '+esc(error.message)+'</div>';}
}
function renderSourceQuality(){
  const root=document.getElementById('sourceQualityPanel');
  if(!root||!SOURCE_QUALITY)return;
  document.getElementById('sourceQualityUpdated').textContent='更新于 '+fmtTime(SOURCE_QUALITY.updatedAt);
  const endpoints=SOURCE_QUALITY.health?.endpoints||[];
  const capabilities=SOURCE_QUALITY.health?.capabilities||[];
  const latest=SOURCE_QUALITY.reports?.[0]||null;
  const failedNow=endpoints.filter((item)=>item.lastStatus==='fail').length;
  const readyCount=capabilities.filter((item)=>item.status==='ready').length;
  const partialCount=capabilities.filter((item)=>item.status==='partial').length;
  const missingCount=capabilities.filter((item)=>item.status==='missing').length;
  root.innerHTML=
    '<div class="section" style="margin-top:0"><h3>数据源能力总览</h3><div class="cost-summary">'+stat(fmtNumber(readyCount),'可用能力')+stat(fmtNumber(partialCount),'部分可用')+stat(fmtNumber(missingCount),'缺失能力')+stat(fmtNumber(endpoints.length),'数据源端点')+'</div><div class="cost-source">'+badge('服务层数据','info')+badge('可靠服务目标: fallback + freshness + audit','warn')+'</div></div>'+
    '<div class="section"><h3>能力矩阵</h3>'+renderSourceCapabilityTable(capabilities)+'</div>'+
    '<div class="section"><h3>当前数据源健康</h3><div class="cost-summary">'+stat(fmtNumber(endpoints.length),'已观测端点')+stat(fmtNumber(failedNow),'当前失败')+stat(fmtNumber(latest?.totalFailures||0),'最近日报失败')+stat(fmtNumber(latest?.totalDegraded||0),'最近日报降级')+'</div><div class="cost-source">'+badge('服务层数据','info')+badge('目录 '+(SOURCE_QUALITY.sourceQualityDir||'-'),'gray')+'</div></div>'+
    '<div class="section"><h3>端点状态</h3>'+renderSourceEndpointTable(endpoints)+'</div>'+
    '<div class="section"><h3>最近质量日报</h3>'+renderSourceReportTable(SOURCE_QUALITY.reports||[])+'</div>'+
    '<div class="section"><h3>近期质量告警</h3>'+renderSourceAlertTable(SOURCE_QUALITY.alerts||[])+'</div>';
}
function renderSourceCapabilityTable(rows){if(!rows.length)return '<div class="empty">暂无数据源能力声明</div>';const statusLabel={ready:'可用',partial:'部分可用',missing:'缺失'};const statusKind={ready:'ok',partial:'warn',missing:'gray'};return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>能力</th><th>状态</th><th>证据等级</th><th>主源</th><th>备用源</th><th>业务用途</th><th>使用边界</th><th>缺口</th><th>下一步</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td><strong>'+esc(row.name||row.key||'-')+'</strong><div class="muted mono">'+esc(row.key||'-')+'</div></td><td>'+badge(statusLabel[row.status]||row.status||'-',statusKind[row.status]||'gray')+'</td><td>'+renderEvidenceBadge(row.evidenceLevel)+'</td><td class="mono">'+esc((row.primaryProviders||[]).join(', ')||'-')+'</td><td class="mono">'+esc((row.fallbackProviders||[]).join(', ')||'无')+'</td><td>'+esc(row.businessUse||'-')+'</td><td>'+esc(row.usageBoundary||'-')+'</td><td>'+esc((row.gaps||[]).join('；')||'-')+'</td><td>'+esc(row.nextStep||'-')+'</td></tr>').join('')+'</tbody></table></div>';}
function renderEvidenceBadge(level){const labels={primary_fact:'事实',secondary_evidence:'辅助证据',signal:'观察信号',operational:'运行规则'};const kinds={primary_fact:'ok',secondary_evidence:'info',signal:'warn',operational:'gray'};return badge(labels[level]||level||'-',kinds[level]||'gray');}
function renderSourceEndpointTable(rows){if(!rows.length)return '<div class="empty">暂无数据源调用记录；冷启动或尚未请求行情时是正常状态。</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>数据源</th><th>端点</th><th>证据等级</th><th>置信度</th><th>状态</th><th>调用</th><th>失败</th><th>连续失败</th><th>P95延迟(ms)</th><th>最近成功</th><th>最近错误</th></tr></thead><tbody>'+rows.map((row)=>{const statusKind=row.lastStatus==='ok'?'ok':(row.lastStatus==='fail'?'warn':'gray');return '<tr><td class="mono">'+esc(row.provider||'-')+'</td><td class="mono">'+esc(row.endpoint||'-')+'</td><td>'+renderEvidenceBadge(row.evidenceLevel)+'</td><td>'+esc(row.confidence||'-')+'</td><td>'+badge(row.lastStatus||'unknown',statusKind)+'</td><td>'+esc(fmtNumber(row.totalCalls))+'</td><td>'+esc(fmtNumber(row.totalFailures))+'</td><td>'+esc(fmtNumber(row.consecutiveFailures))+'</td><td>'+esc(row.recentLatencyP95==null?'-':fmtNumber(row.recentLatencyP95))+'</td><td>'+esc(fmtTime(row.lastSuccessAt))+'</td><td>'+esc(row.lastError||'-')+'</td></tr>';}).join('')+'</tbody></table></div>';}
function renderSourceReportTable(rows){if(!rows.length)return '<div class="empty">暂无质量日报；每日 15:30 后生成，或等待 provider 调用后手动生成。</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>日期</th><th>事件</th><th>端点</th><th>失败</th><th>降级</th><th>最长连续失败</th><th>生成时间</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td class="mono">'+esc(row.dateKey||'-')+'</td><td>'+esc(fmtNumber(row.eventCount))+'</td><td>'+esc(fmtNumber(row.endpointsTouched))+'</td><td>'+esc(fmtNumber(row.totalFailures))+'</td><td>'+esc(fmtNumber(row.totalDegraded))+'</td><td>'+esc(fmtNumber(row.longestFailureStreak))+'</td><td>'+esc(fmtTime(row.generatedAt))+'</td></tr>').join('')+'</tbody></table></div>';}
function renderSourceAlertTable(rows){if(!rows.length)return '<div class="empty">暂无服务层数据源质量告警</div>';return '<div style="overflow:auto"><table class="cost-table"><thead><tr><th>时间</th><th>级别</th><th>数据源</th><th>端点</th><th>用户标签</th><th>消息</th></tr></thead><tbody>'+rows.map((row)=>'<tr><td>'+esc(fmtTime(row.created_at))+'</td><td>'+badge(row.severity||'-',row.severity==='P1'?'warn':'gray')+'</td><td class="mono">'+esc(row.provider||'-')+'</td><td class="mono">'+esc(row.endpoint||'-')+'</td><td class="mono">'+esc(row.userId||'-')+'</td><td>'+esc(row.message||'-')+'</td></tr>').join('')+'</tbody></table></div>';}
`;
