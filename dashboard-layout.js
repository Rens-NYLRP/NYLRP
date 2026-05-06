const LOGO_URL = process.env.SERVER_LOGO_URL || 'https://cdn.discordapp.com/attachments/1363047391263064166/1484556795321122917/image.png';
const SERVER_NAME = process.env.SERVER_NAME || 'NYLRP';
const SERVER_FULL = process.env.SERVER_FULL_NAME || 'New York Liberty Roleplay';

const CSS = `
*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --bg:#0f0f0f;--surface:#171717;--surface2:#1e1e1e;--surface3:#242424;
  --border:#2a2a2a;--border2:#333;
  --accent:#00e5a0;--accent-dim:rgba(0,229,160,.1);--accent-border:rgba(0,229,160,.25);
  --text:#e8e8e8;--text2:#aaa;--muted:#666;
  --danger:#ff4757;--danger-dim:rgba(255,71,87,.1);
  --warn:#ffa502;--warn-dim:rgba(255,165,2,.1);
  --success:#2ed573;--success-dim:rgba(46,213,115,.1);
  --blue:#5865F2;--blue-dim:rgba(88,101,242,.1);
  --purple:#9b59b6;--purple-dim:rgba(155,89,182,.1);
  --sb-width:230px;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;font-size:14px;line-height:1.5;}
a{text-decoration:none;color:inherit;}
button{cursor:pointer;}
/* ── Sidebar ── */
.sidebar{width:var(--sb-width);background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:200;overflow-y:auto;}
.sb-top{padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;}
.sb-logo{width:38px;height:38px;border-radius:10px;object-fit:cover;flex-shrink:0;}
.sb-logo-fallback{width:38px;height:38px;border-radius:10px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#000;flex-shrink:0;}
.sb-name{font-size:14px;font-weight:700;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sb-sub{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sb-nav{flex:1;padding:8px 0;}
.sb-section{padding:12px 14px 4px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:700;}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;margin:1px 8px;border-radius:8px;color:var(--text2);font-size:13px;font-weight:500;transition:all .15s;border:1px solid transparent;white-space:nowrap;}
.nav-item:hover{background:var(--surface2);color:var(--text);}
.nav-item.active{background:var(--accent-dim);color:var(--accent);border-color:var(--accent-border);}
.nav-item .ni{width:18px;text-align:center;font-size:15px;flex-shrink:0;}
.nav-badge{margin-left:auto;background:var(--danger);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;}
.sb-footer{padding:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.sb-av{width:30px;height:30px;border-radius:50%;flex-shrink:0;}
.sb-un{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;}
.sb-ut{font-size:10px;color:var(--muted);}
.sb-logout{margin-left:auto;color:var(--muted);font-size:18px;transition:color .15s;padding:4px;}
.sb-logout:hover{color:var(--danger);}
/* ── Main ── */
.main{margin-left:var(--sb-width);flex:1;display:flex;flex-direction:column;min-width:0;}
.topbar{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface);position:sticky;top:0;z-index:100;}
.tb-left{display:flex;align-items:center;gap:12px;}
.tb-title{font-size:16px;font-weight:600;}
.tb-right{display:flex;align-items:center;gap:10px;}
.live-pill{display:inline-flex;align-items:center;gap:5px;background:var(--success-dim);color:var(--success);padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.content{flex:1;padding:22px;max-width:1600px;}
/* ── Alert ── */
.alert{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:13px;display:flex;align-items:center;gap:8px;font-weight:500;}
.alert-s{background:var(--success-dim);border:1px solid rgba(46,213,115,.3);color:var(--success);}
.alert-e{background:var(--danger-dim);border:1px solid rgba(255,71,87,.3);color:var(--danger);}
/* ── Stats ── */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px;}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;transition:border-color .2s;}
.stat:hover{border-color:var(--border2);}
.stat-icon{font-size:20px;margin-bottom:8px;}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;font-weight:600;margin-bottom:4px;}
.stat-value{font-size:26px;font-weight:700;color:var(--accent);line-height:1;}
.stat-sub{font-size:11px;color:var(--muted);margin-top:4px;}
.stat-active{border-color:var(--accent-border);background:var(--accent-dim);}
/* ── Panel ── */
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:18px;}
.panel-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;}
.panel-title{font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px;}
.panel-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.panel-body{padding:16px;}
/* ── Table ── */
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;white-space:nowrap;}
th{padding:10px 16px;text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;border-bottom:1px solid var(--border);font-weight:700;background:var(--surface2);}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle;}
td.wrap{white-space:normal;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,.015);}
/* ── Badge ── */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap;}
.bg{background:var(--success-dim);color:var(--success);}
.br{background:var(--danger-dim);color:var(--danger);}
.by{background:var(--warn-dim);color:var(--warn);}
.bb{background:var(--blue-dim);color:var(--blue);}
.ba{background:var(--accent-dim);color:var(--accent);}
.bp{background:var(--purple-dim);color:var(--purple);}
/* ── Buttons ── */
.btn{padding:8px 16px;border-radius:8px;border:none;font-size:12px;font-weight:700;transition:all .2s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
.btn:hover{opacity:.85;transform:translateY(-1px);}
.btn-accent{background:var(--accent);color:#000;}
.btn-danger{background:var(--danger);color:#fff;}
.btn-ghost{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border);}
.btn-ghost:hover{background:rgba(255,255,255,.1);}
.btn-sm{padding:5px 11px;font-size:11px;}
.btn-block{width:100%;justify-content:center;padding:11px;}
/* ── Forms ── */
.fg{margin-bottom:13px;}
.fg label{display:block;font-size:12px;color:var(--text2);margin-bottom:5px;font-weight:600;}
.fg input,.fg select,.fg textarea{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 13px;color:var(--text);font-size:13px;outline:none;transition:border-color .15s;font-family:inherit;}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--accent);}
.fg select option{background:var(--surface2);}
.form-row{display:flex;gap:10px;align-items:flex-end;}
.form-row .fg{margin-bottom:0;flex:1;}
/* ── Grid ── */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
.g12{display:grid;grid-template-columns:1fr 2fr;gap:16px;}
.g21{display:grid;grid-template-columns:2fr 1fr;gap:16px;}
@media(max-width:1100px){.g2,.g3,.g12,.g21{grid-template-columns:1fr;}}
/* ── Log list ── */
.loglist{max-height:500px;overflow-y:auto;}
.logitem{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.03);transition:background .1s;}
.logitem:last-child{border-bottom:none;}
.logitem:hover{background:rgba(255,255,255,.015);}
.logitem-icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
.logitem-body{flex:1;min-width:0;}
.logitem-title{font-size:13px;font-weight:600;}
.logitem-meta{font-size:12px;color:var(--muted);margin-top:2px;}
.logitem-time{font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
/* ── Player card ── */
.player-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:14px;}
.player-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;align-items:center;gap:10px;transition:border-color .15s;}
.player-card:hover{border-color:var(--accent-border);}
.player-icon{width:32px;height:32px;border-radius:8px;background:var(--surface3);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
.player-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.player-team{font-size:10px;color:var(--muted);margin-top:1px;}
/* ── Misc ── */
.empty{padding:40px;text-align:center;color:var(--muted);font-size:13px;}
.empty-icon{font-size:32px;margin-bottom:10px;}
code{background:var(--surface2);padding:2px 6px;border-radius:5px;font-size:12px;font-family:'SF Mono',Consolas,monospace;color:var(--accent);}
.divider{height:1px;background:var(--border);margin:16px 0;}
.tag{display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--text2);}
.search-bar{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 13px;margin-bottom:14px;}
.search-bar input{background:none;border:none;outline:none;color:var(--text);font-size:13px;flex:1;font-family:inherit;}
.puncard{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:13px;margin-bottom:8px;}
.puncard-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;}
.puncard-user{font-weight:700;font-size:13px;}
.puncard-meta{font-size:12px;color:var(--muted);line-height:1.6;}
.shift-row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.03);}
.shift-row:last-child{border-bottom:none;}
.shift-av{width:30px;height:30px;border-radius:50%;background:var(--surface3);flex-shrink:0;}
.shift-name{font-size:13px;font-weight:600;}
.shift-time{font-size:12px;color:var(--muted);}
.progress{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px;}
.progress-fill{height:100%;background:var(--accent);border-radius:3px;}
.perm-check{display:flex;align-items:center;gap:8px;padding:6px 0;}
.perm-check input{width:16px;height:16px;accent-color:var(--accent);}
.perm-check label{font-size:13px;color:var(--text2);}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px;}
@media(max-width:768px){.sidebar{transform:translateX(-100%);transition:transform .3s;}.sidebar.open{transform:none;}.main{margin-left:0;}.stats{grid-template-columns:1fr 1fr;}}
`;

const NAV_ITEMS = [
  { id: 'panel',       icon: '🖥️',  label: 'Panel',           section: 'Main' },
  { id: 'shift',       icon: '⏱️',  label: 'Shifts',          section: null },
  { id: 'loa',         icon: '🏖️',  label: 'LOA / RA',        section: null },
  { id: 'punishments', icon: '🔨',  label: 'Punishments',     section: 'Moderation' },
  { id: 'infractions', icon: '⚖️',  label: 'Infractions',    section: null },
  { id: 'members',     icon: '👥',  label: 'Members',         section: null },
  { id: 'search',      icon: '🔍',  label: 'Search Player',   section: null },
  { id: 'erlclogs',    icon: '📡',  label: 'ER:LC Logs',      section: 'ER:LC' },
  { id: 'ingame',      icon: '🎮',  label: 'In-Game',         section: null },
  { id: 'sessions',    icon: '📈',  label: 'Sessions',        section: null },
  { id: 'activity',    icon: '📊',  label: 'Activity',        section: 'Reports' },
  { id: 'logs',        icon: '📋',  label: 'Audit Logs',      section: null },
  { id: 'roles',       icon: '🔐',  label: 'Dashboard Roles', section: 'Settings' },
  { id: 'settings',    icon: '⚙️',  label: 'Settings',        section: null },
];

function fmt(ms) {
  if (!ms || ms < 0) return '0m';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) { const d = Math.floor(h/24), rh = h%24; return `${d}d ${rh}h`; }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function flash(req) {
  const s = req.query.success, e = req.query.error;
  if (s) return `<div class="alert alert-s">✅ ${decodeURIComponent(s)}</div>`;
  if (e) return `<div class="alert alert-e">❌ ${decodeURIComponent(e)}</div>`;
  return '';
}

function layout(user, page, content, flashHtml = '') {
  let navHtml = '';
  let lastSection = null;
  for (const n of NAV_ITEMS) {
    if (n.section && n.section !== lastSection) {
      navHtml += `<div class="sb-section">${n.section}</div>`;
      lastSection = n.section;
    }
    navHtml += `<a href="/${n.id}" class="nav-item${page===n.id?' active':''}"><span class="ni">${n.icon}</span>${n.label}</a>`;
  }
  const av = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;
  const cur = NAV_ITEMS.find(n => n.id === page);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVER_NAME} Dashboard — ${cur?.label ?? 'Dashboard'}</title>
<style>${CSS}</style>
</head>
<body>
<div class="sidebar" id="sidebar">
  <div class="sb-top">
    <img class="sb-logo" src="${LOGO_URL}" onerror="this.style.display='none';document.getElementById('logo-fallback').style.display='flex'" alt="Logo">
    <div class="sb-logo-fallback" id="logo-fallback" style="display:none">N</div>
    <div><div class="sb-name">${SERVER_NAME}</div><div class="sb-sub">${SERVER_FULL}</div></div>
  </div>
  <div class="sb-nav">${navHtml}</div>
  <div class="sb-footer">
    <img class="sb-av" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
    <div><div class="sb-un">${user.username}</div><div class="sb-ut">Staff</div></div>
    <a href="/logout" class="sb-logout" title="Logout">↩</a>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <div class="tb-left">
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('sidebar').classList.toggle('open')" style="display:none" id="mob-menu">☰</button>
      <div class="tb-title">${cur?.icon ?? ''} ${cur?.label ?? 'Dashboard'}</div>
    </div>
    <div class="tb-right">
      <span class="live-pill"><span class="live-dot"></span>Live</span>
    </div>
  </div>
  <div class="content">
    ${flashHtml}
    ${content}
  </div>
</div>
<script>
if(window.innerWidth<=768){document.getElementById('mob-menu').style.display='flex';}
${page==='panel'||page==='ingame'?'setTimeout(()=>location.reload(),30000);':''}
${page==='shift'?'setInterval(()=>{const el=document.getElementById("shift-timer");if(el){const start=parseInt(el.dataset.start);if(start){const diff=Date.now()-start;const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);el.textContent=(h>0?h+"h ":"")+m+"m "+s+"s";}}},1000);':''}
</script>
</body>
</html>`;
}

module.exports = { CSS, NAV_ITEMS, fmt, timeAgo, flash, layout, LOGO_URL, SERVER_NAME };
