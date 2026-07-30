// Owner 后台组件 CSS。
// 策略：保留原 platform-page.ts 全部类名（JS 深度引用，改类名=回归风险），
// 仅把硬编码色值替换为澜策设计令牌（var(--xxx)），并补齐交互态。
// 与共享层 primitives.ts 的组件类（.panel/.badge/.stat/.btn/.table 等）复用，此处只放 owner 专属类。

export const OWNER_CSS = `
/* owner topbar / actions（owner 旧版结构，区别于共享 .userbar）*/
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.form-grid{display:grid;gap:10px}
.field label{display:block;color:var(--muted);font-size:12px;margin-bottom:5px}
.field input{width:100%;box-sizing:border-box;background:var(--surface-raised);border:1px solid var(--line-strong);color:var(--ink);border-radius:var(--radius-sm);padding:8px 10px;outline:none}
.field input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-ring)}
.ops{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.modal-backdrop{position:fixed;inset:0;background:rgba(14,34,54,.32);display:none;align-items:center;justify-content:center;padding:18px;z-index:20}
.modal{width:min(520px,100%);background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow-md)}
.modal h2{margin:0 0 12px;color:var(--ink);font-size:15px}
.input{background:var(--surface-raised);border:1px solid var(--line-strong);color:var(--ink);border-radius:var(--radius-sm);padding:7px 10px;min-width:230px;outline:none}
.input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-ring)}
.select{background:var(--surface-raised);border:1px solid var(--line-strong);color:var(--ink);border-radius:var(--radius-sm);padding:7px 10px;width:100%;outline:none}
.grid{display:grid;grid-template-columns:minmax(360px,.92fr) minmax(420px,1.08fr);gap:var(--gap);align-items:start}
.audit-grid{display:grid;grid-template-columns:300px 1fr;gap:var(--gap);align-items:start}
.view.audit-grid{display:none}
.view.audit-grid.active{display:grid}
.cost-grid{display:grid;grid-template-columns:1fr;gap:var(--gap);align-items:start}
.view.cost-grid{display:none}
.view.cost-grid.active{display:grid}
/* owner 专属统计卡密度（用共享 .stat 但 owner 旧版有更紧凑布局）*/
.owner-stats{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px;margin-bottom:16px}
.instance-list{display:flex;flex-direction:column;gap:9px}
.instance-card{border:1px solid var(--line);background:var(--surface-raised);border-radius:var(--radius);padding:11px;cursor:pointer;transition:border-color .12s,background .12s,box-shadow .12s}
.instance-card:hover{background:var(--surface-sunken);border-color:#9db3d1}
.instance-card.selected{background:var(--brand-soft);border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.22)}
.row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.name{color:var(--ink);font-weight:650;font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;color:var(--muted);word-break:break-all}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.metric{background:var(--surface-inset);border:1px solid var(--line-soft);border-radius:var(--radius-sm);padding:7px}
.metric strong{display:block;color:var(--ink);font-size:14px;line-height:1}
.metric span{display:block;color:var(--muted);font-size:11px;margin-top:5px}
.kv{display:grid;grid-template-columns:118px 1fr;gap:8px 12px;margin:0}
.kv dt{color:var(--muted);font-size:12px}
.kv dd{margin:0;color:var(--ink-soft);font-size:12px;word-break:break-word}
.section{margin-top:14px}
.section h3{margin:0 0 8px;color:var(--ink);font-size:13px}
.list{display:flex;flex-direction:column;gap:7px}
.item{background:var(--surface-inset);border:1px solid var(--line-soft);border-radius:var(--radius-sm);padding:9px}
.item-line{display:flex;justify-content:space-between;gap:10px;color:var(--ink-soft);font-size:12px}
.error{background:var(--danger-soft);border:1px solid #fda4af;color:var(--danger);border-radius:var(--radius);padding:12px;font-size:13px;margin-bottom:14px;display:none}
/* owner 旧版 .stat 结构与新令牌 .stat 兼容（value/label 而非 stat-value/stat-label）*/
.stat .value{color:var(--ink);font-size:24px;font-weight:750;line-height:1}
.stat .label{color:var(--muted);font-size:12px;margin-top:8px}
/* 浮动通知（owner 用 fixed notice，区别于 partner 的 inline notice）*/
.notice{position:fixed;right:22px;bottom:22px;z-index:30;min-width:260px;max-width:min(420px,calc(100vw - 44px));border:1px solid var(--line);border-radius:var(--radius);padding:11px 13px;box-shadow:var(--shadow-md);font-size:13px;line-height:1.45;display:none}
.notice strong{display:block;color:var(--ink);font-size:13px;margin-bottom:3px}
.notice-ok{border-color:#bbf7d0;background:var(--ok-soft);color:var(--ok)}
.notice-warn{border-color:#fde68a;background:var(--warn-soft);color:var(--warn)}
.notice-error{border-color:#fecdd3;background:var(--danger-soft);color:var(--danger)}
/* cost-table 复用共享 table 样式，补 owner 专属表头 */
.cost-table{width:100%;border-collapse:collapse;font-size:12px}
.cost-table th,.cost-table td{border-bottom:1px solid var(--line-soft);padding:9px 8px;text-align:right;white-space:nowrap}
.cost-table th:first-child,.cost-table td:first-child{text-align:left;white-space:normal}
.cost-table th{color:var(--muted);font-weight:650;background:var(--surface-sunken)}
.cost-table td{color:var(--ink-soft)}
.cost-table tr:last-child td{border-bottom:0}
.cost-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
.cost-summary .stat,.owner-stats .stat{border:1px solid var(--line);border-radius:var(--radius);padding:14px;box-shadow:var(--shadow-sm);background:var(--surface-raised)}
.cost-source{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line-soft);margin:-2px 0 14px}
.tab{border:0;background:transparent;color:var(--muted);padding:9px 10px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{color:var(--brand-strong);border-bottom-color:var(--brand);font-weight:700}
.tab:hover{color:var(--brand-strong)}
.cost-toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:10px;padding:0 0 12px;margin-bottom:12px;border-bottom:1px solid var(--line-soft)}
.cost-toolbar .field{min-width:150px}
/* segmented（audit scope 切换）*/
.segmented{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--surface-inset);border:1px solid var(--line);border-radius:var(--radius);padding:4px}
.segment{border:0;background:transparent;color:#475569;border-radius:6px;padding:7px 8px;font-size:12px;cursor:pointer}
.segment.active{background:var(--surface-raised);color:var(--brand-strong);font-weight:650;box-shadow:var(--shadow-sm)}
/* audit 时间线 */
.audit-list{display:flex;flex-direction:column;gap:10px}
.audit-item{display:grid;grid-template-columns:132px 1fr;border:1px solid var(--line);background:var(--surface-raised);border-radius:var(--radius);overflow:hidden}
.audit-rail{background:var(--surface-inset);border-right:1px solid var(--line-soft);padding:12px}
.audit-time{color:var(--ink);font-size:12px;font-weight:650;line-height:1.35}
.audit-date{color:var(--muted);font-size:11px;margin-top:3px}
.audit-status{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.audit-main{min-width:0;padding:12px 13px}
.audit-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.audit-title{min-width:0}
.audit-title-row{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.audit-summary{color:var(--ink-soft);font-size:13px;line-height:1.5;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.audit-meta{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;color:var(--muted);font-size:11px}
.audit-meta span{background:var(--surface-inset);border:1px solid var(--line-soft);border-radius:999px;padding:2px 7px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.audit-section{margin-top:11px}
.audit-section-title{color:var(--muted);font-size:11px;font-weight:650;margin-bottom:5px}
.audit-text{white-space:pre-wrap;word-break:break-word;background:var(--surface-sunken);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px;max-height:190px;overflow:auto;color:#243447;font-size:12px;line-height:1.55}
.audit-text.primary{background:var(--brand-soft);border-color:#bfd4f5;color:var(--ink);font-size:13px}
.audit-details{margin-top:10px;border-top:1px solid var(--line-soft);padding-top:8px}
.audit-details summary{cursor:pointer;color:#475569;font-size:12px;font-weight:650}
.audit-columns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.audit-error{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.kv-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
.kv-table th,.kv-table td{border-bottom:1px solid var(--line-soft);padding:6px 8px;text-align:left}
.kv-table th{color:var(--muted);font-weight:650;background:var(--surface-sunken)}
.kv-table tr:last-child td{border-bottom:0}
#investmentStatePanel details{margin-top:6px}
#investmentStatePanel summary{cursor:pointer;color:#475569;font-size:12px;font-weight:650}
.log{white-space:pre-wrap;word-break:break-word;background:var(--surface-inset);color:var(--ink-soft);border:1px solid var(--line-soft);border-radius:var(--radius);padding:10px;max-height:160px;overflow:auto;font-size:12px}
.qr-box{margin-top:10px;display:none;gap:8px;justify-items:start}
.qr-box img{width:220px;max-width:100%;border:1px solid var(--line);border-radius:var(--radius);background:#fff}
@media (max-width:980px){
  .shell{display:block}
  aside.sidebar{border-right:0;border-bottom:1px solid var(--line)}
  .nav{flex-direction:row;overflow:auto}
  main.main{padding:18px 14px}
  .topbar{flex-direction:column}
  .owner-stats,.cost-summary,.stats{grid-template-columns:repeat(2,minmax(120px,1fr))}
  .grid,.audit-grid,.cost-grid{grid-template-columns:1fr}
  .audit-item{grid-template-columns:1fr}
  .audit-rail{border-right:0;border-bottom:1px solid var(--line-soft);display:flex;justify-content:space-between;gap:12px}
  .audit-columns{grid-template-columns:1fr}
  .input{min-width:0;width:100%}
}`;
