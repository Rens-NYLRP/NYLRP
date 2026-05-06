require('dotenv').config();
const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const mongoose        = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_URL  = process.env.DASHBOARD_URL || 'http://localhost:3000';
const CLIENT_ID      = process.env.DISCORD_CLIENT_ID || '1478295713254477855';
const CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'nylrp-secret';
const ERLC_API_KEY   = process.env.ERLC_API_KEY;
const ERLC_BASE      = 'https://api.policeroleplay.community/v1';
const GUILD_ID       = '1379173469132030062';

// ── Mongoose ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).catch(console.error);

const GuildConfigSchema = new mongoose.Schema({ guildId: String, data: mongoose.Schema.Types.Mixed }, { strict: false });
const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', GuildConfigSchema);

const ShiftSchema = new mongoose.Schema({ userId: String, username: String, avatar: String, startTime: Number, endTime: Number, duration: Number, guildId: String });
const Shift = mongoose.models.Shift || mongoose.model('Shift', ShiftSchema);

const PunishmentSchema = new mongoose.Schema({ guildId: String, moderatorId: String, moderatorTag: String, targetUsername: String, targetRobloxId: String, type: String, reason: String, createdAt: { type: Number, default: Date.now } });
const Punishment = mongoose.models.Punishment || mongoose.model('Punishment', PunishmentSchema);

async function getConfig(guildId) {
  const doc = await GuildConfig.findOne({ guildId });
  return doc?.data ?? {};
}

async function erlc(endpoint, method = 'GET', body = null, key = null) {
  const apiKey = key || ERLC_API_KEY;
  if (!apiKey) throw new Error('No API key');
  const opts = { method, headers: { 'Server-Key': apiKey, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${endpoint}`, opts);
  if (!res.ok) throw new Error(`ERLC ${res.status}`);
  return res.json();
}

function fmt(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Express ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({ clientID: CLIENT_ID, clientSecret: CLIENT_SECRET, callbackURL: `${DASHBOARD_URL}/auth/callback`, scope: ['identify', 'guilds'] }, (at, rt, profile, done) => done(null, profile)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');

const CSS = `*{margin:0;padding:0;box-sizing:border-box;}:root{--bg:#0f0f0f;--surface:#181818;--surface2:#202020;--border:#2a2a2a;--accent:#00e5a0;--text:#e8e8e8;--muted:#666;--danger:#ff4757;--warn:#ffa502;--success:#2ed573;--blue:#5865F2;}body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;display:flex;min-height:100vh;font-size:14px;}a{text-decoration:none;color:inherit;}.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;position:fixed;top:0;left:0;height:100vh;z-index:100;}.sb-logo{padding:18px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}.sb-logo-icon{width:34px;height:34px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}.logo-name{font-size:14px;font-weight:700;color:var(--accent);}.logo-sub{font-size:10px;color:var(--muted);}.sb-section{padding:10px 14px 3px;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:600;}.nav-item{display:flex;align-items:center;gap:10px;padding:9px 14px;margin:1px 6px;border-radius:8px;color:var(--muted);font-size:13px;font-weight:500;transition:all .15s;border:1px solid transparent;}.nav-item:hover{background:var(--surface2);color:var(--text);}.nav-item.active{background:rgba(0,229,160,.1);color:var(--accent);border-color:rgba(0,229,160,.2);}.nav-icon{width:18px;text-align:center;font-size:14px;}.sb-footer{margin-top:auto;padding:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;}.sb-av{width:30px;height:30px;border-radius:50%;flex-shrink:0;}.sb-uname{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;}.sb-utag{font-size:10px;color:var(--muted);}.sb-out{margin-left:auto;color:var(--muted);font-size:16px;transition:color .15s;}.sb-out:hover{color:var(--danger);}.main{margin-left:220px;flex:1;display:flex;flex-direction:column;}.topbar{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface);position:sticky;top:0;z-index:50;}.tb-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}.live{display:inline-flex;align-items:center;gap:5px;background:rgba(46,213,115,.1);color:var(--success);padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;}.ld{width:6px;height:6px;border-radius:50%;background:var(--success);animation:p 2s infinite;}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}.content{flex:1;padding:22px;}.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:20px;}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}.stat-value{font-size:24px;font-weight:700;color:var(--accent);line-height:1;}.stat-sub{font-size:11px;color:var(--muted);margin-top:4px;}.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:18px;}.ph{padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}.ph-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;}table{width:100%;border-collapse:collapse;}th{padding:10px 16px;text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);}td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.03);}tr:last-child td{border-bottom:none;}tr:hover td{background:rgba(255,255,255,.02);}.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;}.bg{background:rgba(46,213,115,.12);color:var(--success);}.br{background:rgba(255,71,87,.12);color:var(--danger);}.by{background:rgba(255,165,2,.12);color:var(--warn);}.bb{background:rgba(88,101,242,.12);color:var(--blue);}.ba{background:rgba(0,229,160,.12);color:var(--accent);}.btn{padding:7px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:600;transition:all .2s;display:inline-flex;align-items:center;gap:5px;}.btn:hover{opacity:.85;}.btn-accent{background:var(--accent);color:#000;}.btn-danger{background:var(--danger);color:#fff;}.btn-ghost{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border);}.fg{margin-bottom:12px;}.fg label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px;}.fg input,.fg select,.fg textarea{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;transition:border-color .15s;}.fg input:focus,.fg select:focus{border-color:var(--accent);}.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;padding:14px;}.pcard{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;align-items:center;gap:8px;}.pav{width:30px;height:30px;border-radius:8px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;}.pname{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.pteam{font-size:10px;color:var(--muted);}.tc{display:grid;grid-template-columns:1fr 1fr;gap:16px;}.tc-1{grid-template-columns:1fr;}.loglist{padding:4px 0;}.logitem{display:flex;align-items:flex-start;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.03);}.logitem:last-child{border-bottom:none;}.logicon{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;background:var(--surface2);}.logtitle{font-size:13px;font-weight:600;}.logmeta{font-size:11px;color:var(--muted);margin-top:2px;}.logtime{font-size:10px;color:var(--muted);white-space:nowrap;}.empty{padding:36px;text-align:center;color:var(--muted);font-size:13px;}.alert{padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;}.alert-s{background:rgba(46,213,115,.1);border:1px solid rgba(46,213,115,.2);color:var(--success);}.alert-e{background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.2);color:var(--danger);}.pc{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;}.pc-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;}.pc-u{font-weight:600;font-size:13px;}.pc-m{font-size:12px;color:var(--muted);line-height:1.5;}code{background:var(--surface2);padding:2px 5px;border-radius:4px;font-size:11px;font-family:monospace;}::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px;}.shift-active{background:rgba(0,229,160,.06);border-color:rgba(0,229,160,.2);}@media(max-width:900px){.tc{grid-template-columns:1fr;}.sidebar{display:none;}.main{margin-left:0;}}`;

const NAV = [
  { id: 'panel',       icon: '🖥️',  label: 'Panel',           sec: 'Main' },
  { id: 'shift',       icon: '⏱️',  label: 'My Shift',        sec: null },
  { id: 'members',     icon: '👥',  label: 'Members',         sec: null },
  { id: 'infractions', icon: '⚖️',  label: 'Infractions',    sec: null },
  { id: 'punishments', icon: '🔨',  label: 'Punishment Logs', sec: null },
  { id: 'sessions',    icon: '📈',  label: 'Sessions',        sec: 'ER:LC' },
  { id: 'erlc',        icon: '🎮',  label: 'ER:LC Settings',  sec: null },
  { id: 'logs',        icon: '📋',  label: 'Audit Logs',      sec: 'System' },
  { id: 'settings',    icon: '⚙️',  label: 'Settings',        sec: null },
];

function layout(user, page, content, flash = '') {
  let nav = '', lastSec = null;
  for (const n of NAV) {
    if (n.sec && n.sec !== lastSec) { nav += `<div class="sb-section">${n.sec}</div>`; lastSec = n.sec; }
    nav += `<a href="/${n.id}" class="nav-item${page===n.id?' active':''}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`;
  }
  const av = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32` : `https://cdn.discordapp.com/embed/avatars/0.png`;
  const cur = NAV.find(n=>n.id===page);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NYLRP — ${cur?.label??'Dashboard'}</title><style>${CSS}</style></head><body>
<div class="sidebar"><div class="sb-logo"><div class="sb-logo-icon">🗽</div><div><div class="logo-name">NYLRP</div><div class="logo-sub">Staff Dashboard</div></div></div><div style="flex:1;overflow-y:auto;padding:4px 0">${nav}</div><div class="sb-footer"><img class="sb-av" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div><div class="sb-uname">${user.username}</div><div class="sb-utag">Staff</div></div><a href="/logout" class="sb-out" title="Logout">↩</a></div></div>
<div class="main"><div class="topbar"><div class="tb-title">${cur?.icon} ${cur?.label??'Dashboard'}</div><span class="live"><span class="ld"></span>Live</span></div><div class="content">${flash}${content}</div></div>
${page==='panel'?'<script>setTimeout(()=>location.reload(),30000)</script>':''}
</body></html>`;
}

function flash(req) {
  if (req.query.success) return `<div class="alert alert-s">✅ ${decodeURIComponent(req.query.success)}</div>`;
  if (req.query.error)   return `<div class="alert alert-e">❌ ${decodeURIComponent(req.query.error)}</div>`;
  return '';
}

// ── Auth ──────────────────────────────────────────────────
app.get('/login', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NYLRP Login</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f0f;color:#e8e8e8;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#181818;border:1px solid #2a2a2a;border-radius:16px;padding:48px 40px;text-align:center;max-width:380px;width:100%}.logo{width:56px;height:56px;background:#00e5a0;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 16px}h1{font-size:20px;font-weight:700;color:#00e5a0;margin-bottom:6px}p{color:#666;font-size:13px;margin-bottom:28px}.btn{display:inline-flex;align-items:center;gap:10px;background:#5865F2;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px;transition:opacity .2s}.btn:hover{opacity:.85}</style></head><body><div class="card"><div class="logo">🗽</div><h1>NYLRP Dashboard</h1><p>New York Liberty Roleplay — Staff Panel</p><a class="btn" href="/auth/discord"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>Login with Discord</a></div></body></html>`));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/panel'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));
app.get('/', isAuth, (req, res) => res.redirect('/panel'));

// ── Panel ─────────────────────────────────────────────────
app.get('/panel', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let players = {}, kills = [], cmds = [], modcalls = [], serverInfo = {};
  try { serverInfo = await erlc('/server', 'GET', null, key); } catch {}
  try { players = await erlc('/server/players', 'GET', null, key); } catch {}
  try { kills = (await erlc('/server/killlogs', 'GET', null, key)).slice(0, 15); } catch {}
  try { cmds = (await erlc('/server/commandlogs', 'GET', null, key)).slice(0, 15); } catch {}
  try { modcalls = (await erlc('/server/modcalls', 'GET', null, key)).slice(0, 10); } catch {}
  const pl = Object.values(players);
  const activeShift = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Players In-Game</div><div class="stat-value">${pl.length}</div><div class="stat-sub">${serverInfo?.Name??'Offline'}</div></div>
  <div class="stat"><div class="stat-label">Kill Logs</div><div class="stat-value">${kills.length}</div></div>
  <div class="stat"><div class="stat-label">Commands</div><div class="stat-value">${cmds.length}</div></div>
  <div class="stat"><div class="stat-label">Mod Calls</div><div class="stat-value">${modcalls.length}</div><div class="stat-sub">${modcalls.filter(m=>!m.Responder).length} pending</div></div>
  <div class="stat${activeShift?' shift-active':''}"><div class="stat-label">My Shift</div><div class="stat-value" style="font-size:16px">${activeShift?'🟢 Active':'⚫ Off'}</div>${activeShift?`<div class="stat-sub">Since ${new Date(activeShift.startTime).toLocaleTimeString()}</div>`:''}</div>
</div>
<div class="tc">
  <div>
    <div class="panel"><div class="ph"><div class="ph-title">👥 Players <span class="badge bg">${pl.length}</span></div><button class="btn btn-ghost" onclick="location.reload()">🔄</button></div>
    ${pl.length?`<div class="pgrid">${pl.map(p=>`<div class="pcard"><div class="pav">👤</div><div><div class="pname">${p.Player}</div><div class="pteam">${p.Team||'No Team'}</div></div></div>`).join('')}</div>`:'<div class="empty">No players in game</div>'}</div>
    <div class="panel"><div class="ph"><div class="ph-title">🚨 Mod Calls</div></div>
    ${modcalls.length?`<table><thead><tr><th>Caller</th><th>Responder</th><th>Status</th></tr></thead><tbody>${modcalls.map(m=>`<tr><td><b>${m.Caller}</b></td><td>${m.Responder||'—'}</td><td>${m.Responder?'<span class="badge bg">✓</span>':'<span class="badge by">Pending</span>'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No mod calls</div>'}</div>
    <div class="panel"><div class="ph"><div class="ph-title">🎮 Run Command</div></div><div style="padding:14px"><form action="/api/erlc/command" method="POST" style="display:flex;gap:8px;align-items:flex-end"><div class="fg" style="flex:1;margin:0"><label>Command</label><input name="command" placeholder=":kick PlayerName Reason" required></div><button type="submit" class="btn btn-accent">▶ Run</button></form></div></div>
  </div>
  <div>
    <div class="panel"><div class="ph"><div class="ph-title">💀 Kill Logs</div></div>
    ${kills.length?`<table><thead><tr><th>Killer</th><th>Killed</th><th>Weapon</th></tr></thead><tbody>${kills.map(k=>`<tr><td><b>${k.Killer}</b></td><td>${k.Killed}</td><td><code>${k.Weapon||'?'}</code></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No kill logs</div>'}</div>
    <div class="panel"><div class="ph"><div class="ph-title">⌨️ Command Logs</div></div>
    ${cmds.length?`<table><thead><tr><th>Player</th><th>Command</th></tr></thead><tbody>${cmds.map(c=>`<tr><td><b>${c.Player}</b></td><td><code>${(c.Command||'?').slice(0,40)}</code></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No command logs</div>'}</div>
  </div>
</div>`;
  res.send(layout(req.user, 'panel', content, flash(req)));
});

// ── Shift ─────────────────────────────────────────────────
app.get('/shift', isAuth, async (req, res) => {
  const activeShift = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  const recent = await Shift.find({ userId: req.user.id, guildId: GUILD_ID, endTime: { $ne: null } }).sort({ endTime: -1 }).limit(10);
  const allActive = await Shift.find({ guildId: GUILD_ID, endTime: null });
  const total = recent.reduce((a, s) => a + (s.duration || 0), 0);
  const now = Date.now();

  const content = `
<div class="stats">
  <div class="stat${activeShift?' shift-active':''}"><div class="stat-label">Status</div><div class="stat-value" style="font-size:16px">${activeShift?'🟢 On Shift':'⚫ Off Duty'}</div>${activeShift?`<div class="stat-sub">Since ${new Date(activeShift.startTime).toLocaleTimeString()}</div>`:''}</div>
  <div class="stat"><div class="stat-label">Current Duration</div><div class="stat-value" style="font-size:18px">${activeShift?fmt(now-activeShift.startTime):'—'}</div></div>
  <div class="stat"><div class="stat-label">Total Time</div><div class="stat-value" style="font-size:18px">${fmt(total)}</div><div class="stat-sub">Last ${recent.length} shifts</div></div>
  <div class="stat"><div class="stat-label">Shifts Done</div><div class="stat-value">${recent.length}</div></div>
</div>
<div class="tc">
  <div>
    <div class="panel"><div class="ph"><div class="ph-title">⏱️ Shift Control</div></div>
    <div style="padding:18px">
      ${activeShift?`<div style="background:rgba(0,229,160,.06);border:1px solid rgba(0,229,160,.2);border-radius:10px;padding:16px;text-align:center;margin-bottom:14px"><div style="font-size:12px;color:var(--muted)">Started at</div><div style="font-size:22px;font-weight:700;color:var(--accent)">${new Date(activeShift.startTime).toLocaleTimeString()}</div><div style="font-size:12px;color:var(--muted);margin-top:4px">${fmt(now-activeShift.startTime)}</div></div><form action="/api/shift/end" method="POST"><button type="submit" class="btn btn-danger" style="width:100%;justify-content:center;padding:11px;font-size:13px">⏹ End Shift</button></form>`:`<div style="text-align:center;padding:20px 0;color:var(--muted);font-size:13px;margin-bottom:14px">You are currently off duty</div><form action="/api/shift/start" method="POST"><button type="submit" class="btn btn-accent" style="width:100%;justify-content:center;padding:11px;font-size:13px">▶ Start Shift</button></form>`}
    </div></div>
    <div class="panel"><div class="ph"><div class="ph-title">👥 Staff On Shift <span class="badge bg">${allActive.length}</span></div></div>
    ${allActive.length?`<table><thead><tr><th>Staff</th><th>Started</th><th>Duration</th></tr></thead><tbody>${allActive.map(s=>`<tr><td><b>${s.username}</b></td><td>${new Date(s.startTime).toLocaleTimeString()}</td><td><span class="badge bg">${fmt(now-s.startTime)}</span></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No staff on shift</div>'}</div>
  </div>
  <div class="panel"><div class="ph"><div class="ph-title">📊 Recent Shifts</div></div>
  ${recent.length?`<table><thead><tr><th>Date</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>${recent.map(s=>`<tr><td>${new Date(s.startTime).toLocaleDateString()}</td><td>${new Date(s.startTime).toLocaleTimeString()}</td><td>${s.endTime?new Date(s.endTime).toLocaleTimeString():'—'}</td><td><span class="badge ba">${fmt(s.duration||0)}</span></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No shifts yet</div>'}</div>
</div>`;
  res.send(layout(req.user, 'shift', content, flash(req)));
});

app.post('/api/shift/start', isAuth, async (req, res) => {
  if (!await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null }))
    await Shift.create({ userId: req.user.id, username: req.user.username, avatar: req.user.avatar, startTime: Date.now(), guildId: GUILD_ID });
  res.redirect('/shift?success=Shift+started');
});
app.post('/api/shift/end', isAuth, async (req, res) => {
  const s = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  if (s) { s.endTime = Date.now(); s.duration = s.endTime - s.startTime; await s.save(); }
  res.redirect('/shift?success=Shift+ended');
});

// ── Members ───────────────────────────────────────────────
app.get('/members', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const v = cfg?.verification?.verifiedUsers ?? {};
  const entries = Object.entries(v);
  const content = `
<div class="stats"><div class="stat"><div class="stat-label">Verified Members</div><div class="stat-value">${entries.length}</div></div></div>
<div class="panel"><div class="ph"><div class="ph-title">✅ Verified Members</div></div>
${entries.length?`<table><thead><tr><th>Discord ID</th><th>Roblox</th><th>ID</th><th>Verified</th><th>Source</th></tr></thead><tbody>${entries.map(([id,d])=>`<tr><td><code>${id}</code></td><td><a href="https://www.roblox.com/users/${d.robloxId}/profile" target="_blank" style="color:var(--accent)">${d.robloxUsername}</a></td><td><code>${d.robloxId}</code></td><td>${d.verifiedAt?new Date(d.verifiedAt).toLocaleDateString():'—'}</td><td>${d.importedFrom?`<span class="badge bb">${d.importedFrom}</span>`:'<span class="badge bg">Bot</span>'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No verified members</div>'}</div>`;
  res.send(layout(req.user, 'members', content));
});

// ── Infractions ───────────────────────────────────────────
app.get('/infractions', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const warn = cfg?.warnings ?? {}, note = cfg?.notes ?? {};
  const users = [...new Set([...Object.keys(warn), ...Object.keys(note)])];
  const content = `
<div class="stats"><div class="stat"><div class="stat-label">Users</div><div class="stat-value">${users.length}</div></div><div class="stat"><div class="stat-label">Warnings</div><div class="stat-value">${Object.values(warn).reduce((a,b)=>a+b.length,0)}</div></div><div class="stat"><div class="stat-label">Notes</div><div class="stat-value">${Object.values(note).reduce((a,b)=>a+b.length,0)}</div></div></div>
<div class="panel"><div class="ph"><div class="ph-title">⚖️ Infractions</div></div>
${users.length?`<table><thead><tr><th>User ID</th><th>Warnings</th><th>Notes</th><th>Last Reason</th></tr></thead><tbody>${users.map(uid=>`<tr><td><code>${uid}</code></td><td>${(warn[uid]||[]).length?`<span class="badge br">⚠️ ${(warn[uid]||[]).length}</span>`:'—'}</td><td>${(note[uid]||[]).length?`<span class="badge by">📝 ${(note[uid]||[]).length}</span>`:'—'}</td><td style="color:var(--muted);font-size:12px">${(warn[uid]||[]).at(-1)?.reason||'—'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No infractions</div>'}</div>`;
  res.send(layout(req.user, 'infractions', content));
});

// ── Punishments ───────────────────────────────────────────
app.get('/punishments', isAuth, async (req, res) => {
  const punishments = await Punishment.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(50);
  const content = `
<div class="stats"><div class="stat"><div class="stat-label">Total</div><div class="stat-value">${punishments.length}</div></div><div class="stat"><div class="stat-label">Kicks</div><div class="stat-value">${punishments.filter(p=>p.type==='kick').length}</div></div><div class="stat"><div class="stat-label">Bans</div><div class="stat-value">${punishments.filter(p=>p.type==='ban').length}</div></div><div class="stat"><div class="stat-label">Warns</div><div class="stat-value">${punishments.filter(p=>p.type==='warn').length}</div></div></div>
<div class="tc">
  <div class="panel"><div class="ph"><div class="ph-title">➕ Create Log</div></div><div style="padding:14px">
    <form action="/api/punishment" method="POST">
      <div class="fg"><label>Roblox Username</label><input name="targetUsername" placeholder="PlayerName" required></div>
      <div class="fg"><label>Roblox ID (optional)</label><input name="targetRobloxId" placeholder="123456789"></div>
      <div class="fg"><label>Type</label><select name="type"><option value="warn">⚠️ Warning</option><option value="kick">👢 Kick</option><option value="ban">🔨 Ban</option><option value="note">📝 Note</option></select></div>
      <div class="fg"><label>Reason</label><textarea name="reason" rows="3" style="resize:vertical;width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none"></textarea></div>
      <button type="submit" class="btn btn-accent" style="width:100%;justify-content:center">➕ Create Log</button>
    </form>
  </div></div>
  <div><div style="max-height:400px;overflow-y:auto">${punishments.slice(0,8).map(p=>`<div class="pc"><div class="pc-h"><span class="pc-u">${p.targetUsername}</span><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':'bb'}">${p.type}</span></div><div class="pc-m"><b>Reason:</b> ${p.reason||'—'}<br><b>By:</b> ${p.moderatorTag||'?'} · ${new Date(p.createdAt).toLocaleDateString()}${p.targetRobloxId?`<br><b>ID:</b> ${p.targetRobloxId}`:''}</div></div>`).join('')||'<div class="empty">No logs yet</div>'}</div></div>
</div>
<div class="panel"><div class="ph"><div class="ph-title">📋 All Punishment Logs</div></div>
${punishments.length?`<table><thead><tr><th>Type</th><th>Player</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>${punishments.map(p=>`<tr><td><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':'bb'}">${p.type}</span></td><td><b>${p.targetUsername}</b></td><td style="max-width:200px;color:var(--muted)">${p.reason||'—'}</td><td>${p.moderatorTag||'—'}</td><td>${new Date(p.createdAt).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No punishment logs</div>'}</div>`;
  res.send(layout(req.user, 'punishments', content, flash(req)));
});
app.post('/api/punishment', isAuth, async (req, res) => {
  const { targetUsername, targetRobloxId, type, reason } = req.body;
  await Punishment.create({ guildId: GUILD_ID, moderatorId: req.user.id, moderatorTag: req.user.username, targetUsername, targetRobloxId: targetRobloxId||null, type, reason, createdAt: Date.now() });
  res.redirect('/punishments?success=Log+created');
});

// ── Sessions ──────────────────────────────────────────────
app.get('/sessions', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const sc = cfg?.session ?? {};
  const content = `
<div class="stats"><div class="stat"><div class="stat-label">Vote Threshold</div><div class="stat-value">${sc.voteThreshold??6}</div></div><div class="stat"><div class="stat-label">Channel</div><div class="stat-value" style="font-size:14px">${sc.channel?'✅ Set':'❌ Not set'}</div></div><div class="stat"><div class="stat-label">Join Link</div><div class="stat-value" style="font-size:14px">${sc.joinLink?'✅ Set':'❌ Not set'}</div></div></div>
<div class="panel"><div class="ph"><div class="ph-title">📈 Session Info</div></div><div style="padding:18px;color:var(--muted);font-size:13px;line-height:1.8">Manage sessions via Discord: <code>/session start</code> <code>/session vote</code> <code>/session shutdown</code><br><br><b style="color:var(--text)">Start Description:</b><br>${sc.startDescription?.slice(0,200)??'Not set'}</div></div>`;
  res.send(layout(req.user, 'sessions', content));
});

// ── ERLC Settings ─────────────────────────────────────────
app.get('/erlc', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const ec = cfg?.erlcLogs ?? {};
  const content = `
<div class="stats"><div class="stat"><div class="stat-label">Status</div><div class="stat-value" style="font-size:15px">${ec.enabled?'<span style="color:var(--success)">✅ Active</span>':'<span style="color:var(--danger)">❌ Inactive</span>'}</div></div><div class="stat"><div class="stat-label">Server Key</div><div class="stat-value" style="font-size:15px">${ec.serverKey?'<span style="color:var(--success)">✅ Set</span>':'<span style="color:var(--danger)">❌ Not set</span>'}</div></div></div>
<div class="tc">
  <div class="panel"><div class="ph"><div class="ph-title">🔑 Server Key</div></div><div style="padding:14px"><form action="/api/erlc/key" method="POST"><div class="fg"><label>ERLC Server Key</label><input type="password" name="key" placeholder="Paste key..." required></div><button type="submit" class="btn btn-accent" style="width:100%;justify-content:center">💾 Save</button></form></div></div>
  <div class="panel"><div class="ph"><div class="ph-title">📡 Log Channels</div></div><table><thead><tr><th>Type</th><th>Status</th></tr></thead><tbody><tr><td>🔨 Kick/Ban</td><td>${ec.kickBans?'<span class="badge bg">Set</span>':'<span class="badge br">Not set</span>'}</td></tr><tr><td>📥 Join/Leave</td><td>${ec.joinLeave?'<span class="badge bg">Set</span>':'<span class="badge br">Not set</span>'}</td></tr><tr><td>⌨️ Commands</td><td>${ec.cmds?'<span class="badge bg">Set</span>':'<span class="badge br">Not set</span>'}</td></tr><tr><td>🚨 Mod Calls</td><td>${ec.modCall?'<span class="badge bg">Set</span>':'<span class="badge br">Not set</span>'}</td></tr><tr><td>💀 Kills</td><td>${ec.kills?'<span class="badge bg">Set</span>':'<span class="badge br">Not set</span>'}</td></tr></tbody></table><div style="padding:10px 16px;color:var(--muted);font-size:11px">Configure via <code>/setup erlclogs</code> in Discord</div></div>
</div>`;
  res.send(layout(req.user, 'erlc', content, flash(req)));
});

// ── Logs ──────────────────────────────────────────────────
app.get('/logs', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const warn = cfg?.warnings ?? {}, note = cfg?.notes ?? {};
  const punishments = await Punishment.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(20);
  const logs = [];
  for (const [uid, ws] of Object.entries(warn)) for (const w of ws) logs.push({ type: 'warn', uid, data: w, ts: w.timestamp||0 });
  for (const [uid, ns] of Object.entries(note)) for (const n of ns) logs.push({ type: 'note', uid, data: n, ts: n.timestamp||0 });
  logs.sort((a,b)=>b.ts-a.ts);
  const content = `
<div class="tc">
  <div class="panel"><div class="ph"><div class="ph-title">⚖️ Warning & Note Logs</div></div><div class="loglist">
    ${logs.slice(0,20).map(l=>`<div class="logitem"><div class="logicon">${l.type==='warn'?'⚠️':'📝'}</div><div style="flex:1"><div class="logtitle">${l.type==='warn'?'Warning':'Note'} — <code>${l.uid}</code></div><div class="logmeta">${l.data.reason||l.data.note||'No reason'}${l.data.by?` · ${l.data.by}`:''}</div></div><div class="logtime">${l.ts?new Date(l.ts).toLocaleDateString():'—'}</div></div>`).join('')||'<div class="empty">No logs</div>'}
  </div></div>
  <div class="panel"><div class="ph"><div class="ph-title">🔨 Punishment Logs</div></div><div class="loglist">
    ${punishments.map(p=>`<div class="logitem"><div class="logicon">${p.type==='ban'?'🔨':p.type==='kick'?'👢':'⚠️'}</div><div style="flex:1"><div class="logtitle">${p.type.toUpperCase()} — ${p.targetUsername}</div><div class="logmeta">${p.reason||'No reason'} · ${p.moderatorTag}</div></div><div class="logtime">${new Date(p.createdAt).toLocaleDateString()}</div></div>`).join('')||'<div class="empty">No punishment logs</div>'}
  </div></div>
</div>`;
  res.send(layout(req.user, 'logs', content));
});

// ── Settings ──────────────────────────────────────────────
app.get('/settings', isAuth, async (req, res) => {
  const content = `<div class="panel"><div class="ph"><div class="ph-title">⚙️ Settings</div></div><div style="padding:18px;display:flex;flex-direction:column;gap:10px">
  <div style="background:var(--surface2);border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:600;font-size:13px">Bot Configuration</div><div style="color:var(--muted);font-size:11px;margin-top:2px">Tickets, applications, sessions</div></div><span class="badge bb">Via /setup in Discord</span></div>
  <div style="background:var(--surface2);border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:600;font-size:13px">ERLC Integration</div><div style="color:var(--muted);font-size:11px;margin-top:2px">Server key, log channels</div></div><a href="/erlc" class="btn btn-ghost" style="font-size:11px">Configure →</a></div>
  <div style="background:var(--surface2);border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:600;font-size:13px">Dashboard Version</div><div style="color:var(--muted);font-size:11px;margin-top:2px">NYLRP Dashboard v2.0</div></div><span class="badge bg">Up to date</span></div>
</div></div>`;
  res.send(layout(req.user, 'settings', content));
});

// ── API ───────────────────────────────────────────────────
app.post('/api/erlc/command', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try { await erlc('/server/command', 'POST', { command: req.body.command }, key); res.redirect('/panel?success=Command+sent'); }
  catch (e) { res.redirect('/panel?error=' + encodeURIComponent(e.message)); }
});
app.post('/api/erlc/key', isAuth, async (req, res) => {
  try { await GuildConfig.findOneAndUpdate({ guildId: GUILD_ID }, { $set: { 'data.erlcLogs.serverKey': req.body.key } }, { upsert: true }); res.redirect('/erlc?success=Key+saved'); }
  catch (e) { res.redirect('/erlc?error=' + encodeURIComponent(e.message)); }
});

app.listen(PORT, () => console.log(`✅ Dashboard running on port ${PORT}`));
