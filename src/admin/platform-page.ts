export function renderPlatformPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Project Platform</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; background: #f5f7fb; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: inherit; text-decoration: none; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 232px 1fr; }
    .sidebar { background: #ffffff; border-right: 1px solid #d9e0ea; padding: 22px 14px; }
    .brand { color: #111827; font-size: 16px; font-weight: 700; line-height: 1.2; padding: 0 8px 18px; }
    .brand small { display: block; color: #6b7280; font-size: 11px; font-weight: 400; margin-top: 5px; }
    .nav { display: flex; flex-direction: column; gap: 6px; }
    .nav a { color: #475569; border-radius: 7px; padding: 9px 10px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    .nav a:hover { background: #eef4ff; color: #1d4ed8; }
    .nav a.active { background: #dbeafe; color: #1d4ed8; font-weight: 650; }
    .main { padding: 24px; min-width: 0; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
    h1 { color: #111827; font-size: 22px; margin: 0; letter-spacing: 0; }
    .sub { color: #64748b; font-size: 12px; margin-top: 5px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .btn { border: 1px solid #cbd5e1; background: #ffffff; color: #1f2937; border-radius: 7px; padding: 7px 11px; font-size: 12px; cursor: pointer; box-shadow: 0 1px 1px rgba(15,23,42,.04); }
    .btn:hover { background: #f1f5f9; border-color: #94a3b8; }
    .input { background: #ffffff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 7px; padding: 7px 10px; min-width: 230px; outline: none; }
    .input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .stat .value { color: #0f172a; font-size: 24px; font-weight: 750; line-height: 1; }
    .stat .label { color: #64748b; font-size: 12px; margin-top: 8px; }
    .grid { display: grid; grid-template-columns: minmax(380px, .95fr) minmax(390px, 1.05fr); gap: 14px; align-items: start; }
    .panel { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .panel-head { padding: 13px 15px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fbfdff; }
    .panel-head h2 { color: #111827; font-size: 14px; margin: 0; }
    .panel-body { padding: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; color: #64748b; font-size: 11px; font-weight: 600; padding: 8px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    td { color: #334155; font-size: 12px; padding: 10px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    tr { cursor: pointer; }
    tr:hover td { background: #f8fafc; }
    tr.selected td { background: #eff6ff; }
    .project-list { display: flex; flex-direction: column; gap: 9px; }
    .project-card { border: 1px solid #d9e0ea; background: #ffffff; border-radius: 8px; padding: 11px; cursor: pointer; }
    .project-card:hover { background: #f8fafc; border-color: #9db3d1; }
    .project-card.selected { background: #eff6ff; border-color: #60a5fa; box-shadow: 0 0 0 1px rgba(96,165,250,.22); }
    .project-card-top { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .project-title { min-width: 0; }
    .project-title .name { font-size: 13px; }
    .project-id { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .project-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .mini-metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 7px; }
    .mini-metric strong { display: block; color: #0f172a; font-size: 14px; line-height: 1; }
    .mini-metric span { display: block; color: #64748b; font-size: 11px; margin-top: 5px; }
    .name { color: #111827; font-weight: 650; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: #64748b; word-break: break-all; }
    .muted { color: #64748b; font-size: 12px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 650; white-space: nowrap; }
    .badge-ok { background: #dcfce7; color: #166534; }
    .badge-warn { background: #fef3c7; color: #92400e; }
    .badge-info { background: #dbeafe; color: #1d4ed8; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .kv { display: grid; grid-template-columns: 112px 1fr; gap: 8px 12px; margin: 0; }
    .kv dt { color: #64748b; font-size: 12px; }
    .kv dd { margin: 0; color: #334155; font-size: 12px; word-break: break-word; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { background: #f8fafc; border: 1px solid #d9e0ea; color: #475569; border-radius: 6px; padding: 4px 7px; font-size: 11px; }
    .section { margin-top: 14px; }
    .section h3 { margin: 0 0 8px; color: #111827; font-size: 13px; }
    .list { display: flex; flex-direction: column; gap: 7px; }
    .item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 9px; }
    .item-line { display: flex; justify-content: space-between; gap: 10px; color: #334155; font-size: 12px; }
    .item-clickable { cursor: pointer; }
    .item-clickable:hover { border-color: #9db3d1; background: #eef4ff; }
    .trace-detail { margin-top: 8px; border-top: 1px solid #d9e0ea; padding-top: 8px; display: none; }
    .trace-block { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 6px; padding: 8px; color: #334155; font-size: 11px; white-space: pre-wrap; max-height: 220px; overflow: auto; }
    .trace-label { color: #64748b; font-size: 11px; margin: 8px 0 4px; }
    .empty { color: #94a3b8; text-align: center; padding: 24px 10px; font-size: 13px; }
    .ops { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .connection-summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 11px; margin-bottom: 10px; }
    .connection-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 7px; }
    .connection-row:last-child { margin-bottom: 0; }
    .connection-title { color: #111827; font-size: 13px; font-weight: 700; }
    .connection-meta { color: #64748b; font-size: 12px; }
    .advanced { margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
    .advanced summary { cursor: pointer; color: #1d4ed8; font-size: 12px; user-select: none; }
    .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-bottom: 12px; }
    .summary-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
    .summary-card .label { color: #64748b; font-size: 11px; margin-bottom: 6px; }
    .summary-card .value { color: #111827; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-group { border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 10px; }
    .detail-group summary { cursor: pointer; color: #111827; font-size: 13px; font-weight: 700; user-select: none; }
    .detail-group-body { margin-top: 10px; }
    .qr-box { margin-top: 12px; display: grid; gap: 8px; justify-items: start; }
    .qr-box img { width: 220px; max-width: 100%; border: 1px solid #d9e0ea; border-radius: 8px; background: #fff; }
    .link-row { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.32); display: none; align-items: center; justify-content: center; padding: 18px; z-index: 20; }
    .modal { width: min(520px, 100%); background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 16px; box-shadow: 0 20px 80px rgba(15,23,42,.18); }
    .modal h2 { margin: 0 0 12px; color: #111827; font-size: 15px; }
    .form-grid { display: grid; gap: 10px; }
    .field label { display: block; color: #64748b; font-size: 12px; margin-bottom: 5px; }
    .field input, .field select { width: 100%; box-sizing: border-box; background: #ffffff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 7px; padding: 8px 10px; outline: none; }
    .field input:focus, .field select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .error { background: #fff1f2; border: 1px solid #fda4af; color: #9f1239; border-radius: 8px; padding: 12px; font-size: 13px; margin-bottom: 14px; display: none; }
    @media (max-width: 980px) {
      .shell { display: block; }
      .sidebar { position: static; border-right: 0; border-bottom: 1px solid #d9e0ea; }
      .nav { flex-direction: row; overflow: auto; }
      .nav a { white-space: nowrap; }
      .main { padding: 18px 14px; }
      .topbar { flex-direction: column; }
      .stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .input { min-width: 0; width: 100%; }
      .actions { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">AI Project Platform<small>项目运行后台</small></div>
      <nav class="nav">
        <a class="active" href="/platform">项目总览 <span>›</span></a>
        <a href="/dashboard">投资助手 <span>↗</span></a>
      </nav>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h1>项目总览</h1>
          <div class="sub" id="updatedAt">加载中...</div>
        </div>
        <div class="actions">
          <input id="search" class="input" placeholder="搜索项目、用户、类型、技能包" oninput="render()" />
          <button class="btn" onclick="openCreateInvestModal()">创建投资助手</button>
          <button class="btn" onclick="loadProjects()">刷新</button>
        </div>
      </div>
      <div id="error" class="error"></div>
      <section class="stats" id="stats"></section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>AI 项目</h2>
            <span class="muted" id="projectCount">0 个项目</span>
          </div>
          <div class="panel-body" id="projectTable"></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>运行详情</h2>
            <span class="muted" id="selectedHint">未选择</span>
          </div>
          <div class="panel-body" id="detail"></div>
        </div>
      </section>
    </main>
  </div>
  <div class="modal-backdrop" id="createInvestModal">
    <div class="modal">
      <h2>创建投资助手实例</h2>
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
          <input id="createInstanceName" placeholder="例如 张三的投资助手" />
        </div>
        <div class="field">
          <label>Backend</label>
          <select id="createBackend">
            <option value="hermes">Hermes</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div class="field" style="grid-column:1 / -1">
          <label>Skill Bundle</label>
          <select id="createSkillBundle">
            <option value="invest-agent-default">投资助手默认技能包</option>
          </select>
        </div>
        <div id="createInvestError" class="error" style="display:none;margin:0"></div>
        <div class="ops">
          <button class="btn" onclick="createInvestInstance()">创建</button>
          <button class="btn" onclick="closeCreateInvestModal()">取消</button>
        </div>
      </div>
    </div>
  </div>
<script>
let DATA = { projects: [] };
let selectedProjectId = '';
let WEIXIN_STATE = {};
let INVEST_SKILL_BUNDLES = [];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function sumStatus(projects, field, status) {
  return projects.reduce((total, project) => total + Number(project[field]?.[status] || 0), 0);
}

function badge(text, kind = 'gray') {
  return '<span class="badge badge-' + kind + '">' + esc(text) + '</span>';
}

async function loadProjects() {
  document.getElementById('error').style.display = 'none';
  try {
    const res = await fetch('/api/platform/projects');
    DATA = await res.json();
    if (!DATA.ok) throw new Error(DATA.error || '平台接口返回失败');
    selectedProjectId = selectedProjectId || DATA.projects?.[0]?.projectId || '';
    render();
    refreshSelectedWeixin();
  } catch (error) {
    const node = document.getElementById('error');
    node.textContent = '加载失败: ' + error.message;
    node.style.display = 'block';
  }
}

function filteredProjects() {
  const keyword = document.getElementById('search').value.trim().toLowerCase();
  const projects = DATA.projects || [];
  if (!keyword) return projects;
  return projects.filter((project) => [
    project.projectId,
    project.instanceId,
    project.name,
    project.projectType,
    project.skillBundleId,
    project.hermesProfile,
    project.owner?.id,
    project.owner?.displayName,
    project.backend,
  ].some((value) => String(value || '').toLowerCase().includes(keyword)));
}

function render() {
  const projects = filteredProjects();
  if (!projects.some((project) => project.projectId === selectedProjectId)) {
    selectedProjectId = projects[0]?.projectId || '';
  }
  document.getElementById('updatedAt').textContent = DATA.updatedAt ? '更新于 ' + fmtTime(DATA.updatedAt) : '加载中...';
  renderStats(DATA.projects || []);
  renderTable(projects);
  renderDetail((DATA.projects || []).find((project) => project.projectId === selectedProjectId));
}

function renderStats(projects) {
  const active = projects.filter((project) => project.status === 'active').length;
  const channelCount = projects.reduce((total, project) => total + (project.channelBindings?.length || 0), 0);
  const traces = projects.reduce((total, project) => total + Number(project.recentTraceCount || 0), 0);
  const pushDead = sumStatus(projects, 'pushQueueSummary', 'dead');
  const auditDenied = sumStatus(projects, 'auditSummary', 'denied');
  document.getElementById('stats').innerHTML = [
    stat(projects.length, '项目总数'),
    stat(active, 'active 项目'),
    stat(channelCount, '通道绑定'),
    stat(traces, 'ACP 追踪'),
    stat(pushDead + auditDenied, '需关注事件'),
  ].join('');
}

function stat(value, label) {
  return '<div class="stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>';
}

function renderTable(projects) {
  document.getElementById('projectCount').textContent = projects.length + ' 个项目';
  if (projects.length === 0) {
    document.getElementById('projectTable').innerHTML = '<div class="empty">没有匹配的项目</div>';
    return;
  }
  const cards = projects.map((project) => {
    const statusKind = project.status === 'active' ? 'ok' : 'warn';
    const pushDead = Number(project.pushQueueSummary?.dead || 0);
    const auditDenied = Number(project.auditSummary?.denied || 0);
    const issueCount = pushDead + auditDenied;
    return '<div class="project-card ' + (project.projectId === selectedProjectId ? 'selected' : '') + '" onclick="selectProject(\\'' + esc(project.projectId) + '\\')">' +
      '<div class="project-card-top">' +
        '<div class="project-title"><div class="name">' + esc(project.name || project.projectId) + '</div><div class="mono project-id" title="' + esc(project.projectId) + '">' + esc(project.projectId) + '</div></div>' +
        '<div>' + badge(project.status || '-', statusKind) + '</div>' +
      '</div>' +
      '<div class="project-meta">' +
        badge(project.projectType || '-', project.projectType === 'diet-recommendation' ? 'ok' : 'info') +
        badge(project.backend || '-', 'gray') +
        badge(project.hermesProfile || '-', 'info') +
      '</div>' +
      '<div class="muted" style="margin-top:8px">' + esc(project.owner?.displayName || project.owner?.id || '-') + ' / ' + esc(project.owner?.id || '-') + '</div>' +
      '<div class="project-metrics">' +
        '<div class="mini-metric"><strong>' + esc(project.channelBindings?.length || 0) + '</strong><span>绑定</span></div>' +
        '<div class="mini-metric"><strong>' + esc(project.recentTraceCount || 0) + '</strong><span>追踪</span></div>' +
        '<div class="mini-metric"><strong>' + esc(issueCount || 0) + '</strong><span>风险</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
  document.getElementById('projectTable').innerHTML = '<div class="project-list">' + cards + '</div>';
}

function selectProject(projectId) {
  selectedProjectId = projectId;
  render();
  refreshSelectedWeixin();
}

function renderDetail(project) {
  const detail = document.getElementById('detail');
  const hint = document.getElementById('selectedHint');
  if (!project) {
    hint.textContent = '未选择';
    detail.innerHTML = '<div class="empty">请选择一个项目</div>';
    return;
  }
  hint.textContent = project.projectId;
  const boundUsers = uniqueBindingUsers(project.channelBindings || []);
  const latestBinding = (project.channelBindings || [])[0];
  const issueCount = Number(project.pushQueueSummary?.dead || 0) + Number(project.auditSummary?.denied || 0);
  detail.innerHTML =
    '<div class="summary-grid">' +
      summaryCard('项目类型', project.projectType || '-') +
      summaryCard('Hermes Profile', project.hermesProfile || project.projectTypeManifest?.defaultHermesProfile || '-') +
      summaryCard('绑定用户', String(boundUsers.length || 0)) +
      summaryCard('最近活跃', fmtTime(latestBinding?.updatedAt)) +
      summaryCard('Backend', project.backend || '-') +
      summaryCard('风险事件', String(issueCount || 0)) +
    '</div>' +
    section('项目操作', renderProjectActions(project)) +
    section('微信连接', renderWeixinControl(project)) +
    detailsGroup('基础配置', renderBasicConfig(project), true) +
    detailsGroup('通道绑定', renderChannels(project.channelBindings || []), false) +
    detailsGroup('追踪与审计', section('推送队列', renderCountMap(project.pushQueueSummary || {})) + section('沙箱审计', renderCountMap(project.auditSummary || {})) + section('最近 ACP 追踪', renderTraces(project.recentTraces || [])) + section('最近审计日志', renderAudits(project.recentAuditLogs || [])), false) +
    detailsGroup('工具与权限', section('Skill Bundle', renderSkillBundle(project.skillBundle)) + section('可调用工具', renderChips(project.allowedTools || [])) + section('权限', renderChips(project.permissions || [])) + section('资源类型', renderChips(project.resourceTypes || [])), false);
}

function projectWeixinApiBase(project) {
  return '/api/platform/projects/' + encodeURIComponent(project.projectId) + '/weixin';
}

function renderProjectActions(project) {
  const links = [];
  if (project.dashboardType === 'invest-agent') {
    links.push('<a class="btn" href="/dashboard?userId=' + encodeURIComponent(project.owner?.id || 'primary') + '&instanceId=' + encodeURIComponent(project.instanceId || project.projectId) + '">打开 Dashboard</a>');
  }
  links.push('<button class="btn" onclick="loadProjects()">刷新项目</button>');
  return '<div class="link-row">' + links.join('') + '</div>';
}

function renderWeixinControl(project) {
  const apiBase = projectWeixinApiBase(project);
  const state = WEIXIN_STATE[project.projectId] || {};
  const stage = state.stage || 'unknown';
  const connected = stage === 'connected';
  const waiting = stage === 'waiting_scan' || stage === 'scanned';
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const bindings = project.channelBindings || [];
  const isShared = project.projectType !== 'invest-agent';
  const uniqueUsers = Array.from(new Map(bindings.map((item) => [item.userId || item.externalUserIdSuffix || item.id, item])).values());
  const activeAccounts = accounts.filter((account) => account.listenerRunning).length;
  const pushReadyAccounts = accounts.filter((account) => account.pushReady).length;
  const lastActive = bindings[0]?.updatedAt || state.lastConversationAt;
  const healthBadge = state.listenerRunning
    ? badge('连接正常', 'ok')
    : accounts.length
      ? badge('待恢复监听', 'warn')
      : badge('未绑定', 'gray');
  const bindingTitle = isShared
    ? '共享项目：' + uniqueUsers.length + ' 个微信用户已接入'
    : '专属项目：' + (bindings[0]?.userDisplayName || project.owner?.displayName || '待绑定');
  const bindingMeta = isShared
    ? '同一套 Skill 和 Hermes Profile 服务多个用户；后续偏好数据按用户隔离。'
    : '该实例应只绑定给一个用户；业务数据按该用户和实例隔离。';
  const userRows = uniqueUsers.length
    ? '<div class="list">' + uniqueUsers.map((item) =>
      '<div class="item"><div class="item-line"><strong>' + esc(item.userDisplayName || item.userId || '微信用户') + '</strong>' + badge(item.backend || '-', 'info') + '</div>' +
      '<div class="mono">' + esc(item.userId || '-') + ' · ' + esc(item.externalAccountId || '-') + '</div>' +
      '<div class="muted">最近活跃 ' + fmtTime(item.updatedAt) + '</div></div>'
    ).join('') + '</div>'
    : '<div class="muted">还没有微信用户完成绑定。</div>';
  const accountRows = accounts.length
    ? '<div class="mini-table"><table><thead><tr><th>账号</th><th>监听</th><th>推送</th><th>最近会话</th></tr></thead><tbody>' +
      accounts.map((account) => '<tr>' +
        '<td class="mono">' + esc(account.accountId || '-') + '</td>' +
        '<td>' + (account.listenerRunning ? '监听中' : '未监听') + '</td>' +
        '<td>' + (account.pushReady ? '可推送' : '待首条消息') + '</td>' +
        '<td class="mono">' + esc(account.lastConversationId || '-') + '</td>' +
      '</tr>').join('') +
      '</tbody></table></div>'
    : '<div class="muted">暂无已绑定微信账号。</div>';
  const qr = state.qrcodeDataUrl
    ? '<div class="qr-box"><div class="muted">' + (isShared ? '可让多个微信用户依次扫码接入该共享项目。' : '请让该实例对应用户扫码绑定；专属项目不建议多人共用。') + '</div><img alt="微信登录二维码" src="' + esc(state.qrcodeDataUrl) + '" /><div class="mono">' + esc(state.qrcodeUrl || '') + '</div></div>'
    : '';
  return '<div class="connection-summary">' +
      '<div class="connection-row"><div><div class="connection-title">' + esc(bindingTitle) + '</div><div class="connection-meta">' + esc(bindingMeta) + '</div></div>' + healthBadge + '</div>' +
      '<dl class="kv">' +
        kv(isShared ? '绑定用户' : '绑定状态', isShared ? String(uniqueUsers.length) : (bindings.length ? '已绑定' : '待绑定')) +
        kv('微信通道', accounts.length ? activeAccounts + '/' + accounts.length + ' 监听中' : '未创建') +
        kv('可推送账号', accounts.length ? pushReadyAccounts + '/' + accounts.length : '-') +
        kv('最近活跃', fmtTime(lastActive)) +
        kv('提示', state.message || '-') +
        kv('错误', state.lastError || '-') +
      '</dl>' +
    '</div>' +
    '<div class="ops">' +
      '<button class="btn" onclick="weixinAction(\\'' + esc(project.projectId) + '\\', \\'' + apiBase + '\\', \\'connect/start\\')" ' + (waiting ? 'disabled' : '') + '>' + (isShared ? '生成共享二维码' : '生成绑定二维码') + '</button>' +
      '<button class="btn" onclick="refreshWeixin(\\'' + esc(project.projectId) + '\\', \\'' + apiBase + '\\')">刷新状态</button>' +
    '</div>' +
    qr +
    '<div class="section"><h3>' + (isShared ? '已接入用户' : '绑定对象') + '</h3>' + userRows + '</div>' +
    '<details class="advanced"><summary>高级连接操作</summary>' +
      '<dl class="kv" style="margin-top:10px">' +
        kv('接口', apiBase, true) +
        kv('阶段', stage) +
        kv('当前账号', state.accountId || '-') +
        kv('最近会话', state.lastConversationId || '-') +
      '</dl>' +
      '<div class="ops">' +
        '<button class="btn" onclick="weixinAction(\\'' + esc(project.projectId) + '\\', \\'' + apiBase + '\\', \\'listener/start\\')" ' + (!connected || state.listenerRunning ? 'disabled' : '') + '>启动监听</button>' +
        '<button class="btn" onclick="weixinAction(\\'' + esc(project.projectId) + '\\', \\'' + apiBase + '\\', \\'connect/stop\\')">停止监听</button>' +
      '</div>' + accountRows +
    '</details>';
}

async function refreshSelectedWeixin() {
  const project = (DATA.projects || []).find((item) => item.projectId === selectedProjectId);
  if (!project) return;
  await refreshWeixin(project.projectId, projectWeixinApiBase(project));
}

async function refreshWeixin(projectId, apiBase) {
  try {
    const res = await fetch(apiBase + '/status');
    const state = await res.json();
    WEIXIN_STATE[projectId] = state;
    render();
  } catch (error) {
    WEIXIN_STATE[projectId] = { stage: 'error', message: '连接状态加载失败', lastError: error.message };
    render();
  }
}

async function weixinAction(projectId, apiBase, action) {
  try {
    const res = await fetch(apiBase + '/' + action, { method: 'POST' });
    const state = await res.json();
    WEIXIN_STATE[projectId] = state;
    render();
  } catch (error) {
    WEIXIN_STATE[projectId] = { stage: 'error', message: '操作失败', lastError: error.message };
    render();
  }
}

async function loadInvestSkillBundles() {
  if (INVEST_SKILL_BUNDLES.length) return INVEST_SKILL_BUNDLES;
  const res = await fetch('/api/platform/skill-bundles?projectType=invest-agent');
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '技能包加载失败');
  INVEST_SKILL_BUNDLES = data.bundles || [];
  return INVEST_SKILL_BUNDLES;
}

function renderCreateSkillBundles() {
  const select = document.getElementById('createSkillBundle');
  const bundles = INVEST_SKILL_BUNDLES.length ? INVEST_SKILL_BUNDLES : [{ id: 'invest-agent-default', displayName: '投资助手默认技能包', description: '' }];
  select.innerHTML = bundles.map((bundle) =>
    '<option value="' + esc(bundle.id) + '">' + esc(bundle.displayName || bundle.id) + ' (' + esc(bundle.id) + ')</option>'
  ).join('');
  select.value = bundles.some((bundle) => bundle.id === 'invest-agent-default') ? 'invest-agent-default' : bundles[0]?.id || 'invest-agent-default';
}

async function openCreateInvestModal() {
  document.getElementById('createInvestError').style.display = 'none';
  document.getElementById('createInvestModal').style.display = 'flex';
  try {
    await loadInvestSkillBundles();
    renderCreateSkillBundles();
  } catch (error) {
    const errorNode = document.getElementById('createInvestError');
    errorNode.textContent = error.message;
    errorNode.style.display = 'block';
  }
}

function closeCreateInvestModal() {
  document.getElementById('createInvestModal').style.display = 'none';
}

async function createInvestInstance() {
  const errorNode = document.getElementById('createInvestError');
  errorNode.style.display = 'none';
  const body = {
    userId: document.getElementById('createUserId').value.trim(),
    displayName: document.getElementById('createDisplayName').value.trim(),
    instanceName: document.getElementById('createInstanceName').value.trim(),
    backend: document.getElementById('createBackend').value,
    skillBundleId: document.getElementById('createSkillBundle').value,
  };
  if (!body.userId || !body.displayName) {
    errorNode.textContent = '用户 ID 和用户显示名必填';
    errorNode.style.display = 'block';
    return;
  }
  try {
    const res = await fetch('/api/platform/projects/invest-agent/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '创建失败');
    selectedProjectId = data.project.projectId;
    closeCreateInvestModal();
    await loadProjects();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.style.display = 'block';
  }
}

function kv(label, value, mono = false) {
  return '<dt>' + esc(label) + '</dt><dd class="' + (mono ? 'mono' : '') + '">' + esc(value) + '</dd>';
}

function section(title, body) {
  return '<div class="section"><h3>' + esc(title) + '</h3>' + body + '</div>';
}

function detailsGroup(title, body, open = false) {
  return '<details class="detail-group" ' + (open ? 'open' : '') + '><summary>' + esc(title) + '</summary><div class="detail-group-body">' + body + '</div></details>';
}

function summaryCard(label, value) {
  return '<div class="summary-card"><div class="label">' + esc(label) + '</div><div class="value" title="' + esc(value) + '">' + esc(value) + '</div></div>';
}

function uniqueBindingUsers(bindings) {
  return Array.from(new Map((bindings || []).map((item) => [item.userId || item.externalUserIdSuffix || item.id, item])).values());
}

function renderBasicConfig(project) {
  return '<dl class="kv">' +
    kv('项目 ID', project.projectId, true) +
    kv('兼容实例', project.instanceId, true) +
    kv('旧项目类型', project.legacyProjectId || '-') +
    kv('Dashboard', project.dashboardType || '-') +
    kv('Skill Bundle', project.skillBundleId || '-', true) +
    kv('Hermes Profile', project.hermesProfile || project.projectTypeManifest?.defaultHermesProfile || '-', true) +
    kv('Owner', (project.owner?.displayName || '-') + ' / ' + (project.owner?.id || '-')) +
  '</dl>' +
  section('项目类型配置', renderManifest(project.projectTypeManifest || {}));
}

function renderChips(items) {
  if (!items.length) return '<div class="empty">无</div>';
  return '<div class="chips">' + items.map((item) => '<span class="chip">' + esc(item) + '</span>').join('') + '</div>';
}

function renderSkillBundle(bundle) {
  if (!bundle) return '<div class="empty">未配置技能包</div>';
  const skills = Array.isArray(bundle.skills) ? bundle.skills : [];
  const constraints = Array.isArray(bundle.constraints) ? bundle.constraints : [];
  return '<div class="list">' +
    '<div class="item">' +
      '<div class="item-title">' + esc(bundle.displayName || bundle.id || '-') + '</div>' +
      '<div class="item-meta">' + esc(bundle.id || '-') + ' · ' + esc(bundle.mode || '-') + '</div>' +
      '<div class="item-meta">' + esc(bundle.description || '-') + '</div>' +
    '</div>' +
    section('技能清单', renderChips(skills.map((skill) => skill.id + '：' + skill.purpose))) +
    section('约束', renderChips(constraints)) +
  '</div>';
}

function renderCountMap(map) {
  const entries = Object.entries(map);
  if (!entries.length) return '<div class="empty">暂无记录</div>';
  return '<div class="chips">' + entries.map(([key, value]) => '<span class="chip">' + esc(key) + ': ' + esc(value) + '</span>').join('') + '</div>';
}

function renderManifest(manifest) {
  return '<dl class="kv">' +
    kv('类型名称', manifest.displayName || '-') +
    kv('Manifest ID', manifest.id || '-', true) +
    kv('默认技能包', manifest.defaultSkillBundleId || '-', true) +
    kv('Hermes Profile', manifest.defaultHermesProfile || '-', true) +
    kv('Dashboard', manifest.dashboardType || '-') +
  '</dl>';
}

function renderChannels(channels) {
  if (!channels.length) return '<div class="empty">未绑定通道</div>';
  return '<div class="list">' + channels.map((item) =>
    '<div class="item"><div class="item-line"><strong>' + esc(item.channel) + ' / ' + esc(item.backend) + '</strong>' + (item.isDefault ? badge('default', 'info') : '') + '</div>' +
    '<div class="mono">' + esc(item.externalAccountId || '-') + ' · user *' + esc(item.externalUserIdSuffix || '-') + '</div>' +
    '<div class="muted">' + fmtTime(item.updatedAt) + '</div></div>'
  ).join('') + '</div>';
}

function renderTraces(traces) {
  if (!traces.length) return '<div class="empty">暂无追踪</div>';
  return '<div class="list">' + traces.map((trace) =>
    '<div class="item item-clickable" onclick="toggleTraceDetail(event, ' + Number(trace.id) + ')"><div class="item-line"><strong>' + esc(trace.mode || '-') + '</strong>' + badge(trace.status || '-', trace.status === 'success' ? 'ok' : 'warn') + '</div>' +
    '<div class="muted">' + esc(trace.channel || '-') + ' · ' + esc(trace.elapsedMs ?? '-') + 'ms · ' + fmtTime(trace.createdAt) + '</div>' +
    '<div class="mono">trace #' + esc(trace.id) + (trace.sandboxTokenId ? ' · token ' + esc(trace.sandboxTokenId) : '') + '</div>' +
    '<div class="trace-detail" id="traceDetail' + Number(trace.id) + '"><div class="muted">加载中...</div></div></div>'
  ).join('') + '</div>';
}

async function toggleTraceDetail(event, traceId) {
  event.stopPropagation();
  const box = document.getElementById('traceDetail' + traceId);
  if (!box) return;
  if (box.style.display === 'block') {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  if (box.dataset.loaded === 'true') return;
  try {
    const res = await fetch('/api/platform/traces/' + encodeURIComponent(traceId));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'trace 加载失败');
    box.innerHTML = renderTraceDetail(data.trace);
    box.dataset.loaded = 'true';
  } catch (error) {
    box.innerHTML = '<div class="error" style="display:block;margin:0">加载失败: ' + esc(error.message) + '</div>';
  }
}

function renderTraceDetail(trace) {
  const reply = trace.status === 'error' || trace.status === 'timeout'
    ? (trace.errorMessage || '')
    : (trace.replyTextSanitized || trace.replyTextRaw || '');
  return '<dl class="kv">' +
    kv('Conversation', trace.conversationId || '-', true) +
    kv('Message', trace.messageId || '-', true) +
    kv('用户', trace.userId || '-', true) +
    kv('项目', trace.instanceId || '-', true) +
    kv('Token', trace.sandboxTokenId || '-', true) +
    kv('权限', trace.sandboxPermissions || '-') +
    '</dl>' +
    '<div class="trace-label">用户输入</div><div class="trace-block">' + esc(trace.userText || '-') + '</div>' +
    '<div class="trace-label">助手输出 / 错误</div><div class="trace-block">' + esc(reply || '-') + '</div>' +
    '<div class="trace-label">复盘上下文摘要</div><div class="trace-block">' + esc(trace.reviewContextSummary || '-') + '</div>' +
    '<div class="trace-label">Prompt（已脱敏）</div><div class="trace-block">' + esc(trace.promptText || '-') + '</div>';
}

function renderAudits(logs) {
  if (!logs.length) return '<div class="empty">暂无审计日志</div>';
  return '<div class="list">' + logs.map((log) =>
    '<div class="item"><div class="item-line"><strong>' + esc(log.operation || '-') + '</strong>' + badge(log.status || '-', log.status === 'success' ? 'ok' : 'warn') + '</div>' +
    '<div class="muted">' + esc(log.resourceType || '-') + ' · ' + fmtTime(log.createdAt) + '</div></div>'
  ).join('') + '</div>';
}

loadProjects();
setInterval(loadProjects, 60000);
setInterval(refreshSelectedWeixin, 5000);
</script>
</body>
</html>`;
}
