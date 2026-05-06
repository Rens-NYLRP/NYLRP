const LOGO_URL = process.env.SERVER_LOGO_URL || 'https://cdn.discordapp.com/attachments/1363047391263064166/1484556795321122917/image.png';
const SERVER_NAME = process.env.SERVER_NAME || 'NYLRP';
const SERVER_FULL = process.env.SERVER_FULL_NAME || 'New York Liberty Roleplay';

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --bg:#0a0a0b;
  --surface:#111113;
  --surface2:#18181c;
  --surface3:#1e1e24;
  --surface4:#242430;
  --border:#ffffff0d;
  --border2:#ffffff14;
  --border3:#ffffff1f;
  --accent:#00e5a0;
  --accent2:#00c584;
  --accent-dim:rgba(0,229,160,.08);
  --accent-border:rgba(0,229,160,.2);
  --accent-glow:rgba(0,229,160,.15);
  --text:#f0f0f5;
  --text2:#9191a4;
  --muted:#5a5a6e;
  --danger:#ff4060;
  --danger-dim:rgba(255,64,96,.1);
  --danger-border:rgba(255,64,96,.2);
  --warn:#f59e0b;
  --warn-dim:rgba(245,158,11,.1);
  --warn-border:rgba(245,158,11,.2);
  --success:#10d488;
  --success-dim:rgba(16,212,136,.1);
  --blue:#5b8af5;
  --blue-dim:rgba(91,138,245,.1);
  --blue-border:rgba(91,138,245,.2);
  --purple:#a78bfa;
  --purple-dim:rgba(167,139,250,.1);
  --orange:#fb923c;
  --orange-dim:rgba(251,146,60,.1);
  --sb-width:240px;
  --radius:10px;
  --radius-lg:14px;
  --radius-xl:18px;
}
body{background:var(--bg);color:var(--text);font-family:'Plus Jakarta Sans',system-ui,sans-serif;display:flex;min-height:100vh;font-size:14px;line-height:1.5;overflow-x:hidden;}
a{text-decoration:none;color:inherit;}
button,input,select,textarea{font-family:inherit;}
button{cursor:pointer;}

/* ── Sidebar ── */
.sidebar{
  width:var(--sb-width);
  background:var(--surface);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;
  position:fixed;top:0;left:0;height:100vh;
  z-index:200;overflow-y:auto;
}
.sb-top{
  padding:18px 16px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px;
  flex-shrink:0;
}
.sb-logo{width:34px;height:34px;border-radius:9px;object-fit:cover;flex-shrink:0;}
.sb-logo-fallback{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#000;flex-shrink:0;}
.sb-name{font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.2px;}
.sb-sub{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.sb-nav{flex:1;padding:8px 0 8px;}
.sb-section{padding:16px 14px 5px;font-size:9.5px;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);font-weight:700;}
.nav-item{
  display:flex;align-items:center;gap:9px;
  padding:7px 10px;margin:1px 8px;
  border-radius:8px;color:var(--text2);
  font-size:12.5px;font-weight:500;
  transition:all .15s;border:1px solid transparent;
  white-space:nowrap;
}
.nav-item:hover{background:var(--surface2);color:var(--text);}
.nav-item.active{background:var(--accent-dim);color:var(--accent);border-color:var(--accent-border);}
.nav-item .ni{width:16px;text-align:center;font-size:14px;flex-shrink:0;opacity:.8;}
.nav-item.active .ni{opacity:1;}
.nav-badge{margin-left:auto;background:var(--danger);color:#fff;font-size:9px;font-weight:800;padding:1px 6px;border-radius:20px;min-width:18px;text-align:center;}
.sb-footer{
  padding:10px 12px;
  border-top:1px solid var(--border);
  display:flex;align-items:center;gap:10px;flex-shrink:0;
  background:var(--surface);
}
.sb-av{width:28px;height:28px;border-radius:50%;flex-shrink:0;border:1.5px solid var(--border2);}
.sb-un{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;}
.sb-ut{font-size:10px;color:var(--muted);margin-top:1px;}
.sb-logout{margin-left:auto;color:var(--muted);font-size:14px;transition:color .15s;padding:5px;border-radius:6px;line-height:1;}
.sb-logout:hover{color:var(--danger);background:var(--danger-dim);}

/* ── Main ── */
.main{margin-left:var(--sb-width);flex:1;display:flex;flex-direction:column;min-width:0;}
.topbar{
  padding:10px 24px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  background:var(--surface);
  position:sticky;top:0;z-index:100;
  backdrop-filter:blur(12px);
}
.tb-left{display:flex;align-items:center;gap:12px;}
.tb-title{font-size:14px;font-weight:700;letter-spacing:-.2px;}
.tb-right{display:flex;align-items:center;gap:8px;}
.live-pill{
  display:inline-flex;align-items:center;gap:5px;
  background:var(--success-dim);color:var(--success);
  padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;
  border:1px solid rgba(16,212,136,.2);
}
.live-dot{width:5px;height:5px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.content{flex:1;padding:20px 24px;max-width:1700px;}

/* ── Alerts ── */
.alert{padding:11px 16px;border-radius:var(--radius);margin-bottom:16px;font-size:12.5px;display:flex;align-items:center;gap:8px;font-weight:600;}
.alert-s{background:var(--success-dim);border:1px solid rgba(16,212,136,.25);color:var(--success);}
.alert-e{background:var(--danger-dim);border:1px solid var(--danger-border);color:var(--danger);}
.alert-w{background:var(--warn-dim);border:1px solid var(--warn-border);color:var(--warn);}

/* ── Stats ── */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-bottom:18px;}
.stat{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:14px 16px;
  transition:border-color .2s,transform .2s;
  position:relative;overflow:hidden;
}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent-glow),transparent);opacity:0;transition:opacity .2s;}
.stat:hover{border-color:var(--border2);transform:translateY(-1px);}
.stat:hover::before{opacity:1;}
.stat-icon{font-size:18px;margin-bottom:10px;display:block;}
.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin-bottom:3px;}
.stat-value{font-size:24px;font-weight:800;color:var(--text);line-height:1;letter-spacing:-1px;}
.stat-sub{font-size:10px;color:var(--muted);margin-top:4px;}
.stat-active{border-color:var(--accent-border)!important;background:var(--accent-dim)!important;}
.stat-active .stat-value{color:var(--accent);}

/* ── Panel ── */
.panel{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  overflow:hidden;margin-bottom:14px;
}
.panel-header{
  padding:12px 16px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;gap:12px;
}
.panel-title{font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:7px;letter-spacing:-.1px;}
.panel-body{padding:16px;}

/* ── Table ── */
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;white-space:nowrap;}
th{
  padding:9px 14px;text-align:left;
  font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.8px;
  border-bottom:1px solid var(--border);font-weight:700;
  background:var(--surface2);
}
td{
  padding:9px 14px;font-size:12.5px;
  border-bottom:1px solid var(--border);
  vertical-align:middle;
}
td.wrap{white-space:normal;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,.012);}
code{
  background:var(--surface3);padding:2px 7px;
  border-radius:5px;font-size:11px;
  font-family:'JetBrains Mono',monospace;
  color:var(--accent);border:1px solid var(--border2);
}

/* ── Badges ── */
.badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:2px 8px;border-radius:20px;
  font-size:10px;font-weight:700;white-space:nowrap;
  letter-spacing:.2px;
}
.bg{background:var(--success-dim);color:var(--success);border:1px solid rgba(16,212,136,.2);}
.br{background:var(--danger-dim);color:var(--danger);border:1px solid var(--danger-border);}
.by{background:var(--warn-dim);color:var(--warn);border:1px solid var(--warn-border);}
.bb{background:var(--blue-dim);color:var(--blue);border:1px solid var(--blue-border);}
.ba{background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent-border);}
.bp{background:var(--purple-dim);color:var(--purple);border:1px solid rgba(167,139,250,.2);}
.bo{background:var(--orange-dim);color:var(--orange);border:1px solid rgba(251,146,60,.2);}

/* ── Buttons ── */
.btn{
  padding:7px 14px;border-radius:8px;border:none;
  font-size:12px;font-weight:700;
  transition:all .15s;
  display:inline-flex;align-items:center;gap:6px;
  white-space:nowrap;letter-spacing:-.1px;
}
.btn:hover{transform:translateY(-1px);opacity:.9;}
.btn:active{transform:translateY(0);}
.btn-accent{background:var(--accent);color:#000;}
.btn-accent:hover{background:var(--accent2);opacity:1;}
.btn-danger{background:var(--danger);color:#fff;}
.btn-blue{background:var(--blue);color:#fff;}
.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border2);}
.btn-ghost:hover{background:var(--surface3);opacity:1;}
.btn-sm{padding:4px 10px;font-size:11px;}
.btn-block{width:100%;justify-content:center;padding:10px;}

/* ── Forms ── */
.fg{margin-bottom:12px;}
.fg label{display:block;font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:700;letter-spacing:.2px;text-transform:uppercase;}
.fg input,.fg select,.fg textarea{
  width:100%;background:var(--surface2);
  border:1px solid var(--border2);border-radius:8px;
  padding:8px 12px;color:var(--text);font-size:13px;
  outline:none;transition:border-color .15s,box-shadow .15s;
  font-family:inherit;
}
.fg input:focus,.fg select:focus,.fg textarea:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-dim);
}
.fg select option{background:var(--surface2);}
.form-row{display:flex;gap:10px;align-items:flex-end;}
.form-row .fg{margin-bottom:0;flex:1;}

/* ── Grid layouts ── */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}
.g12{display:grid;grid-template-columns:1fr 2fr;gap:14px;}
.g21{display:grid;grid-template-columns:2fr 1fr;gap:14px;}
.g13{display:grid;grid-template-columns:1fr 3fr;gap:14px;}
@media(max-width:1200px){.g2,.g3,.g12,.g21,.g13{grid-template-columns:1fr;}}

/* ── Log list ── */
.loglist{max-height:480px;overflow-y:auto;}
.logitem{display:flex;align-items:flex-start;gap:11px;padding:10px 14px;border-bottom:1px solid var(--border);transition:background .1s;}
.logitem:last-child{border-bottom:none;}
.logitem:hover{background:rgba(255,255,255,.012);}
.logitem-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;background:var(--surface2);}
.logitem-body{flex:1;min-width:0;}
.logitem-title{font-size:12.5px;font-weight:600;}
.logitem-meta{font-size:11px;color:var(--muted);margin-top:2px;}
.logitem-time{font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;margin-top:2px;}

/* ── Player cards ── */
.player-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:8px;padding:12px;}
.player-card{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius);padding:10px;
  display:flex;align-items:center;gap:9px;
  transition:border-color .15s,transform .15s;
}
.player-card:hover{border-color:var(--accent-border);transform:translateY(-1px);}
.player-icon{width:30px;height:30px;border-radius:7px;background:var(--surface3);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;}
.player-name{font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.player-team{font-size:10px;color:var(--muted);margin-top:1px;}

/* ── Punishment cards ── */
.puncard{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;transition:border-color .15s;}
.puncard:hover{border-color:var(--border2);}
.puncard-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;}
.puncard-user{font-weight:700;font-size:12.5px;}
.puncard-meta{font-size:11px;color:var(--muted);line-height:1.7;}

/* ── Shift rows ── */
.shift-row{display:flex;align-items:center;gap:11px;padding:9px 14px;border-bottom:1px solid var(--border);}
.shift-row:last-child{border-bottom:none;}
.shift-av{width:28px;height:28px;border-radius:50%;background:var(--surface3);flex-shrink:0;}
.shift-name{font-size:12.5px;font-weight:600;}
.shift-time{font-size:11px;color:var(--muted);}

/* ── Search bar ── */
.search-bar{
  display:flex;align-items:center;gap:8px;
  background:var(--surface);border:1px solid var(--border2);
  border-radius:var(--radius);padding:8px 12px;margin-bottom:12px;
  transition:border-color .15s,box-shadow .15s;
}
.search-bar:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim);}
.search-bar input{background:none;border:none;outline:none;color:var(--text);font-size:13px;flex:1;font-family:inherit;}

/* ── Permissions checkboxes ── */
.perm-check{display:flex;align-items:center;gap:8px;padding:6px 0;}
.perm-check input{width:15px;height:15px;accent-color:var(--accent);}
.perm-check label{font-size:12.5px;color:var(--text2);}

/* ── Misc ── */
.empty{padding:36px;text-align:center;color:var(--muted);font-size:13px;}
.empty-icon{font-size:28px;margin-bottom:10px;opacity:.5;}
.divider{height:1px;background:var(--border);margin:14px 0;}
.progress{height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px;}
.progress-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .5s ease;}

/* ── Chat bubbles ── */
.chat-msg{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px;}
.chat-msg:last-child{border-bottom:none;}
.chat-header{display:flex;align-items:center;justify-content:space-between;}
.chat-player{font-size:12px;font-weight:700;color:var(--accent);}
.chat-time{font-size:10px;color:var(--muted);}
.chat-text{font-size:12.5px;color:var(--text2);}
.chat-team-tag{font-size:9px;padding:1px 6px;border-radius:4px;margin-left:6px;font-weight:700;}

/* ── BOLO card ── */
.bolo-card{background:var(--surface2);border:1px solid var(--danger-border);border-radius:var(--radius);padding:13px;margin-bottom:8px;}
.bolo-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
.bolo-name{font-weight:800;font-size:13px;color:var(--danger);}
.bolo-meta{font-size:11px;color:var(--muted);line-height:1.7;}

/* ── Mod panel layout ── */
.mod-grid{display:grid;grid-template-columns:280px 1fr 320px;gap:14px;height:calc(100vh - 90px);}
.mod-col{display:flex;flex-direction:column;gap:14px;overflow-y:auto;padding-bottom:14px;}
@media(max-width:1300px){.mod-grid{grid-template-columns:1fr 1fr;}}
@media(max-width:900px){.mod-grid{grid-template-columns:1fr;}}

/* ── Live feed ── */
.feed-item{
  padding:10px 14px;border-bottom:1px solid var(--border);
  display:flex;align-items:flex-start;gap:10px;
  font-size:12px;animation:slideIn .3s ease;
}
@keyframes slideIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
.feed-item:last-child{border-bottom:none;}
.feed-icon{font-size:13px;flex-shrink:0;margin-top:1px;}
.feed-text{flex:1;color:var(--text2);}
.feed-text b{color:var(--text);}
.feed-time{font-size:10px;color:var(--muted);white-space:nowrap;}

/* ── Player search autocomplete ── */
.ac-wrap{position:relative;}
.ac-list{
  position:absolute;top:100%;left:0;right:0;z-index:500;
  background:var(--surface2);border:1px solid var(--border2);
  border-radius:var(--radius);overflow:hidden;
  box-shadow:0 8px 24px rgba(0,0,0,.5);
  max-height:220px;overflow-y:auto;display:none;
}
.ac-list.open{display:block;}
.ac-item{
  padding:9px 13px;cursor:pointer;font-size:12.5px;
  display:flex;align-items:center;gap:9px;
  transition:background .1s;border-bottom:1px solid var(--border);
}
.ac-item:last-child{border-bottom:none;}
.ac-item:hover,.ac-item.focused{background:var(--surface3);}
.ac-item-ingame{color:var(--accent);}

/* ── Roster ── */
.roster-rank{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius);margin-bottom:8px;overflow:hidden;
}
.roster-rank-header{
  padding:9px 14px;background:var(--surface3);
  font-size:11px;font-weight:700;color:var(--text2);
  text-transform:uppercase;letter-spacing:.8px;
  display:flex;align-items:center;justify-content:space-between;
}
.roster-member{
  padding:8px 14px;display:flex;align-items:center;gap:10px;
  border-bottom:1px solid var(--border);font-size:12.5px;
}
.roster-member:last-child{border-bottom:none;}
.roster-av{width:26px;height:26px;border-radius:50%;background:var(--surface3);}
.online-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.dot-green{background:var(--success);}
.dot-red{background:var(--danger);}
.dot-grey{background:var(--muted);}

/* ── Session management ── */
.session-card{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:16px;text-align:center;
}
.session-status{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin-bottom:8px;}
.session-count{font-size:48px;font-weight:800;color:var(--accent);line-height:1;letter-spacing:-2px;}
.session-label{font-size:12px;color:var(--muted);margin-top:4px;margin-bottom:16px;}
.vote-bar{background:var(--surface3);border-radius:6px;height:8px;overflow:hidden;margin:10px 0;}
.vote-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:6px;transition:width .5s ease;}

/* ── Announcement ── */
.channel-tag{display:inline-flex;align-items:center;gap:5px;background:var(--blue-dim);color:var(--blue);border:1px solid var(--blue-border);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;}

/* ── Topbar actions ── */
.tb-action{
  display:flex;align-items:center;gap:6px;
  padding:5px 12px;border-radius:8px;
  background:var(--surface2);border:1px solid var(--border2);
  color:var(--text2);font-size:12px;font-weight:600;
  cursor:pointer;transition:all .15s;white-space:nowrap;
}
.tb-action:hover{color:var(--text);border-color:var(--border3);}

/* ── Tabs ── */
.tabs{display:flex;gap:4px;margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px;}
.tab{
  padding:6px 14px;border-radius:7px;font-size:12px;font-weight:600;
  color:var(--muted);cursor:pointer;transition:all .15s;border:none;background:none;
}
.tab.active{background:var(--surface3);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.3);}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px;}
::-webkit-scrollbar-thumb:hover{background:var(--border3);}

/* ── Mobile ── */
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:transform .3s;}
  .sidebar.open{transform:none;}
  .main{margin-left:0;}
  .stats{grid-template-columns:1fr 1fr;}
  #mob-menu{display:flex!important;}
}
`;

const NAV_ITEMS = [
  { id: 'panel',       icon: '🖥️',  label: 'Overview',        section: 'Main' },
  { id: 'moderator',   icon: '🛡️',  label: 'Moderator Panel', section: null },
  { id: 'shift',       icon: '⏱️',  label: 'Shifts',          section: null },
  { id: 'loa',         icon: '🏖️',  label: 'LOA / RA',        section: null },
  { id: 'sessions',    icon: '📈',  label: 'Sessions',        section: null },
  { id: 'punishments', icon: '🔨',  label: 'Punishments',     section: 'Moderation' },
  { id: 'bolo',        icon: '👁️',  label: 'BOLO Board',      section: null },
  { id: 'infractions', icon: '⚖️',  label: 'Infractions',     section: null },
  { id: 'warnings',    icon: '⚠️',  label: 'Warnings',        section: null },
  { id: 'search',      icon: '🔍',  label: 'Search Player',   section: null },
  { id: 'members',     icon: '👥',  label: 'Members',         section: null },
  { id: 'roster',      icon: '📋',  label: 'Staff Roster',    section: null },
  { id: 'erlclogs',    icon: '📡',  label: 'ER:LC Logs',      section: 'ER:LC' },
  { id: 'chatlogs',    icon: '💬',  label: 'Chat Logs',       section: null },
  { id: 'ingame',      icon: '🎮',  label: 'In-Game',         section: null },
  { id: 'announce',    icon: '📢',  label: 'Announcements',   section: null },
  { id: 'activity',    icon: '📊',  label: 'Activity',        section: 'Reports' },
  { id: 'logs',        icon: '📋',  label: 'Audit Logs',      section: null },
  { id: 'roles',       icon: '🔐',  label: 'Dash Roles',      section: 'Settings' },
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
<title>${SERVER_NAME} — ${cur?.label ?? 'Dashboard'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${CSS}</style>
</head>
<body>
<div class="sidebar" id="sidebar">
  <div class="sb-top">
    <img class="sb-logo" src="${LOGO_URL}" onerror="this.style.display='none';document.getElementById('logo-fb').style.display='flex'" alt="">
    <div class="sb-logo-fallback" id="logo-fb" style="display:none">${SERVER_NAME.charAt(0)}</div>
    <div style="min-width:0">
      <div class="sb-name">${SERVER_NAME}</div>
      <div class="sb-sub">${SERVER_FULL}</div>
    </div>
  </div>
  <div class="sb-nav">${navHtml}</div>
  <div class="sb-footer">
    <img class="sb-av" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" alt="">
    <div style="min-width:0">
      <div class="sb-un">${user.username}</div>
      <div class="sb-ut">Staff Member</div>
    </div>
    <a href="/logout" class="sb-logout" title="Logout">⏻</a>
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
${page==='moderator'?'setTimeout(()=>location.reload(),15000);':''}
${page==='shift'?`setInterval(()=>{
  document.querySelectorAll('[data-start]').forEach(el=>{
    const start=parseInt(el.dataset.start);
    if(!start) return;
    const diff=Date.now()-start;
    const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    el.textContent=(h>0?h+'h ':'')+m+'m '+s+'s';
  });
},1000);`:''}
</script>
</body>
</html>`;
}

module.exports = { CSS, NAV_ITEMS, fmt, timeAgo, flash, layout, LOGO_URL, SERVER_NAME, SERVER_FULL };
