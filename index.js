cat > /home/claude/index.js
require('dotenv').config();
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

// Health check server
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.end('Bot is running!');
  }
}).listen(process.env.PORT || 10000);

process.chdir(path.dirname(require.main.filename));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ════════════════════════════════════════════
// MONGODB CONFIGURATION
// ════════════════════════════════════════════
const configSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { strict: false });

const ConfigModel = mongoose.model('Config', configSchema);
let config = {};
let dbReady = false;

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ MongoDB connected!');
    dbReady = true;
    await loadConfigFromDB();
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    console.error('⚠️ Bot running without persistent storage!');
  }
}

async function loadConfigFromDB() {
  try {
    const docs = await ConfigModel.find({});
    config = {};
    for (const doc of docs) {
      config[doc._id] = doc.data;
    }
    console.log(`✅ Config loaded: ${docs.length} guild(s)`);
  } catch (e) {
    console.error('❌ Config load failed:', e.message);
  }
}

async function saveGuildConfig(guildId) {
  if (!dbReady) return;
  try {
    await ConfigModel.findByIdAndUpdate(
      guildId,
      { _id: guildId, data: config[guildId] ?? {} },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error(`❌ Config save failed (${guildId}):`, e.message);
  }
}

async function saveAllConfigs() {
  if (!dbReady) return;
  const promises = Object.keys(config).map(guildId => saveGuildConfig(guildId));
  await Promise.allSettled(promises);
}

async function saveConfig(cfg) {
  const promises = Object.keys(cfg).map(guildId => saveGuildConfig(guildId).catch(() => {}));
  await Promise.allSettled(promises);
}

setInterval(() => saveAllConfigs().catch(console.error), 5 * 60 * 1000);

async function gracefulShutdown(signal) {
  console.log(`\n⚠️ ${signal} — saving config...`);
  await saveAllConfigs();
  console.log('✅ Config saved. Shutting down.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  if ([10062, 40060, 10008, 50013].includes(err?.code)) {
    console.warn('⚠️ Discord API warning:', err.message);
    return;
  }
  console.error('❌ Uncaught Exception:', err);
  await saveAllConfigs().catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if ([10062, 40060, 10008, 50013].includes(reason?.code)) {
    console.warn('⚠️ Discord API warning:', reason.message);
    return;
  }
  console.error('❌ Unhandled Rejection:', reason);
  saveAllConfigs().catch(() => {});
});

function getGuildConfig(guildId) {
  if (!config[guildId]) {
    config[guildId] = {};
    saveGuildConfig(guildId).catch(() => {});
  }
  return config[guildId];
}

// ════════════════════════════════════════════
// DEPARTMENT SYSTEM CONFIG
// ════════════════════════════════════════════
function getServerTypeConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.serverType) gc.serverType = {
    type: 'standalone',
    mainGuildId: null,
    departments: [],
    staffRoleName: null,
    shrRoleName: null,
    setupRoleId: null,
  };
  if (!gc.serverType.departments) gc.serverType.departments = [];
  return gc.serverType;
}

const DEFAULT_STAFF_ROLE = '《 𝑵𝒀𝑳𝑹𝑷 | Staff Team》';
const DEFAULT_SHR_ROLE = 'SHR';
const DEFAULT_SETUP_ID = '1379173469501264026';

function getStaffRoleName(guildId) { return getServerTypeConfig(guildId).staffRoleName || DEFAULT_STAFF_ROLE; }
function getSHRRoleName(guildId) { return getServerTypeConfig(guildId).shrRoleName || DEFAULT_SHR_ROLE; }
function getSetupRoleId(guildId) { return getServerTypeConfig(guildId).setupRoleId || DEFAULT_SETUP_ID; }

function hasStaff(member) { return member.roles.cache.some(r => r.name === getStaffRoleName(member.guild.id)); }
function hasSHR(member) { return member.roles.cache.some(r => r.name === getSHRRoleName(member.guild.id)); }
function hasSetup(member) { return member.roles.cache.has(getSetupRoleId(member.guild.id)) || member.permissions.has('Administrator'); }
function hasAnyStaff(member) { return hasStaff(member) || hasSHR(member); }

// ════════════════════════════════════════════
// CONFIG HELPERS
// ════════════════════════════════════════════
function getHandbookConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.handbooks) gc.handbooks = { panels: {} };
  return gc.handbooks;
}

function getTicketConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticket) gc.ticket = {
    pingRoles: [], transcriptChannel: null, ticketChannel: null, ticketCategory: null,
    panelTitle: '🎫 Support Tickets', panelDescription: 'Click a button below to open a support ticket.',
    panelColor: '#5865F2', panelThumbnail: null, welcomeText: 'Hello {user}, thank you for opening a ticket!',
    ticketTypes: []
  };
  for (const t of gc.ticket.ticketTypes) {
    if (!t.requiredRoles) t.requiredRoles = [];
    if (!t.viewRoles) t.viewRoles = [];
    if (!t.category) t.category = null;
  }
  return gc.ticket;
}

function getSessionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.session) gc.session = {
    channel: null, pingRoles: [], allowedRoles: [], joinLink: null,
    startImage: null, startDescription: null, voteImage: null, voteDescription: null,
    shutdownImage: null, shutdownDescription: null, voteThreshold: 5
  };
  if (gc.session.voteThreshold === undefined) gc.session.voteThreshold = 5;
  return gc.session;
}

function getSelfRoleConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.selfroles) gc.selfroles = { panels: {} };
  return gc.selfroles;
}

function getAnnouncementConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.announcements) gc.announcements = { types: {} };
  return gc.announcements;
}

function getWelcomerConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.welcomer) gc.welcomer = {
    enabled: false, channel: null, title: 'Welcome to {server}!',
    description: 'Hello {userMention}, welcome to **{server}**!\nYou are member **#{memberCount}**.',
    color: '#2f3136', thumbnail: true, image: null, footer: 'Welcome!', pingUser: true
  };
  return gc.welcomer;
}

function getAutoroleConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.autorole) gc.autorole = { enabled: false, roles: [] };
  return gc.autorole;
}

function getVerificationConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.verification) gc.verification = {
    enabled: false, channel: null, verifiedRole: null,
    panelTitle: '✅ Verify your Roblox account',
    panelDescription: 'Click **Verify** below, enter your Roblox username, and you\'ll get access!\n\nNickname will be: `(DiscordName) | RobloxName`',
    panelColor: '#57F287', panelImage: null, verifiedUsers: {}
  };
  return gc.verification;
}

function getApplicationConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.applications) gc.applications = {
    panels: [], reviewChannel: null, logChannel: null, appTypes: []
  };
  if (!gc.applications.panels) gc.applications.panels = [];
  if (!gc.applications.appTypes) gc.applications.appTypes = [];
  for (const t of gc.applications.appTypes) {
    if (!Array.isArray(t.questions)) t.questions = [];
    if (!Array.isArray(t.acceptRoles)) t.acceptRoles = [];
    if (t.acceptMessage === undefined) t.acceptMessage = null;
    if (t.denyMessage === undefined) t.denyMessage = null;
    if (t.groupLink === undefined) t.groupLink = null;
    if (t.nicknameFormat === undefined) t.nicknameFormat = null;
    if (t.reviewChannel === undefined) t.reviewChannel = null;
    if (t.reviewRoles === undefined) t.reviewRoles = [];
    if (t.requiredRoles === undefined) t.requiredRoles = [];
  }
  for (const p of gc.applications.panels) {
    if (!Array.isArray(p.appTypeIds)) p.appTypeIds = [];
    if (p.reviewChannel === undefined) p.reviewChannel = null;
    if (p.image === undefined) p.image = null;
    if (p.title === undefined) p.title = '📋 Applications';
    if (p.description === undefined) p.description = null;
    if (p.color === undefined) p.color = '#5865F2';
    if (p.channel === undefined) p.channel = null;
  }
  return gc.applications;
}

function getSavedMessagesConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.savedMessages) gc.savedMessages = { messages: {} };
  if (!gc.savedMessages.messages) gc.savedMessages.messages = {};
  for (const msg of Object.values(gc.savedMessages.messages)) {
    if (msg.title === undefined) msg.title = 'Bericht';
    if (msg.description === undefined) msg.description = '';
    if (msg.color === undefined) msg.color = '#5865F2';
    if (msg.image === undefined) msg.image = null;
    if (msg.footer === undefined) msg.footer = null;
  }
  return gc.savedMessages;
}

function getAutomodConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.automod) gc.automod = { enabled: false, keywords: [], logChannel: null, action: 'delete', muteMinutes: 5 };
  return gc.automod;
}

function getCounterConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.counters) gc.counters = {
    enabled: false, categoryId: null,
    channels: {
      members: { enabled: true, channelId: null, label: '👥 Members: {count}' },
      bots: { enabled: true, channelId: null, label: '🤖 Bots: {count}' },
      online: { enabled: true, channelId: null, label: '🟢 Online: {count}' },
      channels: { enabled: true, channelId: null, label: '💬 Channels: {count}' },
      roles: { enabled: true, channelId: null, label: '🎭 Roles: {count}' }
    }
  };
  return gc.counters;
}

function getWarnings(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  if (!gc.warnings[userId]) gc.warnings[userId] = [];
  return gc.warnings[userId];
}

async function addWarning(guildId, userId, warn) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  if (!gc.warnings[userId]) gc.warnings[userId] = [];
  gc.warnings[userId].push(warn);
  await saveConfig(config);
}

async function clearWarnings(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  gc.warnings[userId] = [];
  await saveConfig(config);
}

function getNotes(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.notes) gc.notes = {};
  if (!gc.notes[userId]) gc.notes[userId] = [];
  return gc.notes[userId];
}

async function addNote(guildId, userId, note) {
  const gc = getGuildConfig(guildId);
  if (!gc.notes) gc.notes = {};
  if (!gc.notes[userId]) gc.notes[userId] = [];
  gc.notes[userId].push(note);
  await saveConfig(config);
}

function getRolePermConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.rolePerms) gc.rolePerms = {};
  return gc.rolePerms;
}

function getCommandListConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.commandList) gc.commandList = { channel: null, messageId: null };
  return gc.commandList;
}

function getExecRequestConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.execRequest) gc.execRequest = { channel: null, approvalRoles: [], requiredApprovals: 2 };
  return gc.execRequest;
}

function getFounderRequestConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.founderRequest) gc.founderRequest = { channel: null, approvalRoles: [], requiredApprovals: 2 };
  return gc.founderRequest;
}

function getTrainingConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.training) gc.training = {
    channel: null, trainerRoles: [], requestRoles: [], pingRoles: [],
    announceChannel: null, announceMessage: null
  };
  if (!gc.training.trainerRoles) gc.training.trainerRoles = [];
  if (!gc.training.requestRoles) gc.training.requestRoles = [];
  if (!gc.training.pingRoles) gc.training.pingRoles = [];
  if (!gc.training.announceChannel) gc.training.announceChannel = null;
  if (!gc.training.announceMessage) gc.training.announceMessage = null;
  return gc.training;
}

function getErlcLogConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.erlcLogs) gc.erlcLogs = {
    enabled: false, serverKey: null, kickBans: null, joinLeave: null, cmds: null, modCall: null, kills: null
  };
  if (!gc.erlcLogs.serverKey) gc.erlcLogs.serverKey = null;
  return gc.erlcLogs;
}

// ════════════════════════════════════════════
// CONSTANTS & STATE
// ════════════════════════════════════════════
const LOGO_URL = 'https://cdn.discordapp.com/attachments/1363047391263064166/1484556795321122917/image.png';
const trainRequestCooldowns = new Map();
const openTickets = new Map();
const srPendingRoleAdd = new Map();
const activeVotes = new Map();
const pendingCloseReqs = new Map();
const pendingAnnounceChannel = new Map();
const pendingSendMsgChannel = new Map();
const activeAppSessions = new Map();
const pendingVerifications = new Map();
const erlcState = new Map();

function genId() { return Math.random().toString(36).slice(2, 8); }
function hexToInt(hex) { if (!hex) return 0x5865F2; const v = parseInt(hex.replace('#', ''), 16); return isNaN(v) ? 0x5865F2 : v; }
function colorToButtonStyle(c) {
  if (!c) return ButtonStyle.Secondary;
  const s = c.toLowerCase().trim();
  if (s === 'green' || s === 'success') return ButtonStyle.Success;
  if (s === 'red' || s === 'danger') return ButtonStyle.Danger;
  if (s === 'grey' || s === 'gray' || s === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}
function safeSetEmoji(btn, emoji) { if (!emoji || emoji === 'null') return btn; try { btn.setEmoji(emoji); } catch {} return btn; }
function isValidUrl(url) { if (!url || typeof url !== 'string') return false; const t = url.trim(); return t.startsWith('https://') || t.startsWith('http://'); }

function replaceVars(text, opts = {}) {
  if (!text) return text;
  const now = new Date();
  return text
    .replace(/{user}/g, opts.userMention ?? '')
    .replace(/{userMention}/g, opts.userMention ?? '')
    .replace(/{username}/g, opts.username ?? '')
    .replace(/{host}/g, opts.username ?? '')
    .replace(/{hostMention}/g, opts.userMention ?? '')
    .replace(/{hostTag}/g, opts.userTag ?? '')
    .replace(/{memberCount}/g, opts.memberCount ?? '')
    .replace(/{server}/g, opts.server ?? '')
    .replace(/{time}/g, now.toUTCString())
    .replace(/{date}/g, now.toDateString());
}

function roleDropdown(customId, placeholder, min = 1, max = 10) {
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max)
  );
}

function channelDropdown(customId, placeholder, types = [ChannelType.GuildText]) {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addChannelTypes(...types).setMinValues(1).setMaxValues(1)
  );
}

// ════════════════════════════════════════════
// ERLC API
// ════════════════════════════════════════════
const ERLC_BASE = 'https://api.policeroleplay.community/v1';
async function erlcRequest(p, method = 'GET', body = null, guildId = null) {
  const key = guildId ? (getErlcLogConfig(guildId).serverKey || process.env.ERLC_API_KEY) : process.env.ERLC_API_KEY;
  const opts = { method, headers: { 'Server-Key': key, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${p}`, opts);
  if (!res.ok) throw new Error(`ERLC ${res.status}: ${res.statusText}`);
  return res.json();
}

async function getRobloxUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!res.ok) throw new Error('Roblox API error');
  const data = await res.json();
  return data.data?.length ? data.data[0] : null;
}

async function getRobloxDescription(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  if (!res.ok) throw new Error('Roblox API error');
  return (await res.json()).description ?? '';
}

function canRunSession(member, guildId) {
  if (hasSHR(member)) return true;
  const sc = getSessionConfig(guildId);
  if (!sc.allowedRoles?.length) return hasAnyStaff(member);
  return sc.allowedRoles.some(id => member.roles.cache.has(id));
}

// ════════════════════════════════════════════
// COUNTER FUNCTIONS
// ════════════════════════════════════════════
async function getCounterValue(guild, type) {
  switch (type) {
    case 'members': { await guild.members.fetch(); return guild.members.cache.filter(m => !m.user.bot).size; }
    case 'bots': { await guild.members.fetch(); return guild.members.cache.filter(m => m.user.bot).size; }
    case 'online': {
      await guild.members.fetch();
      return guild.members.cache.filter(m => !m.user.bot && m.presence && ['online', 'idle', 'dnd'].includes(m.presence.status)).size;
    }
    case 'channels': return guild.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).size;
    case 'roles': return guild.roles.cache.size - 1;
    default: return 0;
  }
}

async function updateCounters(guild) {
  const cc = getCounterConfig(guild.id);
  if (!cc.enabled) return;
  for (const [type, cfg] of Object.entries(cc.channels)) {
    if (!cfg.enabled || !cfg.channelId) continue;
    try {
      const channel = guild.channels.cache.get(cfg.channelId);
      if (!channel) continue;
      const count = await getCounterValue(guild, type);
      const newName = cfg.label.replace('{count}', count);
      if (channel.name !== newName) await channel.setName(newName).catch(() => {});
    } catch (e) { console.error(`Counter update error [${type}]:`, e); }
  }
}

async function createCounterChannel(guild, type, cc) {
  const cfg = cc.channels[type];
  const count = await getCounterValue(guild, type);
  const name = cfg.label.replace('{count}', count);
  const opts = {
    name,
    type: ChannelType.GuildVoice,
    permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }]
  };
  if (cc.categoryId) opts.parent = cc.categoryId;
  const ch = await guild.channels.create(opts);
  cfg.channelId = ch.id;
  return ch;
}

async function deleteCounterChannel(guild, type, cc) {
  const cfg = cc.channels[type];
  if (!cfg.channelId) return;
  const ch = guild.channels.cache.get(cfg.channelId);
  if (ch) await ch.delete().catch(() => {});
  cfg.channelId = null;
}

setInterval(async () => {
  for (const guild of client.guilds.cache.values()) {
    await updateCounters(guild).catch(console.error);
  }
}, 5 * 60 * 1000);

// ════════════════════════════════════════════
// TRAINING / PROMOTION HELPERS
// ════════════════════════════════════════════
async function sendPromotionAnnounce(guild, targetUser, roleName, promotedBy, source = 'promotion') {
  const tc = getTrainingConfig(guild.id);
  if (!tc.announceChannel) return;
  const ch = guild.channels.cache.get(tc.announceChannel);
  if (!ch) return;
  const defaultMsg = source === 'training'
    ? '🎉 Congratulations <@{user}>! You have **passed your training** and have been promoted to **{role}**! Well done!'
    : '🎉 Congratulations <@{user}>! You have been promoted to **{role}**!';
  const msg = (tc.announceMessage || defaultMsg)
    .replace(/{user}/g, targetUser.id)
    .replace(/{role}/g, roleName)
    .replace(/{promotedBy}/g, promotedBy?.tag ?? 'Staff')
    .replace(/{server}/g, guild.name);
  const embed = new EmbedBuilder()
    .setTitle(source === 'training' ? '🎓 Training Passed!' : '⬆️ Promotion!')
    .setColor(0x57F287)
    .setDescription(msg)
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
    .setTimestamp();
  await ch.send({ embeds: [embed] }).catch(() => {});
}

// ════════════════════════════════════════════
// APPLICATION SYSTEM FUNCTIONS
// ════════════════════════════════════════════
async function sendNextQuestion(userId, session, appType) {
  const dmChannel = await client.users.fetch(userId).then(u => u.createDM()).catch(() => null);
  if (!dmChannel) return false;
  const qIndex = session.questionIndex;
  const total = appType.questions.length;
  const question = appType.questions[qIndex];
  const filled = Math.round((qIndex / total) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 ${appType.label} — Question ${qIndex + 1}/${total}`)
    .setDescription(`**${question}**`)
    .setFooter({ text: `Type your answer below. Type "cancel" to cancel. • ${session.guildName}` })
    .addFields({ name: 'Progress', value: `\`${bar}\` ${qIndex}/${total} answered`, inline: false });
  try {
    await dmChannel.send({ embeds: [embed] });
    return true;
  } catch { return false; }
}

async function submitApplication(userId, session, appType, guild) {
  const ac = getApplicationConfig(session.guildId);
  let reviewChannelId = ac.reviewChannel;
  if (session.panelId) {
    const panel = ac.panels.find(p => p.id === session.panelId);
    if (panel?.reviewChannel) reviewChannelId = panel.reviewChannel;
  }
  if (appType.reviewChannel) reviewChannelId = appType.reviewChannel;
  if (!reviewChannelId) throw new Error('No review channel configured.');
  const reviewCh = guild.channels.cache.get(reviewChannelId);
  if (!reviewCh) throw new Error('Review channel not found.');
  const applicant = await client.users.fetch(userId).catch(() => null);
  const answerFields = appType.questions.map((q, i) => ({
    name: `❓ ${q.slice(0, 250)}`,
    value: (session.answers[i] ?? '*No answer*').slice(0, 1024),
    inline: false,
  }));
  const appId = genId();
  const headerFields = [
    { name: '👤 Applicant', value: applicant ? `${applicant.tag} (<@${userId}>)` : `<@${userId}>`, inline: true },
    { name: '🆔 User ID', value: userId, inline: true },
    { name: '📅 Submitted', value: new Date().toUTCString(), inline: false },
  ];
  const fieldSize = f => (f.name?.length ?? 0) + (f.value?.length ?? 0);
  const MAX_FIELDS = 25;
  const EMBED_MAX = 5800;
  const embeds = [];
  let currentFields = [...headerFields];
  let currentSize = 60 + headerFields.reduce((s, f) => s + fieldSize(f), 0);
  let isFirst = true;
  let page = 1;

  const flushEmbed = (isLast) => {
    const title = isFirst
      ? `📋 New Application — ${appType.emoji || ''} ${appType.label}`
      : `📋 Application (continued) — ${appType.label} — Page ${page}`;
    const eb = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x5865F2)
      .addFields(...currentFields)
      .setFooter({ text: `Application ID: ${appId}${!isLast ? ' • Continued below ↓' : ''}` });
    if (isFirst) {
      eb.setThumbnail(applicant?.displayAvatarURL({ dynamic: true }) ?? null);
      eb.setTimestamp();
    }
    embeds.push(eb);
    isFirst = false;
    page++;
    currentFields = [];
    currentSize = 60;
  };

  for (const field of answerFields) {
    const fSize = fieldSize(field);
    if (currentFields.length >= MAX_FIELDS || (currentSize + fSize > EMBED_MAX && currentFields.length > 0)) {
      flushEmbed(false);
    }
    currentFields.push(field);
    currentSize += fSize;
  }
  if (currentFields.length > 0) flushEmbed(true);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app__accept__${userId}__${appType.id}__${appId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app__acceptsilent__${userId}__${appType.id}__${appId}`).setLabel('🔕 Accept (Silent)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`app__deny__${userId}__${appType.id}__${appId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
  );

  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    const isLastBatch = i + 10 >= embeds.length;
    await reviewCh.send({ embeds: batch, components: isLastBatch ? [row] : [] });
  }
  return appId;
}

// ════════════════════════════════════════════
// SESSION HELPERS
// ════════════════════════════════════════════
async function announceSessionToAllDepartments(mainGuildId, embed, joinLink) {
  const stc = getServerTypeConfig(mainGuildId);
  if (!stc.departments?.length) return;
  for (const dept of stc.departments) {
    try {
      const guild = client.guilds.cache.get(dept.guildId);
      if (!guild) continue;
      const ch = guild.channels.cache.get(dept.announcementChannel);
      if (!ch) continue;
      const ping = dept.pingRoles?.length ? dept.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
      const comps = [];
      if (joinLink && isValidUrl(joinLink)) {
        comps.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(joinLink.trim())
        ));
      }
      await ch.send({ content: ping ?? undefined, embeds: [embed], components: comps });
    } catch (e) { console.error(`Department announce error [${dept.guildId}]:`, e.message); }
  }
}

async function postSessionStart(guild, sc, hostUser, rawLink, vars, voterMentions = null) {
  const sCh = guild.channels.cache.get(sc.channel);
  if (!sCh) throw new Error('Session channel not found');
  const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
  const desc = replaceVars(sc.startDescription ?? '{hostMention} has started a session! Join using the button below.', vars);
  const embed = new EmbedBuilder()
    .setTitle('🟢 Session Started!')
    .setColor(0x57F287)
    .setDescription(desc)
    .setTimestamp()
    .setFooter({ text: `By ${hostUser.tag}` });
  if (sc.startImage) embed.setImage(sc.startImage);
  const comps = [];
  if (isValidUrl(rawLink)) {
    comps.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(rawLink.trim())
    ));
  }
  let content = ping ?? '';
  if (voterMentions) {
    content = content ? `${content}\n🗳️ **Voters:** ${voterMentions}` : `🗳️ **Voters:** ${voterMentions}`;
  }
  await sCh.send({ content: content || undefined, embeds: [embed], components: comps });
  await announceSessionToAllDepartments(guild.id, embed, rawLink);
}

// ════════════════════════════════════════════
// SELF ROLE DEPLOY
// ════════════════════════════════════════════
async function deploySelfRolePanel(guild, panelId, panel) {
  const channel = await guild.channels.fetch(panel.channel).catch(() => null);
  if (!channel) throw new Error('Channel not found');
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description || 'Select your roles below.')
    .setColor(hexToInt(panel.color))
    .setFooter({ text: panel.type === 'reaction' ? 'React to get a role' : 'Click to toggle your role' });
  if (panel.thumbnail) embed.setThumbnail(panel.thumbnail);
  if (panel.type === 'reaction') {
    const msg = await channel.send({ embeds: [embed] });
    for (const role of panel.roles) {
      if (role.reaction) await msg.react(role.reaction).catch(() => {});
    }
    panel.messageId = msg.id;
    return;
  }
  if (panel.type === 'dropdown') {
    const options = panel.roles.slice(0, 25).map(r => {
      const opt = { label: r.label.slice(0, 100), value: r.id, description: `Toggle ${r.label}`.slice(0, 100) };
      if (r.emoji) opt.emoji = r.emoji;
      return opt;
    });
    const maxVals = panel.max > 0 ? Math.min(panel.max, options.length) : options.length;
    const select = new StringSelectMenuBuilder()
      .setCustomId(`srp__dd__${panelId}`)
      .setPlaceholder('Choose your roles…')
      .setMinValues(0)
      .setMaxValues(maxVals)
      .addOptions(options);
    const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
    panel.messageId = msg.id;
    return;
  }
  const rows = [];
  for (let i = 0; i < Math.min(panel.roles.length, 25); i += 5) {
    const chunk = panel.roles.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(
      chunk.map(r => safeSetEmoji(new ButtonBuilder().setCustomId(`srp__btn__${panelId}__${r.id}`).setLabel(r.label.slice(0, 80)).setStyle(ButtonStyle.Secondary), r.emoji))
    ));
  }
  const msg = await channel.send({ embeds: [embed], components: rows });
  panel.messageId = msg.id;
}

// ════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════
const commands = [
  { name: 'ping', description: 'Check bot latency' },
  { name: 'avatar', description: 'Show avatar', options: [{ name: 'user', type: 6, description: 'Who?', required: false }] },
  { name: 'serverinfo', description: 'Server information' },
  { name: 'roleinfo', description: 'Role information', options: [{ name: 'role', type: 8, description: 'Which role?', required: true }] },
  { name: 'poll', description: 'Create a poll', options: [
    { name: 'question', type: 3, description: 'Question', required: true },
    { name: 'option1', type: 3, description: 'Option 1', required: true },
    { name: 'option2', type: 3, description: 'Option 2', required: true },
    { name: 'option3', type: 3, description: 'Option 3', required: false },
    { name: 'option4', type: 3, description: 'Option 4', required: false },
  ]},
  { name: 'userinfo', description: 'User information', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'warn', description: 'Warn a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: true }] },
  { name: 'mute', description: 'Mute a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'minutes', type: 4, description: 'Minutes', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'unmute', description: 'Unmute a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'slowmode', description: 'Set slowmode', options: [{ name: 'seconds', type: 4, description: 'Seconds (0=off)', required: true }] },
  { name: 'lock', description: 'Lock channel' },
  { name: 'unlock', description: 'Unlock channel' },
  { name: 'clear', description: 'Delete messages', options: [{ name: 'amount', type: 4, description: 'How many (max 100)', required: true }] },
  { name: 'close', description: 'Close the current ticket (staff only)' },
  { name: 'closerequest', description: 'Request to close this ticket' },
  { name: 'send', description: 'Send a custom message to this channel' },
  { name: 'session', description: 'Session commands', options: [
    { name: 'start', type: 1, description: 'Start session', options: [{ name: 'link', type: 3, description: 'Join link override', required: false }] },
    { name: 'vote', type: 1, description: 'Start vote', options: [{ name: 'votes', type: 4, description: 'Votes needed', required: false }] },
    { name: 'shutdown', type: 1, description: 'Shutdown session' },
  ]},
  { name: 'ban', description: '[SHR] Ban user + delete all messages/threads', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'unban', description: '[SHR] Unban by ID', options: [{ name: 'userid', type: 3, description: 'User ID', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'softban', description: '[SHR] Softban user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'tempban', description: '[SHR] Temp ban user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'hours', type: 4, description: 'Hours', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'kick', description: '[SHR] Kick user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'addrole', description: 'Add a role to a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role', required: true }] },
  { name: 'removerole', description: 'Remove a role from a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role', required: true }] },
  { name: 'giveroles', description: 'Add multiple roles to a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'roles', type: 3, description: 'Role IDs or mentions separated by spaces', required: true },
  ]},
  { name: 'nickname', description: '[SHR] Change nickname', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'nickname', type: 3, description: 'New nickname', required: false }] },
  { name: 'promote', description: '[SHR] Promote a user to a role', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role to promote to', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'demote', description: '[SHR] Demote a user from a role', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role to demote from', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'unverify', description: '[SHR] Unverify a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'executiverequest', description: 'Submit an executive request (demotion/termination)' },
  { name: 'foundationrequest', description: 'Submit a foundership team request' },
  { name: 'Roblox Profile', type: 2 },
  { name: 'clearwarnings', description: '[SHR] Clear warnings', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'note', description: '[SHR] Add note', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'text', type: 3, description: 'Note', required: true }] },
  { name: 'notes', description: '[SHR] View notes', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'announce', description: '[SHR] Send an announcement' },
  { name: 'embed', description: '[SHR] Send custom embed', options: [
    { name: 'channel', type: 7, description: 'Channel', required: true },
    { name: 'title', type: 3, description: 'Title', required: true },
    { name: 'description', type: 3, description: 'Description', required: true },
    { name: 'color', type: 3, description: 'Hex color', required: false },
    { name: 'image', type: 3, description: 'Image URL', required: false },
    { name: 'footer', type: 3, description: 'Footer', required: false },
  ]},
  { name: 'giveaway', description: '[SHR] Start giveaway', options: [
    { name: 'channel', type: 7, description: 'Channel', required: true },
    { name: 'prize', type: 3, description: 'Prize', required: true },
    { name: 'minutes', type: 4, description: 'Duration (minutes)', required: true },
    { name: 'winners', type: 4, description: 'Winners', required: true },
  ]},
  { name: 'punish', description: '[SHR] Punish user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'type', type: 3, description: 'Type', required: true, choices: [{ name: 'Warn', value: 'warn' }, { name: 'Mute 10min', value: 'mute' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }] },
    { name: 'reason', type: 3, description: 'Reason', required: true },
  ]},
  { name: 'players', description: '[SHR] ERLC players' },
  { name: 'serverstatus', description: '[SHR] ERLC server status' },
  { name: 'erlckick', description: '[SHR] Kick ERLC player', options: [{ name: 'username', type: 3, description: 'Roblox username', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'erlcban', description: '[SHR] Ban ERLC player', options: [{ name: 'username', type: 3, description: 'Roblox username', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'trainrequest', description: 'Request a trainer (Trial Staff only)' },
  { name: 'erlcconfig', description: '[Setup] Set ERLC server key' },
  { name: 'setup', description: '[Setup] Configure bot features' },
];

// ════════════════════════════════════════════
// READY EVENT
// ════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | DB: ${dbReady ? '✅' : '❌'}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Commands registered');
  } catch (e) {
    console.error('❌ Command registration failed:', e);
  }
  for (const guild of client.guilds.cache.values()) {
    await updateCounters(guild).catch(console.error);
  }

  // ERLC Log Polling
  const erlcBansInitialized = new Map();

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const ec = getErlcLogConfig(guild.id);
        if (!ec.enabled) continue;
        if (!erlcState.has(guild.id)) {
          erlcState.set(guild.id, { players: new Set(), kills: new Set(), modCalls: new Set(), cmds: new Set(), bans: new Set() });
        }
        const state = erlcState.get(guild.id);

        if (ec.joinLeave) {
          const ch = guild.channels.cache.get(ec.joinLeave);
          if (ch) {
            const players = await erlcRequest('/server/players', 'GET', null, guild.id).catch(() => null);
            if (players) {
              const current = new Set(Object.keys(players));
              if (state.players.size > 0) {
                for (const id of current) {
                  if (!state.players.has(id)) {
                    const p = players[id];
                    await ch.send({ embeds: [new EmbedBuilder().setTitle('📥 Player Joined').setColor(0x57F287).addFields({ name: '👤 Player', value: p.Player, inline: true }, { name: '🎭 Team', value: p.Team || 'None', inline: true }).setTimestamp()] }).catch(() => {});
                  }
                }
                for (const id of state.players) {
                  if (!current.has(id)) {
                    await ch.send({ embeds: [new EmbedBuilder().setTitle('📤 Player Left').setColor(0xED4245).addFields({ name: '👤 Player', value: id, inline: true }).setTimestamp()] }).catch(() => {});
                  }
                }
              }
              state.players = current;
          } }
        }
        if (ec.kills) {
          const ch = guild.channels.cache.get(ec.kills);
          if (ch) {
            const kills = await erlcRequest('/server/killlogs', 'GET', null, guild.id).catch(() => null);
            if (kills) {
              for (const k of kills) {
                const key = `${k.Killer}-${k.Killed}-${k.Timestamp}`;
                if (!state.kills.has(key)) {
                  state.kills.add(key);
                  await ch.send({ embeds: [new EmbedBuilder().setTitle('💀 Kill Log').setColor(0xFF0000).addFields({ name: '🔫 Killer', value: k.Killer, inline: true }, { name: '💀 Killed', value: k.Killed, inline: true }, { name: '🗡️ Weapon', value: k.Weapon || 'Unknown', inline: true }).setTimestamp()] }).catch(() => {});
                }
              }
              if (state.kills.size > 500) state.kills = new Set([...state.kills].slice(-200));
            }
          }
        }
        if (ec.cmds) {
          const ch = guild.channels.cache.get(ec.cmds);
          if (ch) {
            const cmds = await erlcRequest('/server/commandlogs', 'GET', null, guild.id).catch(() => null);
            if (cmds) {
              for (const c of cmds) {
                const key = `${c.Player}-${c.Command}-${c.Timestamp}`;
                if (!state.cmds.has(key)) {
                  state.cmds.add(key);
                  await ch.send({ embeds: [new EmbedBuilder().setTitle('⌨️ Command Log').setColor(0x5865F2).addFields({ name: '👤 Player', value: c.Player, inline: true }, { name: '💬 Command', value: c.Command || 'Unknown', inline: false }).setTimestamp()] }).catch(() => {});
                }
              }
              if (state.cmds.size > 500) state.cmds = new Set([...state.cmds].slice(-200));
            }
          }
        }
        if (ec.modCall) {
          const ch = guild.channels.cache.get(ec.modCall);
          if (ch) {
            const modcalls = await erlcRequest('/server/modcalls', 'GET', null, guild.id).catch(() => null);
            if (modcalls) {
              for (const m of modcalls) {
                const key = `${m.Caller}-${m.Timestamp}`;
                if (!state.modCalls.has(key)) {
                  state.modCalls.add(key);
                  await ch.send({ embeds: [new EmbedBuilder().setTitle('🚨 Mod Call').setColor(0xFEE75C).addFields({ name: '📞 Caller', value: m.Caller, inline: true }, { name: '🛡️ Responder', value: m.Responder || '*No responder yet*', inline: true }).setTimestamp()] }).catch(() => {});
                }
              }
              if (state.modCalls.size > 500) state.modCalls = new Set([...state.modCalls].slice(-200));
            }
          }
        }
        if (ec.kickBans) {
          const ch = guild.channels.cache.get(ec.kickBans);
          if (ch) {
            const bans = await erlcRequest('/server/bans', 'GET', null, guild.id).catch(() => null);
            if (bans) {
              if (!erlcBansInitialized.get(guild.id)) {
                for (const b of Object.keys(bans)) state.bans.add(b);
                erlcBansInitialized.set(guild.id, true);
              } else {
                for (const b of Object.keys(bans)) {
                  if (!state.bans.has(b)) {
                    state.bans.add(b);
                    const ban = bans[b];
                    await ch.send({ embeds: [new EmbedBuilder().setTitle('🔨 Ban Log').setColor(0xFF0000).addFields({ name: '👤 Player', value: ban.UserName || b, inline: true }, { name: '👮 By', value: ban.moderatorName || 'Unknown', inline: true }, { name: '📝 Reason', value: ban.Reason || '*No reason*', inline: false }).setTimestamp()] }).catch(() => {});
                  }
                }
              }
            }
          }
        }
      } catch {}
    }
  }, 30000);
});

// ════════════════════════════════════════════
// GUILD MEMBER EVENTS
// ════════════════════════════════════════════
client.on('guildMemberAdd', async member => {
  await updateCounters(member.guild).catch(console.error);
  // Autorole
  try {
    const ar = getAutoroleConfig(member.guild.id);
    if (ar.enabled && ar.roles.length) {
      const roles = ar.roles.map(id => member.guild.roles.cache.get(id)).filter(Boolean);
      if (roles.length) await member.roles.add(roles);
    }
  } catch (e) { console.error('Autorole error:', e); }
  // Welcomer
  try {
    const wc = getWelcomerConfig(member.guild.id);
    if (!wc.enabled || !wc.channel) return;
    const ch = member.guild.channels.cache.get(wc.channel);
    if (!ch) return;
    const vars = {
      userMention: `<@${member.user.id}>`,
      username: member.user.username,
      userTag: member.user.tag,
      memberCount: member.guild.memberCount.toString(),
      server: member.guild.name
    };
    const embed = new EmbedBuilder()
      .setTitle(replaceVars(wc.title, vars))
      .setDescription(replaceVars(wc.description, vars))
      .setColor(hexToInt(wc.color))
      .setTimestamp();
    if (wc.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
    if (wc.image) embed.setImage(wc.image);
    if (wc.footer) embed.setFooter({ text: replaceVars(wc.footer, vars) });
    await ch.send({ content: wc.pingUser ? `<@${member.user.id}>` : undefined, embeds: [embed] });
  } catch (e) { console.error('Welcomer error:', e); }
});

client.on('guildMemberRemove', async member => {
  await updateCounters(member.guild).catch(console.error);
});

// ════════════════════════════════════════════
// DM MESSAGE HANDLER (Application Q&A)
// ════════════════════════════════════════════
client.on('messageCreate', async message => {
  if (message.author.bot || message.guild) return;
  const userId = message.author.id;
  const session = activeAppSessions.get(userId);
  if (!session) return;
  const content = message.content.trim();
  if (content.toLowerCase() === 'cancel') {
    activeAppSessions.delete(userId);
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Application Cancelled').setDescription('Your application has been cancelled.')] });
    return;
  }
  const ac = getApplicationConfig(session.guildId);
  const appType = ac.appTypes.find(t => t.id === session.typeId);
  if (!appType) {
    activeAppSessions.delete(userId);
    await message.channel.send('❌ This application type no longer exists.');
    return;
  }
  if (content.length > 12000) {
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Answer too long! Max 12,000 characters.`)] });
    return;
  }
  session.answers.push(content);
  const nextIndex = session.questionIndex + 1;
  if (nextIndex < appType.questions.length) {
    session.questionIndex = nextIndex;
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('✅ **Answer recorded!**').setFooter({ text: `${nextIndex}/${appType.questions.length} answered` })] });
    const sent = await sendNextQuestion(userId, session, appType);
    if (!sent) activeAppSessions.delete(userId);
  } else {
    activeAppSessions.delete(userId);
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('⏳ Submitting…').setDescription('All questions answered! Submitting your application…')] });
    try {
      const guild = await client.guilds.fetch(session.guildId).catch(() => null);
      if (!guild) throw new Error('Server not found.');
      const appId = await submitApplication(userId, session, appType, guild);
      await message.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Application Submitted!').setColor(0x57F287).setDescription(`Your **${appType.label}** application has been submitted!\n\n**Application ID:** \`${appId}\``).setTimestamp()] });
      const logChId = ac.logChannel;
      if (logChId) {
        const logCh = guild.channels.cache.get(logChId);
        if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('📋 Application Submitted').setColor(0x5865F2).addFields({ name: '👤 Applicant', value: `<@${userId}>`, inline: true }, { name: '📝 Type', value: appType.label, inline: true }, { name: '🆔 App ID', value: appId, inline: true }).setTimestamp()] });
      }
    } catch (e) {
      console.error('App submit error:', e);
      await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Submission Failed').setDescription(`Could not submit: **${e.message}**`)] });
    }
  }
});

// ════════════════════════════════════════════
// AUTOMOD
// ════════════════════════════════════════════
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const am = getAutomodConfig(guildId);
  if (!am.enabled || !am.keywords.length) return;
  const member = message.member;
  if (!member) return;
  if (hasAnyStaff(member) || member.permissions.has(PermissionFlagsBits.Administrator)) return;
  const content = message.content.toLowerCase();
  const triggered = am.keywords.find(kw => content.includes(kw.toLowerCase()));
  if (!triggered) return;
  try {
    await message.delete().catch(() => {});
    const logEmbed = new EmbedBuilder().setTitle('🛡️ Automod Triggered').setColor(0xED4245)
      .addFields(
        { name: '👤 User', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
        { name: '📢 Channel', value: `<#${message.channel.id}>`, inline: true },
        { name: '🚫 Keyword', value: `\`${triggered}\``, inline: true },
        { name: '💬 Message', value: message.content.slice(0, 1024) || '*empty*', inline: false },
        { name: '⚙️ Action', value: am.action || 'delete', inline: true },
      ).setTimestamp();
    if (am.action === 'delete+warn') {
      await addWarning(guildId, message.author.id, { reason: `Automod: keyword "${triggered}"`, moderator: 'Automod', date: new Date().toUTCString() });
      logEmbed.addFields({ name: '⚠️ Warning', value: `Total: ${getWarnings(guildId, message.author.id).length}`, inline: true });
      await message.author.send(`⚠️ You received a warning in **${message.guild.name}** for using a forbidden word.`).catch(() => {});
    } else if (am.action === 'delete+mute') {
      const mins = am.muteMinutes ?? 5;
      await member.timeout(mins * 60000, `Automod: keyword "${triggered}"`).catch(() => {});
      logEmbed.addFields({ name: '🔇 Muted', value: `${mins} minutes`, inline: true });
      await message.author.send(`🔇 You were muted for **${mins} minutes** in **${message.guild.name}**.`).catch(() => {});
    }
    if (am.logChannel) {
      const logCh = message.guild.channels.cache.get(am.logChannel);
      if (logCh) await logCh.send({ embeds: [logEmbed] });
    }
  } catch (e) { console.error('Automod error:', e); }
});

// ════════════════════════════════════════════
// REACTION EVENTS (Self Roles)
// ════════════════════════════════════════════
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    const guild = reaction.message.guild;
    if (!guild) return;
    const src = getSelfRoleConfig(guild.id);
    let targetPanel = null, targetRole = null;
    for (const [, panel] of Object.entries(src.panels)) {
      if (panel.type === 'reaction' && panel.messageId === reaction.message.id) {
        for (const role of panel.roles) {
          if (role.reaction && role.reaction === reaction.emoji.toString()) {
            targetPanel = panel;
            targetRole = role;
            break;
          }
        }
        if (targetRole) break;
      }
    }
    if (!targetRole) return;
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(targetRole.id);
    if (!role) return;
    if (targetPanel.max > 0) {
      const count = targetPanel.roles.filter(r => member.roles.cache.has(r.id)).length;
      if (count >= targetPanel.max && !member.roles.cache.has(role.id)) {
        await reaction.users.remove(user.id).catch(() => {});
        return user.send(`❌ Max ${targetPanel.max} role(s).`).catch(() => {});
      }
    }
    await member.roles.add(role).catch(() => {});
  } catch (e) { console.error('Reaction add error:', e); }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    const guild = reaction.message.guild;
    if (!guild) return;
    const src = getSelfRoleConfig(guild.id);
    let targetRole = null;
    for (const [, panel] of Object.entries(src.panels)) {
      if (panel.type === 'reaction' && panel.messageId === reaction.message.id) {
        for (const role of panel.roles) {
          if (role.reaction && role.reaction === reaction.emoji.toString()) {
            targetRole = role;
            break;
          }
        }
        if (targetRole) break;
      }
    }
    if (!targetRole) return;
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(targetRole.id);
    if (!role) return;
    await member.roles.remove(role).catch(() => {});
  } catch (e) { console.error('Reaction remove error:', e); }
});

// ════════════════════════════════════════════
// SETUP PAYLOAD BUILDERS (Compact)
// ════════════════════════════════════════════
function buildMainSetupMenu(guildId) {
  const stc = getServerTypeConfig(guildId);
  const typeLabel = stc.type === 'main' ? '🏠 Main Server' : stc.type === 'department' ? '🏢 Department' : '🔧 Standalone';
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Bot Setup')
    .setColor(0x5865F2)
    .setDescription(`**Server Type:** ${typeLabel}\n**Staff Role:** \`${getStaffRoleName(guildId)}\`\n**SHR Role:** \`${getSHRRoleName(guildId)}\`\n\nSelect a category:`)
    .addFields(
      stc.type === 'main' ? { name: '🏠 Departments', value: `${stc.departments?.length ?? 0} gekoppeld`, inline: true } : { name: '🔗 Main Server', value: stc.mainGuildId ? `\`${stc.mainGuildId}\`` : '*Not set*', inline: true },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_menu__moderation').setLabel('🛡️ Moderation').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__roles').setLabel('🎭 Roles & Perms').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__tickets').setLabel('🎫 Tickets').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__apps').setLabel('📋 Applications').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__sessions').setLabel('🎮 Sessions').setStyle(ButtonStyle.Secondary),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_menu__community').setLabel('👥 Community').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__erlc').setLabel('🚓 ER:LC').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_menu__server').setLabel('🏠 Server Type').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_menu__staffroles').setLabel('👮 Staff Roles').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildCategoryMenu(guildId, category) {
  const cats = {
    moderation: { title: '🛡️ Moderation Setup', color: 0xED4245, btns: [
      { id: 'setup__automod', label: '🛡️ Automod' }, { id: 'setup__training', label: '🎓 Training' },
      { id: 'setup__execrequest', label: '📋 Exec Request' }, { id: 'setup__founderrequest', label: '📋 Founder Request' },
    ]},
    roles: { title: '🎭 Roles & Permissions', color: 0xEB459E, btns: [
      { id: 'setup__selfroles', label: '🎨 Self Roles' }, { id: 'setup__autorole', label: '🎭 Autorole' },
      { id: 'setup__roleperms', label: '🔐 Role Permissions' }, { id: 'setup__verification', label: '✅ Verification' },
      { id: 'setup__commandlist', label: '📜 Command List' },
    ]},
    tickets: { title: '🎫 Tickets', color: 0x5865F2, btns: [{ id: 'setup__tickets', label: '🎫 Ticket System' }] },
    apps: { title: '📋 Applications', color: 0x5865F2, btns: [{ id: 'setup__applications', label: '📋 Applications' }] },
    sessions: { title: '🎮 Sessions', color: 0x57F287, btns: [
      { id: 'setup__sessions', label: '🎮 Session System' }, { id: 'setup__handbooks', label: '📚 Handbooks' },
    ]},
    community: { title: '👥 Community', color: 0xEB459E, btns: [
      { id: 'setup__welcomer', label: '👋 Welcomer' }, { id: 'setup__announcements', label: '📣 Announcements' },
      { id: 'setup__savedmessages', label: '💾 Saved Messages' }, { id: 'setup__counters', label: '📊 Counters' },
    ]},
    erlc: { title: '🚓 ER:LC', color: 0x00E5A0, btns: [{ id: 'setup__erlclogs', label: '📡 ERLC Logs' }] },
    server: { title: '🏠 Server Type', color: 0x5865F2, btns: [
      { id: 'setup_servertype__main', label: '🏠 Main Server', style: ButtonStyle.Success },
      { id: 'setup_servertype__department', label: '🏢 Department', style: ButtonStyle.Primary },
      { id: 'setup_servertype__standalone', label: '🔧 Standalone', style: ButtonStyle.Secondary },
      { id: 'setup_dept__manage', label: '📋 Manage Departments', style: ButtonStyle.Primary },
    ]},
    staffroles: { title: '👮 Staff Roles', color: 0x5865F2, btns: [
      { id: 'setup_staffroles__staff', label: '👮 Staff Role Name' },
      { id: 'setup_staffroles__shr', label: '⭐ SHR Role Name' },
      { id: 'setup_staffroles__setup', label: '🔧 Setup Role ID' },
      { id: 'setup_staffroles__reset', label: '🔄 Reset to Default', style: ButtonStyle.Danger },
    ]},
  };
  const cat = cats[category];
  if (!cat) return buildMainSetupMenu(guildId);
  const embed = new EmbedBuilder().setTitle(cat.title).setColor(cat.color).setDescription('Select an option:');
  const rows = [];
  for (let i = 0; i < cat.btns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      cat.btns.slice(i, i+5).map(b => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style || ButtonStyle.Primary))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_menu__back').setLabel('← Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral };
}

function buildDepartmentManager(guildId) {
  const stc = getServerTypeConfig(guildId);
  const depts = stc.departments ?? [];
  const deptList = depts.length
    ? depts.map((d, i) => `**${i+1}.** ${d.name} \`${d.guildId}\`\nAnnounce: ${d.announcementChannel ? `<#${d.announcementChannel}>` : '❌'} | Ping: ${d.pingRoles?.length ? d.pingRoles.map(r => `<@&${r}>`).join(', ') : 'None'}`).join('\n\n')
    : '*No departments linked*';
  const embed = new EmbedBuilder()
    .setTitle('📋 Department Manager')
    .setColor(0x5865F2)
    .setDescription(`**Server Type:** ${stc.type === 'main' ? '🏠 Main Server' : '⚠️ First set as **Main Server**'}\n\n${deptList}`)
    .setFooter({ text: 'Add department servers via their Guild ID' });
  const btns = [new ButtonBuilder().setCustomId('setup_dept__add').setLabel('➕ Add Department').setStyle(ButtonStyle.Success)];
  if (depts.length) {
    btns.push(new ButtonBuilder().setCustomId('setup_dept__remove').setLabel('➖ Remove').setStyle(ButtonStyle.Danger));
    btns.push(new ButtonBuilder().setCustomId('setup_dept__configure').setLabel('⚙️ Configure').setStyle(ButtonStyle.Primary));
  }
  btns.push(new ButtonBuilder().setCustomId('setup_menu__back').setLabel('← Back').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}

// More setup builders (compact versions)
function buildRolePermsSetupPayload(guildId) {
  const rp = getRolePermConfig(guildId);
  const entries = Object.entries(rp);
  const fieldVal = entries.length ? entries.map(([roleId, perms]) => `<@&${roleId}>\n  ➕ Add: ${perms.addRoles?.length ? perms.addRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}\n  ➖ Remove: ${perms.removeRoles?.length ? perms.removeRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`).join('\n\n') : '*No role permissions set*';
  const embed = new EmbedBuilder().setTitle('🔐 Role Permissions Setup').setColor(0x5865F2).setDescription('Set which roles are required to add or remove specific roles.\n\n' + fieldVal);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('rperms__add').setLabel('Configure Role').setStyle(ButtonStyle.Primary).setEmoji('🔐'), new ButtonBuilder().setCustomId('rperms__clear').setLabel('Clear All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildTicketSetupPayload(guildId) {
  const tc = getTicketConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🎫 Ticket System Setup').setColor(0x5865F2).setDescription('Configure the ticket system below.')
    .addFields(
      { name: '📢 Ping Roles', value: tc.pingRoles.length ? tc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '📋 Transcript Ch.', value: tc.transcriptChannel ? `<#${tc.transcriptChannel}>` : '*Not set*', inline: true },
      { name: '📬 Panel Channel', value: tc.ticketChannel ? `<#${tc.ticketChannel}>` : '*Not set*', inline: true },
      { name: '📁 Category', value: tc.ticketCategory ? `<#${tc.ticketCategory}>` : '*Not set*', inline: true },
      { name: '🏷️ Ticket Types', value: tc.ticketTypes.length ? tc.ticketTypes.map(t => `${t.emoji || '•'} \`${t.label}\``).join('\n') : '*No types yet*', inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_ping_roles').setLabel('Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('t_transcript').setLabel('Transcript Ch.').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('t_channel').setLabel('Panel Channel').setStyle(ButtonStyle.Primary).setEmoji('📬'),
    new ButtonBuilder().setCustomId('t_category').setLabel('Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_panel_embed').setLabel('Panel Embed').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
    new ButtonBuilder().setCustomId('t_welcome').setLabel('Welcome Text').setStyle(ButtonStyle.Primary).setEmoji('💬'),
    new ButtonBuilder().setCustomId('t_add_type').setLabel('Add Type').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('t_remove_type').setLabel('Remove Type').setStyle(ButtonStyle.Danger).setEmoji('➖'),
    new ButtonBuilder().setCustomId('t_type_roles').setLabel('Type Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
  );
  const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_deploy').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'));
  return { embeds: [embed], components: [r1, r2, r3], flags: MessageFlags.Ephemeral };
}

function buildSessionSetupPayload(guildId) {
  const sc = getSessionConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🎮 Session System Setup').setColor(0x57F287)
    .setDescription('**Variables:** `{host}` `{hostMention}` `{time}` `{date}` `{memberCount}` `{server}`')
    .addFields(
      { name: '📢 Channel', value: sc.channel ? `<#${sc.channel}>` : '*Not set*', inline: true },
      { name: '👥 Ping Roles', value: sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔑 Allowed', value: sc.allowedRoles?.length ? sc.allowedRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔗 Join Link', value: sc.joinLink ?? '*Not set*', inline: false },
      { name: '🗳️ Vote Threshold', value: `**${sc.voteThreshold ?? 5}** votes needed`, inline: true },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('s_channel').setLabel('Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('s_ping_roles').setLabel('Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('s_allowed_roles').setLabel('Allowed Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('s_join_link').setLabel('Join Link').setStyle(ButtonStyle.Primary).setEmoji('🔗'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('s_descriptions').setLabel('Descriptions').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('s_images').setLabel('Images').setStyle(ButtonStyle.Primary).setEmoji('🖼️'),
    new ButtonBuilder().setCustomId('s_vote_threshold').setLabel('Vote Threshold').setStyle(ButtonStyle.Primary).setEmoji('🗳️'),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildVerificationSetupPayload(guildId) {
  const vc = getVerificationConfig(guildId);
  const embed = new EmbedBuilder().setTitle('✅ Verification Setup').setColor(0x57F287)
    .setDescription('Roblox verification.')
    .addFields(
      { name: '✅ Enabled', value: vc.enabled ? 'Yes' : 'No', inline: true },
      { name: '📢 Channel', value: vc.channel ? `<#${vc.channel}>` : '*Not set*', inline: true },
      { name: '🎭 Verified Role', value: vc.verifiedRole ? `<@&${vc.verifiedRole}>` : '*Not set*', inline: true },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_channel').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('vc_role').setLabel('Set Verified Role').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
    new ButtonBuilder().setCustomId('vc_content').setLabel('Edit Panel').setStyle(ButtonStyle.Primary).setEmoji('📝'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_deploy').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('vc_toggle').setLabel(vc.enabled ? 'Disable' : 'Enable').setStyle(vc.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(vc.enabled ? '🔴' : '🟢'),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildApplicationSetupPayload(guildId) {
  const ac = getApplicationConfig(guildId);
  const typeList = ac.appTypes.length ? ac.appTypes.map(t => `${t.emoji || '•'} \`${t.label}\` — **${t.questions?.length ?? 0}** questions`).join('\n') : '*No types yet*';
  const panelList = ac.panels.length ? ac.panels.map((p, i) => `**Panel ${i + 1}:** \`${p.name}\` → Types: ${p.appTypeIds.length}`).join('\n') : '*No panels yet*';
  const embed = new EmbedBuilder().setTitle('📋 Application System Setup').setColor(0x5865F2).setDescription('Applications handled in DMs — one question at a time.')
    .addFields(
      { name: '📢 Review Channel', value: ac.reviewChannel ? `<#${ac.reviewChannel}>` : '*Not set*', inline: true },
      { name: '📋 Log Channel', value: ac.logChannel ? `<#${ac.logChannel}>` : '*Not set*', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '📝 Types', value: typeList, inline: false },
      { name: '🖼️ Panels', value: panelList, inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ap_review_channel').setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'), new ButtonBuilder().setCustomId('ap_log_channel').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'));
  const r2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ap_add_type').setLabel('Add Type').setStyle(ButtonStyle.Success).setEmoji('➕'), new ButtonBuilder().setCustomId('ap_edit_type').setLabel('Edit Type').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('ap_remove_type').setLabel('Remove Type').setStyle(ButtonStyle.Danger).setEmoji('➖'));
  const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ap_add_panel').setLabel('Add Panel').setStyle(ButtonStyle.Success).setEmoji('🖼️'), new ButtonBuilder().setCustomId('ap_edit_panel').setLabel('Edit Panel').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('ap_remove_panel').setLabel('Remove Panel').setStyle(ButtonStyle.Danger).setEmoji('🗑️'), new ButtonBuilder().setCustomId('ap_deploy_panel').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'));
  return { embeds: [embed], components: [r1, r2, r3], flags: MessageFlags.Ephemeral };
}

// ════════════════════════════════════════════
// INTERACTION HANDLER (Main)
// ════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;
  if (!guildId) {
    try {
      if (interaction.isRepliable()) await interaction.reply({ content: '❌ Server only.', flags: MessageFlags.Ephemeral });
    } catch {}
    return;
  }

  try {
    // User Context Menu - Roblox Profile
    if (interaction.isUserContextMenuCommand() && interaction.commandName === 'Roblox Profile') {
      const targetUser = interaction.targetUser;
      const vc = getVerificationConfig(guildId);
      const data = vc.verifiedUsers?.[targetUser.id];
      if (!data) return interaction.reply({ content: `❌ **${targetUser.username}** has not verified their Roblox account.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🎮 Roblox Profile').setColor(0x5865F2)
          .setThumbnail(`https://www.roblox.com/headshot-thumbnail/image?userId=${data.robloxId}&width=420&height=420&format=png`)
          .addFields(
            { name: '👤 Discord', value: `<@${targetUser.id}>`, inline: true },
            { name: '🎮 Roblox', value: data.robloxUsername, inline: true },
            { name: '🆔 Roblox ID', value: `${data.robloxId}`, inline: true },
          ).setTimestamp()],
        flags: MessageFlags.Ephemeral
      });
    }

    // Slash Commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const user = interaction.options.getUser('user') ?? null;
      const member = user ? interaction.options.getMember('user') : null;
      const reason = interaction.options.getString('reason') ?? 'No reason provided';

      // Basic commands
      if (cmd === 'ping') {
        const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
        return interaction.editReply(`🏓 Pong! Bot: ${sent.createdTimestamp - interaction.createdTimestamp}ms | API: ${client.ws.ping}ms`);
      }
      if (cmd === 'avatar') {
        const t = interaction.options.getUser('user') ?? interaction.user;
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🖼️ ${t.username}'s Avatar`).setImage(t.displayAvatarURL({ size: 1024, dynamic: true })).setColor(0x5865F2)] });
      }
      if (cmd === 'serverinfo') {
        const g = interaction.guild;
        await g.fetch();
        const owner = await g.fetchOwner();
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📊 ${g.name}`).setThumbnail(g.iconURL({ dynamic: true })).setColor(0x5865F2).addFields(
          { name: '👑 Owner', value: owner.user.tag, inline: true },
          { name: '👥 Members', value: `${g.memberCount}`, inline: true },
          { name: '📅 Created', value: g.createdAt.toDateString(), inline: true },
          { name: '💬 Channels', value: `${g.channels.cache.size}`, inline: true },
          { name: '🎭 Roles', value: `${g.roles.cache.size}`, inline: true },
        ).setTimestamp()] });
      }
      if (cmd === 'roleinfo') {
        const role = interaction.options.getRole('role');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🎭 ${role.name}`).setColor(role.color || 0x5865F2).addFields(
          { name: '🆔 ID', value: role.id, inline: true },
          { name: '🎨 Color', value: role.hexColor, inline: true },
          { name: '👥 Members', value: `${role.members.size}`, inline: true },
        ).setTimestamp()] });
      }
      if (cmd === 'poll') {
        const question = interaction.options.getString('question');
        const opts = [interaction.options.getString('option1'), interaction.options.getString('option2'), interaction.options.getString('option3'), interaction.options.getString('option4')].filter(Boolean);
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const embed = new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(opts.map((o, i) => `${emojis[i]} ${o}`).join('\n\n')).setColor(0x5865F2).setFooter({ text: `Poll by ${interaction.user.tag}` }).setTimestamp();
        const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
        for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]);
      }
      if (cmd === 'userinfo') {
        const tu = interaction.options.getUser('user');
        const tm = interaction.options.getMember('user');
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [new EmbedBuilder().setTitle(`👤 ${tu.tag}`).setThumbnail(tu.displayAvatarURL({ dynamic: true })).setColor(0x5865F2).addFields(
            { name: '🆔 ID', value: tu.id, inline: true },
            { name: '📅 Created', value: tu.createdAt.toDateString(), inline: true },
            { name: '📥 Joined', value: tm?.joinedAt?.toDateString() ?? 'Unknown', inline: true },
            { name: '🎭 Roles', value: tm?.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None', inline: false },
          ).setTimestamp()],
        });
      }
      if (cmd === 'warn') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await addWarning(guildId, user.id, { reason, moderator: interaction.user.tag, date: new Date().toUTCString() });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⚠️ Warning Issued').setColor(0xFEE75C).addFields(
          { name: 'User', value: user.tag, inline: true },
          { name: 'Warnings', value: `${getWarnings(guildId, user.id).length}`, inline: true },
          { name: 'Reason', value: reason },
        ).setTimestamp()] });
      }
      if (cmd === 'mute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await member.timeout(interaction.options.getInteger('minutes') * 60000, reason);
        return interaction.reply(`🔇 **${user.tag}** muted. Reason: ${reason}`);
      }
      if (cmd === 'unmute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await member.timeout(null);
        return interaction.reply(`🔊 **${user.tag}** unmuted.`);
      }
      if (cmd === 'slowmode') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        const s = interaction.options.getInteger('seconds');
        await interaction.channel.setRateLimitPerUser(s);
        return interaction.reply(`✅ Slowmode: **${s}s**.`);
      }
      if (cmd === 'lock') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        return interaction.reply('🔒 Channel **locked**.');
      }
      if (cmd === 'unlock') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: true });
        return interaction.reply('🔓 Channel **unlocked**.');
      }
      if (cmd === 'clear') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const del = await interaction.channel.bulkDelete(Math.min(interaction.options.getInteger('amount'), 100), true);
        return interaction.editReply({ content: `✅ Deleted **${del.size}** messages.` });
      }
      if (cmd === 'close') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.channel;
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        pendingCloseReqs.delete(ch.id);
        await interaction.reply({ content: `🔒 Ticket closed by **${interaction.user.tag}**. Deleting in 3 seconds...` });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
      }
      if (cmd === 'closerequest') {
        const ch = interaction.channel;
        if (pendingCloseReqs.has(ch.id)) return interaction.reply({ content: '❌ A close request is already pending.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🔒 Close Request').setDescription(`**${interaction.user.tag}** has requested to close this ticket.\n\nStaff can accept or deny below.`).setColor(0xFEE75C).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('closereq__accept').setLabel('Accept & Close').setStyle(ButtonStyle.Danger).setEmoji('✅'),
          new ButtonBuilder().setCustomId('closereq__deny').setLabel('Deny').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
        );
        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        pendingCloseReqs.set(ch.id, { requesterId: interaction.user.id, messageId: msg.id });
      }
      if (cmd === 'trainrequest') {
        const tc = getTrainingConfig(guildId);
        if (tc.requestRoles.length && !tc.requestRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: '❌ You do not have permission to request a trainer.', flags: MessageFlags.Ephemeral });
        }
        const cdKey = `${guildId}:${interaction.user.id}`;
        const lastUsed = trainRequestCooldowns.get(cdKey);
        if (lastUsed) {
          const remaining = 60 * 60 * 1000 - (Date.now() - lastUsed);
          if (remaining > 0) {
            const mins = Math.ceil(remaining / 60000);
            return interaction.reply({ content: `⏳ You can request a trainer again in **${mins} minute${mins !== 1 ? 's' : ''}**.`, flags: MessageFlags.Ephemeral });
          }
        }
        if (!tc.channel) return interaction.reply({ content: '❌ Training request channel not set up. Ask an admin to use `/setup`.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_trainrequest').setTitle('Training Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_times').setLabel('When are you available? (times/timezone)').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Monday 5-8PM EST').setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_notes').setLabel('Anything else the trainer should know?').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }
      if (cmd === 'send') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_send').setTitle('Send Message');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('send_content').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
        return interaction.showModal(modal);
      }
      if (cmd === 'ban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        let deletedMessages = 0, deletedThreads = 0;
        try {
          for (const [, ch] of interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)) {
            try {
              const msgs = await ch.messages.fetch({ limit: 100 });
              const userMsgs = msgs.filter(m => m.author.id === user.id);
              if (userMsgs.size > 0) {
                await ch.bulkDelete(userMsgs, true).catch(async () => { for (const [, m] of userMsgs) await m.delete().catch(() => {}); });
                deletedMessages += userMsgs.size;
              }
            } catch {}
          }
          for (const [, thread] of interaction.guild.channels.cache.filter(c => [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(c.type))) {
            try { if (thread.ownerId === user.id) { await thread.delete().catch(() => {}); deletedThreads++; } } catch {}
          }
        } catch (e) { console.error('Ban cleanup error:', e); }
        await interaction.guild.members.ban(user, { reason, deleteMessageSeconds: 604800 });
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔨 User Banned').setColor(0xED4245).addFields(
          { name: 'User', value: user.tag, inline: true },
          { name: 'Reason', value: reason, inline: true },
          { name: '🗑️ Messages', value: `${deletedMessages}`, inline: true },
          { name: '🧵 Threads', value: `${deletedThreads}`, inline: true },
        ).setTimestamp()] });
      }
      if (cmd === 'unban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const uid = interaction.options.getString('userid');
        await interaction.guild.members.unban(uid, reason);
        return interaction.reply(`✅ **${uid}** unbanned.`);
      }
      if (cmd === 'softban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.guild.members.ban(user, { reason, deleteMessageSeconds: 604800 });
        await interaction.guild.members.unban(user.id, 'Softban');
        return interaction.reply(`🪃 **${user.tag}** softbanned.`);
      }
      if (cmd === 'tempban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const hours = interaction.options.getInteger('hours');
        await interaction.guild.members.ban(user, { reason });
        setTimeout(async () => { await interaction.guild.members.unban(user.id, 'Tempban expired').catch(() => {}); }, hours * 3600000);
        return interaction.reply(`⏱️ **${user.tag}** banned for **${hours} hours**.`);
      }
      if (cmd === 'kick') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await member.kick(reason);
        return interaction.reply(`👢 **${user.tag}** kicked.`);
      }
      if (cmd === 'addrole') {
        const role = interaction.options.getRole('role');
        const rp = getRolePermConfig(guildId);
        const perms = rp[role.id];
        const canAdd = perms?.addRoles?.length ? perms.addRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member) : hasSHR(interaction.member);
        if (!canAdd) return interaction.reply({ content: `❌ You do not have permission to add **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.add(role);
        await updateCommandListEmbed(interaction.guild);
        return interaction.reply(`✅ Added **${role.name}** to **${user.tag}**.`);
      }
      if (cmd === 'removerole') {
        const role = interaction.options.getRole('role');
        const rp = getRolePermConfig(guildId);
        const perms = rp[role.id];
        const canRemove = perms?.removeRoles?.length ? perms.removeRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member) : hasSHR(interaction.member);
        if (!canRemove) return interaction.reply({ content: `❌ You do not have permission to remove **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.remove(role);
        await updateCommandListEmbed(interaction.guild);
        return interaction.reply(`✅ Removed **${role.name}** from **${user.tag}**.`);
      }
      if (cmd === 'giveroles') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const rolesInput = interaction.options.getString('roles');
        const roleIds = rolesInput.match(/\d{17,20}/g) ?? [];
        if (!roleIds.length) return interaction.reply({ content: '❌ No valid role IDs or mentions found.', flags: MessageFlags.Ephemeral });
        const rp = getRolePermConfig(guildId);
        const added = [], denied = [], notFound = [];
        for (const roleId of roleIds) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (!role) { notFound.push(roleId); continue; }
          const perms = rp[roleId];
          const canAdd = perms?.addRoles?.length ? perms.addRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member) : hasSHR(interaction.member);
          if (!canAdd) { denied.push(role.name); continue; }
          await member.roles.add(role).catch(() => {});
          added.push(role.name);
        }
        let msg = '';
        if (added.length) msg += `✅ Added: **${added.join(', ')}**\n`;
        if (denied.length) msg += `❌ No permission: **${denied.join(', ')}**\n`;
        if (notFound.length) msg += `⚠️ Not found: **${notFound.join(', ')}**`;
        return interaction.reply({ content: msg.trim() });
      }
      if (cmd === 'nickname') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const nick = interaction.options.getString('nickname') ?? null;
        await member.setNickname(nick);
        return interaction.reply(nick ? `✅ Nickname set to **${nick}**.` : `✅ Nickname reset.`);
      }
      if (cmd === 'promote') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const role = interaction.options.getRole('role');
        if (member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ Already has **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.add(role, reason);
        await sendPromotionAnnounce(interaction.guild, user, role.name, interaction.user, 'promotion');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⬆️ User Promoted').setColor(0x57F287).addFields(
          { name: '👤 User', value: user.tag, inline: true },
          { name: '🎭 Role', value: role.name, inline: true },
          { name: '📝 Reason', value: reason, inline: false },
          { name: '👮 By', value: interaction.user.tag, inline: true },
        ).setTimestamp()] });
      }
      if (cmd === 'demote') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const role = interaction.options.getRole('role');
        if (!member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ Does not have **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.remove(role, reason);
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⬇️ User Demoted').setColor(0xED4245).addFields(
          { name: '👤 User', value: user.tag, inline: true },
          { name: '🎭 Role', value: role.name, inline: true },
          { name: '📝 Reason', value: reason, inline: false },
          { name: '👮 By', value: interaction.user.tag, inline: true },
        ).setTimestamp()] });
      }
      if (cmd === 'executiverequest') {
        const ec = getExecRequestConfig(guildId);
        if (!ec.channel) return interaction.reply({ content: '❌ Executive request channel not set up.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_execrequest').setTitle('Executive Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_action').setLabel('Action (e.g. Demotion / Termination)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_person').setLabel('Person concerned (name + rank)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
        );
        return interaction.showModal(modal);
      }
      if (cmd === 'foundationrequest') {
        const fc = getFounderRequestConfig(guildId);
        if (!fc.channel) return interaction.reply({ content: '❌ Foundership request channel not set up.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_founderrequest').setTitle('Foundership Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_action').setLabel('Action (e.g. Demotion / Termination)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_person').setLabel('Person concerned (name + rank)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
        );
        return interaction.showModal(modal);
      }
      if (cmd === 'erlcconfig') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const ec = getErlcLogConfig(guildId);
        const modal = new ModalBuilder().setCustomId('modal_erlcconfig').setTitle('ERLC Server Key');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('erlc_server_key').setLabel('ERLC Server Key').setStyle(TextInputStyle.Short).setValue(ec.serverKey || '').setRequired(true)));
        return interaction.showModal(modal);
      }
      if (cmd === 'warnings') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const warns = getWarnings(guildId, user.id);
        if (!warns.length) return interaction.reply({ content: '✅ No warnings.', flags: MessageFlags.Ephemeral });
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`⚠️ Warnings — ${user.tag}`).setColor(0xFEE75C).setDescription(warns.map((w, i) => `**${i+1}.** ${w.reason} — *${w.moderator}*`).join('\n'))] });
      }
      if (cmd === 'clearwarnings') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await clearWarnings(guildId, user.id);
        return interaction.reply(`✅ Cleared warnings for **${user.tag}**.`);
      }
      if (cmd === 'note') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await addNote(guildId, user.id, { text: interaction.options.getString('text'), moderator: interaction.user.tag, date: new Date().toUTCString() });
        return interaction.reply({ content: '✅ Note added.', flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'notes') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const notes = getNotes(guildId, user.id);
        if (!notes.length) return interaction.reply({ content: '📝 No notes.', flags: MessageFlags.Ephemeral });
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`📝 Notes — ${user.tag}`).setColor(0x5865F2).setDescription(notes.map((n, i) => `**${i+1}.** ${n.text} — *${n.moderator}*`).join('\n'))] });
      }
      if (cmd === 'announce') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ac = getAnnouncementConfig(guildId);
        const types = Object.entries(ac.types);
        if (!types.length) return interaction.reply({ content: '❌ No announcement types. Use `/setup`.', flags: MessageFlags.Ephemeral });
        pendingAnnounceChannel.set(interaction.user.id, interaction.channel.id);
        const sel = new StringSelectMenuBuilder().setCustomId('announce_pick').setPlaceholder('Select type...').addOptions(types.slice(0, 25).map(([tid, t]) => ({ label: `${t.emoji ? t.emoji+' ' : ''}${t.name}`.slice(0, 100), value: tid })));
        return interaction.reply({ content: '### 📣 Select announcement type', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'embed') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.options.getChannel('channel');
        const embed = new EmbedBuilder().setTitle(interaction.options.getString('title')).setDescription(interaction.options.getString('description')).setColor(hexToInt(interaction.options.getString('color') ?? '#5865F2'));
        const img = interaction.options.getString('image');
        const footer = interaction.options.getString('footer');
        if (img) embed.setImage(img);
        if (footer) embed.setFooter({ text: footer });
        await ch.send({ embeds: [embed] });
        return interaction.reply({ content: '✅ Sent!', flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'giveaway') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.options.getChannel('channel');
        const prize = interaction.options.getString('prize');
        const minutes = interaction.options.getInteger('minutes');
        const winners = interaction.options.getInteger('winners');
        const endsAt = new Date(Date.now() + minutes * 60000);
        const embed = new EmbedBuilder().setTitle('🎉 GIVEAWAY 🎉').setColor(0xEB459E).setDescription(`**Prize:** ${prize}\n\nReact with 🎉 to enter!\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>`).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp(endsAt);
        const msg = await ch.send({ embeds: [embed] });
        await msg.react('🎉');
        setTimeout(async () => {
          try {
            const gMsg = await ch.messages.fetch(msg.id);
            const reaction = gMsg.reactions.cache.get('🎉');
            if (!reaction) return;
            const users = await reaction.users.fetch();
            const entries = users.filter(u => !u.bot);
            if (!entries.size) return ch.send('🎉 No valid entries!');
            const picked = entries.random(Math.min(winners, entries.size));
            const winnerMentions = (Array.isArray(picked) ? picked : [picked]).map(u => `<@${u.id}>`).join(', ');
            await ch.send({ embeds: [new EmbedBuilder().setTitle('🎉 Giveaway Ended!').setColor(0xEB459E).setDescription(`**Prize:** ${prize}\n**Winners:** ${winnerMentions} 🎊`).setTimestamp()] });
          } catch (e) { console.error('Giveaway error:', e); }
        }, minutes * 60000);
        return interaction.reply({ content: '✅ Giveaway started!', flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'punish') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const t = interaction.options.getString('type');
        if (t === 'warn') { await addWarning(guildId, user.id, { reason, moderator: interaction.user.tag, date: new Date().toUTCString() }); return interaction.reply(`⚠️ **${user.tag}** warned.`); }
        if (t === 'mute') { await member.timeout(600000, reason); return interaction.reply(`🔇 **${user.tag}** muted 10min.`); }
        if (t === 'kick') { await member.kick(reason); return interaction.reply(`👢 **${user.tag}** kicked.`); }
        if (t === 'ban') { await interaction.guild.members.ban(user, { reason }); return interaction.reply(`🔨 **${user.tag}** banned.`); }
      }
      if (cmd === 'players') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const data = await erlcRequest('/server/players');
          const list = Object.values(data);
          if (!list.length) return interaction.editReply('No players.');
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`👥 Players (${list.length})`).setDescription(list.map((p, i) => `${i+1}. **${p.Player}** — ${p.Team || 'None'}`).join('\n').slice(0, 4000)).setColor(0x5865F2)] });
        } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }
      if (cmd === 'serverstatus') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const d = await erlcRequest('/server');
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🖥️ ERLC Status').setColor(0x57F287).addFields(
            { name: 'Name', value: d.Name || 'Unknown', inline: true },
            { name: 'Players', value: `${d.CurrentPlayers ?? 0}/${d.MaxPlayers ?? 0}`, inline: true },
            { name: 'Key', value: d.JoinKey || 'N/A', inline: true },
          ).setTimestamp()] });
        } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }
      if (cmd === 'erlckick') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const u = interaction.options.getString('username');
        try { await erlcRequest('/server/command', 'POST', { command: `:kick ${u}` }); return interaction.editReply(`✅ **${u}** kicked from ERLC.`); }
        catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }
      if (cmd === 'erlcban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const u = interaction.options.getString('username');
        try { await erlcRequest('/server/command', 'POST', { command: `:ban ${u}` }); return interaction.editReply(`✅ **${u}** banned from ERLC.`); }
        catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }
      if (cmd === 'session') {
        if (!canRunSession(interaction.member, guildId)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const stc = getServerTypeConfig(guildId);
        if (stc.type === 'department') return interaction.reply({ content: '❌ Department servers hebben geen session systeem. Sessions worden beheerd via de main server.', flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        const sc = getSessionConfig(guildId);
        if (!sc.channel) return interaction.reply({ content: '❌ Session channel not set.', flags: MessageFlags.Ephemeral });
        const sCh = interaction.guild.channels.cache.get(sc.channel);
        if (!sCh) return interaction.reply({ content: '❌ Session channel not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const vars = { userMention: `<@${interaction.user.id}>`, username: interaction.user.username, userTag: interaction.user.tag, memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
        if (sub === 'start') {
          const rawLink = interaction.options.getString('link') ?? sc.joinLink ?? null;
          try { await postSessionStart(interaction.guild, sc, interaction.user, rawLink, vars); return interaction.editReply({ content: '✅ Session started!' }); }
          catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
        }
        if (sub === 'vote') {
          const threshold = interaction.options.getInteger('votes') ?? sc.voteThreshold ?? 5;
          const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
          const embed = new EmbedBuilder().setTitle('🗳️ Session Vote!').setColor(0xFEE75C).setDescription(`${replaceVars(sc.voteDescription ?? '**{host}** wants to host a session!\n\nClick the button below to vote!', vars)}\n\n**Votes: 0/${threshold}**`).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.voteImage) embed.setImage(sc.voteImage);
          const voteRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('session__vote').setLabel('Vote ✅').setStyle(ButtonStyle.Success));
          const msg = await sCh.send({ content: ping ?? undefined, embeds: [embed], components: [voteRow] });
          activeVotes.set(guildId, { messageId: msg.id, channelId: sCh.id, hostId: interaction.user.id, threshold, joinLink: sc.joinLink ?? null, voters: [] });
          setTimeout(async () => { if (activeVotes.get(guildId)?.messageId === msg.id) { activeVotes.delete(guildId); await msg.delete().catch(() => {}); } }, 30 * 60 * 1000);
          return interaction.editReply({ content: `✅ Vote posted! Auto-starts at **${threshold}** votes.` });
        }
        if (sub === 'shutdown') {
          activeVotes.delete(guildId);
          const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
          const embed = new EmbedBuilder().setTitle('🔴 Session Ended!').setColor(0xED4245).setDescription(replaceVars(sc.shutdownDescription ?? 'The session has ended!', vars)).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.shutdownImage) embed.setImage(sc.shutdownImage);
          await sCh.send({ content: ping ?? undefined, embeds: [embed] });
          return interaction.editReply({ content: '✅ Shutdown posted!' });
        }
      }
      if (cmd === 'setup') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        return interaction.reply(buildMainSetupMenu(guildId));
      }
    }

    // BUTTONS
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Setup menu navigation
      if (id.startsWith('setup_menu__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cat = id.replace('setup_menu__', '');
        if (cat === 'back') return interaction.update(buildMainSetupMenu(guildId));
        return interaction.update(buildCategoryMenu(guildId, cat));
      }

      // Setup category buttons
      if (id.startsWith('setup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const sub = id.replace('setup__', '');
        if (sub === 'tickets')       return interaction.update(buildTicketSetupPayload(guildId));
        if (sub === 'sessions')      return interaction.update(buildSessionSetupPayload(guildId));
        if (sub === 'verification')  return interaction.update(buildVerificationSetupPayload(guildId));
        if (sub === 'applications')  return interaction.update(buildApplicationSetupPayload(guildId));
        if (sub === 'roleperms')     return interaction.update(buildRolePermsSetupPayload(guildId));
        if (sub === 'selfroles')     return interaction.reply({ content: '📝 Self Roles system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'automod')       return interaction.reply({ content: '🛡️ Automod system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'training')      return interaction.reply({ content: '🎓 Training system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'execrequest')   return interaction.reply({ content: '📋 Executive Request system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'founderrequest') return interaction.reply({ content: '📋 Foundership Request system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'welcomer')      return interaction.reply({ content: '👋 Welcomer system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'autorole')      return interaction.reply({ content: '🎭 Autorole system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'announcements') return interaction.reply({ content: '📣 Announcements system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'savedmessages') return interaction.reply({ content: '💾 Saved Messages system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'counters')      return interaction.reply({ content: '📊 Counters system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'erlclogs')      return interaction.reply({ content: '📡 ERLC Logs system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'handbooks')     return interaction.reply({ content: '📚 Handbooks system coming soon!', flags: MessageFlags.Ephemeral });
        if (sub === 'commandlist')   return interaction.reply({ content: '📜 Command List system coming soon!', flags: MessageFlags.Ephemeral });
      }

      // Server type buttons
      if (id.startsWith('setup_servertype__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const type = id.replace('setup_servertype__', '');
        const stc = getServerTypeConfig(guildId);
        stc.type = type;
        await saveConfig(config);
        const embed = new EmbedBuilder().setTitle('✅ Server Type Updated').setColor(0x57F287).setDescription(`Server type set to: **${type === 'main' ? '🏠 Main Server' : type === 'department' ? '🏢 Department' : '🔧 Standalone'}**`);
        if (type === 'department') {
          const modal = new ModalBuilder().setCustomId('modal_dept_mainid').setTitle('Main Server Guild ID');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('main_guild_id').setLabel('Guild ID van de main server').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('bijv. 1234567890123456789')));
          return interaction.showModal(modal);
        }
        return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_menu__server').setLabel('← Terug').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral });
      }

      // Department management
      if (id === 'setup_dept__manage') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        return interaction.update(buildDepartmentManager(guildId));
      }
      if (id === 'setup_dept__add') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const stc = getServerTypeConfig(guildId);
        if (stc.type !== 'main') return interaction.reply({ content: '❌ Stel deze server eerst in als **Main Server**.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_dept_add').setTitle('Department Toevoegen');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dept_guild_id').setLabel('Guild ID van de department server').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('bijv. 1234567890123456789')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dept_name').setLabel('Naam van het department').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('bijv. Police Department')),
        );
        return interaction.showModal(modal);
      }
      if (id === 'setup_dept__remove') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const stc = getServerTypeConfig(guildId);
        if (!stc.departments?.length) return interaction.reply({ content: '❌ Geen departments om te verwijderen.', flags: MessageFlags.Ephemeral });
        const sel = new StringSelectMenuBuilder().setCustomId('dept_remove_select').setPlaceholder('Selecteer department om te verwijderen...').addOptions(stc.departments.map((d, i) => ({ label: d.name, description: d.guildId, value: i.toString() })));
        return interaction.reply({ content: '### 🗑️ Welk department wil je verwijderen?', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
      }
      if (id === 'setup_dept__configure') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const stc = getServerTypeConfig(guildId);
        if (!stc.departments?.length) return interaction.reply({ content: '❌ Geen departments om te configureren.', flags: MessageFlags.Ephemeral });
        const sel = new StringSelectMenuBuilder().setCustomId('dept_configure_select').setPlaceholder('Selecteer department...').addOptions(stc.departments.map((d, i) => ({ label: d.name, description: d.guildId, value: i.toString() })));
        return interaction.reply({ content: '### ⚙️ Welk department wil je configureren?', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
      }

      // Staff roles buttons
      if (id.startsWith('setup_staffroles__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('setup_staffroles__', '');
        if (action === 'reset') {
          const stc = getServerTypeConfig(guildId);
          stc.staffRoleName = null; stc.shrRoleName = null; stc.setupRoleId = null;
          await saveConfig(config);
          return interaction.update(buildCategoryMenu(guildId, 'staffroles'));
        }
        const stc = getServerTypeConfig(guildId);
        const modal = new ModalBuilder().setCustomId(`modal_staffrole__${action}`).setTitle(action === 'staff' ? 'Staff Role Name' : action === 'shr' ? 'SHR Role Name' : 'Setup Role ID');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role_value').setLabel(action === 'setup' ? 'Setup Role ID (Discord Role ID)' : 'Role name (exact zoals in Discord)').setStyle(TextInputStyle.Short).setValue(action === 'staff' ? (stc.staffRoleName || DEFAULT_STAFF_ROLE) : action === 'shr' ? (stc.shrRoleName || DEFAULT_SHR_ROLE) : (stc.setupRoleId || DEFAULT_SETUP_ID)).setRequired(true)));
        return interaction.showModal(modal);
      }

      // Session vote button
      if (id === 'session__vote') {
        const voteData = activeVotes.get(guildId);
        if (!voteData || voteData.messageId !== interaction.message.id) return interaction.reply({ content: '❌ This vote is no longer active.', flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;
        if (voteData.voters.includes(userId)) return interaction.reply({ content: '❌ You have already voted!', flags: MessageFlags.Ephemeral });
        voteData.voters.push(userId);
        const count = voteData.voters.length;
        const threshold = voteData.threshold;
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0]).setDescription(interaction.message.embeds[0].description.replace(/\*\*Votes: \d+\/\d+\*\*/, `**Votes: ${count}/${threshold}**`));
        if (count >= threshold) {
          activeVotes.delete(guildId);
          const disabledRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('session__vote').setLabel(`✅ Vote Passed! (${count}/${threshold})`).setStyle(ButtonStyle.Success).setDisabled(true));
          await interaction.update({ embeds: [updatedEmbed.setTitle('✅ Vote Passed!').setColor(0x57F287)], components: [disabledRow] });
          const sc = getSessionConfig(guildId);
          const hostUser = await client.users.fetch(voteData.hostId).catch(() => ({ tag: 'Unknown', id: voteData.hostId }));
          const vars = { userMention: `<@${voteData.hostId}>`, username: hostUser.username ?? 'Unknown', userTag: hostUser.tag ?? 'Unknown', memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
          const voterMentions = voteData.voters.map(id => `<@${id}>`).join(' ');
          await postSessionStart(interaction.guild, sc, hostUser, voteData.joinLink, vars, voterMentions);
        } else {
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
        }
        return;
      }

      // Executive/Founder request approve/deny
      if (id.startsWith('req__approve__') || id.startsWith('req__deny__')) {
        const parts = id.split('__');
        const action = parts[1];
        const prefix = parts[2];
        const cfg = prefix === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        const required = cfg.requiredApprovals ?? 2;
        const canVote = cfg.approvalRoles?.length ? cfg.approvalRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member) : hasSetup(interaction.member);
        if (!canVote) return interaction.reply({ content: '❌ You do not have permission to approve or deny this request.', flags: MessageFlags.Ephemeral });
        const embed = interaction.message.embeds[0];
        if (!embed) return interaction.reply({ content: '❌ Could not find embed.', flags: MessageFlags.Ephemeral });
        const statusField = embed.fields.find(f => f.name === '📊 Status');
        if (statusField?.value !== '⏳ Pending') return interaction.reply({ content: '❌ This request has already been decided.', flags: MessageFlags.Ephemeral });
        const approvalsField = embed.fields.find(f => f.name?.startsWith('✅ Approvals'));
        const denialsField = embed.fields.find(f => f.name?.startsWith('❌ Denials'));
        const currentApprovals = approvalsField?.value === '*No approvals yet*' ? [] : approvalsField?.value.split('\n') ?? [];
        const currentDenials = denialsField?.value === '*No denials yet*' ? [] : denialsField?.value.split('\n') ?? [];
        const userTag = `${interaction.user.tag} (<@${interaction.user.id}>)`;
        if ([...currentApprovals, ...currentDenials].some(v => v.includes(interaction.user.id))) return interaction.reply({ content: '❌ You have already voted on this request.', flags: MessageFlags.Ephemeral });
        let newApprovals = currentApprovals;
        let newDenials = currentDenials;
        if (action === 'approve') newApprovals = [...currentApprovals, userTag];
        if (action === 'deny') newDenials = [...currentDenials, userTag];
        const approved = newApprovals.length >= required;
        const denied = newDenials.length >= required;
        const newStatus = approved ? '✅ Approved' : denied ? '❌ Denied' : '⏳ Pending';
        const newColor = approved ? 0x57F287 : denied ? 0xED4245 : (prefix === 'exec' ? 0x5865F2 : 0xFEE75C);
        const updatedEmbed = EmbedBuilder.from(embed)
          .setColor(newColor)
          .spliceFields(embed.fields.findIndex(f => f.name?.startsWith('✅ Approvals')), 1, { name: `✅ Approvals (${newApprovals.length}/${required})`, value: newApprovals.join('\n') || '*No approvals yet*', inline: false })
          .spliceFields(embed.fields.findIndex(f => f.name?.startsWith('❌ Denials')), 1, { name: `❌ Denials (${newDenials.length})`, value: newDenials.join('\n') || '*No denials yet*', inline: false })
          .spliceFields(embed.fields.findIndex(f => f.name === '📊 Status'), 1, { name: '📊 Status', value: newStatus, inline: false });
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req__approve__${prefix}__done`).setLabel('✅ Approve').setStyle(ButtonStyle.Success).setDisabled(approved || denied),
          new ButtonBuilder().setCustomId(`req__deny__${prefix}__done`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger).setDisabled(approved || denied),
        );
        await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });
        if (approved) await interaction.followUp({ content: `✅ **Request approved!** Required ${required} approvals reached.`, ephemeral: false }).catch(() => {});
        if (denied) await interaction.followUp({ content: `❌ **Request denied!** Required ${required} denials reached.`, ephemeral: false }).catch(() => {});
        return;
      }

      // Training claim buttons
      if (id.startsWith('tr__claim__') || id.startsWith('tr__unclaim__') || id.startsWith('tr__pass__') || id.startsWith('tr__fail__')) {
        const parts = id.split('__');
        const action = parts[1];
        const requestUserId = parts[2];
        const tc = getTrainingConfig(guildId);
        const isTrainer = tc.trainerRoles.length ? tc.trainerRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member) : hasSetup(interaction.member);
        if (!isTrainer) return interaction.reply({ content: '❌ Only trainers can interact with training requests.', flags: MessageFlags.Ephemeral });
        const embed = interaction.message.embeds[0];
        if (!embed) return interaction.reply({ content: '❌ Could not find embed.', flags: MessageFlags.Ephemeral });
        const statusField = embed.fields?.find(f => f.name === '📊 Status');
        if (statusField && (statusField.value === '✅ Passed' || statusField.value === '❌ Failed')) return interaction.reply({ content: '❌ This training has already been completed.', flags: MessageFlags.Ephemeral });
        const claimedField = embed.fields?.find(f => f.name === '✅ Claimed By');
        const currentClaims = claimedField?.value === '*No one yet*' ? [] : claimedField?.value?.split('\n') ?? [];
        if (action === 'claim') {
          if (currentClaims.some(c => c.includes(interaction.user.id))) return interaction.reply({ content: '❌ You have already claimed this request.', flags: MessageFlags.Ephemeral });
          currentClaims.push(`<@${interaction.user.id}> (${interaction.user.tag})`);
          const updatedEmbed = EmbedBuilder.from(embed).spliceFields(embed.fields.findIndex(f => f.name === '✅ Claimed By'), 1, { name: '✅ Claimed By', value: currentClaims.join('\n'), inline: false });
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
          return;
        }
        if (action === 'unclaim') {
          const newClaims = currentClaims.filter(c => !c.includes(interaction.user.id));
          if (newClaims.length === currentClaims.length) return interaction.reply({ content: '❌ You have not claimed this request.', flags: MessageFlags.Ephemeral });
          const updatedEmbed = EmbedBuilder.from(embed).spliceFields(embed.fields.findIndex(f => f.name === '✅ Claimed By'), 1, { name: '✅ Claimed By', value: newClaims.length ? newClaims.join('\n') : '*No one yet*', inline: false });
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
          return;
        }
        if (action === 'pass' || action === 'fail') {
          const passed = action === 'pass';
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`tr__claim__${requestUserId}__done`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__unclaim__${requestUserId}__done`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__pass__${requestUserId}__done`).setLabel('✅ Pass').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__fail__${requestUserId}__done`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          let updatedEmbed = EmbedBuilder.from(embed).setColor(passed ? 0x57F287 : 0xED4245);
          const statusIdx = embed.fields?.findIndex(f => f.name === '📊 Status');
          if (statusIdx !== undefined && statusIdx >= 0) {
            updatedEmbed = updatedEmbed.spliceFields(statusIdx, 1, { name: '📊 Status', value: passed ? '✅ Passed' : '❌ Failed', inline: false });
          } else {
            updatedEmbed = updatedEmbed.addFields({ name: '📊 Status', value: passed ? '✅ Passed' : '❌ Failed', inline: false });
          }
          updatedEmbed = updatedEmbed.addFields({ name: passed ? '🎓 Passed By' : '❌ Failed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true });
          await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });
          if (passed) {
            const targetUser = await client.users.fetch(requestUserId).catch(() => null);
            if (targetUser) await sendPromotionAnnounce(interaction.guild, targetUser, 'their training', interaction.user, 'training');
          }
          const targetUser = await client.users.fetch(requestUserId).catch(() => null);
          if (targetUser) {
            const dmEmbed = new EmbedBuilder().setTitle(passed ? '🎓 Training Passed!' : '❌ Training Failed').setColor(passed ? 0x57F287 : 0xED4245).setDescription(passed ? `Congratulations! **${interaction.user.tag}** has marked your training as **passed**! 🎉` : `**${interaction.user.tag}** has marked your training as **failed**. Don't give up — keep practicing!`).setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
          }
          return;
        }
      }

      // Verification buttons
      if (id === 'verify_start') {
        const vc = getVerificationConfig(guildId);
        if (!vc.enabled) return interaction.reply({ content: '❌ Verification is disabled.', flags: MessageFlags.Ephemeral });
        if (vc.verifiedRole && interaction.member.roles.cache.has(vc.verifiedRole)) return interaction.reply({ content: '✅ You are already verified!', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_verify_username').setTitle('Roblox Verification — Step 1');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true).setMinLength(3).setMaxLength(20)));
        return interaction.showModal(modal);
      }

      if (id === 'verify_confirm') {
        const pending = pendingVerifications.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: '❌ No pending verification. Click **Verify** again to start over.', flags: MessageFlags.Ephemeral });
        if (Date.now() > pending.expires) {
          pendingVerifications.delete(interaction.user.id);
          return interaction.reply({ content: '❌ Verification expired (15 minutes). Click **Verify** again to start over.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const description = await getRobloxDescription(pending.robloxId);
          if (!description.includes(pending.code)) {
            return interaction.editReply({ content: `❌ Code **${pending.code}** not found in your Roblox profile description.\n\n1. Go to [your Roblox profile](https://www.roblox.com/users/${pending.robloxId}/profile)\n2. Click **Edit Profile**\n3. Paste \`${pending.code}\` anywhere in your description\n4. Save and click **✅ Done, check my profile** again` });
          }
          const vc = getVerificationConfig(guildId);
          const nickname = `(${interaction.user.username}) | ${pending.robloxUsername}`.slice(0, 32);
          try { await interaction.member.setNickname(nickname, 'Roblox verification'); } catch {}
          if (vc.verifiedRole) { const role = interaction.guild.roles.cache.get(vc.verifiedRole); if (role) await interaction.member.roles.add(role); }
          if (!vc.verifiedUsers) vc.verifiedUsers = {};
          vc.verifiedUsers[interaction.user.id] = { robloxUsername: pending.robloxUsername, robloxId: pending.robloxId, verifiedAt: Date.now() };
          await saveConfig(config);
          pendingVerifications.delete(interaction.user.id);
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Verified!').setColor(0x57F287).addFields(
            { name: '🎮 Roblox Username', value: pending.robloxUsername, inline: true },
            { name: '🆔 Roblox ID', value: `${pending.robloxId}`, inline: true },
            { name: '📛 Nickname', value: `\`${nickname}\``, inline: false },
          ).setDescription('You can now remove the code from your profile description.').setTimestamp()] });
        } catch { return interaction.editReply({ content: '❌ Could not check your profile. Try again later.' }); }
      }

      // Close request buttons
      if (id === 'closereq__accept' || id === 'closereq__deny') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.channel;
        const req = pendingCloseReqs.get(ch.id);
        if (!req) return interaction.reply({ content: '❌ No pending close request.', flags: MessageFlags.Ephemeral });
        if (id === 'closereq__deny') {
          pendingCloseReqs.delete(ch.id);
          return interaction.update({ embeds: [new EmbedBuilder().setTitle('❌ Close Request Denied').setColor(0xED4245).setDescription(`**${interaction.user.tag}** denied the close request.`).setTimestamp()], components: [] });
        }
        pendingCloseReqs.delete(ch.id);
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        for (const [uid, cid] of openTickets.entries()) {
          if (cid === ch.id) { openTickets.delete(uid); break; }
        }
        await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ Ticket Closed').setColor(0x57F287).setDescription(`Closed by **${interaction.user.tag}**. Deleting in 3 seconds...`).setTimestamp()], components: [] });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
        return;
      }

      // Application open button
      if (id.startsWith('appopen__')) {
        const parts = id.split('__');
        const typeId = parts[1];
        const panelId = parts[2];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ This application type no longer exists.', flags: MessageFlags.Ephemeral });
        if (!appType.questions || appType.questions.length === 0) return interaction.reply({ content: '❌ No questions configured for this type.', flags: MessageFlags.Ephemeral });
        if (activeAppSessions.has(interaction.user.id)) return interaction.reply({ content: '❌ You already have an active application. Check your DMs!\n\nType `cancel` to cancel it.', flags: MessageFlags.Ephemeral });
        if (appType.requiredRoles?.length && !appType.requiredRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: `❌ You need one of the following roles to apply: ${appType.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let dmChannel;
        try { dmChannel = await interaction.user.createDM(); }
        catch { return interaction.editReply({ content: '❌ I could not open a DM with you. Please enable DMs from server members.' }); }
        const session = { guildId, typeId, panelId, questionIndex: 0, answers: [], dmChannelId: dmChannel.id, guildName: interaction.guild.name, startedAt: Date.now() };
        activeAppSessions.set(interaction.user.id, session);
        try {
          const introEmbed = new EmbedBuilder().setTitle(`📋 ${appType.label}`).setColor(0x5865F2).setDescription(`Welcome! You are applying for **${appType.label}** in **${interaction.guild.name}**.\n\nYou have **${appType.questions.length}** question(s) to answer, one at a time.\nType your answer after each question.\n\n> Type \`cancel\` at any time to cancel.\n\n━━━━━━━━━━━━━━━━━━━━━━`).setFooter({ text: `${interaction.guild.name} • Application System` }).setThumbnail(interaction.guild.iconURL({ dynamic: true }));
          await dmChannel.send({ embeds: [introEmbed] });
          const sent = await sendNextQuestion(interaction.user.id, session, appType);
          if (!sent) {
            activeAppSessions.delete(interaction.user.id);
            return interaction.editReply({ content: '❌ Could not send question. Please check your DMs.' });
          }
          return interaction.editReply({ content: `✅ Your application has started! **Check your DMs** to answer the questions.\n\n> Type \`cancel\` to cancel at any time.` });
        } catch (e) {
          activeAppSessions.delete(interaction.user.id);
          return interaction.editReply({ content: '❌ Could not send DM. Please enable DMs from server members.' });
        }
      }

      // Application accept/deny
      if (id.startsWith('app__accept__') || id.startsWith('app__acceptsilent__') || id.startsWith('app__deny__')) {
        const parts = id.split('__');
        const action = parts[1];
        const applicantId = parts[2];
        const typeId = parts[3];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        const canReview = appType?.reviewRoles?.length ? appType.reviewRoles.some(rId => interaction.member.roles.cache.has(rId)) || hasSetup(interaction.member) : hasSetup(interaction.member);
        if (!canReview) return interaction.reply({ content: '❌ You do not have permission to accept or deny applications of this type.', flags: MessageFlags.Ephemeral });
        const applicant = await interaction.guild.members.fetch(applicantId).catch(() => null);
        if (action === 'accept' || action === 'acceptsilent') {
          if (appType?.acceptRoles?.length && applicant) {
            for (const roleId of appType.acceptRoles) {
              const role = interaction.guild.roles.cache.get(roleId);
              if (role) await applicant.roles.add(role).catch(() => {});
            }
          }
          let newNickname = null;
          if (appType?.nicknameFormat && applicant) {
            newNickname = appType.nicknameFormat.replace(/{user}/g, applicant.user.username).replace(/{username}/g, applicant.user.username).replace(/{rank}/g, appType.label).slice(0, 32);
            await applicant.setNickname(newNickname, `Application accepted: ${appType.label}`).catch(() => {});
          }
          const givenRoles = appType?.acceptRoles?.length ? appType.acceptRoles.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).filter(Boolean).join(', ') : 'None';
          await interaction.update({
            embeds: [new EmbedBuilder().setTitle('✅ Application Accepted').setColor(0x57F287).addFields(
              { name: '👤 Applicant', value: applicant?.user.tag ?? applicantId, inline: true },
              { name: '✅ Accepted by', value: interaction.user.tag, inline: true },
              { name: '🎭 Roles Given', value: givenRoles, inline: true },
              { name: '🏷️ Nickname', value: newNickname ? `\`${newNickname}\`` : '*Not changed*', inline: true },
              { name: '🔔 DM Sent', value: action === 'accept' ? 'Yes' : 'No (silent)', inline: true },
            ).setTimestamp()],
            components: [],
          });
          if (action === 'accept' && applicant) {
            const acceptRoleNames = appType?.acceptRoles?.length ? '\n\n**Roles given:** ' + appType.acceptRoles.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).filter(Boolean).join(', ') : '';
            const rawMsg = appType?.acceptMessage ? appType.acceptMessage.replace(/{username}/g, applicant.user.username).replace(/{userMention}/g, `<@${applicant.user.id}>`).replace(/{type}/g, appType.label).replace(/{server}/g, interaction.guild.name) : `✅ Congratulations **${applicant.user.username}**!\n\nYour **${appType.label}** in **${interaction.guild.name}** has been **accepted**! 🎉${acceptRoleNames}`;
            const acceptEmbed = new EmbedBuilder().setTitle('✅ Application Accepted!').setColor(0x57F287).setDescription(rawMsg).setTimestamp();
            const dmComponents = [];
            if (appType?.groupLink && isValidUrl(appType.groupLink)) dmComponents.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🚀 Join the group!').setStyle(ButtonStyle.Link).setURL(appType.groupLink)));
            await applicant.send({ embeds: [acceptEmbed], components: dmComponents }).catch(() => {});
          }
          if (ac.logChannel) {
            const logCh = interaction.guild.channels.cache.get(ac.logChannel);
            if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('✅ Application Accepted').setColor(0x57F287).addFields(
              { name: 'Applicant', value: applicant?.user.tag ?? applicantId, inline: true },
              { name: 'Type', value: appType?.label ?? typeId, inline: true },
              { name: 'Accepted by', value: interaction.user.tag, inline: true },
              { name: 'DM Sent', value: action === 'accept' ? 'Yes' : 'No', inline: true },
            ).setTimestamp()] });
          }
          return;
        }
        if (action === 'deny') {
          const modal = new ModalBuilder().setCustomId(`modal_app_deny__${applicantId}__${typeId}`).setTitle('Deny Application');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deny_reason').setLabel('Reason for denial').setStyle(TextInputStyle.Paragraph).setPlaceholder('You did not meet the requirements...').setRequired(true).setMaxLength(1000)));
          return interaction.showModal(modal);
        }
      }

      // Ticket open button
      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Ticket type not found.', flags: MessageFlags.Ephemeral });
        if (type.requiredRoles?.length && !type.requiredRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: `❌ You need one of the following roles to open this ticket: ${type.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }
        if (openTickets.has(interaction.user.id)) {
          const existing = interaction.guild.channels.cache.get(openTickets.get(interaction.user.id));
          if (existing) return interaction.reply({ content: `❌ You already have a ticket: <#${existing.id}>`, flags: MessageFlags.Ephemeral });
          openTickets.delete(interaction.user.id);
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const category = (type.category ? interaction.guild.channels.cache.get(type.category) : null) ?? (tc.ticketCategory ? interaction.guild.channels.cache.get(tc.ticketCategory) : null);
        const perms = [
          { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        for (const rid of tc.pingRoles) perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        if (type.viewRoles?.length) for (const rid of type.viewRoles) perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
        const ticketCh = await interaction.guild.channels.create({
          name: `ticket-${type.label.toLowerCase().replace(/\s+/g, '-')}-${interaction.user.username}`,
          type: ChannelType.GuildText,
          parent: category ?? null,
          permissionOverwrites: perms,
          topic: `Ticket by ${interaction.user.tag} | ${type.label}`,
        });
        openTickets.set(interaction.user.id, ticketCh.id);
        const vars = { userMention: `<@${interaction.user.id}>`, username: interaction.user.username, userTag: interaction.user.tag };
        const embed = new EmbedBuilder().setTitle(`${type.emoji || '🎫'} Ticket — ${type.label}`).setDescription(`${replaceVars(tc.welcomeText || 'Hello {user}!', vars)}\n\n**Type:** ${type.label}`).setColor(hexToInt(tc.panelColor)).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tkt__claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
          new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        );
        await ticketCh.send({ content: `<@${interaction.user.id}>${tc.pingRoles.map(id => ` <@&${id}>`).join('')}`, embeds: [embed], components: [closeRow] });
        return interaction.editReply({ content: `✅ Ticket created: <#${ticketCh.id}>` });
      }

      // Ticket claim/close
      if (id === 'tkt__claim') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const embed = interaction.message.embeds[0];
        const alreadyClaimed = embed?.description?.includes('**Claimed by**');
        if (alreadyClaimed) return interaction.reply({ content: '❌ This ticket is already claimed.', flags: MessageFlags.Ephemeral });
        const updatedEmbed = embed ? EmbedBuilder.from(embed).setDescription(`${embed.description || ''}\n\n**Claimed by:** ${interaction.user.tag} (<@${interaction.user.id}>)`) : new EmbedBuilder().setDescription(`**Claimed by:** ${interaction.user.tag} (<@${interaction.user.id}>)`);
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tkt__claim').setLabel(`Claimed by ${interaction.user.username}`).setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(true),
          new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        );
        await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] });
        await interaction.reply({ content: '✅ You have claimed this ticket!', ephemeral: false });
        return;
      }

      if (id === 'tkt__close') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.channel;
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        pendingCloseReqs.delete(ch.id);
        await interaction.reply({ content: '🔒 Closing in 3 seconds...' });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
      }
    }

    // String Select Menus
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const val = interaction.values[0];

      if (id === 'announce_pick') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const ac = getAnnouncementConfig(guildId);
        const t = ac.types[val];
        if (!t) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const targetChannelId = pendingAnnounceChannel.get(interaction.user.id);
        pendingAnnounceChannel.delete(interaction.user.id);
        const targetCh = targetChannelId ? interaction.guild.channels.cache.get(targetChannelId) : interaction.channel;
        if (!targetCh) return interaction.reply({ content: '❌ Target channel not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`${t.emoji || '📢'} ${t.title || t.name}`).setDescription(t.description || '*No description*').setColor(hexToInt(t.color)).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp();
        if (t.image) embed.setImage(t.image);
        await targetCh.send({ content: t.pingRole ? `<@&${t.pingRole}>` : undefined, embeds: [embed] });
        return interaction.editReply({ content: `✅ Sent in <#${targetCh.id}>!` });
      }

      if (id === 'dept_remove_select') {
        const deptIdx = parseInt(val);
        const stc = getServerTypeConfig(guildId);
        if (!stc.departments[deptIdx]) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
        const name = stc.departments[deptIdx].name;
        stc.departments.splice(deptIdx, 1);
        await saveConfig(config);
        return interaction.reply({ content: `✅ Department **${name}** verwijderd!`, flags: MessageFlags.Ephemeral });
      }

      if (id === 'dept_configure_select') {
        const deptIdx = parseInt(val);
        const stc = getServerTypeConfig(guildId);
        const dept = stc.departments[deptIdx];
        if (!dept) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`⚙️ Configureer: ${dept.name}`).setColor(0x5865F2).addFields(
          { name: '🆔 Guild ID', value: dept.guildId, inline: true },
          { name: '📢 Announcement Channel', value: dept.announcementChannel ? `<#${dept.announcementChannel}>` : '*Niet ingesteld*', inline: true },
          { name: '🔔 Ping Roles', value: dept.pingRoles?.length ? dept.pingRoles.map(r => `<@&${r}>`).join(', ') : '*Geen*', inline: false },
        ).setDescription('Stel in waar sessie-aankondigingen worden geplaatst:');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dept_set_announce__${deptIdx}`).setLabel('📢 Set Announcement Channel').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`dept_set_ping__${deptIdx}`).setLabel('🔔 Set Ping Roles').setStyle(ButtonStyle.Primary),
        );
        return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      }
    }

    // Role Select Menus
    if (interaction.isRoleSelectMenu()) {
      const ids = interaction.values;

      if (interaction.customId === 'vcd_role') {
        const vc = getVerificationConfig(guildId);
        vc.verifiedRole = ids[0];
        await saveConfig(config);
        return interaction.reply({ content: `✅ Verified role: <@&${ids[0]}>.`, flags: MessageFlags.Ephemeral });
      }
    }

    // Channel Select Menus
    if (interaction.isChannelSelectMenu()) {
      const chId = interaction.values[0];

      if (interaction.customId === 'vcd_channel') {
        getVerificationConfig(guildId).channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Verification channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'td_channel') {
        getTicketConfig(guildId).ticketChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Panel channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'td_category') {
        getTicketConfig(guildId).ticketCategory = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Category: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'td_transcript') {
        getTicketConfig(guildId).transcriptChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Transcript: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'sd_channel') {
        getSessionConfig(guildId).channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Session channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'apd_review_channel') {
        getApplicationConfig(guildId).reviewChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Global review channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'apd_log_channel') {
        getApplicationConfig(guildId).logChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Log channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'cmdlist_channel') {
        const cl = getCommandListConfig(guildId);
        cl.channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Command list channel set to <#${chId}>! Use **Deploy** to post it.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_channel') {
        const tc = getTrainingConfig(guildId);
        tc.channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Training request channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_announce_channel') {
        const tc = getTrainingConfig(guildId);
        tc.announceChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Announce channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
    }

    // Modals
    if (interaction.isModalSubmit()) {
      const mid = interaction.customId;

      if (mid === 'modal_dept_add') {
        const stc = getServerTypeConfig(guildId);
        const deptGuildId = interaction.fields.getTextInputValue('dept_guild_id').trim();
        const deptName = interaction.fields.getTextInputValue('dept_name').trim();
        if (!deptGuildId || !deptName) return interaction.reply({ content: '❌ Guild ID en naam zijn verplicht.', flags: MessageFlags.Ephemeral });
        if (stc.departments.some(d => d.guildId === deptGuildId)) return interaction.reply({ content: '❌ Dit department is al gekoppeld.', flags: MessageFlags.Ephemeral });
        stc.departments.push({ guildId: deptGuildId, name: deptName, announcementChannel: null, pingRoles: [] });
        await saveConfig(config);
        return interaction.reply({ content: `✅ Department **${deptName}** (\`${deptGuildId}\`) toegevoegd!\n\nGebruik **Configureren** om een announcement channel in te stellen.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_dept_mainid') {
        const mainId = interaction.fields.getTextInputValue('main_guild_id').trim();
        const stc = getServerTypeConfig(guildId);
        stc.mainGuildId = mainId || null;
        await saveConfig(config);
        return interaction.reply({ content: mainId ? `✅ Main server ingesteld op \`${mainId}\`.` : '✅ Main server ID verwijderd.', flags: MessageFlags.Ephemeral });
      }

      if (mid.startsWith('modal_staffrole__')) {
        const action = mid.replace('modal_staffrole__', '');
        const value = interaction.fields.getTextInputValue('role_value').trim();
        const stc = getServerTypeConfig(guildId);
        if (action === 'staff') { stc.staffRoleName = value || null; await saveConfig(config); return interaction.reply({ content: `✅ Staff rol naam ingesteld op: \`${value || DEFAULT_STAFF_ROLE}\``, flags: MessageFlags.Ephemeral }); }
        if (action === 'shr') { stc.shrRoleName = value || null; await saveConfig(config); return interaction.reply({ content: `✅ SHR rol naam ingesteld op: \`${value || DEFAULT_SHR_ROLE}\``, flags: MessageFlags.Ephemeral }); }
        if (action === 'setup') { stc.setupRoleId = value || null; await saveConfig(config); return interaction.reply({ content: `✅ Setup rol ID ingesteld op: \`${value || DEFAULT_SETUP_ID}\``, flags: MessageFlags.Ephemeral }); }
      }

      if (mid === 'modal_erlcconfig') {
        const key = interaction.fields.getTextInputValue('erlc_server_key').trim();
        const ec = getErlcLogConfig(guildId);
        ec.serverKey = key;
        await saveConfig(config);
        try {
          await erlcRequest('/server', 'GET', null, guildId);
          return interaction.reply({ content: '✅ ERLC Server Key saved and **verified**! The connection works.', flags: MessageFlags.Ephemeral });
        } catch (e) {
          return interaction.reply({ content: `⚠️ Key saved but **could not connect** to ERLC (${e.message}). Double check the key is correct.`, flags: MessageFlags.Ephemeral });
        }
      }

      if (mid === 'modal_verify_username') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        const robloxUsername = interaction.fields.getTextInputValue('roblox_username').trim();
        try {
          const robloxUser = await getRobloxUser(robloxUsername);
          if (!robloxUser) return interaction.editReply({ content: `❌ Roblox user **${robloxUsername}** not found. Check the spelling and try again.` });
          const code = `NYLRP-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
          pendingVerifications.set(interaction.user.id, { code, robloxUsername: robloxUser.name, robloxId: robloxUser.id, expires: Date.now() + 15 * 60 * 1000 });
          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('✏️ Edit my Roblox Profile').setStyle(ButtonStyle.Link).setURL(`https://www.roblox.com/users/${robloxUser.id}/profile`),
            new ButtonBuilder().setCustomId('verify_confirm').setLabel('✅ Done, check my profile').setStyle(ButtonStyle.Success),
          );
          return interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('🔐 Step 2 — Add the code to your Roblox profile').setColor(0xFEE75C).setDescription([
              `**Found:** ${robloxUser.name} (ID: ${robloxUser.id})`,
              ``,
              `**1.** Go to your [Roblox profile](https://www.roblox.com/users/${robloxUser.id}/profile)`,
              `**2.** Click **Edit Profile**`,
              `**3.** Paste this code anywhere in your **description:**`,
              `\`\`\`${code}\`\`\``,
              `**4.** Save your profile`,
              `**5.** Click the button below`,
              ``,
              `⏳ This code expires in **15 minutes**.`,
            ].join('\n'))],
            components: [confirmRow],
          });
        } catch { return interaction.editReply({ content: '❌ Could not reach Roblox. Try again later.' }); }
      }

      if (mid === 'modal_trainrequest') {
        const tc = getTrainingConfig(guildId);
        const ch = interaction.guild.channels.cache.get(tc.channel);
        if (!ch) return interaction.reply({ content: '❌ Training channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        const times = interaction.fields.getTextInputValue('tr_times');
        const notes = interaction.fields.getTextInputValue('tr_notes').trim();
        const reqId = genId();
        const embed = new EmbedBuilder().setTitle('📋 Training Request').setColor(0x5865F2).setThumbnail(interaction.user.displayAvatarURL({ dynamic: true })).addFields(
          { name: '👤 Requester', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '🆔 User ID', value: interaction.user.id, inline: true },
          { name: '🕐 Available Times', value: times, inline: false },
          { name: '📝 Notes', value: notes || '*None*', inline: false },
          { name: '✅ Claimed By', value: '*No one yet*', inline: false },
        ).setFooter({ text: `Request ID: ${reqId}` }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tr__claim__${interaction.user.id}__${reqId}`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`tr__unclaim__${interaction.user.id}__${reqId}`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`tr__pass__${interaction.user.id}__${reqId}`).setLabel('✅ Pass').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tr__fail__${interaction.user.id}__${reqId}`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger),
        );
        const ping = tc.pingRoles.length ? tc.pingRoles.map(r => `<@&${r}>`).join(' ') : null;
        await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        const cdKey = `${guildId}:${interaction.user.id}`;
        trainRequestCooldowns.set(cdKey, Date.now());
        return interaction.reply({ content: '✅ Your training request has been posted! A trainer will claim it soon.', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_send') {
        const content = interaction.fields.getTextInputValue('send_content');
        await interaction.channel.send({ content });
        return interaction.reply({ content: '✅ Message sent!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_execrequest' || mid === 'modal_founderrequest') {
        const isExec = mid === 'modal_execrequest';
        const cfg = isExec ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        const ch = interaction.guild.channels.cache.get(cfg.channel);
        if (!ch) return interaction.reply({ content: '❌ Request channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        const prefix = isExec ? 'exec' : 'founder';
        const action = interaction.fields.getTextInputValue(`${prefix}_action`).trim();
        const person = interaction.fields.getTextInputValue(`${prefix}_person`).trim();
        const reason = interaction.fields.getTextInputValue(`${prefix}_reason`).trim();
        const reqId = genId();
        const type = isExec ? 'Executive' : 'Foundership';
        const required = cfg.requiredApprovals ?? 2;
        const embed = new EmbedBuilder().setTitle(`📋 ${type} Request`).setColor(isExec ? 0x5865F2 : 0xFEE75C).setThumbnail(interaction.user.displayAvatarURL({ dynamic: true })).addFields(
          { name: '👤 Submitted By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
          { name: '⚡ Action', value: action, inline: true },
          { name: '🎯 Person Concerned', value: person, inline: false },
          { name: '📝 Reason', value: reason, inline: false },
          { name: `✅ Approvals (0/${required})`, value: '*No approvals yet*', inline: false },
          { name: '❌ Denials (0)', value: '*No denials yet*', inline: false },
          { name: '📊 Status', value: '⏳ Pending', inline: false },
        ).setFooter({ text: `Request ID: ${reqId} • Requires ${required} approvals` }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req__approve__${prefix}__${reqId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`req__deny__${prefix}__${reqId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
        );
        const ping = cfg.approvalRoles?.length ? cfg.approvalRoles.map(r => `<@&${r}>`).join(' ') : null;
        await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ Your **${type} Request** has been submitted!`, flags: MessageFlags.Ephemeral });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

// Department button handlers (separate to avoid clutter)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (id.startsWith('dept_set_announce__')) {
    if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
    const deptIdx = parseInt(id.replace('dept_set_announce__', ''));
    const stc = getServerTypeConfig(guildId);
    if (!stc.departments[deptIdx]) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: `### 📢 Selecteer announcement channel voor **${stc.departments[deptIdx].name}**`, components: [channelDropdown(`dept_announce_ch__${deptIdx}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('dept_set_ping__')) {
    if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
    const deptIdx = parseInt(id.replace('dept_set_ping__', ''));
    const stc = getServerTypeConfig(guildId);
    if (!stc.departments[deptIdx]) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: `### 🔔 Selecteer ping roles voor **${stc.departments[deptIdx].name}**`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`dept_ping_roles__${deptIdx}`).setPlaceholder('Select ping roles...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
  }
});

// Department channel select for announcement channel
client.on('interactionCreate', async interaction => {
  if (!interaction.isChannelSelectMenu()) return;
  const id = interaction.customId;
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (id.startsWith('dept_announce_ch__')) {
    if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
    const deptIdx = parseInt(id.replace('dept_announce_ch__', ''));
    const chId = interaction.values[0];
    const stc = getServerTypeConfig(guildId);
    if (!stc.departments[deptIdx]) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
    stc.departments[deptIdx].announcementChannel = chId;
    await saveConfig(config);
    return interaction.reply({ content: `✅ Announcement channel voor **${stc.departments[deptIdx].name}** ingesteld op <#${chId}>!`, flags: MessageFlags.Ephemeral });
  }
});

// Department role select for ping roles
client.on('interactionCreate', async interaction => {
  if (!interaction.isRoleSelectMenu()) return;
  const id = interaction.customId;
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (id.startsWith('dept_ping_roles__')) {
    if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
    const deptIdx = parseInt(id.replace('dept_ping_roles__', ''));
    const stc = getServerTypeConfig(guildId);
    if (!stc.departments[deptIdx]) return interaction.reply({ content: '❌ Department niet gevonden.', flags: MessageFlags.Ephemeral });
    stc.departments[deptIdx].pingRoles = interaction.values;
    await saveConfig(config);
    return interaction.reply({ content: `✅ Ping roles voor **${stc.departments[deptIdx].name}** ingesteld!`, flags: MessageFlags.Ephemeral });
  }
});

// Helper function for command list embed
async function updateCommandListEmbed(guild) {
  try {
    const cl = getCommandListConfig(guild.id);
    if (!cl.channel) return;
    const ch = guild.channels.cache.get(cl.channel);
    if (!ch) return;
    const embed = buildCommandListEmbed(guild.id);
    if (cl.messageId) {
      const msg = await ch.messages.fetch(cl.messageId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed] }); return; }
    }
    const msg = await ch.send({ embeds: [embed] });
    cl.messageId = msg.id;
    await saveConfig(config);
  } catch (e) { console.error('Command list update error:', e); }
}

function buildCommandListEmbed(guildId) {
  return new EmbedBuilder()
    .setTitle('📜 Command List')
    .setColor(0x5865F2)
    .setDescription([
      '**🛡️ Moderation**',
      '`/ban` `/unban` `/kick` `/softban` `/tempban` — SHR',
      '`/mute` `/unmute` `/warn` `/warnings` — Staff',
      '',
      '**🎭 Roles**',
      '`/addrole` `/removerole` `/giveroles` — SHR (with perms)',
      '`/promote` `/demote` — SHR',
      '',
      '**🎫 Tickets**',
      '`/close` `/closerequest` — Staff',
      '',
      '**📋 Applications**',
      '`/setup applications` — Setup role',
      '',
      '**🟢 Sessions**',
      '`/session start` `/session vote` `/session shutdown` — Staff',
      '',
      '**🎓 Training**',
      '`/trainrequest` — Trial Staff',
      '',
      '**✅ Verification**',
      '`/verify` — Everyone | `/unverify` — SHR',
      '',
      '**⚙️ Setup**',
      '`/setup` `/erlcconfig` `/send` — Setup role',
    ].join('\n'))
    .setFooter({ text: 'Last updated' })
    .setTimestamp();
}

// Start bot
(async () => {
  await connectDB();
  await client.login(process.env.TOKEN);
  console.log('🚀 Bot is starting...');
})();
