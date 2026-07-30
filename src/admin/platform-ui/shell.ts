// Platform UI 共享布局壳。
// 产出 sidebar/main/topbar 的 CSS + 一个通用的 helper JS 字符串（escape/pct/statusBadge/format）。
// 该 helper JS 注入页面后，各视图模块的内联渲染逻辑可直接调用。

// 布局壳 CSS：shell 双栏、侧栏、导航、顶栏、视图切换。Owner 与 Partner 共享。
export const SHELL_CSS = `
.shell{min-height:100vh;display:grid;grid-template-columns:224px 1fr}
aside.sidebar{background:var(--surface-raised);border-right:1px solid var(--line);padding:22px 14px;display:flex;flex-direction:column}
.brand{color:var(--ink);font-size:16px;font-weight:750;padding:0 8px}
.brand small{display:block;color:var(--muted);font-size:11px;font-weight:400;margin-top:5px}
.nav{display:flex;flex-direction:column;gap:4px;margin-top:24px}
.nav a,.nav button{border:0;background:transparent;border-radius:var(--radius-sm);padding:10px 11px;text-align:left;color:#475569;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:8px;text-decoration:none;transition:background .12s,color .12s}
.nav a:hover,.nav button:hover{background:var(--brand-hover);color:var(--brand-strong)}
.nav a.active,.nav button.active{background:var(--brand-soft);color:var(--brand-strong);font-weight:650}
.nav a .chev,.nav button .chev{color:var(--muted);transition:transform .12s}
.nav a.active .chev,.nav button.active .chev{color:var(--brand);transform:translateX(2px)}
.nav-group{margin-top:18px}
.nav-group:first-of-type{margin-top:24px}
.nav-group-label{font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--muted);padding:0 11px 7px;text-transform:uppercase}
.nav-group .nav-item+.nav-item{margin-top:0}
main.main{min-width:0;padding:var(--gap-lg);min-width:0}
.view{display:none}
.view.active{display:block}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.topbar h1{margin:0;font-size:22px;color:var(--ink);letter-spacing:-.01em}
.topbar .sub{color:var(--muted);font-size:12px;margin-top:6px}
.userbar{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}
@media (max-width:980px){
  .shell{display:block}
  aside.sidebar{border-right:0;border-bottom:1px solid var(--line)}
  .nav{flex-direction:row;overflow:auto;margin-top:16px}
  .nav a,.nav button{white-space:nowrap}
  main.main{padding:18px 14px}
  .topbar{flex-direction:column}
  .stats{grid-template-columns:repeat(2,minmax(120px,1fr))}
}
@media (max-width:520px){
  .stats{grid-template-columns:1fr 1fr;gap:8px}
  .stat .stat-value{font-size:20px}
}`;

// 共享客户端 helper：escape / pct / statusBadge / formatMs / formatNum。
// 状态映射覆盖 Partner 与 Owner 视图所需的全部 status/health/onboarding/push 值。
// 以字符串注入，各视图模块直接调用这些全局函数。
export const SHARED_HELPERS_JS = `
const json=async(url,options)=>{const res=await fetch(url,{credentials:'same-origin',...options});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||'请求失败');return body;};
const escape=(v)=>String(v??'-').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(v)=>v==null?'-':(Number(v)*100).toFixed(1)+'%';
const formatMs=(v)=>{if(v==null)return '-';const n=Number(v);if(!Number.isFinite(n))return '-';if(n<1000)return n+' 毫秒';const s=n/1000;if(s<60)return s.toFixed(1)+' 秒';const m=Math.floor(s/60);const rs=Math.round(s%60);return rs>0?m+' 分 '+rs+' 秒':m+' 分钟';};
const formatNum=(v)=>v==null?'-':v;
const STATUS_TEXT={ok:'正常',attention:'需关注',blocked:'异常',completed:'已完成',drafting:'配置中',committing:'提交中',not_started:'未开始',exception:'异常',active:'运行中',inactive:'未启用',sent:'已送达',awaiting_user:'待用户',delivery_failed:'送达失败',session_expired:'会话失效',wechat_delivery_error:'微信异常',timeout:'超时',observed:'观测中',degraded:'降级',partial:'部分可用',healthy:'健康',watch:'关注',critical:'异常'};
const STATUS_CLS={ok:'ok',attention:'warn',blocked:'danger',completed:'ok',drafting:'info',committing:'info',not_started:'gray',exception:'danger',active:'ok',inactive:'gray',sent:'ok',awaiting_user:'warn',delivery_failed:'danger',session_expired:'danger',wechat_delivery_error:'danger',timeout:'warn',observed:'gray',degraded:'warn',partial:'warn',healthy:'ok',watch:'warn',critical:'danger'};
const statusBadge=(v)=>{const t=STATUS_TEXT[v]||v||'未知';const c=STATUS_CLS[v]||'gray';return '<span class="badge badge-'+c+'">'+escape(t)+'</span>';};
const statCard=(value,label,opts)=>{const signal=opts&&opts.signal?' signal':'';const trend=opts&&opts.trend?'<span class="stat-trend">'+opts.trend+'</span>':'';return '<div class="stat'+signal+'"><span class="stat-value">'+escape(value)+'</span><span class="stat-label">'+label+'</span>'+trend+'</div>';};
const exceptBar=(label,count,total,dotCls)=>{const w=total>0?Math.round(count/total*100):0;return '<div class="ui-except"><div><div class="ex-label">'+dotCls+' '+escape(label)+'</div><div class="ex-bar"><i style="width:'+w+'%"></i></div></div><span class="ex-count">'+escape(count)+' 个客户</span></div>';};`;
