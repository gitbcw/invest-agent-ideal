export function renderPlatformPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invest Agent Platform</title>
  <style>
    body { margin: 0; background: #f5f7fb; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: inherit; text-decoration: none; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 228px 1fr; }
    .sidebar { background: #fff; border-right: 1px solid #d9e0ea; padding: 22px 14px; }
    .brand { color: #111827; font-size: 16px; font-weight: 700; padding: 0 8px 18px; }
    .brand small { display: block; color: #64748b; font-size: 11px; font-weight: 400; margin-top: 5px; }
    .nav { display: flex; flex-direction: column; gap: 6px; }
    .nav a { color: #475569; border-radius: 7px; padding: 9px 10px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    .nav a:hover { background: #eef4ff; color: #1d4ed8; }
    .nav a.active { background: #dbeafe; color: #1d4ed8; font-weight: 650; }
    .main { padding: 24px; min-width: 0; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
    h1 { color: #111827; font-size: 22px; margin: 0; letter-spacing: 0; }
    .sub { color: #64748b; font-size: 12px; margin-top: 5px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .btn { border: 1px solid #cbd5e1; background: #fff; color: #1f2937; border-radius: 7px; padding: 7px 11px; font-size: 12px; cursor: pointer; box-shadow: 0 1px 1px rgba(15,23,42,.04); }
    .btn:hover { background: #f1f5f9; border-color: #94a3b8; }
    .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    .btn-primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
    .input { background: #fff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 7px; padding: 7px 10px; min-width: 230px; outline: none; }
    .input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .stat .value { color: #0f172a; font-size: 24px; font-weight: 750; line-height: 1; }
    .stat .label { color: #64748b; font-size: 12px; margin-top: 8px; }
    .grid { display: grid; grid-template-columns: minmax(360px, .92fr) minmax(420px, 1.08fr); gap: 14px; align-items: start; }
    .panel { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .panel-head { padding: 13px 15px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fbfdff; }
    .panel-head h2 { color: #111827; font-size: 14px; margin: 0; }
    .panel-body { padding: 14px; }
    .instance-list { display: flex; flex-direction: column; gap: 9px; }
    .instance-card { border: 1px solid #d9e0ea; background: #fff; border-radius: 8px; padding: 11px; cursor: pointer; }
    .instance-card:hover { background: #f8fafc; border-color: #9db3d1; }
    .instance-card.selected { background: #eff6ff; border-color: #60a5fa; box-shadow: 0 0 0 1px rgba(96,165,250,.22); }
    .row { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .name { color: #111827; font-weight: 650; font-size: 13px; }
    .muted { color: #64748b; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: #64748b; word-break: break-all; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 650; white-space: nowrap; }
    .badge-ok { background: #dcfce7; color: #166534; }
    .badge-info { background: #dbeafe; color: #1d4ed8; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .badge-warn { background: #fef3c7; color: #92400e; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 7px; }
    .metric strong { display: block; color: #0f172a; font-size: 14px; line-height: 1; }
    .metric span { display: block; color: #64748b; font-size: 11px; margin-top: 5px; }
    .kv { display: grid; grid-template-columns: 118px 1fr; gap: 8px 12px; margin: 0; }
    .kv dt { color: #64748b; font-size: 12px; }
    .kv dd { margin: 0; color: #334155; font-size: 12px; word-break: break-word; }
    .section { margin-top: 14px; }
    .section h3 { margin: 0 0 8px; color: #111827; font-size: 13px; }
    .list { display: flex; flex-direction: column; gap: 7px; }
    .item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 9px; }
    .item-line { display: flex; justify-content: space-between; gap: 10px; color: #334155; font-size: 12px; }
    .empty { color: #94a3b8; text-align: center; padding: 24px 10px; font-size: 13px; }
    .error { background: #fff1f2; border: 1px solid #fda4af; color: #9f1239; border-radius: 8px; padding: 12px; font-size: 13px; margin-bottom: 14px; display: none; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.32); display: none; align-items: center; justify-content: center; padding: 18px; z-index: 20; }
    .modal { width: min(520px, 100%); background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 16px; box-shadow: 0 20px 80px rgba(15,23,42,.18); }
    .modal h2 { margin: 0 0 12px; color: #111827; font-size: 15px; }
    .form-grid { display: grid; gap: 10px; }
    .field label { display: block; color: #64748b; font-size: 12px; margin-bottom: 5px; }
    .field input { width: 100%; box-sizing: border-box; background: #fff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 7px; padding: 8px 10px; outline: none; }
    .field input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .ops { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .qr-box { margin-top: 10px; display: none; gap: 8px; justify-items: start; }
    .qr-box img { width: 220px; max-width: 100%; border: 1px solid #d9e0ea; border-radius: 8px; background: #fff; }
    .log { white-space: pre-wrap; word-break: break-word; background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; max-height: 160px; overflow: auto; font-size: 12px; }
    @media (max-width: 980px) {
      .shell { display: block; }
      .sidebar { border-right: 0; border-bottom: 1px solid #d9e0ea; }
      .nav { flex-direction: row; overflow: auto; }
      .main { padding: 18px 14px; }
      .topbar { flex-direction: column; }
      .stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .input { min-width: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Invest Agent Platform<small>用户实例管理</small></div>
      <nav class="nav">
        <a class="active" href="/platform">实例管理 <span>›</span></a>
        <a href="/dashboard">投资工作台 <span>↗</span></a>
      </nav>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h1>用户实例</h1>
          <div class="sub" id="updatedAt">加载中...</div>
        </div>
        <div class="actions">
          <input id="search" class="input" placeholder="搜索实例、用户、ID" oninput="render()" />
          <button class="btn btn-primary" onclick="openCreateModal()">创建用户实例</button>
          <button class="btn" onclick="loadPlatform()">刷新</button>
        </div>
      </div>
      <div id="error" class="error"></div>
      <section class="stats" id="stats"></section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>Invest Agent 实例</h2>
            <span class="muted" id="instanceCount">0 个实例</span>
          </div>
          <div class="panel-body" id="instanceList"></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>实例详情</h2>
            <span class="muted" id="selectedHint">未选择</span>
          </div>
          <div class="panel-body" id="detail"></div>
        </div>
      </section>
    </main>
  </div>

  <div class="modal-backdrop" id="createModal">
    <div class="modal">
      <h2>创建用户实例</h2>
      <div class="form-grid">
        <div class="field">
          <label>用户 ID</label>
          <input id="createUserId" placeholder="例如 user-zhangsan" />
        </div>
        <div class="field">
          <label>用户显示名</label>
          <input id="createDisplayName" placeholder="例如 张三" />
        </div>
        <div class="field">
          <label>实例名称</label>
          <input id="createInstanceName" placeholder="例如 张三的投资助手，可留空" />
        </div>
        <div id="createError" class="error" style="display:none;margin:0"></div>
        <div class="ops">
          <button class="btn btn-primary" onclick="createInstance()">创建</button>
          <button class="btn" onclick="closeCreateModal()">取消</button>
        </div>
      </div>
    </div>
  </div>

<script>
let DATA = { instances: [] };
let selectedInstanceId = '';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function badge(text, kind = 'gray') {
  return '<span class="badge badge-' + kind + '">' + esc(text) + '</span>';
}

async function loadPlatform() {
  document.getElementById('error').style.display = 'none';
  try {
    const res = await fetch('/api/platform/instances');
    DATA = await res.json();
    if (!DATA.ok) throw new Error(DATA.error || '平台接口返回失败');
    selectedInstanceId = selectedInstanceId || DATA.instances?.[0]?.instanceId || '';
    render();
  } catch (error) {
    const node = document.getElementById('error');
    node.textContent = '加载失败: ' + error.message;
    node.style.display = 'block';
  }
}

function filteredInstances() {
  const keyword = document.getElementById('search').value.trim().toLowerCase();
  const instances = DATA.instances || [];
  if (!keyword) return instances;
  return instances.filter((item) => [
    item.instanceId,
    item.projectId,
    item.name,
    item.owner?.id,
    item.owner?.displayName,
    item.backend,
    item.skillBundleId,
  ].some((value) => String(value || '').toLowerCase().includes(keyword)));
}

function render() {
  const instances = filteredInstances();
  if (!instances.some((item) => item.instanceId === selectedInstanceId)) {
    selectedInstanceId = instances[0]?.instanceId || '';
  }
  document.getElementById('updatedAt').textContent = '更新于 ' + fmtTime(DATA.updatedAt);
  document.getElementById('instanceCount').textContent = instances.length + ' 个实例';
  renderStats(DATA.instances || []);
  renderList(instances);
  renderDetail((DATA.instances || []).find((item) => item.instanceId === selectedInstanceId));
}

function renderStats(instances) {
  const active = instances.filter((item) => item.status === 'active').length;
  const wxBound = instances.filter((item) => item.channelBindingCount > 0).length;
  const conversations = instances.reduce((sum, item) => sum + Number(item.traceCount || 0), 0);
  document.getElementById('stats').innerHTML = [
    stat(instances.length, '实例总数'),
    stat(active, '运行中'),
    stat(wxBound, '已绑定微信'),
    stat(conversations, '对话记录'),
  ].join('');
}

function stat(value, label) {
  return '<div class="stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>';
}

function renderList(instances) {
  const root = document.getElementById('instanceList');
  if (!instances.length) {
    root.innerHTML = '<div class="empty">暂无实例</div>';
    return;
  }
  root.innerHTML = '<div class="instance-list">' + instances.map((item) => {
    const selected = item.instanceId === selectedInstanceId ? ' selected' : '';
    return '<div class="instance-card' + selected + '" onclick="selectInstance(\\'' + esc(item.instanceId) + '\\')">' +
      '<div class="row"><div><div class="name">' + esc(item.name) + '</div><div class="mono">' + esc(item.instanceId) + '</div></div>' +
      badge(item.status || 'active', item.status === 'active' ? 'ok' : 'warn') + '</div>' +
      '<div class="muted" style="margin-top:8px">用户 ' + esc(item.owner?.displayName || item.owner?.id || '-') + ' · ' + esc(item.backend || '-') + '</div>' +
      '<div class="metrics">' +
        metric(item.holdingCount, '持仓') +
        metric(item.watchlistCount, '自选') +
        metric(item.alertRuleCount, '提醒') +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function metric(value, label) {
  return '<div class="metric"><strong>' + esc(value ?? 0) + '</strong><span>' + esc(label) + '</span></div>';
}

function selectInstance(instanceId) {
  selectedInstanceId = instanceId;
  render();
}

function renderDetail(item) {
  const root = document.getElementById('detail');
  document.getElementById('selectedHint').textContent = item ? item.instanceId : '未选择';
  if (!item) {
    root.innerHTML = '<div class="empty">请选择一个实例</div>';
    return;
  }
  root.innerHTML =
    '<dl class="kv">' +
      '<dt>实例名称</dt><dd>' + esc(item.name) + '</dd>' +
      '<dt>实例 ID</dt><dd class="mono">' + esc(item.instanceId) + '</dd>' +
      '<dt>用户</dt><dd>' + esc(item.owner?.displayName || '-') + ' <span class="mono">' + esc(item.owner?.id || '') + '</span></dd>' +
      '<dt>项目类型</dt><dd>' + esc(item.projectType || 'invest-agent') + '</dd>' +
      '<dt>Backend</dt><dd>' + esc(item.backend || '-') + '</dd>' +
      '<dt>Skill Bundle</dt><dd class="mono">' + esc(item.skillBundleId || '-') + '</dd>' +
      '<dt>Workspace</dt><dd>' + badge(item.workspace?.exists ? '已创建' : '缺失', item.workspace?.exists ? 'ok' : 'warn') + ' <span class="mono">' + esc(item.workspace?.path || '-') + '</span></dd>' +
      '<dt>状态</dt><dd>' + badge(item.status || 'active', item.status === 'active' ? 'ok' : 'warn') + '</dd>' +
      '<dt>创建时间</dt><dd>' + esc(fmtTime(item.createdAt)) + '</dd>' +
    '</dl>' +
    '<div class="ops">' +
      '<a class="btn btn-primary" href="/dashboard?userId=' + encodeURIComponent(item.owner?.id || '') + '&instanceId=' + encodeURIComponent(item.instanceId) + '">打开 Dashboard</a>' +
      '<a class="btn" href="/dashboard">返回当前 Dashboard</a>' +
      (item.workspace?.exists ? '' : '<button class="btn" onclick="ensureSelectedWorkspace()">补建 Workspace</button>') +
      (item.instanceId === 'invest-agent-primary' ? '' : '<button class="btn" onclick="archiveSelectedInstance()">删除实例</button>') +
    '</div>' +
    '<div class="section"><h3>运行概况</h3><div class="metrics">' +
      metric(item.planCount, '预案') +
      metric(item.traceCount, '对话') +
      metric(item.channelBindingCount, '微信绑定') +
    '</div></div>' +
    '<div class="section"><h3>微信扫码绑定</h3>' + renderWeixinPanel(item) + '</div>' +
    '<div class="section"><h3>最近对话</h3>' + renderTraces(item.recentTraces || []) + '</div>' +
    '<div class="section"><h3>微信绑定</h3>' + renderBindings(item.channelBindings || []) + '</div>';
  refreshWeixinStatus(item.instanceId);
}

function renderWeixinPanel(item) {
  const id = esc(item.instanceId);
  return '<div class="item">' +
    '<div class="item-line"><strong id="wxStage-' + id + '">加载中</strong><span id="wxUpdated-' + id + '">-</span></div>' +
    '<div class="muted" id="wxMessage-' + id + '" style="margin-top:6px">正在读取微信状态...</div>' +
    '<div class="ops">' +
      '<button class="btn btn-primary" onclick="wxConnectSelected()">连接微信</button>' +
      '<button class="btn" onclick="wxListenSelected()">启动监听</button>' +
      '<button class="btn" onclick="wxTestSelected()">测试推送</button>' +
      '<button class="btn" onclick="wxStopSelected()">断开</button>' +
      '<button class="btn" onclick="refreshWeixinStatus(\\'' + id + '\\')">刷新</button>' +
    '</div>' +
    '<div class="qr-box" id="wxQrBox-' + id + '">' +
      '<div class="muted">请使用微信扫码，并在微信中确认登录。</div>' +
      '<img id="wxQrImg-' + id + '" alt="微信登录二维码" />' +
      '<div class="mono" id="wxQrLink-' + id + '"></div>' +
    '</div>' +
    '<div class="log" id="wxLog-' + id + '" style="margin-top:10px">-</div>' +
  '</div>';
}

function renderTraces(rows) {
  if (!rows.length) return '<div class="empty">暂无对话记录</div>';
  return '<div class="list">' + rows.map((row) =>
    '<div class="item"><div class="item-line"><strong>' + esc(row.mode || '-') + '</strong><span>' + esc(fmtTime(row.createdAt)) + '</span></div>' +
    '<div class="muted" style="margin-top:6px">' + esc(row.userText || '-') + '</div></div>'
  ).join('') + '</div>';
}

function renderBindings(rows) {
  if (!rows.length) return '<div class="empty">暂无微信绑定；用户先给该实例对应微信发消息后会出现绑定。</div>';
  return '<div class="list">' + rows.map((row) =>
    '<div class="item"><div class="item-line"><strong>' + esc(row.channel || '-') + '</strong><span>' + esc(fmtTime(row.updatedAt)) + '</span></div>' +
    '<div class="muted" style="margin-top:6px">外部账号 ' + esc(row.externalAccountId || '-') + ' · 用户尾号 ' + esc(row.externalUserIdSuffix || '-') + '</div></div>'
  ).join('') + '</div>';
}

function openCreateModal() {
  document.getElementById('createError').style.display = 'none';
  document.getElementById('createModal').style.display = 'flex';
  setTimeout(() => document.getElementById('createUserId').focus(), 50);
}

function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

async function createInstance() {
  const error = document.getElementById('createError');
  error.style.display = 'none';
  const userId = document.getElementById('createUserId').value.trim();
  const displayName = document.getElementById('createDisplayName').value.trim();
  const instanceName = document.getElementById('createInstanceName').value.trim();
  try {
    const res = await fetch('/api/platform/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, displayName, instanceName }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '创建失败');
    selectedInstanceId = data.instance.instanceId;
    closeCreateModal();
    await loadPlatform();
  } catch (err) {
    error.textContent = err.message;
    error.style.display = 'block';
  }
}

function selectedInstance() {
  return (DATA.instances || []).find((item) => item.instanceId === selectedInstanceId);
}

async function platformJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || data.message || ('请求失败: ' + res.status));
  return data;
}

async function archiveSelectedInstance() {
  const item = selectedInstance();
  if (!item) return;
  if (item.instanceId === 'invest-agent-primary') {
    alert('主实例不能删除');
    return;
  }
  const ok = confirm('确认删除实例「' + item.name + '」？\\n\\n这会删除该实例的数据库记录、微信绑定、业务数据和 Workspace。主实例不能删除。');
  if (!ok) return;
  await platformJson('/api/platform/instances/' + encodeURIComponent(item.instanceId), { method: 'DELETE' });
  selectedInstanceId = '';
  await loadPlatform();
}

async function ensureSelectedWorkspace() {
  const item = selectedInstance();
  if (!item) return;
  await platformJson('/api/platform/instances/' + encodeURIComponent(item.instanceId) + '/workspace/ensure', { method: 'POST' });
  await loadPlatform();
}

function wxIds(instanceId) {
  return {
    stage: document.getElementById('wxStage-' + instanceId),
    updated: document.getElementById('wxUpdated-' + instanceId),
    message: document.getElementById('wxMessage-' + instanceId),
    qrBox: document.getElementById('wxQrBox-' + instanceId),
    qrImg: document.getElementById('wxQrImg-' + instanceId),
    qrLink: document.getElementById('wxQrLink-' + instanceId),
    log: document.getElementById('wxLog-' + instanceId),
  };
}

function renderWeixinState(instanceId, state) {
  if (instanceId !== selectedInstanceId) return;
  const els = wxIds(instanceId);
  if (!els.stage) return;
  els.stage.textContent = (state.stage || '-') + (state.listenerRunning ? ' · 监听中' : '');
  els.updated.textContent = state.updatedAt || '-';
  els.message.textContent = [
    state.message || '-',
    state.accountId ? '账号 ' + state.accountId : '',
    state.pushReady ? '可主动推送' : '等待该微信先发一条消息后可推送',
  ].filter(Boolean).join(' · ');
  if (state.qrcodeUrl) {
    els.qrBox.style.display = 'grid';
    els.qrImg.src = state.qrcodeDataUrl || '';
    els.qrLink.textContent = state.qrcodeUrl;
  } else {
    els.qrBox.style.display = 'none';
    els.qrImg.src = '';
    els.qrLink.textContent = '';
  }
  els.log.textContent = JSON.stringify(state, null, 2);
}

async function refreshWeixinStatus(instanceId = selectedInstanceId) {
  if (!instanceId) return;
  try {
    const state = await platformJson('/api/platform/instances/' + encodeURIComponent(instanceId) + '/weixin/status');
    renderWeixinState(instanceId, state);
  } catch (err) {
    const els = wxIds(instanceId);
    if (els.log) els.log.textContent = err.message;
  }
}

async function wxAction(path, options = {}) {
  const item = selectedInstance();
  if (!item) return;
  const state = await platformJson('/api/platform/instances/' + encodeURIComponent(item.instanceId) + '/weixin/' + path, options);
  renderWeixinState(item.instanceId, state.state || state);
}

async function wxConnectSelected() {
  await wxAction('connect/start', { method: 'POST' });
}

async function wxListenSelected() {
  await wxAction('listener/start', { method: 'POST' });
}

async function wxStopSelected() {
  await wxAction('connect/stop', { method: 'POST' });
}

async function wxTestSelected() {
  await wxAction('push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

loadPlatform();
</script>
</body>
</html>`;
}
