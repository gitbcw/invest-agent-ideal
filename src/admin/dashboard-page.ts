export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invest Agent</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { theme: { extend: { colors: {
      panel: '#ffffff', surface: '#f8fafc', border: '#d9e0ea',
    }}}}
  </script>
  <style>
    body { background: #f5f7fb; color: #1f2937; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

    /* ─── Sidebar ─── */
    .sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 220px;
      background: #ffffff; border-right: 1px solid #d9e0ea;
      display: flex; flex-direction: column; z-index: 50;
      transition: transform .25s;
    }
    .sidebar-brand { padding: 20px 18px 16px; font-size: 16px; font-weight: 700; color: #111827; letter-spacing: 0; }
    .sidebar-brand small { display: block; font-size: 11px; font-weight: 400; color: #64748b; margin-top: 4px; }
    .sidebar nav { flex: 1; overflow-y: auto; padding: 0 8px 16px; }
    .sidebar nav a {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; border-radius: 6px; font-size: 13px;
      color: #475569; cursor: pointer; text-decoration: none; transition: all .15s;
    }
    .sidebar nav a:hover { background: #eef4ff; color: #1d4ed8; }
    .sidebar nav a.active { background: #dbeafe; color: #1d4ed8; font-weight: 600; }
    .sidebar nav a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    .sidebar-divider { height: 1px; background: #e2e8f0; margin: 8px 12px; }
    .sidebar-label { font-size: 11px; color: #94a3b8; padding: 8px 12px 4px; text-transform: uppercase; letter-spacing: .5px; }

    /* ─── Main ─── */
    .main { margin-left: 220px; min-height: 100vh; }
    .main-inner { max-width: 1100px; margin: 0 auto; padding: 24px 20px 32px; }
    .page { display: none; }
    .page.active { display: block; }

    /* ─── Mobile ─── */
    .mobile-header {
      display: none; position: sticky; top: 0; z-index: 40;
      background: #ffffff; border-bottom: 1px solid #d9e0ea;
      padding: 12px 16px; align-items: center; gap: 12px;
    }
    .mobile-header .brand { font-size: 15px; font-weight: 700; color: #111827; }
    .menu-btn { background: none; border: none; color: #475569; font-size: 22px; cursor: pointer; padding: 0 4px; }
    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 45; }

    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); }
      .sidebar-overlay.open { display: block; }
      .main { margin-left: 0; }
      .mobile-header { display: flex; }
    }

    /* ─── Components ─── */
    .card { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .card-header { padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e2e8f0; background: #fbfdff; }
    .card-header h2 { font-size: 14px; font-weight: 600; color: #111827; margin: 0; }
    .card-body { padding: 16px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .badge-red { background: #fff1f2; color: #9f1239; }
    .badge-yellow { background: #fef3c7; color: #92400e; }
    .badge-info { background: #dbeafe; color: #1d4ed8; }
    .toggle { width: 36px; height: 20px; border-radius: 10px; position: relative; display: inline-block; cursor: pointer; }
    .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .toggle-on { background: #059669; }
    .toggle-on::after { transform: translateX(16px); }
    .toggle-off { background: #cbd5e1; }
    .toggle-off::after { transform: translateX(0); }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 12px; color: #64748b; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
    td { padding: 8px; font-size: 13px; color: #334155; border-bottom: 1px solid #edf2f7; }
    tr:last-child td { border-bottom: none; }
    .empty-hint { color: #94a3b8; font-size: 13px; padding: 24px; text-align: center; }
    .btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; transition: background .15s; border: none; }
    .btn-blue { background: #2563eb; color: #fff; }
    .btn-blue:hover { background: #1d4ed8; }
    .btn-red { background: #991b1b; color: #fca5a5; }
    .btn-red:hover { background: #7f1d1d; }
    .btn-gray { background: #ffffff; color: #1f2937; border: 1px solid #cbd5e1; }
    .btn-gray:hover { background: #f1f5f9; }
    .btn-green { background: #16a34a; color: #fff; }
    .btn-green:hover { background: #15803d; }
    .btn-amber { background: #d97706; color: #fff; }
    .btn-amber:hover { background: #b45309; }
    .inline-form { display: none; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px; }
    .inline-form.active { display: block; }
    .form-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
    .form-row:last-child { margin-bottom: 0; }
    .form-label { font-size: 12px; color: #64748b; min-width: 50px; }
    .form-input { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px 8px; font-size: 13px; color: #1f2937; outline: none; }
    .form-input:focus { border-color: #2563eb; }
    .form-input-sm { width: 80px; }
    .form-input-md { width: 120px; }
    .form-input-wide { flex: 1; min-width: 140px; }
    .form-select { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px 8px; font-size: 13px; color: #1f2937; outline: none; }
    .toast { position: fixed; top: 20px; right: 20px; padding: 10px 16px; border-radius: 8px; font-size: 13px; z-index: 1000; opacity: 0; transition: opacity .3s; pointer-events: none; }
    .toast.show { opacity: 1; }
    .toast-ok { background: #065f46; color: #6ee7b7; }
    .toast-err { background: #7f1d1d; color: #fca5a5; }
    .edit-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.32); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .edit-modal { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 20px; width: 420px; max-width: 90vw; box-shadow: 0 20px 80px rgba(15,23,42,.18); }
    .muted { color: #64748b; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .cell-main { color: #111827; font-weight: 600; }
    .cell-sub { color: #64748b; font-size: 12px; margin-top: 2px; word-break: break-word; }
    .compact-list { display: flex; flex-direction: column; gap: 4px; }
    .condition-line { color: #334155; font-size: 12px; line-height: 1.45; }
    .condition-line strong { color: #111827; font-weight: 600; }
    .filter-bar { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 12px; margin-bottom: 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .filter-field { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
    .filter-field-wide { flex: 1; min-width: 220px; }
    .filter-field label { font-size: 11px; color: #64748b; }
    .date-group { margin-bottom: 18px; }
    .date-group-header { display: flex; align-items: center; gap: 8px; color: #64748b; font-size: 12px; font-weight: 600; margin: 10px 2px 8px; cursor: pointer; user-select: none; }
    .date-group-header .line { height: 1px; background: #e2e8f0; flex: 1; }
    .conversation-preview { color: #334155; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 620px; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-card { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 16px; text-align: center; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .stat-card .value { font-size: 24px; font-weight: 700; color: #0f172a; }
    .stat-card .value small { font-size: 13px; color: #64748b; font-weight: 400; margin-left: 2px; }
    .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
    .workbench-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .workbench-tile { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .workbench-tile .tile-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
    .workbench-tile .tile-value { font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.2; }
    .workbench-tile .tile-note { font-size: 12px; color: #64748b; margin-top: 6px; line-height: 1.45; }
    .workbench-list { display: flex; flex-direction: column; gap: 10px; }
    .workbench-item { border-bottom: 1px solid #edf2f7; padding-bottom: 10px; }
    .workbench-item:last-child { border-bottom: none; padding-bottom: 0; }
    .reader-layout { display: grid; grid-template-columns: 280px 1fr; gap: 14px; align-items: start; }
    .review-list { display: flex; flex-direction: column; gap: 8px; }
    .review-list button { text-align: left; background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 10px; cursor: pointer; color: #334155; }
    .review-list button.active { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
    .review-reader { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; min-height: 420px; }
    .review-reader-header { padding: 14px 16px; border-bottom: 1px solid #e2e8f0; background: #fbfdff; }
    .review-reader-body { padding: 18px; color: #1f2937; font-size: 14px; line-height: 1.75; white-space: pre-wrap; word-break: break-word; }
    .viewpoint-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .viewpoint-card { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .viewpoint-card .vp-title { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .viewpoint-card .vp-body { color: #334155; font-size: 13px; line-height: 1.55; }
    .viewpoint-card .vp-meta { color: #64748b; font-size: 12px; margin-top: 10px; }
    .section-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .wx-status-grid { display: grid; grid-template-columns: 100px 1fr; gap: 8px 12px; font-size: 13px; }
    .wx-status-grid dt { color: #64748b; }
    .wx-status-grid dd { color: #334155; margin: 0; word-break: break-all; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { font-size: 18px; font-weight: 700; color: #111827; margin: 0; }
    .page-header .meta { font-size: 12px; color: #64748b; }
    .action-log { white-space: pre-wrap; word-break: break-word; background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; max-height: 200px; overflow: auto; font-size: 12px; font-family: monospace; }
    .qr-area { margin-top: 12px; }
    .qr-area img { width: min(220px, 60vw); height: min(220px, 60vw); border: 1px solid #d9e0ea; border-radius: 8px; background: #fff; }
    .wx-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .context-bar { background: #ffffff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; margin-bottom: 16px; display: grid; grid-template-columns: 1fr auto; gap: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .context-title { color: #111827; font-size: 16px; font-weight: 700; margin: 0 0 5px; }
    .context-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; color: #64748b; font-size: 12px; }
    .context-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; justify-content: flex-end; }
    .context-controls .filter-field { min-width: 170px; }
    .debug-context { color: #94a3b8; font-size: 11px; margin-top: 8px; }
    @media (max-width: 980px) {
      .context-bar { grid-template-columns: 1fr; }
      .context-controls { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>
  <div id="modal-root"></div>

  <!-- Mobile header -->
  <div class="mobile-header">
    <button class="menu-btn" onclick="toggleSidebar()">&#9776;</button>
    <span class="brand">Invest Agent</span>
  </div>
  <div id="sidebarOverlay" class="sidebar-overlay" onclick="toggleSidebar()"></div>

  <!-- Sidebar -->
  <aside id="sidebar" class="sidebar">
    <div class="sidebar-brand">Invest Agent<small>投资决策助手</small></div>
    <nav>
      <a data-page="overview" class="active" onclick="switchPage('overview')"><span class="nav-icon">&#9632;</span> 总览</a>
      <a data-page="holdings" onclick="switchPage('holdings')"><span class="nav-icon">&#9638;</span> 持仓池</a>
      <a data-page="watchlist" onclick="switchPage('watchlist')"><span class="nav-icon">&#9638;</span> 自选池</a>
      <a data-page="plans" onclick="switchPage('plans')"><span class="nav-icon">&#9638;</span> 交易预案</a>
      <a data-page="indicators" onclick="switchPage('indicators')"><span class="nav-icon">&#9638;</span> 指标库</a>
      <a data-page="rule-system" onclick="switchPage('rule-system')"><span class="nav-icon">&#9638;</span> 提醒规则</a>
      <a data-page="indicator-results" onclick="switchPage('indicator-results')"><span class="nav-icon">&#9638;</span> 指标快照</a>
      <a data-page="events" onclick="switchPage('events')"><span class="nav-icon">&#9638;</span> 提醒事件</a>
      <a data-page="reviews" onclick="switchPage('reviews')"><span class="nav-icon">&#9638;</span> 复盘阅读</a>
      <a data-page="viewpoints" onclick="switchPage('viewpoints')"><span class="nav-icon">&#9638;</span> 观点追踪</a>
      <a data-page="conversations" onclick="switchPage('conversations')"><span class="nav-icon">&#9638;</span> 对话记录</a>
      <div class="sidebar-divider"></div>
      <div class="sidebar-label">设置</div>
      <a data-page="signals" onclick="switchPage('signals')"><span class="nav-icon">&#9881;</span> 信号配置</a>
      <a data-page="patrol" onclick="switchPage('patrol')"><span class="nav-icon">&#9881;</span> 巡检设置</a>
    </nav>
  </aside>

  <!-- Main content -->
  <div class="main">
    <div class="main-inner">
      <div class="context-bar">
        <div>
          <p class="context-title" id="contextTitle">投资助手实例</p>
          <div class="context-meta">
            <span class="badge badge-info" id="contextStatus">加载中</span>
            <span id="contextOwner">绑定用户 -</span>
            <span id="contextSkill">Skill -</span>
          </div>
          <div class="debug-context" id="userContextHint" hidden>userId=primary</div>
        </div>
        <div class="context-controls">
          <div class="filter-field">
            <label>用户</label>
            <select class="form-select" id="userSelect" onchange="switchUser(this.value)">
              <option value="primary">默认测试用户</option>
            </select>
          </div>
          <div class="filter-field filter-field-wide">
            <label>投资助手</label>
            <select class="form-select" id="instanceSelect" onchange="switchInstance(this.value)">
              <option value="invest-agent-primary">默认测试投资助手</option>
            </select>
          </div>
        </div>
      </div>

      <!-- ═══════ 总览 ═══════ -->
      <section id="page-overview" class="page active">
        <div class="page-header">
          <div>
            <h1>投资工作台</h1>
            <div class="meta" id="updateTime">加载中...</div>
          </div>
          <button class="btn btn-blue" onclick="loadData()">刷新</button>
        </div>
        <div id="workbenchStrip" class="workbench-strip"></div>
        <div id="summaryCards" class="stat-grid"></div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" id="overviewGrid"></div>
      </section>

      <!-- ═══════ 持仓池 ═══════ -->
      <section id="page-holdings" class="page">
        <div class="page-header">
          <h1>持仓池 <span id="holdingCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
          <div class="section-actions">
            <button class="btn btn-blue" onclick="toggleForm('addHoldingForm')">+ 添加股票</button>
            <button class="btn btn-gray" onclick="loadData()">刷新</button>
          </div>
        </div>
        <div id="addHoldingForm" class="inline-form">
          <div class="form-row">
            <span class="form-label">名称/代码</span>
            <input class="form-input form-input-md" id="addHoldingInput" placeholder="如：宁德时代 或 300750" onkeydown="if(event.key==='Enter')doAddHolding()" />
            <span class="form-label">成本价</span>
            <input class="form-input" id="addHoldingCostInput" placeholder="可选，如 70.5" onkeydown="if(event.key==='Enter')doAddHolding()" style="width:120px" />
            <button class="btn btn-green" onclick="doAddHolding()">添加</button>
            <button class="btn btn-gray" onclick="toggleForm('addHoldingForm')">取消</button>
          </div>
          <div class="form-row" style="color:#94a3b8;font-size:12px">成本价只记录每股单价,用于算浮亏比例;数量与金额不存。</div>
        </div>
        <div class="card"><div class="card-body" id="holdingsTable"><div class="empty-hint">暂无持仓</div></div></div>
      </section>

      <!-- ═══════ 自选池 ═══════ -->
      <section id="page-watchlist" class="page">
        <div class="page-header">
          <h1>自选池 <span id="watchlistCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
          <div class="section-actions">
            <button class="btn btn-blue" onclick="toggleForm('addWatchlistForm')">+ 添加自选</button>
            <button class="btn btn-gray" onclick="loadData()">刷新</button>
          </div>
        </div>
        <div id="addWatchlistForm" class="inline-form">
          <div class="form-row">
            <span class="form-label">名称/代码</span>
            <input class="form-input form-input-md" id="addWatchlistInput" placeholder="如：阳光电源 或 300274" onkeydown="if(event.key==='Enter')doAddWatchlist()" />
            <span class="form-label">理由</span>
            <input class="form-input form-input-wide" id="addWatchlistReason" placeholder="可选" onkeydown="if(event.key==='Enter')doAddWatchlist()" />
            <button class="btn btn-green" onclick="doAddWatchlist()">添加</button>
            <button class="btn btn-gray" onclick="toggleForm('addWatchlistForm')">取消</button>
          </div>
        </div>
        <div class="card"><div class="card-body" id="watchlistTable"><div class="empty-hint">暂无自选股</div></div></div>
      </section>

      <!-- ═══════ 交易预案 ═══════ -->
      <section id="page-plans" class="page">
        <div class="page-header">
          <h1>交易预案 <span id="planCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
          <div class="section-actions">
            <button class="btn btn-blue" onclick="showPlanModal()">+ 新建预案</button>
            <button class="btn btn-gray" onclick="loadData()">刷新</button>
          </div>
        </div>
        <div class="card"><div class="card-body" id="plansTable"><div class="empty-hint">暂无交易预案</div></div></div>
      </section>

      <!-- ═══════ 指标库 ═══════ -->
      <section id="page-indicators" class="page">
        <div class="page-header">
          <div>
            <h1>指标库 <span id="indicatorCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
            <div class="meta">指标定义负责“怎么算”，提醒规则负责“什么时候提醒”。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="card"><div class="card-body" id="indicatorsTable"><div class="empty-hint">暂无指标定义</div></div></div>
      </section>

      <!-- ═══════ 提醒规则 ═══════ -->
      <section id="page-rule-system" class="page">
        <div class="page-header">
          <div>
            <h1>提醒规则 <span id="upgradedRuleCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
            <div class="meta">提醒规则负责“什么时候提醒”：股票、指标、条件、去重策略和预案关系在这里统一查看。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="card"><div class="card-body" id="upgradedRulesTable"><div class="empty-hint">暂无提醒规则</div></div></div>
      </section>

      <!-- ═══════ 指标快照 ═══════ -->
      <section id="page-indicator-results" class="page">
        <div class="page-header">
          <div>
            <h1>指标快照 <span id="indicatorResultCount" class="badge badge-yellow" style="vertical-align:middle">0</span></h1>
            <div class="meta">指标快照是巡检触发时的计算依据；提醒事件是实际生成给用户看的提醒记录。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="card"><div class="card-body" id="indicatorResultsTable"><div class="empty-hint">暂无指标快照</div></div></div>
      </section>

      <!-- ═══════ 提醒事件 ═══════ -->
      <section id="page-events" class="page">
        <div class="page-header">
          <h1>提醒事件 <span id="eventCount" class="badge badge-yellow" style="vertical-align:middle">0</span></h1>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div id="recentEvents"><div class="empty-hint">暂无提醒事件</div></div>
      </section>

      <!-- ═══════ 复盘阅读 ═══════ -->
      <section id="page-reviews" class="page">
        <div class="page-header">
          <div>
            <h1>复盘阅读</h1>
            <div class="meta">微信只推摘要，完整复盘在这里阅读和追溯。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div id="recentPlans"><div class="empty-hint">暂无复盘记录</div></div>
      </section>

      <!-- ═══════ 观点追踪 ═══════ -->
      <section id="page-viewpoints" class="page">
        <div class="page-header">
          <div>
            <h1>观点追踪 <span id="viewpointCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
            <div class="meta">把复盘里的判断变成后续可验证的闭环，不让结论消失在聊天里。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="filter-bar">
          <div class="filter-field">
            <label for="viewpointStatusFilter">状态</label>
            <select class="form-select" id="viewpointStatusFilter" onchange="renderViewpoints()">
              <option value="">全部</option>
              <option value="due">到期待验证</option>
              <option value="open">观察中</option>
              <option value="validated">已验证</option>
              <option value="invalidated">已失效</option>
            </select>
          </div>
          <div class="filter-field filter-field-wide">
            <label for="viewpointKeywordFilter">关键词</label>
            <input class="form-input" id="viewpointKeywordFilter" placeholder="股票、行业、观点内容..." oninput="renderViewpoints()" />
          </div>
          <button class="btn btn-gray" onclick="resetViewpointFilters()">重置</button>
        </div>
        <div id="viewpointList"><div class="empty-hint">暂无观点记录</div></div>
      </section>

      <!-- ═══════ 对话记录 ═══════ -->
      <section id="page-conversations" class="page">
        <div class="page-header">
          <div>
            <h1>对话记录 <span id="conversationCount" class="badge badge-green" style="vertical-align:middle">0</span></h1>
            <div class="meta">展示微信助手与用户之间的最近对话；内部提示词和原始调试输出不在这里展示。</div>
          </div>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="filter-bar">
          <div class="filter-field">
            <label for="conversationDateFilter">日期</label>
            <input class="form-input" id="conversationDateFilter" type="date" onchange="renderConversations()" />
          </div>
          <div class="filter-field">
            <label for="conversationModeFilter">类型</label>
            <select class="form-select" id="conversationModeFilter" onchange="renderConversations()">
              <option value="">全部</option>
              <option value="chat">普通对话</option>
              <option value="daily-review">日复盘</option>
              <option value="daily-review-ack">日复盘回执</option>
              <option value="daily-review-push">日复盘推送</option>
              <option value="screening">选股问答</option>
            </select>
          </div>
          <div class="filter-field">
            <label for="conversationStatusFilter">状态</label>
            <select class="form-select" id="conversationStatusFilter" onchange="renderConversations()">
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="timeout">超时</option>
              <option value="error">失败</option>
            </select>
          </div>
          <div class="filter-field filter-field-wide">
            <label for="conversationKeywordFilter">关键词</label>
            <input class="form-input" id="conversationKeywordFilter" placeholder="股票名、代码、复盘、加入自选..." oninput="renderConversations()" />
          </div>
          <button class="btn btn-gray" onclick="resetConversationFilters()">重置</button>
        </div>
        <div id="conversationList"><div class="empty-hint">暂无对话记录</div></div>
      </section>

      <!-- ═══════ 信号配置 ═══════ -->
      <section id="page-signals" class="page">
        <div class="page-header">
          <h1>信号配置</h1>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="card"><div class="card-body" id="signalsTable"></div></div>
      </section>

      <!-- ═══════ 规则巡检设置 ═══════ -->
      <section id="page-patrol" class="page">
        <div class="page-header">
          <h1>规则巡检设置</h1>
          <button class="btn btn-gray" onclick="loadData()">刷新</button>
        </div>
        <div class="card">
          <div class="card-body">
            <div class="form-row">
              <span class="form-label">规则巡检间隔</span>
              <input class="form-input form-input-sm" id="patrolInterval" type="number" min="1" placeholder="分钟" />
              <span class="text-sm text-gray-500">分钟</span>
              <button class="btn btn-green" onclick="doSetInterval()">保存</button>
            </div>
            <p class="text-xs text-gray-500 mt-2">设置明确规则巡检的采样间隔，单位为分钟。盘中定时简报时间不在这里配置。</p>
          </div>
        </div>
        <div class="card mt-4">
          <div class="card-header"><h2>ACP Backend</h2></div>
          <div class="card-body">
            <div class="form-row">
              <span class="form-label">推理后端</span>
              <select class="form-input form-input-sm" id="acpBackendSelect" style="min-width:200px">
              <option value="hermes">Hermes</option>
              <option value="codex">Codex</option>
              </select>
              <button class="btn btn-blue" onclick="doSwitchAcpBackend()">切换</button>
              <span id="acpBackendBadge" class="badge badge-gray">loading</span>
            </div>
            <div id="acpBackendStatus" class="text-xs text-gray-500 mt-3"></div>
            <p class="text-xs text-gray-500 mt-2">切换后会重启当前 ACP 子进程。</p>
          </div>
        </div>
        <div class="card mt-4">
          <div class="card-header"><h2>手动操作</h2></div>
          <div class="card-body">
            <div class="section-actions">
              <button class="btn btn-amber" onclick="doCheckAlerts()">立即规则巡检</button>
              <button class="btn btn-blue" onclick="doMockAlert()">模拟触发</button>
            </div>
            <p class="text-xs text-gray-500 mt-2">立即规则巡检会强制执行一次提醒/规则检查并推送命中结果。模拟触发会发送一条测试提醒。</p>
          </div>
        </div>
      </section>

      <!-- ═══════ 微信连接 ═══════ -->
      <section id="page-weixin" class="page">
        <div class="page-header">
          <h1>微信连接</h1>
          <div class="section-actions">
            <span id="wxStageBadge" class="badge badge-gray">loading</span>
          </div>
        </div>
        <div class="card mb-4">
          <div class="card-header"><h2>操作</h2></div>
          <div class="card-body">
            <div class="wx-btns">
              <button class="btn btn-blue" id="wxConnectBtn" onclick="wxConnect()">连接微信</button>
              <button class="btn btn-gray" id="wxListenBtn" onclick="wxListen()">启动监听</button>
              <button class="btn btn-gray" id="wxTestBtn" onclick="wxTestPush()">测试提醒</button>
              <button class="btn btn-red" id="wxStopBtn" onclick="wxStop()">断开连接</button>
            </div>
            <div id="wxQrWrap" class="qr-area" style="display:none">
              <p class="text-xs text-gray-500 mt-3 mb-2">请使用客户微信扫描二维码，并在微信中确认登录。</p>
              <img id="wxQrImg" alt="微信登录二维码" />
              <p id="wxQrLink" class="text-xs text-gray-500 mt-2" style="word-break:break-all"></p>
            </div>
          </div>
        </div>
        <div class="card mb-4">
          <div class="card-header"><h2>状态</h2></div>
          <div class="card-body">
            <dl class="wx-status-grid">
              <dt>连接阶段</dt><dd id="wxStage">-</dd>
              <dt>账号</dt><dd id="wxAccountId">-</dd>
              <dt>监听状态</dt><dd id="wxListener">-</dd>
              <dt>提醒推送</dt><dd id="wxPushReady">-</dd>
              <dt>最近会话</dt><dd id="wxLastConversation">-</dd>
              <dt>提示</dt><dd id="wxMessage">-</dd>
              <dt>更新时间</dt><dd id="wxUpdatedAt">-</dd>
              <dt>错误</dt><dd id="wxLastError">-</dd>
            </dl>
          </div>
        </div>
        <div class="card mb-4">
          <div class="card-header"><h2>使用示例</h2></div>
          <div class="card-body">
            <p class="text-xs text-gray-500 mb-2">连接成功后，用另一个微信给该账号发送：</p>
            <div class="action-log" style="max-height:120px">我的持仓
自选列表
买入 000001 10.50 100
每日复盘</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>操作日志</h2></div>
          <div class="card-body">
            <div id="wxActionLog" class="action-log">-</div>
          </div>
        </div>
      </section>

    </div>

    <footer style="text-align:center;font-size:11px;color:#4b5563;padding:16px;">Invest Agent Experimental MVP &mdash; 数据仅供参考，不构成投资建议</footer>
  </div>

<script>
// ─── Global State ───
let D = {};
const initialParams = new URLSearchParams(window.location.search);
let currentUserId = initialParams.get('userId') || 'primary';
let currentInstanceId = initialParams.get('instanceId') || 'invest-agent-primary';
let wxPollTimer = null;
let wxLastQr = '';
let conversationRows = [];

// ─── Navigation ───
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === name));
  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}

// ─── Data Loading ───
async function loadData() {
  try {
    const res = await fetch('/api/dashboard?userId=' + encodeURIComponent(currentUserId) + '&instanceId=' + encodeURIComponent(currentInstanceId));
    D = await res.json();
    render(D);
  } catch (e) {
    document.getElementById('updateTime').textContent = '加载失败: ' + e.message;
  }
}

function render(data) {
  D = data;
  const s = data.summary;
  renderUserSelector(data.users || [], data.userId || currentUserId);
  renderInstanceSelector(data.instances || [], data.instanceId || currentInstanceId, data.currentInstance);
  renderContextHeader(data);
  document.getElementById('updateTime').textContent = '更新于 ' + new Date(data.updatedAt).toLocaleString('zh-CN');

  // Summary cards
  renderWorkbenchStrip();
  document.getElementById('summaryCards').innerHTML = [
    statCard('监控股票', s.holdingCount + s.watchlistCount, '只'),
    statCard('交易预案', s.planCount, '个'),
    statCard('提醒规则', s.alertRuleCount, '条'),
    statCard('指标库', s.indicatorCount || (data.indicators || []).length, '个'),
    statCard('今日提醒', s.todayEventCount, '次'),
    statCard('对话记录', s.conversationCount || (data.recentConversations || []).length, '条'),
    statCard('巡检间隔', s.intervalMinutes, '分钟'),
    statCard('信号开关', data.signals.filter(x => x.enabled).length + '/' + data.signals.length, ''),
  ].join('');

  // Overview grid: compact preview cards
  renderOverviewGrid();

  // Detailed pages
  renderHoldingsTable();
  renderWatchlistTable();
  renderPlansTable();
  renderIndicatorsTable();
  renderUpgradedRulesTable();
  renderIndicatorResultsTable();
  renderSignalsTable(data.signals);
  renderEventBatches(data.eventBatches || []);
  renderRecentPlans(data.recentPlans);
  renderViewpoints();
  conversationRows = data.recentConversations || [];
  renderConversations();

  // Patrol interval
  const pi = document.getElementById('patrolInterval');
  if (pi && !pi.matches(':focus')) pi.value = s.intervalMinutes;

  // ACP backends
  loadAcpBackends();
}

function renderUserSelector(users, userId) {
  currentUserId = userId || currentUserId || 'primary';
  localStorage.setItem('investAgentUserId', currentUserId);
  const select = document.getElementById('userSelect');
  if (select) {
    const investOwnerIds = new Set((D.instances || []).map((i) => i.ownerUserId).filter(Boolean));
    investOwnerIds.add(currentUserId);
    const investUsers = users.filter((u) => investOwnerIds.has(u.id));
    const existing = new Set(investUsers.map(u => u.id));
    const normalizedUsers = existing.has(currentUserId)
      ? investUsers
      : [{ id: currentUserId, displayName: currentUserId, status: 'active' }, ...investUsers];
    select.innerHTML = normalizedUsers.map(u => '<option value="' + esc(u.id) + '">' + H(u.displayName || u.id) + ' (' + H(u.id) + ')</option>').join('');
    select.value = currentUserId;
  }
  const hint = document.getElementById('userContextHint');
  if (hint) hint.textContent = 'projectId=' + (D.projectId || 'invest-agent') + ' · instanceId=' + (D.instanceId || currentInstanceId) + ' · userId=' + currentUserId;
}

function renderInstanceSelector(instances, instanceId, currentInstance) {
  currentInstanceId = instanceId || currentInstanceId || 'invest-agent-primary';
  localStorage.setItem('investAgentInstanceId', currentInstanceId);
  const select = document.getElementById('instanceSelect');
  if (select) {
    const existing = new Set(instances.map(i => i.id));
    const normalized = existing.has(currentInstanceId)
      ? instances
      : [{ id: currentInstanceId, name: currentInstance?.name || currentInstanceId, projectId: currentInstance?.projectId || 'invest-agent', status: 'active' }, ...instances];
    select.innerHTML = normalized.map(i => '<option value="' + esc(i.id) + '">' + H(i.name || i.id) + ' (' + H(i.id) + ')</option>').join('');
    select.value = currentInstanceId;
  }
  const hint = document.getElementById('userContextHint');
  if (hint) hint.textContent = 'projectId=' + (D.projectId || 'invest-agent') + ' · instanceId=' + currentInstanceId + ' · userId=' + currentUserId;
}

function renderContextHeader(data) {
  const instance = data.currentInstance || {};
  const projectType = data.projectType || {};
  const title = document.getElementById('contextTitle');
  const owner = document.getElementById('contextOwner');
  const skill = document.getElementById('contextSkill');
  const status = document.getElementById('contextStatus');
  if (title) title.textContent = instance.name || projectType.displayName || '投资助手实例';
  if (owner) owner.textContent = '绑定用户 ' + displayUserName(data.userId);
  if (skill) skill.textContent = 'Skill ' + (data.skillBundleId || instance.skillBundleId || '-');
  if (status) {
    const value = instance.status || 'active';
    status.textContent = value;
    status.className = 'badge ' + (value === 'active' ? 'badge-green' : 'badge-gray');
  }
}

function displayUserName(userId) {
  const user = (D.users || []).find((item) => item.id === userId);
  return user ? ((user.displayName || user.id) + ' (' + user.id + ')') : (userId || '-');
}

function syncUrlContext() {
  const url = new URL(window.location.href);
  url.searchParams.set('userId', currentUserId);
  url.searchParams.set('instanceId', currentInstanceId);
  window.history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
}

function switchUser(userId) {
  currentUserId = userId || 'primary';
  localStorage.setItem('investAgentUserId', currentUserId);
  const match = (D.instances || []).find((item) => item.ownerUserId === currentUserId);
  currentInstanceId = match?.id || (currentUserId === 'primary' ? 'invest-agent-primary' : 'invest-agent-' + currentUserId);
  localStorage.setItem('investAgentInstanceId', currentInstanceId);
  syncUrlContext();
  loadData();
}

function switchInstance(instanceId) {
  currentInstanceId = instanceId || 'invest-agent-primary';
  const match = (D.instances || []).find((item) => item.id === currentInstanceId);
  if (match?.ownerUserId) {
    currentUserId = match.ownerUserId;
    localStorage.setItem('investAgentUserId', currentUserId);
  }
  localStorage.setItem('investAgentInstanceId', currentInstanceId);
  syncUrlContext();
  loadData();
}

function renderOverviewGrid() {
  const el = document.getElementById('overviewGrid');
  let html = '';

  // Workbench value: review loop
  html += '<div class="card"><div class="card-header"><h2>复盘闭环</h2><button class="btn btn-gray" onclick="switchPage(\\'reviews\\')">查看复盘</button></div><div class="card-body">';
  html += renderWorkbenchLoopList();
  html += '</div></div>';

  // Workbench value: method evolution
  html += '<div class="card"><div class="card-header"><h2>方法演化候选</h2><button class="btn btn-gray" onclick="switchPage(\\'conversations\\')">看来源</button></div><div class="card-body">';
  html += renderMethodCandidateList();
  html += '</div></div>';

  // Holdings quick
  html += '<div class="card"><div class="card-header"><h2>持仓池 (' + D.holdings.length + ')</h2><button class="btn btn-gray" onclick="switchPage(\\'holdings\\')">查看</button></div><div class="card-body">';
  if (!D.holdings.length) html += '<div class="empty-hint">暂无</div>';
  else { html += '<table><thead><tr><th>股票</th><th>主力净流入</th></tr></thead><tbody>';
    for (const h of D.holdings) { html += '<tr><td>' + H(h.stockName) + '</td><td>' + formatFlowCell(D.capitalFlows?.[h.stockCode]?.mainNetInflow) + '</td></tr>'; }
    html += '</tbody></table>'; }
  html += '</div></div>';

  // Watchlist quick
  html += '<div class="card"><div class="card-header"><h2>自选池 (' + D.watchlist.length + ')</h2><button class="btn btn-gray" onclick="switchPage(\\'watchlist\\')">查看</button></div><div class="card-body">';
  if (!D.watchlist.length) html += '<div class="empty-hint">暂无</div>';
  else { html += '<table><thead><tr><th>股票</th><th>主力净流入</th></tr></thead><tbody>';
    for (const w of D.watchlist) { html += '<tr><td>' + H(w.stockName) + '</td><td>' + formatFlowCell(D.capitalFlows?.[w.stockCode]?.mainNetInflow) + '</td></tr>'; }
    html += '</tbody></table>'; }
  html += '</div></div>';

  // Plans quick
  html += '<div class="card"><div class="card-header"><h2>交易预案 (' + D.plans.length + ')</h2><button class="btn btn-gray" onclick="switchPage(\\'plans\\')">查看</button></div><div class="card-body">';
  if (!D.plans.length) html += '<div class="empty-hint">暂无</div>';
  else { html += '<table><thead><tr><th>股票</th><th>支撑</th><th>压力</th><th>目标</th></tr></thead><tbody>';
    for (const p of D.plans) { html += '<tr><td>' + H(p.stockName) + '</td><td>' + val(p.support) + '</td><td>' + val(p.resistance) + '</td><td>' + val(p.targetPrice) + '</td></tr>'; }
    html += '</tbody></table>'; }
  html += '</div></div>';

  // Alert rules quick
  const upgraded = D.upgradedAlertRules || [];
  const enabledUpgraded = upgraded.filter(a => a.enabled);
  html += '<div class="card"><div class="card-header"><h2>提醒规则 (' + enabledUpgraded.length + '/' + upgraded.length + ')</h2><button class="btn btn-gray" onclick="switchPage(\\'rule-system\\')">查看</button></div><div class="card-body">';
  if (!upgraded.length) html += '<div class="empty-hint">暂无</div>';
  else { html += '<table><thead><tr><th>股票</th><th>指标</th><th>来源</th></tr></thead><tbody>';
    for (const r of upgraded.slice(0, 6)) { html += '<tr><td>' + H(r.stockName || r.stockCode) + '</td><td>' + H(indicatorName(r.indicatorKey)) + '</td><td>' + H(relationLabel(r.relationToPlan)) + '</td></tr>'; }
    html += '</tbody></table>'; }
  html += '</div></div>';

  // Indicator results quick
  const snapshots = D.recentIndicatorResults || [];
  html += '<div class="card"><div class="card-header"><h2>指标快照 (' + snapshots.length + ')</h2><button class="btn btn-gray" onclick="switchPage(\\'indicator-results\\')">查看</button></div><div class="card-body">';
  if (!snapshots.length) html += '<div class="empty-hint">暂无触发快照</div>';
  else { html += '<table><thead><tr><th>时间</th><th>股票</th><th>级别</th></tr></thead><tbody>';
    for (const r of snapshots.slice(0, 6)) { html += '<tr><td>' + shortTime(r.calculatedAt) + '</td><td>' + H(r.stockName || r.stockCode) + '</td><td>' + severityBadge(r.level || 'medium') + '</td></tr>'; }
    html += '</tbody></table>'; }
  html += '</div></div>';

  el.innerHTML = html;
}

function renderWorkbenchStrip() {
  const el = document.getElementById('workbenchStrip');
  if (!el) return;
  const due = (D.dueViewpoints || []).length;
  const open = (D.openViewpoints || []).length;
  const candidates = (D.methodCandidates || []).filter(x => x.status === 'proposed').length;
  const reviews = (D.recentPlans || []).length;
  el.innerHTML = [
    workbenchTile('待验证观点', due + '/' + open, due ? '已有观点到复盘日期，需要判断有效、失效或继续观察。' : '暂无到期观点，后续复盘继续积累。'),
    workbenchTile('方法候选', candidates, candidates ? '有实例展开候选等待确认、拒绝或吸收。' : '当前没有待处理方法候选。'),
    workbenchTile('复盘记录', reviews, reviews ? '最近复盘已沉淀，可展开阅读完整内容。' : '暂无已保存复盘记录。'),
  ].join('');
}

function workbenchTile(label, value, note) {
  return '<div class="workbench-tile"><div class="tile-label">' + H(label) + '</div><div class="tile-value">' + H(String(value)) + '</div><div class="tile-note">' + H(note) + '</div></div>';
}

function renderWorkbenchLoopList() {
  const due = D.dueViewpoints || [];
  const open = D.openViewpoints || [];
  const latestReviews = D.recentPlans || [];
  const rows = [];
  if (due.length) {
    rows.push(...due.slice(0, 4).map(v => ({
      badge: '<span class="badge badge-yellow">待验证</span>',
      title: (v.sourceDate || '-') + ' · ' + (v.viewpointId || '观点'),
      body: v.view || v.validation || '-',
      meta: '预计复盘 ' + (v.expectedReviewDate || '-'),
    })));
  } else if (open.length) {
    rows.push(...open.slice(0, 3).map(v => ({
      badge: '<span class="badge badge-info">观察中</span>',
      title: (v.sourceDate || '-') + ' · ' + (v.viewpointId || '观点'),
      body: v.view || v.validation || '-',
      meta: '预计复盘 ' + (v.expectedReviewDate || '-'),
    })));
  }
  if (latestReviews[0]) {
    rows.push({
      badge: '<span class="badge badge-green">最近复盘</span>',
      title: latestReviews[0].planDate || '-',
      body: firstLine(latestReviews[0].summary || latestReviews[0].content || '已保存复盘内容'),
      meta: latestReviews[0].generatedAt ? shortTime(latestReviews[0].generatedAt) : '-',
    });
  }
  if (!rows.length) return '<div class="empty-hint">暂无复盘闭环数据</div>';
  return '<div class="workbench-list">' + rows.map(renderWorkbenchItem).join('') + '</div>';
}

function renderMethodCandidateList() {
  const candidates = D.methodCandidates || [];
  const rows = [];
  rows.push(...candidates.slice(0, 4).map(item => ({
    badge: '<span class="badge ' + (item.status === 'proposed' ? 'badge-yellow' : item.status === 'confirmed' ? 'badge-green' : 'badge-gray') + '">' + H(methodStatusLabel(item.status)) + '</span>',
    title: H(affectedResourceLabel(item.affectedResource || '-')),
    body: item.proposedChange || item.reason || '-',
    meta: [sourceTypeLabel(item.sourceType), shortTime(item.createdAt)].filter(Boolean).join(' · '),
  })));
  if (!rows.length) return '<div class="empty-hint">暂无方法候选</div>';
  return '<div class="workbench-list">' + rows.map(renderWorkbenchItem).join('') + '</div>';
}

function renderWorkbenchItem(item) {
  return '<div class="workbench-item">' +
    '<div class="flex items-center gap-2 mb-1">' + item.badge + '<span class="cell-main">' + H(item.title) + '</span></div>' +
    '<div class="text-xs" style="color:#334155;line-height:1.5">' + H(item.body) + '</div>' +
    '<div class="cell-sub">' + H(item.meta || '-') + '</div>' +
  '</div>';
}

// ─── Holdings ───
function renderHoldingsTable() {
  document.getElementById('holdingCount').textContent = D.holdings.length;
  const el = document.getElementById('holdingsTable');
  if (!D.holdings.length) { el.innerHTML = '<div class="empty-hint">暂无持仓</div>'; return; }
  let html = '<table><thead><tr><th>股票</th><th>代码</th><th>成本价</th><th>当前价</th><th>浮亏</th><th>主力净流入</th><th></th></tr></thead><tbody>';
  for (const h of D.holdings) {
    const cur = h.currentPrice;
    const cost = h.buyPrice;
    let pnlCell = '<span style="color:#94a3b8">—</span>';
    if (cost != null && cur != null) {
      const pnl = cur - cost;
      const pct = (pnl / cost) * 100;
      const sign = pnl >= 0 ? '+' : '';
      const color = pnl > 0 ? '#dc2626' : pnl < 0 ? '#16a34a' : '#475569';
      pnlCell = '<span style="color:' + color + '">' + sign + pnl.toFixed(2) + ' (' + sign + pct.toFixed(2) + '%)</span>';
    } else if (cost != null) {
      pnlCell = '<span style="color:#94a3b8">无行情</span>';
    }
    const costCell = cost != null ? cost.toFixed(2) : '<span style="color:#94a3b8">未填</span>';
    const curCell = cur != null ? cur.toFixed(2) : '<span style="color:#94a3b8">—</span>';
    html += '<tr><td>' + H(h.stockName) + '</td><td>' + h.stockCode + '</td><td>' + costCell + '</td><td>' + curCell + '</td><td>' + pnlCell + '</td><td>' + formatFlowCell(D.capitalFlows?.[h.stockCode]?.mainNetInflow) + '</td><td><button class="btn btn-red" onclick="doRemoveHolding(\\''+h.stockCode+'\\')">移除</button></td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

async function doAddHolding() {
  const input = document.getElementById('addHoldingInput');
  const costInput = document.getElementById('addHoldingCostInput');
  const v = input.value.trim();
  if (!v) return;
  const isCode = /^\\d{6}$/.test(v);
  const payload = isCode ? { code: v } : { name: v };
  const rawCost = costInput.value.trim();
  if (rawCost) {
    const cost = Number(rawCost);
    if (Number.isFinite(cost) && cost > 0 && cost < 100000) payload.costPrice = cost;
  }
  const res = await api('/api/portfolio/add', payload);
  if (res) { input.value = ''; costInput.value = ''; toggleForm('addHoldingForm'); loadData(); }
}

async function doRemoveHolding(code) {
  if (!confirm('确认移除？')) return;
  const res = await api('/api/portfolio/remove', { code });
  if (res) loadData();
}

// ─── Watchlist ───
function renderWatchlistTable() {
  document.getElementById('watchlistCount').textContent = D.watchlist.length;
  const el = document.getElementById('watchlistTable');
  if (!D.watchlist.length) { el.innerHTML = '<div class="empty-hint">暂无自选股</div>'; return; }
  let html = '<table><thead><tr><th>股票</th><th>代码</th><th>来源</th><th>理由</th><th>主力净流入</th><th></th></tr></thead><tbody>';
  for (const w of D.watchlist) {
    html += '<tr><td>' + H(w.stockName) + '</td><td>' + w.stockCode + '</td><td>' + H(w.source || '-') + '</td><td>' + H(w.reason || '-') + '</td><td>' + formatFlowCell(D.capitalFlows?.[w.stockCode]?.mainNetInflow) + '</td><td><button class="btn btn-red" onclick="doRemoveWatchlist(\\''+w.stockCode+'\\')">移除</button></td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

async function doAddWatchlist() {
  const input = document.getElementById('addWatchlistInput');
  const reason = document.getElementById('addWatchlistReason');
  const v = input.value.trim();
  if (!v) return;
  const isCode = /^\\d{6}$/.test(v);
  const res = await api('/api/watchlist/add', { ...(isCode ? { code: v } : { name: v }), reason: reason.value.trim() || undefined });
  if (res) { input.value = ''; reason.value = ''; toggleForm('addWatchlistForm'); loadData(); }
}

async function doRemoveWatchlist(code) {
  if (!confirm('确认移除？')) return;
  const res = await api('/api/watchlist/remove', { code });
  if (res) loadData();
}

// ─── Plans ───
function renderPlansTable() {
  document.getElementById('planCount').textContent = D.plans.length;
  const el = document.getElementById('plansTable');
  if (!D.plans.length) { el.innerHTML = '<div class="empty-hint">暂无交易预案</div>'; return; }
  let html = '<table><thead><tr><th>股票</th><th>关键价位</th><th>预案类型</th><th>观察条件</th><th>备注</th><th></th></tr></thead><tbody>';
  for (const p of D.plans) {
    const conditions = parseJson(p.watchConditions, []);
    const linked = parseJson(p.linkedAlertRuleIds, []);
    const priceLines = [
      '支撑 ' + val(p.support),
      '压力 ' + val(p.resistance),
      '目标 ' + val(p.targetPrice),
      '止损 ' + val(p.stopLoss),
    ].join(' / ');
    html += '<tr><td class="whitespace-nowrap"><div class="cell-main">' + H(p.stockName) + '</div><div class="cell-sub mono">' + p.stockCode + '</div></td><td class="text-xs">' + H(priceLines) + '</td><td>' + planTypeBadge(p.planType) + '</td><td>' + formatWatchConditions(conditions, linked) + '</td><td class="text-xs">' + H(p.notes || '-') + '</td><td><button class="btn btn-blue" onclick="showPlanModal(\\''+p.stockCode+'\\',\\''+esc(p.stockName)+'\\')">编辑</button> <button class="btn btn-red" onclick="doRemovePlan(\\''+p.stockCode+'\\')">删除</button></td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

function showPlanModal(code, name) {
  const existing = code ? D.plans.find(p => p.stockCode === code) : null;
  const html = '<div class="edit-overlay" onclick="if(event.target===this)closeModal()"><div class="edit-modal">' +
    '<h3 style="color:#111827;font-weight:600;margin:0 0 16px">' + (existing ? '编辑预案' : '新建预案') + '</h3>' +
    '<div class="form-row"><span class="form-label">股票</span>' +
    (existing ? '<span style="color:#111827;font-size:14px">' + name + '(' + code + ')</span>' :
    '<input class="form-input form-input-md" id="planCode" placeholder="代码 如 300750" /><input class="form-input form-input-wide" id="planName" placeholder="名称 如 宁德时代" />') + '</div>' +
    '<div class="form-row"><span class="form-label">支撑位</span><input class="form-input form-input-sm" id="planSupport" type="number" step="0.01" value="' + (existing?.support ?? '') + '" /><span class="form-label">压力位</span><input class="form-input form-input-sm" id="planResistance" type="number" step="0.01" value="' + (existing?.resistance ?? '') + '" /></div>' +
    '<div class="form-row"><span class="form-label">目标价</span><input class="form-input form-input-sm" id="planTarget" type="number" step="0.01" value="' + (existing?.targetPrice ?? '') + '" /><span class="form-label">止损价</span><input class="form-input form-input-sm" id="planStop" type="number" step="0.01" value="' + (existing?.stopLoss ?? '') + '" /></div>' +
    '<div class="form-row"><span class="form-label">备注</span><input class="form-input form-input-wide" id="planNotes" value="' + (existing?.notes ?? '') + '" /></div>' +
    '<div class="flex justify-end gap-2 mt-4"><button class="btn btn-gray" onclick="closeModal()">取消</button><button class="btn btn-green" onclick="doSavePlan(\\''+(code||'')+'\\')">保存</button></div>' +
    '</div></div>';
  document.getElementById('modal-root').innerHTML = html;
}

async function doSavePlan(code) {
  const stockCode = code || document.getElementById('planCode').value.trim();
  if (!stockCode) { toast('请输入股票代码', false); return; }
  const stockName = code ? undefined : document.getElementById('planName').value.trim() || undefined;
  const res = await api('/api/plans/set', {
    stockCode, stockName,
    support: parseFloat(document.getElementById('planSupport').value) || undefined,
    resistance: parseFloat(document.getElementById('planResistance').value) || undefined,
    targetPrice: parseFloat(document.getElementById('planTarget').value) || undefined,
    stopLoss: parseFloat(document.getElementById('planStop').value) || undefined,
    notes: document.getElementById('planNotes').value.trim() || undefined,
  });
  if (res) { closeModal(); loadData(); }
}

async function doRemovePlan(code) {
  if (!confirm('确认删除预案？')) return;
  const res = await api('/api/plans/remove', { stockCode: code });
  if (res) loadData();
}

// ─── Indicator Library ───
function renderIndicatorsTable() {
  const items = D.indicators || [];
  document.getElementById('indicatorCount').textContent = items.length;
  const el = document.getElementById('indicatorsTable');
  if (!items.length) { el.innerHTML = '<div class="empty-hint">暂无指标定义</div>'; return; }
  let html = '<table><thead><tr><th>指标</th><th>分类/周期</th><th>数据需求</th><th>可靠性</th><th>状态</th><th>说明</th></tr></thead><tbody>';
  for (const item of items) {
    const requirements = parseJson(item.dataRequirements, []);
    html += '<tr><td><div class="cell-main">' + H(item.name) + '</div><div class="cell-sub mono">' + H(item.key) + '</div></td><td><div>' + H(categoryLabel(item.category)) + '</div><div class="cell-sub">' + H(item.timeframe) + ' / ' + H(formulaTypeLabel(item.formulaType)) + '</div></td><td class="text-xs">' + formatList(requirements, '暂无') + '</td><td>' + reliabilityBadge(item.reliability) + '</td><td>' + enabledBadge(item.enabled) + '</td><td class="text-xs">' + H(item.description || '-') + '</td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

function renderUpgradedRulesTable() {
  const rules = D.upgradedAlertRules || [];
  const enabled = rules.filter(r => r.enabled).length;
  document.getElementById('upgradedRuleCount').textContent = enabled + '/' + rules.length;
  const el = document.getElementById('upgradedRulesTable');
  if (!rules.length) { el.innerHTML = '<div class="empty-hint">暂无新版提醒规则</div>'; return; }
  let html = '<table><thead><tr><th>股票</th><th>指标</th><th>触发条件</th><th>参数/去重</th><th>预案关系</th><th>状态</th></tr></thead><tbody>';
  for (const r of rules) {
    const params = parseJson(r.params, {});
    const dedupe = parseJson(r.dedupePolicy, {});
    html += '<tr><td><div class="cell-main">' + H(r.stockName || r.stockCode) + '</div><div class="cell-sub mono">' + H(r.stockCode) + '</div></td><td><div>' + H(indicatorName(r.indicatorKey)) + '</div><div class="cell-sub mono">' + H(r.indicatorKey) + '</div></td><td class="mono">' + H(r.condition || '-') + '</td><td class="text-xs"><div>' + H(formatObject(params)) + '</div><div class="cell-sub">' + H(formatDedupe(dedupe)) + '</div></td><td>' + relationBadge(r.relationToPlan) + '<div class="cell-sub">' + H(r.schedule || 'intraday') + ' / ' + H(r.severity || 'medium') + '</div></td><td>' + enabledBadge(r.enabled) + '</td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

function renderIndicatorResultsTable() {
  const rows = D.recentIndicatorResults || [];
  document.getElementById('indicatorResultCount').textContent = rows.length;
  const el = document.getElementById('indicatorResultsTable');
  if (!rows.length) { el.innerHTML = '<div class="empty-hint">暂无指标快照。只有真实巡检触发提醒时，才会写入这里。</div>'; return; }
  let html = '<table><thead><tr><th>时间</th><th>股票</th><th>指标</th><th>级别/置信度</th><th>触发值</th><th>依据</th></tr></thead><tbody>';
  for (const row of rows) {
    const value = parseJson(row.value, {});
    const missing = parseJson(row.missingData, []);
    const source = parseJson(row.sourceSnapshot, {});
    const missingText = Array.isArray(missing) && missing.length ? '<div class="cell-sub">缺口：' + H(missing.join(', ')) + '</div>' : '';
    html += '<tr><td><div>' + shortTime(row.calculatedAt) + '</div><div class="cell-sub">' + H(row.timeframe || '-') + '</div></td><td><div class="cell-main">' + H(row.stockName || row.stockCode) + '</div><div class="cell-sub mono">' + H(row.stockCode) + '</div></td><td><div>' + H(indicatorName(row.indicatorKey)) + '</div><div class="cell-sub mono">' + H(row.indicatorKey) + '</div></td><td>' + severityBadge(row.level || 'medium') + '<div class="cell-sub">' + H(row.confidence || '-') + '</div></td><td class="text-xs">' + H(formatObject(value)) + '</td><td class="text-xs">' + H(row.explanation || formatObject(source) || '-') + missingText + '</td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

// ─── Signals ───
function renderSignalsTable(signals) {
  const el = document.getElementById('signalsTable');
  let html = '<table><thead><tr><th>信号</th><th>说明</th><th>状态</th><th>参数</th></tr></thead><tbody>';
  for (const s of signals) {
    const toggle = '<span class="toggle ' + (s.enabled ? 'toggle-on' : 'toggle-off') + '" onclick="doToggleSignal(\\''+s.key+'\\','+(!s.enabled)+')"></span>';
    const params = Object.entries(s.params).map(([k,v]) => k + '=' + v).join(', ') || '-';
    html += '<tr><td class="font-medium" style="color:#111827">' + H(s.name) + '</td><td class="text-xs" style="color:#64748b">' + H(s.description || '') + '</td><td>' + toggle + '</td><td class="text-xs">' + H(params) + '</td></tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

async function doToggleSignal(key, enabled) {
  const res = await api('/api/signals/update', { signalKey: key, enabled });
  if (res) loadData();
}

// ─── Alert Events ───
function renderEventBatches(batches) {
  const total = batches.reduce((s, b) => s + b.events.length, 0);
  document.getElementById('eventCount').textContent = total;
  const el = document.getElementById('recentEvents');
  if (!batches.length) { el.innerHTML = '<div class="empty-hint">暂无提醒事件</div>'; return; }
  const sevMap = { high: 'badge-red', medium: 'badge-yellow', low: 'badge-gray' };
  const statusMap = { pending: 'badge-gray' };
  let html = '';
  for (const batch of batches) {
    const time = new Date(batch.batchTime).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    const highCount = batch.events.filter(e => e.severity === 'high').length;
    const label = highCount > 0 ? '<span class="badge badge-red ml-2">' + highCount + ' 重要</span>' : '';
    html += '<div class="card mb-3"><div class="card-header"><h2>' + time + ' (' + batch.events.length + '条)' + label + '</h2></div><div class="card-body"><table><thead><tr><th>股票</th><th>消息</th><th>严重度</th><th>状态</th></tr></thead><tbody>';
    for (const e of batch.events) {
      html += '<tr><td class="whitespace-nowrap">' + H(e.stockName) + '</td><td class="text-xs">' + H(e.message) + '</td><td><span class="badge ' + (sevMap[e.severity] || 'badge-gray') + '">' + e.severity + '</span></td><td><span class="badge ' + (statusMap[e.status] || 'badge-gray') + '">' + e.status + '</span></td></tr>';
    }
    html += '</tbody></table></div></div>';
  }
  el.innerHTML = html;
}

// ─── Reviews ───
function renderRecentPlans(plans) {
  const el = document.getElementById('recentPlans');
  if (!plans.length) { el.innerHTML = '<div class="empty-hint">暂无复盘记录</div>'; return; }
  const selected = plans[0];
  const list = plans.map((p, index) =>
    '<button class="' + (index === 0 ? 'active' : '') + '" onclick="selectReview(' + index + ')">' +
      '<div class="cell-main">' + H(p.planDate) + '</div>' +
      '<div class="cell-sub">' + H(firstLine(p.summary || p.content || '已保存复盘内容')) + '</div>' +
    '</button>'
  ).join('');
  el.innerHTML = '<div class="reader-layout">' +
    '<div class="review-list" id="reviewList">' + list + '</div>' +
    '<div class="review-reader">' +
      '<div class="review-reader-header"><div class="cell-main" id="reviewReaderTitle">' + H(selected.planDate) + '</div><div class="cell-sub" id="reviewReaderMeta">' + H(selected.generatedAt ? shortTime(selected.generatedAt) : '-') + '</div></div>' +
      '<div class="review-reader-body" id="reviewReaderBody">' + H(selected.content || selected.summary || '暂无内容') + '</div>' +
    '</div>' +
  '</div>';
}

function selectReview(index) {
  const plans = D.recentPlans || [];
  const selected = plans[index];
  if (!selected) return;
  document.querySelectorAll('#reviewList button').forEach((button, i) => button.classList.toggle('active', i === index));
  document.getElementById('reviewReaderTitle').textContent = selected.planDate || '-';
  document.getElementById('reviewReaderMeta').textContent = selected.generatedAt ? shortTime(selected.generatedAt) : '-';
  document.getElementById('reviewReaderBody').textContent = selected.content || selected.summary || '暂无内容';
}

function renderViewpoints() {
  const rows = D.reviewViewpoints || [];
  const count = document.getElementById('viewpointCount');
  const el = document.getElementById('viewpointList');
  if (!el) return;
  const filtered = filterViewpoints(rows);
  if (count) count.textContent = filtered.length + '/' + rows.length;
  if (!filtered.length) { el.innerHTML = '<div class="empty-hint">暂无符合条件的观点记录</div>'; return; }
  el.innerHTML = '<div class="viewpoint-grid">' + filtered.map(formatViewpointCard).join('') + '</div>';
}

function filterViewpoints(rows) {
  const status = document.getElementById('viewpointStatusFilter')?.value || '';
  const keyword = (document.getElementById('viewpointKeywordFilter')?.value || '').trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter(row => {
    const due = row.status === 'open' && row.expectedReviewDate && row.expectedReviewDate <= today;
    if (status === 'due' && !due) return false;
    if (status && status !== 'due' && row.status !== status) return false;
    if (keyword) {
      const text = [row.sourceDate, row.viewpointId, row.view, row.reason, row.action, row.validation, row.resolution].join(' ').toLowerCase();
      if (!text.includes(keyword)) return false;
    }
    return true;
  });
}

function formatViewpointCard(row) {
  const due = row.status === 'open' && row.expectedReviewDate && row.expectedReviewDate <= new Date().toISOString().slice(0, 10);
  return '<div class="viewpoint-card">' +
    '<div class="vp-title"><div class="cell-main">' + H(row.sourceDate || '-') + ' · ' + H(row.viewpointId || '观点') + '</div>' + viewpointStatusBadge(row.status, due) + '</div>' +
    '<div class="vp-body"><strong>观点：</strong>' + H(row.view || '-') + '</div>' +
    '<div class="vp-body"><strong>依据：</strong>' + H(row.reason || '-') + '</div>' +
    '<div class="vp-body"><strong>动作：</strong>' + H(row.action || '-') + '</div>' +
    '<div class="vp-body"><strong>验证：</strong>' + H(row.validation || '-') + '</div>' +
    (row.resolution ? '<div class="vp-body"><strong>结论：</strong>' + H(row.resolution) + '</div>' : '') +
    '<div class="vp-meta">预计复盘 ' + H(row.expectedReviewDate || '-') + (row.resolvedAt ? ' · 已处理 ' + H(shortTime(row.resolvedAt)) : '') + '</div>' +
  '</div>';
}

function resetViewpointFilters() {
  const status = document.getElementById('viewpointStatusFilter');
  const keyword = document.getElementById('viewpointKeywordFilter');
  if (status) status.value = '';
  if (keyword) keyword.value = '';
  renderViewpoints();
}

// ─── Conversations ───
function renderConversations(rows) {
  const sourceRows = rows || conversationRows || [];
  const el = document.getElementById('conversationList');
  const count = document.getElementById('conversationCount');
  const filtered = filterConversations(sourceRows);
  if (count) count.textContent = filtered.length + '/' + sourceRows.length;
  if (!filtered.length) { el.innerHTML = '<div class="empty-hint">没有符合条件的对话记录</div>'; return; }

  const groups = groupByDate(filtered);
  let html = '';
  let groupIndex = 0;
  for (const group of groups) {
    const groupId = 'conversationGroup' + groupIndex++;
    html += '<div class="date-group">' +
      '<div class="date-group-header" onclick="toggleConversationGroup(\\'' + groupId + '\\', this)"><span>▾</span><span>' + H(group.date) + '</span><span class="badge badge-gray">' + group.rows.length + '</span><span class="line"></span></div>' +
      '<div id="' + groupId + '">';
    for (const row of group.rows) {
      html += formatConversationCard(row);
    }
    html += '</div></div>';
  }
  el.innerHTML = html;
}

function filterConversations(rows) {
  const date = document.getElementById('conversationDateFilter')?.value || '';
  const mode = document.getElementById('conversationModeFilter')?.value || '';
  const status = document.getElementById('conversationStatusFilter')?.value || '';
  const keyword = (document.getElementById('conversationKeywordFilter')?.value || '').trim().toLowerCase();
  return rows.filter(row => {
    const rowDate = dateKey(row.createdAt);
    if (date && rowDate !== date) return false;
    if (mode && row.mode !== mode) return false;
    if (status && row.status !== status) return false;
    if (keyword) {
      const text = [row.userText, row.replyTextSanitized, row.errorMessage, row.conversationId, row.mode, row.channel].join(' ').toLowerCase();
      if (!text.includes(keyword)) return false;
    }
    return true;
  });
}

function groupByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = dateKey(row.createdAt) || '未知日期';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].map(([date, groupRows]) => ({ date, rows: groupRows }));
}

function formatConversationCard(row) {
  const reply = row.status === 'error' || row.status === 'timeout'
    ? (row.errorMessage || '处理失败')
    : (row.replyTextSanitized || '-');
  const detailId = 'conversationDetail' + row.id;
  const preview = firstLine(row.userText || '-');
  const elapsed = row.elapsedMs != null ? ' / ' + Math.round(row.elapsedMs / 1000) + 's' : '';
  return '<div class="card mb-3">' +
    '<div class="card-header cursor-pointer" onclick="toggleConversationDetail(\\'' + detailId + '\\', this)"><h2>' + shortTime(row.createdAt) + ' · ' + H(modeLabel(row.mode)) + '</h2><div class="section-actions">' + traceStatusBadge(row.status) + '<span class="badge badge-gray">' + H(row.channel || '-') + '</span><span class="text-xs text-gray-500">展开</span></div></div>' +
    '<div class="card-body">' +
      '<div class="conversation-preview">' + H(preview) + '</div>' +
      '<div id="' + detailId + '" style="display:none" class="mt-3">' +
        '<div class="cell-sub mono mb-2">' + H(row.conversationId || '-') + elapsed + '</div>' +
        '<div class="mb-3"><div class="muted mb-1">用户</div><div class="text-sm whitespace-pre-wrap" style="color:#111827">' + H(row.userText || '-') + '</div></div>' +
        '<div><div class="muted mb-1">助手</div><div class="text-sm whitespace-pre-wrap" style="color:#334155">' + H(reply) + '</div></div>' +
      '</div>' +
    '</div></div>';
}

function toggleConversationDetail(id, header) {
  const el = document.getElementById(id);
  if (!el) return;
  const label = header.querySelector('.section-actions span:last-child');
  if (el.style.display === 'none') { el.style.display = 'block'; if (label) label.textContent = '收起'; }
  else { el.style.display = 'none'; if (label) label.textContent = '展开'; }
}

function toggleConversationGroup(id, header) {
  const el = document.getElementById(id);
  if (!el) return;
  const arrow = header.querySelector('span:first-child');
  if (el.style.display === 'none') { el.style.display = 'block'; if (arrow) arrow.textContent = '▾'; }
  else { el.style.display = 'none'; if (arrow) arrow.textContent = '▸'; }
}

function resetConversationFilters() {
  const date = document.getElementById('conversationDateFilter');
  const mode = document.getElementById('conversationModeFilter');
  const status = document.getElementById('conversationStatusFilter');
  const keyword = document.getElementById('conversationKeywordFilter');
  if (date) date.value = '';
  if (mode) mode.value = '';
  if (status) status.value = '';
  if (keyword) keyword.value = '';
  renderConversations();
}

// ─── Patrol ───
async function doSetInterval() {
  const v = parseInt(document.getElementById('patrolInterval').value);
  if (!v || v < 1) { toast('请输入有效的分钟数', false); return; }
  const res = await api('/api/interval/set', { minutes: v });
  if (res) loadData();
}

// ─── ACP Backend ───
async function loadAcpBackends() {
  const res = await api('/api/acp-backends');
  if (!res) return;
  const select = document.getElementById('acpBackendSelect');
  const badge = document.getElementById('acpBackendBadge');
  const status = document.getElementById('acpBackendStatus');
  select.value = res.current;
  const current = res.backends.find((b) => b.id === res.current);
  badge.className = 'badge ' + (current?.ready ? 'badge-green' : 'badge-gray');
  badge.textContent = current ? (current.label + ' ' + (current.ready ? '就绪' : '未启动')) : res.current;
  status.innerHTML = res.backends.map((b) => {
    const flag = b.id === res.current ? '●' : '○';
    const state = b.ready ? '<span class="text-green-600">就绪</span>' : '<span class="text-gray-500">未启动</span>';
    const def = b.isDefault ? ' <span class="text-xs text-gray-400">默认</span>' : '';
    const sess = b.sessions > 0 ? (' · ' + b.sessions + ' 会话') : '';
    const pid = b.pid ? (' · pid=' + b.pid) : '';
    return '<div>' + flag + ' <b>' + b.label + '</b>' + def + ' — ' + state + ' ' + sess + pid + '</div>';
  }).join('');
}

async function doSwitchAcpBackend() {
  const v = document.getElementById('acpBackendSelect').value;
  if (v !== 'hermes' && v !== 'codex') { toast('请选择有效的后端', false); return; }
  const res = await api('/api/acp-backends/switch', { backend: v });
  if (res) {
    toast('已切换到 ' + v, true);
    loadAcpBackends();
  }
}

async function doCheckAlerts() {
  toast('正在巡检...', true);
  try {
    const data = await api('/api/alerts/check-and-push', {});
    if (!data) return;
    document.getElementById('wxActionLog').textContent = JSON.stringify(data, null, 2);
    toast('巡检完成：' + (data.count || 0) + ' 条提醒', data.count > 0);
    loadData();
  } catch (e) { toast('巡检失败: ' + e.message, false); }
}

async function doMockAlert() {
  try {
    const res = await fetch('/api/alerts/mock-and-push', { method: 'POST' });
    const data = await res.json();
    document.getElementById('wxActionLog').textContent = JSON.stringify(data, null, 2);
    toast('模拟触发完成', data.ok);
  } catch (e) { toast('模拟触发失败: ' + e.message, false); }
}

// ─── WeChat ───
async function wxRefresh() {
  try {
    const state = await wxApi('/api/weixin/status');
    wxRender(state);
  } catch (e) { document.getElementById('wxMessage').textContent = e.message; }
}

function wxRender(state) {
  const badge = document.getElementById('wxStageBadge');
  badge.textContent = state.stage || '-';
  badge.className = 'badge ' + (state.stage === 'connected' ? 'badge-green' : state.stage === 'error' ? 'badge-red' : 'badge-gray');
  document.getElementById('wxStage').textContent = state.stage || '-';
  document.getElementById('wxAccountId').textContent = state.accountId || '-';
  document.getElementById('wxListener').textContent = state.listenerRunning ? '监听中' : '未监听';
  document.getElementById('wxPushReady').textContent = state.pushReady ? '可推送' : '等待客户先发一条消息';
  document.getElementById('wxLastConversation').textContent = state.lastConversationId ? state.lastConversationId + (state.lastConversationAt ? ' / ' + state.lastConversationAt : '') : '-';
  document.getElementById('wxMessage').textContent = state.message || '-';
  document.getElementById('wxUpdatedAt').textContent = state.updatedAt || '-';
  document.getElementById('wxLastError').textContent = state.lastError || '-';
  if (state.qrcodeUrl) {
    if (wxLastQr !== state.qrcodeDataUrl) {
      document.getElementById('wxQrImg').src = state.qrcodeDataUrl || '';
      document.getElementById('wxQrLink').textContent = state.qrcodeUrl;
      wxLastQr = state.qrcodeDataUrl || '';
    }
    document.getElementById('wxQrWrap').style.display = 'block';
  } else {
    document.getElementById('wxQrWrap').style.display = 'none';
    wxLastQr = '';
  }
  document.getElementById('wxConnectBtn').disabled = state.stage === 'waiting_scan' || state.stage === 'scanned';
  document.getElementById('wxListenBtn').disabled = state.stage !== 'connected' || state.listenerRunning;
  document.getElementById('wxTestBtn').disabled = !state.pushReady;
  // Auto-poll during QR scan
  if (['waiting_scan', 'scanned'].includes(state.stage) && !wxPollTimer) {
    wxPollTimer = setInterval(wxRefresh, 2500);
  }
  if (!['waiting_scan', 'scanned'].includes(state.stage) && wxPollTimer) {
    clearInterval(wxPollTimer);
    wxPollTimer = null;
  }
}

async function wxConnect() {
  const state = await wxApi('/api/weixin/connect/start', { method: 'POST' });
  wxRender(state);
  await wxRefresh();
}

async function wxListen() {
  const state = await wxApi('/api/weixin/listener/start', { method: 'POST' });
  wxRender(state);
  await wxRefresh();
}

async function wxTestPush() {
  const result = await wxApi('/api/weixin/push/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '测试提醒：盘中提醒链路已接通。' }),
  });
  if (result.state) wxRender(result.state);
  document.getElementById('wxActionLog').textContent = JSON.stringify(result, null, 2);
  await wxRefresh();
}

async function wxStop() {
  if (!confirm('确认断开微信连接？')) return;
  const state = await wxApi('/api/weixin/connect/stop', { method: 'POST' });
  wxRender(state);
  await wxRefresh();
}

async function wxApi(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Utility ───
async function api(path, body) {
  try {
    const payload = { ...(body || {}), userId: currentUserId, instanceId: currentInstanceId };
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Invest-User-Id': currentUserId,
        'X-Invest-Instance-Id': currentInstanceId,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) { toast(data.message, true); return data; }
    else { toast(data.error || '操作失败', false); return null; }
  } catch (e) { toast('请求失败: ' + e.message, false); return null; }
}

function toast(msg, ok) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (ok ? 'toast-ok' : 'toast-err');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.className = 'toast', 2500);
}

function toggleForm(id) {
  const el = document.getElementById(id);
  el.classList.toggle('active');
  if (el.classList.contains('active')) {
    const input = el.querySelector('input');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

function statCard(label, value, unit) {
  return '<div class="stat-card"><div class="value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</div><div class="label">' + label + '</div></div>';
}

function val(v) { return v != null ? v : '-'; }
function esc(s) { return (s||'').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
const H = escapeHtml;

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function indicatorName(key) {
  const item = (D.indicators || []).find(x => x.key === key);
  return item ? item.name : (key || '-');
}

function categoryLabel(category) {
  const map = {
    price: '价格',
    plan_price: '预案价位',
    price_volume: '价量',
    volume: '量能',
    trend: '趋势',
    intraday: '盘中',
    capital_flow: '资金流',
    control_proxy: '控盘代理',
  };
  return map[category] || category || '-';
}

function formulaTypeLabel(type) {
  const map = { builtin: '内置', expression: '表达式', script: '脚本', manual_spec: '待人工规格' };
  return map[type] || type || '-';
}

function relationLabel(value) {
  const map = {
    legacy_alert_mirror: '兼容镜像',
    stock_plan_watch_condition: '预案观察条件',
    manual: '手动',
  };
  return map[value] || value || '未关联';
}

function methodStatusLabel(value) {
  const map = {
    proposed: '候选',
    confirmed: '已确认',
    rejected: '已拒绝',
    applied: '已应用',
  };
  return map[value] || value || '-';
}

function affectedResourceLabel(value) {
  const map = {
    methodology_profile: '方法论兼容 Profile',
    strategy_skill_instance_expansion: '策略实例展开',
    strategy_skeleton: '策略骨架候选',
    review: '复盘规则',
    screening: '选股问答规则',
    alerts: '提醒规则',
    technical_entry: '技术入场规则',
    risk: '风险规则',
  };
  return map[value] || value || '-';
}

function sourceTypeLabel(value) {
  const map = {
    review: '复盘',
    conversation: '对话',
    conversation_instance_expansion: '对话实例展开',
    manual: '手动',
  };
  return map[value] || value || '';
}

function reliabilityBadge(value) {
  const label = { stable: '稳定', experimental: '试验', manual_review: '需人工审查' }[value] || value || '-';
  const cls = value === 'stable' ? 'badge-green' : value === 'experimental' ? 'badge-yellow' : 'badge-gray';
  return '<span class="badge ' + cls + '">' + H(label) + '</span>';
}

function enabledBadge(enabled) {
  return enabled ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-gray">停用</span>';
}

function severityBadge(level) {
  const v = String(level || 'medium').toLowerCase();
  const cls = v === 'high' || v === 'critical' ? 'badge-red' : v === 'medium' ? 'badge-yellow' : 'badge-gray';
  const label = { high: '高', critical: '高', medium: '中', low: '低' }[v] || level;
  return '<span class="badge ' + cls + '">' + H(label) + '</span>';
}

function relationBadge(value) {
  const cls = value === 'stock_plan_watch_condition' ? 'badge-green' : value === 'legacy_alert_mirror' ? 'badge-yellow' : 'badge-gray';
  return '<span class="badge ' + cls + '">' + H(relationLabel(value)) + '</span>';
}

function traceStatusBadge(status) {
  const value = String(status || 'unknown');
  const cls = value === 'success' ? 'badge-green' : value === 'timeout' ? 'badge-yellow' : value === 'error' ? 'badge-red' : 'badge-gray';
  const label = { success: '成功', timeout: '超时', error: '失败' }[value] || value;
  return '<span class="badge ' + cls + '">' + H(label) + '</span>';
}

function viewpointStatusBadge(status, due) {
  if (due) return '<span class="badge badge-yellow">到期待验证</span>';
  const value = String(status || 'open');
  const cls = value === 'validated' ? 'badge-green' : value === 'invalidated' ? 'badge-red' : value === 'open' ? 'badge-info' : 'badge-gray';
  const label = { open: '观察中', validated: '已验证', invalidated: '已失效' }[value] || value;
  return '<span class="badge ' + cls + '">' + H(label) + '</span>';
}

function modeLabel(mode) {
  const map = {
    chat: '普通对话',
    'daily-review': '日复盘',
    'daily-review-ack': '日复盘回执',
    'daily-review-push': '日复盘推送',
    screening: '选股问答',
  };
  return map[mode] || mode || '-';
}

function planTypeBadge(value) {
  const label = { manual: '手动预案', watchlist_candidate: '自选候选', holding_plan: '持仓预案' }[value] || value || '手动预案';
  const cls = value === 'holding_plan' ? 'badge-green' : value === 'watchlist_candidate' ? 'badge-yellow' : 'badge-gray';
  return '<span class="badge ' + cls + '">' + H(label) + '</span>';
}

function formatList(items, emptyText) {
  if (!Array.isArray(items) || !items.length) return '<span class="muted">' + H(emptyText || '-') + '</span>';
  return '<div class="compact-list">' + items.map(x => '<span class="mono">' + H(String(x)) + '</span>').join('') + '</div>';
}

function formatObject(obj) {
  if (obj == null) return '-';
  if (typeof obj !== 'object') return String(obj);
  const entries = Object.entries(obj);
  if (!entries.length) return '-';
  return entries.map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
}

function formatDedupe(dedupe) {
  if (!dedupe || typeof dedupe !== 'object' || !Object.keys(dedupe).length) return '默认去重';
  const parts = [];
  if (dedupe.windowMinutes != null) parts.push('窗口 ' + dedupe.windowMinutes + ' 分钟');
  if (dedupe.mode) parts.push('模式 ' + dedupe.mode);
  if (dedupe.key) parts.push('键 ' + dedupe.key);
  return parts.length ? parts.join(' / ') : formatObject(dedupe);
}

function formatWatchConditions(conditions, linkedRuleIds) {
  const list = Array.isArray(conditions) ? conditions : [];
  const linked = Array.isArray(linkedRuleIds) ? linkedRuleIds : [];
  if (!list.length && !linked.length) return '<span class="muted">未挂观察条件</span>';
  let html = '<div class="compact-list">';
  for (const item of list.slice(0, 3)) {
    const title = item.label || indicatorName(item.indicatorKey);
    const action = item.actionHint ? ' / ' + item.actionHint : '';
    html += '<div class="condition-line"><strong>' + H(title) + '</strong><span class="cell-sub mono">' + H(item.indicatorKey || '-') + action + '</span></div>';
  }
  if (list.length > 3) html += '<div class="muted">另有 ' + (list.length - 3) + ' 条</div>';
  if (linked.length) html += '<div class="muted">已关联提醒规则 ' + linked.length + ' 条</div>';
  html += '</div>';
  return html;
}

function shortTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function dateKey(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function firstLine(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 120) + '...' : text;
}

function formatFlowCell(yuan) {
  if (yuan == null) return '<span class="text-gray-600 text-xs">-</span>';
  const abs = Math.abs(yuan);
  let text;
  if (abs >= 1e8) text = (yuan >= 0 ? '+' : '') + (yuan / 1e8).toFixed(2) + '亿';
  else if (abs >= 1e4) text = (yuan >= 0 ? '+' : '') + (yuan / 1e4).toFixed(0) + '万';
  else text = (yuan >= 0 ? '+' : '') + abs.toFixed(0);
  const cls = yuan > 0 ? 'text-red-600' : yuan < 0 ? 'text-green-600' : 'text-gray-500';
  return '<span class="' + cls + ' text-xs font-medium">' + text + '</span>';
}

// ─── Init ───
loadData();
</script>
</body>
</html>`;
}
