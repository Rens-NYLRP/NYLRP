require('dotenv').config();
const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const mongoose        = require('mongoose');

const { GuildConfig, Shift, Punishment, ErlcLog, Leave, Activity, DashRole } = require('./dashboard-models');
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
  if (!res.ok) throw new Error(`ERLC API error ${res.status}: ${res.statusText}`);
  return res.json();
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
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f0f;color:#e8e8e8;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background-image:radial-gradient(ellipse at 50% 0%,rgba(0,229,160,.08) 0%,transparent 60%)}
.card{background:#171717;border:1px solid #2a2a2a;border-radius:20px;padding:48px 40px;text-align:center;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo-wrap{width:72px;height:72px;border-radius:16px;margin:0 auto 20px;overflow:hidden;background:#00e5a0;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#000}
.logo-wrap img{width:100%;height:100%;object-fit:cover}
h1{font-size:22px;font-weight:700;color:#00e5a0;margin-bottom:6px}
p{color:#666;font-size:13px;margin-bottom:32px}
.btn{display:inline-flex;align-items:center;gap:10px;background:#5865F2;color:#fff;padding:13px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;transition:all .2s}
.btn:hover{background:#4752C4;transform:translateY(-2px);box-shadow:0 8px 20px rgba(88,101,242,.4)}</style></head>
<body><div class="card">
<div class="logo-wrap">${LOGO?`<img src="${LOGO}" onerror="this.style.display='none';this.parentNode.textContent='N'">`:'N'}</div>
<h1>${NAME} Dashboard</h1>
<p>Staff Management & ER:LC Panel<br>Login with your Discord account to continue.</p>
<a class="btn" href="/auth/discord">
<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
Login with Discord</a></div></body></html>`);
});
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/panel'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));
app.get('/', isAuth, (req, res) => res.redirect('/panel'));

// ── Panel ─────────────────────────────────────────────────
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
  const now = Date.now();

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-icon">👥</div><div class="stat-label">In-Game</div><div class="stat-value">${pl.length}</div><div class="stat-sub">${serverInfo?.Name ?? 'Server'}</div></div>
  <div class="stat"><div class="stat-icon">👮</div><div class="stat-label">Staff On Duty</div><div class="stat-value">${allActiveShifts.length}</div><div class="stat-sub">Active shifts</div></div>
  <div class="stat"><div class="stat-icon">🚨</div><div class="stat-label">Mod Calls</div><div class="stat-value">${modcalls.length}</div><div class="stat-sub">${modcalls.filter(m=>!m.Responder).length} pending</div></div>
  <div class="stat"><div class="stat-icon">💀</div><div class="stat-label">Kill Logs</div><div class="stat-value">${kills.length}</div></div>
  <div class="stat${activeShift?' stat-active':''}"><div class="stat-icon">${activeShift?'🟢':'⚫'}</div><div class="stat-label">My Shift</div><div class="stat-value" style="font-size:16px;margin-top:4px">${activeShift?'On Duty':'Off Duty'}</div>${activeShift?`<div class="stat-sub">${fmt(now-activeShift.startTime)}</div>`:''}</div>
</div>

<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">👥 Players In-Game <span class="badge bg">${pl.length}</span></div><a href="/ingame" class="btn btn-ghost btn-sm">Full View →</a></div>
      ${pl.length ? `<div class="player-grid">${pl.slice(0,12).map(p=>`<div class="player-card"><div class="player-icon">👤</div><div><div class="player-name">${p.Player}</div><div class="player-team">${p.Team||'No Team'}</div></div></div>`).join('')}${pl.length>12?`<div style="padding:10px 14px;color:var(--muted);font-size:12px">+${pl.length-12} more players</div>`:''}</div>` : '<div class="empty"><div class="empty-icon">🎮</div>No players in game</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">👮 Staff On Duty <span class="badge bg">${allActiveShifts.length}</span></div><a href="/shift" class="btn btn-ghost btn-sm">Manage →</a></div>
      ${allActiveShifts.length ? allActiveShifts.map(s=>`<div class="shift-row"><img class="shift-av" src="https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div style="flex:1"><div class="shift-name">${s.username}</div><div class="shift-time">Since ${new Date(s.startTime).toLocaleTimeString()}</div></div><span class="badge bg">${fmt(now-s.startTime)}</span></div>`).join('') : '<div class="empty">No staff on duty</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🎮 Run Command</div></div>
      <div class="panel-body">
        <form action="/api/erlc/command" method="POST" class="form-row">
          <div class="fg"><label>Command (e.g. :kick PlayerName Reason)</label><input name="command" placeholder=":kick PlayerName Reason" required></div>
          <button type="submit" class="btn btn-accent">▶ Run</button>
        </form>
      </div>
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🚨 Mod Calls</div></div>
      ${modcalls.length ? `<div class="table-wrap"><table><thead><tr><th>Caller</th><th>Responder</th><th>Status</th></tr></thead><tbody>${modcalls.map(m=>`<tr><td><b>${m.Caller}</b></td><td>${m.Responder||'—'}</td><td>${m.Responder?'<span class="badge bg">✓ Responded</span>':'<span class="badge by">⏳ Pending</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No mod calls</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">💀 Kill Logs</div><a href="/erlclogs" class="btn btn-ghost btn-sm">All Logs →</a></div>
      ${kills.length ? `<div class="table-wrap"><table><thead><tr><th>Killer</th><th>Killed</th><th>Weapon</th></tr></thead><tbody>${kills.map(k=>`<tr><td><b>${k.Killer}</b></td><td>${k.Killed}</td><td><code>${k.Weapon||'?'}</code></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No kill logs</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">⌨️ Recent Commands</div></div>
      ${cmds.length ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Command</th></tr></thead><tbody>${cmds.map(c=>`<tr><td><b>${c.Player}</b></td><td><code>${(c.Command||'?').slice(0,40)}</code></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No commands</div>'}
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔨 Recent Punishments</div><a href="/punishments" class="btn btn-ghost btn-sm">All →</a></div>
      ${recentPunishments.length ? recentPunishments.map(p=>`<div class="puncard"><div class="puncard-header"><span class="puncard-user">${p.targetUsername}</span><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':p.type==='note'?'bb':'by'}">${p.type}</span></div><div class="puncard-meta"><b>Reason:</b> ${p.reason||'—'} · <b>By:</b> ${p.moderatorTag||'?'} · ${timeAgo(p.createdAt)}</div></div>`).join('') : '<div class="empty">No punishments</div>'}
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'panel', content, flash(req)));
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
    { $sort: { total: -1 } },
    { $limit: 10 },
  ]);
  const totalTime = recent.reduce((a, s) => a + (s.duration || 0), 0);
  const now = Date.now();

  const content = `
<div class="stats">
  <div class="stat${active?' stat-active':''}"><div class="stat-label">Status</div><div class="stat-value" style="font-size:16px;margin-top:4px">${active?'🟢 On Duty':'⚫ Off'}</div>${active?`<div class="stat-sub">Since ${new Date(active.startTime).toLocaleTimeString()}</div>`:''}</div>
  <div class="stat"><div class="stat-label">Current Duration</div><div class="stat-value" style="font-size:20px" id="shift-timer" data-start="${active?.startTime||0}">${active?fmt(now-active.startTime):'—'}</div></div>
  <div class="stat"><div class="stat-label">Total Time (all shifts)</div><div class="stat-value" style="font-size:20px">${fmt(totalTime)}</div></div>
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
          <div style="font-size:12px;color:var(--muted)">Shift started at</div>
          <div style="font-size:28px;font-weight:700;color:var(--accent);margin:4px 0">${new Date(active.startTime).toLocaleTimeString()}</div>
          <div style="font-size:13px;color:var(--muted)" id="shift-timer" data-start="${active.startTime}">${fmt(now-active.startTime)}</div>
        </div>
        <form action="/api/shift/end" method="POST"><button type="submit" class="btn btn-danger btn-block">⏹ End Shift</button></form>` :
        `<div style="text-align:center;padding:20px 0;color:var(--muted);font-size:13px;margin-bottom:16px">You are currently off duty</div>
        <form action="/api/shift/start" method="POST"><button type="submit" class="btn btn-accent btn-block">▶ Start Shift</button></form>`}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">👥 All Active Shifts</div></div>
      ${allActive.length ? allActive.map(s=>`<div class="shift-row"><img class="shift-av" src="https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div style="flex:1"><div class="shift-name">${s.username}</div><div class="shift-time">Started ${new Date(s.startTime).toLocaleTimeString()}</div></div><span class="badge bg">${fmt(now-s.startTime)}</span></div>`).join('') : '<div class="empty">No staff on duty</div>'}
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
      <div class="panel-header"><div class="panel-title">⏳ Pending Approvals <span class="badge by">${pending.length}</span></div></div>
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
      ${punishments.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Player</th><th>Roblox ID</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>
        ${punishments.map(p=>`<tr>
          <td><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':p.type==='tempban'?'bp':p.type==='bolo'?'br':p.type==='note'?'bb':'by'}">${p.type}</span></td>
          <td><b>${p.targetUsername}</b></td>
          <td>${p.targetRobloxId?`<code>${p.targetRobloxId}</code>`:'—'}</td>
          <td class="wrap" style="max-width:200px">${p.reason||'—'}</td>
          <td>${p.moderatorTag||'—'}</td>
          <td>${new Date(p.createdAt).toLocaleDateString()}</td>
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
  const { targetUsername, targetRobloxId, type, reason, duration } = req.body;
  await Punishment.create({ guildId: GUILD_ID, moderatorId: req.user.id, moderatorTag: req.user.username, targetUsername, targetRobloxId: targetRobloxId||null, type, reason, duration: duration||null, createdAt: Date.now() });
  await logActivity(req.user.id, req.user.username, 'punishment.create', { type, target: targetUsername });
  res.redirect('/punishments?success=Punishment+logged');
});

// ── Search ────────────────────────────────────────────────
app.get('/search', isAuth, async (req, res) => {
  const q = req.query.q || '';
  let results = [], robloxUser = null;
  if (q) {
    results = await Punishment.find({ guildId: GUILD_ID, $or: [{ targetUsername: { $regex: q, $options: 'i' } }, { targetRobloxId: q }] }).sort({ createdAt: -1 });
    try { const r = await fetch(`https://users.roblox.com/v1/usernames/users`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ usernames: [q], excludeBannedUsers: false }) }); const d = await r.json(); robloxUser = d.data?.[0] ?? null; } catch {}
  }

  const content = `
<div class="panel">
  <div class="panel-header"><div class="panel-title">🔍 Search Player</div></div>
  <div class="panel-body">
    <form method="GET" class="form-row">
      <div class="fg"><label>Roblox Username or ID</label><input name="q" value="${q}" placeholder="Enter username or Roblox ID..." required></div>
      <button type="submit" class="btn btn-accent">🔍 Search</button>
    </form>
  </div>
</div>

${q ? `
${robloxUser ? `
<div class="panel">
  <div class="panel-header"><div class="panel-title">👤 Roblox Profile</div></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:16px">
    <img src="https://www.roblox.com/headshot-thumbnail/image?userId=${robloxUser.id}&width=100&height=100&format=png" style="width:64px;height:64px;border-radius:10px;background:var(--surface2)">
    <div>
      <div style="font-size:18px;font-weight:700">${robloxUser.name}</div>
      <div style="color:var(--muted);font-size:13px">ID: ${robloxUser.id}</div>
      <a href="https://www.roblox.com/users/${robloxUser.id}/profile" target="_blank" class="btn btn-ghost btn-sm" style="margin-top:8px">View Profile →</a>
    </div>
    <div style="margin-left:auto;text-align:center"><div style="font-size:24px;font-weight:700;color:${results.length?'var(--danger)':'var(--success)'}">${results.length}</div><div style="font-size:12px;color:var(--muted)">Punishment${results.length!==1?'s':''}</div></div>
  </div>
</div>` : ''}

<div class="panel">
  <div class="panel-header"><div class="panel-title">📋 Punishment History for "${q}" <span class="badge ${results.length?'br':'bg'}">${results.length}</span></div></div>
  ${results.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>
    ${results.map(p=>`<tr><td><span class="badge ${p.type==='ban'?'br':p.type==='kick'?'by':p.type==='note'?'bb':'by'}">${p.type}</span></td><td class="wrap">${p.reason||'—'}</td><td>${p.moderatorTag||'—'}</td><td>${new Date(p.createdAt).toLocaleDateString()}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">No punishments found for this player ✅</div>'}
</div>` : ''}`;

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
  <div class="stat"><div class="stat-label">Total Logs</div><div class="stat-value">${total}</div><div class="stat-sub">Never deleted</div></div>
  <div class="stat"><div class="stat-label">Kill Logs</div><div class="stat-value">${await typeCount('kill')}</div></div>
  <div class="stat"><div class="stat-label">Join/Leave</div><div class="stat-value">${await typeCount('join') + await typeCount('leave')}</div></div>
  <div class="stat"><div class="stat-label">Commands</div><div class="stat-value">${await typeCount('command')}</div></div>
  <div class="stat"><div class="stat-label">Mod Calls</div><div class="stat-value">${await typeCount('modcall')}</div></div>
</div>

<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
  ${['all','kill','join','leave','command','modcall','ban'].map(t=>`<a href="/erlclogs?type=${t}" class="btn ${type===t?'btn-accent':'btn-ghost'} btn-sm">${t.charAt(0).toUpperCase()+t.slice(1)}</a>`).join('')}
</div>

<div class="panel">
  <div class="panel-header"><div class="panel-title">📡 ER:LC Logs <span class="badge ba">${logs.length}</span></div></div>
  ${logs.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Details</th><th>Time</th></tr></thead><tbody>
    ${logs.map(l=>{
      let icon = '📋', details = '';
      if(l.type==='kill'){icon='💀';details=`<b>${l.data?.Killer}</b> killed <b>${l.data?.Killed}</b> with ${l.data?.Weapon||'?'}`;}
      else if(l.type==='join'){icon='📥';details=`<b>${l.data?.Player}</b> joined (${l.data?.Team||'No Team'})`;}
      else if(l.type==='leave'){icon='📤';details=`<b>${l.data?.Player||l.data}</b> left`;}
      else if(l.type==='command'){icon='⌨️';details=`<b>${l.data?.Player}</b>: <code>${(l.data?.Command||'?').slice(0,50)}</code>`;}
      else if(l.type==='modcall'){icon='🚨';details=`Caller: <b>${l.data?.Caller}</b> — Responder: ${l.data?.Responder||'Pending'}`;}
      else if(l.type==='ban'){icon='🔨';details=`<b>${l.data?.UserName||'?'}</b> banned by ${l.data?.moderatorName||'?'}`;}
      return `<tr><td><span class="badge ${l.type==='kill'?'br':l.type==='join'?'bg':l.type==='leave'?'by':l.type==='command'?'bb':l.type==='modcall'?'by':'br'}">${icon} ${l.type}</span></td><td class="wrap">${details}</td><td style="white-space:nowrap">${new Date(l.timestamp).toLocaleString()}</td></tr>`;
    }).join('')}
  </tbody></table></div>` : '<div class="empty">No logs found</div>'}
</div>`;

  res.send(layout(req.user, 'erlclogs', content));
});

// ── Sessions ──────────────────────────────────────────────
app.get('/sessions', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const sc = cfg?.session ?? {};

  const content = `
<div class="stats">
  <div class="stat"><div class="stat-label">Vote Threshold</div><div class="stat-value">${sc.voteThreshold??6}</div></div>
  <div class="stat"><div class="stat-label">Channel</div><div class="stat-value" style="font-size:14px;margin-top:4px">${sc.channel?'✅ Set':'❌ Not set'}</div></div>
  <div class="stat"><div class="stat-label">Join Link</div><div class="stat-value" style="font-size:14px;margin-top:4px">${sc.joinLink?'✅ Set':'❌ Not set'}</div></div>
</div>
<div class="panel">
  <div class="panel-header"><div class="panel-title">📈 Session Configuration</div></div>
  <div class="panel-body" style="color:var(--muted);font-size:13px;line-height:1.8">
    Manage sessions via Discord: <code>/session start</code> <code>/session vote</code> <code>/session shutdown</code><br><br>
    <b style="color:var(--text)">Start Description:</b><br>${sc.startDescription?.slice(0,300)??'Not configured'}
  </div>
</div>`;

  res.send(layout(req.user, 'sessions', content));
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
        const icons = {'shift.start':'🟢','shift.end':'🔴','punishment.create':'🔨','loa.request':'🏖️'};
        return `<div class="logitem"><div class="logitem-icon" style="background:var(--surface2)">${icons[a.action]||'📋'}</div><div class="logitem-body"><div class="logitem-title">${a.username}</div><div class="logitem-meta">${a.action}</div></div><div class="logitem-time">${timeAgo(a.timestamp)}</div></div>`;
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
  const cfg = await getConfig();
  const warn = cfg?.warnings ?? {}, note = cfg?.notes ?? {};
  const discordLogs = [];
  for (const [uid, ws] of Object.entries(warn)) for (const w of ws) discordLogs.push({ type: 'warn', uid, data: w, ts: w.timestamp||0 });
  for (const [uid, ns] of Object.entries(note)) for (const n of ns) discordLogs.push({ type: 'note', uid, data: n, ts: n.timestamp||0 });
  discordLogs.sort((a,b) => b.ts - a.ts);

  const content = `
<div class="g2">
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📋 Dashboard Activity</div></div>
      <div class="loglist">
        ${actLogs.map(a=>`<div class="logitem"><div class="logitem-icon" style="background:var(--surface2)">📋</div><div class="logitem-body"><div class="logitem-title">${a.username}</div><div class="logitem-meta">${a.action}${a.details?.type?` · ${a.details.type}`:''}</div></div><div class="logitem-time">${timeAgo(a.timestamp)}</div></div>`).join('')||'<div class="empty">No activity</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">🔨 Punishment Logs</div></div>
      <div class="loglist">
        ${punLogs.map(p=>`<div class="logitem"><div class="logitem-icon" style="background:var(--surface2)">${p.type==='ban'?'🔨':p.type==='kick'?'👢':'⚠️'}</div><div class="logitem-body"><div class="logitem-title">${p.type.toUpperCase()} — ${p.targetUsername}</div><div class="logitem-meta">${p.reason||'No reason'} · by ${p.moderatorTag}</div></div><div class="logitem-time">${timeAgo(p.createdAt)}</div></div>`).join('')||'<div class="empty">No punishments</div>'}
      </div>
    </div>
  </div>
  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚖️ Discord Bot Infractions</div></div>
      <div class="loglist">
        ${discordLogs.slice(0,50).map(l=>`<div class="logitem"><div class="logitem-icon" style="background:var(--surface2)">${l.type==='warn'?'⚠️':'📝'}</div><div class="logitem-body"><div class="logitem-title">${l.type==='warn'?'Warning':'Note'} — <code>${l.uid}</code></div><div class="logitem-meta">${l.data.reason||l.data.note||'No reason'}${l.data.by?` · ${l.data.by}`:''}</div></div><div class="logitem-time">${l.ts?timeAgo(l.ts):'—'}</div></div>`).join('')||'<div class="empty">No discord infractions</div>'}
      </div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'logs', content));
});

// ── Dashboard Roles ───────────────────────────────────────
app.get('/roles', isAuth, async (req, res) => {
  const dashRoles = await DashRole.find({ guildId: GUILD_ID });
  const cfg = await getConfig();
  const discordRoles = cfg?.roleList ?? [];

  const PERMS = [
    { key: 'viewPanel',          label: 'View Panel & In-Game' },
    { key: 'viewLogs',           label: 'View Logs' },
    { key: 'viewMembers',        label: 'View Members' },
    { key: 'manageShifts',       label: 'Manage Shifts' },
    { key: 'createPunishments',  label: 'Create Punishments' },
    { key: 'manageLOA',          label: 'Approve/Deny LOA' },
    { key: 'manageSettings',     label: 'Manage Settings' },
    { key: 'viewErlcPanel',      label: 'View ER:LC Panel' },
    { key: 'runCommands',        label: 'Run ER:LC Commands' },
  ];

  const content = `
<div class="panel">
  <div class="panel-header"><div class="panel-title">➕ Add Dashboard Role</div></div>
  <div class="panel-body">
    <form action="/api/roles/add" method="POST">
      <div class="g2">
        <div class="fg"><label>Discord Role ID</label><input name="discordRoleId" placeholder="Role ID from Discord" required></div>
        <div class="fg"><label>Role Name (display only)</label><input name="roleName" placeholder="e.g. Moderator" required></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px;margin-bottom:14px">
        ${PERMS.map(p=>`<div class="perm-check"><input type="checkbox" name="${p.key}" id="p_${p.key}"><label for="p_${p.key}">${p.label}</label></div>`).join('')}
      </div>
      <button type="submit" class="btn btn-accent">➕ Add Role</button>
    </form>
  </div>
</div>

${dashRoles.length ? dashRoles.map(r=>`
<div class="panel">
  <div class="panel-header">
    <div class="panel-title">🔐 ${r.roleName} <code>${r.discordRoleId}</code></div>
    <form action="/api/roles/delete/${r._id}" method="POST"><button type="submit" class="btn btn-danger btn-sm">🗑️ Remove</button></form>
  </div>
  <div class="panel-body">
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px">
      ${PERMS.map(p=>`<div class="perm-check"><input type="checkbox" ${r.permissions?.[p.key]?'checked':''} disabled><label style="${r.permissions?.[p.key]?'color:var(--accent)':''}">${p.label}</label></div>`).join('')}
    </div>
  </div>
</div>`).join('') : '<div class="panel"><div class="empty">No dashboard roles configured yet</div></div>'}`;

  res.send(layout(req.user, 'roles', content, flash(req)));
});
app.post('/api/roles/add', isAuth, async (req, res) => {
  const { discordRoleId, roleName, ...perms } = req.body;
  const permissions = {};
  ['viewPanel','viewLogs','viewMembers','manageShifts','createPunishments','manageLOA','manageSettings','viewErlcPanel','runCommands'].forEach(k => { permissions[k] = !!perms[k]; });
  await DashRole.create({ guildId: GUILD_ID, discordRoleId, roleName, permissions });
  res.redirect('/roles?success=Role+added');
});
app.post('/api/roles/delete/:id', isAuth, async (req, res) => {
  await DashRole.findByIdAndDelete(req.params.id);
  res.redirect('/roles?success=Role+removed');
});

// ── Settings ──────────────────────────────────────────────
app.get('/settings', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const ec = cfg?.erlcLogs ?? {};

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
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">Note: Update these in your Render environment variables for permanent changes.</div>
      </div>
    </div>
  </div>

  <div>
    <div class="panel">
      <div class="panel-header"><div class="panel-title">📡 ER:LC Log Channels</div></div>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>Status</th></tr></thead><tbody>
        <tr><td>🔨 Kick/Ban</td><td>${ec.kickBans?'<span class="badge bg">✅ Set</span>':'<span class="badge br">Not set</span>'}</td></tr>
        <tr><td>📥 Join/Leave</td><td>${ec.joinLeave?'<span class="badge bg">✅ Set</span>':'<span class="badge br">Not set</span>'}</td></tr>
        <tr><td>⌨️ Commands</td><td>${ec.cmds?'<span class="badge bg">✅ Set</span>':'<span class="badge br">Not set</span>'}</td></tr>
        <tr><td>🚨 Mod Calls</td><td>${ec.modCall?'<span class="badge bg">✅ Set</span>':'<span class="badge br">Not set</span>'}</td></tr>
        <tr><td>💀 Kills</td><td>${ec.kills?'<span class="badge bg">✅ Set</span>':'<span class="badge br">Not set</span>'}</td></tr>
      </tbody></table></div>
      <div style="padding:12px 16px;font-size:12px;color:var(--muted)">Configure via <code>/setup erlclogs</code> in Discord</div>
    </div>

    <div class="panel">
      <div class="panel-header"><div class="panel-title">⚙️ System Info</div></div>
      <div class="table-wrap"><table><tbody>
        <tr><td>Dashboard Version</td><td><span class="badge bg">v2.0</span></td></tr>
        <tr><td>Bot Commands</td><td><span class="badge bb">Via /setup in Discord</span></td></tr>
        <tr><td>Database</td><td><span class="badge bg">MongoDB Atlas</span></td></tr>
        <tr><td>Logs Retention</td><td><span class="badge bg">Forever ♾️</span></td></tr>
      </tbody></table></div>
    </div>
  </div>
</div>`;

  res.send(layout(req.user, 'settings', content, flash(req)));
});

// ── API ───────────────────────────────────────────────────
app.post('/api/erlc/command', isAuth, async (req, res) => {
  const cfg = await getConfig();
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try {
    await erlc('/server/command', 'POST', { command: req.body.command }, key);
    await logActivity(req.user.id, req.user.username, 'erlc.command', { command: req.body.command });
    res.redirect('/panel?success=Command+sent');
  } catch (e) { res.redirect('/panel?error=' + encodeURIComponent(e.message)); }
});

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

// ── ERLC log ingestion (called by bot) ────────────────────
app.post('/api/erlclog', async (req, res) => {
  const { secret, guildId, type, data } = req.body;
  if (secret !== process.env.SESSION_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  await ErlcLog.create({ guildId, type, data, timestamp: Date.now() });
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Dashboard on port ${PORT} — ${DASHBOARD_URL}`));
