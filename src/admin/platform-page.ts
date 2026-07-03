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
    .eval-workbench { display: flex; flex-direction: column; gap: 14px; height: calc(100vh - 92px); min-height: 620px; }
    .view.eval-workbench { display: none; }
    .view.eval-workbench.active { display: flex; }
    .eval-grid { display: grid; grid-template-columns: minmax(320px, .78fr) minmax(460px, 1.22fr); gap: 14px; align-items: stretch; flex: 1; min-height: 0; }
    .view.eval-grid { display: none; }
    .view.eval-grid.active { display: grid; }
    .eval-tab-view { display: none; min-height: 0; flex: 1; }
    .eval-tab-view.active { display: block; }
    .eval-tab-view.case-library.active { display: flex; }
    .eval-workbench-grid { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(420px, 1fr); gap: 14px; align-items: start; }
    .eval-stage-list { display: grid; gap: 10px; }
    .eval-stage { border: 1px solid #d9e0ea; border-radius: 8px; background: #fff; padding: 12px; }
    .eval-stage-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .eval-stage h3 { margin: 0; color: #111827; font-size: 13px; }
    .eval-stage p { margin: 7px 0 0; color: #475569; font-size: 12px; line-height: 1.55; }
    .eval-command { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 8px; color: #334155; font-size: 12px; margin-top: 8px; }
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
    .golden-list-panel, .golden-detail-panel { min-height: 0; display: flex; flex-direction: column; }
    .golden-list-body { min-height: 0; display: flex; flex-direction: column; }
    .golden-list-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .golden-list-scroll { flex: 1; min-height: 0; overflow: auto; padding-right: 4px; }
    .golden-detail-body { min-height: 0; overflow: auto; }
    .golden-tier-filter { display: flex; flex-wrap: wrap; gap: 6px; }
    .tier-chip { border: 1px solid #cbd5e1; background: #fff; color: #475569; border-radius: 999px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
    .tier-chip.active { border-color: #2563eb; background: #dbeafe; color: #1d4ed8; font-weight: 650; }
    .eval-list { display: flex; flex-direction: column; gap: 9px; padding-bottom: 4px; }
    .eval-card { border: 1px solid #d9e0ea; background: #fff; border-radius: 8px; padding: 12px; cursor: pointer; }
    .eval-card:hover { background: #f8fafc; border-color: #9db3d1; }
    .eval-card.selected { background: #eff6ff; border-color: #60a5fa; box-shadow: 0 0 0 1px rgba(96,165,250,.22); }
    .eval-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .eval-title strong { min-width: 0; color: #0f172a; font-size: 13px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .eval-desc { color: #475569; font-size: 12px; line-height: 1.5; margin-top: 7px; }
    .eval-case-id { color: #64748b; font-size: 11px; margin-top: 6px; }
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
      .eval-workbench { height: auto; min-height: 0; }
      .eval-grid { grid-template-columns: 1fr; height: auto; min-height: 0; }
      .eval-workbench-grid { grid-template-columns: 1fr; }
      .golden-list-panel, .golden-detail-panel { max-height: none; }
      .golden-list-scroll, .golden-detail-body { overflow: visible; }
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
        <a id="nav-rule-alerts" href="#rule-alerts" onclick="setView('rule-alerts')">规则巡检 <span>›</span></a>
        <a id="nav-golden" href="#golden" onclick="setView('golden')">评测工作台 <span>›</span></a>
        <a href="/dashboard">投资工作台 <span>↗</span></a>
        <a id="nav-source-quality" href="#source-quality" onclick="setView('source-quality')">数据源质量 <span>›</span></a>
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
        <div class="actions" id="ruleAlertActions" style="display:none">
          <button class="btn btn-primary" onclick="loadRuleAlerts()">刷新巡检</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
        <div class="actions" id="costActions" style="display:none">
          <button class="btn btn-primary" onclick="loadCostPanel()">刷新成本</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
        <div class="actions" id="sourceQualityActions" style="display:none">
          <button class="btn btn-primary" onclick="loadSourceQuality()">刷新质量</button>
          <button class="btn" onclick="setView('instances')">返回用户助手</button>
        </div>
        <div class="actions" id="goldenActions" style="display:none">
          <button class="btn btn-primary" onclick="loadGoldenCases()">刷新评测资产</button>
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
      <section id="view-source-quality" class="view cost-grid">
        <div class="panel">
          <div class="panel-head">
            <h2>数据源可靠性</h2>
            <span class="muted" id="sourceQualityUpdated">未加载</span>
          </div>
          <div class="panel-body" id="sourceQualityPanel"><div class="empty">加载中...</div></div>
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
      <section id="view-rule-alerts" class="view audit-grid">
        <div class="panel">
          <div class="panel-head">
            <h2>规则巡检</h2>
            <span class="muted" id="ruleAlertScopeHint">确定性采样</span>
          </div>
          <div class="panel-body">
            <div class="form-grid">
              <div class="field">
                <label>用户</label>
                <select id="ruleAlertUser" class="select" onchange="onRuleAlertUserChange()"></select>
              </div>
              <div class="field">
                <label>用户助手</label>
                <select id="ruleAlertInstance" class="select" onchange="loadRuleAlerts()"></select>
              </div>
              <div class="field">
                <label>条数</label>
                <select id="ruleAlertLimit" class="select" onchange="loadRuleAlerts()">
                  <option value="30">30</option>
                  <option value="60">60</option>
                  <option value="120">120</option>
                </select>
              </div>
              <button class="btn btn-primary" onclick="loadRuleAlerts()">刷新巡检</button>
              <div class="muted">规则巡检按采样当刻价格执行确定性规则；触发事实写入提醒事件，推送由优先级和去重策略决定。</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>规则巡检审计</h2>
            <span class="muted" id="ruleAlertUpdated">未加载</span>
          </div>
          <div class="panel-body" id="ruleAlertPanel"><div class="empty">选择用户后加载规则巡检记录</div></div>
        </div>
      </section>
      <section id="view-golden" class="view eval-workbench">
        <div class="tabs">
          <button id="evalTabOverview" class="tab active" onclick="setGoldenTab('overview')">总览</button>
          <button id="evalTabReview" class="tab" onclick="setGoldenTab('review')">人工待审</button>
          <button id="evalTabCases" class="tab" onclick="setGoldenTab('cases')">黄金 Case 库</button>
          <button id="evalTabRuns" class="tab" onclick="setGoldenTab('runs')">运行记录</button>
        </div>
        <div id="eval-view-overview" class="eval-tab-view active">
          <div class="eval-workbench-grid">
            <div class="panel">
              <div class="panel-head">
                <h2>评测分层</h2>
                <span class="muted">L1 / L2 / L3</span>
              </div>
              <div class="panel-body" id="evalOverview"></div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2>资产概览</h2>
                <span class="muted" id="goldenUpdated">未加载</span>
              </div>
              <div class="panel-body" id="evalAssetOverview"><div class="empty">加载中...</div></div>
            </div>
          </div>
        </div>
        <div id="eval-view-review" class="eval-tab-view">
          <div class="panel">
            <div class="panel-head">
              <h2>人工待审</h2>
              <span class="muted" id="evalReviewHint">等待评测结果</span>
            </div>
            <div class="panel-body" id="evalReviewQueue"><div class="empty">加载中...</div></div>
          </div>
        </div>
        <div id="eval-view-cases" class="eval-tab-view case-library">
          <div class="eval-grid">
            <div class="panel golden-list-panel">
              <div class="panel-head">
                <h2>黄金 Case 库</h2>
                <span class="muted" id="goldenCount">0 项</span>
              </div>
              <div class="panel-body golden-list-body">
                <div class="metrics" id="goldenStats"></div>
                <div class="section">
                  <div class="form-grid">
                    <input id="goldenSearch" class="input" placeholder="搜索 case、场景、输入、原则" oninput="renderGoldenCases()" />
                    <div class="golden-tier-filter" id="goldenTierFilter"></div>
                    <div class="audit-columns">
                      <select id="goldenDomain" class="select" onchange="renderGoldenCases()"></select>
                      <select id="goldenCategory" class="select" onchange="renderGoldenCases()"></select>
                    </div>
                    <div class="audit-columns">
                      <select id="goldenPriority" class="select" onchange="renderGoldenCases()"></select>
                    </div>
                  </div>
                </div>
                <div class="section golden-list-section">
                  <div class="golden-list-scroll" id="goldenList"><div class="empty">加载中...</div></div>
                </div>
              </div>
            </div>
            <div class="panel golden-detail-panel">
              <div class="panel-head">
                <h2>Case 详情</h2>
                <span class="muted">YAML / 单条运行</span>
              </div>
              <div class="panel-body golden-detail-body" id="goldenDetail"><div class="empty">选择一个 case</div></div>
            </div>
          </div>
        </div>
        <div id="eval-view-runs" class="eval-tab-view">
          <div class="panel">
            <div class="panel-head">
              <h2>运行记录</h2>
              <span class="muted">本页单条运行</span>
            </div>
            <div class="panel-body" id="evalRunHistory"><div class="empty">尚未运行 case</div></div>
          </div>
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
let AUDIT_ITEM_BY_ID = {};
let RULE_ALERTS = { users: [], instances: [], tasks: [], events: [], rules: [], filters: {}, summary: {} };
let COST = { platform: null, scoped: null };
let COST_TAB = 'overview';
let COST_FILTERS = { days: '30' };
let selectedCostInstanceId = '';
let SOURCE_QUALITY = null;
let GOLDEN = { cases: [], stats: {}, suite: {}, qualityGates: {} };
let EVAL_REVIEW_QUEUE = null;
let selectedGoldenId = '';
let GOLDEN_RUNS = {};
let GOLDEN_TAB = 'overview';
let GOLDEN_ACTIVE_TIERS = new Set(['golden_core', 'regression']);
const VALID_VIEWS = new Set(['instances', 'cost', 'source-quality', 'audit', 'rule-alerts', 'golden']);
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
    initRuleAlertsFromSelection();
    initCostFromSelection();
    if (ACTIVE_VIEW === 'golden') {
      loadGoldenCases();
    }
    if (ACTIVE_VIEW === 'source-quality' && !SOURCE_QUALITY) {
      loadSourceQuality();
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
  if (ACTIVE_VIEW === 'rule-alerts' && !(RULE_ALERTS.tasks || []).length) {
    initRuleAlertsFromSelection();
  }
  if (ACTIVE_VIEW === 'cost' && !COST.platform) {
    initCostFromSelection();
  }
  if (ACTIVE_VIEW === 'source-quality' && !SOURCE_QUALITY) {
    loadSourceQuality();
  }
  if (ACTIVE_VIEW === 'golden' && !(GOLDEN.cases || []).length) {
    loadGoldenCases();
  } else if (ACTIVE_VIEW === 'golden') {
    renderGoldenWorkbench();
  }
}

function renderChrome() {
  document.getElementById('view-instances').classList.toggle('active', ACTIVE_VIEW === 'instances');
  document.getElementById('view-cost').classList.toggle('active', ACTIVE_VIEW === 'cost');
  document.getElementById('view-source-quality').classList.toggle('active', ACTIVE_VIEW === 'source-quality');
  document.getElementById('view-audit').classList.toggle('active', ACTIVE_VIEW === 'audit');
  document.getElementById('view-rule-alerts').classList.toggle('active', ACTIVE_VIEW === 'rule-alerts');
  document.getElementById('view-golden').classList.toggle('active', ACTIVE_VIEW === 'golden');
  document.getElementById('nav-instances').classList.toggle('active', ACTIVE_VIEW === 'instances');
  document.getElementById('nav-cost').classList.toggle('active', ACTIVE_VIEW === 'cost');
  document.getElementById('nav-source-quality').classList.toggle('active', ACTIVE_VIEW === 'source-quality');
  document.getElementById('nav-audit').classList.toggle('active', ACTIVE_VIEW === 'audit');
  document.getElementById('nav-rule-alerts').classList.toggle('active', ACTIVE_VIEW === 'rule-alerts');
  document.getElementById('nav-golden').classList.toggle('active', ACTIVE_VIEW === 'golden');
  document.getElementById('instanceActions').style.display = ACTIVE_VIEW === 'instances' ? 'flex' : 'none';
  document.getElementById('costActions').style.display = ACTIVE_VIEW === 'cost' ? 'flex' : 'none';
  document.getElementById('sourceQualityActions').style.display = ACTIVE_VIEW === 'source-quality' ? 'flex' : 'none';
  document.getElementById('auditActions').style.display = ACTIVE_VIEW === 'audit' ? 'flex' : 'none';
  document.getElementById('ruleAlertActions').style.display = ACTIVE_VIEW === 'rule-alerts' ? 'flex' : 'none';
  document.getElementById('goldenActions').style.display = ACTIVE_VIEW === 'golden' ? 'flex' : 'none';
  document.getElementById('pageTitle').textContent =
    ACTIVE_VIEW === 'cost' ? '成本统计' :
    ACTIVE_VIEW === 'source-quality' ? '数据源质量' :
    ACTIVE_VIEW === 'audit' ? '日志审计' :
    ACTIVE_VIEW === 'rule-alerts' ? '规则巡检' :
    ACTIVE_VIEW === 'golden' ? '评测工作台' : '用户助手';
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

async function loadRuleAlerts() {
  const userId = document.getElementById('ruleAlertUser')?.value || '';
  const instanceId = document.getElementById('ruleAlertInstance')?.value || '';
  const limit = document.getElementById('ruleAlertLimit')?.value || '30';
  const params = new URLSearchParams();
  if (userId) params.set('userId', userId);
  if (instanceId) params.set('instanceId', instanceId);
  params.set('limit', limit);
  try {
    RULE_ALERTS = await platformJson('/api/platform/rule-alerts?' + params.toString());
    if (!RULE_ALERTS.ok) throw new Error(RULE_ALERTS.error || '规则巡检接口返回失败');
    renderRuleAlertControls();
    renderRuleAlertPanel();
  } catch (error) {
    document.getElementById('ruleAlertPanel').innerHTML = '<div class="error" style="display:block">规则巡检加载失败: ' + esc(error.message) + '</div>';
  }
}

function initRuleAlertsFromSelection() {
  const item = selectedInstance();
  if (!document.getElementById('ruleAlertUser')) return;
  if (item) {
    document.getElementById('ruleAlertUser').innerHTML = '<option value="' + esc(item.owner?.id || '') + '">' + esc(item.owner?.displayName || item.owner?.id || '') + '</option>';
    document.getElementById('ruleAlertInstance').innerHTML = '<option value="' + esc(item.instanceId) + '">' + esc(item.name || item.instanceId) + '</option>';
  }
  if (ACTIVE_VIEW === 'rule-alerts') loadRuleAlerts();
}

function renderRuleAlertControls() {
  const userSelect = document.getElementById('ruleAlertUser');
  const instanceSelect = document.getElementById('ruleAlertInstance');
  if (!userSelect || !instanceSelect) return;
  const selectedUser = RULE_ALERTS.filters?.userId || userSelect.value || '';
  const selectedInstance = RULE_ALERTS.filters?.instanceId || instanceSelect.value || '';
  userSelect.innerHTML = '<option value="">全部用户</option>' + (RULE_ALERTS.users || []).map((user) =>
    '<option value="' + esc(user.id) + '"' + (user.id === selectedUser ? ' selected' : '') + '>' + esc(user.displayName || user.id) + ' · ' + esc(user.id) + '</option>'
  ).join('');
  instanceSelect.innerHTML = '<option value="">全部用户助手</option>' + (RULE_ALERTS.instances || []).map((item) =>
    '<option value="' + esc(item.instanceId) + '"' + (item.instanceId === selectedInstance ? ' selected' : '') + '>' + esc(item.name || item.instanceId) + ' · ' + esc(item.instanceId) + '</option>'
  ).join('');
  document.getElementById('ruleAlertUpdated').textContent = '更新于 ' + fmtTime(RULE_ALERTS.updatedAt);
  document.getElementById('ruleAlertScopeHint').textContent = '采样间隔 ' + (RULE_ALERTS.intervalMinutes || '-') + ' 分钟';
}

async function onRuleAlertUserChange() {
  const instanceSelect = document.getElementById('ruleAlertInstance');
  if (instanceSelect) instanceSelect.value = '';
  await loadRuleAlerts();
}

function renderRuleAlertPanel() {
  const root = document.getElementById('ruleAlertPanel');
  if (!root || !RULE_ALERTS.ok) return;
  const summary = RULE_ALERTS.summary || {};
  root.innerHTML =
    '<div class="section" style="margin-top:0"><h3>运行总览</h3><div class="cost-summary">' +
      stat(fmtNumber(RULE_ALERTS.intervalMinutes), '采样间隔(分钟)') +
      stat(fmtNumber(summary.enabledRules), '启用规则') +
      stat(fmtNumber(summary.todayRuns), '今日运行') +
      stat(fmtNumber(summary.todayHits), '今日命中') +
      stat(fmtNumber(summary.todayErrors), '今日错误') +
    '</div><div class="cost-source">' +
      badge('独立确定性任务', 'info') +
      badge('只判断采样当刻价格/事实', 'ok') +
      badge('不依赖定时简报', 'warn') +
    '</div></div>' +
    '<div class="section"><h3>最近运行</h3>' + renderRuleAlertTaskTable(RULE_ALERTS.tasks || []) + '</div>' +
    '<div class="section"><h3>最近命中事件</h3>' + renderRuleAlertEventTable(RULE_ALERTS.events || []) + '</div>' +
    '<div class="section"><h3>启用规则</h3>' + renderRuleAlertRuleTable(RULE_ALERTS.rules || []) + '</div>';
}

function renderRuleAlertTaskTable(rows) {
  if (!rows.length) return '<div class="empty">暂无独立规则巡检运行记录；服务启动后会按采样间隔生成。</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>时间</th><th>用户</th><th>助手</th><th>采样槽</th><th>状态</th><th>推送</th><th>错误</th></tr></thead>' +
    '<tbody>' + rows.map((row) => {
      const statusKind = row.status === 'success' ? 'ok' : (row.status === 'error' ? 'warn' : 'gray');
      return '<tr>' +
        '<td>' + esc(fmtTime(row.createdAt)) + '</td>' +
        '<td class="mono">' + esc(row.userId || '-') + '</td>' +
        '<td class="mono">' + esc(row.instanceId || '-') + '</td>' +
        '<td class="mono">' + esc(row.scheduledFor || '-') + '</td>' +
        '<td>' + badge(row.status || '-', statusKind) + '</td>' +
        '<td class="mono">' + esc(row.pushJobId || '-') + '</td>' +
        '<td>' + esc(row.errorMessage || '-') + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
}

function renderRuleAlertEventTable(rows) {
  if (!rows.length) return '<div class="empty">暂无规则命中事件</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>时间</th><th>用户</th><th>股票</th><th>规则</th><th>价格</th><th>级别</th><th>状态</th><th>消息</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td>' + esc(fmtTime(row.createdAt)) + '</td>' +
        '<td class="mono">' + esc(row.userId || '-') + '</td>' +
        '<td><strong>' + esc(row.stockName || '-') + '</strong><div class="mono">' + esc(row.stockCode || '-') + '</div></td>' +
        '<td class="mono">' + esc(row.signalKey || '-') + '</td>' +
        '<td>' + esc(row.price == null ? '-' : row.price) + '</td>' +
        '<td>' + badge(row.severity || '-', row.severity === 'high' ? 'warn' : 'gray') + '</td>' +
        '<td>' + esc(row.status || '-') + '</td>' +
        '<td>' + esc(row.message || '-') + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

function renderRuleAlertRuleTable(rows) {
  if (!rows.length) return '<div class="empty">暂无规则实例</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>规则</th><th>用户</th><th>股票</th><th>条件</th><th>参数</th><th>去重</th><th>启用</th><th>更新时间</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td><strong>#' + esc(row.id) + '</strong><div class="mono">' + esc(row.indicatorKey || '-') + '</div></td>' +
        '<td class="mono">' + esc(row.userId || '-') + '</td>' +
        '<td><strong>' + esc(row.stockName || '-') + '</strong><div class="mono">' + esc(row.stockCode || '-') + '</div></td>' +
        '<td class="mono">' + esc(row.condition || '-') + '</td>' +
        '<td class="mono">' + esc(row.params || '{}') + '</td>' +
        '<td class="mono">' + esc(row.dedupePolicy || '{}') + '</td>' +
        '<td>' + badge(row.enabled ? '启用' : '停用', row.enabled ? 'ok' : 'gray') + '</td>' +
        '<td>' + esc(fmtTime(row.updatedAt)) + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
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
  const days = document.getElementById('costDays')?.value || COST_FILTERS.days || '30';
  COST_FILTERS = { days: String(days) };
  const root = document.getElementById('costPanel');
  if (root) root.innerHTML = '<div class="empty">正在加载成本统计...</div>';
  try {
    const base = new URLSearchParams();
    base.set('days', days);
    const scoped = new URLSearchParams(base);
    if (userId) scoped.set('userId', userId);
    if (instanceId) scoped.set('instanceId', instanceId);
    const [platform, scopedUsage, byInstance] = await Promise.all([
      platformJson('/api/platform/audit/usage?' + base.toString()),
      platformJson('/api/platform/audit/usage?' + scoped.toString()),
      platformJson('/api/platform/audit/usage?' + withParam(base, 'groupBy', 'instance')),
    ]);
    COST = { platform, scoped: scopedUsage, byInstance };
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
  if (costScopeHint) costScopeHint.textContent = '最近 ' + (filters.days || 30) + ' 天 · Codex 原生日志';
  const selectedAssistant = costInstanceById(filters.instanceId || selectedCostInstanceId);
  const scopedTitle = selectedAssistant
    ? '当前用户助手 Codex 用量：' + (selectedAssistant.owner?.displayName || selectedAssistant.owner?.id || selectedAssistant.name || selectedAssistant.instanceId)
    : '当前用户助手 Codex 用量';
  root.innerHTML =
    renderCostToolbar() +
    renderCostTabs() +
    (COST_TAB === 'users'
      ? renderCostUsersView(scopedTitle, scoped)
      : renderCostOverviewView(platform, scoped));
}

function renderCostToolbar() {
  const days = String(COST_FILTERS.days || COST.scoped?.filters?.days || '30');
  return '<div class="cost-toolbar">' +
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
  return '<div class="section" style="margin-top:0"><h3>Codex 原生日志用量</h3><div class="cost-summary">' + renderCodexUsageSummary(platform.codexUsage?.totals || {}) + '</div>' + renderCodexUsageSource(platform.codexUsage?.totals || {}) + '</div>' +
    '<div class="section"><h3>Codex 原生日志按日期</h3>' + renderCodexUsageTable(platform.codexUsage?.groups || [], '日期') + '</div>';
}

function renderCostUsersView(scopedTitle, scoped) {
  return '<div class="section" style="margin-top:0"><h3>各用户助手 Codex 原生日志</h3>' + renderCodexAssistantTable(COST.byInstance?.codexUsage?.groups || []) + '</div>' +
    '<div class="section"><h3>' + esc(scopedTitle) + '</h3><div class="cost-summary">' + renderCodexUsageSummary(scoped.codexUsage?.totals || {}) + '</div>' + renderCodexUsageSource(scoped.codexUsage?.totals || {}) + '</div>' +
    '<div class="section"><h3>当前筛选 Codex 按日期</h3>' + renderCodexUsageTable(scoped.codexUsage?.groups || [], '日期') + '</div>';
}

function renderCodexAssistantTable(rows) {
  if (!rows.length) return '<div class="empty">暂无 Codex 原生日志用量</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>用户助手</th><th>用户</th><th>Token Events</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>Cache Read</th></tr></thead>' +
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
        '<td>' + esc(fmtNumber(row.cachedReadTokens)) + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
}

function renderCodexUsageSummary(totals) {
  return [
    stat(fmtNumber(totals.totalTokens), 'Codex 总 Token'),
    stat(fmtNumber(totals.inputTokens), '输入 Token'),
    stat(fmtNumber(totals.outputTokens), '输出 Token'),
    stat(fmtNumber(totals.thoughtTokens), '推理 Token'),
    stat(fmtNumber(totals.cachedReadTokens), 'Cache Read'),
  ].join('');
}

function renderCodexUsageSource(totals) {
  return '<div class="cost-source">' +
    badge('token_count events ' + fmtNumber(totals.calls || 0), 'ok') +
    badge('来源 .codex/sessions', 'info') +
    badge('不区分对话/推送', 'warn') +
  '</div>';
}

function renderCodexUsageTable(rows, firstLabel) {
  if (!rows.length) return '<div class="empty">暂无 Codex 原生日志用量</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>' + esc(firstLabel) + '</th><th>Token Events</th><th>总 Token</th><th>输入</th><th>输出</th><th>推理</th><th>Cache Read</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td class="mono">' + esc(row.bucket || '-') + '</td>' +
        '<td>' + esc(fmtNumber(row.calls)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.inputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.outputTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.thoughtTokens)) + '</td>' +
        '<td>' + esc(fmtNumber(row.cachedReadTokens)) + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

async function loadSourceQuality() {
  const root = document.getElementById('sourceQualityPanel');
  if (root) root.innerHTML = '<div class="empty">正在加载数据源质量...</div>';
  try {
    SOURCE_QUALITY = await platformJson('/api/platform/source-quality');
    renderSourceQuality();
  } catch (error) {
    document.getElementById('sourceQualityPanel').innerHTML = '<div class="error" style="display:block">数据源质量加载失败: ' + esc(error.message) + '</div>';
  }
}

function renderSourceQuality() {
  const root = document.getElementById('sourceQualityPanel');
  if (!root || !SOURCE_QUALITY) return;
  document.getElementById('sourceQualityUpdated').textContent = '更新于 ' + fmtTime(SOURCE_QUALITY.updatedAt);
  const endpoints = SOURCE_QUALITY.health?.endpoints || [];
  const capabilities = SOURCE_QUALITY.health?.capabilities || [];
  const latest = SOURCE_QUALITY.reports?.[0] || null;
  const failedNow = endpoints.filter((item) => item.lastStatus === 'fail').length;
  const readyCount = capabilities.filter((item) => item.status === 'ready').length;
  const partialCount = capabilities.filter((item) => item.status === 'partial').length;
  const missingCount = capabilities.filter((item) => item.status === 'missing').length;
  root.innerHTML =
    '<div class="section" style="margin-top:0"><h3>数据源能力总览</h3><div class="cost-summary">' +
      stat(fmtNumber(readyCount), '可用能力') +
      stat(fmtNumber(partialCount), '部分可用') +
      stat(fmtNumber(missingCount), '缺失能力') +
      stat(fmtNumber(endpoints.length), 'Provider 端点') +
    '</div><div class="cost-source">' +
      badge('服务层数据', 'info') +
      badge('可靠服务目标: fallback + freshness + audit', 'warn') +
    '</div></div>' +
    '<div class="section"><h3>能力矩阵</h3>' + renderSourceCapabilityTable(capabilities) + '</div>' +
    '<div class="section"><h3>当前 Provider 健康</h3><div class="cost-summary">' +
      stat(fmtNumber(endpoints.length), '已观测端点') +
      stat(fmtNumber(failedNow), '当前失败') +
      stat(fmtNumber(latest?.totalFailures || 0), '最近日报失败') +
      stat(fmtNumber(latest?.totalDegraded || 0), '最近日报降级') +
    '</div><div class="cost-source">' +
      badge('服务层数据', 'info') +
      badge('目录 ' + (SOURCE_QUALITY.sourceQualityDir || '-'), 'gray') +
    '</div></div>' +
    '<div class="section"><h3>Endpoint 状态</h3>' + renderSourceEndpointTable(endpoints) + '</div>' +
    '<div class="section"><h3>最近质量日报</h3>' + renderSourceReportTable(SOURCE_QUALITY.reports || []) + '</div>' +
    '<div class="section"><h3>近期质量告警</h3>' + renderSourceAlertTable(SOURCE_QUALITY.alerts || []) + '</div>';
}

function renderSourceCapabilityTable(rows) {
  if (!rows.length) return '<div class="empty">暂无数据源能力声明</div>';
  const statusLabel = { ready: '可用', partial: '部分可用', missing: '缺失' };
  const statusKind = { ready: 'ok', partial: 'warn', missing: 'gray' };
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>能力</th><th>状态</th><th>证据等级</th><th>主源</th><th>Fallback</th><th>业务用途</th><th>使用边界</th><th>缺口</th><th>下一步</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td><strong>' + esc(row.name || row.key || '-') + '</strong><div class="muted mono">' + esc(row.key || '-') + '</div></td>' +
        '<td>' + badge(statusLabel[row.status] || row.status || '-', statusKind[row.status] || 'gray') + '</td>' +
        '<td>' + renderEvidenceBadge(row.evidenceLevel) + '</td>' +
        '<td class="mono">' + esc((row.primaryProviders || []).join(', ') || '-') + '</td>' +
        '<td class="mono">' + esc((row.fallbackProviders || []).join(', ') || '无') + '</td>' +
        '<td>' + esc(row.businessUse || '-') + '</td>' +
        '<td>' + esc(row.usageBoundary || '-') + '</td>' +
        '<td>' + esc((row.gaps || []).join('；') || '-') + '</td>' +
        '<td>' + esc(row.nextStep || '-') + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

function renderEvidenceBadge(level) {
  const labels = {
    primary_fact: '事实',
    secondary_evidence: '辅助证据',
    signal: '观察信号',
    operational: '运行规则',
  };
  const kinds = {
    primary_fact: 'ok',
    secondary_evidence: 'info',
    signal: 'warn',
    operational: 'gray',
  };
  return badge(labels[level] || level || '-', kinds[level] || 'gray');
}

function renderSourceEndpointTable(rows) {
  if (!rows.length) return '<div class="empty">暂无 provider 调用记录；冷启动或尚未请求行情时是正常状态。</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>Provider</th><th>Endpoint</th><th>证据等级</th><th>置信度</th><th>状态</th><th>调用</th><th>失败</th><th>连续失败</th><th>P95(ms)</th><th>最近成功</th><th>最近错误</th></tr></thead>' +
    '<tbody>' + rows.map((row) => {
      const statusKind = row.lastStatus === 'ok' ? 'ok' : (row.lastStatus === 'fail' ? 'warn' : 'gray');
      return '<tr>' +
        '<td class="mono">' + esc(row.provider || '-') + '</td>' +
        '<td class="mono">' + esc(row.endpoint || '-') + '</td>' +
        '<td>' + renderEvidenceBadge(row.evidenceLevel) + '</td>' +
        '<td>' + esc(row.confidence || '-') + '</td>' +
        '<td>' + badge(row.lastStatus || 'unknown', statusKind) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalCalls)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalFailures)) + '</td>' +
        '<td>' + esc(fmtNumber(row.consecutiveFailures)) + '</td>' +
        '<td>' + esc(row.recentLatencyP95 == null ? '-' : fmtNumber(row.recentLatencyP95)) + '</td>' +
        '<td>' + esc(fmtTime(row.lastSuccessAt)) + '</td>' +
        '<td>' + esc(row.lastError || '-') + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
}

function renderSourceReportTable(rows) {
  if (!rows.length) return '<div class="empty">暂无质量日报；每日 15:30 后生成，或等待 provider 调用后手动生成。</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>日期</th><th>事件</th><th>端点</th><th>失败</th><th>降级</th><th>最长连续失败</th><th>生成时间</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td class="mono">' + esc(row.dateKey || '-') + '</td>' +
        '<td>' + esc(fmtNumber(row.eventCount)) + '</td>' +
        '<td>' + esc(fmtNumber(row.endpointsTouched)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalFailures)) + '</td>' +
        '<td>' + esc(fmtNumber(row.totalDegraded)) + '</td>' +
        '<td>' + esc(fmtNumber(row.longestFailureStreak)) + '</td>' +
        '<td>' + esc(fmtTime(row.generatedAt)) + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

function renderSourceAlertTable(rows) {
  if (!rows.length) return '<div class="empty">暂无服务层数据源质量告警</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>时间</th><th>级别</th><th>Provider</th><th>Endpoint</th><th>User 标签</th><th>消息</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td>' + esc(fmtTime(row.created_at)) + '</td>' +
        '<td>' + badge(row.severity || '-', row.severity === 'P1' ? 'warn' : 'gray') + '</td>' +
        '<td class="mono">' + esc(row.provider || '-') + '</td>' +
        '<td class="mono">' + esc(row.endpoint || '-') + '</td>' +
        '<td class="mono">' + esc(row.userId || '-') + '</td>' +
        '<td>' + esc(row.message || '-') + '</td>' +
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

function renderAuditTimeline() {
  const root = document.getElementById('auditTimeline');
  const items = AUDIT.items || [];
  AUDIT_ITEM_BY_ID = Object.fromEntries(items.map((item) => [String(item.id), item]));
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
      renderAuditCandidateAction(item) +
      renderAuditUsage(item) +
      details +
    '</div>' +
  '</div>';
}

function renderAuditCandidateAction(item) {
  if (item.kind !== 'trace' || !item.userText) return '';
  return '<div class="ops">' +
    '<button class="btn" onclick="createCandidateFromAudit(\\'' + esc(String(item.id)) + '\\')">生成候选 case</button>' +
  '</div>';
}

async function createCandidateFromAudit(id) {
  const item = AUDIT_ITEM_BY_ID[String(id)];
  if (!item) return;
  const note = prompt('给这个候选 case 加一句备注，说明为什么值得评测。', '');
  if (note === null) return;
  const actualOutput = item.replyTextSanitized || item.replyTextRaw || item.errorMessage || '';
  try {
    await platformJson('/api/platform/evaluation/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'audit',
        sourceId: String(item.id),
        userInput: item.userText,
        actualOutput,
        scenario: 'candidate_from_audit',
        priority: item.errorMessage ? 'P0' : 'P1',
        note,
      }),
    });
    if (ACTIVE_VIEW === 'golden') await loadGoldenCases();
    alert('已生成候选 case 草稿，可在评测工作台查看。');
  } catch (error) {
    alert('生成候选 case 失败: ' + error.message);
  }
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
    const [golden, reviewQueue] = await Promise.all([
      platformJson('/api/platform/golden-cases'),
      loadEvaluationReviewQueue(),
    ]);
    GOLDEN = golden;
    EVAL_REVIEW_QUEUE = reviewQueue;
    selectedGoldenId = selectedGoldenId || GOLDEN.cases?.[0]?.id || '';
    renderGoldenFilters();
    renderGoldenWorkbench();
  } catch (error) {
    const detail = document.getElementById('goldenDetail');
    if (detail) detail.innerHTML = '<div class="error" style="display:block">评测资产加载失败: ' + esc(error.message) + '</div>';
    const overview = document.getElementById('evalAssetOverview');
    if (overview) overview.innerHTML = '<div class="error" style="display:block">评测资产加载失败: ' + esc(error.message) + '</div>';
  }
}

async function loadEvaluationReviewQueue() {
  try {
    return await platformJson('/api/platform/evaluation/review-queue');
  } catch (error) {
    return {
      ok: false,
      exists: false,
      error: error.message,
      judge: { verdict_counts: {}, review_count: 0 },
      reviewQueue: [],
      reports: [],
    };
  }
}

function setGoldenTab(tab) {
  GOLDEN_TAB = ['overview', 'review', 'cases', 'runs'].includes(tab) ? tab : 'overview';
  renderGoldenWorkbench();
}

function renderGoldenWorkbench() {
  for (const tab of ['overview', 'review', 'cases', 'runs']) {
    document.getElementById('evalTab' + tabName(tab))?.classList.toggle('active', GOLDEN_TAB === tab);
    document.getElementById('eval-view-' + tab)?.classList.toggle('active', GOLDEN_TAB === tab);
  }
  const updated = document.getElementById('goldenUpdated');
  if (updated) updated.textContent = GOLDEN.updatedAt ? '更新于 ' + fmtTime(GOLDEN.updatedAt) : '未加载';
  renderEvaluationOverview();
  renderEvaluationReviewQueue();
  renderEvaluationRunHistory();
  renderGoldenCases();
}

function tabName(tab) {
  return tab === 'overview' ? 'Overview' : tab === 'review' ? 'Review' : tab === 'cases' ? 'Cases' : 'Runs';
}

function renderEvaluationOverview() {
  const root = document.getElementById('evalOverview');
  const assets = document.getElementById('evalAssetOverview');
  if (!root || !assets) return;
  const stats = GOLDEN.stats || {};
  const tiers = stats.reviewTiers || {};
  const queue = EVAL_REVIEW_QUEUE || {};
  const verdicts = queue.judge?.verdict_counts || {};
  root.innerHTML =
    '<div class="eval-stage-list">' +
      renderEvalStage('L1 程序化评测', '确定性 contract、格式、状态机、权限、禁词、调度和推送队列。失败时直接修代码或契约。', 'npm run build · npm test · npm run eval:golden · smoke:*', 'ok') +
      renderEvalStage('L2 AI 语义评估', '真实或模拟对话跑出 actual output，再由 AI judge 按 rubric 判定 pass / warn / fail / unknown。', 'npm run eval:conversation -- --judge=model', 'info') +
      renderEvalStage('L3 人工审核', '只处理 AI judge 的 warn / fail / unknown、新核心样本和产品标准取舍。', 'Platform 评测工作台', 'warn') +
    '</div>';
  assets.innerHTML =
    '<div class="cost-summary">' +
      stat(fmtNumber(stats.total || 0), 'Case 总数') +
      stat(fmtNumber(tiers.golden_core || 0), '黄金核心') +
      stat(fmtNumber(tiers.regression || 0), '事故回归') +
      stat(fmtNumber(stats.scenarioCount || 0), '场景数') +
      stat(fmtNumber(queue.judge?.review_count || 0), '人工待审') +
    '</div>' +
    '<div class="cost-source">' +
      badge('黄金集属于 L2 case 库', 'info') +
      badge('eval:golden 是 L1 结构校验', 'ok') +
      badge(queue.exists ? ('最近评测 ' + fmtTime(queue.ranAt || queue.updatedAt)) : '尚未生成评测队列', queue.exists ? 'ok' : 'warn') +
    '</div>' +
    '<div class="section"><h3>最近 L2 Verdict</h3><div class="cost-summary">' +
      stat(fmtNumber(verdicts.pass || 0), 'Pass') +
      stat(fmtNumber(verdicts.warn || 0), 'Warn') +
      stat(fmtNumber(verdicts.fail || 0), 'Fail') +
      stat(fmtNumber(verdicts.unknown || 0), 'Unknown') +
    '</div></div>' +
    '<div class="section"><h3>当前 Case 层级</h3>' + renderTierTable(tiers) + '</div>';
}

function renderEvalStage(title, desc, command, badgeKind) {
  return '<div class="eval-stage">' +
    '<div class="eval-stage-head"><h3>' + esc(title) + '</h3>' + badge(title.slice(0, 2), badgeKind) + '</div>' +
    '<p>' + esc(desc) + '</p>' +
    '<div class="eval-command mono">' + esc(command) + '</div>' +
  '</div>';
}

function renderTierTable(tiers) {
  const rows = Object.entries(tiers || {});
  if (!rows.length) return '<div class="empty">暂无 case 层级统计</div>';
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>层级</th><th>数量</th><th>工作台含义</th></tr></thead>' +
    '<tbody>' + rows.map(([tier, count]) =>
      '<tr><td>' + esc(reviewTierLabel(tier)) + '<div class="mono">' + esc(tier) + '</div></td><td>' + esc(fmtNumber(count)) + '</td><td>' + esc(reviewTierMeaning(tier)) + '</td></tr>'
    ).join('') + '</tbody></table></div>';
}

function reviewTierMeaning(tier) {
  return ({
    golden_core: '定义产品形态和投资纪律，新增或修改后需要人工校准',
    regression: '历史事故和关键回归，L2 fail 后进入人工复核',
    principle_probe: '验证 AGENTS.md / skills 原则是否被执行',
    smoke: '基础链路样本，后续应尽量下沉到 L1',
    archived_candidate: '暂不参与常规审查的候选样本',
  })[tier] || '未分类样本';
}

function renderEvaluationReviewQueue() {
  const root = document.getElementById('evalReviewQueue');
  if (!root) return;
  const hint = document.getElementById('evalReviewHint');
  const queue = EVAL_REVIEW_QUEUE;
  if (!queue) {
    if (hint) hint.textContent = '加载中';
    root.innerHTML = '<div class="empty">正在加载评测队列...</div>';
    return;
  }
  if (!queue.exists) {
    if (hint) hint.textContent = '暂无评测结果';
    root.innerHTML =
      '<div class="cost-source">' +
        badge('尚未生成 _review-queue.json', 'warn') +
        badge('先跑 L2 对话评测', 'info') +
      '</div>' +
      '<div class="section"><h3>生成方式</h3>' +
        '<div class="eval-command mono">npm run eval:conversation -- --judge=static --only=&lt;case-id&gt;</div>' +
        '<div class="eval-command mono">npm run eval:conversation -- --judge=model --priority=P0</div>' +
        '<div class="muted" style="margin-top:8px">跑完后会生成 eval-reports/_review-queue.json 和 _review-queue.md，本页刷新后展示 warn / fail / unknown。</div>' +
      '</div>' +
      '<div class="section"><h3>核心样本校准入口</h3>' + renderManualCandidateList((GOLDEN.cases || []).filter((item) => ['golden_core', 'regression'].includes(item.reviewTier)).slice(0, 12)) + '</div>';
    return;
  }
  const rows = queue.reviewQueue || [];
  if (hint) hint.textContent = rows.length ? rows.length + ' 条待审' : '无需人工处理';
  if (!rows.length) {
    root.innerHTML =
      '<div class="cost-source">' +
        badge('最近评测全部通过', 'ok') +
        badge('run ' + (queue.runId || '-'), 'gray') +
        badge('judge ' + (queue.judge?.mode || 'none'), 'info') +
      '</div>' +
      '<div class="empty">暂无 warn / fail / unknown。人工可以只抽查黄金核心样本。</div>';
    return;
  }
  root.innerHTML =
    '<div class="cost-source">' +
      badge('run ' + (queue.runId || '-'), 'gray') +
      badge('judge ' + (queue.judge?.mode || 'none'), 'info') +
      badge('更新 ' + fmtTime(queue.ranAt || queue.updatedAt), 'ok') +
      badge('只显示 warn / fail / unknown', 'warn') +
    '</div>' +
    '<div class="section"><h3>待审项</h3>' + renderEvalReviewQueueList(rows) + '</div>';
}

function renderEvalReviewQueueList(rows) {
  return '<div class="eval-list">' + rows.map((row) => {
    const verdict = row.judge?.verdict || 'unknown';
    const decision = latestReviewDecision(row.id);
    return '<div class="eval-card" onclick="openGoldenCase(\\'' + esc(row.id || '') + '\\')">' +
      '<div class="eval-title"><strong>' + esc(row.id || '-') + '</strong>' + badge(verdict.toUpperCase(), verdictBadgeKind(verdict)) + '</div>' +
      '<div class="eval-desc">' + esc(row.judge?.reason || '-') + '</div>' +
      '<div class="eval-tags">' +
        badge(row.scenario_name || row.scenario || '-', 'gray') +
        badge((row.judge?.judge_type || '-') + (row.judge?.confidence ? ' · ' + row.judge.confidence : ''), 'info') +
        badge(String(row.elapsed_ms || 0) + 'ms', 'gray') +
        (decision ? badge(decisionLabel(decision.action), 'ok') : badge('未处理', 'warn')) +
      '</div>' +
      '<div class="section"><div class="audit-text primary">' + esc(summarizeAuditText(row.actual_output_preview || row.user_input || '-')) + '</div></div>' +
      '<div class="ops" onclick="event.stopPropagation()">' +
        renderDecisionButton(row, 'accept_judge', '接受 judge') +
        renderDecisionButton(row, 'override_pass', '改判 Pass') +
        renderDecisionButton(row, 'override_fail', '改判 Fail') +
        renderDecisionButton(row, 'needs_fix', '需要修复') +
        renderDecisionButton(row, 'move_to_l1', '下沉 L1') +
        renderDecisionButton(row, 'update_case', '更新 case') +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function latestReviewDecision(caseId) {
  const rows = EVAL_REVIEW_QUEUE?.decisions || [];
  return rows.find((item) => item.caseId === caseId) || null;
}

function decisionLabel(action) {
  return ({
    accept_judge: '已接受',
    override_pass: '改判 Pass',
    override_fail: '改判 Fail',
    needs_fix: '需修复',
    move_to_l1: '下沉 L1',
    update_case: '更新 case',
  })[action] || action || '已处理';
}

function renderDecisionButton(row, action, label) {
  return '<button class="btn" onclick="saveReviewDecision(\\'' + esc(row.id || '') + '\\', \\'' + esc(action) + '\\')">' + esc(label) + '</button>';
}

async function saveReviewDecision(caseId, action) {
  const note = prompt('处理备注，可写修复方向、改判原因或需要下沉的测试点。', '');
  if (note === null) return;
  const finalVerdict = action === 'override_pass' ? 'pass' : action === 'override_fail' ? 'fail' : '';
  try {
    const res = await platformJson('/api/platform/evaluation/review-decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId,
        action,
        finalVerdict,
        note,
        sourceRunId: EVAL_REVIEW_QUEUE?.runId || '',
      }),
    });
    EVAL_REVIEW_QUEUE.decisions = res.decisions || [];
    renderEvaluationReviewQueue();
  } catch (error) {
    alert('保存处理结果失败: ' + error.message);
  }
}

function verdictBadgeKind(verdict) {
  return verdict === 'pass' ? 'ok' : verdict === 'warn' ? 'warn' : verdict === 'fail' ? 'warn' : 'gray';
}

function renderManualCandidateList(rows) {
  if (!rows.length) return '<div class="empty">暂无核心样本</div>';
  return '<div class="eval-list">' + rows.map((item) =>
    '<div class="eval-card" onclick="openGoldenCase(\\'' + esc(item.id) + '\\')">' +
      '<div class="eval-title"><strong>' + esc(humanGoldenTitle(item)) + '</strong>' + badge(item.priority || '-', item.priority === 'P0' ? 'warn' : 'gray') + '</div>' +
      '<div class="eval-desc">' + esc(summarizeAuditText(item.userInput || item.styleNotes || item.scenario)) + '</div>' +
      '<div class="eval-tags">' + badge(reviewTierLabel(item.reviewTier), item.reviewTier === 'golden_core' ? 'ok' : 'info') + badge(scenarioLabel(item.scenario), 'gray') + '</div>' +
    '</div>'
  ).join('') + '</div>';
}

function renderCandidateCaseList() {
  const rows = EVAL_REVIEW_QUEUE?.candidates || [];
  if (!rows.length) return '<div class="empty">暂无候选 case 草稿；可在日志审计里从真实对话生成。</div>';
  return '<div class="eval-list">' + rows.map((item) =>
    '<div class="eval-card">' +
      '<div class="eval-title"><strong>' + esc(item.id || '-') + '</strong>' + badge(item.priority || 'P1', item.priority === 'P0' ? 'warn' : 'gray') + '</div>' +
      '<div class="eval-desc">' + esc(summarizeAuditText(item.userInput || '-')) + '</div>' +
      '<div class="eval-tags">' + badge(item.reviewTier || 'archived_candidate', 'gray') + badge(item.source || '-', 'info') + badge(fmtTime(item.createdAt), 'gray') + '</div>' +
      '<div class="section"><div class="audit-text">' + esc(item.note || item.actualOutput || '-') + '</div></div>' +
    '</div>'
  ).join('') + '</div>';
}

function renderEvaluationRunHistory() {
  const root = document.getElementById('evalRunHistory');
  if (!root) return;
  const rows = Object.values(GOLDEN_RUNS || {}).filter(Boolean).reverse();
  const reports = EVAL_REVIEW_QUEUE?.reports || [];
  const commandSection = renderEvalCommandBuilder();
  const candidateSection = '<div class="section"><h3>候选 Case 草稿</h3>' + renderCandidateCaseList() + '</div>';
  const reportSection = reports.length
    ? '<div class="section" style="margin-top:0"><h3>最近评测报告</h3>' + renderEvalReportTable(reports) + '</div>'
    : '<div class="section" style="margin-top:0"><h3>最近评测报告</h3><div class="empty">暂无 _review-queue.json 报告索引</div></div>';
  if (!rows.length) {
    root.innerHTML = commandSection + reportSection + candidateSection + '<div class="section"><h3>本页单条运行</h3><div class="empty">尚未运行 case；可在“黄金 Case 库”中选择单条发送。</div></div>';
    return;
  }
  root.innerHTML = commandSection + reportSection + candidateSection + '<div class="section"><h3>本页单条运行</h3><div class="eval-list">' + rows.map((row) => {
    const ok = row.ok !== false && !row.error && !row.running;
    const title = row.id || row.target?.instanceId || '运行中';
    return '<div class="eval-card" onclick="rowIdToCase(\\'' + esc(row.id || '') + '\\')">' +
      '<div class="eval-title"><strong>' + esc(title) + '</strong>' + badge(row.running ? '运行中' : ok ? '已完成' : '异常', row.running ? 'info' : ok ? 'ok' : 'warn') + '</div>' +
      '<div class="eval-desc">' + esc(row.error || row.userInput || '-') + '</div>' +
      '<div class="eval-case-id mono">' + esc(row.conversationId || '-') + '</div>' +
    '</div>';
  }).join('') + '</div></div>';
}

function renderEvalCommandBuilder() {
  const scenarios = Object.keys(GOLDEN.stats?.categories || {}).length ? [...new Set((GOLDEN.cases || []).map((item) => item.scenario).filter(Boolean))].sort() : [];
  return '<div class="section" style="margin-top:0"><h3>运行命令生成</h3>' +
    '<div class="cost-toolbar">' +
      '<div class="field"><label>Judge</label><select id="evalJudgeMode" class="select" onchange="generateEvalCommand()">' +
        '<option value="static">static</option><option value="model">model</option><option value="none">none</option>' +
      '</select></div>' +
      '<div class="field"><label>范围</label><select id="evalRunScope" class="select" onchange="generateEvalCommand()">' +
        '<option value="priority-p0">P0</option><option value="onboarding">Onboarding</option><option value="case">单条 case</option><option value="scenario">场景</option><option value="all">全部</option>' +
      '</select></div>' +
      '<div class="field"><label>Case ID</label><input id="evalRunCaseId" class="input" value="' + esc(selectedGoldenId || '') + '" oninput="generateEvalCommand()" /></div>' +
      '<div class="field"><label>Scenario</label><select id="evalRunScenario" class="select" onchange="generateEvalCommand()">' +
        scenarios.map((item) => '<option value="' + esc(item) + '">' + esc(scenarioLabel(item)) + ' · ' + esc(item) + '</option>').join('') +
      '</select></div>' +
      '<button class="btn btn-primary" onclick="generateEvalCommand()">生成命令</button>' +
      '<button class="btn" onclick="copyEvalCommand()">复制</button>' +
    '</div>' +
    '<textarea id="evalCommandOutput" class="golden-editor" style="min-height:92px" readonly></textarea>' +
    '<div class="section"><h3>对比入口</h3><div class="muted">建议先用两个不同 run id 跑同一范围，再比较两个 _review-queue.json 的 verdict 分布和待审项变化。</div>' +
      '<div class="eval-command mono">npm run eval:conversation -- --judge=static --priority=P0 --run-id=baseline</div>' +
      '<div class="eval-command mono">npm run eval:conversation -- --judge=static --priority=P0 --run-id=candidate</div>' +
    '</div>' +
  '</div>';
}

function generateEvalCommand() {
  const judge = document.getElementById('evalJudgeMode')?.value || 'static';
  const scope = document.getElementById('evalRunScope')?.value || 'priority-p0';
  const caseId = (document.getElementById('evalRunCaseId')?.value || selectedGoldenId || '').trim();
  const scenario = document.getElementById('evalRunScenario')?.value || '';
  let cmd = 'npm run eval:conversation -- --judge=' + judge;
  if (scope === 'priority-p0') cmd += ' --priority=P0';
  else if (scope === 'onboarding') cmd += ' --tag=onboarding';
  else if (scope === 'case' && caseId) cmd += ' --only=' + caseId;
  else if (scope === 'scenario' && scenario) cmd += ' --scenario=' + scenario;
  cmd += ' --run-id=' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const output = document.getElementById('evalCommandOutput');
  if (output) output.value = cmd;
}

async function copyEvalCommand() {
  generateEvalCommand();
  const value = document.getElementById('evalCommandOutput')?.value || '';
  try {
    await navigator.clipboard.writeText(value);
    alert('已复制评测命令');
  } catch {
    prompt('复制评测命令', value);
  }
}

function renderEvalReportTable(rows) {
  return '<div style="overflow:auto"><table class="cost-table">' +
    '<thead><tr><th>场景</th><th>Markdown</th><th>JSON</th></tr></thead>' +
    '<tbody>' + rows.map((row) =>
      '<tr>' +
        '<td><strong>' + esc(row.scenario_name || row.scenario || '-') + '</strong><div class="mono">' + esc(row.scenario || '-') + '</div></td>' +
        '<td class="mono">' + esc(row.mdFilename || '-') + '</td>' +
        '<td class="mono">' + esc(row.jsonFilename || '-') + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table></div>';
}

function openGoldenCase(id) {
  selectedGoldenId = id;
  GOLDEN_TAB = 'cases';
  renderGoldenWorkbench();
}

function rowIdToCase(id) {
  if (!id) return;
  openGoldenCase(id);
}

function selectedGoldenCase() {
  return (GOLDEN.cases || []).find((item) => item.id === selectedGoldenId) || (GOLDEN.cases || [])[0] || null;
}

function renderGoldenFilters() {
  const domains = Object.keys(GOLDEN.stats?.domains || {});
  const categories = Object.keys(GOLDEN.stats?.categories || {});
  const priorities = Object.keys(GOLDEN.stats?.priorities || {});
  renderGoldenTierFilter();
  if (!document.getElementById('goldenDomain') || !document.getElementById('goldenCategory') || !document.getElementById('goldenPriority')) return;
  document.getElementById('goldenDomain').innerHTML = '<option value="">全部业务域</option>' + domains.map((item) => '<option value="' + esc(item) + '">' + esc(item) + ' · ' + esc(GOLDEN.stats?.domains?.[item] || 0) + '</option>').join('');
  document.getElementById('goldenCategory').innerHTML = '<option value="">全部分类</option>' + categories.map((item) => '<option value="' + esc(item) + '">' + esc(item) + '</option>').join('');
  document.getElementById('goldenPriority').innerHTML = '<option value="">全部优先级</option>' + priorities.map((item) => '<option value="' + esc(item) + '">' + esc(item) + '</option>').join('');
}

function renderGoldenTierFilter() {
  const root = document.getElementById('goldenTierFilter');
  if (!root) return;
  const tiers = Object.keys(GOLDEN.stats?.reviewTiers || {});
  const knownOrder = ['golden_core', 'regression', 'principle_probe', 'smoke', 'archived_candidate'];
  const ordered = knownOrder.filter((tier) => tiers.includes(tier)).concat(tiers.filter((tier) => !knownOrder.includes(tier)));
  root.innerHTML = ordered.map((tier) => {
    const active = GOLDEN_ACTIVE_TIERS.has(tier) ? ' active' : '';
    const count = GOLDEN.stats?.reviewTiers?.[tier] || 0;
    return '<button class="tier-chip' + active + '" onclick="toggleGoldenTier(\\'' + esc(tier) + '\\')">' + esc(reviewTierLabel(tier)) + ' ' + esc(count) + '</button>';
  }).join('') + '<button class="tier-chip" onclick="showAllGoldenTiers()">全部</button>';
}

function toggleGoldenTier(tier) {
  if (GOLDEN_ACTIVE_TIERS.has(tier)) {
    GOLDEN_ACTIVE_TIERS.delete(tier);
  } else {
    GOLDEN_ACTIVE_TIERS.add(tier);
  }
  if (!GOLDEN_ACTIVE_TIERS.size) GOLDEN_ACTIVE_TIERS.add(tier);
  renderGoldenTierFilter();
  renderGoldenCases();
}

function showAllGoldenTiers() {
  GOLDEN_ACTIVE_TIERS = new Set(Object.keys(GOLDEN.stats?.reviewTiers || {}));
  renderGoldenTierFilter();
  renderGoldenCases();
}

function filteredGoldenCases() {
  const keyword = (document.getElementById('goldenSearch')?.value || '').trim().toLowerCase();
  const domain = document.getElementById('goldenDomain')?.value || '';
  const category = document.getElementById('goldenCategory')?.value || '';
  const priority = document.getElementById('goldenPriority')?.value || '';
  return (GOLDEN.cases || []).filter((item) => {
    if (GOLDEN_ACTIVE_TIERS.size && !GOLDEN_ACTIVE_TIERS.has(item.reviewTier)) return false;
    if (domain && item.domain !== domain) return false;
    if (category && item.category !== category) return false;
    if (priority && item.priority !== priority) return false;
    if (!keyword) return true;
    return [
      item.id,
      item.category,
      item.domain,
      item.reviewTier,
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
  const count = document.getElementById('goldenCount');
  const stats = document.getElementById('goldenStats');
  const root = document.getElementById('goldenList');
  if (!count || !stats || !root) return;
  count.textContent = (GOLDEN.stats?.total || 0) + ' 条';
  stats.innerHTML = [
    metric(cases.length, '当前显示'),
    metric((GOLDEN.stats?.reviewTiers || {}).golden_core || 0, '黄金核心'),
    metric((GOLDEN.stats?.reviewTiers || {}).regression || 0, '事故回归'),
    metric((GOLDEN.stats?.domains || {}).Onboarding || 0, 'Onboarding'),
  ].join('');
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
  const title = humanGoldenTitle(item);
  const turnLabel = (item.turnCount || 1) > 1 ? (item.turnCount || 1) + ' 轮对话' : '单轮';
  return '<div class="eval-card' + selected + '" onclick="selectGoldenCase(\\'' + esc(item.id) + '\\')">' +
    '<div class="eval-title"><strong>' + esc(title) + '</strong>' + badge(item.priority || '-', item.priority === 'P0' ? 'warn' : 'gray') + '</div>' +
    '<div class="eval-desc">' + esc(summary) + '</div>' +
    '<div class="eval-case-id mono">' + esc(item.id || '-') + '</div>' +
    '<div class="eval-tags">' +
      badge(item.domain || '其他', item.domain === 'Onboarding' ? 'warn' : 'gray') +
      badge(reviewTierLabel(item.reviewTier), item.reviewTier === 'golden_core' ? 'ok' : 'info') +
      badge(turnLabel, 'gray') +
      badge(scenarioLabel(item.scenario), 'gray') +
    '</div>' +
  '</div>';
}

function humanGoldenTitle(item) {
  const firstLine = String(item.userInput || item.styleNotes || item.scenario || item.id || '')
    .split('\\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || item.id || '未命名 case';
}

function categoryLabel(value) {
  return ({
    core_golden: '核心样本',
    principle_probe: '原则探针',
    incident_regression: '回归样本',
    safety_redline: '安全红线',
    smoke: '冒烟样本',
  })[value] || value || '-';
}

function reviewTierLabel(value) {
  return ({
    golden_core: '黄金核心',
    regression: '事故回归',
    principle_probe: '原则探针',
    smoke: '冒烟样本',
    archived_candidate: '候选归档',
  })[value] || value || '-';
}

function scenarioLabel(value) {
  const labels = {
    workspace_greeting: '开场',
    onboarding_market_watch_custom_times: 'Onboarding 盯盘时间',
    onboarding_notification_custom_times: 'Onboarding 通知偏好',
    out_of_scope_boundary: '越界拒答',
    investment_model_guided_setup: '投资模型',
    investment_model_query_empty: '投资模型',
    investment_model_freeform_draft: '投资模型',
    investment_model_plan_drafting_confirm: '模型预案',
    portfolio_add_no_plan_hint: '持仓',
    portfolio_movement_answer_composition: '持仓查询',
    portfolio_movement_natural_question: '持仓查询',
    portfolio_update_cost_confirm: '持仓修改',
    watchlist_add: '自选',
    watchlist_remove_confirm: '自选移除',
    watchlist_movement_answer_composition: '自选查询',
    watchlist_entry_condition_query: '自选买点',
    plan_trigger_answer_composition: '预案查询',
    plan_update_answer_composition: '预案更新',
    contextual_watchlist_add: '上下文写入',
    contextual_expand_latest: '上下文追问',
    contextual_write_policy_guard: '写入拦截',
    contextual_write_no_code_guessing: '上下文绑定',
    alert_set_simple_price: '提醒草案',
    alert_set_confirm_two_turn: '提醒确认',
    pending_confirmation_can_be_ambiguous: '短确认',
    alert_set_breakout_price_cancel: '提醒取消',
    alert_rules_query: '提醒查询',
    alert_near_trigger_answer_composition: '提醒查询',
    alert_invalid_answer_composition: '提醒诊断',
    alert_remove_confirm: '提醒关闭',
    strategy_list_query: '策略查询',
    strategy_plan_drafting_gate_one: '策略闸门',
    investment_style_set_confirm: '风格草案',
    methodology_set_confirm: '方法论',
    screening_methodology_overlay_draft: '选股方法',
    trading_strategy_set_confirm: '交易策略',
    trading_strategy_indicator_draft: '指标草案',
    daily_review_request: '日复盘',
    daily_review_summary_then_expand: '复盘查看',
    weekly_review_request: '周复盘',
    monthly_review_request: '月复盘',
    stock_screening_qa: '选股问答',
    stock_screening_ambiguous: '选股澄清',
  };
  return labels[value] || '其他场景';
}

function selectGoldenCase(id) {
  selectedGoldenId = id;
  renderGoldenCases();
}

function goldenRunResult(id) {
  return GOLDEN_RUNS[id] || null;
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
      '<dt>业务域</dt><dd>' + esc(item.domain || '其他') + '</dd>' +
      '<dt>审查层级</dt><dd>' + esc(reviewTierLabel(item.reviewTier)) + ' · ' + esc(item.priority || '-') + '</dd>' +
      '<dt>原始分类</dt><dd>' + esc(categoryLabel(item.category)) + '</dd>' +
      '<dt>标签</dt><dd>' + esc((item.tags || []).join(', ') || '-') + '</dd>' +
      '<dt>轮数</dt><dd>' + esc(item.turnCount || 1) + '</dd>' +
    '</dl>' +
    '<div class="section"><h3>原则</h3>' + auditSection('Principles', (item.principles || []).map((line) => '- ' + line).join('\\n') || '-') + '</div>' +
    '<div class="section"><h3>单条运行</h3>' +
      '<div class="ops">' +
        '<button id="goldenRunBtn" class="btn btn-primary" onclick="runGoldenCase()">发送到主用户投资助手</button>' +
        '<button class="btn" onclick="setView(\\'audit\\')">查看审计</button>' +
      '</div>' +
      '<div id="goldenRunError" class="error" style="display:none;margin-top:10px"></div>' +
      '<div id="goldenRunResult">' + renderGoldenRunResult(item) + '</div>' +
    '</div>' +
    '<div class="section"><h3>编辑 YAML</h3><textarea id="goldenRawEditor" class="golden-editor">' + esc(item.rawYaml || '') + '</textarea></div>' +
    '<div id="goldenSaveError" class="error" style="display:none"></div>' +
    '<div class="ops">' +
      '<button class="btn btn-primary" onclick="saveGoldenCase()">保存这条 case</button>' +
      '<button class="btn" onclick="renderGoldenDetail()">放弃修改</button>' +
    '</div>';
}

function renderGoldenRunResult(item) {
  const result = goldenRunResult(item.id);
  if (!result) return '<div class="empty">尚未运行。点击后会通过微信入站链路发送 case 的 user_input。</div>';
  if (result.running) return '<div class="empty">正在发送并等待回复...</div>';
  if (result.error) return '<div class="error" style="display:block;margin-top:10px">' + esc(result.error) + '</div>';
  return '<div class="section">' +
    '<dl class="kv">' +
      '<dt>目标</dt><dd>' + esc(result.target?.name || result.target?.instanceId || '-') + ' · <span class="mono">' + esc(result.target?.instanceId || '-') + '</span></dd>' +
      '<dt>耗时</dt><dd>' + esc(result.elapsedMs || 0) + 'ms</dd>' +
      '<dt>会话</dt><dd class="mono">' + esc(result.conversationId || '-') + '</dd>' +
      '<dt>输入</dt><dd>' + esc(result.userInput || '-') + '</dd>' +
    '</dl>' +
    auditSection('助手回复', result.text || '-', 'primary') +
  '</div>';
}

async function runGoldenCase() {
  const item = selectedGoldenCase();
  if (!item) return;
  GOLDEN_RUNS[item.id] = { running: true };
  renderGoldenDetail();
  try {
    const result = await platformJson('/api/platform/golden-cases/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, instanceId: 'invest-agent-primary' }),
    });
    GOLDEN_RUNS[item.id] = result;
  } catch (error) {
    GOLDEN_RUNS[item.id] = { error: error.message };
  }
  renderEvaluationRunHistory();
  renderEvaluationReviewQueue();
  renderGoldenDetail();
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

window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
renderChrome();
loadPlatform();
</script>
</body>
</html>`;
}
