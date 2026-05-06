require('dotenv').config();
const express        = require('express');
const session        = require('express-session');
const passport       = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const mongoose       = require('mongoose');
const path           = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_URL    = process.env.DASHBOARD_URL || 'http://localhost:3000';
const CLIENT_ID        = process.env.DISCORD_CLIENT_ID || '1478295713254477855';
const CLIENT_SECRET    = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'nylrp-secret';
const ERLC_API_KEY     = process.env.ERLC_API_KEY;
const ERLC_BASE        = 'https://api.policeroleplay.community/v1';
const GUILD_ID         = '1379173469132030062';

// ── Mongoose ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).catch(console.error);

const GuildConfigSchema = new mongoose.Schema({ guildId: String, data: Object });
const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', GuildConfigSchema);

async function getConfig(guildId) {
  const doc = await GuildConfig.findOne({ guildId });
  return doc?.data ?? {};
}

// ── ERLC Helper ───────────────────────────────────────────
async function erlc(endpoint, method = 'GET', body = null, key = null) {
  const apiKey = key || ERLC_API_KEY;
  const opts = { method, headers: { 'Server-Key': apiKey, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${endpoint}`, opts);
  if (!res.ok) throw new Error(`ERLC ${res.status}`);
  return res.json();
}

// ── Express setup ─────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));
app.use(passport.initialize());
app.use(passport.session());

// ── Discord OAuth ─────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID:     CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL:  `${DASHBOARD_URL}/auth/callback`,
  scope:        ['identify', 'guilds'],
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

function isAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

function isStaff(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/login');
  // Allow all authenticated users for now — you can add role checks here
  next();
}

// ── Auth routes ───────────────────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>NYLRP Dashboard — Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d0d0d; color: #fff; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161616; border: 1px solid #222; border-radius: 16px; padding: 48px 40px; text-align: center; width: 100%; max-width: 420px; }
    .logo { font-size: 28px; font-weight: 700; color: #00e5a0; margin-bottom: 8px; }
    .sub { color: #888; font-size: 14px; margin-bottom: 32px; }
    .btn { display: inline-flex; align-items: center; gap: 10px; background: #5865F2; color: #fff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; transition: opacity .2s; }
    .btn:hover { opacity: .85; }
    .btn svg { width: 20px; height: 20px; fill: white; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🗽 NYLRP</div>
    <div class="sub">New York Liberty Roleplay — Staff Dashboard</div>
    <a class="btn" href="/auth/discord">
      <svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
      Login with Discord
    </a>
  </div>
</body>
</html>`);
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/login')); });

// ── Dashboard HTML template ───────────────────────────────
function layout(user, page, content) {
  const nav = [
    { id: 'panel',       icon: '🖥️',  label: 'Panel' },
    { id: 'members',     icon: '👥',  label: 'Members' },
    { id: 'infractions', icon: '⚖️',  label: 'Infractions' },
    { id: 'sessions',    icon: '📈',  label: 'Sessions' },
    { id: 'erlc',        icon: '🎮',  label: 'ER:LC' },
    { id: 'logs',        icon: '📋',  label: 'Audit Logs' },
    { id: 'settings',    icon: '⚙️',  label: 'Settings' },
  ];
  return `<!DOCTYPE html>
<html>
<head>
  <title>NYLRP Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    :root{--bg:#0d0d0d;--surface:#161616;--border:#222;--accent:#00e5a0;--text:#e8e8e8;--muted:#666;--danger:#ff4757;--warn:#ffa502;--success:#2ed573;}
    body{background:var(--bg);color:var(--text);font-family:'Segoe UI',sans-serif;display:flex;min-height:100vh;}
    /* Sidebar */
    .sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:0;flex-shrink:0;}
    .sidebar-header{padding:20px;border-bottom:1px solid var(--border);}
    .sidebar-header .logo{font-size:18px;font-weight:700;color:var(--accent);}
    .sidebar-header .server{font-size:12px;color:var(--muted);margin-top:2px;}
    .nav{flex:1;padding:12px 0;}
    .nav-item{display:flex;align-items:center;gap:12px;padding:10px 20px;cursor:pointer;border-radius:0;transition:background .15s;text-decoration:none;color:var(--text);font-size:14px;border-left:3px solid transparent;}
    .nav-item:hover{background:rgba(255,255,255,.05);}
    .nav-item.active{background:rgba(0,229,160,.08);border-left-color:var(--accent);color:var(--accent);}
    .sidebar-footer{padding:16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;}
    .avatar{width:32px;height:32px;border-radius:50%;background:var(--border);}
    .user-info{flex:1;min-width:0;}
    .user-info .name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .user-info .tag{font-size:11px;color:var(--muted);}
    .logout{color:var(--muted);font-size:12px;text-decoration:none;margin-left:auto;}
    .logout:hover{color:var(--danger);}
    /* Main */
    .main{flex:1;display:flex;flex-direction:column;overflow:hidden;}
    .topbar{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface);}
    .topbar h1{font-size:18px;font-weight:600;}
    .content{flex:1;padding:24px;overflow-y:auto;}
    /* Cards */
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:24px;}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;}
    .card-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
    .card-value{font-size:28px;font-weight:700;color:var(--accent);}
    .card-sub{font-size:12px;color:var(--muted);margin-top:4px;}
    /* Table */
    .table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:24px;}
    .table-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
    .table-header h2{font-size:15px;font-weight:600;}
    table{width:100%;border-collapse:collapse;}
    th{padding:12px 16px;text-align:left;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);}
    td{padding:12px 16px;font-size:14px;border-bottom:1px solid rgba(255,255,255,.04);}
    tr:last-child td{border-bottom:none;}
    tr:hover td{background:rgba(255,255,255,.02);}
    /* Badges */
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;}
    .badge-green{background:rgba(46,213,115,.15);color:var(--success);}
    .badge-red{background:rgba(255,71,87,.15);color:var(--danger);}
    .badge-yellow{background:rgba(255,165,2,.15);color:var(--warn);}
    .badge-blue{background:rgba(88,101,242,.15);color:#5865F2;}
    /* Buttons */
    .btn{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:opacity .2s;}
    .btn:hover{opacity:.85;}
    .btn-primary{background:var(--accent);color:#000;}
    .btn-danger{background:var(--danger);color:#fff;}
    .btn-secondary{background:rgba(255,255,255,.08);color:var(--text);}
    /* Section */
    .section{margin-bottom:24px;}
    .section-title{font-size:16px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;}
    /* Live dot */
    .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--success);}
    .live-dot{width:8px;height:8px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
    /* Log item */
    .log-item{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.04);}
    .log-item:last-child{border-bottom:none;}
    .log-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
    .log-info{flex:1;}
    .log-title{font-size:13px;font-weight:600;}
    .log-meta{font-size:12px;color:var(--muted);margin-top:2px;}
    .log-time{font-size:11px;color:var(--muted);white-space:nowrap;}
    /* Form */
    .form-group{margin-bottom:16px;}
    .form-group label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px;}
    .form-group input,.form-group select,.form-group textarea{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;}
    .form-group input:focus,.form-group select:focus{border-color:var(--accent);}
    /* Player card */
    .player-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;}
    .player-card{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;align-items:center;gap:10px;}
    .player-card .p-name{font-size:13px;font-weight:600;}
    .player-card .p-team{font-size:11px;color:var(--muted);}
    /* Scrollbar */
    ::-webkit-scrollbar{width:6px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
    /* Responsive */
    @media(max-width:768px){.sidebar{display:none;}.content{padding:16px;}}
    .refresh-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;}
    .refresh-btn:hover{border-color:var(--accent);color:var(--accent);}
    .empty{text-align:center;padding:40px;color:var(--muted);font-size:14px;}
    .tag-input{display:flex;gap:8px;}
    .tag-input input{flex:1;}
    .punishment-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;}
    .punishment-card .p-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
    .punishment-card .p-user{font-weight:600;font-size:14px;}
    .punishment-card .p-type{font-size:12px;}
    .punishment-card .p-reason{font-size:13px;color:var(--muted);}
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    @media(max-width:900px){.two-col{grid-template-columns:1fr;}}
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <div class="logo">🗽 NYLRP</div>
      <div class="server">New York Liberty Roleplay</div>
    </div>
    <nav class="nav">
      ${nav.map(n => `<a href="/${n.id}" class="nav-item ${page === n.id ? 'active' : ''}">${n.icon} ${n.label}</a>`).join('')}
    </nav>
    <div class="sidebar-footer">
      <img class="avatar" src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
      <div class="user-info">
        <div class="name">${user.username}</div>
        <div class="tag">Staff Member</div>
      </div>
      <a href="/logout" class="logout">↩</a>
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <h1>${nav.find(n=>n.id===page)?.icon} ${nav.find(n=>n.id===page)?.label ?? 'Dashboard'}</h1>
      <span class="live"><span class="live-dot"></span> Live</span>
    </div>
    <div class="content">${content}</div>
  </div>
</body>
</html>`;
}

// ── Pages ─────────────────────────────────────────────────

// Home → redirect to panel
app.get('/', isAuth, (req, res) => res.redirect('/panel'));

// ── ERLC Panel ────────────────────────────────────────────
app.get('/panel', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const erlcKey = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  let players = {}, kills = [], cmds = [], modcalls = [], serverInfo = null;
  try { serverInfo = await erlc('/server', 'GET', null, erlcKey); } catch {}
  try { players = await erlc('/server/players', 'GET', null, erlcKey); } catch {}
  try { kills = (await erlc('/server/killlogs', 'GET', null, erlcKey)).slice(0, 10); } catch {}
  try { cmds = (await erlc('/server/commandlogs', 'GET', null, erlcKey)).slice(0, 10); } catch {}
  try { modcalls = (await erlc('/server/modcalls', 'GET', null, erlcKey)).slice(0, 5); } catch {}

  const playerList = Object.values(players);
  const content = `
    <div class="grid">
      <div class="card"><div class="card-title">Players In-Game</div><div class="card-value">${playerList.length}</div><div class="card-sub">${serverInfo?.Name ?? 'Server'}</div></div>
      <div class="card"><div class="card-title">Recent Kills</div><div class="card-value">${kills.length}</div><div class="card-sub">Last 10 entries</div></div>
      <div class="card"><div class="card-title">Commands Run</div><div class="card-value">${cmds.length}</div><div class="card-sub">Last 10 entries</div></div>
      <div class="card"><div class="card-title">Mod Calls</div><div class="card-value">${modcalls.length}</div><div class="card-sub">Active requests</div></div>
    </div>

    <div class="two-col">
      <div>
        <div class="section">
          <div class="section-title">👥 Players In-Game</div>
          ${playerList.length ? `<div class="player-grid">${playerList.map(p=>`<div class="player-card"><div>👤</div><div><div class="p-name">${p.Player}</div><div class="p-team">${p.Team||'No Team'}</div></div></div>`).join('')}</div>` : '<div class="empty">No players in game</div>'}
        </div>
        <div class="section">
          <div class="section-title">🚨 Mod Calls</div>
          <div class="table-wrap">
            ${modcalls.length ? `<table><thead><tr><th>Caller</th><th>Responder</th></tr></thead><tbody>${modcalls.map(m=>`<tr><td>${m.Caller}</td><td>${m.Responder||'<span class="badge badge-yellow">Pending</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No mod calls</div>'}
          </div>
        </div>
      </div>
      <div>
        <div class="section">
          <div class="section-title">💀 Kill Logs</div>
          <div class="table-wrap">
            ${kills.length ? `<table><thead><tr><th>Killer</th><th>Killed</th><th>Weapon</th></tr></thead><tbody>${kills.map(k=>`<tr><td>${k.Killer}</td><td>${k.Killed}</td><td>${k.Weapon||'?'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No kill logs</div>'}
          </div>
        </div>
        <div class="section">
          <div class="section-title">⌨️ Command Logs</div>
          <div class="table-wrap">
            ${cmds.length ? `<table><thead><tr><th>Player</th><th>Command</th></tr></thead><tbody>${cmds.map(c=>`<tr><td>${c.Player}</td><td><code>${c.Command||'?'}</code></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No command logs</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">🎮 Run Command</div>
      <div class="card">
        <form action="/api/erlc/command" method="POST" style="display:flex;gap:12px;align-items:flex-end;">
          <div class="form-group" style="flex:1;margin:0">
            <label>Command (e.g. :kick PlayerName reason)</label>
            <input name="command" placeholder=":kick PlayerName Reason" required>
          </div>
          <button type="submit" class="btn btn-primary">Run</button>
        </form>
      </div>
    </div>
  `;
  res.send(layout(req.user, 'panel', content));
});

// ── Members ───────────────────────────────────────────────
app.get('/members', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const verified = cfg?.verification?.verifiedUsers ?? {};
  const entries = Object.entries(verified);
  const content = `
    <div class="grid">
      <div class="card"><div class="card-title">Verified Members</div><div class="card-value">${entries.length}</div></div>
    </div>
    <div class="table-wrap">
      <div class="table-header"><h2>Verified Members</h2></div>
      ${entries.length ? `
      <table>
        <thead><tr><th>Discord ID</th><th>Roblox Username</th><th>Roblox ID</th><th>Verified At</th></tr></thead>
        <tbody>
          ${entries.map(([discordId, v])=>`
          <tr>
            <td><code>${discordId}</code></td>
            <td><a href="https://www.roblox.com/users/${v.robloxId}/profile" target="_blank" style="color:var(--accent);text-decoration:none;">${v.robloxUsername}</a></td>
            <td>${v.robloxId}</td>
            <td>${v.verifiedAt ? new Date(v.verifiedAt).toLocaleDateString() : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No verified members yet</div>'}
    </div>
  `;
  res.send(layout(req.user, 'members', content));
});

// ── Infractions ───────────────────────────────────────────
app.get('/infractions', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const warnings = cfg?.warnings ?? {};
  const notes    = cfg?.notes    ?? {};
  const allUsers = new Set([...Object.keys(warnings), ...Object.keys(notes)]);
  const content = `
    <div class="grid">
      <div class="card"><div class="card-title">Users with Warnings</div><div class="card-value">${Object.keys(warnings).length}</div></div>
      <div class="card"><div class="card-title">Total Warnings</div><div class="card-value">${Object.values(warnings).reduce((a,b)=>a+b.length,0)}</div></div>
      <div class="card"><div class="card-title">Total Notes</div><div class="card-value">${Object.values(notes).reduce((a,b)=>a+b.length,0)}</div></div>
    </div>
    <div class="table-wrap">
      <div class="table-header"><h2>Infractions</h2></div>
      ${allUsers.size ? `
      <table>
        <thead><tr><th>User ID</th><th>Warnings</th><th>Notes</th></tr></thead>
        <tbody>
          ${[...allUsers].map(uid=>`
          <tr>
            <td><code>${uid}</code></td>
            <td>${(warnings[uid]||[]).length > 0 ? `<span class="badge badge-red">${(warnings[uid]||[]).length} warning${(warnings[uid]||[]).length!==1?'s':''}</span>` : '—'}</td>
            <td>${(notes[uid]||[]).length > 0 ? `<span class="badge badge-yellow">${(notes[uid]||[]).length} note${(notes[uid]||[]).length!==1?'s':''}</span>` : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No infractions on record</div>'}
    </div>
  `;
  res.send(layout(req.user, 'infractions', content));
});

// ── Sessions ──────────────────────────────────────────────
app.get('/sessions', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const sessionCfg = cfg?.session ?? {};
  const content = `
    <div class="grid">
      <div class="card"><div class="card-title">Session Channel</div><div class="card-value" style="font-size:16px">${sessionCfg.channel ? `<#${sessionCfg.channel}>` : 'Not set'}</div></div>
      <div class="card"><div class="card-title">Vote Threshold</div><div class="card-value">${sessionCfg.voteThreshold ?? 6}</div><div class="card-sub">votes required</div></div>
      <div class="card"><div class="card-title">Server Code</div><div class="card-value" style="font-size:16px">${sessionCfg.joinLink ? 'Set' : 'Not set'}</div></div>
    </div>
    <div class="card">
      <div class="section-title">📋 Session Info</div>
      <p style="color:var(--muted);font-size:14px;line-height:1.6">
        Sessions are managed via Discord commands. Use <code>/session start</code>, <code>/session vote</code> and <code>/session shutdown</code> in your Discord server.
        <br><br>
        Session description: <em>${sessionCfg.startDescription?.slice(0,100) ?? 'Not set'}${(sessionCfg.startDescription?.length??0)>100?'...':''}</em>
      </p>
    </div>
  `;
  res.send(layout(req.user, 'sessions', content));
});

// ── ERLC Settings ─────────────────────────────────────────
app.get('/erlc', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const ec  = cfg?.erlcLogs ?? {};
  const content = `
    <div class="grid">
      <div class="card"><div class="card-title">Status</div><div class="card-value" style="font-size:18px">${ec.enabled ? '<span style="color:var(--success)">✅ Active</span>' : '<span style="color:var(--danger)">❌ Inactive</span>'}</div></div>
      <div class="card"><div class="card-title">Server Key</div><div class="card-value" style="font-size:18px">${ec.serverKey ? '<span style="color:var(--success)">✅ Set</span>' : '<span style="color:var(--danger)">❌ Not set</span>'}</div></div>
    </div>
    <div class="card" style="margin-bottom:24px">
      <div class="section-title" style="margin-bottom:16px">📡 Log Channels</div>
      <table style="width:100%">
        <thead><tr><th>Type</th><th>Channel ID</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>🔨 Kick/Ban Logs</td><td><code>${ec.kickBans||'—'}</code></td><td>${ec.kickBans?'<span class="badge badge-green">Set</span>':'<span class="badge badge-red">Not set</span>'}</td></tr>
          <tr><td>📥 Join/Leave</td><td><code>${ec.joinLeave||'—'}</code></td><td>${ec.joinLeave?'<span class="badge badge-green">Set</span>':'<span class="badge badge-red">Not set</span>'}</td></tr>
          <tr><td>⌨️ Commands</td><td><code>${ec.cmds||'—'}</code></td><td>${ec.cmds?'<span class="badge badge-green">Set</span>':'<span class="badge badge-red">Not set</span>'}</td></tr>
          <tr><td>🚨 Mod Calls</td><td><code>${ec.modCall||'—'}</code></td><td>${ec.modCall?'<span class="badge badge-green">Set</span>':'<span class="badge badge-red">Not set</span>'}</td></tr>
          <tr><td>💀 Kill Logs</td><td><code>${ec.kills||'—'}</code></td><td>${ec.kills?'<span class="badge badge-green">Set</span>':'<span class="badge badge-red">Not set</span>'}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <div class="section-title" style="margin-bottom:16px">🔑 Update Server Key</div>
      <form action="/api/erlc/key" method="POST" style="display:flex;gap:12px;align-items:flex-end;">
        <div class="form-group" style="flex:1;margin:0">
          <label>ERLC Server Key</label>
          <input type="password" name="key" placeholder="Paste your ERLC server key..." required>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>
  `;
  res.send(layout(req.user, 'erlc', content));
});

// ── Audit Logs ────────────────────────────────────────────
app.get('/logs', isAuth, async (req, res) => {
  const cfg  = await getConfig(GUILD_ID);
  const warn = cfg?.warnings ?? {};
  const note = cfg?.notes    ?? {};
  const allLogs = [];
  for (const [uid, ws] of Object.entries(warn)) {
    for (const w of ws) allLogs.push({ type: 'warn', uid, data: w });
  }
  for (const [uid, ns] of Object.entries(note)) {
    for (const n of ns) allLogs.push({ type: 'note', uid, data: n });
  }
  allLogs.sort((a,b) => (b.data.timestamp||0) - (a.data.timestamp||0));
  const content = `
    <div class="table-wrap">
      <div class="table-header"><h2>Audit Logs</h2></div>
      ${allLogs.length ? `
      <table>
        <thead><tr><th>Type</th><th>User</th><th>Details</th><th>By</th><th>Date</th></tr></thead>
        <tbody>
          ${allLogs.slice(0,50).map(l=>`
          <tr>
            <td>${l.type==='warn'?'<span class="badge badge-red">⚠️ Warning</span>':'<span class="badge badge-yellow">📝 Note</span>'}</td>
            <td><code>${l.uid}</code></td>
            <td style="max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${l.data.reason||l.data.note||'—'}</td>
            <td>${l.data.by||'—'}</td>
            <td>${l.data.timestamp ? new Date(l.data.timestamp).toLocaleDateString() : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No logs on record</div>'}
    </div>
  `;
  res.send(layout(req.user, 'logs', content));
});

// ── Settings ──────────────────────────────────────────────
app.get('/settings', isAuth, async (req, res) => {
  const content = `
    <div class="card">
      <div class="section-title" style="margin-bottom:8px">⚙️ Dashboard Settings</div>
      <p style="color:var(--muted);font-size:14px;margin-bottom:24px">Bot settings are managed via Discord slash commands. Use <code>/setup</code> in your Discord server to configure the bot.</p>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-weight:600;font-size:14px;">Bot Configuration</div><div style="color:var(--muted);font-size:12px;">Tickets, applications, sessions, etc.</div></div>
          <span class="badge badge-blue">Via /setup in Discord</span>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-weight:600;font-size:14px;">ERLC Integration</div><div style="color:var(--muted);font-size:12px;">Server key, log channels</div></div>
          <a href="/erlc" class="btn btn-secondary" style="text-decoration:none;font-size:12px;">Configure</a>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-weight:600;font-size:14px;">Dashboard Version</div><div style="color:var(--muted);font-size:12px;">NYLRP Dashboard v1.0</div></div>
          <span class="badge badge-green">Up to date</span>
        </div>
      </div>
    </div>
  `;
  res.send(layout(req.user, 'settings', content));
});

// ── API routes ────────────────────────────────────────────
app.post('/api/erlc/command', isAuth, async (req, res) => {
  const { command } = req.body;
  const cfg = await getConfig(GUILD_ID);
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try {
    await erlc('/server/command', 'POST', { command }, key);
    res.redirect('/panel?success=Command+sent');
  } catch (e) {
    res.redirect('/panel?error=' + encodeURIComponent(e.message));
  }
});

app.post('/api/erlc/key', isAuth, async (req, res) => {
  const { key } = req.body;
  const doc = await GuildConfig.findOne({ guildId: GUILD_ID });
  if (doc) {
    if (!doc.data.erlcLogs) doc.data.erlcLogs = {};
    doc.data.erlcLogs.serverKey = key;
    doc.markModified('data');
    await doc.save();
  }
  res.redirect('/erlc?success=Key+saved');
});

// ── API: live data ─────────────────────────────────────────
app.get('/api/players', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try { res.json(await erlc('/server/players', 'GET', null, key)); }
  catch (e) { res.json({}); }
});

app.get('/api/killlogs', isAuth, async (req, res) => {
  const cfg = await getConfig(GUILD_ID);
  const key = cfg?.erlcLogs?.serverKey || ERLC_API_KEY;
  try { res.json(await erlc('/server/killlogs', 'GET', null, key)); }
  catch (e) { res.json([]); }
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Dashboard running on port ${PORT}`));
