export function renderPartnerPlatformPage(options: { authenticated?: boolean } = {}): string {
  const authenticated = Boolean(options.authenticated);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invest Agent 经营看板</title>
  <style>
    :root { color-scheme: light; --ink:#172033; --muted:#64748b; --line:#dbe3ee; --blue:#2563eb; --blue-soft:#eff6ff; --green:#15803d; --amber:#a16207; --red:#b91c1c; }
    * { box-sizing:border-box; }
    body { margin:0; background:#f5f7fb; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input { font:inherit; }
    .login-shell { min-height:100vh; display:grid; place-items:center; padding:24px; }
    .login-card { width:min(420px,100%); background:#fff; border:1px solid var(--line); border-radius:10px; padding:28px; box-shadow:0 14px 40px rgba(15,23,42,.08); }
    .brand { font-size:20px; font-weight:750; color:#0f172a; }
    .eyebrow { color:var(--blue); font-size:12px; font-weight:700; letter-spacing:.04em; margin-bottom:8px; }
    .help { color:var(--muted); font-size:13px; line-height:1.55; margin:9px 0 20px; }
    .field { margin-top:13px; }
    .field label { display:block; color:var(--muted); font-size:12px; margin-bottom:6px; }
    input { width:100%; border:1px solid #cbd5e1; border-radius:7px; padding:10px 11px; outline:none; background:#fff; }
    input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
    .btn { border:1px solid #cbd5e1; border-radius:7px; background:#fff; padding:9px 13px; cursor:pointer; color:#334155; }
    .btn-primary { border-color:var(--blue); background:var(--blue); color:#fff; width:100%; margin-top:18px; }
    .btn:disabled { opacity:.55; cursor:not-allowed; }
    .error { display:none; border:1px solid #fecdd3; background:#fff1f2; color:#9f1239; border-radius:7px; padding:9px 10px; font-size:12px; margin-top:12px; }
    .shell { min-height:100vh; display:grid; grid-template-columns:220px 1fr; }
    aside { background:#fff; border-right:1px solid var(--line); padding:22px 14px; }
    .brand small { display:block; color:var(--muted); font-size:11px; font-weight:400; margin-top:5px; }
    nav { display:grid; gap:5px; margin-top:25px; }
    nav button { border:0; background:transparent; border-radius:7px; padding:10px; text-align:left; color:#475569; cursor:pointer; font-size:13px; }
    nav button.active, nav button:hover { background:var(--blue-soft); color:#1d4ed8; font-weight:650; }
    main { min-width:0; padding:24px; }
    .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; margin-bottom:18px; }
    h1 { margin:0; font-size:23px; letter-spacing:0; }
    h2 { margin:0; font-size:15px; }
    .sub { color:var(--muted); font-size:12px; margin-top:6px; }
    .userbar { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:12px; }
    .btn-small { padding:7px 10px; font-size:12px; }
    .view { display:none; }
    .view.active { display:block; }
    .stats { display:grid; grid-template-columns:repeat(4,minmax(130px,1fr)); gap:12px; margin-bottom:14px; }
    .stat,.panel { background:#fff; border:1px solid var(--line); border-radius:9px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    .stat { padding:14px; }
    .stat strong { display:block; font-size:23px; line-height:1.1; color:#0f172a; }
    .stat span { display:block; color:var(--muted); font-size:12px; margin-top:7px; }
    .grid { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr); gap:14px; align-items:start; }
    .panel-head { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:13px 15px; border-bottom:1px solid #e5eaf1; }
    .panel-body { padding:14px 15px; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th,td { padding:10px 8px; border-bottom:1px solid #edf1f6; text-align:left; white-space:nowrap; }
    th { color:var(--muted); font-weight:650; background:#fbfdff; }
    tr:last-child td { border-bottom:0; }
    .link { border:0; background:transparent; padding:0; color:#1d4ed8; cursor:pointer; font-size:12px; }
    .badge { display:inline-flex; align-items:center; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:650; }
    .ok { background:#dcfce7; color:var(--green); }
    .attention { background:#fef3c7; color:var(--amber); }
    .blocked { background:#fee2e2; color:var(--red); }
    .neutral { background:#f1f5f9; color:#475569; }
    .metric-list { display:grid; gap:9px; }
    .metric-row { display:flex; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px solid #edf1f6; font-size:12px; }
    .metric-row:last-child { border-bottom:0; }
    .metric-row span { color:var(--muted); }
    .metric-row strong { color:#172033; }
    .note { color:var(--muted); font-size:12px; line-height:1.55; }
    .empty { color:#94a3b8; text-align:center; padding:28px 10px; font-size:13px; }
    .pagination { display:flex; justify-content:center; padding:14px 0 2px; }
    .loading { color:var(--muted); font-size:13px; padding:18px 0; }
    .notice { display:none; margin-bottom:14px; border-radius:8px; padding:10px 12px; font-size:12px; background:#fff1f2; border:1px solid #fecdd3; color:#9f1239; }
    .detail { margin-top:14px; }
    .detail-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
    .detail-item { border:1px solid #e2e8f0; background:#f8fafc; border-radius:7px; padding:9px; }
    .detail-item span { display:block; color:var(--muted); font-size:11px; }
    .detail-item strong { display:block; color:#172033; font-size:13px; margin-top:5px; }
    @media (max-width:900px) { .shell{display:block} aside{border-right:0;border-bottom:1px solid var(--line)} nav{display:flex;overflow:auto;margin-top:16px} nav button{white-space:nowrap} main{padding:18px 14px} .topbar{flex-direction:column} .stats{grid-template-columns:repeat(2,minmax(130px,1fr))} .grid{grid-template-columns:1fr} }
    @media (max-width:520px) { .stats{grid-template-columns:1fr 1fr;gap:8px} .stat strong{font-size:20px} .detail-grid{grid-template-columns:1fr 1fr} }
  </style>
</head>
<body>
${authenticated ? `
  <div class="shell">
    <aside>
      <div class="brand">Invest Agent<small>合伙人经营看板</small></div>
      <nav>
        <button class="active" data-view="overview">经营总览</button>
        <button data-view="customers">客户与助手</button>
        <button data-view="quality">产品质量</button>
        <button data-view="runtime">运行与触达</button>
      </nav>
    </aside>
    <main>
      <div class="topbar">
        <div><h1 id="title">经营总览</h1><div class="sub" id="updated">正在加载...</div></div>
        <div class="userbar"><span id="userName">合伙人</span><button class="btn btn-small" id="logout">退出登录</button></div>
      </div>
      <div id="notice" class="notice"></div>
      <section class="view active" id="view-overview"><div id="overview"><div class="loading">正在读取经营数据...</div></div></section>
      <section class="view" id="view-customers"><div class="panel"><div class="panel-head"><h2>客户与助手</h2><span class="sub">只显示运营状态，不含投资明细</span></div><div class="panel-body" id="customers"><div class="loading">正在读取客户状态...</div></div></div><div id="customerDetail" class="detail"></div></section>
      <section class="view" id="view-quality"><div class="panel"><div class="panel-head"><h2>产品质量</h2><span class="sub">近 7 日聚合</span></div><div class="panel-body" id="quality"><div class="loading">正在读取质量指标...</div></div></div></section>
      <section class="view" id="view-runtime"><div class="panel"><div class="panel-head"><h2>运行与触达</h2><span class="sub">当前运行状态摘要</span></div><div class="panel-body" id="runtime"><div class="loading">正在读取运行状态...</div></div></div></section>
    </main>
  </div>` : `
  <div class="login-shell"><form class="login-card" id="loginForm">
    <div class="eyebrow">INVEST AGENT PLATFORM</div><div class="brand">经营看板登录</div>
    <p class="help">使用后台账号登录。合伙人账号只用于查看经营状态和产品运行情况。</p>
    <div class="field"><label for="username">账号</label><input id="username" autocomplete="username" required /></div>
    <div class="field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required /></div>
    <div id="loginError" class="error"></div><button class="btn btn-primary" type="submit">登录</button>
  </form></div>`}
  <script>
    const authenticated = ${authenticated ? "true" : "false"};
    const json = async (url, options) => { const res = await fetch(url, { credentials:'same-origin', ...options }); const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error || '请求失败'); return body; };
    if (!authenticated) {
      document.getElementById('loginForm').addEventListener('submit', async (event) => {
        event.preventDefault(); const error = document.getElementById('loginError'); error.style.display='none';
        const button = event.currentTarget.querySelector('button'); button.disabled=true;
        try { const result = await json('/api/platform/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ username:document.getElementById('username').value, password:document.getElementById('password').value }) });
          if (result.mustChangePassword) {
            const card = document.querySelector('.login-card');
            card.innerHTML='<div class="eyebrow">INVEST AGENT PLATFORM</div><div class="brand">首次登录需要改密</div><p class="help">请设置一个至少 12 位的新密码，完成后才能进入经营看板。</p><form id="passwordForm"><div class="field"><label for="currentPassword">当前密码</label><input id="currentPassword" type="password" autocomplete="current-password" required /></div><div class="field"><label for="newPassword">新密码</label><input id="newPassword" type="password" autocomplete="new-password" minlength="12" required /></div><div id="passwordError" class="error"></div><button class="btn btn-primary" type="submit">更新密码</button></form>';
            document.getElementById('passwordForm').addEventListener('submit', async (passwordEvent) => {
              passwordEvent.preventDefault(); const passwordError=document.getElementById('passwordError'); passwordError.style.display='none'; const passwordButton=passwordEvent.currentTarget.querySelector('button'); passwordButton.disabled=true;
              try { await json('/api/platform/auth/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:document.getElementById('currentPassword').value,newPassword:document.getElementById('newPassword').value})}); window.location.reload(); }
              catch (passwordFailure) { passwordError.textContent=passwordFailure.message || '密码更新失败'; passwordError.style.display='block'; passwordButton.disabled=false; }
            });
            return;
          }
          window.location.reload();
        } catch (e) { error.textContent=e.message || '账号或密码错误'; error.style.display='block'; } finally { button.disabled=false; }
      });
    } else {
      const state = { loaded: new Set(), customers: [] };
      const escape = (value) => String(value ?? '-').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
      const pct = (value) => value == null ? '-' : (Number(value) * 100).toFixed(1) + '%';
      const statusBadge = (value) => { const text = ({ok:'正常',attention:'需关注',blocked:'异常',completed:'已完成',drafting:'配置中',committing:'提交中',not_started:'未开始',exception:'异常',active:'运行中',inactive:'未启用'}[value] || value || '未知'); const cls = ['ok','attention','blocked'].includes(value) ? value : (['completed','active'].includes(value) ? 'ok' : (['exception','blocked'].includes(value) ? 'blocked' : 'neutral')); return '<span class="badge '+cls+'">'+escape(text)+'</span>'; };
      const showError = (message) => { const el=document.getElementById('notice'); el.textContent=message; el.style.display='block'; };
      const setView = (name) => { document.querySelectorAll('nav button').forEach((button) => button.classList.toggle('active', button.dataset.view===name)); document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id==='view-'+name)); document.getElementById('title').textContent=({overview:'经营总览',customers:'客户与助手',quality:'产品质量',runtime:'运行与触达'})[name]; if (!state.loaded.has(name)) loadView(name); };
      document.querySelectorAll('nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
      document.getElementById('logout').addEventListener('click', async () => { await json('/api/platform/auth/logout',{method:'POST'}).catch(()=>{}); window.location.reload(); });
      const loadView = async (name) => { try { if(name==='overview') await loadOverview(); if(name==='customers') await loadCustomers(); if(name==='quality') await loadQuality(); if(name==='runtime') await loadRuntime(); state.loaded.add(name); } catch(e) { showError(e.message || '数据读取失败'); } };
      const finishUpdated = (data) => { document.getElementById('updated').textContent = '数据更新时间：' + (data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '-'); };
      const loadOverview = async () => { const data=await json('/api/platform/partner/overview'); finishUpdated(data); const m=data.metrics||{}; document.getElementById('overview').innerHTML='<div class="stats">'+[['customersTotal','客户总数'],['activeCustomers7d','近 7 日活跃'],['onboardingCompleted','已完成初始配置'],['conversationCountToday','今日对话']].map(([key,label])=>'<div class="stat"><strong>'+escape(m[key] ?? '-')+'</strong><span>'+label+'</span></div>').join('')+'</div><div class="grid"><div class="panel"><div class="panel-head"><h2>今日经营信号</h2><span class="sub">'+escape(data.timeRange?.timezone || 'Asia/Shanghai')+'</span></div><div class="panel-body"><div class="metric-list">'+[['conversationSuccessRateToday','对话成功率',pct],['responseP50MsToday','响应 P50',v=>v==null?'-':v+' ms'],['responseP95MsToday','响应 P95',v=>v==null?'-':v+' ms'],['reviewCoverageToday','今日复盘覆盖率',pct],['pushDeliveryRateToday','推送送达率',pct],['qualityExceptionCountToday','质量异常',v=>v==null?'-':v]].map(([key,label,format])=>'<div class="metric-row"><span>'+label+'</span><strong>'+format(m[key])+'</strong></div>').join('')+'</div></div></div><div class="panel"><div class="panel-head"><h2>需要关注</h2></div><div class="panel-body">'+((data.exceptions||[]).length ? '<div class="metric-list">'+data.exceptions.map(item=>'<div class="metric-row"><span>'+escape(item.type)+'</span><strong>'+escape(item.count)+' 个客户</strong></div>').join('')+'</div>' : '<div class="empty">暂无异常</div>')+'</div></div></div>'; };
      const loadCustomers = async (cursor=null, append=false) => { const data=await json('/api/platform/partner/customers?limit=50'+(cursor ? '&cursor='+encodeURIComponent(cursor) : '')); finishUpdated(data); state.customers=append ? state.customers.concat(data.customers||[]) : (data.customers||[]); const rows=state.customers.map((item,index)=>'<tr><td>'+escape(item.customerLabel)+'</td><td>'+statusBadge(item.onboardingStatus)+'</td><td>'+statusBadge(item.health)+'</td><td>'+escape(item.notificationPreference)+'</td><td>'+escape(item.conversationCount7d)+'</td><td>'+statusBadge(item.lastPushStatus)+'</td><td><button class="link" data-customer="'+index+'">查看运营摘要</button></td></tr>').join(''); const next=data.page?.nextCursor; document.getElementById('customers').innerHTML=rows ? '<div class="table-wrap"><table><thead><tr><th>客户</th><th>初始配置</th><th>健康度</th><th>通知偏好</th><th>近 7 日对话</th><th>最近推送</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(next ? '<div class="pagination"><button class="btn btn-small" id="loadMoreCustomers">加载更多客户</button></div>' : '') : '<div class="empty">暂无客户数据</div>'; document.querySelectorAll('[data-customer]').forEach((button)=>button.addEventListener('click',()=>loadCustomerDetail(state.customers[Number(button.dataset.customer)]))); document.getElementById('loadMoreCustomers')?.addEventListener('click',()=>loadCustomers(next,true)); };
      const loadCustomerDetail = async (item) => { if(!item) return; const data=await json('/api/platform/partner/customers/'+encodeURIComponent(item.customerKey)+'/operations'); const c=data.customer||{}; const s=data.setup||{}; const u=data.usage||{}; const d=data.delivery||{}; const q=data.quality||{}; document.getElementById('customerDetail').innerHTML='<div class="panel"><div class="panel-head"><h2>'+escape(c.customerLabel)+'</h2><span class="sub">运营摘要</span></div><div class="panel-body"><div class="detail-grid">'+[['初始配置',statusBadge(s.onboardingStatus)],['通知偏好',escape(s.notificationPreference)],['启用规则',escape(s.enabledRuleCount)],['近 7 日对话',escape(u.conversationCount7d)],['近 30 日复盘',escape(u.reviewCount30d)],['近 7 日推送',escape(u.pushCount7d)],['微信绑定',d.wechatBound?'已绑定':'未绑定'],['推送可达',d.pushReachable?'可达':'不可达'],['最近推送',statusBadge(d.lastPushStatus)],['超时',escape(q.timeoutCount7d)],['错误',escape(q.errorCount7d)],['重复确认',escape(q.repeatConfirmationCount7d)]].map(([label,value])=>'<div class="detail-item"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</div></div></div>'; };
      const listMetrics = (data) => { const items=data.items||[]; return items.length ? '<div class="metric-list">'+items.map(item=>'<div class="metric-row"><span>'+escape(item.type)+'</span><strong>'+statusBadge(item.status)+' '+escape(item.count)+' 次</strong></div>').join('')+'</div>' : '<div class="empty">暂无数据</div>'; };
      const loadQuality = async () => { const data=await json('/api/platform/partner/quality'); finishUpdated(data); document.getElementById('quality').innerHTML=listMetrics(data)+'<p class="note">指标按近 7 日聚合；数据缺失会标记为部分可用，不会以 0 代替。</p>'; };
      const loadRuntime = async () => { const data=await json('/api/platform/partner/runtime-health'); finishUpdated(data); document.getElementById('runtime').innerHTML=listMetrics(data)+'<p class="note">这里只展示运行与触达状态摘要，不包含消息正文、账号标识或管理操作。</p>'; };
      loadView('overview');
    }
  </script>
</body>
</html>`;
}
