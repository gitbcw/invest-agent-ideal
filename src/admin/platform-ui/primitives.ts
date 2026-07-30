// Platform UI 共享原子：CSS（组件类）+ JS（客户端 helper）。
// 这些 helper 以 JS 字符串形式注入页面，供视图模块的内联渲染逻辑调用，
// 与原实现的运行时 innerHTML 渲染架构保持一致（SSR 拼 HTML 骨架 + 客户端拉数据后填充）。

// 共享组件 CSS：徽标、统计卡、面板、表格、度量行、空态、按钮、输入、通知、点。
export const PRIMITIVES_CSS = `
.ui-dot{display:inline-block;width:7px;height:7px;border-radius:999px;background:var(--dot);flex:none}
.btn{border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-raised);padding:8px 12px;cursor:pointer;color:var(--ink-soft);font-size:12px;box-shadow:var(--shadow-sm);transition:background .12s,border-color .12s,box-shadow .12s}
.btn:hover{background:var(--surface-inset);border-color:#94a3b8}
.btn:active{background:var(--surface-sunken)}
.btn:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
.btn-primary{border-color:var(--brand);background:var(--brand);color:#fff}
.btn-primary:hover{background:var(--brand-strong);border-color:var(--brand-strong)}
.btn-primary:disabled{background:var(--brand);border-color:var(--brand);opacity:.55}
.btn-danger{border-color:var(--danger);background:var(--danger);color:#fff}
.btn-danger:hover{background:#991b1b;border-color:#991b1b}
.btn-small{padding:6px 10px;font-size:12px}
.input,.select{background:var(--surface-raised);border:1px solid var(--line-strong);color:var(--ink);border-radius:var(--radius-sm);padding:8px 11px;outline:none;transition:border-color .12s,box-shadow .12s}
.input:focus,.select:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-ring)}
.link{border:0;background:transparent;padding:0;color:var(--info);cursor:pointer;font-size:12px}
.link:hover{text-decoration:underline}
.panel{background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm)}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line-soft);background:var(--surface-sunken)}
.panel-head h2{margin:0;font-size:15px;color:var(--ink)}
.panel-head .sub{margin:0}
.panel-body{padding:15px 16px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:var(--gap);margin-bottom:var(--gap)}
.stat{background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--radius);padding:15px;box-shadow:var(--shadow-sm)}
.stat .stat-value{display:block;font-size:24px;line-height:1.05;font-weight:750;color:var(--ink);letter-spacing:-.01em}
.stat .stat-label{display:block;color:var(--muted);font-size:12px;margin-top:8px}
.stat .stat-trend{display:flex;align-items:center;gap:5px;margin-top:8px;font-size:11px}
.stat.signal .stat-value{color:var(--signal-strong)}
.metric-list{display:grid;gap:0}
.metric-row{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:12px;align-items:center}
.metric-row:first-child{padding-top:0}
.metric-row:last-child{border-bottom:0;padding-bottom:0}
.metric-row>span{color:var(--muted)}
.metric-row>strong{color:var(--ink);font-weight:650;display:inline-flex;align-items:center;gap:6px}
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:650;white-space:nowrap;line-height:1.6}
.badge-ok{background:var(--ok-soft);color:var(--ok)}
.badge-warn,.badge-attention{background:var(--warn-soft);color:var(--warn)}
.badge-danger,.badge-blocked{background:var(--danger-soft);color:var(--danger)}
.badge-info{background:var(--info-soft);color:var(--info)}
.badge-gray,.badge-neutral,.badge-observed{background:#f1f5f9;color:#475569}
.note{color:var(--muted);font-size:12px;line-height:1.6;margin:12px 0 0}
.empty{color:#94a3b8;text-align:center;padding:28px 10px;font-size:13px}
.loading{color:var(--muted);font-size:13px;padding:20px 0}
.pagination{display:flex;justify-content:center;padding:14px 0 2px}
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:10px 9px;border-bottom:1px solid var(--line-soft);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:650;background:var(--surface-sunken);position:sticky;top:0}
td{color:var(--ink-soft)}
tbody tr{transition:background .1s}
tbody tr:hover{background:var(--surface-sunken)}
tbody tr:last-child td{border-bottom:0}
.tnum{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-align:right}
.notice{display:none;margin-bottom:var(--gap);border-radius:var(--radius-sm);padding:10px 12px;font-size:12px;line-height:1.55;background:var(--danger-soft);border:1px solid #fecdd3;color:#9f1239}
.notice.show{display:block}
.ui-except{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-inset)}
.ui-except+.ui-except{margin-top:8px}
.ui-except .ex-label{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:13px;font-weight:600}
.ui-except .ex-count{color:var(--muted);font-size:12px}
.ui-except .ex-bar{height:5px;border-radius:999px;background:var(--line-soft);margin-top:6px;overflow:hidden}
.ui-except .ex-bar>i{display:block;height:100%;background:var(--warn);border-radius:999px}`;
