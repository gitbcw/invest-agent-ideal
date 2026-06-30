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
    .view { display: none; }
    .view.active { display: block; }
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
    .audit-grid { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
    .view.audit-grid { display: none; }
    .view.audit-grid.active { display: grid; }
    .cost-grid { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }
    .view.cost-grid { display: none; }
    .view.cost-grid.active { display: grid; }
    .eval-grid { display: grid; grid-template-columns: minmax(280px, .75fr) minmax(420px, 1.25fr); gap: 14px; align-items: start; }
    .view.eval-grid { display: none; }
    .view.eval-grid.active { display: grid; }
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
    .select { background: #fff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 7px; padding: 7px 10px; width: 100%; outline: none; }
    .segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: #f1f5f9; border: 1px solid #d9e0ea; border-radius: 8px; padding: 4px; }
    .segment { border: 0; background: transparent; color: #475569; border-radius: 6px; padding: 7px 8px; font-size: 12px; cursor: pointer; }
    .segment.active { background: #fff; color: #1d4ed8; font-weight: 650; box-shadow: 0 1px 2px rgba(15,23,42,.08); }
    .audit-list { display: flex; flex-direction: column; gap: 10px; }
    .audit-item { display: grid; grid-template-columns: 132px 1fr; border: 1px solid #d9e0ea; background: #fff; border-radius: 8px; overflow: hidden; }
    .audit-rail { background: #f8fafc; border-right: 1px solid #e2e8f0; padding: 12px; }
    .audit-time { color: #0f172a; font-size: 12px; font-weight: 650; line-height: 1.35; }
    .audit-date { color: #64748b; font-size: 11px; margin-top: 3px; }
    .audit-status { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .audit-main { min-width: 0; padding: 12px 13px; }
    .audit-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .audit-title { min-width: 0; }
    .audit-title-row { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
    .audit-summary { color: #334155; font-size: 13px; line-height: 1.5; margin-top: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .audit-meta { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; color: #64748b; font-size: 11px; }
    .audit-meta span { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px; padding: 2px 7px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .audit-section { margin-top: 11px; }
    .audit-section-title { color: #64748b; font-size: 11px; font-weight: 650; margin-bottom: 5px; }
    .audit-text { white-space: pre-wrap; word-break: break-word; background: #fbfdff; border: 1px solid #d9e0ea; border-radius: 7px; padding: 10px; max-height: 190px; overflow: auto; color: #243447; font-size: 12px; line-height: 1.55; }
    .audit-text.primary { background: #f8fbff; border-color: #bfd4f5; color: #172033; font-size: 13px; }
    .audit-details { margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
    .audit-details summary { cursor: pointer; color: #475569; font-size: 12px; font-weight: 650; }
    .audit-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
    .audit-error { background: #fff7ed; border-color: #fed7aa; color: #9a3412; }
    .cost-summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; }
    .cost-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .cost-table th, .cost-table td { border-bottom: 1px solid #e2e8f0; padding: 9px 8px; text-align: right; white-space: nowrap; }
    .cost-table th:first-child, .cost-table td:first-child { text-align: left; white-space: normal; }
    .cost-table th { color: #64748b; font-weight: 650; background: #fbfdff; }
    .cost-table td { color: #334155; }
    .cost-table tr:last-child td { border-bottom: 0; }
    .cost-source { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .tabs { display: flex; gap: 6px; border-bottom: 1px solid #e2e8f0; margin: -2px 0 14px; }
    .tab { border: 0; background: transparent; color: #64748b; padding: 9px 10px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
    .tab.active { color: #1d4ed8; border-bottom-color: #2563eb; font-weight: 700; }
    .tab:hover { color: #1d4ed8; }
    .cost-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; padding: 0 0 12px; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; }
    .cost-toolbar .field { min-width: 150px; }
    .eval-list { display: flex; flex-direction: column; gap: 10px; }
    .eval-card { border: 1px solid #d9e0ea; background: #fff; border-radius: 8px; padding: 12px; cursor: pointer; }
    .eval-card:hover { background: #f8fafc; border-color: #9db3d1; }
    .eval-card.selected { background: #eff6ff; border-color: #60a5fa; box-shadow: 0 0 0 1px rgba(96,165,250,.22); }
    .eval-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .eval-desc { color: #475569; font-size: 12px; line-height: 1.55; margin-top: 7px; }
    .eval-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .eval-output { white-space: pre-wrap; word-break: break-word; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 11px; max-height: 360px; overflow: auto; font-size: 12px; line-height: 1.55; }
    .eval-output.empty-output { background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; }
    .eval-result-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .golden-editor { width: 100%; min-height: 430px; box-sizing: border-box; resize: vertical; background: #fbfdff; border: 1px solid #cbd5e1; color: #1f2937; border-radius: 8px; padding: 11px; outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.55; }
    .golden-editor:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    @media (max-width: 980px) {
      .shell { display: block; }
      .sidebar { border-right: 0; border-bottom: 1px solid #d9e0ea; }
      .nav { flex-direction: row; overflow: auto; }
      .main { padding: 18px 14px; }
      .topbar { flex-direction: column; }
      .stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .audit-grid { grid-template-columns: 1fr; }
      .cost-grid { grid-template-columns: 1fr; }
      .eval-grid { grid-template-columns: 1fr; }
      .audit-item { grid-template-columns: 1fr; }
      .audit-rail { border-right: 0; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; gap: 12px; }
      .audit-columns { grid-template-columns: 1fr; }
      .input { min-width: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Invest Agent Platform<small>平台管理</small></div>
      <nav class="nav">
        <a id="nav-instances" class="active" href="#instances" onclick="setView('instances')">用户助手 <span>›</span></a>
        <a id="nav-cost" href="#cost" onclick="setView('cost')">成本统计 <span>›</span></a>
        <a id="nav-audit" href="#audit" onclick="setView('audit')">日志审计 <span>›</span></a>
        <a id="nav-golden" href="#golden" onclick="setView('golden')">黄金数据集 <span>›</span></a>
        <a href="/dashboard">投资工作台 <span>↗</span></a>
      </nav>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h1 id="pageTitle">用户助手</h1>
          <div class="sub" id="updatedAt">加载中...</div>
        </div>
        <div class="actions" id="instanceActions">
          <input id="search" class="input" placeholder="搜索用户、助手、ID" oninput="render()" />
          <button class="btn btn-primary" onclick="openCreateModal()">创建用户助手</button>
          <button class="btn" onclick="loadPlatform()">刷新</button>
        </div>
        <div class="actions" id="auditActions" style="display:none">
          <button class="btn btn-primary" onclick="loadAudit()">刷新审计</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
        <div class="actions" id="costActions" style="display:none">
          <button class="btn btn-primary" onclick="loadCostPanel()">刷新成本</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
        <div class="actions" id="goldenActions" style="display:none">
          <button class="btn btn-primary" onclick="loadGoldenCases()">刷新数据集</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
      </div>
      <div id="error" class="error"></div>
      <section id="view-instances" class="view active">
        <section class="stats" id="stats"></section>
        <section class="grid">
          <div class="panel">
            <div class="panel-head">
              <h2>Invest Agent 用户助手</h2>
              <span class="muted" id="instanceCount">0 个用户</span>
            </div>
            <div class="panel-body" id="instanceList"></div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <h2>用户助手详情</h2>
              <span class="muted" id="selectedHint">未选择</span>
            </div>
            <div class="panel-body" id="detail"></div>
          </div>
        </section>
      </section>
      <section id="view-cost" class="view cost-grid">
        <div class="panel">
          <div class="panel-head">
            <h2>Token 与成本</h2>
            <span class="muted" id="costUpdated">未加载</span>
          </div>
          <div class="panel-body" id="costPanel"><div class="empty">加载中...</div></div>
        </div>
      </section>
      <section id="view-audit" class="view audit-grid">
        <div class="panel">
          <div class="panel-head">
            <h2>日志审计</h2>
            <span class="muted" id="auditScopeHint">对话审计</span>
          </div>
          <div class="panel-body">
            <div class="form-grid">
              <div class="segmented">
                <button id="auditScopeConversation" class="segment active" onclick="setAuditScope('conversation')">对话审计</button>
                <button id="auditScopePush" class="segment" onclick="setAuditScope('push')">推送审计</button>
              </div>
              <div class="field">
                <label>用户</label>
                <select id="auditUser" class="select" onchange="onAuditUserChange()"></select>
              </div>
              <div class="field">
                <label>用户助手</label>
                <select id="auditInstance" class="select" onchange="loadAudit()"></select>
              </div>
              <div class="field">
                <label>条数</label>
                <select id="auditLimit" class="select" onchange="loadAudit()">
                  <option value="30">30</option>
                  <option value="60">60</option>
                  <option value="120">120</option>
                </select>
              </div>
              <button class="btn btn-primary" onclick="loadAudit()">刷新审计</button>
              <div class="muted" id="auditHelp">对话审计查看微信用户消息进入 Codex 后的原始回复、清洗回复和入站提示。</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2 id="auditTimelineTitle">对话时间线</h2>
            <span class="muted" id="auditUpdated">未加载</span>
          </div>
          <div class="panel-body" id="auditTimeline"><div class="empty">选择用户后加载审计记录</div></div>
        </div>
      </section>
      <section id="view-golden" class="view eval-grid">
        <div class="panel">
          <div class="panel-head">
            <h2>黄金数据集</h2>
            <span class="muted" id="goldenCount">0 项</span>
          </div>
          <div class="panel-body">
            <div class="metrics" id="goldenStats"></div>
            <div class="section">
              <div class="form-grid">
                <input id="goldenSearch" class="input" placeholder="搜索 case、场景、输入、原则" oninput="renderGoldenCases()" />
                <div class="audit-columns">
                  <select id="goldenCategory" class="select" onchange="renderGoldenCases()"></select>
                  <select id="goldenPriority" class="select" onchange="renderGoldenCases()"></select>
                </div>
              </div>
            </div>
            <div class="section" id="goldenList"><div class="empty">加载中...</div></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>Case 详情</h2>
            <span class="muted" id="goldenUpdated">未加载</span>
          </div>
          <div class="panel-body" id="goldenDetail"><div class="empty">选择一个 case</div></div>
        </div>
      </section>
    </main>
  </div>

  <div class="modal-backdrop" id="createModal">
    <div class="modal">
      <h2>创建用户助手</h2>
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
          <label>助手名称</label>
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
let AUDIT = { users: [], instances: [], items: [], filters: {} };
let COST = { platform: null, scoped: null };
let COST_TAB = 'overview';
let COST_FILTERS = { scope: 'all', days: '30' };
let selectedCostInstanceId = '';
let GOLDEN = { cases: [], stats: {}, suite: {}, qualityGates: {} };
let selectedGoldenId = '';
const VALID_VIEWS = new Set(['instances', 'cost', 'audit', 'golden']);
let ACTIVE_VIEW = VALID_VIEWS.has(location.hash.slice(1)) ? location.hash.slice(1) : 'instances';
let AUDIT_SCOPE = 'conversation';

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
    initAuditFromSelection();
    initCostFromSelection();
    if (ACTIVE_VIEW === 'golden') {
      loadGoldenCases();
    }
  } catch (error) {
    const node = document.getElementById('error');
    node.textContent = '加载失败: ' + error.message;
    node.style.display = 'block';
  }
}

function setView(view) {
  ACTIVE_VIEW = VALID_VIEWS.has(view) ? view : 'instances';
  if (location.hash !== '#' + ACTIVE_VIEW) {
    history.replaceState(null, '', '#' + ACTIVE_VIEW);
  }
  renderChrome();
  if (ACTIVE_VIEW === 'audit' && !(AUDIT.items || []).length) {
    initAuditFromSelection();
  }
  if (ACTIVE_VIEW === 'cost' && !COST.platform) {
    initCostFromSelection();
  }
  if (ACTIVE_VIEW === 'golden' && !(GOLDEN.cases || []).length) {
    loadGoldenCases();
  } else if (ACTIVE_VIEW === 'golden') {
    renderGoldenCases();
  }
}

function renderChrome() {
  document.getElementById('view-instances').classList.toggle('active', ACTIVE_VIEW === 'instances');
  document.getElementById('view-cost').classList.toggle('active', ACTIVE_VIEW === 'cost');
  document.getElementById('view-audit').classList.toggle('active', ACTIVE_VIEW === 'audit');
  document.getElementById('view-golden').classList.toggle('active', ACTIVE_VIEW === 'golden');
  document.getElementById('nav-instances').classList.toggle('active', ACTIVE_VIEW === 'instances');
  document.getElementById('nav-cost').classList.toggle('active', ACTIVE_VIEW === 'cost');
  document.getElementById('nav-audit').classList.toggle('active', ACTIVE_VIEW === 'audit');
  document.getElementById('nav-golden').classList.toggle('active', ACTIVE_VIEW === 'golden');
  document.getElementById('instanceActions').style.display = ACTIVE_VIEW === 'instances' ? 'flex' : 'none';
  document.getElementById('costActions').style.display = ACTIVE_VIEW === 'cost' ? 'flex' : 'none';
  document.getElementById('auditActions').style.display = ACTIVE_VIEW === 'audit' ? 'flex' : 'none';
  document.getElementById('goldenActions').style.display = ACTIVE_VIEW === 'golden' ? 'flex' : 'none';
  document.getElementById('pageTitle').textContent =
    ACTIVE_VIEW === 'cost' ? '成本统计' :
    ACTIVE_VIEW === 'audit' ? '日志审计' :
    ACTIVE_VIEW === 'golden' ? '黄金数据集' : '用户助手';
}

function setAuditScope(scope) {
  AUDIT_SCOPE = scope === 'push' ? 'push' : 'conversation';
  renderAuditScope();
  loadAudit();
}

function renderAuditScope() {
  const isPush = AUDIT_SCOPE === 'push';
  document.getElementById('auditScopeConversation')?.classList.toggle('active', !isPush);
  document.getElementById('auditScopePush')?.classList.toggle('active', isPush);
  document.getElementById('auditScopeHint').textContent = isPush ? '推送审计' : '对话审计';
  document.getElementById('auditTimelineTitle').textContent = isPush ? '推送时间线' : '对话时间线';
  document.getElementById('auditHelp').textContent = isPush
    ? '推送审计查看主动推送入队正文、调度任务状态和关联的 scheduler LLM trace。'
    : '对话审计查看微信用户消息进入 Codex 后的原始回复、清洗回复和入站提示。';
}

async function loadAudit() {
  const userId = document.getElementById('auditUser')?.value || '';
  const instanceId = document.getElementById('auditInstance')?.value || '';
  const limit = document.getElementById('auditLimit')?.value || '30';
  const params = new URLSearchParams();
  if (userId) params.set('userId', userId);
  if (instanceId) params.set('instanceId', instanceId);
  params.set('limit', limit);
  params.set('scope', AUDIT_SCOPE);
  try {
    const res = await fetch('/api/platform/audit?' + params.toString());
    AUDIT = await res.json();
    if (!AUDIT.ok) throw new Error(AUDIT.error || '审计接口返回失败');
    AUDIT_SCOPE = AUDIT.filters?.scope === 'push' ? 'push' : 'conversation';
    renderAuditScope();
    renderAuditControls();
    renderAuditTimeline();
  } catch (error) {
    document.getElementById('auditTimeline').innerHTML = '<div class="error" style="display:block">审计加载失败: ' + esc(error.message) + '</div>';
  }
}

function initAuditFromSelection() {
  const item = selectedInstance();
  if (!document.getElementById('auditUser')) return;
  if (item) {
    document.getElementById('auditUser').innerHTML = '<option value="' + esc(item.owner?.id || '') + '">' + esc(item.owner?.displayName || item.owner?.id || '') + '</option>';
    document.getElementById('auditInstance').innerHTML = '<option value="' + esc(item.instanceId) + '">' + esc(item.name || item.instanceId) + '</option>';
  }
  loadAudit();
}

function renderAuditControls() {
  const userSelect = document.getElementById('auditUser');
  const instanceSelect = document.getElementById('auditInstance');
  if (!userSelect || !instanceSelect) return;
  const selectedUser = AUDIT.filters?.userId || userSelect.value || '';
  const selectedInstance = AUDIT.filters?.instanceId || instanceSelect.value || '';
  userSelect.innerHTML = '<option value="">全部用户</option>' + (AUDIT.users || []).map((user) =>
    '<option value="' + esc(user.id) + '"' + (user.id === selectedUser ? ' selected' : '') + '>' + esc(user.displayName || user.id) + ' · ' + esc(user.id) + '</option>'
  ).join('');
  instanceSelect.innerHTML = '<option value="">全部用户助手</option>' + (AUDIT.instances || []).map((item) =>
    '<option value="' + esc(item.instanceId) + '"' + (item.instanceId === selectedInstance ? ' selected' : '') + '>' + esc(item.name || item.instanceId) + ' · ' + esc(item.instanceId) + '</option>'
  ).join('');
  document.getElementById('auditUpdated').textContent = '更新于 ' + fmtTime(AUDIT.updatedAt) + ' · ' + (AUDIT_SCOPE === 'push' ? '推送审计' : '对话审计');
}

async function onAuditUserChange() {
  const instanceSelect = document.getElementById('auditInstance');
  if (instanceSelect) instanceSelect.value = '';
  await loadAudit();
}

function initCostFromSelection() {
  const item = selectedInstance();
  selectedCostInstanceId = selectedCostInstanceId || item?.instanceId || '';
  if (ACTIVE_VIEW === 'cost') loadCostPanel();
}

async function loadCostPanel() {
  const selectedCostInstance = costInstanceById(selectedCostInstanceId);
  const userId = selectedCostInstance?.owner?.id || '';
  const instanceId = selectedCostInstance?.instanceId || '';
  const scope = document.getElementById('costScope')?.value || COST_FILTERS.scope || 'all';
  const days = document.getElementById('costDays')?.value || COST_FILTERS.days || '30';
  COST_FILTERS = { scope, days: String(days) };
  const root = document.getElementById('costPanel');
  if (root) root.innerHTML = '<div class="empty">正在加载成本统计...</div>';
  try {
    const base = new URLSearchParams();
    base.set('scope', scope);
    base.set('days', days);
    const scoped = new URLSearchParams(base);
    if (userId) scoped.set('userId', userId);
    if (instanceId) scoped.set('instanceId', instanceId);
    const [platform, scopedUsage, byMode, byChannel, byInstance] = await Promise.all([
      platformJson('/api/platform/audit/usage?' + base.toString()),
      platformJson('/api/platform/audit/usage?' + scoped.toString()),
      platformJson('/api/platform/audit/usage?' + withParam(scoped, 'groupBy', 'mode')),
      platformJson('/api/platform/audit/usage?' + withParam(scoped, 'groupBy', 'channel')),
      platformJson('/api/platform/audit/usage?' + withParam(base, 'groupBy', 'instance')),
    ]);
    COST = { platform, scoped: scopedUsage, byMode, byChannel, byInstance };
    renderCostPanel();
  } catch (error) {
    document.getElementById('costPanel').innerHTML = '<div class="error" style="display:block">成本统计加载失败: ' + esc(error.message) + '</div>';
  }
}

function withParam(params, key, value) {
  const next = new URLSearchParams(params);
  next.set(key, value);
  return next.toString();
}

function costInstanceById(instanceId) {
  return (DATA.instances || []).find((item) => item.instanceId === instanceId) || null;
}

async function selectCostAssistant(instanceId) {
  selectedCostInstanceId = instanceId || '';
  COST_TAB = 'users';
  await loadCostPanel();
}

function renderCostPanel() {
  const platform = COST.platform;
  const scoped = COST.scoped;
  const root = document.getElementById('costPanel');
  if (!root || !platform || !scoped) return;
  document.getElementById('costUpdated').textContent = '更新于 ' + fmtTime(scoped.updatedAt);
  const filters = scoped.filters || {};
  const costScopeHint = document.getElementById('costScopeHint');
  if (costScopeHint) costScopeHint.textContent = '最近 ' + (filters.days || 30) + ' 天 · ' + costScopeLabel(filters.scope);
  const selectedAssistant = costInstanceById(filters.instanceId || selectedCostInstanceId);
  const scopedTitle = selectedAssistant
    ? '当前用户助手成本：' + (selectedAssistant.owner?.displayName || selectedAssistant.owner?.id || selectedAssistant.name || selectedAssistant.instanceId)
    : '当前用户助手成本';
  root.innerHTML =
    renderCostToolbar() +
    renderCostTabs() +
    (COST_TAB === 'users'
      ? renderCostUsersView(scopedTitle, scoped)
      : renderCostOverviewView(platform, scoped));
}

function renderCostToolbar() {
  const scope = COST_FILTERS.scope || COST.scoped?.filters?.scope || 'all';
  const days = String(COST_FILTERS.days || COST.scoped?.filters?.days || '30');
  return '<div class="cost-toolbar">' +
    '<div class="field"><label>范围</label><select id="costScope" class="select" onchange="loadCostPanel()">' +
      costOption('all', '全部调用', scope) +
      costOption('conversation', '对话', scope) +
      costOption('push', '推送', scope) +
    '</select></div>' +
    '<div class="field"><label>时间</label><select id="costDays" class="select" onchange="loadCostPanel()">' +
      costOption('7', '最近 7 天', days) +
      costOption('30', '最近 30 天', days) +
      costOption('90', '最近 90 天', days) +
      costOption('365', '最近 365 天', days) +
    '</select></div>' +
    '<button class="btn btn-primary" onclick="loadCostPanel()">刷新</button>' +
    '<div class="muted">统计当前有效用户；用户助手切换在“各用户统计”中完成。</div>' +
  '</div>';
}

function costOption(value, label, current) {
  return '<option value="' + esc(value) + '"' + (String(value) === String(current) ? ' selected' : '') + '>' + esc(label) + '</option>';
}

function setCostTab(tab) {
  COST_TAB = tab === 'users' ? 'users' : 'overview';
  renderCostPanel();
}

function renderCostTabs() {
  return '<div class="tabs">' +
    '<button class="tab ' + (COST_TAB === 'overview' ? 'active' : '') + '" onclick="setCostTab(\\'overview\\')">总览统计</button>' +
    '<button class="tab ' + (COST_TAB === 'users' ? 'active' : '') + '" onclick="setCostTab(\\'users\\')">各用户统计</button>' +
  '</div>';
}

function renderCostOverviewView(platform, scoped) {
  return '<div class="section" style="margin-top:0"><h3>平台总成本</h3><div class="cost-summary">' + renderCostSummary(platform.totals || {}) + '</div>' + renderUsageSource(platform.totals || {}) + '</div>' +
    '<div class="section"><h3>平台按日期</h3>' + renderCostTable(platform.groups || [], '日期') + '</div>' +
    '<div class="section"><h3>当前筛选按调用类型</h3>' + renderCostTable(COST.byMode?.groups || [], 'Mode') + '</div>' +
    '<div class="section"><h3>当前筛选按通道</h3>' + renderCostTable(COST.byChannel?.groups || [], 'Channel') + '</div>';
}

function renderCostUsersView(scopedTitle, scoped) {
  return '<div class="section" style="margin-top:0"><h3>各用户助手成本统计</h3>' + renderCostAssistantTable(COST.byInstance?.groups || []) + '</div>' +
    '<div class="section"><h3>' + esc(scopedTitle) + '</h3><div class="cost-summary">' + renderCostSummary(scoped.totals || {}) + '</div>' + renderUsageSource(scoped.totals || {}) + '</div>' +
    '<div class="section"><h3>当前筛选按日期</h3>' + renderCostTable(scoped.groups || [], '日期') + '</div>';
}

function renderCostAssistantTable(rows) {
  if (!rows.length) return '<div class="empty">暂无用户助手成本记录</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>用户助手</th><th>用户</th><th>调用</th><th>总 Token</th><th>输入</th><th>输出</th><th>思考</th><th>成本</th><th>真实/估算</th></tr></thead>' +
    '<tbody>' + rows.map((row) => {
      const assistant = costInstanceById(row.bucket);
      const selected = row.bucket === selectedCostInstanceId ? ' style="background:#eff6ff"' : '';
      const label = assistant ? (assistant.name || assistant.instanceId) : row.bucket;
      const userLabel = assistant ? (assistant.owner?.displayName || assistant.owner?.id || '-') : '-';
      return '<tr' + selected + ' onclick="selectCostAssistant(\\'' + esc(row.bucket || '') + '\\')" style="cursor:pointer">' +
        '<td><strong>' + esc(label || '-') + '</strong><div class="mono">' + esc(row.bucket || '-') + '</div></td>' +
        '<td>' + esc(userLabel) + '</td>' +
        '<td>' + esc(fmtNumber(row.calls)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.inputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.outputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.thoughtTokens)) + '</td>' +
        '<td>' + esc(formatCost(row.costAmount)) + '</td>' +
        '<td>' + esc(fmtNumber(row.actualCalls || 0) + '/' + fmtNumber(row.estimatedCalls || 0)) + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
}

function renderCostSummary(totals) {
  return [
    stat(fmtNumber(totals.totalTokens), '总 Token'),
    stat(fmtNumber(totals.inputTokens), '输入 Token'),
    stat(fmtNumber(totals.outputTokens), '输出 Token'),
    stat(formatCost(totals.costAmount), '模型返回成本'),
  ].join('');
}

function renderUsageSource(totals) {
  return '<div class="cost-source">' +
    badge('调用 ' + fmtNumber(totals.calls || 0), 'gray') +
    badge('真实 ' + fmtNumber(totals.actualCalls || 0), 'ok') +
    badge('估算 ' + fmtNumber(totals.estimatedCalls || 0), 'warn') +
  '</div>';
}

function renderCostTable(rows, firstLabel) {
  if (!rows.length) return '<div class="empty">暂无成本记录</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>' + esc(firstLabel) + '</th><th>调用</th><th>总 Token</th><th>输入</th><th>输出</th><th>思考</th><th>Cache Read</th><th>成本</th><th>真实/估算</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td class="mono">' + esc(row.bucket || '-') + '</td>' +
        '<td>' + esc(fmtNumber(row.calls)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.inputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.outputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.thoughtTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.cachedReadTokens)) + '</td>' +
        '<td>' + esc(formatCost(row.costAmount)) + '</td>' +
        '<td>' + esc(fmtNumber(row.actualCalls || 0) + '/' + fmtNumber(row.estimatedCalls || 0)) + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

function fmtNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0';
}

function formatCost(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return '-';
  return '$' + n.toFixed(n < 0.01 ? 4 : 2);
}

function costScopeLabel(scope) {
  if (scope === 'conversation') return '对话';
  if (scope === 'push') return '推送';
  return '全部调用';
}

function renderAuditTimeline() {
  const root = document.getElementById('auditTimeline');
  const items = AUDIT.items || [];
  if (!items.length) {
    root.innerHTML = '<div class="empty">暂无审计记录</div>';
    return;
  }
  root.innerHTML = '<div class="audit-list">' + items.map(renderAuditItem).join('') + '</div>';
}

function kindBadge(kind) {
  if (kind === 'push_run') return badge('推送链路', 'info');
  if (kind === 'trace') return badge(AUDIT_SCOPE === 'push' ? 'Scheduler Trace' : '对话 Trace', 'info');
  if (kind === 'push') return badge('微信 Push', 'ok');
  if (kind === 'task') return badge('Task', 'gray');
  return badge(kind || '-', 'gray');
}

function renderAuditItem(item) {
  const when = formatAuditTime(item.createdAt);
  const statusKind = item.status === 'success' || item.status === 'sent' ? 'ok' : (item.status === 'error' || item.status === 'dead' ? 'warn' : 'gray');
  const meta = [
    item.userId ? ['user', item.userId] : null,
    item.instanceId ? ['instance', item.instanceId] : null,
    item.conversationId ? ['conversation', item.conversationId] : null,
    item.elapsedMs ? ['elapsed', item.elapsedMs + 'ms'] : null,
    item.totalTokens ? ['tokens', fmtNumber(item.totalTokens)] : null,
    item.usageSource ? ['usage', item.usageSource] : null,
    item.pushJobId ? ['pushJob', item.pushJobId] : null,
  ].filter(Boolean);
  const primaryText = item.kind === 'push' ? item.replyTextSanitized : (item.replyTextRaw || item.replyTextSanitized || item.errorMessage || item.userText || '');
  const displayText = item.kind === 'push_run'
    ? (item.push?.replyTextSanitized || item.replyTextSanitized || item.errorMessage || item.userText || '')
    : (item.kind === 'trace' ? (item.replyTextSanitized || item.replyTextRaw || item.errorMessage || item.userText || '') : primaryText);
  const summary = summarizeAuditText(displayText || item.userText || item.errorMessage || '-');
  const visibleBody = renderAuditVisibleBody(item, primaryText);
  const details = renderAuditDetails(item, primaryText);
  return '<div class="audit-item">' +
    '<div class="audit-rail">' +
      '<div><div class="audit-time">' + esc(when.time) + '</div><div class="audit-date">' + esc(when.date) + '</div></div>' +
      '<div class="audit-status">' + kindBadge(item.kind) + badge(item.status || '-', statusKind) + '</div>' +
    '</div>' +
    '<div class="audit-main">' +
      '<div class="audit-head">' +
        '<div class="audit-title"><div class="audit-title-row"><strong>' + esc(auditItemTitle(item)) + '</strong><span class="mono">' + esc(item.mode || '-') + '</span></div><div class="audit-summary">' + esc(summary) + '</div></div>' +
        '<div class="audit-meta">' + meta.map((pair) => '<span title="' + esc(pair[0] + '=' + pair[1]) + '">' + esc(pair[0] + '=' + pair[1]) + '</span>').join('') + '</div>' +
      '</div>' +
      (item.errorMessage ? auditSection('错误', item.errorMessage, 'audit-error') : '') +
      visibleBody +
      renderAuditUsage(item) +
      details +
    '</div>' +
  '</div>';
}

function renderAuditUsage(item) {
  if (!item.totalTokens && !item.inputTokens && !item.outputTokens && !item.costAmount) return '';
  return '<div class="cost-source">' +
    badge('total ' + fmtNumber(item.totalTokens || 0), 'info') +
    badge('in ' + fmtNumber(item.inputTokens || 0), 'gray') +
    badge('out ' + fmtNumber(item.outputTokens || 0), 'gray') +
    (item.thoughtTokens ? badge('thought ' + fmtNumber(item.thoughtTokens), 'gray') : '') +
    (item.costAmount ? badge(formatCost(item.costAmount), 'ok') : '') +
    badge(item.usageSource || 'unknown', item.usageSource === 'actual' ? 'ok' : 'warn') +
  '</div>';
}

function auditPrimaryLabel(kind) {
  if (kind === 'push_run') return '最终微信正文';
  if (kind === 'push') return '入队准备发送给微信的正文';
  if (kind === 'task') return '调度任务';
  return AUDIT_SCOPE === 'push' ? 'Scheduler 清洗后回复 / 主要内容' : '清洗后回复';
}

function auditItemTitle(item) {
  if (item.kind === 'push_run') return '调度推送链路';
  if (item.kind === 'push') return '微信推送正文';
  if (item.kind === 'task') return '调度任务记录';
  return AUDIT_SCOPE === 'push' ? '推送生成 Trace' : '微信对话 Trace';
}

function auditSection(title, text, extraClass = '') {
  return '<div class="audit-section">' +
    '<div class="audit-section-title">' + esc(title) + '</div>' +
    '<div class="audit-text ' + esc(extraClass) + '">' + esc(text || '-') + '</div>' +
  '</div>';
}

function renderAuditVisibleBody(item, primaryText) {
  if (item.kind === 'push_run') {
    return '<div class="audit-columns">' +
      auditSection('模型实际输出（清洗后）', item.replyTextSanitized || '-', 'primary') +
      auditSection('最终微信正文', item.push?.replyTextSanitized || item.push?.replyTextRaw || '-', 'primary') +
    '</div>';
  }
  if (item.kind === 'trace' && AUDIT_SCOPE === 'conversation') {
    return '<div class="audit-columns">' +
      auditSection('原始输入', item.userText, 'primary') +
      auditSection('实际输出（清洗后回复）', item.replyTextSanitized || primaryText || '-', 'primary') +
    '</div>';
  }
  if (item.kind === 'trace') {
    return '<div class="audit-columns">' +
      auditSection('实际输出（清洗后回复）', item.replyTextSanitized || primaryText || '-', 'primary') +
      auditSection('模型原始回复', item.replyTextRaw || primaryText || '-', 'primary') +
    '</div>';
  }
  return auditSection(auditPrimaryLabel(item.kind), primaryText || '-', 'primary');
}

function renderAuditDetails(item, primaryText) {
  if (item.kind === 'push_run') {
    return '<details class="audit-details"><summary>展开调度、任务输入与原始记录</summary>' +
      '<div class="audit-columns">' +
        auditSection('任务状态', renderPushRunTaskSummary(item)) +
        auditSection('模型原始回复', item.replyTextRaw || '-') +
      '</div>' +
      '<div class="audit-columns">' +
        auditSection('任务输入', item.userText || '-') +
        auditSection('Prompt / 入站提示', item.promptText || '-') +
      '</div>' +
    '</details>';
  }
  if (item.kind !== 'trace') return '';
  return '<details class="audit-details"><summary>' + (AUDIT_SCOPE === 'push' ? '展开任务输入与技术字段' : '展开模型原始回复与技术字段') + '</summary>' +
    '<div class="audit-columns">' +
      auditSection(AUDIT_SCOPE === 'push' ? '任务输入' : '模型原始回复', AUDIT_SCOPE === 'push' ? item.userText : (item.replyTextRaw || primaryText || '-')) +
      auditSection('Prompt / 入站提示', item.promptText || '-') +
    '</div></details>';
}

function renderPushRunTaskSummary(item) {
  const lines = [
    'task=' + (item.task?.id || item.id || '-'),
    'taskStatus=' + (item.task?.status || '-'),
    'pushJob=' + (item.pushJobId || '-'),
    'pushStatus=' + (item.push?.status || '-'),
    'finishedAt=' + fmtTime(item.finishedAt || item.task?.finishedAt || ''),
  ];
  return lines.join('\\n');
}

function summarizeAuditText(text) {
  const value = String(text || '').replace(/\\s+/g, ' ').trim();
  if (!value) return '-';
  return value.length > 120 ? value.slice(0, 120) + '...' : value;
}

function formatAuditTime(value) {
  if (!value) return { date: '-', time: '-' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value, time: '-' };
  return {
    date: date.toLocaleDateString('zh-CN'),
    time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

async function loadGoldenCases() {
  try {
    GOLDEN = await platformJson('/api/platform/golden-cases');
    selectedGoldenId = selectedGoldenId || GOLDEN.cases?.[0]?.id || '';
    renderGoldenFilters();
    renderGoldenCases();
  } catch (error) {
    document.getElementById('goldenDetail').innerHTML = '<div class="error" style="display:block">黄金数据集加载失败: ' + esc(error.message) + '</div>';
  }
}

function selectedGoldenCase() {
  return (GOLDEN.cases || []).find((item) => item.id === selectedGoldenId) || (GOLDEN.cases || [])[0] || null;
}

function renderGoldenFilters() {
  const categories = Object.keys(GOLDEN.stats?.categories || {});
  const priorities = Object.keys(GOLDEN.stats?.priorities || {});
  document.getElementById('goldenCategory').innerHTML = '<option value="">全部分类</option>' + categories.map((item) => '<option value="' + esc(item) + '">' + esc(item) + '</option>').join('');
  document.getElementById('goldenPriority').innerHTML = '<option value="">全部优先级</option>' + priorities.map((item) => '<option value="' + esc(item) + '">' + esc(item) + '</option>').join('');
}

function filteredGoldenCases() {
  const keyword = (document.getElementById('goldenSearch')?.value || '').trim().toLowerCase();
  const category = document.getElementById('goldenCategory')?.value || '';
  const priority = document.getElementById('goldenPriority')?.value || '';
  return (GOLDEN.cases || []).filter((item) => {
    if (category && item.category !== category) return false;
    if (priority && item.priority !== priority) return false;
    if (!keyword) return true;
    return [
      item.id,
      item.category,
      item.priority,
      item.scenario,
      item.userInput,
      item.styleNotes,
      ...(item.tags || []),
      ...(item.principles || []),
    ].some((value) => String(value || '').toLowerCase().includes(keyword));
  });
}

function renderGoldenCases() {
  const cases = filteredGoldenCases();
  if (!cases.some((item) => item.id === selectedGoldenId)) {
    selectedGoldenId = cases[0]?.id || GOLDEN.cases?.[0]?.id || '';
  }
  document.getElementById('goldenCount').textContent = (GOLDEN.stats?.total || 0) + ' 条';
  document.getElementById('goldenUpdated').textContent = GOLDEN.updatedAt ? '更新于 ' + fmtTime(GOLDEN.updatedAt) : '未加载';
  document.getElementById('goldenStats').innerHTML = [
    metric(GOLDEN.stats?.total || 0, 'Case 总数'),
    metric((GOLDEN.stats?.priorities || {}).P0 || 0, 'P0'),
    metric(Object.keys(GOLDEN.stats?.categories || {}).length, '分类'),
  ].join('');
  const root = document.getElementById('goldenList');
  if (!cases.length) {
    root.innerHTML = '<div class="empty">没有匹配的 case</div>';
  } else {
    root.innerHTML = '<div class="eval-list">' + cases.map(renderGoldenCard).join('') + '</div>';
  }
  renderGoldenDetail();
}

function renderGoldenCard(item) {
  const selected = item.id === selectedGoldenId ? ' selected' : '';
  const summary = summarizeAuditText(item.userInput || item.styleNotes || item.scenario);
  return '<div class="eval-card' + selected + '" onclick="selectGoldenCase(\\'' + esc(item.id) + '\\')">' +
    '<div class="eval-title"><strong>' + esc(item.id) + '</strong>' + badge(item.priority || '-', item.priority === 'P0' ? 'warn' : 'gray') + '</div>' +
    '<div class="eval-desc">' + esc(item.scenario || '-') + '</div>' +
    '<div class="eval-desc">' + esc(summary) + '</div>' +
    '<div class="eval-tags">' +
      badge(item.category || '-', 'info') +
      badge((item.turnCount || 1) + ' turn', 'gray') +
      badge('must +' + (item.mustContainCount || 0), 'ok') +
      badge('must-not ' + (item.mustNotContainCount || 0), 'gray') +
    '</div>' +
  '</div>';
}

function selectGoldenCase(id) {
  selectedGoldenId = id;
  renderGoldenCases();
}

function renderGoldenDetail() {
  const item = selectedGoldenCase();
  const root = document.getElementById('goldenDetail');
  if (!item) {
    root.innerHTML = '<div class="empty">选择一个 case</div>';
    return;
  }
  root.innerHTML =
    '<dl class="kv">' +
      '<dt>Case ID</dt><dd class="mono">' + esc(item.id) + '</dd>' +
      '<dt>场景</dt><dd>' + esc(item.scenario || '-') + '</dd>' +
      '<dt>分类</dt><dd>' + esc(item.category || '-') + ' · ' + esc(item.priority || '-') + '</dd>' +
      '<dt>标签</dt><dd>' + esc((item.tags || []).join(', ') || '-') + '</dd>' +
      '<dt>轮数</dt><dd>' + esc(item.turnCount || 1) + '</dd>' +
    '</dl>' +
    '<div class="section"><h3>原则</h3>' + auditSection('Principles', (item.principles || []).map((line) => '- ' + line).join('\\n') || '-') + '</div>' +
    '<div class="section"><h3>编辑 YAML</h3><textarea id="goldenRawEditor" class="golden-editor">' + esc(item.rawYaml || '') + '</textarea></div>' +
    '<div id="goldenSaveError" class="error" style="display:none"></div>' +
    '<div class="ops">' +
      '<button class="btn btn-primary" onclick="saveGoldenCase()">保存这条 case</button>' +
      '<button class="btn" onclick="renderGoldenDetail()">放弃修改</button>' +
    '</div>';
}

async function saveGoldenCase() {
  const item = selectedGoldenCase();
  if (!item) return;
  const error = document.getElementById('goldenSaveError');
  error.style.display = 'none';
  try {
    GOLDEN = await platformJson('/api/platform/golden-cases', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, rawYaml: document.getElementById('goldenRawEditor').value }),
    });
    selectedGoldenId = item.id;
    renderGoldenFilters();
    renderGoldenCases();
  } catch (err) {
    error.textContent = err.message;
    error.style.display = 'block';
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
  renderChrome();
  const instances = filteredInstances();
  if (!instances.some((item) => item.instanceId === selectedInstanceId)) {
    selectedInstanceId = instances[0]?.instanceId || '';
  }
  document.getElementById('updatedAt').textContent = '更新于 ' + fmtTime(DATA.updatedAt);
  document.getElementById('instanceCount').textContent = instances.length + ' 个用户助手';
  renderStats(DATA.instances || []);
  renderList(instances);
  renderDetail((DATA.instances || []).find((item) => item.instanceId === selectedInstanceId));
}

function renderStats(instances) {
  const active = instances.filter((item) => item.status === 'active').length;
  const wxBound = instances.filter((item) => item.channelBindingCount > 0).length;
  const conversations = instances.reduce((sum, item) => sum + Number(item.traceCount || 0), 0);
  document.getElementById('stats').innerHTML = [
    stat(instances.length, '用户助手'),
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
    root.innerHTML = '<div class="empty">暂无用户助手</div>';
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
  const item = selectedInstance();
  if (item && document.getElementById('auditUser')) {
    document.getElementById('auditUser').value = item.owner?.id || '';
    document.getElementById('auditInstance').value = item.instanceId;
    loadAudit();
  }
  if (item) {
    selectedCostInstanceId = item.instanceId;
    if (ACTIVE_VIEW === 'cost') loadCostPanel();
  }
}

function renderDetail(item) {
  const root = document.getElementById('detail');
  document.getElementById('selectedHint').textContent = item ? item.instanceId : '未选择';
  if (!item) {
    root.innerHTML = '<div class="empty">请选择一个用户助手</div>';
    return;
  }
  root.innerHTML =
    '<dl class="kv">' +
      '<dt>助手名称</dt><dd>' + esc(item.name) + '</dd>' +
      '<dt>助手 ID</dt><dd class="mono">' + esc(item.instanceId) + '</dd>' +
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
      (item.instanceId === 'invest-agent-primary' ? '' : '<button class="btn" onclick="archiveSelectedInstance()">删除用户助手</button>') +
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
  if (!rows.length) return '<div class="empty">暂无微信绑定；用户先给该助手对应微信发消息后会出现绑定。</div>';
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
    alert('主用户助手不能删除');
    return;
  }
  const ok = confirm('确认删除用户助手「' + item.name + '」？\\n\\n这会删除该用户助手的数据库记录、微信绑定、业务数据和 Workspace。主用户助手不能删除。');
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
