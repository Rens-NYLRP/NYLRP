require('dotenv').config();
const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const mongoose        = require('mongoose');

const { GuildConfig, Shift, Punishment, ErlcLog, Leave, Activity, DashRole, Warning, ChatLog, Announcement, BoloEntry, RosterMember, SessionVote } = require('./dashboard-models');
const { fmt, timeAgo, flash, layout } = require('./dashboard-layout');

const app  = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_URL  = process.env.DASHBOARD_URL  || 'http://localhost:3000';
const CLIENT_ID      = process.env.DISCORD_CLIENT_ID || '1478295713254477855';
const CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'nylrp-secret';
const ERLC_API_KEY   = process.env.ERLC_API_KEY;
const ERLC_BASE      = 'https://api.policeroleplay.community/v1';
const GUILD_ID       = '1379173469132030062';
const DISCORD_BASE   = 'https://discord.com/api/v10';
const BOT_TOKEN      = process.env.TOKEN;

// ── DB ────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('✅ Dashboard DB connected')).catch(console.error);

async function getConfig() {
  const doc = await GuildConfig.findOne({ guildId: GUILD_ID });
  return doc?.data ?? {};
}
async function logActivity(userId, username, action, details = {}) {
  await Activity.create({ guildId: GUILD_ID, userId, username, action, details, timestamp: Date.now() });
}

// ── ERLC ──────────────────────────────────────────────────
async function erlc(endpoint, method = 'GET', body = null, key = null) {
  const apiKey = key || ERLC_API_KEY;
  if (!apiKey) throw new Error('No ERLC API key configured');
  const opts = { method, headers: { 'Server-Key': apiKey, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${endpoint}`, opts);
  if (!res.ok) throw new Error(`ERLC API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Discord API helper ────────────────────────────────────
async function discordApi(endpoint, method = 'GET', body = null) {
  if (!BOT_TOKEN) return null;
  const opts = { method, headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${DISCORD_BASE}${endpoint}`, opts);
  if (!res.ok) return null;
  return res.json();
}

async function sendDM(userId, content) {
  if (!BOT_TOKEN) return;
  try {
    const channel = await discordApi('/users/@me/channels', 'POST', { recipient_id: userId });
    if (!channel?.id) return;
    await discordApi(`/channels/${channel.id}/messages`, 'POST', { content });
  } catch {}
}

async function sendChannelMessage(channelId, content, embed = null) {
  if (!BOT_TOKEN || !channelId) return;
  const body = { content };
  if (embed) body.embeds = [embed];
  return discordApi(`/channels/${channelId}/messages`, 'POST', body);
}

// ── Discord Guild helpers ─────────────────────────────────
async function getGuildRoles() {
  try { const r = await discordApi('/guilds/'+GUILD_ID+'/roles'); return (r||[]).sort((a,b)=>b.position-a.position).filter(r=>r.name!=='@everyone'); } catch { return []; }
}
async function getGuildChannels() {
  try { const c = await discordApi('/guilds/'+GUILD_ID+'/channels'); return (c||[]).filter(c=>c.type===0||c.type===5).sort((a,b)=>a.position-b.position); } catch { return []; }
}
async function getMemberRoles(userId) {
  try { const m = await discordApi('/guilds/'+GUILD_ID+'/members/'+userId); return m?.roles||[]; } catch { return []; }
}

// ── Permission definitions ────────────────────────────────
const ALL_PERMS = [
  { key:'viewPanel',         label:'View Panel & In-Game',      icon:'🖥️' },
  { key:'viewLogs',          label:'View Logs & Audit Trail',   icon:'📋' },
  { key:'viewMembers',       label:'View Members',               icon:'👥' },
  { key:'manageShifts',      label:'Manage Shifts',              icon:'⏱️' },
  { key:'createPunishments', label:'Create Punishments',         icon:'🔨' },
  { key:'deletePunishments', label:'Delete Punishments & Logs',  icon:'🗑️' },
  { key:'manageLOA',         label:'Approve / Deny LOA',         icon:'🏖️' },
  { key:'manageSettings',    label:'Manage Settings',            icon:'⚙️' },
  { key:'viewErlcPanel',     label:'View ER:LC Panel',           icon:'📡' },
  { key:'runCommands',       label:'Run ER:LC Commands',         icon:'▶️' },
  { key:'manageRoles',       label:'Manage Dashboard Roles',     icon:'🔐' },
  { key:'manageRoster',      label:'Manage Staff Roster',        icon:'📋' },
  { key:'sendAnnouncements', label:'Send Announcements',         icon:'📢' },
  { key:'manageBolo',        label:'Manage BOLOs',               icon:'👁️' },
  { key:'manageWarnings',    label:'Issue / Delete Warnings',    icon:'⚠️' },
  { key:'viewChatlogs',      label:'View Chat Logs',             icon:'💬' },
  { key:'manageSessions',    label:'Manage Sessions',            icon:'📈' },
  { key:'administrator',     label:'Administrator (all perms)',  icon:'👑' },
];

// Check if user has a permission
async function hasPerm(userId, perm) {
  const memberRoleIds = await getMemberRoles(userId);
  const dashRoles = await DashRole.find({ guildId: GUILD_ID, discordRoleId: { $in: memberRoleIds } });
  for (const dr of dashRoles) {
    if (dr.permissions?.administrator || dr.permissions?.[perm]) return true;
  }
  return false;
}

// Middleware: require a permission
function requirePerm(perm) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const ok = await hasPerm(req.user.id, perm);
    if (ok) return next();
    res.status(403).send('<html><body style="background:#0a0a0b;color:#f0f0f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px"><div style="font-size:48px">🔒</div><div style="font-size:20px;font-weight:700">Access Denied</div><div style="color:#666;font-size:13px">You do not have the <b style="color:#00e5a0">'+perm+'</b> permission</div><a href="/panel" style="margin-top:12px;background:#00e5a0;color:#000;padding:8px 20px;border-radius:8px;text-decoration:none;font-weight:700">← Back to Panel</a></body></html>');
  };
}

// ── Express ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 604800000 } }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({
  clientID: CLIENT_ID, clientSecret: CLIENT_SECRET,
  callbackURL: `${DASHBOARD_URL}/auth/callback`, scope: ['identify', 'guilds'],
}, (at, rt, profile, done) => done(null, profile)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');

// ── Auth ──────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const LOGO = process.env.SERVER_LOGO_URL || '';
  const NAME = process.env.SERVER_NAME || 'NYLRP';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${NAME} Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0b;color:#f0f0f5;font-family:'Plus Jakarta Sans',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(0,229,160,.12) 0%,transparent 60%);pointer-events:none;}
.card{background:#111113;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:44px 40px;text-align:center;max-width:380px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.6);}
.logo-wrap{width:64px;height:64px;border-radius:14px;margin:0 auto 20px;overflow:hidden;background:linear-gradient(135deg,#00e5a0,#00c584);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#000;}
.logo-wrap img{width:100%;height:100%;object-fit:cover;}
h1{font-size:20px;font-weight:800;color:#f0f0f5;margin-bottom:6px;letter-spacing:-.3px;}
p{color:#5a5a6e;font-size:12.5px;margin-bottom:28px;line-height:1.6;}
.btn{display:inline-flex;align-items:center;gap:10px;background:#5865F2;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;transition:all .2s;border:none;cursor:pointer;}
.btn:hover{background:#4752C4;transform:translateY(-2px);box-shadow:0 8px 24px rgba(88,101,242,.4);}
</style></head>
<body><div class="card">
<div class="logo-wrap">${LOGO?`<img src="${LOGO}" onerror="this.style.display='none';this.parentNode.textContent='${NAME.charAt(0)}'">`:'<span>'+NAME.charAt(0)+'</span>'}</div>
<h1>${NAME} Dashboard</h1>
<p>Staff Management & ER:LC Panel<br>Login with Discord to continue.</p>
<a class="btn" href="/auth/discord">
<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 13.84 13.84 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
Login with Discord</a></div></body></html>`);
});
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/panel'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));
app.get('/', isAuth, (req, res) => res.redirect('/panel'));
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ── API: Player search autocomplete ──────────────────────
app.get('/api/players/search', isAuth, async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ ingame: [], db: [] });
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let ingame = [];
  try {
    const players = await erlc('/server/players', 'GET', null, key);
    ingame = Object.values(players).filter(p => p.Player?.toLowerCase().includes(q)).map(p => ({ name: p.Player, team: p.Team })).slice(0, 5);
  } catch {}
  const dbPunishments = await Punishment.find({ guildId: GUILD_ID, targetUsername: { $regex: q, $options: 'i' } }).distinct('targetUsername');
  return res.json({ ingame, db: dbPunishments.slice(0, 5) });
});

// ── Panel (Overview) ──────────────────────────────────────
app.get('/panel', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let players = {}, kills = [], cmds = [], modcalls = [], serverInfo = {};
  try { serverInfo = await erlc('/server', 'GET', null, key); } catch {}
  try { players = await erlc('/server/players', 'GET', null, key); } catch {}
  try { kills = (await erlc('/server/killlogs', 'GET', null, key)).slice(0, 10); } catch {}
  try { cmds = (await erlc('/server/commandlogs', 'GET', null, key)).slice(0, 10); } catch {}
  try { modcalls = (await erlc('/server/modcalls', 'GET', null, key)).slice(0, 8); } catch {}

  const pl = Object.values(players);
  const activeShift = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  const allActiveShifts = await Shift.find({ guildId: GUILD_ID, endTime: null });
  const recentPunishments = await Punishment.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(5);
  const activeBolos = await BoloEntry.find({ guildId: GUILD_ID, active: true }).sort({ createdAt: -1 });
  const now = Date.now();

  const content = `
<div class="stats">
  <div class="stat"><span class="stat-icon">👥</span><div class="stat-label">In-Game</div><div class="stat-value">${pl.length}</div><div class="stat-sub">${serverInfo?.Name ?? 'Server'}</div></div>
  <div class="stat"><span class="stat-icon">👮</span><div class="stat-label">Staff On Duty</div><div class="stat-value">${allActiveShifts.length}</div><div class="stat-sub">Active shifts</div></div>
  <div class="stat"><span class="stat-icon">🚨</span><div class="stat-label">Mod Calls</div><div class="stat-value">${modcalls.length}</div><div class="stat-sub">${modcalls.filter(m=>!m.Responder).length} pending</div></div>
  <div class="stat"><span class="stat-icon">💀</span><div class="stat-label">Kill Logs</div><div class="stat-value">${kills.length}</div></div>
  <div class="stat"><span class="stat-icon">👁️</span><div class="stat-label">Active BOLOs</div><div class="stat-value">${activeBolos.length}</div></div>
  <div class="stat${activeShift?' stat-active':''}"><span class="stat-icon">${activeShift?'🟢':'⚫'}</span><div class="stat-label">My Shift</div><div class="stat-value" style="font-size:16px;margin-top:4px">${activeShift?'On Duty':'Off Duty'}</div>${activeShift?`<div class="stat-sub" data-start="${activeShift.startTime}">${fmt(now-activeShift.startTime)}</div>`:''}</div>
</div>

${activeBolos.length ? `
<div class="panel">
  <div class="panel-header"><div class="panel-title">👁️ Active BOLOs <span class="badge br">${activeBolos.length}</span></div><a href="/bolo" class="btn btn-ghost btn-sm">Manage →</a></div>
  <div style="padding:12px 14px;display:flex;flex-wrap:wrap;gap:8px">
    ${activeBolos.map(b=>`<div class="bolo-card" style="flex:1;min-width:220px;margin:0"><div class="bolo-header"><span class="bolo-name">🎯 ${b.playerName}</span><span class="badge br">BOLO</span></div><div class="bolo-meta">${b.reason||'No reason'}<br>By ${b.issuedBy} · ${timeAgo(b.createdAt)}</div></div>`).join('')}
  </div>
</div>` : ''}

<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">👥 Players In-Game <span class="badge bg">${pl.length}</span></div><a href="/ingame" class="btn btn-ghost btn-sm">Full View →</a></div>
      ${pl.length ? `<div class="player-grid">${pl.slice(0,12).map(p=>`<div class="player-card"><div class="player-icon">👤</div><div><div class="player-name">${p.Player}</div><div class="player-team">${p.Team||'No Team'}</div></div></div>`).join('')}${pl.length>12?`<div style="padding:8px 12px;color:var(--muted);font-size:11px">+${pl.length-12} more</div>`:''}</div>` : '<div class="empty"><div class="empty-icon">🎮</div>No players in game</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">👮 Staff On Duty <span class="badge bg">${allActiveShifts.length}</span></div><a href="/shift" class="btn btn-ghost btn-sm">Manage →</a></div>
      ${allActiveShifts.length ? allActiveShifts.map(s=>`<div class="shift-row"><img class="shift-av" src="https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div style="flex:1"><div class="shift-name">${s.username}</div><div class="shift-time">Since ${new Date(s.startTime).toLocaleTimeString()}</div></div><span class="badge bg">${fmt(now-s.startTime)}</span></div>`).join('') : '<div class="empty">No staff on duty</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🎮 Run Command</div></div>
      <div class="panel-body">
        <form action="/api/erlc/command" method="POST" class="form-row">
          <div class="fg"><label>Command</label><input name="command" placeholder=":kick PlayerName Reason" required></div>
          <button type="submit" class="btn btn-accent" style="margin-top:20px">▶ Run</button>
        </form>
      </div>
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🚨 Mod Calls</div><a href="/moderator" class="btn btn-ghost btn-sm">Mod Panel →</a></div>
      ${modcalls.length ? `<div class="table-wrap"><table><thead><tr><th>Caller</th><th>Responder</th><th>Status</th></tr></thead><tbody>${modcalls.map(m=>`<tr><td><b>${m.Caller}</b></td><td>${m.Responder||'—'}</td><td>${m.Responder?'<span class="badge bg">✓ Responded</span>':'<span class="badge by">⏳ Pending</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No mod calls</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">💀 Kill Logs</div><a href="/erlclogs" class="btn btn-ghost btn-sm">All Logs →</a></div>
      ${kills.length ? `<div class="table-wrap"><table><thead><tr><th>Killer</th><th>Killed</th><th>Weapon</th></tr></thead><tbody>${kills.map(k=>`<tr><td><b>${k.Killer}</b></td><td>${k.Killed}</td><td><code>${k.Weapon||'?'}</code></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No kill logs</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔨 Recent Punishments</div><a href="/punishments" class="btn btn-ghost btn-sm">All →</a></div>
      ${recentPunishments.length ? recentPunishments.map(p=>`<div class="puncard"><div class="puncard-header"><span class="puncard-user">${p.targetUsername}</span><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':p.type==='note'?'bb':'by'}">${p.type}</span></div><div class="puncard-meta"><b>Reason:</b> ${p.reason||'—'} · <b>By:</b> ${p.moderatorTag||'?'} · ${timeAgo(p.createdAt)}</div></div>`).join('') : '<div class="empty">No punishments</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'panel', content, flash(req)));
});

// ── Moderator Panel ───────────────────────────────────────
app.get('/moderator', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let players = {}, serverInfo = {}, queue = [], kills = [], cmds = [], modcalls = [], chatLogs = [];
  try { serverInfo = await erlc('/server', 'GET', null, key); } catch {}
  try { players = await erlc('/server/players', 'GET', null, key); } catch {}
  try { queue = await erlc('/server/queue', 'GET', null, key); } catch {}
  try { kills = (await erlc('/server/killlogs', 'GET', null, key)).slice(0, 20); } catch {}
  try { cmds = (await erlc('/server/commandlogs', 'GET', null, key)).slice(0, 25); } catch {}
  try { modcalls = (await erlc('/server/modcalls', 'GET', null, key)); } catch {}
  try {
    const raw = await erlc('/server/chatlogs', 'GET', null, key);
    chatLogs = Array.isArray(raw) ? raw.slice(0, 30) : [];
  } catch {}

  const pl = Object.values(players);
  const recentPunishments = await Punishment.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(10);
  const activeShift = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  const now = Date.now();

  // Build the live feed (merged kills + cmds + joins sorted by time)
  const feedItems = [
    ...kills.map(k => ({ type: 'kill', text: `<b>${k.Killer}</b> killed <b>${k.Killed}</b> with ${k.Weapon||'?'}`, time: k.Timestamp||0 })),
    ...cmds.map(c => ({ type: 'cmd', text: `<b>${c.Player}</b> ran <code>${(c.Command||'?').slice(0,40)}</code>`, time: c.Timestamp||0 })),
  ].sort((a,b)=>b.time-a.time).slice(0, 30);

  const typeIcon = { kill: '💀', cmd: '⌨️', join: '📥', leave: '📤', modcall: '🚨' };

  const content = `
<div class="mod-grid">
  <!-- LEFT: Player list + shift -->
  <div class="mod-col">
    <div class="panel" style="flex:0">
      <div class="panel-header">
        <div class="panel-title">
          ${activeShift ? '<span class="badge bg">🟢 On Duty</span>' : '<span class="badge br">⚫ Off Duty</span>'}
          <span style="color:var(--muted);font-weight:500;font-size:11px">${activeShift?`<span data-start="${activeShift.startTime}">${fmt(now-activeShift.startTime)}</span>`:''}</span>
        </div>
        ${activeShift
          ? `<form action="/api/shift/end" method="POST"><button class="btn btn-danger btn-sm">⏹ End</button></form>`
          : `<form action="/api/shift/start" method="POST"><button class="btn btn-accent btn-sm">▶ Start Shift</button></form>`}
      </div>
    </div>

    <div class="panel" style="flex:0">
      <div class="panel-header">
        <div class="panel-title">🎮 ${pl.length} Player${pl.length!==1?'s':''} In-Game</div>
        <span class="badge ba">${Array.isArray(queue)?queue.length:0} queue</span>
      </div>
      <div class="search-bar" style="margin:8px 10px 0;width:auto">🔍 <input placeholder="Search players..." oninput="filterPlayers(this.value)" id="player-search"></div>
      <div style="max-height:320px;overflow-y:auto" id="player-list">
        ${pl.length ? pl.map(p=>`
          <div class="shift-row player-row" data-name="${p.Player.toLowerCase()}">
            <div class="player-icon" style="width:28px;height:28px;font-size:12px">👤</div>
            <div style="flex:1;min-width:0">
              <div class="shift-name">${p.Player}</div>
              <div class="shift-time">${p.Team||'No Team'}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="openPM('${p.Player}')">PM</button>
          </div>`).join('') : '<div class="empty" style="padding:20px">No players</div>'}
      </div>
    </div>

    <div class="panel" style="flex:0">
      <div class="panel-header"><div class="panel-title">🚨 Mod Calls <span class="badge ${modcalls.filter(m=>!m.Responder).length?'by':'bg'}">${modcalls.length}</span></div></div>
      <div style="max-height:200px;overflow-y:auto">
        ${modcalls.length ? modcalls.map(m=>`
          <div class="shift-row">
            <span style="font-size:12px">🚨</span>
            <div style="flex:1;min-width:0">
              <div class="shift-name" style="font-size:12px">${m.Caller}</div>
              <div class="shift-time">${m.Responder?'Responded by '+m.Responder:'Pending'}</div>
            </div>
            <span class="badge ${m.Responder?'bg':'by'}">${m.Responder?'✓':'⏳'}</span>
          </div>`).join('') : '<div class="empty" style="padding:16px">No mod calls</div>'}
      </div>
    </div>

    <div class="panel" style="flex:0">
      <div class="panel-header"><div class="panel-title">🎮 Quick Command</div></div>
      <div class="panel-body" style="padding:10px">
        <form action="/api/erlc/command" method="POST" class="form-row">
          <div class="fg" style="margin:0;flex:1"><input name="command" placeholder=":kick PlayerName Reason" required></div>
          <button type="submit" class="btn btn-accent btn-sm">▶</button>
        </form>
      </div>
    </div>
  </div>

  <!-- MIDDLE: Live feed + chat logs -->
  <div class="mod-col">
    <div class="panel" style="flex:0">
      <div class="panel-header">
        <div class="panel-title">📡 Live Feed</div>
        <span class="live-pill"><span class="live-dot"></span>Auto-refresh 15s</span>
      </div>
      <div style="max-height:280px;overflow-y:auto" id="live-feed">
        ${feedItems.length ? feedItems.map(f=>`<div class="feed-item"><span class="feed-icon">${typeIcon[f.type]||'📋'}</span><span class="feed-text">${f.text}</span><span class="feed-time">${f.time?timeAgo(f.time*1000):'—'}</span></div>`).join('') : '<div class="empty" style="padding:20px">No recent activity</div>'}
      </div>
    </div>

    <div class="panel" style="flex:1">
      <div class="panel-header">
        <div class="panel-title">💬 Chat Logs</div>
        <a href="/chatlogs" class="btn btn-ghost btn-sm">Full View →</a>
      </div>
      <div style="max-height:380px;overflow-y:auto">
        ${chatLogs.length ? chatLogs.map(c=>`
          <div class="chat-msg">
            <div class="chat-header">
              <div style="display:flex;align-items:center;gap:6px">
                <span class="chat-player">${c.Player||c.Username||'Unknown'}</span>
                ${c.Team?`<span class="chat-team-tag badge ba">${c.Team}</span>`:''}
              </div>
              <span class="chat-time">${c.Timestamp?timeAgo(c.Timestamp*1000):'—'}</span>
            </div>
            <div class="chat-text">${c.Message||c.Content||'—'}</div>
          </div>`).join('') : '<div class="empty" style="padding:20px">No chat logs available<br><span style="font-size:11px">Chat logging may not be enabled for this server</span></div>'}
      </div>
    </div>
  </div>

  <!-- RIGHT: Punishment logs + create punishment -->
  <div class="mod-col">
    <div class="panel" style="flex:0">
      <div class="panel-header"><div class="panel-title">➕ Create Log</div></div>
      <div class="panel-body">
        <form action="/api/punishment" method="POST">
          <div class="fg">
            <label>User</label>
            <div class="ac-wrap">
              <input name="targetUsername" id="mod-player-input" placeholder="Enter username (⌘I / Ctrl+I)" required autocomplete="off" oninput="acSearch(this.value)">
              <div class="ac-list" id="ac-list"></div>
            </div>
          </div>
          <div class="fg"><label>Roblox ID</label><input name="targetRobloxId" id="mod-roblox-id" placeholder="Optional"></div>
          <div class="fg"><label>Type</label>
            <select name="type" onchange="document.getElementById('dur-f').style.display=this.value==='tempban'?'block':'none'">
              <option value="warn">⚠️ Warning</option>
              <option value="kick">👢 Kick</option>
              <option value="ban">🔨 Ban</option>
              <option value="tempban">⏳ Temp Ban</option>
              <option value="bolo">👁️ BOLO</option>
              <option value="note">📝 Note</option>
            </select>
          </div>
          <div class="fg" id="dur-f" style="display:none"><label>Duration</label><input name="duration" placeholder="e.g. 7 days"></div>
          <div class="fg"><label>Reason</label><textarea name="reason" rows="2" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:12.5px;outline:none;font-family:inherit;resize:vertical"></textarea></div>
          <div class="fg"><label><input type="checkbox" name="sendPM" value="1" style="accent-color:var(--accent);margin-right:6px">Send DM to Discord user when warned</label></div>
          <input type="hidden" name="discordUserId" id="mod-discord-id">
          <button type="submit" class="btn btn-accent btn-block">📝 Log Punishment</button>
        </form>
      </div>
    </div>

    <div class="panel" style="flex:1">
      <div class="panel-header">
        <div class="panel-title" id="player-log-title">📋 Player Logs</div>
        <a href="/punishments" class="btn btn-ghost btn-sm">All Logs →</a>
      </div>
      <div style="max-height:500px;overflow-y:auto" id="player-log-panel">
        <div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">
          <div style="font-size:28px;margin-bottom:10px;opacity:.4">👤</div>
          Select a player to view their logs
        </div>
      </div>
    </div>
  </div>
</div>

<!-- PM Modal -->
<div id="pm-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:400px">
    <div style="font-size:14px;font-weight:700;margin-bottom:16px">📨 Send PM in ER:LC</div>
    <form action="/api/erlc/pm" method="POST">
      <div class="fg"><label>Player</label><input name="player" id="pm-player" required></div>
      <div class="fg"><label>Message</label><textarea name="message" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical"></textarea></div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-accent" style="flex:1">Send PM</button>
        <button type="button" class="btn btn-ghost" onclick="closePM()">Cancel</button>
      </div>
    </form>
  </div>
</div>

<script>
function filterPlayers(q){document.querySelectorAll('.player-row').forEach(function(r){r.style.display=r.dataset.name.includes(q.toLowerCase())?'':'none';});}
function openPM(name){document.getElementById('pm-modal').style.display='flex';document.getElementById('pm-player').value=name;}
function closePM(){document.getElementById('pm-modal').style.display='none';}
document.getElementById('pm-modal').addEventListener('click',function(e){if(e.target===this)closePM();});
document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='i'){e.preventDefault();document.getElementById('mod-player-input').focus();}});

var acTimeout;
function acSearch(q){
  clearTimeout(acTimeout);
  var list=document.getElementById('ac-list');
  if(!q||q.length<2){list.classList.remove('open');return;}
  acTimeout=setTimeout(function(){
    fetch('/api/players/search?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){
      var ingame=d.ingame||[], db=d.db||[];
      if(!ingame.length&&!db.length){list.classList.remove('open');return;}
      list.innerHTML='';
      ingame.forEach(function(p){
        var el=document.createElement('div');
        el.className='ac-item ac-item-ingame';
        el.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;';
        var img=document.createElement('img');
        img.src='https://cdn.discordapp.com/embed/avatars/0.png';
        img.style.cssText='width:36px;height:36px;border-radius:50%;background:var(--surface3);flex-shrink:0;border:2px solid var(--accent)';
        fetch('/api/roblox/profile?username='+encodeURIComponent(p.name)).then(function(r){return r.json();}).then(function(prof){if(prof&&prof.avatarUrl)img.src=prof.avatarUrl;});
        var info=document.createElement('div');
        info.innerHTML='<div style="font-weight:700;font-size:13px">'+p.name+'</div><div style="font-size:11px;color:var(--success)">🟢 In-Game &middot; '+p.team+'</div>';
        el.appendChild(img);el.appendChild(info);
        el.addEventListener('click',function(){selectPlayer(p.name);});
        list.appendChild(el);
      });
      db.filter(function(n){return!ingame.find(function(p){return p.name===n;});}).forEach(function(n){
        var el=document.createElement('div');
        el.className='ac-item';
        el.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;';
        var img=document.createElement('img');
        img.src='https://cdn.discordapp.com/embed/avatars/0.png';
        img.style.cssText='width:36px;height:36px;border-radius:50%;background:var(--surface3);flex-shrink:0;';
        fetch('/api/roblox/profile?username='+encodeURIComponent(n)).then(function(r){return r.json();}).then(function(prof){if(prof&&prof.avatarUrl)img.src=prof.avatarUrl;});
        var info=document.createElement('div');
        info.innerHTML='<div style="font-weight:700;font-size:13px">'+n+'</div><div style="font-size:11px;color:var(--muted)">📋 In logs</div>';
        el.appendChild(img);el.appendChild(info);
        el.addEventListener('click',function(){selectPlayer(n);});
        list.appendChild(el);
      });
      list.classList.add('open');
    });
  },250);
}

function selectPlayer(name){
  document.getElementById('mod-player-input').value=name;
  document.getElementById('ac-list').classList.remove('open');
  loadPlayerPanel(name);
}

function loadPlayerPanel(username){
  var panel=document.getElementById('player-log-panel');
  var title=document.getElementById('player-log-title');
  title.textContent=username+"'s Logs";
  panel.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted);font-size:13px">Loading...</div>';
  Promise.all([
    fetch('/api/roblox/profile?username='+encodeURIComponent(username)).then(function(r){return r.json();}),
    fetch('/api/player/logs?username='+encodeURIComponent(username)).then(function(r){return r.json();})
  ]).then(function(results){
    var prof=results[0], logs=results[1];
    var html='';
    if(prof){
      var age=prof.created?Math.floor((Date.now()-new Date(prof.created))/(86400000)):null;
      html+='<div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface2)">'
        +'<img src="'+(prof.avatarUrl||'https://cdn.discordapp.com/embed/avatars/0.png')+'" style="width:52px;height:52px;border-radius:50%;border:2px solid '+(prof.isBanned?'var(--danger)':'var(--accent)')+';flex-shrink:0">'
        +'<div style="flex:1;min-width:0">'
          +'<div style="font-size:15px;font-weight:800">'+prof.displayName+'</div>'
          +(prof.displayName!==prof.name?'<div style="font-size:11px;color:var(--muted)">@'+prof.name+'</div>':'')
          +'<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">'
            +(prof.isBanned?'<span class="badge br">🔨 Banned</span>':'<span class="badge bg">✅ Active</span>')
            +(age!==null?'<span class="badge ba">'+age+'d old</span>':'')
            +(prof.friendCount!==null?'<span class="badge bb">'+prof.friendCount+' friends</span>':'')
          +'</div>'
        +'</div>'
        +'<div style="text-align:right;flex-shrink:0">'
          +'<div style="font-size:26px;font-weight:800;color:'+(logs.total?'var(--danger)':'var(--success)')+'">'+logs.total+'</div>'
          +'<div style="font-size:10px;color:var(--muted)">log'+(logs.total!==1?'s':'')+'</div>'
        +'</div>'
      +'</div>';
    }
    if(logs.punishments&&logs.punishments.length){
      html+='<div style="padding:8px 14px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;background:var(--surface2)">Punishments ('+logs.punishments.length+')</div>';
      logs.punishments.forEach(function(p){
        var bc=p.type==='ban'?'br':p.type==='kick'?'by':p.type==='note'?'bb':'by';
        html+='<div style="padding:10px 14px;border-bottom:1px solid var(--border)">'
          +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">'
            +'<span class="badge '+bc+'">'+p.type+'</span>'
            +'<span style="font-size:10px;color:var(--muted)">'+new Date(p.createdAt).toLocaleDateString()+'</span>'
          +'</div>'
          +'<div style="font-size:12px;color:var(--text2)">'+(p.reason||'No reason')+'</div>'
          +'<div style="font-size:11px;color:var(--muted);margin-top:2px">By '+(p.moderatorTag||'?')+'</div>'
        +'</div>';
      });
    }
    if(logs.warnings&&logs.warnings.length){
      html+='<div style="padding:8px 14px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;background:var(--surface2)">Warnings ('+logs.warnings.length+')</div>';
      logs.warnings.forEach(function(w){
        html+='<div style="padding:10px 14px;border-bottom:1px solid var(--border)">'
          +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">'
            +'<span class="badge by">⚠️ warning</span>'
            +'<span style="font-size:10px;color:var(--muted)">'+new Date(w.createdAt).toLocaleDateString()+'</span>'
          +'</div>'
          +'<div style="font-size:12px;color:var(--text2)">'+(w.reason||'No reason')+'</div>'
          +'<div style="font-size:11px;color:var(--muted);margin-top:2px">By '+(w.issuedBy||'?')+'</div>'
        +'</div>';
      });
    }
    if(!logs.total) html+='<div style="padding:30px;text-align:center;color:var(--muted);font-size:13px">✅ No logs found</div>';
    panel.innerHTML=html;
  }).catch(function(){panel.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted)">Failed to load</div>';});
}

document.addEventListener('click',function(e){if(!e.target.closest('.ac-wrap'))document.getElementById('ac-list').classList.remove('open');});
setInterval(function(){document.querySelectorAll('[data-start]').forEach(function(el){var s=parseInt(el.dataset.start);if(!s)return;var d=Date.now()-s;var h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000),sec=Math.floor((d%60000)/1000);el.textContent=(h>0?h+'h ':'')+m+'m '+sec+'s';});},1000);
</script>`;

  res.send(layout(req.user, 'moderator', content, flash(req)));
});

// ── Chat Logs ─────────────────────────────────────────────
app.get('/chatlogs', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let chatLogs = [], players = {};
  try {
    const raw = await erlc('/server/chatlogs', 'GET', null, key);
    chatLogs = Array.isArray(raw) ? raw : [];
  } catch {}
  try { players = await erlc('/server/players', 'GET', null, key); } catch {}
  const pl = Object.values(players);
  const dbChats = await ChatLog.find({ guildId: GUILD_ID }).sort({ timestamp: -1 }).limit(200);

  // Merge ERLC live + stored
  const allChats = [
    ...chatLogs.map(c => ({ player: c.Player||c.Username||'?', team: c.Team||'', message: c.Message||c.Content||'?', timestamp: c.Timestamp ? c.Timestamp*1000 : Date.now(), source: 'live' })),
    ...dbChats.map(c => ({ player: c.player, team: c.team||'', message: c.message, timestamp: c.timestamp, source: 'stored' }))
  ].sort((a,b)=>b.timestamp-a.timestamp).slice(0, 200);

  const teamColors = {};
  pl.forEach(p => {
    if (p.Team) teamColors[p.Team] = teamColors[p.Team] || '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
  });

  const content = `
<div class="stats">
  <div class="stat"><span class="stat-icon">💬</span><div class="stat-label">Total Messages</div><div class="stat-value">${allChats.length}</div></div>
  <div class="stat"><span class="stat-icon">🟢</span><div class="stat-label">Live (ERLC)</div><div class="stat-value">${chatLogs.length}</div></div>
  <div class="stat"><span class="stat-icon">💾</span><div class="stat-label">Stored</div><div class="stat-value">${dbChats.length}</div></div>
  <div class="stat"><span class="stat-icon">👥</span><div class="stat-label">In Game</div><div class="stat-value">${pl.length}</div></div>
</div>

<div class="g21">
  <div>
    <div class="search-bar">🔍 <input placeholder="Filter by player or message..." id="chat-search" oninput="filterChats(this.value)"></div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">💬 Chat Logs <span class="badge ba">${allChats.length}</span></div></div>
      <div style="max-height:600px;overflow-y:auto" id="chat-list">
        ${allChats.length ? allChats.map((c,i)=>`
          <div class="chat-msg" data-search="${(c.player+' '+c.message).toLowerCase()}">
            <div class="chat-header">
              <div style="display:flex;align-items:center;gap:7px">
                ${c.source==='live'?'<span style="width:6px;height:6px;border-radius:50%;background:var(--success);flex-shrink:0"></span>':''}
                <span class="chat-player">${c.player}</span>
                ${c.team?`<span class="badge ba" style="font-size:9px">${c.team}</span>`:''}
              </div>
              <span class="chat-time">${timeAgo(c.timestamp)}</span>
            </div>
            <div class="chat-text">${c.message}</div>
          </div>`).join('') : `<div class="empty"><div class="empty-icon">💬</div>No chat logs available<br><small>ER:LC chat logging may not be enabled for this server</small></div>`}
      </div>
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">👥 Players In-Game</div></div>
      ${pl.length ? `<div style="max-height:200px;overflow-y:auto">${pl.map(p=>`<div class="shift-row"><div class="player-icon" style="width:26px;height:26px;font-size:11px">👤</div><div style="flex:1"><div class="shift-name" style="font-size:12px">${p.Player}</div><div class="shift-time">${p.Team||'No Team'}</div></div><button class="btn btn-ghost btn-sm" onclick="document.getElementById('pm-player').value='${p.Player}';document.getElementById('pm-modal').style.display='flex'">PM</button></div>`).join('')}</div>` : '<div class="empty" style="padding:16px">No players in game</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">📨 Send PM</div></div>
      <div class="panel-body">
        <form action="/api/erlc/pm" method="POST">
          <div class="fg"><label>Player Name</label><input name="player" id="pm-player" placeholder="Exact username" required></div>
          <div class="fg"><label>Message</label><textarea name="message" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical" placeholder="Type your message..."></textarea></div>
          <button type="submit" class="btn btn-accent btn-block">📨 Send PM</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">ℹ️ Chat Info</div></div>
      <div class="panel-body" style="font-size:12px;color:var(--muted);line-height:1.8">
        Live chat logs are pulled directly from the ER:LC API.<br><br>
        📡 <b style="color:var(--text)">Green dot</b> = live from ERLC<br>
        💾 <b style="color:var(--text)">No dot</b> = stored in database<br><br>
        Chat logs are saved automatically when staff interact with the system.
      </div>
    </div>
  </div>
</div>

<div id="pm-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:380px">
    <div style="font-size:14px;font-weight:700;margin-bottom:16px">📨 Send PM in ER:LC</div>
    <form action="/api/erlc/pm" method="POST">
      <div class="fg"><label>Player</label><input name="player" id="pm-player-modal" required></div>
      <div class="fg"><label>Message</label><textarea name="message" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical"></textarea></div>
      <div style="display:flex;gap:8px"><button type="submit" class="btn btn-accent" style="flex:1">Send</button><button type="button" class="btn btn-ghost" onclick="document.getElementById('pm-modal').style.display='none'">Cancel</button></div>
    </form>
  </div>
</div>

<script>
function filterChats(q){document.querySelectorAll('[data-search]').forEach(el=>{el.style.display=el.dataset.search.includes(q.toLowerCase())?'':'none'});}
</script>`;

  res.send(layout(req.user, 'chatlogs', content, flash(req)));
});

// ── Warnings ──────────────────────────────────────────────
app.get('/warnings', isAuth, async (req, res) => {
  const warnings = await Warning.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(100);
  const byUser = {};
  warnings.forEach(w => {
    if (!byUser[w.targetUsername]) byUser[w.targetUsername] = [];
    byUser[w.targetUsername].push(w);
  });
  const sorted = Object.entries(byUser).sort((a,b) => b[1].length - a[1].length);

  const content = `
<div class="stats">
  <div class="stat"><span class="stat-icon">⚠️</span><div class="stat-label">Total Warnings</div><div class="stat-value">${warnings.length}</div></div>
  <div class="stat"><span class="stat-icon">👥</span><div class="stat-label">Unique Players</div><div class="stat-value">${sorted.length}</div></div>
  <div class="stat"><span class="stat-icon">🔥</span><div class="stat-label">Most Warned</div><div class="stat-value" style="font-size:14px;margin-top:4px">${sorted[0]?sorted[0][0]:'—'}</div><div class="stat-sub">${sorted[0]?sorted[0][1].length+' warnings':''}</div></div>
</div>

<div class="g21">
  <div>
    <div class="search-bar">🔍 <input placeholder="Search player..." id="warn-search" oninput="filterWarn(this.value)"></div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚠️ Warning Log <span class="badge by">${warnings.length}</span></div></div>
      <div id="warn-list">
        ${sorted.map(([user, ws]) => `
          <div class="puncard" data-warn="${user.toLowerCase()}" style="margin:8px">
            <div class="puncard-header">
              <span class="puncard-user">🎯 ${user}</span>
              <span class="badge ${ws.length>=3?'br':ws.length>=2?'by':'bo'}">${ws.length} warning${ws.length!==1?'s':''}</span>
            </div>
            <div style="margin-top:8px">
              ${ws.map(w=>`<div style="padding:6px 0;border-top:1px solid var(--border);font-size:11px;color:var(--muted)">
                <b style="color:var(--text)">${w.reason||'No reason'}</b> · by ${w.issuedBy||'?'} · ${timeAgo(w.createdAt)}
                ${w.dmSent?'<span class="badge bg" style="margin-left:4px">DM sent</span>':''}
              </div>`).join('')}
            </div>
          </div>`).join('') || '<div class="empty"><div class="empty-icon">⚠️</div>No warnings issued</div>'}
      </div>
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">➕ Issue Warning</div></div>
      <div class="panel-body">
        <form action="/api/warnings/issue" method="POST">
          <div class="fg">
            <label>Roblox Username</label>
            <div class="ac-wrap">
              <input name="targetUsername" id="warn-player" placeholder="Player name" required autocomplete="off" oninput="acSearchWarn(this.value)">
              <div class="ac-list" id="ac-warn"></div>
            </div>
          </div>
          <div class="fg"><label>Roblox ID (optional)</label><input name="targetRobloxId" placeholder="For auto-lookup"></div>
          <div class="fg"><label>Discord User ID (optional)</label><input name="discordUserId" placeholder="For auto DM on warn"></div>
          <div class="fg"><label>Reason</label><textarea name="reason" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical" placeholder="Describe the reason..."></textarea></div>
          <div class="fg"><label style="display:flex;align-items:center;gap:8px;text-transform:none"><input type="checkbox" name="sendPM" value="1" style="accent-color:var(--accent)"> Send in-game PM via ER:LC</label></div>
          <div class="fg"><label style="display:flex;align-items:center;gap:8px;text-transform:none"><input type="checkbox" name="sendDiscordDM" value="1" style="accent-color:var(--accent)"> Send Discord DM (if Discord ID provided)</label></div>
          <button type="submit" class="btn btn-accent btn-block">⚠️ Issue Warning</button>
        </form>
      </div>
    </div>
  </div>
</div>
<script>
function filterWarn(q){document.querySelectorAll('[data-warn]').forEach(el=>{el.style.display=el.dataset.warn.includes(q.toLowerCase())?'':'none'});}
let awt;
async function acSearchWarn(q){
  clearTimeout(awt);const list=document.getElementById('ac-warn');
  if(!q||q.length<2){list.classList.remove('open');return;}
  awt=setTimeout(async()=>{
    const r=await fetch('/api/players/search?q='+encodeURIComponent(q));
    const d=await r.json();
    const all=[...(d.ingame||[]).map(p=>({name:p.name,sub:p.team,ingame:true})),...(d.db||[]).filter(n=>!(d.ingame||[]).find(p=>p.name===n)).map(n=>({name:n,sub:'in logs',ingame:false}))];
    if(!all.length){list.classList.remove('open');return;}
    list.innerHTML=all.map(function(p){
      var cls='ac-item'+(p.ingame?' ac-item-ingame':'');
      var icon=p.ingame?'🟢':'📋';
      return '<div class="'+cls+'" onclick="document.getElementById(\'warn-player\').value=\''+p.name.replace(/'/g,"\\'")+"';document.getElementById('ac-warn').classList.remove('open')\">"+icon+' <span><b>'+p.name+'</b> <small style="color:var(--muted)">'+p.sub+'</small></span></div>';
    }).join('');
    list.classList.add('open');
  },200);
}
document.addEventListener('click',function(e){if(!e.target.closest('.ac-wrap'))document.getElementById('ac-warn').classList.remove('open');});
</script>`;

  res.send(layout(req.user, 'warnings', content, flash(req)));
});

app.post('/api/warnings/issue', isAuth, async (req, res) => {
  const { targetUsername, targetRobloxId, discordUserId, reason, sendPM, sendDiscordDM } = req.body;
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;

  let dmSent = false;
  // Send in-game PM via ERLC
  if (sendPM) {
    try {
      await erlc('/server/command', 'POST', { command: `:pm ${targetUsername} ⚠️ WARNING: ${reason}` }, key);
    } catch {}
  }
  // Send Discord DM
  if (sendDiscordDM && discordUserId) {
    try {
      await sendDM(discordUserId, `⚠️ **You have been warned on ${process.env.SERVER_NAME || 'NYLRP'}**\n\n**Reason:** ${reason}\n**Issued by:** ${req.user.username}\n\nPlease make sure to follow the rules.`);
      dmSent = true;
    } catch {}
  }

  await Warning.create({
    guildId: GUILD_ID, targetUsername, targetRobloxId: targetRobloxId||null,
    discordUserId: discordUserId||null, reason, issuedBy: req.user.username,
    issuedById: req.user.id, dmSent, createdAt: Date.now()
  });
  await logActivity(req.user.id, req.user.username, 'warning.issue', { target: targetUsername, reason });
  res.redirect('/warnings?success=Warning+issued');
});

// ── BOLO Board ────────────────────────────────────────────
app.get('/bolo', isAuth, async (req, res) => {
  const active = await BoloEntry.find({ guildId: GUILD_ID, active: true }).sort({ createdAt: -1 });
  const recent = await BoloEntry.find({ guildId: GUILD_ID, active: false }).sort({ resolvedAt: -1 }).limit(20);

  const content = `
<div class="stats">
  <div class="stat"><span class="stat-icon">👁️</span><div class="stat-label">Active BOLOs</div><div class="stat-value">${active.length}</div></div>
  <div class="stat"><span class="stat-icon">✅</span><div class="stat-label">Resolved</div><div class="stat-value">${recent.length}</div></div>
</div>

<div class="g21">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🎯 Active BOLOs <span class="badge br">${active.length}</span></div></div>
      ${active.length ? active.map(b=>`
        <div class="bolo-card" style="margin:10px">
          <div class="bolo-header">
            <span class="bolo-name">🎯 ${b.playerName}</span>
            <form action="/api/bolo/resolve/${b._id}" method="POST" style="display:inline">
              <button type="submit" class="btn btn-ghost btn-sm">✅ Resolve</button>
            </form>
          </div>
          <div class="bolo-meta">
            ${b.reason||'No reason stated'}<br>
            ${b.description?`<span>${b.description}</span><br>`:''}
            <b style="color:var(--text)">Issued by</b> ${b.issuedBy} · ${timeAgo(b.createdAt)}
            ${b.robloxId?`<br>Roblox ID: <code>${b.robloxId}</code>`:''}
          </div>
        </div>`).join('') : '<div class="empty"><div class="empty-icon">👁️</div>No active BOLOs</div>'}
    </div>

    ${recent.length ? `
    <div class="panel">
      <div class="panel-header"><div class="panel-title">✅ Recently Resolved</div></div>
      <div class="table-wrap"><table><thead><tr><th>Player</th><th>Reason</th><th>By</th><th>Resolved</th></tr></thead><tbody>
        ${recent.map(b=>`<tr><td><b>${b.playerName}</b></td><td class="wrap">${b.reason||'—'}</td><td>${b.issuedBy}</td><td>${timeAgo(b.resolvedAt)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>` : ''}
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">➕ Issue BOLO</div></div>
      <div class="panel-body">
        <form action="/api/bolo/create" method="POST">
          <div class="fg">
            <label>Roblox Username</label>
            <div class="ac-wrap">
              <input name="playerName" id="bolo-player" placeholder="Player name" required autocomplete="off" oninput="acBolo(this.value)">
              <div class="ac-list" id="ac-bolo"></div>
            </div>
          </div>
          <div class="fg"><label>Roblox ID (optional)</label><input name="robloxId" placeholder="123456789"></div>
          <div class="fg"><label>Reason</label><input name="reason" placeholder="Short reason" required></div>
          <div class="fg"><label>Description (optional)</label><textarea name="description" rows="3" style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical" placeholder="Additional details, last seen location, etc."></textarea></div>
          <button type="submit" class="btn btn-danger btn-block">👁️ Issue BOLO</button>
        </form>
      </div>
    </div>
  </div>
</div>
<script>
let abt;
async function acBolo(q){
  clearTimeout(abt);const list=document.getElementById('ac-bolo');
  if(!q||q.length<2){list.classList.remove('open');return;}
  abt=setTimeout(async()=>{
    const r=await fetch('/api/players/search?q='+encodeURIComponent(q));
    const d=await r.json();
    const all=[...(d.ingame||[]).map(p=>({name:p.name,sub:p.team,ingame:true})),...(d.db||[]).filter(n=>!(d.ingame||[]).find(p=>p.name===n)).map(n=>({name:n,sub:'in logs',ingame:false}))];
    if(!all.length){list.classList.remove('open');return;}
    list.innerHTML=all.map(function(p){var cls='ac-item'+(p.ingame?' ac-item-ingame':'');var icon=p.ingame?'🟢':'📋';return '<div class="'+cls+'" onclick="document.getElementById(\'bolo-player\').value=\''+p.name.replace(/'/g,"\\'")+'\';document.getElementById(\'ac-bolo\').classList.remove(\'open\')">'+icon+' <b>'+p.name+'</b> <small style="color:var(--muted)">'+p.sub+'</small></div>';}).join('');
    list.classList.add('open');
  },200);
}
document.addEventListener('click',function(e){if(!e.target.closest('.ac-wrap'))document.getElementById('ac-bolo').classList.remove('open');});
</script>`;

  res.send(layout(req.user, 'bolo', content, flash(req)));
});

app.post('/api/bolo/create', isAuth, async (req, res) => {
  const { playerName, robloxId, reason, description } = req.body;
  await BoloEntry.create({ guildId: GUILD_ID, playerName, robloxId: robloxId||null, reason, description: description||null, issuedBy: req.user.username, issuedById: req.user.id, active: true, createdAt: Date.now() });
  await logActivity(req.user.id, req.user.username, 'bolo.create', { player: playerName });
  res.redirect('/bolo?success=BOLO+issued');
});

app.post('/api/bolo/resolve/:id', isAuth, async (req, res) => {
  await BoloEntry.findByIdAndUpdate(req.params.id, { active: false, resolvedBy: req.user.username, resolvedAt: Date.now() });
  res.redirect('/bolo?success=BOLO+resolved');
});

// ── Sessions ──────────────────────────────────────────────
app.get('/sessions', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const sc = cfg?.session ?? {};
  const currentSession = await SessionVote.findOne({ guildId: GUILD_ID, active: true });
  const sessionHistory = await SessionVote.find({ guildId: GUILD_ID, active: false }).sort({ endedAt: -1 }).limit(10);

  const content = `
<div class="stats">
  <div class="stat${currentSession?' stat-active':''}"><span class="stat-icon">${currentSession?'🟢':'⚫'}</span><div class="stat-label">Session</div><div class="stat-value" style="font-size:16px;margin-top:4px">${currentSession?'ACTIVE':'OFFLINE'}</div></div>
  <div class="stat"><span class="stat-icon">🗳️</span><div class="stat-label">Vote Threshold</div><div class="stat-value">${sc.voteThreshold??6}</div></div>
  <div class="stat"><span class="stat-icon">👥</span><div class="stat-label">Votes Cast</div><div class="stat-value">${currentSession?.votes?.length??0}</div></div>
  <div class="stat"><span class="stat-icon">📊</span><div class="stat-label">Sessions Run</div><div class="stat-value">${sessionHistory.length}</div></div>
</div>

<div class="g12">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚡ Session Control</div></div>
      <div class="panel-body">
        ${currentSession ? `
        <div class="session-card" style="margin-bottom:14px">
          <div class="session-status">🟢 Session in Progress</div>
          <div class="session-count">${currentSession.votes?.length??0}</div>
          <div class="session-label">votes / ${sc.voteThreshold??6} needed</div>
          <div class="vote-bar"><div class="vote-fill" style="width:${Math.min(100,((currentSession.votes?.length??0)/(sc.voteThreshold??6))*100)}%"></div></div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Started ${timeAgo(currentSession.startedAt)} by ${currentSession.startedBy}</div>
        </div>
        <form action="/api/sessions/end" method="POST">
          <button type="submit" class="btn btn-danger btn-block">⏹ End Session</button>
        </form>` : `
        <div class="session-card" style="margin-bottom:14px">
          <div class="session-status">⚫ No Active Session</div>
          <div class="session-count" style="color:var(--muted)">—</div>
          <div class="session-label">Start a session to begin voting</div>
        </div>
        <form action="/api/sessions/start" method="POST">
          <div class="fg"><label>Join Link (optional)</label><input name="joinLink" placeholder="https://..." value="${sc.joinLink||''}"></div>
          <button type="submit" class="btn btn-accent btn-block">▶ Start Session</button>
        </form>`}
      </div>
    </div>

    ${currentSession ? `
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🗳️ Votes</div></div>
      ${currentSession.votes?.length ? `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Time</th></tr></thead><tbody>${currentSession.votes.map(v=>`<tr><td><b>${v.username}</b></td><td>${timeAgo(v.at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No votes yet</div>'}
    </div>` : ''}
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📊 Session Settings</div></div>
      <div class="panel-body">
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Configure session settings via <code>/setup session</code> in Discord.</div>
        <div class="table-wrap"><table><tbody>
          <tr><td>Vote Threshold</td><td><span class="badge ba">${sc.voteThreshold??6}</span></td></tr>
          <tr><td>Announcement Channel</td><td><span class="badge ${sc.channel?'bg':'br'}">${sc.channel?'✅ Set':'Not set'}</span></td></tr>
          <tr><td>Join Link</td><td><span class="badge ${sc.joinLink?'bg':'br'}">${sc.joinLink?'✅ Set':'Not set'}</span></td></tr>
        </tbody></table></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">📋 Session History</div></div>
      ${sessionHistory.length ? `<div class="table-wrap"><table><thead><tr><th>Started By</th><th>Duration</th><th>Votes</th><th>Date</th></tr></thead><tbody>
        ${sessionHistory.map(s=>`<tr><td><b>${s.startedBy}</b></td><td>${s.startedAt&&s.endedAt?fmt(s.endedAt-s.startedAt):'—'}</td><td>${s.votes?.length??0}</td><td>${new Date(s.startedAt).toLocaleDateString()}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No session history</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'sessions', content, flash(req)));
});

app.post('/api/sessions/start', isAuth, async (req, res) => {
  const existing = await SessionVote.findOne({ guildId: GUILD_ID, active: true });
  if (!existing) {
    await SessionVote.create({ guildId: GUILD_ID, startedBy: req.user.username, startedById: req.user.id, votes: [], active: true, startedAt: Date.now() });
  }
  res.redirect('/sessions?success=Session+started');
});

app.post('/api/sessions/end', isAuth, async (req, res) => {
  await SessionVote.findOneAndUpdate({ guildId: GUILD_ID, active: true }, { active: false, endedAt: Date.now() });
  res.redirect('/sessions?success=Session+ended');
});

// ── Staff Roster ──────────────────────────────────────────
app.get('/roster', isAuth, async (req, res) => {
  const members = await RosterMember.find({ guildId: GUILD_ID }).sort({ rank: 1, username: 1 });
  const byRank = {};
  members.forEach(m => { if (!byRank[m.rank||'Staff']) byRank[m.rank||'Staff'] = []; byRank[m.rank||'Staff'].push(m); });
  const activeShifts = await Shift.find({ guildId: GUILD_ID, endTime: null });
  const onDutyIds = new Set(activeShifts.map(s => s.userId));

  const content = `
<div class="stats">
  <div class="stat"><span class="stat-icon">👥</span><div class="stat-label">Total Staff</div><div class="stat-value">${members.length}</div></div>
  <div class="stat"><span class="stat-icon">🟢</span><div class="stat-label">On Duty</div><div class="stat-value">${onDutyIds.size}</div></div>
  <div class="stat"><span class="stat-icon">📊</span><div class="stat-label">Ranks</div><div class="stat-value">${Object.keys(byRank).length}</div></div>
</div>

<div class="g12">
  <div>
    ${Object.entries(byRank).map(([rank, mems]) => `
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">${rank} <span class="badge ba">${mems.length}</span></div>
      </div>
      <div class="roster-rank" style="border:none;margin:0;border-radius:0">
        ${mems.map(m => `
          <div class="roster-member">
            <img class="roster-av" src="https://cdn.discordapp.com/avatars/${m.discordId}/${m.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;font-weight:600">${m.username}</div>
              <div style="font-size:10px;color:var(--muted)">${m.robloxUsername||'Not linked'}</div>
            </div>
            <span class="online-dot ${onDutyIds.has(m.discordId)?'dot-green':'dot-grey'}"></span>
            ${onDutyIds.has(m.discordId)?'<span class="badge bg" style="font-size:9px">On Duty</span>':''}
            <a href="/search?q=${m.robloxUsername||''}" class="btn btn-ghost btn-sm">🔍</a>
            <form action="/api/roster/remove/${m._id}" method="POST" style="display:inline"><button class="btn btn-ghost btn-sm">🗑️</button></form>
          </div>`).join('')}
      </div>
    </div>`).join('') || '<div class="panel"><div class="empty"><div class="empty-icon">👥</div>No roster members added</div></div>'}
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">➕ Add Member</div></div>
      <div class="panel-body">
        <form action="/api/roster/add" method="POST">
          <div class="fg"><label>Discord ID</label><input name="discordId" placeholder="Discord user ID" required></div>
          <div class="fg"><label>Username</label><input name="username" placeholder="Display name" required></div>
          <div class="fg"><label>Roblox Username</label><input name="robloxUsername" placeholder="For search linking"></div>
          <div class="fg"><label>Rank</label><input name="rank" placeholder="e.g. Moderator, Admin, Owner" required></div>
          <div class="fg"><label>Avatar Hash (optional)</label><input name="avatar" placeholder="Discord avatar hash"></div>
          <button type="submit" class="btn btn-accent btn-block">➕ Add to Roster</button>
        </form>
      </div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'roster', content, flash(req)));
});

app.post('/api/roster/add', isAuth, async (req, res) => {
  const { discordId, username, robloxUsername, rank, avatar } = req.body;
  await RosterMember.create({ guildId: GUILD_ID, discordId, username, robloxUsername: robloxUsername||null, rank, avatar: avatar||null });
  res.redirect('/roster?success=Member+added');
});
app.post('/api/roster/remove/:id', isAuth, async (req, res) => {
  await RosterMember.findByIdAndDelete(req.params.id);
  res.redirect('/roster?success=Member+removed');
});

// ── Announcements ─────────────────────────────────────────
app.get('/announce', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const recentAnnouncements = await Announcement.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(20);

  const content = `
<div class="g21">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📢 Recent Announcements</div></div>
      ${recentAnnouncements.length ? recentAnnouncements.map(a => `
        <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-weight:700;font-size:13px">${a.title||'Announcement'}</div>
            <span class="badge ba">#${a.channelName||'channel'}</span>
          </div>
          <div style="font-size:12.5px;color:var(--text2);margin-bottom:8px;line-height:1.6">${a.content}</div>
          <div style="font-size:11px;color:var(--muted)">By ${a.sentBy} · ${timeAgo(a.createdAt)}</div>
        </div>`).join('') : '<div class="empty">No announcements sent yet</div>'}
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📤 Send Announcement</div></div>
      <div class="panel-body">
        <form action="/api/announce/send" method="POST">
          <div class="fg"><label>Channel ID</label><input name="channelId" placeholder="Discord channel ID" required></div>
          <div class="fg"><label>Channel Name (display)</label><input name="channelName" placeholder="e.g. #announcements"></div>
          <div class="fg"><label>Title (for embed)</label><input name="title" placeholder="Session Starting!"></div>
          <div class="fg"><label>Message</label><textarea name="content" rows="5" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical" placeholder="Type your announcement..."></textarea></div>
          <div class="fg"><label>Embed Color (hex)</label><input name="color" placeholder="#00e5a0" value="#00e5a0"></div>
          <div class="fg"><label style="display:flex;align-items:center;gap:8px;text-transform:none"><input type="checkbox" name="useEmbed" value="1" style="accent-color:var(--accent)"> Send as embed</label></div>
          <button type="submit" class="btn btn-accent btn-block">📢 Send Announcement</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🎮 In-Game Announcement</div></div>
      <div class="panel-body">
        <form action="/api/erlc/announce" method="POST">
          <div class="fg"><label>Message</label><textarea name="message" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical" placeholder=":h [SERVER] Announcement text..."></textarea></div>
          <button type="submit" class="btn btn-blue btn-block">🎮 Send In-Game</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚙️ Custom Join Link</div></div>
      <div class="panel-body">
        <form action="/api/settings/joinlink" method="POST">
          <div class="fg"><label>Join Link URL</label><input name="joinLink" placeholder="https://www.roblox.com/games/..." value="${(await getConfig())?.session?.joinLink||''}"></div>
          <button type="submit" class="btn btn-accent btn-block">💾 Save Join Link</button>
        </form>
      </div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'announce', content, flash(req)));
});

app.post('/api/announce/send', isAuth, async (req, res) => {
  const { channelId, channelName, title, content, color, useEmbed } = req.body;
  try {
    const embed = useEmbed ? { title: title||'Announcement', description: content, color: parseInt((color||'#00e5a0').replace('#',''), 16), footer: { text: `Sent by ${req.user.username}` }, timestamp: new Date().toISOString() } : null;
    await sendChannelMessage(channelId, useEmbed ? '' : content, embed);
    await Announcement.create({ guildId: GUILD_ID, channelId, channelName: channelName||channelId, title: title||'Announcement', content, sentBy: req.user.username, createdAt: Date.now() });
    res.redirect('/announce?success=Announcement+sent');
  } catch (e) { res.redirect('/announce?error=' + encodeURIComponent(e.message)); }
});

app.post('/api/erlc/announce', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try {
    await erlc('/server/command', 'POST', { command: req.body.message }, key);
    res.redirect('/announce?success=In-game+announcement+sent');
  } catch (e) { res.redirect('/announce?error=' + encodeURIComponent(e.message)); }
});

app.post('/api/settings/joinlink', isAuth, async (req, res) => {
  await mongoose.connection.db.collection('guildconfigs').updateOne(
    { guildId: GUILD_ID }, { $set: { 'data.session.joinLink': req.body.joinLink } }, { upsert: true }
  );
  res.redirect('/announce?success=Join+link+saved');
});

// ── In-Game ───────────────────────────────────────────────
app.get('/ingame', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let players = {}, serverInfo = {}, queue = [];
  try { serverInfo = await erlc('/server', 'GET', null, key); } catch {}
  try { players = await erlc('/server/players', 'GET', null, key); } catch {}
  try { queue = await erlc('/server/queue', 'GET', null, key); } catch {}
  const pl = Object.values(players);
  const teams = {};
  pl.forEach(p => { if (!teams[p.Team||'No Team']) teams[p.Team||'No Team'] = []; teams[p.Team||'No Team'].push(p); });

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Total Players</div><div class="stat-value">${pl.length}</div></div>
  <div class="stat"><div class="stat-label">In Queue</div><div class="stat-value">${Array.isArray(queue)?queue.length:0}</div></div>
  <div class="stat"><div class="stat-label">Teams</div><div class="stat-value">${Object.keys(teams).length}</div></div>
  <div class="stat"><div class="stat-label">Server</div><div class="stat-value" style="font-size:14px;margin-top:4px">${serverInfo?.Name??'Unknown'}</div></div>
</div>
${Object.entries(teams).map(([team, members])=>`
<div class="panel">
  <div class="panel-header"><div class="panel-title">🎭 ${team} <span class="badge ba">${members.length}</span></div></div>
  <div class="player-grid">${members.map(p=>`<div class="player-card"><div class="player-icon">👤</div><div><div class="player-name">${p.Player}</div><div class="player-team">${team}</div></div></div>`).join('')}</div>
</div>`).join('') || '<div class="panel"><div class="empty"><div class="empty-icon">🎮</div>No players in game</div></div>'}`;

  res.send(layout(req.user, 'ingame', content));
});

// ── Shifts ────────────────────────────────────────────────
app.get('/shift', isAuth, async (req, res) => {
  const active = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  const recent = await Shift.find({ userId: req.user.id, guildId: GUILD_ID, endTime: { $ne: null } }).sort({ endTime: -1 }).limit(20);
  const allActive = await Shift.find({ guildId: GUILD_ID, endTime: null });
  const leaderboard = await Shift.aggregate([
    { $match: { guildId: GUILD_ID, endTime: { $ne: null } } },
    { $group: { _id: '$userId', username: { $last: '$username' }, avatar: { $last: '$avatar' }, total: { $sum: '$duration' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } }, { $limit: 10 },
  ]);
  const totalTime = recent.reduce((a, s) => a + (s.duration || 0), 0);
  const now = Date.now();

  const content = `
<div class="stats">
  <div class="stat${active?' stat-active':''}"><div class="stat-label">Status</div><div class="stat-value" style="font-size:16px;margin-top:4px">${active?'🟢 On Duty':'⚫ Off'}</div>${active?`<div class="stat-sub">Since ${new Date(active.startTime).toLocaleTimeString()}</div>`:''}</div>
  <div class="stat"><div class="stat-label">Current Duration</div><div class="stat-value" style="font-size:20px" id="shift-timer" data-start="${active?.startTime||0}">${active?fmt(now-active.startTime):'—'}</div></div>
  <div class="stat"><div class="stat-label">Total Time</div><div class="stat-value" style="font-size:20px">${fmt(totalTime)}</div></div>
  <div class="stat"><div class="stat-label">Shifts Completed</div><div class="stat-value">${recent.length}</div></div>
  <div class="stat"><div class="stat-label">Staff On Duty</div><div class="stat-value">${allActive.length}</div></div>
</div>
<div class="g12">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">⏱️ Shift Control</div></div>
      <div class="panel-body">
        ${active ? `
        <div style="background:var(--accent-dim);border:1px solid var(--accent-border);border-radius:10px;padding:18px;text-align:center;margin-bottom:16px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700">Shift started at</div>
          <div style="font-size:30px;font-weight:800;color:var(--accent);margin:4px 0;letter-spacing:-1px">${new Date(active.startTime).toLocaleTimeString()}</div>
          <div style="font-size:13px;color:var(--muted)" id="shift-timer" data-start="${active.startTime}">${fmt(now-active.startTime)}</div>
        </div>
        <form action="/api/shift/end" method="POST"><button type="submit" class="btn btn-danger btn-block">⏹ End Shift</button></form>` :
        `<div style="text-align:center;padding:20px 0;color:var(--muted);font-size:13px;margin-bottom:16px">You are currently off duty</div>
        <form action="/api/shift/start" method="POST"><button type="submit" class="btn btn-accent btn-block">▶ Start Shift</button></form>`}
      </div>
    </div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">👥 All Active Shifts</div></div>
      ${allActive.length ? allActive.map(s=>`<div class="shift-row"><img class="shift-av" src="https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div style="flex:1"><div class="shift-name">${s.username}</div><div class="shift-time">Started ${new Date(s.startTime).toLocaleTimeString()}</div></div><span class="badge bg" data-start="${s.startTime}">${fmt(now-s.startTime)}</span></div>`).join('') : '<div class="empty">No staff on duty</div>'}
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🏆 Leaderboard</div></div>
      ${leaderboard.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Staff</th><th>Time</th><th>Shifts</th></tr></thead><tbody>
        ${leaderboard.map((s,i)=>`<tr><td><b>#${i+1}</b></td><td>${s.username}</td><td><span class="badge ba">${fmt(s.total)}</span></td><td>${s.count}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No data yet</div>'}
    </div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📊 My Recent Shifts</div></div>
      ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>
        ${recent.map(s=>`<tr><td>${new Date(s.startTime).toLocaleDateString()}</td><td>${new Date(s.startTime).toLocaleTimeString()}</td><td>${s.endTime?new Date(s.endTime).toLocaleTimeString():'—'}</td><td><span class="badge ba">${fmt(s.duration||0)}</span></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No shifts yet</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'shift', content, flash(req)));
});

app.post('/api/shift/start', isAuth, async (req, res) => {
  if (!await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null })) {
    await Shift.create({ userId: req.user.id, username: req.user.username, avatar: req.user.avatar, startTime: Date.now(), guildId: GUILD_ID });
    await logActivity(req.user.id, req.user.username, 'shift.start');
  }
  res.redirect('/shift?success=Shift+started');
});
app.post('/api/shift/end', isAuth, async (req, res) => {
  const s = await Shift.findOne({ userId: req.user.id, guildId: GUILD_ID, endTime: null });
  if (s) { s.endTime = Date.now(); s.duration = s.endTime - s.startTime; await s.save(); await logActivity(req.user.id, req.user.username, 'shift.end', { duration: s.duration }); }
  res.redirect('/shift?success=Shift+ended');
});

// ── LOA / RA ──────────────────────────────────────────────
app.get('/loa', isAuth, async (req, res) => {
  const myLeaves = await Leave.find({ userId: req.user.id, guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(10);
  const pending = await Leave.find({ guildId: GUILD_ID, status: 'pending' }).sort({ createdAt: -1 });
  const active = await Leave.find({ guildId: GUILD_ID, status: 'approved', endDate: { $gt: Date.now() } });

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">My Requests</div><div class="stat-value">${myLeaves.length}</div></div>
  <div class="stat"><div class="stat-label">Pending</div><div class="stat-value">${pending.length}</div></div>
  <div class="stat"><div class="stat-label">Active LOAs</div><div class="stat-value">${active.filter(l=>l.type==='loa').length}</div></div>
  <div class="stat"><div class="stat-label">Active RAs</div><div class="stat-value">${active.filter(l=>l.type==='ra').length}</div></div>
</div>
<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📝 Submit Request</div></div>
      <div class="panel-body">
        <form action="/api/loa/request" method="POST">
          <div class="fg"><label>Type</label><select name="type"><option value="loa">🏖️ LOA (Leave of Absence)</option><option value="ra">🔄 RA (Reduced Activity)</option></select></div>
          <div class="fg"><label>Reason</label><textarea name="reason" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 13px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical"></textarea></div>
          <div class="fg"><label>Start Date</label><input type="date" name="startDate" required></div>
          <div class="fg"><label>End Date</label><input type="date" name="endDate" required></div>
          <button type="submit" class="btn btn-accent btn-block">📤 Submit Request</button>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📋 My Requests</div></div>
      ${myLeaves.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Reason</th><th>Period</th><th>Status</th></tr></thead><tbody>
        ${myLeaves.map(l=>`<tr><td><span class="badge ${l.type==='loa'?'ba':'bb'}">${l.type.toUpperCase()}</span></td><td class="wrap" style="max-width:150px">${l.reason||'—'}</td><td>${new Date(l.startDate).toLocaleDateString()} — ${new Date(l.endDate).toLocaleDateString()}</td><td><span class="badge ${l.status==='approved'?'bg':l.status==='denied'?'br':'by'}">${l.status}</span></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No requests submitted</div>'}
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">⏳ Pending <span class="badge by">${pending.length}</span></div></div>
      ${pending.length ? pending.map(l=>`<div style="padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <b>${l.username}</b><span class="badge ${l.type==='loa'?'ba':'bb'}">${l.type.toUpperCase()}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${l.reason||'No reason'}<br>${new Date(l.startDate).toLocaleDateString()} — ${new Date(l.endDate).toLocaleDateString()}</div>
        <div style="display:flex;gap:8px">
          <form action="/api/loa/approve/${l._id}" method="POST" style="flex:1"><button class="btn btn-accent btn-sm" style="width:100%">✅ Approve</button></form>
          <form action="/api/loa/deny/${l._id}" method="POST" style="flex:1"><button class="btn btn-danger btn-sm" style="width:100%">❌ Deny</button></form>
        </div>
      </div>`).join('') : '<div class="empty">No pending requests</div>'}
    </div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">✅ Active Leaves</div></div>
      ${active.length ? `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Type</th><th>Until</th></tr></thead><tbody>
        ${active.map(l=>`<tr><td><b>${l.username}</b></td><td><span class="badge ${l.type==='loa'?'ba':'bb'}">${l.type.toUpperCase()}</span></td><td>${new Date(l.endDate).toLocaleDateString()}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No active leaves</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'loa', content, flash(req)));
});

app.post('/api/loa/request', isAuth, async (req, res) => {
  const { type, reason, startDate, endDate } = req.body;
  await Leave.create({ guildId: GUILD_ID, userId: req.user.id, username: req.user.username, type, reason, startDate: new Date(startDate).getTime(), endDate: new Date(endDate).getTime() });
  res.redirect('/loa?success=Request+submitted');
});
app.post('/api/loa/approve/:id', isAuth, async (req, res) => {
  await Leave.findByIdAndUpdate(req.params.id, { status: 'approved', reviewedBy: req.user.username });
  res.redirect('/loa?success=Request+approved');
});
app.post('/api/loa/deny/:id', isAuth, async (req, res) => {
  await Leave.findByIdAndUpdate(req.params.id, { status: 'denied', reviewedBy: req.user.username });
  res.redirect('/loa?success=Request+denied');
});

// ── Punishments ───────────────────────────────────────────
app.get('/punishments', isAuth, async (req, res) => {
  const search = req.query.q || '';
  const filter = { guildId: GUILD_ID };
  if (search) filter.targetUsername = { $regex: search, $options: 'i' };
  const punishments = await Punishment.find(filter).sort({ createdAt: -1 }).limit(100);
  const total = await Punishment.countDocuments({ guildId: GUILD_ID });

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Total Logs</div><div class="stat-value">${total}</div></div>
  <div class="stat"><div class="stat-label">Bans</div><div class="stat-value">${await Punishment.countDocuments({guildId:GUILD_ID,type:'ban'})}</div></div>
  <div class="stat"><div class="stat-label">Kicks</div><div class="stat-value">${await Punishment.countDocuments({guildId:GUILD_ID,type:'kick'})}</div></div>
  <div class="stat"><div class="stat-label">Warnings</div><div class="stat-value">${await Punishment.countDocuments({guildId:GUILD_ID,type:'warn'})}</div></div>
  <div class="stat"><div class="stat-label">Temp Bans</div><div class="stat-value">${await Punishment.countDocuments({guildId:GUILD_ID,type:'tempban'})}</div></div>
  <div class="stat"><div class="stat-label">BOLOs</div><div class="stat-value">${await Punishment.countDocuments({guildId:GUILD_ID,type:'bolo'})}</div></div>
</div>
<div class="g21">
  <div>
    <div class="search-bar">🔍 <input placeholder="Search player name..." value="${search}" onchange="window.location.href='/punishments?q='+this.value"></div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📋 Punishment Logs <span class="badge ba">${punishments.length}</span></div></div>
      ${punishments.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Player</th><th>Roblox ID</th><th>Reason</th><th>By</th><th>Date</th><th></th></tr></thead><tbody>
        ${punishments.map(p=>`<tr>
          <td><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':p.type==='tempban'?'bp':p.type==='bolo'?'br':p.type==='note'?'bb':'by'}">${p.type}</span></td>
          <td><b><a href="/search?q=${p.targetUsername}" style="color:var(--accent)">${p.targetUsername}</a></b></td>
          <td>${p.targetRobloxId?`<code>${p.targetRobloxId}</code>`:'—'}</td>
          <td class="wrap" style="max-width:200px">${p.reason||'—'}</td>
          <td>${p.moderatorTag||'—'}</td>
          <td>${new Date(p.createdAt).toLocaleDateString()}</td>
          <td><form action="/api/punishment/delete/${p._id}" method="POST" onsubmit="return confirm('Delete this log?')"><button class="btn btn-danger btn-sm">🗑️</button></form></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No punishment logs found</div>'}
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">➕ Log Punishment</div></div>
      <div class="panel-body">
        <form action="/api/punishment" method="POST">
          <div class="fg"><label>Type</label>
            <select name="type">
              <option value="warn">⚠️ Warning</option>
              <option value="kick">👢 Kick</option>
              <option value="ban">🔨 Ban</option>
              <option value="tempban">⏳ Temp Ban</option>
              <option value="bolo">👁️ BOLO</option>
              <option value="note">📝 Note</option>
            </select>
          </div>
          <div class="fg"><label>Roblox Username</label><input name="targetUsername" placeholder="PlayerName" required></div>
          <div class="fg"><label>Roblox ID (optional)</label><input name="targetRobloxId" placeholder="123456789"></div>
          <div class="fg"><label>Reason</label><textarea name="reason" rows="3" required style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 13px;color:var(--text);font-size:13px;outline:none;font-family:inherit;resize:vertical"></textarea></div>
          <div class="fg" id="dur-field" style="display:none"><label>Duration (for Temp Ban)</label><input name="duration" placeholder="e.g. 7 days"></div>
          <div class="fg"><label style="display:flex;align-items:center;gap:8px;text-transform:none"><input type="checkbox" name="sendPM" value="1" style="accent-color:var(--accent)"> Auto-send Discord DM when warned</label></div>
          <input type="hidden" name="discordUserId" id="pun-discord-id">
          <button type="submit" class="btn btn-accent btn-block">📝 Log Punishment</button>
        </form>
      </div>
    </div>
  </div>
</div>
<script>document.querySelector('select[name=type]').addEventListener('change',function(){document.getElementById('dur-field').style.display=this.value==='tempban'?'block':'none'});</script>`;

  res.send(layout(req.user, 'punishments', content, flash(req)));
});

app.post('/api/punishment', isAuth, async (req, res) => {
  const { targetUsername, targetRobloxId, type, reason, duration, sendPM, discordUserId } = req.body;
  await Punishment.create({ guildId: GUILD_ID, moderatorId: req.user.id, moderatorTag: req.user.username, targetUsername, targetRobloxId: targetRobloxId||null, type, reason, duration: duration||null, createdAt: Date.now() });
  await logActivity(req.user.id, req.user.username, 'punishment.create', { type, target: targetUsername });

  // Auto-DM on warn
  if (sendPM && discordUserId && (type === 'warn' || type === 'kick' || type === 'ban')) {
    const typeLabel = { warn: '⚠️ warned', kick: '👢 kicked', ban: '🔨 banned' }[type];
    await sendDM(discordUserId, `You have been **${typeLabel}** on **${process.env.SERVER_NAME || 'NYLRP'}**\n**Reason:** ${reason||'No reason provided'}\n**By:** ${req.user.username}`);
  }

  // If BOLO type, also create a BOLO entry
  if (type === 'bolo') {
    await BoloEntry.create({ guildId: GUILD_ID, playerName: targetUsername, robloxId: targetRobloxId||null, reason, issuedBy: req.user.username, issuedById: req.user.id, active: true, createdAt: Date.now() });
  }

  res.redirect('/punishments?success=Punishment+logged');
});

// ── Roblox profile helper ─────────────────────────────────
async function getRobloxProfile(username) {
  try {
    const r = await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) });
    const d = await r.json();
    const user = d.data?.[0];
    if (!user) return null;
    const [details, avatar, friends] = await Promise.allSettled([
      fetch('https://users.roblox.com/v1/users/' + user.id).then(r=>r.json()),
      fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + user.id + '&size=150x150&format=Png').then(r=>r.json()),
      fetch('https://friends.roblox.com/v1/users/' + user.id + '/friends/count').then(r=>r.json()),
    ]);
    return {
      id: user.id,
      name: user.name,
      displayName: details.value?.displayName || user.name,
      description: details.value?.description || '',
      created: details.value?.created,
      isBanned: details.value?.isBanned || false,
      avatarUrl: avatar.value?.data?.[0]?.imageUrl || null,
      friendCount: friends.value?.count ?? null,
    };
  } catch(e) { return null; }
}

// ── API: Roblox profile lookup ────────────────────────────
app.get('/api/roblox/profile', isAuth, async (req, res) => {
  const username = req.query.username || '';
  if (!username) return res.json(null);
  const profile = await getRobloxProfile(username);
  res.json(profile);
});

// ── Search ────────────────────────────────────────────────
app.get('/api/player/logs', isAuth, async (req, res) => {
  const username = req.query.username || '';
  if (!username) return res.json({ punishments: [], warnings: [], total: 0 });
  const [punishments, warnings] = await Promise.all([
    Punishment.find({ guildId: GUILD_ID, targetUsername: { $regex: username, $options: 'i' } }).sort({ createdAt: -1 }).limit(20),
    Warning.find({ guildId: GUILD_ID, targetUsername: { $regex: username, $options: 'i' } }).sort({ createdAt: -1 }).limit(10),
  ]);
  res.json({ punishments, warnings, total: punishments.length + warnings.length });
});

app.get('/search', isAuth, async (req, res) => {
  const q = req.query.q || '';
  let results = [], robloxUser = null;
  if (q) {
    results = await Punishment.find({ guildId: GUILD_ID, $or: [{ targetUsername: { $regex: q, $options: 'i' } }, { targetRobloxId: q }] }).sort({ createdAt: -1 });
    robloxUser = await getRobloxProfile(q);
  }

  const warnings = q ? await Warning.find({ guildId: GUILD_ID, targetUsername: { $regex: q, $options: 'i' } }) : [];
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let ingamePlayers = [];
  try { const p = await erlc('/server/players', 'GET', null, key); ingamePlayers = Object.values(p).map(p=>p.Player); } catch {}
  const ingameMatch = q ? ingamePlayers.filter(n => n.toLowerCase().includes(q.toLowerCase())) : [];
  const isIngame = ingamePlayers.some(n => n.toLowerCase() === q.toLowerCase());
  const accountAge = robloxUser?.created ? Math.floor((Date.now() - new Date(robloxUser.created)) / (1000*60*60*24)) : null;

  const profileCard = robloxUser ? `
<div class="panel" style="margin:0">
  <div style="background:linear-gradient(135deg,var(--surface2),var(--surface3));padding:24px;display:flex;flex-direction:column;align-items:center;text-align:center;border-bottom:1px solid var(--border)">
    <div style="position:relative;margin-bottom:14px">
      <img src="${robloxUser.avatarUrl||''}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" style="width:90px;height:90px;border-radius:50%;border:3px solid ${robloxUser.isBanned?'var(--danger)':'var(--accent)'};background:var(--surface3)">
      ${isIngame ? '<span style="position:absolute;bottom:2px;right:2px;width:18px;height:18px;background:var(--success);border-radius:50%;border:2px solid var(--surface)"></span>' : ''}
    </div>
    <div style="font-size:20px;font-weight:800;letter-spacing:-.3px">${robloxUser.displayName}</div>
    ${robloxUser.displayName !== robloxUser.name ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">@'+robloxUser.name+'</div>' : ''}
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;justify-content:center">
      ${robloxUser.isBanned ? '<span class="badge br">🔨 Banned</span>' : '<span class="badge bg">✅ Active</span>'}
      ${isIngame ? '<span class="badge ba">🟢 In-Game</span>' : ''}
      ${results.length ? '<span class="badge br">⚠️ '+results.length+' log'+(results.length!==1?'s':'')+'</span>' : '<span class="badge bg">✅ Clean</span>'}
    </div>
  </div>
  <div style="padding:16px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700">Roblox ID</div>
        <div style="font-size:13px;font-weight:700;margin-top:3px;font-family:'JetBrains Mono',monospace">${robloxUser.id}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700">Friends</div>
        <div style="font-size:13px;font-weight:700;margin-top:3px">${robloxUser.friendCount ?? '—'}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700">Account Age</div>
        <div style="font-size:13px;font-weight:700;margin-top:3px">${accountAge !== null ? accountAge+'d' : '—'}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700">Joined</div>
        <div style="font-size:12px;font-weight:700;margin-top:3px">${robloxUser.created ? new Date(robloxUser.created).toLocaleDateString() : '—'}</div>
      </div>
    </div>
    ${robloxUser.description ? '<div style="font-size:11px;color:var(--muted);background:var(--surface2);border-radius:8px;padding:10px;margin-bottom:12px;max-height:60px;overflow:hidden">'+robloxUser.description.slice(0,120)+(robloxUser.description.length>120?'...':'')+'</div>' : ''}
    <div style="display:flex;flex-direction:column;gap:6px">
      <a href="https://www.roblox.com/users/${robloxUser.id}/profile" target="_blank" class="btn btn-ghost btn-block">🔗 Roblox Profile</a>
      <a href="/punishments" class="btn btn-ghost btn-block">🔨 Log Punishment</a>
    </div>
  </div>
</div>` : '';

  const historyPanel = `
<div>
  <div class="panel" style="margin-bottom:14px">
    <div class="panel-header"><div class="panel-title">🔨 Punishment History <span class="badge ${results.length?'br':'bg'}">${results.length}</span></div></div>
    ${results.length ? '<div class="table-wrap"><table><thead><tr><th>Type</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>'+results.map(p=>'<tr><td><span class="badge '+(p.type==='ban'?'br':p.type==='kick'?'by':p.type==='note'?'bb':'by')+'">'+p.type+'</span></td><td class="wrap" style="max-width:180px">'+(p.reason||'—')+'</td><td>'+(p.moderatorTag||'—')+'</td><td>'+new Date(p.createdAt).toLocaleDateString()+'</td></tr>').join('')+'</tbody></table></div>' : '<div class="empty">No punishments ✅</div>'}
  </div>
  ${warnings.length ? '<div class="panel"><div class="panel-header"><div class="panel-title">⚠️ Warnings <span class="badge by">'+warnings.length+'</span></div></div><div class="table-wrap"><table><thead><tr><th>Reason</th><th>By</th><th>Date</th><th>DM</th></tr></thead><tbody>'+warnings.map(w=>'<tr><td class="wrap">'+(w.reason||'—')+'</td><td>'+(w.issuedBy||'—')+'</td><td>'+new Date(w.createdAt).toLocaleDateString()+'</td><td>'+(w.dmSent?'<span class="badge bg">✓</span>':'—')+'</td></tr>').join('')+'</tbody></table></div></div>' : ''}
</div>`;

  const content = `
<div class="panel">
  <div class="panel-header"><div class="panel-title">🔍 Search Player</div></div>
  <div class="panel-body">
    <form method="GET" class="form-row">
      <div class="fg" style="flex:1;margin:0">
        <div class="ac-wrap">
          <input name="q" value="${q}" placeholder="Enter Roblox username or ID..." id="search-input" autocomplete="off" oninput="acMainSearch(this.value)">
          <div class="ac-list" id="ac-main"></div>
        </div>
      </div>
      <button type="submit" class="btn btn-accent">🔍 Search</button>
    </form>
  </div>
</div>

${ingameMatch.length && q ? '<div class="alert alert-w">🟢 <b>In-Game:</b> '+ingameMatch.slice(0,5).map(n=>'<a href="/search?q='+encodeURIComponent(n)+'" style="color:var(--warn);margin-left:8px;font-weight:700">'+n+'</a>').join('')+'</div>' : ''}

${q && robloxUser ? '<div class="g12">'+profileCard+historyPanel+'</div>' : ''}
${q && !robloxUser ? '<div class="panel"><div class="empty"><div class="empty-icon">👤</div>No Roblox user found for "'+q+'"</div></div>' : ''}

<script>
var smt;
function acMainSearch(q){
  clearTimeout(smt);var list=document.getElementById('ac-main');
  if(!q||q.length<2){list.classList.remove('open');return;}
  smt=setTimeout(function(){
    fetch('/api/players/search?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){
      var all=(d.ingame||[]).map(function(p){return{name:p.name,sub:'In-Game: '+p.team,ingame:true};}).concat((d.db||[]).filter(function(n){return!(d.ingame||[]).find(function(p){return p.name===n;});}).map(function(n){return{name:n,sub:'In logs',ingame:false};}));
      if(!all.length){list.classList.remove('open');return;}
      list.innerHTML=all.map(function(p){return '<div class="ac-item'+(p.ingame?' ac-item-ingame':'')+'" onclick="window.location.href=\'?q='+encodeURIComponent(p.name)+'\'">'+( p.ingame?'🟢':'📋')+' <b>'+p.name+'</b> <small style=\'color:var(--muted)\'>'+p.sub+'</small></div>';}).join('');
      list.classList.add('open');
    });
  },250);
}
document.addEventListener('click',function(e){if(!e.target.closest('.ac-wrap'))document.getElementById('ac-main').classList.remove('open');});
</script>`;

  res.send(layout(req.user, 'search', content));
});
// ── Infractions ───────────────────────────────────────────
app.get('/infractions', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const warn = cfg?.warnings ?? {}, note = cfg?.notes ?? {};
  const users = [...new Set([...Object.keys(warn), ...Object.keys(note)])];

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Users</div><div class="stat-value">${users.length}</div></div>
  <div class="stat"><div class="stat-label">Warnings</div><div class="stat-value">${Object.values(warn).reduce((a,b)=>a+b.length,0)}</div></div>
  <div class="stat"><div class="stat-label">Notes</div><div class="stat-value">${Object.values(note).reduce((a,b)=>a+b.length,0)}</div></div>
</div>
<div class="panel">
  <div class="panel-header"><div class="panel-title">⚖️ Discord Infractions (from bot)</div></div>
  ${users.length ? `<div class="table-wrap"><table><thead><tr><th>Discord ID</th><th>Warnings</th><th>Notes</th><th>Last Warning</th></tr></thead><tbody>
    ${users.map(uid=>`<tr>
      <td><code>${uid}</code></td>
      <td>${(warn[uid]||[]).length?`<span class="badge br">⚠️ ${(warn[uid]||[]).length}</span>`:'—'}</td>
      <td>${(note[uid]||[]).length?`<span class="badge by">📝 ${(note[uid]||[]).length}</span>`:'—'}</td>
      <td class="wrap" style="max-width:200px;color:var(--muted)">${(warn[uid]||[]).at(-1)?.reason||'—'}</td>
    </tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No infractions on record</div>'}
</div>`;

  res.send(layout(req.user, 'infractions', content));
});

// ── Members ───────────────────────────────────────────────
app.get('/members', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const v = cfg?.verification?.verifiedUsers ?? {};
  const entries = Object.entries(v);

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Verified Members</div><div class="stat-value">${entries.length}</div></div>
</div>
<div class="search-bar">🔍 <input placeholder="Filter members..." id="member-search" oninput="filterTable(this.value)"></div>
<div class="panel">
  <div class="panel-header"><div class="panel-title">✅ Verified Members</div></div>
  ${entries.length ? `<div class="table-wrap"><table id="member-table"><thead><tr><th>Discord ID</th><th>Roblox</th><th>Roblox ID</th><th>Verified</th><th>Actions</th></tr></thead><tbody>
    ${entries.map(([id,d])=>`<tr>
      <td><code>${id}</code></td>
      <td><a href="https://www.roblox.com/users/${d.robloxId}/profile" target="_blank" style="color:var(--accent)">${d.robloxUsername}</a></td>
      <td><code>${d.robloxId}</code></td>
      <td>${d.verifiedAt?new Date(d.verifiedAt).toLocaleDateString():'—'}</td>
      <td><a href="/search?q=${d.robloxUsername}" class="btn btn-ghost btn-sm">🔍 Search</a></td>
    </tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No verified members</div>'}
</div>
<script>function filterTable(q){const rows=document.querySelectorAll('#member-table tbody tr');rows.forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q.toLowerCase())?'':'none'});}</script>`;

  res.send(layout(req.user, 'members', content));
});

// ── ERLC Logs ─────────────────────────────────────────────
app.get('/erlclogs', isAuth, async (req, res) => {
  const type = req.query.type || 'all';
  const filter = { guildId: GUILD_ID };
  if (type !== 'all') filter.type = type;
  const logs = await ErlcLog.find(filter).sort({ timestamp: -1 }).limit(200);
  const total = await ErlcLog.countDocuments({ guildId: GUILD_ID });
  const typeCount = async (t) => await ErlcLog.countDocuments({ guildId: GUILD_ID, type: t });

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Total Logs</div><div class="stat-value">${total}</div></div>
  <div class="stat"><div class="stat-label">Kill Logs</div><div class="stat-value">${await typeCount('kill')}</div></div>
  <div class="stat"><div class="stat-label">Join/Leave</div><div class="stat-value">${await typeCount('join') + await typeCount('leave')}</div></div>
  <div class="stat"><div class="stat-label">Commands</div><div class="stat-value">${await typeCount('command')}</div></div>
  <div class="stat"><div class="stat-label">Mod Calls</div><div class="stat-value">${await typeCount('modcall')}</div></div>
</div>
<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
  ${['all','kill','join','leave','command','modcall','ban'].map(t=>`<a href="/erlclogs?type=${t}" class="btn ${type===t?'btn-accent':'btn-ghost'} btn-sm">${t.charAt(0).toUpperCase()+t.slice(1)}</a>`).join('')}
</div>
<div class="panel">
  <div class="panel-header"><div class="panel-title">📡 ER:LC Logs <span class="badge ba">${logs.length}</span></div></div>
  ${logs.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Details</th><th>Time</th></tr></thead><tbody>
    ${logs.map(l=>{
      let icon='📋',details='';
      if(l.type==='kill'){icon='💀';details=`<b>${l.data?.Killer}</b> killed <b>${l.data?.Killed}</b> with ${l.data?.Weapon||'?'}`;}
      else if(l.type==='join'){icon='📥';details=`<b>${l.data?.Player}</b> joined (${l.data?.Team||'No Team'})`;}
      else if(l.type==='leave'){icon='📤';details=`<b>${l.data?.Player||l.data}</b> left`;}
      else if(l.type==='command'){icon='⌨️';details=`<b>${l.data?.Player}</b>: <code>${(l.data?.Command||'?').slice(0,50)}</code>`;}
      else if(l.type==='modcall'){icon='🚨';details=`Caller: <b>${l.data?.Caller}</b> — Responder: ${l.data?.Responder||'Pending'}`;}
      else if(l.type==='ban'){icon='🔨';details=`<b>${l.data?.UserName||'?'}</b> banned`;}
      return `<tr><td><span class="badge ${l.type==='kill'?'br':l.type==='join'?'bg':l.type==='leave'?'by':l.type==='command'?'bb':l.type==='modcall'?'by':'br'}">${icon} ${l.type}</span></td><td class="wrap">${details}</td><td style="white-space:nowrap">${new Date(l.timestamp).toLocaleString()}</td></tr>`;
    }).join('')}
  </tbody></table></div>` : '<div class="empty">No logs found</div>'}
</div>`;

  res.send(layout(req.user, 'erlclogs', content));
});

// ── Activity ──────────────────────────────────────────────
app.get('/activity', isAuth, async (req, res) => {
  const actLogs = await Activity.find({ guildId: GUILD_ID }).sort({ timestamp: -1 }).limit(100);
  const shiftData = await Shift.aggregate([
    { $match: { guildId: GUILD_ID, endTime: { $ne: null } } },
    { $group: { _id: '$userId', username: { $last: '$username' }, total: { $sum: '$duration' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } }
  ]);

  const content = `
<div class="g2">
  <div class="panel">
    <div class="panel-header"><div class="panel-title">📊 Staff Activity Overview</div></div>
    ${shiftData.length ? `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Total Time</th><th>Shifts</th></tr></thead><tbody>
      ${shiftData.map(s=>`<tr><td><b>${s.username}</b></td><td><span class="badge ba">${fmt(s.total)}</span></td><td>${s.count}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No activity data</div>'}
  </div>
  <div class="panel">
    <div class="panel-header"><div class="panel-title">📋 Recent Activity</div></div>
    <div class="loglist">
      ${actLogs.slice(0,50).map(a=>{
        const icons={'shift.start':'🟢','shift.end':'🔴','punishment.create':'🔨','loa.request':'🏖️','warning.issue':'⚠️','bolo.create':'👁️'};
        return `<div class="logitem"><div class="logitem-icon">${icons[a.action]||'📋'}</div><div class="logitem-body"><div class="logitem-title">${a.username}</div><div class="logitem-meta">${a.action}</div></div><div class="logitem-time">${timeAgo(a.timestamp)}</div></div>`;
      }).join('')||'<div class="empty">No activity yet</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'activity', content));
});

// ── Audit Logs ────────────────────────────────────────────
app.get('/logs', isAuth, async (req, res) => {
  const actLogs = await Activity.find({ guildId: GUILD_ID }).sort({ timestamp: -1 }).limit(100);
  const punLogs = await Punishment.find({ guildId: GUILD_ID }).sort({ createdAt: -1 }).limit(50);

  const content = `
<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📋 Dashboard Activity</div></div>
      <div class="loglist">
        ${actLogs.map(a=>`<div class="logitem"><div class="logitem-icon">📋</div><div class="logitem-body"><div class="logitem-title">${a.username}</div><div class="logitem-meta">${a.action}${a.details?.type?` · ${a.details.type}`:''}</div></div><div class="logitem-time">${timeAgo(a.timestamp)}</div></div>`).join('')||'<div class="empty">No activity</div>'}
      </div>
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔨 Punishment Logs</div></div>
      <div class="loglist">
        ${punLogs.map(p=>`<div class="logitem"><div class="logitem-icon">${p.type==='ban'?'🔨':p.type==='kick'?'👢':'⚠️'}</div><div class="logitem-body"><div class="logitem-title">${p.type.toUpperCase()} — ${p.targetUsername}</div><div class="logitem-meta">${p.reason||'No reason'} · by ${p.moderatorTag}</div></div><div class="logitem-time">${timeAgo(p.createdAt)}</div></div>`).join('')||'<div class="empty">No punishments</div>'}
      </div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'logs', content));
});

// ── Dashboard Roles ───────────────────────────────────────
app.get('/roles', isAuth, async (req, res) => {
  const [dashRoles, guildRoles] = await Promise.all([
    DashRole.find({ guildId: GUILD_ID }),
    getGuildRoles(),
  ]);

  const roleOptions = guildRoles.map(r =>
    '<option value="'+r.id+'" data-color="'+r.color+'">'+r.name+'</option>'
  ).join('');

  const permGrid = ALL_PERMS.map(p =>
    '<div class="perm-check"><input type="checkbox" name="'+p.key+'" id="p_'+p.key+'"><label for="p_'+p.key+'">'+p.icon+' '+p.label+'</label></div>'
  ).join('');

  const existingRoles = dashRoles.map(r => {
    const gRole = guildRoles.find(g => g.id === r.discordRoleId);
    const color = gRole?.color ? '#'+gRole.color.toString(16).padStart(6,'0') : '#5865F2';
    const permBadges = ALL_PERMS.filter(p => r.permissions?.[p.key] || r.permissions?.administrator)
      .map(p => '<span class="badge bb" style="font-size:9px">'+p.icon+' '+p.label+'</span>').join('');
    return '<div class="panel">'+
      '<div class="panel-header">'+
        '<div class="panel-title">'+
          '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:'+color+';margin-right:6px"></span>'+
          r.roleName+
          ' <code style="font-size:10px">'+r.discordRoleId+'</code>'+
        '</div>'+
        '<form action="/api/roles/delete/'+r._id+'" method="POST" style="display:inline">'+
          '<button type="submit" class="btn btn-danger btn-sm">🗑️ Remove</button>'+
        '</form>'+
      '</div>'+
      '<div class="panel-body">'+
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">'+permBadges+'</div>'+
        '<details><summary style="font-size:11px;color:var(--muted);cursor:pointer">Edit permissions</summary>'+
        '<form action="/api/roles/update/'+r._id+'" method="POST" style="margin-top:12px">'+
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px;margin-bottom:12px">'+
            ALL_PERMS.map(p => '<div class="perm-check"><input type="checkbox" name="'+p.key+'" '+(r.permissions?.[p.key]?'checked':'')+' id="u_'+r._id+'_'+p.key+'"><label for="u_'+r._id+'_'+p.key+'">'+p.icon+' '+p.label+'</label></div>').join('')+
          '</div>'+
          '<button type="submit" class="btn btn-accent btn-sm">💾 Save Changes</button>'+
        '</form></details>'+
      '</div>'+
    '</div>';
  }).join('');

  const content = `
<div class="panel">
  <div class="panel-header"><div class="panel-title">➕ Add Dashboard Role</div></div>
  <div class="panel-body">
    <form action="/api/roles/add" method="POST">
      <div class="g2">
        <div class="fg">
          <label>Discord Role</label>
          <select name="discordRoleId" required id="role-select" onchange="updateRoleName(this)">
            <option value="">— Select a role from your server —</option>
            ${roleOptions}
          </select>
        </div>
        <div class="fg">
          <label>Display Name</label>
          <input name="roleName" id="role-name-input" placeholder="Auto-filled from Discord" required>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px;margin-bottom:16px">
        ${permGrid}
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-ghost btn-sm" onclick="selectAllPerms(true)">✅ Select All</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="selectAllPerms(false)">❌ Clear All</button>
        <button type="submit" class="btn btn-accent" style="margin-left:auto">➕ Add Role</button>
      </div>
    </form>
  </div>
</div>

${existingRoles || '<div class="panel"><div class="empty">No dashboard roles configured yet</div></div>'}

<script>
var roleNames = {${guildRoles.map(r => '"'+r.id+'":"'+r.name.replace(/"/g,'\"')+'"').join(',')}};
function updateRoleName(sel) {
  var nameInput = document.getElementById('role-name-input');
  if (sel.value && roleNames[sel.value]) nameInput.value = roleNames[sel.value];
}
function selectAllPerms(val) {
  document.querySelectorAll('[name^="p_"],[id^="p_"]').forEach(function(cb){ if(cb.type==='checkbox') cb.checked=val; });
  // also target by form checkboxes
  document.querySelectorAll('form input[type=checkbox]').forEach(function(cb){ cb.checked=val; });
}
</script>`;

  res.send(layout(req.user, 'roles', content, flash(req)));
});

app.post('/api/roles/add', isAuth, async (req, res) => {
  const { discordRoleId, roleName, ...perms } = req.body;
  const permissions = {};
  ALL_PERMS.forEach(p => { permissions[p.key] = !!perms[p.key]; });
  await DashRole.create({ guildId: GUILD_ID, discordRoleId, roleName, permissions });
  res.redirect('/roles?success=Role+added');
});

app.post('/api/roles/update/:id', isAuth, async (req, res) => {
  const permissions = {};
  ALL_PERMS.forEach(p => { permissions[p.key] = !!req.body[p.key]; });
  await DashRole.findByIdAndUpdate(req.params.id, { permissions });
  res.redirect('/roles?success=Permissions+updated');
});

app.post('/api/roles/delete/:id', isAuth, async (req, res) => {
  await DashRole.findByIdAndDelete(req.params.id);
  res.redirect('/roles?success=Role+removed');
});
// ── Settings ──────────────────────────────────────────────
app.get('/settings', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const ec = cfg?.erlcLogs ?? {};
  const [guildRoles, guildChannels] = await Promise.all([getGuildRoles(), getGuildChannels()]);

  const channelOpts = '<option value="">— Select channel —</option>' + guildChannels.map(c=>'<option value="'+c.id+'">#'+c.name+'</option>').join('');

  const content = `
<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔑 ER:LC Server Key</div></div>
      <div class="panel-body">
        <form action="/api/erlc/key" method="POST">
          <div class="fg"><label>Server Key</label><input type="password" name="key" placeholder="Paste ERLC server key..." required></div>
          <div style="margin-bottom:12px;font-size:12px;color:var(--muted)">Status: ${ec.serverKey?'<span style="color:var(--success)">✅ Key configured</span>':'<span style="color:var(--danger)">❌ Not configured</span>'}</div>
          <button type="submit" class="btn btn-accent">💾 Save Key</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🖼️ Server Branding</div></div>
      <div class="panel-body">
        <form action="/api/settings/branding" method="POST">
          <div class="fg"><label>Server Logo URL</label><input name="logoUrl" value="${process.env.SERVER_LOGO_URL||''}" placeholder="https://..."></div>
          <div class="fg"><label>Server Name (short)</label><input name="serverName" value="${process.env.SERVER_NAME||'NYLRP'}" placeholder="NYLRP"></div>
          <div class="fg"><label>Server Full Name</label><input name="serverFullName" value="${process.env.SERVER_FULL_NAME||'New York Liberty Roleplay'}" placeholder="New York Liberty Roleplay"></div>
          <button type="submit" class="btn btn-accent">💾 Save Branding</button>
        </form>
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">Update these in Render environment variables for permanent changes.</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔗 Custom Join Link</div></div>
      <div class="panel-body">
        <form action="/api/settings/joinlink" method="POST">
          <div class="fg"><label>Join Link URL</label><input name="joinLink" placeholder="https://www.roblox.com/games/..." value="${cfg?.session?.joinLink||''}"></div>
          <button type="submit" class="btn btn-accent">💾 Save</button>
        </form>
      </div>
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📡 ER:LC Log Channels</div></div>
      <div class="panel-body">
        <form action="/api/settings/erlcchannels" method="POST">
          <div class="fg"><label>🔨 Kick/Ban Logs</label>
            <select name="kickBans">${channelOpts.replace('value="'+ec.kickBans+'"','value="'+ec.kickBans+'" selected')}</select>
          </div>
          <div class="fg"><label>📥 Join/Leave Logs</label>
            <select name="joinLeave">${channelOpts.replace('value="'+ec.joinLeave+'"','value="'+ec.joinLeave+'" selected')}</select>
          </div>
          <div class="fg"><label>⌨️ Command Logs</label>
            <select name="cmds">${channelOpts.replace('value="'+ec.cmds+'"','value="'+ec.cmds+'" selected')}</select>
          </div>
          <div class="fg"><label>🚨 Mod Call Logs</label>
            <select name="modCall">${channelOpts.replace('value="'+ec.modCall+'"','value="'+ec.modCall+'" selected')}</select>
          </div>
          <div class="fg"><label>💀 Kill Logs</label>
            <select name="kills">${channelOpts.replace('value="'+ec.kills+'"','value="'+ec.kills+'" selected')}</select>
          </div>
          <div class="fg"><label>⚠️ Punishment Logs</label>
            <select name="punishments">${channelOpts.replace('value="'+ec.punishments+'"','value="'+ec.punishments+'" selected')}</select>
          </div>
          <button type="submit" class="btn btn-accent btn-block">💾 Save Channels</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚙️ System Info</div></div>
      <div class="table-wrap"><table><tbody>
        <tr><td>Dashboard Version</td><td><span class="badge bg">v3.0</span></td></tr>
        <tr><td>Discord Roles Loaded</td><td><span class="badge bg">${guildRoles.length} roles</span></td></tr>
        <tr><td>Discord Channels Loaded</td><td><span class="badge bg">${guildChannels.length} channels</span></td></tr>
        <tr><td>Database</td><td><span class="badge bg">MongoDB Atlas</span></td></tr>
        <tr><td>Logs Retention</td><td><span class="badge bg">Forever ♾️</span></td></tr>
        <tr><td>Auto-DM on Warn</td><td><span class="badge bg">✅ Enabled</span></td></tr>
      </tbody></table></div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'settings', content, flash(req)));
});
// ── API: ERLC Command ─────────────────────────────────────
app.post('/api/erlc/command', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try {
    await erlc('/server/command', 'POST', { command: req.body.command }, key);
    await logActivity(req.user.id, req.user.username, 'erlc.command', { command: req.body.command });
    const ref = req.headers.referer || '/panel';
    res.redirect(ref.includes('?') ? ref+'&success=Command+sent' : ref+'?success=Command+sent');
  } catch (e) {
    const ref = req.headers.referer || '/panel';
    res.redirect(ref.includes('?') ? ref+'&error='+encodeURIComponent(e.message) : ref+'?error='+encodeURIComponent(e.message));
  }
});

// ── API: ERLC PM ──────────────────────────────────────────
app.post('/api/erlc/pm', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try {
    await erlc('/server/command', 'POST', { command: `:pm ${req.body.player} ${req.body.message}` }, key);
    await logActivity(req.user.id, req.user.username, 'erlc.pm', { player: req.body.player });
    const ref = req.headers.referer || '/moderator';
    res.redirect(ref+'?success=PM+sent');
  } catch (e) {
    const ref = req.headers.referer || '/moderator';
    res.redirect(ref+'?error='+encodeURIComponent(e.message));
  }
});

// ── API: ERLC Key ─────────────────────────────────────────
app.post('/api/erlc/key', isAuth, async (req, res) => {
  try {
    await mongoose.connection.db.collection('guildconfigs').updateOne(
      { guildId: GUILD_ID }, { $set: { 'data.erlcLogs.serverKey': req.body.key } }, { upsert: true }
    );
    res.redirect('/settings?success=Key+saved');
  } catch (e) { res.redirect('/settings?error=' + encodeURIComponent(e.message)); }
});

app.post('/api/settings/branding', isAuth, async (req, res) => {
  res.redirect('/settings?success=Update+SERVER_LOGO_URL+SERVER_NAME+and+SERVER_FULL_NAME+in+Render+env+vars');
});

app.post('/api/settings/erlcchannels', isAuth, async (req, res) => {
  const { kickBans, joinLeave, cmds, modCall, kills, punishments } = req.body;
  await mongoose.connection.db.collection('guildconfigs').updateOne(
    { guildId: GUILD_ID },
    { $set: {
      'data.erlcLogs.kickBans': kickBans||null,
      'data.erlcLogs.joinLeave': joinLeave||null,
      'data.erlcLogs.cmds': cmds||null,
      'data.erlcLogs.modCall': modCall||null,
      'data.erlcLogs.kills': kills||null,
      'data.erlcLogs.punishments': punishments||null,
    }},
    { upsert: true }
  );
  res.redirect('/settings?success=Log+channels+saved');
});

// ── Delete endpoints ──────────────────────────────────────
app.post('/api/punishment/delete/:id', isAuth, async (req, res) => {
  await Punishment.findByIdAndDelete(req.params.id);
  await logActivity(req.user.id, req.user.username, 'punishment.delete', { id: req.params.id });
  res.redirect((req.headers.referer||'/punishments')+'?success=Punishment+deleted');
});

app.post('/api/warnings/delete/:id', isAuth, async (req, res) => {
  await Warning.findByIdAndDelete(req.params.id);
  res.redirect((req.headers.referer||'/warnings')+'?success=Warning+deleted');
});

app.post('/api/erlclog/delete/:id', isAuth, async (req, res) => {
  await ErlcLog.findByIdAndDelete(req.params.id);
  res.redirect((req.headers.referer||'/erlclogs')+'?success=Log+deleted');
});

app.post('/api/activity/delete/:id', isAuth, async (req, res) => {
  await Activity.findByIdAndDelete(req.params.id);
  res.redirect((req.headers.referer||'/logs')+'?success=Log+deleted');
});

app.post('/api/shift/delete/:id', isAuth, async (req, res) => {
  await Shift.findByIdAndDelete(req.params.id);
  res.redirect((req.headers.referer||'/shift')+'?success=Shift+deleted');
});

// ── API: ERLC log ingestion (called by bot) ───────────────
app.post('/api/erlclog', async (req, res) => {
  const { secret, guildId, type, data } = req.body;
  if (secret !== process.env.SESSION_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  await ErlcLog.create({ guildId, type, data, timestamp: Date.now() });
  // Also save chat logs to DB
  if (type === 'chat') {
    await ChatLog.create({ guildId, player: data?.Player||data?.Username||'?', team: data?.Team||'', message: data?.Message||data?.Content||'', timestamp: Date.now() });
  }
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Dashboard v3.0 on port ${PORT} — ${DASHBOARD_URL}`));