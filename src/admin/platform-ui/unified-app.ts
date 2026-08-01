// 统一壳：单一入口，按角色分层导航（运营 4 视图 + 管理 5 视图）。
// Owner 看全部 9 视图，Partner 仅看运营 4 视图；视图模块完全复用。
// 替换原 partner-app + platform-app 双壳架构（这两个文件保留为薄壳 re-export 以兼容 import）。
import { TOKENS_CSS, RESET_CSS } from "./tokens";
import { PRIMITIVES_CSS } from "./primitives";
import { SHELL_CSS, SHARED_HELPERS_JS } from "./shell";
import { OWNER_CSS } from "./owner/owner-css";
import { CORE_JS } from "./owner/owner-core";
import { INSTANCES_JS } from "./owner/view-instances";
import { COST_JS } from "./owner/view-cost";
import { SOURCE_JS } from "./owner/view-source";
import { AUDIT_JS } from "./owner/view-audit";
import { RULES_JS } from "./owner/view-rules";
import { OVERVIEW_JS } from "./partner/view-overview";
import { CUSTOMERS_JS } from "./partner/view-customers";
import { QUALITY_JS } from "./partner/view-quality";
import { RUNTIME_JS } from "./partner/view-runtime";
import { PRICING_JS } from "./pricing";

// Partner 专属 CSS（登录卡 / 改密卡 / detail-grid / grid）。
const PARTNER_CSS = `
.login-shell{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:min(420px,100%);background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--radius-lg);padding:28px;box-shadow:var(--shadow-md)}
.login-card .brand{font-size:20px;font-weight:750;color:var(--ink);padding:0}
.eyebrow{color:var(--brand);font-size:12px;font-weight:700;letter-spacing:.04em;margin-bottom:8px}
.help{color:var(--muted);font-size:13px;line-height:1.6;margin:9px 0 20px}
.field{margin-top:13px}
.field label{display:block;color:var(--muted);font-size:12px;margin-bottom:6px}
.field input{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:10px 11px;outline:none;background:var(--surface-raised);color:var(--ink);transition:border-color .12s,box-shadow .12s}
.field input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-ring)}
.login-card .btn-primary{width:100%;margin-top:18px}
.login-error{display:none;border:1px solid #fecdd3;background:var(--danger-soft);color:#9f1239;border-radius:var(--radius-sm);padding:9px 10px;font-size:12px;margin-top:12px}
.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:var(--gap);align-items:start}
.detail{margin-top:var(--gap)}
.detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--gap-sm)}
.detail-item{border:1px solid var(--line);background:var(--surface-inset);border-radius:var(--radius-sm);padding:10px}
.detail-item span{display:block;color:var(--muted);font-size:11px}
.detail-item strong{display:block;color:var(--ink);font-size:13px;margin-top:5px}
.notice.show{display:block}
@media (max-width:980px){.grid{grid-template-columns:1fr}}
@media (max-width:520px){.detail-grid{grid-template-columns:1fr 1fr}}`;

// 运营视图骨架（双方都渲染：4 运营视图 + 成本总览）。
function opsViewsHtml(): string {
  return `
      <section class="view active" id="view-overview"><div id="partner-overview"><div class="loading">正在读取运营数据...</div></div></section>
      <section class="view" id="view-customers"><div id="customersSummary"></div><div class="panel"><div class="panel-head"><h2>客户与助手</h2><span class="sub">只显示运营状态，不含投资明细</span></div><div class="panel-body" id="partner-customers"><div class="loading">正在读取客户状态...</div></div></div><div id="customerDetail" class="detail"></div></section>
      <section class="view" id="view-quality"><div id="qualitySummary"></div><div class="panel"><div class="panel-head"><h2>产品质量</h2><span class="sub">近 7 日聚合</span></div><div class="panel-body" id="partner-quality"><div class="loading">正在读取质量指标...</div></div></div></section>
      <section class="view" id="view-runtime"><div id="runtimeSummary"></div><div class="panel"><div class="panel-head"><h2>运行与触达</h2><span class="sub">当前运行状态摘要</span></div><div class="panel-body" id="partner-runtime"><div class="loading">正在读取运行状态...</div></div></div></section>
      <section id="view-cost" class="view cost-grid">
        <div class="panel"><div class="panel-head"><h2>Token 与成本</h2><span class="muted" id="costUpdated">未加载</span> <span class="muted" id="costScopeHint"></span></div><div class="panel-body" id="costPanel"><div class="empty">加载中...</div></div></div>
      </section>`;
}

// 管理视图骨架（owner 5 视图，仅 owner 渲染）。
function adminViewsHtml(): string {
  return `
      <section id="view-instances" class="view">
        <div class="topbar" style="margin-bottom:14px">
          <input id="search" class="input" placeholder="搜索用户、助手、ID" oninput="render()" />
          <div class="actions">
            <button class="btn btn-primary" onclick="openCreateModal()">创建用户助手</button>
            <button class="btn" onclick="loadPlatform()">刷新</button>
          </div>
        </div>
        <div id="error" class="error"></div>
        <section class="owner-stats" id="stats"></section>
        <section class="grid">
          <div class="panel"><div class="panel-head"><h2>澜策 用户助手</h2><span class="muted" id="instanceCount">0 个用户</span></div><div class="panel-body" id="instanceList"></div></div>
          <div class="panel"><div class="panel-head"><h2>用户助手详情</h2><span class="muted" id="selectedHint">未选择</span></div><div class="panel-body" id="detail"></div></div>
        </section>
      </section>
      <section id="view-source-quality" class="view cost-grid">
        <div class="panel"><div class="panel-head"><h2>MCP 工具状态</h2><span class="muted" id="mcpToolsUpdated">未加载</span></div><div class="panel-body" id="mcpToolsPanel"><div class="empty">加载中...</div></div></div>
        <div class="panel"><div class="panel-head"><h2>数据源可靠性（历史）</h2><span class="muted" id="sourceQualityUpdated">未加载</span></div><div class="panel-body" id="sourceQualityPanel"><div class="empty">加载中...</div></div></div>
      </section>
      <section id="view-audit" class="view audit-grid">
        <div class="panel"><div class="panel-head"><h2>日志审计</h2><span class="muted" id="auditScopeHint">对话审计</span></div><div class="panel-body"><div class="form-grid"><div class="segmented"><button id="auditScopeConversation" class="segment active" onclick="setAuditScope('conversation')">对话审计</button><button id="auditScopePush" class="segment" onclick="setAuditScope('push')">推送审计</button></div><div class="field"><label>用户</label><select id="auditUser" class="select" onchange="onAuditUserChange()"></select></div><div class="field"><label>用户助手</label><select id="auditInstance" class="select" onchange="loadAudit()"></select></div><div class="field"><label>条数</label><select id="auditLimit" class="select" onchange="loadAudit()"><option value="30">30</option><option value="60">60</option><option value="120">120</option></select></div><button class="btn btn-primary" onclick="loadAudit()">刷新审计</button><div class="muted" id="auditHelp">对话审计查看微信用户消息进入 Codex 后的原始回复、清洗回复和入站提示。</div></div></div></div>
        <div class="panel"><div class="panel-head"><h2 id="auditTimelineTitle">对话时间线</h2><span class="muted" id="auditUpdated">未加载</span></div><div class="panel-body" id="auditTimeline"><div class="empty">选择用户后加载审计记录</div></div></div>
      </section>
      <section id="view-rule-alerts" class="view audit-grid">
        <div class="panel"><div class="panel-head"><h2>规则巡检</h2><span class="muted" id="ruleAlertScopeHint">确定性采样</span></div><div class="panel-body"><div class="form-grid"><div class="field"><label>用户</label><select id="ruleAlertUser" class="select" onchange="onRuleAlertUserChange()"></select></div><div class="field"><label>用户助手</label><select id="ruleAlertInstance" class="select" onchange="loadRuleAlerts()"></select></div><div class="field"><label>条数</label><select id="ruleAlertLimit" class="select" onchange="loadRuleAlerts()"><option value="30">30</option><option value="60">60</option><option value="120">120</option></select></div><button class="btn btn-primary" onclick="loadRuleAlerts()">刷新巡检</button><div class="muted">规则巡检按采样当刻价格执行确定性规则；触发事实写入提醒事件，推送由优先级和去重策略决定。</div></div></div></div>
        <div class="panel"><div class="panel-head"><h2>规则巡检审计</h2><span class="muted" id="ruleAlertUpdated">未加载</span></div><div class="panel-body" id="ruleAlertPanel"><div class="empty">选择用户后加载规则巡检记录</div></div></div>
      </section>
      <div class="modal-backdrop" id="createModal">
        <div class="modal">
          <h2>创建用户助手</h2>
          <div class="form-grid">
            <div class="field"><label>用户 ID</label><input id="createUserId" placeholder="例如 user-zhangsan" /></div>
            <div class="field"><label>用户显示名</label><input id="createDisplayName" placeholder="例如 张三" /></div>
            <div class="field"><label>助手名称</label><input id="createInstanceName" placeholder="例如 张三的投资助手，可留空" /></div>
            <div id="createError" class="error" style="display:none;margin:0"></div>
            <div class="ops"><button class="btn btn-primary" onclick="createInstance()">创建</button><button class="btn" onclick="closeCreateModal()">取消</button></div>
          </div>
        </div>
      </div>`;
}

// 登录壳 HTML（未认证或 owner 强制改密时）。
function loginShell(): string {
  return `<div class="login-shell"><form class="login-card" id="loginForm">
    <div class="eyebrow">INVEST AGENT PLATFORM</div><div class="brand">运营看板登录</div>
    <p class="help">使用后台账号登录。合伙人账号只用于查看运营状态和产品运行情况。</p>
    <div class="field"><label for="username">账号</label><input id="username" autocomplete="username" required /></div>
    <div class="field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required /></div>
    <div id="loginError" class="login-error"></div><button class="btn btn-primary" type="submit">登录</button>
  </form></div>`;
}

// 看板壳 HTML（已认证）。按角色渲染导航分组 + 视图。
function dashboardShell(role: "owner" | "partner"): string {
  const isAdmin = role === "owner";
  const brandSmall = isAdmin ? "平台管理" : "运营看板";
  // 运营视角导航（双方都有）。
  const opsNav = `
        <div class="nav-group">
          <div class="nav-group-label">运营视角</div>
          <a class="active" href="#overview" onclick="setView('overview');return false">运营总览 <span class="chev">›</span></a>
          <a href="#customers" onclick="setView('customers');return false">客户与助手 <span class="chev">›</span></a>
          <a href="#quality" onclick="setView('quality');return false">产品质量 <span class="chev">›</span></a>
          <a href="#runtime" onclick="setView('runtime');return false">运行与触达 <span class="chev">›</span></a>
          <a href="#cost" onclick="setView('cost');return false">成本统计 <span class="chev">›</span></a>
        </div>`;
  // 管理视角导航（仅 owner）。
  const adminNav = isAdmin ? `
        <div class="nav-group">
          <div class="nav-group-label">管理视角</div>
          <a id="nav-instances" href="#instances" onclick="setView('instances');return false">用户助手 <span class="chev">›</span></a>
          <a id="nav-audit" href="#audit" onclick="setView('audit');return false">日志审计 <span class="chev">›</span></a>
          <a id="nav-rule-alerts" href="#rule-alerts" onclick="setView('rule-alerts');return false">规则巡检 <span class="chev">›</span></a>
          <a id="nav-source-quality" href="#source-quality" onclick="setView('source-quality');return false">MCP 工具状态 <span class="chev">›</span></a>
        </div>` : "";
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand">澜策<small>${brandSmall}</small></div>
      <nav class="nav">${opsNav}${adminNav}</nav>
    </aside>
    <main class="main">
      <div class="topbar">
        <div><h1 id="title">运营总览</h1><div class="sub" id="updated">正在加载...</div></div>
        <div class="userbar"><span id="userName">${isAdmin ? "管理员" : "合伙人"}</span><button class="btn btn-small" id="logout">退出登录</button></div>
      </div>
      <div id="notice" class="notice"></div>
      ${opsViewsHtml()}${isAdmin ? adminViewsHtml() : ""}
    </main>
  </div>`;
}

// 运营视图异常点的颜色映射（供 overview 排序条使用）。
const DOTS_DEF_JS = `const DOTS={onboarding_stuck:'<span class="ui-dot ui-dot-info"></span>',onboarding_exception:'<span class="ui-dot ui-dot-danger"></span>',push_failed:'<span class="ui-dot ui-dot-warn"></span>',inactive_7d:'<span class="ui-dot ui-dot-muted"></span>'};`;

// 登录 + 强制改密逻辑（行为与 partner-app 等价）。
const LOGIN_JS = `
if(!authenticated){
  document.getElementById('loginForm').addEventListener('submit',async(event)=>{
    event.preventDefault();
    const error=document.getElementById('loginError');error.style.display='none';
    const button=event.currentTarget.querySelector('button');button.disabled=true;
    try{
      const result=await json('/api/platform/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});
      if(result.mustChangePassword){
        const card=document.querySelector('.login-card');
        // 注意：.login-card 本身是 <form id="loginForm">，HTML 禁止 form 嵌套，
        // 故改密卡片用 <div> 而非 <form>，按钮绑定 click 而非 submit。
        card.innerHTML='<div class="eyebrow">INVEST AGENT PLATFORM</div><div class="brand">首次登录需要改密</div><p class="help">请设置一个至少 8 位的新密码，完成后才能进入运营看板。</p><div id="passwordForm"><div class="field"><label for="currentPassword">当前密码</label><input id="currentPassword" type="password" autocomplete="current-password" required /></div><div class="field"><label for="newPassword">新密码</label><input id="newPassword" type="password" autocomplete="new-password" minlength="8" required /></div><div id="passwordError" class="login-error"></div><button class="btn btn-primary" id="passwordSubmit" type="button">更新密码</button></div>';
        document.getElementById('passwordSubmit').addEventListener('click',async()=>{
          const pe_err=document.getElementById('passwordError');pe_err.style.display='none';
          const pe_btn=document.getElementById('passwordSubmit');pe_btn.disabled=true;
          const newPw=document.getElementById('newPassword').value;
          if(newPw.length<8){pe_err.textContent='新密码至少需要 8 位';pe_err.style.display='block';pe_btn.disabled=false;return;}
          try{await json('/api/platform/auth/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:document.getElementById('currentPassword').value,newPassword:newPw})});window.location.reload();}
          catch(pf){pe_err.textContent=pf.message||'密码更新失败';pe_err.style.display='block';pe_btn.disabled=false;}
        });
        return;
      }
      window.location.reload();
    }catch(e){error.textContent=e.message||'账号或密码错误';error.style.display='block';}
    finally{button.disabled=false;}
  });
}`;

// 统一看板客户端运行时：合并 partner 的 loadView 模型 + owner 的路由模型。
// 关键：setView 需同时处理运营视图（loadOpsView 驱动）和管理视图（懒加载 init）。
const DASHBOARD_JS = `
const OPS_VIEWS=['overview','customers','quality','runtime'];
const TITLE_MAP={overview:'运营总览',customers:'客户与助手',quality:'产品质量',runtime:'运行与触达',instances:'用户助手',cost:'成本统计','source-quality':'MCP 工具状态',audit:'日志审计','rule-alerts':'规则巡检'};
const state={loaded:new Set(),customers:[]};
const showError=(message)=>{const el=document.getElementById('notice');el.textContent=message;el.classList.add('show');};
const finishUpdated=(data)=>{const el=document.getElementById('updated');if(el)el.textContent='数据更新时间：'+(data.updatedAt?new Date(data.updatedAt).toLocaleString('zh-CN'):'-');};
const METRIC_LABEL={conversation_success:'对话成功',conversation_error:'对话错误',conversation_timeout:'对话超时',repeat_confirmation:'重复确认',wechat_reachability:'微信可触达',push_delivery:'推送送达',market_data:'行情数据源'};
const metricLabel=(t)=>METRIC_LABEL[t]||t;
const listMetrics=(data)=>{const items=data.items||[];return items.length?'<div class="metric-list">'+items.map((item)=>'<div class="metric-row"><span>'+escape(metricLabel(item.type))+'</span><strong>'+statusBadge(item.status)+' '+escape(item.count)+' 次</strong></div>').join('')+'</div>':'<div class="empty">暂无数据</div>';};
const loadOpsView=async(name)=>{try{if(name==='overview')await loadOverview();if(name==='customers')await loadCustomers();if(name==='quality')await loadQuality();if(name==='runtime')await loadRuntime();state.loaded.add(name);}catch(e){showError(e.message||'数据读取失败');}};
document.getElementById('logout').addEventListener('click',async()=>{await json('/api/platform/auth/logout',{method:'POST'}).catch(()=>{});window.location.reload();});
// 统一 setView：运营视图走 loadOpsView，管理视图走懒加载初始化。
function setView(view){
  const name=VALID_VIEWS.has(view)?view:'overview';
  if(location.hash!=='#'+name){history.replaceState(null,'','#'+name);}
  ACTIVE_VIEW=name;
  document.querySelectorAll('nav a').forEach((a)=>{const v=a.getAttribute('href')&&a.getAttribute('href').slice(1);a.classList.toggle('active',v===name);});
  document.querySelectorAll('.view').forEach((v)=>v.classList.toggle('active',v.id==='view-'+name));
  document.getElementById('title').textContent=TITLE_MAP[name]||'运营总览';
  if(OPS_VIEWS.includes(name)){if(!state.loaded.has(name))loadOpsView(name);return;}
  if(name==='instances'){if(typeof render==='function')render();}
  if(name==='audit'&&!(AUDIT.items||[]).length&&typeof initAuditFromSelection==='function')initAuditFromSelection();
  if(name==='rule-alerts'&&!(RULE_ALERTS.tasks||[]).length&&typeof initRuleAlertsFromSelection==='function')initRuleAlertsFromSelection();
  if(name==='cost'&&!COST.platform&&typeof initCostFromSelection==='function')initCostFromSelection();
  if(name==='source-quality'&&!SOURCE_QUALITY&&typeof loadSourceQuality==='function')loadSourceQuality();
  if(name==='source-quality'&&!MCP_TOOLS&&typeof loadMcpToolsStatus==='function')loadMcpToolsStatus();
}
window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));
`;

// CORE_JS 已不含 setView/renderChrome/启动（由 unified-app 接管），直接注入配置占位即可。
function trimmedCoreJs(): string {
  return CORE_JS.replace("__PLATFORM_CONFIG__", JSON.stringify({ portalPublicUrl: "http://localhost:3100" }));
}

export function renderPlatformPage(options: { role?: "owner" | "partner"; portalPublicUrl?: string } = {}): string {
  const role = options.role || "partner";
  const isAdmin = role === "owner";
  const coreJs = CORE_JS.replace("__PLATFORM_CONFIG__", JSON.stringify({ portalPublicUrl: options.portalPublicUrl || "http://localhost:3100" }));
  // owner 管理视图 JS（instances/source/audit/rules）仅 owner 注入。
  const adminOnlyJs = isAdmin ? `${INSTANCES_JS}${SOURCE_JS}${AUDIT_JS}${RULES_JS}` : "";
  // 成本 JS 双方都注入（partner 看总览大盘，owner 看全部）；IS_PARTNER 控制脱敏分支。
  const costJs = `${COST_JS}`;
  // partner 运营视图 JS 双方都注入（owner 也要看运营视图）。
  const opsJs = `${OVERVIEW_JS}${CUSTOMERS_JS}${QUALITY_JS}${RUNTIME_JS}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>澜策 · 运营看板</title>
  <style>${RESET_CSS}${TOKENS_CSS}${PRIMITIVES_CSS}${SHELL_CSS}${OWNER_CSS}${PARTNER_CSS}</style>
</head>
<body>
${isAdmin ? dashboardShell("owner") : dashboardShell("partner")}
<script>
const authenticated=true;
const IS_PARTNER=${isAdmin ? "false" : "true"};
${SHARED_HELPERS_JS}
${PRICING_JS}
${DOTS_DEF_JS}
${coreJs}
${DASHBOARD_JS}
${opsJs}
${costJs}
${adminOnlyJs}
// 启动：运营总览默认加载（两个角色统一）。
loadOpsView('overview');
${isAdmin ? "if(typeof loadPlatform==='function')loadPlatform();" : ""}
</script>
</body>
</html>`;
}

// 登录壳入口（未认证 / owner 强制改密）。
export function renderLoginShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>澜策 · 运营看板</title>
  <style>${RESET_CSS}${TOKENS_CSS}${PRIMITIVES_CSS}${SHELL_CSS}${OWNER_CSS}${PARTNER_CSS}</style>
</head>
<body>
${loginShell()}
<script>
const authenticated=false;
${SHARED_HELPERS_JS}
${LOGIN_JS}
</script>
</body>
</html>`;
}

// 兼容旧 import 签名：partner-platform-page.ts 委托。
export function renderPartnerPlatformPage(options: { authenticated?: boolean } = {}): string {
  return options.authenticated ? renderPlatformPage({ role: "partner" }) : renderLoginShell();
}
