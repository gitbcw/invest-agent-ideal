// Owner 核心：全局状态 + 通用 helper + 数据加载。
// 注意：setView / renderChrome / 启动调用由统一壳（unified-app.ts）提供，
// 本模块只导出状态、helper 与各视图的数据加载函数（loadPlatform / initAuditFromSelection 等），
// 供统一壳的统一 setView 调用。

export const CORE_JS = `
let DATA={instances:[]};
const PLATFORM_CONFIG=__PLATFORM_CONFIG__;
let selectedInstanceId='';
let AUDIT={users:[],instances:[],items:[],filters:{}};
let AUDIT_ITEM_BY_ID={};
let RULE_ALERTS={users:[],instances:[],tasks:[],events:[],rules:[],filters:{},summary:{}};
let COST={platform:null,scoped:null};
let COST_TAB='overview';
let COST_FILTERS={days:'30'};
let selectedCostInstanceId='';
let SOURCE_QUALITY=null;
let MCP_TOOLS=null;
const VALID_VIEWS=new Set(['overview','customers','quality','runtime','instances','cost','source-quality','audit','diagnostics','rule-alerts']);
let ACTIVE_VIEW='overview';
let AUDIT_SCOPE='conversation';

function esc(value){return String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function fmtTime(value){if(!value)return '-';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN');}
function badge(text,kind='gray'){return '<span class="badge badge-'+kind+'">'+esc(text)+'</span>';}
function fmtNumber(value){const n=Number(value||0);return Number.isFinite(n)?n.toLocaleString('zh-CN'):'0';}
function formatCost(value){const n=Number(value||0);if(!Number.isFinite(n)||n===0)return '-';return '$'+n.toFixed(n<0.01?4:2);}
function stat(value,label){return '<div class="stat"><div class="value">'+esc(value)+'</div><div class="label">'+esc(label)+'</div></div>';}
function metric(value,label){return '<div class="metric"><strong>'+esc(value??0)+'</strong><span>'+esc(label)+'</span></div>';}

let noticeTimer=null;
function showNotice(title,detail='',kind='ok'){const node=document.getElementById('notice');if(!node)return;node.className='notice notice-'+kind;node.innerHTML='<strong>'+esc(title)+'</strong>'+(detail?'<div>'+esc(detail)+'</div>':'');node.style.display='block';if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{node.style.display='none';},3600);}

async function platformJson(url,options={}){const res=await fetch(url,options);const data=await res.json().catch(()=>({}));if(!res.ok||data.ok===false)throw new Error(data.error||data.message||('请求失败: '+res.status));return data;}
function selectedInstance(){return (DATA.instances||[]).find((item)=>item.instanceId===selectedInstanceId);}

async function loadPlatform(){
  const errorEl=document.getElementById('error');
  if(errorEl)errorEl.style.display='none';
  try{
    const res=await fetch('/api/platform/instances');
    DATA=await res.json();
    if(!DATA.ok)throw new Error(DATA.error||'平台接口返回失败');
    selectedInstanceId=selectedInstanceId||DATA.instances?.[0]?.instanceId||'';
    if(ACTIVE_VIEW==='instances'){render();}
    initAuditFromSelection();
    initRuleAlertsFromSelection();
    initCostFromSelection();
    if(ACTIVE_VIEW==='source-quality'&&!SOURCE_QUALITY){loadSourceQuality();}
    if(ACTIVE_VIEW==='source-quality'&&!MCP_TOOLS){loadMcpToolsStatus();}
  }catch(error){if(errorEl){errorEl.textContent='加载失败: '+error.message;errorEl.style.display='block';}}
}
`;
