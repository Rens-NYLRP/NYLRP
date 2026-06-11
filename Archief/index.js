require('dotenv').config();
const http     = require('http');
const path     = require('path');
const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

http.createServer((req, res) => res.end('Bot is running!')).listen(process.env.PORT || 10000);
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
// CONFIG — MONGODB PERSISTENT STORAGE
// ════════════════════════════════════════════

// MongoDB schema: één document per guild, plus één 'global' doc
const configSchema = new mongoose.Schema({
  _id:  { type: String, required: true }, // guildId or 'global'
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { strict: false });

const ConfigModel = mongoose.model('Config', configSchema);

// In-memory config cache (zelfde structuur als voorheen)
let config = {};
let dbReady = false;

// Verbinding maken met MongoDB
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
    console.error('⚠️ Bot running without persistent storage! Add MONGODB_URI to .env');
  }
}

// Laad alle guild configs uit MongoDB in de in-memory cache
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

// Sla één guild op naar MongoDB (wordt aangeroepen na elke wijziging)
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

// Sla alles op (wordt gebruikt bij shutdown)
async function saveAllConfigs() {
  if (!dbReady) return;
  const promises = Object.keys(config).map(guildId => saveGuildConfig(guildId));
  await Promise.allSettled(promises);
}

// saveConfig is een alias die de hele config wegschrijft
// (voor backwards-compat met alle bestaande await saveConfig(config) calls)
// We vervangen dit door per-guild saves maar houden de functie intact
async function saveConfig(cfg) {
  // cfg is altijd het globale config object
  // Wacht tot alle guilds zijn opgeslagen (100% waterdicht)
  const promises = Object.keys(cfg).map(guildId => saveGuildConfig(guildId).catch(() => {}));
  await Promise.allSettled(promises);
}

// Auto-save elke 5 minuten als extra zekerheid
setInterval(() => {
  saveAllConfigs().catch(console.error);
}, 5 * 60 * 1000);

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n⚠️ ${signal} — saving config before shutdown...`);
  await saveAllConfigs();
  console.log('✅ Config saved. Shutting down.');
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  // Negeer bekende Discord API errors die geen crash rechtvaardigen
  if (err?.code === 10062 || err?.code === 40060 || err?.code === 10008 || err?.code === 50013) {
    console.warn('⚠️ Discord API warning (ignored):', err.message);
    return;
  }
  console.error('❌ Uncaught Exception:', err);
  await saveAllConfigs().catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // Negeer bekende Discord API errors
  if (reason?.code === 10062 || reason?.code === 40060 || reason?.code === 10008 || reason?.code === 50013) {
    console.warn('⚠️ Discord API warning (ignored):', reason.message);
    return;
  }
  console.error('❌ Unhandled Rejection:', reason);
  saveAllConfigs().catch(() => {});
});

function getGuildConfig(guildId) {
  if (!config[guildId]) {
    config[guildId] = {};
    // Nieuwe guild — direct opslaan
    saveGuildConfig(guildId).catch(() => {});
  }
  return config[guildId];
}

function getHandbookConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.handbooks) gc.handbooks = { panels: {} }; // panelId → { title, description, color, channel, messageId, books: [{ id, label, url, requiredRoles[] }] }
  return gc.handbooks;
}

function getTicketConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticket) gc.ticket = { pingRoles: [], transcriptChannel: null, ticketChannel: null, ticketCategory: null, panelTitle: '🎫 Support Tickets', panelDescription: 'Click a button below to open a support ticket.', panelColor: '#5865F2', panelThumbnail: null, welcomeText: 'Hello {user}, thank you for opening a ticket!', ticketTypes: [] };
  // Patch bestaande types
  for (const t of gc.ticket.ticketTypes) {
    if (!t.requiredRoles) t.requiredRoles = [];
    if (!t.viewRoles)     t.viewRoles     = [];
    if (!t.category)      t.category      = null;
  }
  return gc.ticket;
}
function getSessionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.session) gc.session = { channel: null, pingRoles: [], allowedRoles: [], joinLink: null, startImage: null, startDescription: null, voteImage: null, voteDescription: null, shutdownImage: null, shutdownDescription: null, voteThreshold: 5 };
  if (gc.session.voteThreshold === undefined) gc.session.voteThreshold = 5;
  return gc.session;
}
function getSelfRoleConfig(guildId) { const gc = getGuildConfig(guildId); if (!gc.selfroles) gc.selfroles = { panels: {} }; return gc.selfroles; }
function getAnnouncementConfig(guildId) { const gc = getGuildConfig(guildId); if (!gc.announcements) gc.announcements = { types: {} }; return gc.announcements; }
function getWelcomerConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.welcomer) gc.welcomer = { enabled: false, channel: null, title: 'Welcome to {server}!', description: 'Hello {userMention}, welcome to **{server}**!\nYou are member **#{memberCount}**.', color: '#2f3136', thumbnail: true, image: null, footer: 'Welcome!', pingUser: true };
  return gc.welcomer;
}
function getAutoroleConfig(guildId) { const gc = getGuildConfig(guildId); if (!gc.autorole) gc.autorole = { enabled: false, roles: [] }; return gc.autorole; }
function getVerificationConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.verification) gc.verification = { enabled: false, channel: null, verifiedRole: null, panelTitle: '✅ Verify your Roblox account', panelDescription: 'Click **Verify** below, enter your Roblox username, and you\'ll get access!\n\nNickname will be: `(DiscordName) | RobloxName`', panelColor: '#57F287', panelImage: null };
  return gc.verification;
}

// ════════════════════════════════════════════
// APPLICATION CONFIG (overhauled)
// ════════════════════════════════════════════
function getApplicationConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.applications) gc.applications = {
    panels: [],
    reviewChannel: null,
    logChannel: null,
    appTypes: [],
  };
  // Zorg dat verplichte velden altijd aanwezig zijn (migratie van oude data)
  if (!gc.applications.panels)   gc.applications.panels   = [];
  if (!gc.applications.appTypes) gc.applications.appTypes = [];
  // Patch elk bestaand type met ontbrekende velden zodat data nooit verloren gaat
  for (const t of gc.applications.appTypes) {
    if (!Array.isArray(t.questions))    t.questions    = [];
    if (!Array.isArray(t.acceptRoles))  t.acceptRoles  = [];
    if (t.acceptMessage  === undefined) t.acceptMessage  = null;
    if (t.denyMessage    === undefined) t.denyMessage    = null;
    if (t.groupLink      === undefined) t.groupLink      = null;
    if (t.nicknameFormat === undefined) t.nicknameFormat = null;
    if (t.reviewChannel  === undefined) t.reviewChannel  = null;
    if (t.reviewRoles    === undefined) t.reviewRoles    = [];
    if (t.requiredRoles  === undefined) t.requiredRoles  = [];
  }
  // Patch elk bestaand panel met ontbrekende velden
  for (const p of gc.applications.panels) {
    if (!Array.isArray(p.appTypeIds)) p.appTypeIds = [];
    if (p.reviewChannel === undefined) p.reviewChannel = null;
    if (p.image         === undefined) p.image         = null;
    if (p.title         === undefined) p.title         = '📋 Applications';
    if (p.description   === undefined) p.description   = null;
    if (p.color         === undefined) p.color         = '#5865F2';
    if (p.channel       === undefined) p.channel       = null;
  }
  return gc.applications;
}

function getSavedMessagesConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.savedMessages) gc.savedMessages = { messages: {} };
  if (!gc.savedMessages.messages) gc.savedMessages.messages = {};
  // Patch bestaande messages met ontbrekende velden
  for (const msg of Object.values(gc.savedMessages.messages)) {
    if (msg.title       === undefined) msg.title       = 'Bericht';
    if (msg.description === undefined) msg.description = '';
    if (msg.color       === undefined) msg.color       = '#5865F2';
    if (msg.image       === undefined) msg.image       = null;
    if (msg.footer      === undefined) msg.footer      = null;
  }
  return gc.savedMessages;
}
function getAutomodConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.automod) gc.automod = { enabled: false, keywords: [], logChannel: null, action: 'delete', muteMinutes: 5 };
  return gc.automod;
}

// ════════════════════════════════════════════
// COUNTER CONFIG
// ════════════════════════════════════════════
function getCounterConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.counters) gc.counters = {
    enabled: false, categoryId: null,
    channels: {
      members:  { enabled: true,  channelId: null, label: '👥 Members: {count}' },
      bots:     { enabled: true,  channelId: null, label: '🤖 Bots: {count}' },
      online:   { enabled: true,  channelId: null, label: '🟢 Online: {count}' },
      channels: { enabled: true,  channelId: null, label: '💬 Channels: {count}' },
      roles:    { enabled: true,  channelId: null, label: '🎭 Roles: {count}' },
    }
  };
  return gc.counters;
}

async function getCounterValue(guild, type) {
  switch (type) {
    case 'members': { await guild.members.fetch(); return guild.members.cache.filter(m => !m.user.bot).size; }
    case 'bots':    { await guild.members.fetch(); return guild.members.cache.filter(m => m.user.bot).size; }
    case 'online':  { await guild.members.fetch(); return guild.members.cache.filter(m => !m.user.bot && m.presence && ['online', 'idle', 'dnd'].includes(m.presence.status)).size; }
    case 'channels': return guild.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).size;
    case 'roles':    return guild.roles.cache.size - 1;
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
  const opts = { name, type: ChannelType.GuildVoice, permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }] };
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
setInterval(async () => { for (const guild of client.guilds.cache.values()) { await updateCounters(guild).catch(console.error); } }, 5 * 60 * 1000);

function buildRolePermsSetupPayload(guildId) {
  const rp = getRolePermConfig(guildId);
  const entries = Object.entries(rp);
  const fieldVal = entries.length
    ? entries.map(([roleId, perms]) => `<@&${roleId}>\n  ➕ Add: ${perms.addRoles?.length ? perms.addRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}\n  ➖ Remove: ${perms.removeRoles?.length ? perms.removeRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`).join('\n\n')
    : '*No role permissions set*';
  const embed = new EmbedBuilder().setTitle('🔐 Role Permissions Setup').setColor(0x5865F2)
    .setDescription('Set which roles are required to add or remove specific roles.\n\n' + fieldVal);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rperms__add').setLabel('Configure Role').setStyle(ButtonStyle.Primary).setEmoji('🔐'),
    new ButtonBuilder().setCustomId('rperms__clear').setLabel('Clear All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildCommandListEmbed(guildId) {
  const rp = getRolePermConfig(guildId);

  const section = (title, commands) => ({ name: title, value: commands.join('\n'), inline: false });

  const rolePermsStr = (roleId) => {
    const p = rp[roleId];
    if (!p) return 'Everyone';
    const add = p.addRoles?.length ? p.addRoles.map(r => `<@&${r}>`).join(', ') : 'Everyone';
    return add;
  };

  const fields = [
    section('🛡️ Moderation', [
      '`/ban` — Ban a user · **SHR**',
      '`/unban` — Unban a user · **SHR**',
      '`/kick` — Kick a user · **SHR**',
      '`/softban` — Softban a user · **SHR**',
      '`/tempban` — Temporarily ban a user · **SHR**',
      '`/mute` — Mute a user · **Staff**',
      '`/unmute` — Unmute a user · **Staff**',
      '`/warn` — Warn a user · **Staff**',
      '`/warnings` — View warnings · **Staff**',
      '`/clearwarnings` — Clear warnings · **SHR**',
      '`/note` — Add a note · **SHR**',
      '`/notes` — View notes · **SHR**',
    ]),
    section('🎭 Roles', [
      '`/addrole` — Add a role · **See role permissions**',
      '`/removerole` — Remove a role · **See role permissions**',
      '`/giveroles` — Add multiple roles · **See role permissions**',
      '`/promote` — Promote a user · **SHR**',
      '`/demote` — Demote a user · **SHR**',
    ]),
    section('🎟️ Tickets', [
      '`/setup tickets` — Configure tickets · **Setup Role**',
    ]),
    section('📋 Applications', [
      '`/setup applications` — Configure applications · **Setup Role**',
    ]),
    section('🟢 Sessions', [
      '`/session start` — Start a session · **Staff**',
      '`/session vote` — Start a vote · **Staff**',
      '`/session shutdown` — End a session · **Staff**',
    ]),
    section('🎓 Training', [
      '`/trainrequest` — Request a trainer · **Trial Staff**',
    ]),
    section('📋 Requests', [
      '`/executiverequest` — Executive request · **Everyone**',
      '`/foundationrequest` — Foundership request · **Everyone**',
    ]),
    section('✅ Verification', [
      '`/verify` — Verify Roblox account · **Everyone**',
      '`/unverify` — Unverify a user · **SHR**',
    ]),
    section('⚙️ Setup', [
      '`/setup` — Configure bot features · **Setup Role**',
      '`/erlcconfig` — Set ERLC key · **Setup Role**',
      '`/send` — Send a message · **Setup Role**',
    ]),
  ];

  return new EmbedBuilder()
    .setTitle('📜 Command List')
    .setColor(0x5865F2)
    .addFields(...fields)
    .setFooter({ text: 'Last updated' })
    .setTimestamp();
}

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
  } catch {}
}

function buildHandbookSetupPayload(guildId) {
  const hc = getHandbookConfig(guildId);
  const panels = Object.entries(hc.panels);
  const embed = new EmbedBuilder().setTitle('📚 Handbook Setup').setColor(0x5865F2)
    .setDescription(panels.length
      ? panels.map(([id, p]) => `**${p.title}** — ${p.books?.length ?? 0} book(s) — ${p.channel ? `<#${p.channel}>` : '*No channel*'}`).join('\n')
      : '*No handbook panels yet*');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hb__create').setLabel('➕ New Panel').setStyle(ButtonStyle.Success),
  );
  if (panels.length) {
    const sel = new StringSelectMenuBuilder().setCustomId('hb__select_panel').setPlaceholder('Select panel to edit...').addOptions(panels.slice(0, 25).map(([id, p]) => ({ label: p.title, value: id })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(sel), row], flags: MessageFlags.Ephemeral };
  }
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildHandbookPanelEditor(guildId, panelId) {
  const hc = getHandbookConfig(guildId);
  const panel = hc.panels[panelId];
  const embed = new EmbedBuilder().setTitle(`📚 Editing: ${panel.title}`).setColor(0x5865F2)
    .addFields(
      { name: '📢 Channel', value: panel.channel ? `<#${panel.channel}>` : '*Not set*', inline: true },
      { name: '📌 Status', value: panel.messageId ? '✅ Deployed' : '❌ Not deployed', inline: true },
      { name: '📖 Books', value: panel.books?.length
        ? panel.books.map((b, i) => `${i+1}. **${b.label}** ${b.requiredRoles?.length ? `— ${b.requiredRoles.map(r => `<@&${r}>`).join(', ')}` : '— Everyone'}`).join('\n')
        : '*No books yet*', inline: false },
    );
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hb__add_book__${panelId}`).setLabel('➕ Add Book').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hb__set_channel__${panelId}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
      new ButtonBuilder().setCustomId(`hb__deploy__${panelId}`).setLabel('🚀 Deploy').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hb__delete_panel__${panelId}`).setLabel('🗑️ Delete Panel').setStyle(ButtonStyle.Danger),
    ),
  ];
  if (panel.books?.length) {
    const sel = new StringSelectMenuBuilder().setCustomId(`hb__remove_book__${panelId}`).setPlaceholder('Remove a book...').addOptions(panel.books.slice(0, 25).map(b => ({ label: b.label, value: b.id })));
    rows.push(new ActionRowBuilder().addComponents(sel));
  }
  return { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral };
}

function buildCommandListSetupPayload(guildId) {
  const cl = getCommandListConfig(guildId);
  const embed = new EmbedBuilder().setTitle('📜 Command List Setup').setColor(0x5865F2)
    .addFields(
      { name: '📢 Channel', value: cl.channel ? `<#${cl.channel}>` : '*Not set*', inline: true },
      { name: '📌 Message', value: cl.messageId ? `✅ Deployed` : '❌ Not deployed', inline: true },
    )
    .setDescription('The command list auto-updates whenever settings change.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cmdlist__channel').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('cmdlist__deploy').setLabel('Deploy / Update Now').setStyle(ButtonStyle.Success).setEmoji('🚀'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildRequestSetupPayload(guildId, type) {
  const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
  const label = type === 'exec' ? 'Executive' : 'Foundership';
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${label} Request Setup`)
    .setColor(type === 'exec' ? 0x5865F2 : 0xFEE75C)
    .addFields(
      { name: '📢 Channel', value: cfg.channel ? `<#${cfg.channel}>` : '*Not set*', inline: true },
      { name: '🔑 Approval Roles', value: cfg.approvalRoles?.length ? cfg.approvalRoles.map(r => `<@&${r}>`).join(', ') : '*Not set (setup only)*', inline: true },
      { name: '✅ Required Approvals', value: `${cfg.requiredApprovals ?? 2}`, inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reqsetup__channel__${type}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId(`reqsetup__roles__${type}`).setLabel('Approval Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId(`reqsetup__approvals__${type}`).setLabel('Required Approvals').setStyle(ButtonStyle.Primary).setEmoji('✅'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildErlcLogSetupPayload(guildId) {
  const ec = getErlcLogConfig(guildId);
  const embed = new EmbedBuilder().setTitle('📋 ERLC Log Setup').setColor(0x5865F2)
    .setDescription(`**Status:** ${ec.enabled ? '✅ Active' : '❌ Inactive'}\n**Server Key:** ${ec.serverKey ? '✅ Set' : '❌ Not set — use `/erlcconfig`'}\n\nSet the Discord channel for each ERLC log type. Polls every **30 seconds**.**`)
    .addFields(
      { name: '🔨 Kick/Ban Logs',   value: ec.kickBans  ? `<#${ec.kickBans}>`  : '*Not set*', inline: true },
      { name: '📥 Join/Leave Logs', value: ec.joinLeave ? `<#${ec.joinLeave}>` : '*Not set*', inline: true },
      { name: '⌨️ Command Logs',    value: ec.cmds      ? `<#${ec.cmds}>`      : '*Not set*', inline: true },
      { name: '🚨 Mod Call Logs',   value: ec.modCall   ? `<#${ec.modCall}>`   : '*Not set*', inline: true },
      { name: '💀 Kill Logs',       value: ec.kills     ? `<#${ec.kills}>`     : '*Not set*', inline: true },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('erlc_toggle').setLabel(ec.enabled ? '🔴 Disable' : '🟢 Enable').setStyle(ec.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('erlc_set_kickbans').setLabel('Kick/Ban Channel').setStyle(ButtonStyle.Primary).setEmoji('🔨'),
    new ButtonBuilder().setCustomId('erlc_set_joinleave').setLabel('Join/Leave Channel').setStyle(ButtonStyle.Primary).setEmoji('📥'),
    new ButtonBuilder().setCustomId('erlc_set_cmds').setLabel('Commands Channel').setStyle(ButtonStyle.Primary).setEmoji('⌨️'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('erlc_set_modcall').setLabel('Mod Call Channel').setStyle(ButtonStyle.Primary).setEmoji('🚨'),
    new ButtonBuilder().setCustomId('erlc_set_kills').setLabel('Kill Logs Channel').setStyle(ButtonStyle.Primary).setEmoji('💀'),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildTrainingSetupPayload(guildId) {
  const tc = getTrainingConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🎓 Training Request Setup').setColor(0x5865F2)
    .addFields(
      { name: '📢 Request Channel', value: tc.channel ? `<#${tc.channel}>` : '*Not set*', inline: true },
      { name: '🔑 Trainer Roles', value: tc.trainerRoles.length ? tc.trainerRoles.map(r => `<@&${r}>`).join(', ') : '*Not set (setup only)*', inline: true },
      { name: '📋 Request Roles', value: tc.requestRoles.length ? tc.requestRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*', inline: true },
      { name: '🔔 Ping Roles', value: tc.pingRoles.length ? tc.pingRoles.map(r => `<@&${r}>`).join(', ') : '*None*', inline: true },
      { name: '📣 Announce Channel', value: tc.announceChannel ? `<#${tc.announceChannel}>` : '*Not set*', inline: true },
      { name: '💬 Announce Message', value: tc.announceMessage ? `\`${tc.announceMessage.slice(0, 80)}...\`` : '*Default*', inline: false },
    )
    .setDescription('Variables: `{user}` `{role}` `{promotedBy}` `{server}`');
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tr_setup__channel').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('tr_setup__trainer_roles').setLabel('Trainer Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('tr_setup__request_roles').setLabel('Request Roles').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('tr_setup__ping_roles').setLabel('Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('🔔'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tr_setup__announce_channel').setLabel('Announce Channel').setStyle(ButtonStyle.Primary).setEmoji('📣'),
    new ButtonBuilder().setCustomId('tr_setup__announce_message').setLabel('Announce Message').setStyle(ButtonStyle.Primary).setEmoji('💬'),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildCounterSetupPayload(guildId) {
  const cc = getCounterConfig(guildId);
  const typeLabels = { members: '👥 Members', bots: '🤖 Bots', online: '🟢 Online', channels: '💬 Channels', roles: '🎭 Roles' };
  const fields = Object.entries(cc.channels).map(([type, cfg]) => ({ name: typeLabels[type], value: cfg.channelId ? `<#${cfg.channelId}> — ${cfg.enabled ? '✅ On' : '❌ Off'}` : `${cfg.enabled ? '✅ On' : '❌ Off'} — *No channel yet*`, inline: true }));
  const embed = new EmbedBuilder().setTitle('📊 Counter Setup').setColor(0x5865F2)
    .setDescription(`**Status:** ${cc.enabled ? '✅ Active' : '❌ Inactive'}\n**Category:** ${cc.categoryId ? `<#${cc.categoryId}>` : '*None*'}\n\nCreate counter channels that update every 5 minutes.`)
    .addFields(fields);
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cnt_toggle').setLabel(cc.enabled ? 'Disable Counters' : 'Enable Counters').setStyle(cc.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(cc.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('cnt_category').setLabel('Set Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
    new ButtonBuilder().setCustomId('cnt_create_all').setLabel('Create All').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('cnt_delete_all').setLabel('Delete All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cnt_toggle_members').setLabel('Members').setStyle(cc.channels.members.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('cnt_toggle_bots').setLabel('Bots').setStyle(cc.channels.bots.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🤖'),
    new ButtonBuilder().setCustomId('cnt_toggle_online').setLabel('Online').setStyle(cc.channels.online.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🟢'),
    new ButtonBuilder().setCustomId('cnt_toggle_channels').setLabel('Channels').setStyle(cc.channels.channels.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('💬'),
    new ButtonBuilder().setCustomId('cnt_toggle_roles').setLabel('Roles').setStyle(cc.channels.roles.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎭'),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cnt_labels').setLabel('Edit Labels').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('cnt_refresh').setLabel('Force Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
  );
  return { embeds: [embed], components: [r1, r2, r3], flags: MessageFlags.Ephemeral };
}

function getWarnings(guildId, userId) { const gc = getGuildConfig(guildId); if (!gc.warnings) gc.warnings = {}; if (!gc.warnings[userId]) gc.warnings[userId] = []; return gc.warnings[userId]; }
async function addWarning(guildId, userId, warn) { const gc = getGuildConfig(guildId); if (!gc.warnings) gc.warnings = {}; if (!gc.warnings[userId]) gc.warnings[userId] = []; gc.warnings[userId].push(warn); await saveConfig(config); }
async function clearWarnings(guildId, userId) { const gc = getGuildConfig(guildId); if (!gc.warnings) gc.warnings = {}; gc.warnings[userId] = []; await saveConfig(config); }
function getNotes(guildId, userId) { const gc = getGuildConfig(guildId); if (!gc.notes) gc.notes = {}; if (!gc.notes[userId]) gc.notes[userId] = []; return gc.notes[userId]; }
async function addNote(guildId, userId, note) { const gc = getGuildConfig(guildId); if (!gc.notes) gc.notes = {}; if (!gc.notes[userId]) gc.notes[userId] = []; gc.notes[userId].push(note); await saveConfig(config); }

// ════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════
const STAFF_ROLE = '《 𝑵𝒀𝑳𝑹𝑷 | Staff Team》';
const SHR_ROLE      = 'SHR';
const SETUP_ROLE_ID = '1379173469501264026';
const LOGO_URL      = 'https://cdn.discordapp.com/attachments/1363047391263064166/1484556795321122917/image.png';

const hasStaff    = m => m.roles.cache.some(r => r.name === STAFF_ROLE);
const hasSHR      = m => m.roles.cache.some(r => r.name === SHR_ROLE);
const hasSetup    = m => m.roles.cache.has(SETUP_ROLE_ID) || m.permissions.has('Administrator');
const hasAnyStaff = m => hasStaff(m) || hasSHR(m);

const trainRequestCooldowns = new Map(); // userId → timestamp

function getTrainingConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.training) gc.training = { channel: null, trainerRoles: [], requestRoles: [], pingRoles: [], announceChannel: null, announceMessage: null };
  if (!gc.training.trainerRoles)    gc.training.trainerRoles    = [];
  if (!gc.training.requestRoles)    gc.training.requestRoles    = [];
  if (!gc.training.pingRoles)       gc.training.pingRoles       = [];
  if (!gc.training.announceChannel) gc.training.announceChannel = null;
  if (!gc.training.announceMessage) gc.training.announceMessage = null;
  return gc.training;
}

async function sendPromotionAnnounce(guild, targetUser, roleName, promotedBy, source = 'promotion') {
  const tc = getTrainingConfig(guild.id);
  if (!tc.announceChannel) return;
  const ch = guild.channels.cache.get(tc.announceChannel);
  if (!ch) return;
  const defaultMsg = source === 'training'
    ? `🎉 Congratulations <@{user}>! You have **passed your training** and have been promoted to **{role}**! Well done!`
    : `🎉 Congratulations <@{user}>! You have been promoted to **{role}**!`;
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

function canRunSession(member, guildId) {
  if (hasSHR(member)) return true;
  const sc = getSessionConfig(guildId);
  if (!sc.allowedRoles?.length) return hasAnyStaff(member);
  return sc.allowedRoles.some(id => member.roles.cache.has(id));
}

const openTickets      = new Map();
const srPendingRoleAdd = new Map();
const activeVotes      = new Map();
const pendingCloseReqs = new Map();
const pendingAnnounceChannel = new Map();
const pendingSendMsgChannel  = new Map();

// ════════════════════════════════════════════
// APPLICATION SESSION STATE
// activeAppSessions: userId -> {
//   guildId, typeId, panelId, questionIndex, answers, dmChannelId, guildName, startedAt
// }
// ════════════════════════════════════════════
const activeAppSessions = new Map();

// ════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════
function genId() { return Math.random().toString(36).slice(2, 8); }
function hexToInt(hex) { if (!hex) return 0x5865F2; const v = parseInt(hex.replace('#', ''), 16); return isNaN(v) ? 0x5865F2 : v; }
function colorToButtonStyle(c) {
  if (!c) return ButtonStyle.Secondary;
  const s = c.toLowerCase().trim();
  if (s === 'green' || s === 'success') return ButtonStyle.Success;
  if (s === 'red'   || s === 'danger')  return ButtonStyle.Danger;
  if (s === 'grey'  || s === 'gray' || s === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}
function safeSetEmoji(btn, emoji) { if (!emoji || emoji === 'null') return btn; try { btn.setEmoji(emoji); } catch {} return btn; }
function isValidUrl(url) { if (!url || typeof url !== 'string') return false; const t = url.trim(); return t.startsWith('https://') || t.startsWith('http://'); }

function replaceVars(text, opts = {}) {
  if (!text) return text;
  const now = new Date();
  return text
    .replace(/{user}/g,        opts.userMention  ?? '')
    .replace(/{userMention}/g, opts.userMention  ?? '')
    .replace(/{username}/g,    opts.username     ?? '')
    .replace(/{host}/g,        opts.username     ?? '')
    .replace(/{hostMention}/g, opts.userMention  ?? '')
    .replace(/{hostTag}/g,     opts.userTag      ?? '')
    .replace(/{memberCount}/g, opts.memberCount  ?? '')
    .replace(/{server}/g,      opts.server       ?? '')
    .replace(/{time}/g,        now.toUTCString())
    .replace(/{date}/g,        now.toDateString());
}

async function getRobloxUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!res.ok) throw new Error('Roblox API error');
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return data.data[0];
}

async function getRobloxDescription(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  if (!res.ok) throw new Error('Roblox API error');
  const data = await res.json();
  return data.description ?? '';
}

function getRolePermConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.rolePerms) gc.rolePerms = {}; // roleId → { addRoles: [], removeRoles: [] }
  return gc.rolePerms;
}

function getCommandListConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.commandList) gc.commandList = { channel: null, messageId: null };
  return gc.commandList;
}

function getExecRequestConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.execRequest) gc.execRequest = { channel: null, approvalRoles: [], requiredApprovals: 2 };
  return gc.execRequest;
}

function getFounderRequestConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.founderRequest) gc.founderRequest = { channel: null, approvalRoles: [], requiredApprovals: 2 };
  return gc.founderRequest;
}

const pendingVerifications = new Map(); // discordUserId → { code, robloxUsername, robloxId, expires }

const ERLC_BASE = 'https://api.policeroleplay.community/v1';
async function erlcRequest(p, method = 'GET', body = null, guildId = null) {
  const key = guildId ? (getErlcLogConfig(guildId).serverKey || process.env.ERLC_API_KEY) : process.env.ERLC_API_KEY;
  const opts = { method, headers: { 'Server-Key': key, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${p}`, opts);
  if (!res.ok) throw new Error(`ERLC ${res.status}: ${res.statusText}`);
  return res.json();
}

function getErlcLogConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.erlcLogs) gc.erlcLogs = { enabled: false, serverKey: null, kickBans: null, joinLeave: null, cmds: null, modCall: null, kills: null };
  if (!gc.erlcLogs.serverKey) gc.erlcLogs.serverKey = null;
  return gc.erlcLogs;
}

// ERLC polling state — bijhouden wat we al gezien hebben
const erlcState = new Map(); // guildId → { players: Set, kills: Set, modCalls: Set, cmds: Set, bans: Set }

function roleDropdown(customId, placeholder, min = 1, max = 10) {
  return new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max));
}
function channelDropdown(customId, placeholder, types = [ChannelType.GuildText]) {
  return new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addChannelTypes(...types).setMinValues(1).setMaxValues(1));
}

// ════════════════════════════════════════════
// APPLICATION SYSTEM — CORE FUNCTIONS
// ════════════════════════════════════════════

/**
 * Send the next question to the user's DM and update the session state.
 */
async function sendNextQuestion(userId, session, appType) {
  const dmChannel = await client.users.fetch(userId).then(u => u.createDM()).catch(() => null);
  if (!dmChannel) return false;

  const qIndex = session.questionIndex;
  const total  = appType.questions.length;
  const question = appType.questions[qIndex];

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 ${appType.label} — Question ${qIndex + 1}/${total}`)
    .setDescription(`**${question}**`)
    .setFooter({ text: `Type your answer below. Type "cancel" to cancel your application. • ${session.guildName}` });

  // Add progress bar
  const filled = Math.round((qIndex / total) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  embed.addFields({ name: 'Progress', value: `\`${bar}\` ${qIndex}/${total} answered`, inline: false });

  try {
    await dmChannel.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit the completed application to the review channel.
 */
async function submitApplication(userId, session, appType, guild) {
  const ac = getApplicationConfig(session.guildId);

  // Determine review channel: type-level override > panel-level override > global
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
    { name: '🆔 User ID',   value: userId, inline: true },
    { name: '📅 Submitted', value: new Date().toUTCString(), inline: false },
  ];

  // Helper: bereken embed size (Discord telt title + description + fields + footer)
  const fieldSize = f => (f.name?.length ?? 0) + (f.value?.length ?? 0);
  const EMBED_MAX = 5800; // iets onder 6000 als veiligheidsmarge
  const MAX_FIELDS = 25;

  // Bouw embeds waarbij we per embed de totale grootte bewaken
  const embeds = [];
  let currentFields = [...headerFields];
  let currentSize = 60 + headerFields.reduce((s, f) => s + fieldSize(f), 0); // 60 voor title/footer
  let isFirst = true;
  let page = 1;

  const flushEmbed = (isLast) => {
    const title = isFirst
      ? `📋 New Application — ${appType.emoji || ''} ${appType.label}`
      : `📋 Application (continued) — ${appType.label} — Page ${page}`;
    const footer = `Application ID: ${appId}${!isLast ? ' • Continued below ↓' : ''}`;
    const eb = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x5865F2)
      .addFields(...currentFields)
      .setFooter({ text: footer });
    if (isFirst) { eb.setThumbnail(applicant?.displayAvatarURL({ dynamic: true }) ?? null); eb.setTimestamp(); }
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

  // Discord limit: max 10 embeds per message
  // Stuur eerste batch met buttons, rest zonder (buttons op laatste bericht)
  const EMBEDS_PER_MSG = 10;
  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MSG) {
    const batch = embeds.slice(i, i + EMBEDS_PER_MSG);
    const isLastBatch = i + EMBEDS_PER_MSG >= embeds.length;
    await reviewCh.send({ embeds: batch, components: isLastBatch ? [row] : [] });
  }
  return appId;
}

// ════════════════════════════════════════════
// AUTOMOD
// ════════════════════════════════════════════
function buildAutomodSetupPayload(guildId) {
  const am = getAutomodConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🛡️ Automod Setup').setColor(0xED4245)
    .setDescription('Configure automatic moderation for keywords.\n\n**Actions:** `delete` | `delete+warn` | `delete+mute`')
    .addFields(
      { name: '✅ Enabled',    value: am.enabled ? 'Yes' : 'No', inline: true },
      { name: '⚙️ Action',     value: am.action || 'delete', inline: true },
      { name: '⏱️ Mute (min)', value: `${am.muteMinutes ?? 5}`, inline: true },
      { name: '📋 Log Channel',value: am.logChannel ? `<#${am.logChannel}>` : '*Not set*', inline: true },
      { name: '🚫 Keywords',   value: am.keywords.length ? am.keywords.map(k => `\`${k}\``).join(', ') : '*None*', inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('am_toggle').setLabel(am.enabled ? 'Disable' : 'Enable').setStyle(am.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(am.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('am_keywords').setLabel('Edit Keywords').setStyle(ButtonStyle.Primary).setEmoji('🚫'),
    new ButtonBuilder().setCustomId('am_action').setLabel('Set Action').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
    new ButtonBuilder().setCustomId('am_log').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
  );
  return { embeds: [embed], components: [r1], flags: MessageFlags.Ephemeral };
}

// ════════════════════════════════════════════
// APPLICATION SETUP PAYLOADS
// ════════════════════════════════════════════
function buildApplicationSetupPayload(guildId) {
  const ac = getApplicationConfig(guildId);
  const typeList = ac.appTypes.length
    ? ac.appTypes.map(t => {
        const roles = (t.acceptRoles ?? []).map(id => `<@&${id}>`).join(', ') || 'None';
        return `${t.emoji || '•'} \`${t.label}\` — **${t.questions?.length ?? 0}** questions | Accept roles: ${roles}`;
      }).join('\n')
    : '*No types yet*';

  const panelList = ac.panels.length
    ? ac.panels.map((p, i) => {
        const types = p.appTypeIds.map(tid => ac.appTypes.find(t => t.id === tid)?.label ?? tid).join(', ') || 'None';
        return `**Panel ${i + 1}:** \`${p.name}\` → <#${p.channel ?? '?'}> | Types: ${types}`;
      }).join('\n')
    : '*No panels yet*';

  const embed = new EmbedBuilder()
    .setTitle('📋 Application System Setup').setColor(0x5865F2)
    .setDescription(
      '> Applications are handled entirely in **DMs** — one question at a time.\n\n' +
      '**Workflow:**\n' +
      '1. Create application **types** (with questions)\n' +
      '2. Create **panels** (embed + buttons in a channel)\n' +
      '3. Deploy panels to your channel\n\n' +
      '**Channels:**'
    )
    .addFields(
      { name: '📢 Global Review Channel', value: ac.reviewChannel ? `<#${ac.reviewChannel}>` : '*Not set*', inline: true },
      { name: '📋 Log Channel',           value: ac.logChannel ? `<#${ac.logChannel}>` : '*Not set*', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '📝 Application Types',    value: typeList, inline: false },
      { name: '🖼️ Panels',              value: panelList, inline: false },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_review_channel').setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('ap_log_channel').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_add_type').setLabel('Add Type').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('ap_edit_type').setLabel('Edit Type').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('ap_remove_type').setLabel('Remove Type').setStyle(ButtonStyle.Danger).setEmoji('➖'),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_add_panel').setLabel('Add Panel').setStyle(ButtonStyle.Success).setEmoji('🖼️'),
    new ButtonBuilder().setCustomId('ap_edit_panel').setLabel('Edit Panel').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('ap_remove_panel').setLabel('Remove Panel').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    new ButtonBuilder().setCustomId('ap_deploy_panel').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'),
  );

  return { embeds: [embed], components: [r1, r2, r3], flags: MessageFlags.Ephemeral };
}

// ════════════════════════════════════════════
// OTHER SETUP PAYLOADS (unchanged)
// ════════════════════════════════════════════
function buildSavedMessagesPayload(guildId) {
  const sm = getSavedMessagesConfig(guildId);
  const msgs = Object.entries(sm.messages);
  const embed = new EmbedBuilder().setTitle('💾 Saved Messages').setColor(0x57F287)
    .setDescription(['Save messages you send often.', '', msgs.length ? msgs.map(([, m]) => `**${m.emoji || '📨'} ${m.name}**`).join('\n') : '*No saved messages yet.*'].join('\n'));
  const btns = [new ButtonBuilder().setCustomId('sm_new').setLabel('New Message').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (msgs.length) { btns.push(new ButtonBuilder().setCustomId('sm_edit').setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('sm_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')); }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}
function buildWelcomerSetupPayload(guildId) {
  const wc = getWelcomerConfig(guildId);
  const embed = new EmbedBuilder().setTitle('👋 Welcomer Setup').setColor(0x5865F2)
    .setDescription('Configure the welcome message.\n\n**Variables:** `{userMention}` `{username}` `{memberCount}` `{server}`')
    .addFields(
      { name: '✅ Enabled', value: wc.enabled ? 'Yes' : 'No', inline: true },
      { name: '📢 Channel', value: wc.channel ? `<#${wc.channel}>` : '*Not set*', inline: true },
      { name: '🏷️ Title', value: wc.title || '*Not set*', inline: false },
      { name: '📝 Description', value: wc.description ? `\`\`\`${wc.description.slice(0, 150)}\`\`\`` : '*Not set*', inline: false },
      { name: '🎨 Color', value: wc.color || '*Not set*', inline: true },
      { name: '🖼️ Image', value: wc.image ? '✅ Set' : '❌ Not set', inline: true },
      { name: '📌 Footer', value: wc.footer || '*Not set*', inline: true },
      { name: '🔔 Ping User', value: wc.pingUser ? 'Yes' : 'No', inline: true },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wc_channel').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('wc_content').setLabel('Edit Content').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('wc_toggle').setLabel(wc.enabled ? 'Disable' : 'Enable').setStyle(wc.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(wc.enabled ? '🔴' : '🟢'),
  );
  return { embeds: [embed], components: [r1], flags: MessageFlags.Ephemeral };
}
function buildAutoroleSetupPayload(guildId) {
  const ar = getAutoroleConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🎭 Autorole Setup').setColor(0xEB459E)
    .setDescription('Roles given automatically when someone joins.')
    .addFields({ name: '✅ Enabled', value: ar.enabled ? 'Yes' : 'No', inline: true }, { name: '🎭 Roles', value: ar.roles.length ? ar.roles.map(id => `<@&${id}>`).join(', ') : '*No roles set*', inline: false });
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ar_add').setLabel('Add Role').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('ar_remove').setLabel('Remove Role').setStyle(ButtonStyle.Danger).setEmoji('➖'),
    new ButtonBuilder().setCustomId('ar_toggle').setLabel(ar.enabled ? 'Disable' : 'Enable').setStyle(ar.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(ar.enabled ? '🔴' : '🟢'),
  );
  return { embeds: [embed], components: [r1], flags: MessageFlags.Ephemeral };
}
function buildVerificationSetupPayload(guildId) {
  const vc = getVerificationConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🔐 Verification Setup').setColor(0x57F287)
    .setDescription('Roblox verification.')
    .addFields(
      { name: '✅ Enabled', value: vc.enabled ? 'Yes' : 'No', inline: true },
      { name: '📢 Channel', value: vc.channel ? `<#${vc.channel}>` : '*Not set*', inline: true },
      { name: '🎭 Verified Role', value: vc.verifiedRole ? `<@&${vc.verifiedRole}>` : '*Not set*', inline: true },
      { name: '🏷️ Panel Title', value: vc.panelTitle || '*Not set*', inline: false },
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
function buildTicketPanelEmbed(tc) {
  const embed = new EmbedBuilder().setTitle(tc.panelTitle || '🎫 Support Tickets').setDescription(tc.panelDescription || 'Click a button below.').setColor(hexToInt(tc.panelColor));
  if (tc.panelThumbnail) embed.setImage(tc.panelThumbnail);
  return embed;
}
function buildTicketTypeButtons(ticketTypes) {
  const rows = [];
  for (let i = 0; i < Math.min(ticketTypes.length, 25); i += 5) {
    const chunk = ticketTypes.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(chunk.map(t => safeSetEmoji(new ButtonBuilder().setCustomId(`tkt__open__${t.id}`).setLabel(t.label.slice(0, 80)).setStyle(colorToButtonStyle(t.color)), t.emoji))));
  }
  return rows;
}
function buildTicketSetupPayload(guildId) {
  const tc = getTicketConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🎫 Ticket System Setup').setColor(0x5865F2).setDescription('Configure the ticket system below.')
    .addFields(
      { name: '📢 Ping Roles',    value: tc.pingRoles.length ? tc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '📋 Transcript Ch.', value: tc.transcriptChannel ? `<#${tc.transcriptChannel}>` : '*Not set*', inline: true },
      { name: '📬 Panel Channel',  value: tc.ticketChannel ? `<#${tc.ticketChannel}>` : '*Not set*', inline: true },
      { name: '📁 Category',       value: tc.ticketCategory ? `<#${tc.ticketCategory}>` : '*Not set*', inline: true },
      { name: '🏷️ Ticket Types',  value: tc.ticketTypes.length ? tc.ticketTypes.map(t => `${t.emoji || '•'} \`${t.label}\``).join('\n') : '*No types yet*', inline: false },
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
      { name: '📢 Channel',      value: sc.channel ? `<#${sc.channel}>` : '*Not set*', inline: true },
      { name: '👥 Ping Roles',   value: sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔑 Allowed',      value: sc.allowedRoles?.length ? sc.allowedRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔗 Join Link',    value: sc.joinLink ?? '*Not set*', inline: false },
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
function buildAnnouncementOverview(guildId) {
  const ac = getAnnouncementConfig(guildId);
  const types = Object.entries(ac.types);
  const embed = new EmbedBuilder().setTitle('📣 Announcement System Setup').setColor(0xED4245)
    .setDescription(types.length === 0 ? '*No types yet.*' : types.map(([tid, t]) => `**${t.emoji || '📢'} ${t.name}** \`[${tid}]\`\nChannel: ${t.channel ? `<#${t.channel}>` : '❌'} | Ping: ${t.pingRole ? `<@&${t.pingRole}>` : 'None'}`).join('\n\n'));
  const btns = [new ButtonBuilder().setCustomId('an_new').setLabel('New Type').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (types.length) btns.push(new ButtonBuilder().setCustomId('an_edit').setLabel('Edit Type').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('an_delete').setLabel('Delete Type').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}
function buildAnnouncementEditor(guildId, typeId) {
  const ac = getAnnouncementConfig(guildId);
  const t = ac.types[typeId];
  if (!t) return buildAnnouncementOverview(guildId);
  const embed = new EmbedBuilder().setTitle(`✏️ Editing — ${t.emoji || '📢'} ${t.name}`).setColor(hexToInt(t.color))
    .addFields({ name: '📛 Name', value: t.name, inline: true }, { name: '📢 Channel', value: t.channel ? `<#${t.channel}>` : '*Not set*', inline: true }, { name: '🔔 Ping', value: t.pingRole ? `<@&${t.pingRole}>` : '*None*', inline: true });
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ane__content__${typeId}`).setLabel('Edit Content').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`ane__channel__${typeId}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId(`ane__pingrole__${typeId}`).setLabel('Set Ping Role').setStyle(ButtonStyle.Primary).setEmoji('🔔'),
    new ButtonBuilder().setCustomId(`ane__clearping__${typeId}`).setLabel('Clear Ping').setStyle(ButtonStyle.Secondary).setEmoji('🚫'),
  );
  const r2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('an__back').setLabel('← Back').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}
function buildSelfRoleOverview(guildId) {
  const src = getSelfRoleConfig(guildId);
  const panels = Object.entries(src.panels);
  const embed = new EmbedBuilder().setTitle('🎨 Self Role Setup').setColor(0xEB459E)
    .setDescription(panels.length === 0 ? '*No panels yet.*' : panels.map(([pid, p]) => `**${p.title}** \`[${pid}]\` — ${p.roles.length} roles | ch: ${p.channel ? `<#${p.channel}>` : '❌'}`).join('\n'));
  const btns = [new ButtonBuilder().setCustomId('sr_new').setLabel('New Panel').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (panels.length) btns.push(new ButtonBuilder().setCustomId('sr_edit').setLabel('Edit Panel').setStyle(ButtonStyle.Primary).setEmoji('✏️'), new ButtonBuilder().setCustomId('sr_delete').setLabel('Delete Panel').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}
function buildPanelEditor(guildId, panelId) {
  const src = getSelfRoleConfig(guildId);
  const p = src.panels[panelId];
  const embed = new EmbedBuilder().setTitle(`✏️ Editing — ${p.title}`).setColor(hexToInt(p.color))
    .addFields({ name: '📛 Title', value: p.title, inline: true }, { name: '🔀 Type', value: p.type || 'buttons', inline: true }, { name: '📢 Channel', value: p.channel ? `<#${p.channel}>` : '*Not set*', inline: true }, { name: '🎭 Roles', value: p.roles.length ? p.roles.map(r => `${r.emoji || '•'} <@&${r.id}> — \`${r.label}\``).join('\n') : '*No roles yet*', inline: false });
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sre__embed__${panelId}`).setLabel('Edit Embed').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
    new ButtonBuilder().setCustomId(`sre__channel__${panelId}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId(`sre__addrole__${panelId}`).setLabel('Add Role').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId(`sre__removerole__${panelId}`).setLabel('Remove Role').setStyle(ButtonStyle.Danger).setEmoji('➖'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sre__deploy__${panelId}`).setLabel('Deploy').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('sr__back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

async function deploySelfRolePanel(guild, panelId, panel) {
  const channel = await guild.channels.fetch(panel.channel).catch(() => null);
  if (!channel) throw new Error('Channel not found');
  const embed = new EmbedBuilder().setTitle(panel.title).setDescription(panel.description || 'Select your roles below.').setColor(hexToInt(panel.color)).setFooter({ text: panel.type === 'reaction' ? 'React to get a role' : 'Click to toggle your role' });
  if (panel.thumbnail) embed.setThumbnail(panel.thumbnail);
  if (panel.type === 'reaction') { const msg = await channel.send({ embeds: [embed] }); for (const role of panel.roles) { if (role.reaction) await msg.react(role.reaction).catch(() => {}); } panel.messageId = msg.id; return; }
  if (panel.type === 'dropdown') {
    const options = panel.roles.slice(0, 25).map(r => { const opt = { label: r.label.slice(0, 100), value: r.id, description: `Toggle ${r.label}`.slice(0, 100) }; if (r.emoji) opt.emoji = r.emoji; return opt; });
    const maxVals = panel.max > 0 ? Math.min(panel.max, options.length) : options.length;
    const select = new StringSelectMenuBuilder().setCustomId(`srp__dd__${panelId}`).setPlaceholder('Choose your roles…').setMinValues(0).setMaxValues(maxVals).addOptions(options);
    const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] }); panel.messageId = msg.id; return;
  }
  const rows = [];
  for (let i = 0; i < Math.min(panel.roles.length, 25); i += 5) {
    const chunk = panel.roles.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(chunk.map(r => safeSetEmoji(new ButtonBuilder().setCustomId(`srp__btn__${panelId}__${r.id}`).setLabel(r.label.slice(0, 80)).setStyle(ButtonStyle.Secondary), r.emoji))));
  }
  const msg = await channel.send({ embeds: [embed], components: rows }); panel.messageId = msg.id;
}
async function postSessionStart(guild, sc, hostUser, rawLink, vars, voterMentions = null) {
  const sCh = guild.channels.cache.get(sc.channel);
  if (!sCh) throw new Error('Session channel not found');
  const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
  const desc = replaceVars(sc.startDescription ?? '{hostMention} has started a session! Join using the button below.', vars);
  const embed = new EmbedBuilder().setTitle('🟢 Session Started!').setColor(0x57F287).setDescription(desc).setTimestamp().setFooter({ text: `By ${hostUser.tag}` });
  if (sc.startImage) embed.setImage(sc.startImage);
  const comps = [];
  if (isValidUrl(rawLink)) comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(rawLink.trim())));

  // Bouw content: ping roles + voters (als ze er zijn)
  let content = ping ?? '';
  if (voterMentions) content = content ? `${content}\n🗳️ **Voters:** ${voterMentions}` : `🗳️ **Voters:** ${voterMentions}`;

  await sCh.send({ content: content || undefined, embeds: [embed], components: comps });
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
    { name: 'channel', type: 7, description: 'Channel', required: true }, { name: 'title', type: 3, description: 'Title', required: true },
    { name: 'description', type: 3, description: 'Description', required: true }, { name: 'color', type: 3, description: 'Hex color', required: false },
    { name: 'image', type: 3, description: 'Image URL', required: false }, { name: 'footer', type: 3, description: 'Footer', required: false },
  ]},
  { name: 'giveaway', description: '[SHR] Start giveaway', options: [
    { name: 'channel', type: 7, description: 'Channel', required: true }, { name: 'prize', type: 3, description: 'Prize', required: true },
    { name: 'minutes', type: 4, description: 'Duration (minutes)', required: true }, { name: 'winners', type: 4, description: 'Winners', required: true },
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
  { name: 'setup', description: '[SHR] Setup bot features', options: [
    { name: 'tickets', type: 1, description: 'Ticket system' },
    { name: 'sessions', type: 1, description: 'Session system' },
    { name: 'selfroles', type: 1, description: 'Self role system' },
    { name: 'announcements', type: 1, description: 'Announcement system' },
    { name: 'welcomer', type: 1, description: 'Welcome message system' },
    { name: 'autorole', type: 1, description: 'Auto role system' },
    { name: 'verification', type: 1, description: 'Roblox verification system' },
    { name: 'applications', type: 1, description: 'Application system' },
    { name: 'savedmessages', type: 1, description: 'Saved messages system' },
    { name: 'automod', type: 1, description: 'Automod keyword filter' },
    { name: 'counters', type: 1, description: 'Member counter channels' },
    { name: 'training', type: 1, description: 'Training request system' },
    { name: 'erlclogs', type: 1, description: 'ERLC log channels' },
    { name: 'execrequest', type: 1, description: 'Executive request system' },
    { name: 'founderrequest', type: 1, description: 'Foundership request system' },
    { name: 'roleperms', type: 1, description: 'Role permission system' },
    { name: 'commandlist', type: 1, description: 'Auto-updating command list' },
    { name: 'handbooks', type: 1, description: 'Handbook panel system' },
  ]},
];

// ════════════════════════════════════════════
// READY
// ════════════════════════════════════════════
client.once('clientReady', async () => {
  console.log(`✅ Bot online as ${client.user.tag} | DB: ${dbReady ? '✅ Verbonden' : '❌ Niet verbonden'}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try { await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); console.log('✅ Commands registered'); }
  catch (e) { console.error('❌ Command registration failed:', e); }
  for (const guild of client.guilds.cache.values()) { await updateCounters(guild).catch(console.error); }

  // ════ ERLC LOG POLLING ════
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const ec = getErlcLogConfig(guild.id);
        if (!ec.enabled) continue;

        if (!erlcState.has(guild.id)) {
          erlcState.set(guild.id, { players: new Set(), kills: new Set(), modCalls: new Set(), cmds: new Set(), bans: new Set() });
        }
        const state = erlcState.get(guild.id);

        // ── Join/Leave logs ──
        if (ec.joinLeave) {
          const ch = guild.channels.cache.get(ec.joinLeave);
          if (ch) {
            const players = await erlcRequest('/server/players', 'GET', null, guild.id).catch(() => null);
            if (players) {
              const current = new Set(Object.keys(players));
              // Joined
              for (const id of current) {
                if (!state.players.has(id)) {
                  const p = players[id];
                  await ch.send({ embeds: [new EmbedBuilder().setTitle('📥 Player Joined').setColor(0x57F287).addFields({ name: '👤 Player', value: p.Player, inline: true }, { name: '🎭 Team', value: p.Team || 'None', inline: true }).setTimestamp()] }).catch(() => {});
                }
              }
              // Left
              for (const id of state.players) {
                if (!current.has(id)) {
                  await ch.send({ embeds: [new EmbedBuilder().setTitle('📤 Player Left').setColor(0xED4245).addFields({ name: '👤 Player', value: id, inline: true }).setTimestamp()] }).catch(() => {});
                }
              }
              state.players = current;
            }
          }
        }

        // ── Kill logs ──
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
              // Houd state klein
              if (state.kills.size > 500) state.kills = new Set([...state.kills].slice(-200));
            }
          }
        }

        // ── Command logs ──
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

        // ── Mod call logs ──
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

        // ── Kick/Ban logs ──
        if (ec.kickBans) {
          const ch = guild.channels.cache.get(ec.kickBans);
          if (ch) {
            const bans = await erlcRequest('/server/bans', 'GET', null, guild.id).catch(() => null);
            if (bans) {
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

      } catch (e) { /* silently skip guild on error */ }
    }
  }, 30_000); // Poll elke 30 seconden
});


client.on('guildMemberAdd', async member => { await updateCounters(member.guild).catch(console.error); });
client.on('guildMemberRemove', async member => { await updateCounters(member.guild).catch(console.error); });

// ════════════════════════════════════════════
// DM MESSAGE — APPLICATION Q&A
// ════════════════════════════════════════════
client.on('messageCreate', async message => {
  // Only handle DMs from non-bots
  if (message.author.bot) return;
  if (message.guild) return; // Ignore guild messages here — handle in automod listener

  const userId = message.author.id;
  const session = activeAppSessions.get(userId);
  if (!session) return; // Not in an application session

  const content = message.content.trim();

  // Cancel command
  if (content.toLowerCase() === 'cancel') {
    activeAppSessions.delete(userId);
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Application Cancelled').setDescription('Your application has been cancelled. You can start a new one at any time.')] });
    return;
  }

  // Validate session data still exists in config
  const ac = getApplicationConfig(session.guildId);
  const appType = ac.appTypes.find(t => t.id === session.typeId);
  if (!appType) {
    activeAppSessions.delete(userId);
    await message.channel.send('❌ This application type no longer exists. Your session has been cancelled.');
    return;
  }

  // Record the answer
  if (content.length > 12000) {
    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ **Answer too long!** Max 12,000 characters. Your answer was ${content.length} characters.\n\nPlease shorten your answer and try again.`)] });
    return;
  }
  session.answers.push(content);
  const nextIndex = session.questionIndex + 1;

  if (nextIndex < appType.questions.length) {
    // More questions remain
    session.questionIndex = nextIndex;

    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ **Answer recorded!**`).setFooter({ text: `${nextIndex}/${appType.questions.length} answered` })] });

    // Send next question
    const sent = await sendNextQuestion(userId, session, appType);
    if (!sent) {
      activeAppSessions.delete(userId);
    }
  } else {
    // All questions answered — submit
    activeAppSessions.delete(userId);

    await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('⏳ Submitting…').setDescription('All questions answered! Submitting your application…')] });

    try {
      const guild = await client.guilds.fetch(session.guildId).catch(() => null);
      if (!guild) throw new Error('Server not found.');

      const appId = await submitApplication(userId, session, appType, guild);

      await message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('✅ Application Submitted!')
        .setColor(0x57F287)
        .setDescription(`Your **${appType.label}** application has been submitted for review.\n\nYou will receive a DM when a decision has been made.\n\n**Application ID:** \`${appId}\``)
        .setTimestamp()] });

      // Log
      const logChId = ac.logChannel;
      if (logChId) {
        const logCh = guild.channels.cache.get(logChId);
        if (logCh) {
          await logCh.send({ embeds: [new EmbedBuilder().setTitle('📋 Application Submitted').setColor(0x5865F2)
            .addFields(
              { name: '👤 Applicant', value: `<@${userId}>`, inline: true },
              { name: '📝 Type',      value: appType.label,  inline: true },
              { name: '🆔 App ID',    value: appId,           inline: true },
            ).setTimestamp()] });
        }
      }
    } catch (e) {
      console.error('App submit error:', e);
      await message.channel.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Submission Failed').setDescription(`Could not submit your application: **${e.message}**\n\nPlease contact a staff member.`)] });
    }
  }
});

// ════════════════════════════════════════════
// AUTOMOD — GUILD MESSAGE CREATE
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
    if (am.logChannel) { const logCh = message.guild.channels.cache.get(am.logChannel); if (logCh) await logCh.send({ embeds: [logEmbed] }); }
  } catch (e) { console.error('Automod error:', e); }
});

// ════════════════════════════════════════════
// GUILD MEMBER ADD (welcomer + autorole)
// ════════════════════════════════════════════
client.on('guildMemberAdd', async member => {
  const guildId = member.guild.id;
  try {
    const ar = getAutoroleConfig(guildId);
    if (ar.enabled && ar.roles.length) {
      const roles = ar.roles.map(id => member.guild.roles.cache.get(id)).filter(Boolean);
      if (roles.length) await member.roles.add(roles);
    }
  } catch (e) { console.error('Autorole error:', e); }
  try {
    const wc = getWelcomerConfig(guildId);
    if (!wc.enabled || !wc.channel) return;
    const ch = member.guild.channels.cache.get(wc.channel);
    if (!ch) return;
    const vars = { userMention: `<@${member.user.id}>`, username: member.user.username, userTag: member.user.tag, memberCount: member.guild.memberCount.toString(), server: member.guild.name };
    const embed = new EmbedBuilder().setTitle(replaceVars(wc.title, vars)).setDescription(replaceVars(wc.description, vars)).setColor(hexToInt(wc.color)).setTimestamp();
    if (wc.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
    if (wc.image) embed.setImage(wc.image);
    if (wc.footer) embed.setFooter({ text: replaceVars(wc.footer, vars) });
    await ch.send({ content: wc.pingUser ? `<@${member.user.id}>` : undefined, embeds: [embed] });
  } catch (e) { console.error('Welcomer error:', e); }
});

// ════════════════════════════════════════════
// REACTION EVENTS
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
        for (const role of panel.roles) { if (role.reaction && role.reaction === reaction.emoji.toString()) { targetPanel = panel; targetRole = role; break; } }
        if (targetRole) break;
      }
    }
    if (!targetRole) return;
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(targetRole.id);
    if (!role) return;
    if (targetPanel.max > 0) {
      const count = targetPanel.roles.filter(r => member.roles.cache.has(r.id)).length;
      if (count >= targetPanel.max && !member.roles.cache.has(role.id)) { await reaction.users.remove(user.id).catch(() => {}); return user.send(`❌ Max ${targetPanel.max} role(s).`).catch(() => {}); }
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
        for (const role of panel.roles) { if (role.reaction && role.reaction === reaction.emoji.toString()) { targetRole = role; break; } }
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
// INTERACTIONS
// ════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;
  if (!guildId) { try { if (interaction.isRepliable()) await interaction.reply({ content: '❌ Server only.', flags: MessageFlags.Ephemeral }); } catch {} return; }

  try {

    // ══ SLASH COMMANDS ══
    if (interaction.isUserContextMenuCommand() && interaction.commandName === 'Roblox Profile') {
      const targetUser = interaction.targetUser;
      const vc = getVerificationConfig(guildId);
      const data = vc.verifiedUsers?.[targetUser.id];
      if (!data) return interaction.reply({ content: `❌ **${targetUser.username}** has not verified their Roblox account.`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('🎮 Roblox Profile')
        .setColor(0x5865F2)
        .setThumbnail(`https://www.roblox.com/headshot-thumbnail/image?userId=${data.robloxId}&width=420&height=420&format=png`)
        .addFields(
          { name: '👤 Discord', value: `<@${targetUser.id}>`, inline: true },
          { name: '🎮 Roblox', value: data.robloxUsername, inline: true },
          { name: '🆔 Roblox ID', value: `${data.robloxId}`, inline: true },
          { name: '📅 Verified', value: new Date(data.verifiedAt).toUTCString(), inline: false },
          { name: '🔗 Profile', value: `[Click here](https://www.roblox.com/users/${data.robloxId}/profile)`, inline: true },
        ).setTimestamp()
      ], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const user = interaction.options.getUser('user') ?? null;
      const member = user ? interaction.options.getMember('user') : null;
      const reason = interaction.options.getString('reason') ?? 'No reason provided';

      if (cmd === 'ping') { const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true }); return interaction.editReply(`🏓 Pong! Bot: ${sent.createdTimestamp - interaction.createdTimestamp}ms | API: ${client.ws.ping}ms`); }
      if (cmd === 'avatar') { const t = interaction.options.getUser('user') ?? interaction.user; return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🖼️ ${t.username}'s Avatar`).setImage(t.displayAvatarURL({ size: 1024, dynamic: true })).setColor(0x5865F2)] }); }
      if (cmd === 'serverinfo') {
        const g = interaction.guild; await g.fetch(); const owner = await g.fetchOwner();
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📊 ${g.name}`).setThumbnail(g.iconURL({ dynamic: true })).setColor(0x5865F2).addFields({ name: '👑 Owner', value: owner.user.tag, inline: true }, { name: '👥 Members', value: `${g.memberCount}`, inline: true }, { name: '📅 Created', value: g.createdAt.toDateString(), inline: true }, { name: '💬 Channels', value: `${g.channels.cache.size}`, inline: true }, { name: '🎭 Roles', value: `${g.roles.cache.size}`, inline: true }).setTimestamp()] });
      }
      if (cmd === 'roleinfo') { const role = interaction.options.getRole('role'); return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🎭 ${role.name}`).setColor(role.color || 0x5865F2).addFields({ name: '🆔 ID', value: role.id, inline: true }, { name: '🎨 Color', value: role.hexColor, inline: true }, { name: '👥 Members', value: `${role.members.size}`, inline: true }).setTimestamp()] }); }
      if (cmd === 'poll') {
        const question = interaction.options.getString('question');
        const opts = [interaction.options.getString('option1'), interaction.options.getString('option2'), interaction.options.getString('option3'), interaction.options.getString('option4')].filter(Boolean);
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const embed = new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(opts.map((o, i) => `${emojis[i]} ${o}`).join('\n\n')).setColor(0x5865F2).setFooter({ text: `Poll by ${interaction.user.tag}` }).setTimestamp();
        const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
        for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]);
      }
      if (cmd === 'userinfo') {
        const tu = interaction.options.getUser('user'); const tm = interaction.options.getMember('user');
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`👤 ${tu.tag}`).setThumbnail(tu.displayAvatarURL({ dynamic: true })).setColor(0x5865F2).addFields({ name: '🆔 ID', value: tu.id, inline: true }, { name: '📅 Created', value: tu.createdAt.toDateString(), inline: true }, { name: '📥 Joined', value: tm?.joinedAt?.toDateString() ?? 'Unknown', inline: true }, { name: '🎭 Roles', value: tm?.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None', inline: false }).setTimestamp()] });
      }
      if (cmd === 'warn') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await addWarning(guildId, user.id, { reason, moderator: interaction.user.tag, date: new Date().toUTCString() });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⚠️ Warning Issued').setColor(0xFEE75C).addFields({ name: 'User', value: user.tag, inline: true }, { name: 'Warnings', value: `${getWarnings(guildId, user.id).length}`, inline: true }, { name: 'Reason', value: reason }).setTimestamp()] });
      }
      if (cmd === 'mute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await member.timeout(interaction.options.getInteger('minutes') * 60000, reason);
        return interaction.reply(`🔇 **${user.tag}** muted. Reason: ${reason}`);
      }
      if (cmd === 'unmute') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await member.timeout(null); return interaction.reply(`🔊 **${user.tag}** unmuted.`); }
      if (cmd === 'slowmode') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); const s = interaction.options.getInteger('seconds'); await interaction.channel.setRateLimitPerUser(s); return interaction.reply(`✅ Slowmode: **${s}s**.`); }
      if (cmd === 'lock')   { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }); return interaction.reply('🔒 Channel **locked**.'); }
      if (cmd === 'unlock') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: true }); return interaction.reply('🔓 Channel **unlocked**.'); }
      if (cmd === 'clear')  { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const del = await interaction.channel.bulkDelete(Math.min(interaction.options.getInteger('amount'), 100), true); return interaction.editReply({ content: `✅ Deleted **${del.size}** messages.` }); }

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
        // Check of gebruiker de juiste rol heeft
        if (tc.requestRoles.length && !tc.requestRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: '❌ You do not have permission to request a trainer.', flags: MessageFlags.Ephemeral });
        }
        // Cooldown check (1 uur)
        const cdKey = `${guildId}:${interaction.user.id}`;
        const lastUsed = trainRequestCooldowns.get(cdKey);
        if (lastUsed) {
          const remaining = 60 * 60 * 1000 - (Date.now() - lastUsed);
          if (remaining > 0) {
            const mins = Math.ceil(remaining / 60000);
            return interaction.reply({ content: `⏳ You can request a trainer again in **${mins} minute${mins !== 1 ? 's' : ''}**.`, flags: MessageFlags.Ephemeral });
          }
        }
        if (!tc.channel) return interaction.reply({ content: '❌ Training request channel not set up. Ask an admin to run `/setup training`.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_trainrequest').setTitle('Training Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_times').setLabel('When are you available? (times/timezone)').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Monday 5-8PM EST, Wednesday 6-9PM EST').setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_notes').setLabel('Anything else the trainer should know?').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. I have done 2 ride-alongs already').setRequired(false).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }

      if (cmd === 'send') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_send').setTitle('Send Message');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('send_content').setLabel('Message').setStyle(TextInputStyle.Paragraph).setPlaceholder('Paste your ad here...').setRequired(true).setMaxLength(4000)
          )
        );
        return interaction.showModal(modal);
      }

      if (cmd === 'sendmessage') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const sm = getSavedMessagesConfig(guildId);
        const msgs = Object.entries(sm.messages);
        if (!msgs.length) return interaction.reply({ content: '❌ No saved messages yet.', flags: MessageFlags.Ephemeral });
        pendingSendMsgChannel.set(interaction.user.id, interaction.channel.id);
        const options = msgs.slice(0, 25).map(([mid, m]) => ({ label: m.name.slice(0, 100), value: mid, emoji: m.emoji || undefined }));
        const sel = new StringSelectMenuBuilder().setCustomId('sendmsg_pick').setPlaceholder('Select a saved message...').addOptions(options);
        return interaction.reply({ content: `### 📨 Select a message to send in <#${interaction.channel.id}>`, components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'ban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        let deletedMessages = 0, deletedThreads = 0;
        try {
          for (const [, ch] of interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)) {
            try { const msgs = await ch.messages.fetch({ limit: 100 }); const userMsgs = msgs.filter(m => m.author.id === user.id); if (userMsgs.size > 0) { await ch.bulkDelete(userMsgs, true).catch(async () => { for (const [, m] of userMsgs) await m.delete().catch(() => {}); }); deletedMessages += userMsgs.size; } } catch {}
          }
          for (const [, thread] of interaction.guild.channels.cache.filter(c => [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(c.type))) {
            try { if (thread.ownerId === user.id) { await thread.delete().catch(() => {}); deletedThreads++; } } catch {}
          }
        } catch (e) { console.error('Ban cleanup error:', e); }
        await interaction.guild.members.ban(user, { reason, deleteMessageSeconds: 604800 });
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔨 User Banned').setColor(0xED4245).addFields({ name: 'User', value: user.tag, inline: true }, { name: 'Reason', value: reason, inline: true }, { name: '🗑️ Messages', value: `${deletedMessages}`, inline: true }, { name: '🧵 Threads', value: `${deletedThreads}`, inline: true }).setTimestamp()] });
      }
      if (cmd === 'unban')    { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); const uid = interaction.options.getString('userid'); await interaction.guild.members.unban(uid, reason); return interaction.reply(`✅ **${uid}** unbanned.`); }
      if (cmd === 'softban')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.guild.members.ban(user, { reason, deleteMessageSeconds: 604800 }); await interaction.guild.members.unban(user.id, 'Softban'); return interaction.reply(`🪃 **${user.tag}** softbanned.`); }
      if (cmd === 'tempban')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); const hours = interaction.options.getInteger('hours'); await interaction.guild.members.ban(user, { reason }); setTimeout(async () => { await interaction.guild.members.unban(user.id, 'Tempban expired').catch(() => {}); }, hours * 3600000); return interaction.reply(`⏱️ **${user.tag}** banned for **${hours} hours**.`); }
      if (cmd === 'kick')     { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await member.kick(reason); return interaction.reply(`👢 **${user.tag}** kicked.`); }
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
        if (added.length)    msg += `✅ Added: **${added.join(', ')}**\n`;
        if (denied.length)   msg += `❌ No permission: **${denied.join(', ')}**\n`;
        if (notFound.length) msg += `⚠️ Not found: **${notFound.join(', ')}**`;
        return interaction.reply({ content: msg.trim(), ephemeral: false });
      }
      if (cmd === 'nickname') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); const nick = interaction.options.getString('nickname') ?? null; await member.setNickname(nick); return interaction.reply(nick ? `✅ Nickname set to **${nick}**.` : `✅ Nickname reset.`); }
      if (cmd === 'promote') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const role = interaction.options.getRole('role');
        if (member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ Already has **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.add(role, reason);
        await sendPromotionAnnounce(interaction.guild, user, role.name, interaction.user, 'promotion');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⬆️ User Promoted').setColor(0x57F287).addFields({ name: '👤 User', value: user.tag, inline: true }, { name: '🎭 Role', value: role.name, inline: true }, { name: '📝 Reason', value: reason, inline: false }, { name: '👮 By', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
      if (cmd === 'demote') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const role = interaction.options.getRole('role');
        if (!member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ Does not have **${role.name}**.`, flags: MessageFlags.Ephemeral });
        await member.roles.remove(role, reason);
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⬇️ User Demoted').setColor(0xED4245).addFields({ name: '👤 User', value: user.tag, inline: true }, { name: '🎭 Role', value: role.name, inline: true }, { name: '📝 Reason', value: reason, inline: false }, { name: '👮 By', value: interaction.user.tag, inline: true }).setTimestamp()] });
      }
      if (cmd === 'executiverequest') {
        const ec = getExecRequestConfig(guildId);
        if (!ec.channel) return interaction.reply({ content: '❌ Executive request channel not set up. Ask an admin to configure it.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_execrequest').setTitle('Executive Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_action').setLabel('Action (e.g. Demotion / Termination)').setStyle(TextInputStyle.Short).setPlaceholder('Demotion').setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_person').setLabel('Person concerned (name + rank)').setStyle(TextInputStyle.Short).setPlaceholder('John Doe — Senior Executive').setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exec_reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('Explain why this action is needed...').setRequired(true).setMaxLength(1000)),
        );
        return interaction.showModal(modal);
      }

      if (cmd === 'foundationrequest') {
        const fc = getFounderRequestConfig(guildId);
        if (!fc.channel) return interaction.reply({ content: '❌ Foundership request channel not set up. Ask an admin to configure it.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_founderrequest').setTitle('Foundership Request');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_action').setLabel('Action (e.g. Demotion / Termination)').setStyle(TextInputStyle.Short).setPlaceholder('Demotion').setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_person').setLabel('Person concerned (name + rank)').setStyle(TextInputStyle.Short).setPlaceholder('John Doe — Co-Founder').setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('founder_reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('Explain why this action is needed...').setRequired(true).setMaxLength(1000)),
        );
        return interaction.showModal(modal);
      }

      if (cmd === 'removeverifiedroles') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        if (!vc.verifiedRole) return interaction.reply({ content: '❌ No verified role set up.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const role = interaction.guild.roles.cache.get(vc.verifiedRole);
        if (!role) return interaction.editReply('❌ Verified role not found.');
        const members = await interaction.guild.members.fetch().catch(() => null);
        if (!members) return interaction.editReply('❌ Could not fetch members.');
        let removed = 0, failed = 0;
        for (const [, member] of members) {
          if (member.user.bot) continue;
          if (!member.roles.cache.has(vc.verifiedRole)) continue;
          try { await member.roles.remove(vc.verifiedRole, 'Mass unverify by staff'); removed++; }
          catch { failed++; }
          await new Promise(r => setTimeout(r, 300));
        }
        return interaction.editReply({ content: `✅ Done!\n**Removed:** ${removed}\n**Failed:** ${failed}` });
      }

      if (cmd === 'erlcconfig') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        const ec = getErlcLogConfig(guildId);
        const modal = new ModalBuilder().setCustomId('modal_erlcconfig').setTitle('ERLC Server Key');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('erlc_server_key').setLabel('ERLC Server Key').setStyle(TextInputStyle.Short).setValue(ec.serverKey || '').setPlaceholder('Paste your ERLC server key here...').setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (cmd === 'warnings') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral }); const warns = getWarnings(guildId, user.id); if (!warns.length) return interaction.reply({ content: `✅ No warnings.`, flags: MessageFlags.Ephemeral }); return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`⚠️ Warnings — ${user.tag}`).setColor(0xFEE75C).setDescription(warns.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.moderator}*`).join('\n'))] }); }
      if (cmd === 'clearwarnings') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await clearWarnings(guildId, user.id); return interaction.reply(`✅ Cleared warnings for **${user.tag}**.`); }
      if (cmd === 'note')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await addNote(guildId, user.id, { text: interaction.options.getString('text'), moderator: interaction.user.tag, date: new Date().toUTCString() }); return interaction.reply({ content: `✅ Note added.`, flags: MessageFlags.Ephemeral }); }
      if (cmd === 'notes') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); const notes = getNotes(guildId, user.id); if (!notes.length) return interaction.reply({ content: `📝 No notes.`, flags: MessageFlags.Ephemeral }); return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`📝 Notes — ${user.tag}`).setColor(0x5865F2).setDescription(notes.map((n, i) => `**${i + 1}.** ${n.text} — *${n.moderator}*`).join('\n'))] }); }

      if (cmd === 'announce') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ac = getAnnouncementConfig(guildId);
        const types = Object.entries(ac.types);
        if (!types.length) return interaction.reply({ content: '❌ No announcement types. Use `/setup announcements`.', flags: MessageFlags.Ephemeral });
        pendingAnnounceChannel.set(interaction.user.id, interaction.channel.id);
        const sel = new StringSelectMenuBuilder().setCustomId('announce_pick').setPlaceholder('Select type...').addOptions(types.slice(0, 25).map(([tid, t]) => ({ label: `${t.emoji ? t.emoji + ' ' : ''}${t.name}`.slice(0, 100), value: tid })));
        return interaction.reply({ content: `### 📣 Select announcement type`, components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'embed') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.options.getChannel('channel');
        const embed = new EmbedBuilder().setTitle(interaction.options.getString('title')).setDescription(interaction.options.getString('description')).setColor(hexToInt(interaction.options.getString('color') ?? '#5865F2'));
        const img = interaction.options.getString('image'); const footer = interaction.options.getString('footer');
        if (img) embed.setImage(img); if (footer) embed.setFooter({ text: footer });
        await ch.send({ embeds: [embed] }); return interaction.reply({ content: `✅ Sent!`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'giveaway') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.options.getChannel('channel'); const prize = interaction.options.getString('prize');
        const minutes = interaction.options.getInteger('minutes'); const winners = interaction.options.getInteger('winners');
        const endsAt = new Date(Date.now() + minutes * 60000);
        const embed = new EmbedBuilder().setTitle('🎉 GIVEAWAY 🎉').setColor(0xEB459E).setDescription(`**Prize:** ${prize}\n\nReact with 🎉 to enter!\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>`).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp(endsAt);
        const msg = await ch.send({ embeds: [embed] }); await msg.react('🎉');
        setTimeout(async () => {
          try {
            const gMsg = await ch.messages.fetch(msg.id); const reaction = gMsg.reactions.cache.get('🎉');
            if (!reaction) return;
            const users = await reaction.users.fetch(); const entries = users.filter(u => !u.bot);
            if (!entries.size) return ch.send('🎉 No valid entries!');
            const picked = entries.random(Math.min(winners, entries.size));
            const winnerMentions = (Array.isArray(picked) ? picked : [picked]).map(u => `<@${u.id}>`).join(', ');
            await ch.send({ embeds: [new EmbedBuilder().setTitle('🎉 Giveaway Ended!').setColor(0xEB459E).setDescription(`**Prize:** ${prize}\n**Winners:** ${winnerMentions} 🎊`).setTimestamp()] });
          } catch (e) { console.error('Giveaway error:', e); }
        }, minutes * 60000);
        return interaction.reply({ content: `✅ Giveaway started!`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'punish') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const t = interaction.options.getString('type');
        if (t === 'warn') { await addWarning(guildId, user.id, { reason, moderator: interaction.user.tag, date: new Date().toUTCString() }); return interaction.reply(`⚠️ **${user.tag}** warned.`); }
        if (t === 'mute') { await member.timeout(600000, reason); return interaction.reply(`🔇 **${user.tag}** muted 10min.`); }
        if (t === 'kick') { await member.kick(reason); return interaction.reply(`👢 **${user.tag}** kicked.`); }
        if (t === 'ban')  { await interaction.guild.members.ban(user, { reason }); return interaction.reply(`🔨 **${user.tag}** banned.`); }
      }
      if (cmd === 'players') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); try { const data = await erlcRequest('/server/players'); const list = Object.values(data); if (!list.length) return interaction.editReply('No players.'); return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`👥 Players (${list.length})`).setDescription(list.map((p, i) => `${i + 1}. **${p.Player}** — ${p.Team || 'None'}`).join('\n').slice(0, 4000)).setColor(0x5865F2)] }); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'serverstatus') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); try { const d = await erlcRequest('/server'); return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🖥️ ERLC Status').setColor(0x57F287).addFields({ name: 'Name', value: d.Name || 'Unknown', inline: true }, { name: 'Players', value: `${d.CurrentPlayers ?? 0}/${d.MaxPlayers ?? 0}`, inline: true }, { name: 'Key', value: d.JoinKey || 'N/A', inline: true }).setTimestamp()] }); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'erlckick') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const u = interaction.options.getString('username'); try { await erlcRequest('/server/command', 'POST', { command: `:kick ${u}` }); return interaction.editReply(`✅ **${u}** kicked from ERLC.`); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'erlcban')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const u = interaction.options.getString('username'); try { await erlcRequest('/server/command', 'POST', { command: `:ban ${u}` }); return interaction.editReply(`✅ **${u}** banned from ERLC.`); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }

      if (cmd === 'session') {
        if (!canRunSession(interaction.member, guildId)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        const sc = getSessionConfig(guildId);
        if (!sc.channel) return interaction.reply({ content: '❌ Session channel not set.', flags: MessageFlags.Ephemeral });
        const sCh = interaction.guild.channels.cache.get(sc.channel);
        if (!sCh) return interaction.reply({ content: '❌ Session channel not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const vars = { userMention: `<@${interaction.user.id}>`, username: interaction.user.username, userTag: interaction.user.tag, memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
        if (sub === 'start') { const rawLink = interaction.options.getString('link') ?? sc.joinLink ?? null; try { await postSessionStart(interaction.guild, sc, interaction.user, rawLink, vars); return interaction.editReply({ content: `✅ Session started!` }); } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); } }
        if (sub === 'vote') {
          const threshold = interaction.options.getInteger('votes') ?? sc.voteThreshold ?? 5;
          const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
          const embed = new EmbedBuilder().setTitle('🗳️ Session Vote!').setColor(0xFEE75C).setDescription(`${replaceVars(sc.voteDescription ?? '**{host}** wants to host a session!\n\nClick the button below to vote!', vars)}\n\n**Votes: 0/${threshold}**`).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.voteImage) embed.setImage(sc.voteImage);
          const voteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('session__vote').setLabel('Vote ✅').setStyle(ButtonStyle.Success),
          );
          const msg = await sCh.send({ content: ping ?? undefined, embeds: [embed], components: [voteRow] });
          activeVotes.set(guildId, { messageId: msg.id, channelId: sCh.id, hostId: interaction.user.id, threshold, joinLink: sc.joinLink ?? null, voters: [] });
          // Auto-delete vote bericht na 30 minuten als het niet geslaagd is
          setTimeout(async () => {
            if (activeVotes.get(guildId)?.messageId === msg.id) {
              activeVotes.delete(guildId);
              await msg.delete().catch(() => {});
            }
          }, 30 * 60 * 1000);
          return interaction.editReply({ content: `✅ Vote posted! Auto-starts at **${threshold}** votes. Deletes in 30 minutes if not reached.` });
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
        const sub = interaction.options.getSubcommand();
        if (sub === 'tickets')       return interaction.reply(buildTicketSetupPayload(guildId));
        if (sub === 'sessions')      return interaction.reply(buildSessionSetupPayload(guildId));
        if (sub === 'selfroles')     return interaction.reply(buildSelfRoleOverview(guildId));
        if (sub === 'announcements') return interaction.reply(buildAnnouncementOverview(guildId));
        if (sub === 'welcomer')      return interaction.reply(buildWelcomerSetupPayload(guildId));
        if (sub === 'autorole')      return interaction.reply(buildAutoroleSetupPayload(guildId));
        if (sub === 'verification')  return interaction.reply(buildVerificationSetupPayload(guildId));
        if (sub === 'applications')  return interaction.reply(buildApplicationSetupPayload(guildId));
        if (sub === 'savedmessages') return interaction.reply(buildSavedMessagesPayload(guildId));
        if (sub === 'automod')       return interaction.reply(buildAutomodSetupPayload(guildId));
        if (sub === 'counters')      return interaction.reply(buildCounterSetupPayload(guildId));
        if (sub === 'training')      return interaction.reply(buildTrainingSetupPayload(guildId));
        if (sub === 'erlclogs')      return interaction.reply(buildErlcLogSetupPayload(guildId));
        if (sub === 'execrequest')   return interaction.reply(buildRequestSetupPayload(guildId, 'exec'));
        if (sub === 'founderrequest') return interaction.reply(buildRequestSetupPayload(guildId, 'founder'));
        if (sub === 'roleperms')      return interaction.reply(buildRolePermsSetupPayload(guildId));
        if (sub === 'commandlist')    return interaction.reply(buildCommandListSetupPayload(guildId));
        if (sub === 'handbooks')      return interaction.reply(buildHandbookSetupPayload(guildId));
      }
    }

    // ══ BUTTONS ══
    if (interaction.isButton()) {
      const id = interaction.customId;

      // ════ EXECUTIVE / FOUNDERSHIP REQUEST APPROVE/DENY ════
      if (id.startsWith('req__approve__') || id.startsWith('req__deny__')) {
        const parts = id.split('__');
        const action = parts[1]; // approve or deny
        const prefix = parts[2]; // exec or founder
        const cfg = prefix === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        const required = cfg.requiredApprovals ?? 2;

        // Check of de gebruiker de juiste rol heeft
        const canVote = cfg.approvalRoles?.length
          ? cfg.approvalRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member)
          : hasSetup(interaction.member);
        if (!canVote) return interaction.reply({ content: '❌ You do not have permission to approve or deny this request.', flags: MessageFlags.Ephemeral });

        const embed = interaction.message.embeds[0];
        if (!embed) return interaction.reply({ content: '❌ Could not find embed.', flags: MessageFlags.Ephemeral });

        // Check of al afgehandeld
        const statusField = embed.fields.find(f => f.name === '📊 Status');
        if (statusField?.value !== '⏳ Pending') return interaction.reply({ content: '❌ This request has already been decided.', flags: MessageFlags.Ephemeral });

        const approvalsField = embed.fields.find(f => f.name?.startsWith('✅ Approvals'));
        const denialsField   = embed.fields.find(f => f.name?.startsWith('❌ Denials'));

        const currentApprovals = approvalsField?.value === '*No approvals yet*' ? [] : approvalsField?.value.split('\n') ?? [];
        const currentDenials   = denialsField?.value   === '*No denials yet*'   ? [] : denialsField?.value.split('\n')   ?? [];

        // Check of al gestemd
        const userTag = `${interaction.user.tag} (<@${interaction.user.id}>)`;
        if ([...currentApprovals, ...currentDenials].some(v => v.includes(interaction.user.id))) {
          return interaction.reply({ content: '❌ You have already voted on this request.', flags: MessageFlags.Ephemeral });
        }

        let newApprovals = currentApprovals;
        let newDenials   = currentDenials;
        if (action === 'approve') newApprovals = [...currentApprovals, userTag];
        if (action === 'deny')    newDenials   = [...currentDenials,   userTag];

        const approved = newApprovals.length >= required;
        const denied   = newDenials.length   >= required;
        const newStatus = approved ? '✅ Approved' : denied ? '❌ Denied' : '⏳ Pending';
        const newColor  = approved ? 0x57F287 : denied ? 0xED4245 : (prefix === 'exec' ? 0x5865F2 : 0xFEE75C);

        const updatedEmbed = EmbedBuilder.from(embed)
          .setColor(newColor)
          .spliceFields(embed.fields.findIndex(f => f.name?.startsWith('✅ Approvals')), 1, { name: `✅ Approvals (${newApprovals.length}/${required})`, value: newApprovals.join('\n') || '*No approvals yet*', inline: false })
          .spliceFields(embed.fields.findIndex(f => f.name?.startsWith('❌ Denials')),   1, { name: `❌ Denials (${newDenials.length})`,                  value: newDenials.join('\n')   || '*No denials yet*',   inline: false })
          .spliceFields(embed.fields.findIndex(f => f.name === '📊 Status'),             1, { name: '📊 Status', value: newStatus, inline: false });

        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req__approve__${prefix}__done`).setLabel('✅ Approve').setStyle(ButtonStyle.Success).setDisabled(approved || denied),
          new ButtonBuilder().setCustomId(`req__deny__${prefix}__done`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger).setDisabled(approved || denied),
        );

        await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

        if (approved) await interaction.followUp({ content: `✅ **Request approved!** Required ${required} approvals reached.`, ephemeral: false }).catch(() => {});
        if (denied)   await interaction.followUp({ content: `❌ **Request denied!** Required ${required} denials reached.`,   ephemeral: false }).catch(() => {});
        return;
      }

      // ════ TRAINING CLAIM BUTTONS ════
      if (id.startsWith('tr__claim__') || id.startsWith('tr__unclaim__') || id.startsWith('tr__pass__') || id.startsWith('tr__fail__')) {
        const parts = id.split('__');
        const action = parts[1];
        const requestUserId = parts[2];
        const tc = getTrainingConfig(guildId);
        const isTrainer = tc.trainerRoles.length
          ? tc.trainerRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member)
          : hasSetup(interaction.member);
        if (!isTrainer) return interaction.reply({ content: '❌ Only trainers can interact with training requests.', flags: MessageFlags.Ephemeral });

        const embed = interaction.message.embeds[0];
        if (!embed) return interaction.reply({ content: '❌ Could not find embed.', flags: MessageFlags.Ephemeral });

        // Check of al afgehandeld
        const statusField = embed.fields?.find(f => f.name === '📊 Status');
        if (statusField && (statusField.value === '✅ Passed' || statusField.value === '❌ Failed')) {
          return interaction.reply({ content: '❌ This training has already been completed.', flags: MessageFlags.Ephemeral });
        }

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
          // Disable alle knoppen
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`tr__claim__${requestUserId}__done`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__unclaim__${requestUserId}__done`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__pass__${requestUserId}__done`).setLabel('✅ Pass').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId(`tr__fail__${requestUserId}__done`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          // Update embed met status
          let updatedEmbed = EmbedBuilder.from(embed).setColor(passed ? 0x57F287 : 0xED4245);
          const statusIdx = embed.fields?.findIndex(f => f.name === '📊 Status');
          if (statusIdx !== undefined && statusIdx >= 0) {
            updatedEmbed = updatedEmbed.spliceFields(statusIdx, 1, { name: '📊 Status', value: passed ? '✅ Passed' : '❌ Failed', inline: false });
          } else {
            updatedEmbed = updatedEmbed.addFields({ name: '📊 Status', value: passed ? '✅ Passed' : '❌ Failed', inline: false });
          }
          updatedEmbed = updatedEmbed.addFields({ name: passed ? '🎓 Passed By' : '❌ Failed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true });
          await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

          // Stuur promotion announce als passed
          if (passed) {
            const targetUser = await client.users.fetch(requestUserId).catch(() => null);
            if (targetUser) await sendPromotionAnnounce(interaction.guild, targetUser, 'their training', interaction.user, 'training');
          }

          // Stuur DM naar de aanvrager
          const targetUser = await client.users.fetch(requestUserId).catch(() => null);
          if (targetUser) {
            const dmEmbed = new EmbedBuilder()
              .setTitle(passed ? '🎓 Training Passed!' : '❌ Training Failed')
              .setColor(passed ? 0x57F287 : 0xED4245)
              .setDescription(passed
                ? `Congratulations! **${interaction.user.tag}** has marked your training as **passed**! 🎉`
                : `**${interaction.user.tag}** has marked your training as **failed**. Don't give up — keep practicing!`)
              .setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
          }
          return;
        }
      }

      // ════ SESSION VOTE BUTTON ════
      if (id === 'session__vote') {
        const voteData = activeVotes.get(guildId);
        if (!voteData || voteData.messageId !== interaction.message.id) {
          return interaction.reply({ content: '❌ This vote is no longer active.', flags: MessageFlags.Ephemeral });
        }
        const userId = interaction.user.id;
        if (voteData.voters.includes(userId)) {
          return interaction.reply({ content: '❌ You have already voted!', flags: MessageFlags.Ephemeral });
        }
        voteData.voters.push(userId);
        const count = voteData.voters.length;
        const threshold = voteData.threshold;

        // Update embed met nieuwe vote count
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setDescription(interaction.message.embeds[0].description.replace(/\*\*Votes: \d+\/\d+\*\*/, `**Votes: ${count}/${threshold}**`));

        if (count >= threshold) {
          // Vote geslaagd — disable de knop en start sessie
          activeVotes.delete(guildId);
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('session__vote').setLabel(`✅ Vote Passed! (${count}/${threshold})`).setStyle(ButtonStyle.Success).setDisabled(true),
          );
          await interaction.update({ embeds: [updatedEmbed.setTitle('✅ Vote Passed!').setColor(0x57F287)], components: [disabledRow] });
          const sc = getSessionConfig(guildId);
          const hostUser = await client.users.fetch(voteData.hostId).catch(() => ({ tag: 'Unknown', id: voteData.hostId }));
          const vars = { userMention: `<@${voteData.hostId}>`, username: hostUser.username ?? 'Unknown', userTag: hostUser.tag ?? 'Unknown', memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
          const voterMentions = voteData.voters.map(id => `<@${id}>`).join(' ');
          await postSessionStart(interaction.guild, sc, hostUser, voteData.joinLink, vars, voterMentions);
        } else {
          // Nog niet genoeg votes — update de count
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
        }
        return;
      }

      // ════ TICKET TYPE CONFIG BUTTONS ════
      if (id.startsWith('tkt_type_cfg__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__');
        const action = parts[1], typeId = parts[2];
        if (action === 'required') return interaction.reply({ content: `### 🔒 Select required roles`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`tkt_required_roles__${typeId}`).setPlaceholder('Select required roles (0 = everyone)...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'view')     return interaction.reply({ content: `### 👁️ Select view roles`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`tkt_view_roles__${typeId}`).setPlaceholder('Select view roles (0 = none)...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'category') return interaction.reply({ content: `### 📁 Select category for this ticket type`, components: [channelDropdown(`tkt_type_category__${typeId}`, 'Select category...')], flags: MessageFlags.Ephemeral });
      }

      // ════ HANDBOOK SETUP BUTTONS ════
      if (id.startsWith('hb__') && id !== 'hb__select_panel') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__');
        const action = parts[1];
        const panelId = parts[2];
        const hc = getHandbookConfig(guildId);

        if (action === 'create') {
          const modal = new ModalBuilder().setCustomId('modal_hb_create').setTitle('Create Handbook Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hb_title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setPlaceholder('📚 Server Handbooks').setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hb_description').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setPlaceholder('Select a handbook from the dropdown below.').setRequired(false).setMaxLength(500)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'add_book') {
          const modal = new ModalBuilder().setCustomId(`modal_hb_add_book__${panelId}`).setTitle('Add Handbook');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hb_book_label').setLabel('Label (shown in dropdown)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hb_book_url').setLabel('URL (Google Docs, etc.)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'set_channel') return interaction.reply({ content: `### 📢 Select channel for this handbook panel`, components: [channelDropdown(`hb_channel__${panelId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'deploy') {
          const panel = hc.panels[panelId];
          if (!panel?.channel) return interaction.reply({ content: '❌ Set a channel first.', flags: MessageFlags.Ephemeral });
          if (!panel.books?.length) return interaction.reply({ content: '❌ Add at least one book first.', flags: MessageFlags.Ephemeral });
          const ch = interaction.guild.channels.cache.get(panel.channel);
          if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const embed = new EmbedBuilder().setTitle(panel.title).setDescription(panel.description || 'Select a handbook below.').setColor(0x5865F2).setTimestamp();
          const options = panel.books.map(b => ({ label: b.label, value: b.id, description: b.requiredRoles?.length ? '🔒 Role Required' : '🟢 Open' }));
          const sel = new StringSelectMenuBuilder().setCustomId(`hbp__select__${panelId}`).setPlaceholder('Select a handbook...').addOptions(options.slice(0, 25));
          const existing = panel.messageId ? await ch.messages.fetch(panel.messageId).catch(() => null) : null;
          if (existing) { await existing.edit({ embeds: [embed], components: [new ActionRowBuilder().addComponents(sel)] }); }
          else { const msg = await ch.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(sel)] }); panel.messageId = msg.id; }
          await saveConfig(config);
          return interaction.editReply({ content: `✅ Handbook panel deployed in <#${panel.channel}>!` });
        }
        if (action === 'delete_panel') { delete hc.panels[panelId]; await saveConfig(config); return interaction.update(buildHandbookSetupPayload(guildId)); }
      }

      // ════ ROLE PERMS SETUP BUTTONS ════
      if (id.startsWith('rperms__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('rperms__', '');
        if (action === 'clear') {
          config[guildId].rolePerms = {};
          await saveConfig(config);
          return interaction.update(buildRolePermsSetupPayload(guildId));
        }
        if (action === 'add') {
          return interaction.reply({
            content: '### 🔐 Select the role you want to configure permissions for',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('rperms_select_role').setPlaceholder('Select role...').setMinValues(1).setMaxValues(1))],
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      // ════ COMMANDLIST SETUP BUTTONS ════
      if (id.startsWith('cmdlist__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('cmdlist__', '');
        if (action === 'channel') return interaction.reply({ content: '### 📢 Select the channel for the command list', components: [channelDropdown('cmdlist_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'deploy') {
          await updateCommandListEmbed(interaction.guild);
          return interaction.reply({ content: '✅ Command list deployed/updated!', flags: MessageFlags.Ephemeral });
        }
      }

      // ════ REQUEST SETUP BUTTONS ════
      if (id.startsWith('reqsetup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__');
        const action = parts[1];
        const type   = parts[2];
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        const label = type === 'exec' ? 'Executive' : 'Foundership';
        if (action === 'channel') return interaction.reply({ content: `### 📢 Select channel for **${label}** requests`, components: [channelDropdown(`reqsetup_channel__${type}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'roles')   return interaction.reply({ content: `### 🔑 Select roles that can approve **${label}** requests`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`reqsetup_roles__${type}`).setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'approvals') {
          const modal = new ModalBuilder().setCustomId(`modal_reqapprovals__${type}`).setTitle(`Required Approvals — ${label}`);
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('approvals_count').setLabel('How many approvals are required?').setStyle(TextInputStyle.Short).setValue(`${cfg.requiredApprovals ?? 2}`).setRequired(true).setMinLength(1).setMaxLength(2)));
          return interaction.showModal(modal);
        }
      }

      // ════ ERLC LOG SETUP BUTTONS ════
      if (id.startsWith('erlc_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ec = getErlcLogConfig(guildId);
        if (id === 'erlc_toggle') { ec.enabled = !ec.enabled; await saveConfig(config); return interaction.update(buildErlcLogSetupPayload(guildId)); }
        const channelMap = {
          erlc_set_kickbans:  { key: 'kickBans',  label: '🔨 Kick/Ban logs channel',    cid: 'erlcd_kickbans' },
          erlc_set_joinleave: { key: 'joinLeave', label: '📥 Join/Leave logs channel',   cid: 'erlcd_joinleave' },
          erlc_set_cmds:      { key: 'cmds',      label: '⌨️ Command logs channel',      cid: 'erlcd_cmds' },
          erlc_set_modcall:   { key: 'modCall',   label: '🚨 Mod call logs channel',     cid: 'erlcd_modcall' },
          erlc_set_kills:     { key: 'kills',     label: '💀 Kill logs channel',         cid: 'erlcd_kills' },
        };
        const entry = channelMap[id];
        if (entry) return interaction.reply({ content: `### ${entry.label}`, components: [channelDropdown(entry.cid, 'Select channel...')], flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING SETUP BUTTONS ════
      if (id.startsWith('tr_setup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const action = id.replace('tr_setup__', '');
        const tc = getTrainingConfig(guildId);
        if (action === 'channel') {
          return interaction.reply({
            content: '### 📢 Select the channel where training requests will be posted.',
            components: [channelDropdown('tr_setup_channel', 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'trainer_roles') {
          return interaction.reply({
            content: '### 🔑 Select roles that can **claim** training requests.',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('tr_setup_trainer_roles').setPlaceholder('Select trainer roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'request_roles') {
          return interaction.reply({
            content: '### 📋 Select roles that can **request** a trainer. Leave empty for everyone.',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('tr_setup_request_roles').setPlaceholder('Select request roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'announce_channel') {
          return interaction.reply({ content: '### 📣 Select the channel for promotion announcements.', components: [channelDropdown('tr_setup_announce_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'announce_message') {
          const tc = getTrainingConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_tr_announce_msg').setTitle('Promotion Announce Message');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_msg').setLabel('Message (variables: {user} {role} {promotedBy})').setStyle(TextInputStyle.Paragraph).setValue(tc.announceMessage || '').setPlaceholder('🎉 Congratulations <@{user}>! You have been promoted to **{role}**!').setRequired(false).setMaxLength(1000)));
          return interaction.showModal(modal);
        }
        if (action === 'ping_roles') {
          return interaction.reply({
            content: '### 🔔 Select roles to ping when a training request is posted.',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('tr_setup_ping_roles').setPlaceholder('Select ping roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      // ════ COUNTER BUTTONS ════
      if (id.startsWith('cnt_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const cc = getCounterConfig(guildId);
        if (id === 'cnt_toggle') { cc.enabled = !cc.enabled; await saveConfig(config); return interaction.update(buildCounterSetupPayload(guildId)); }
        if (id === 'cnt_category') return interaction.reply({ content: '### 📁 Select category', components: [channelDropdown('cntd_category', 'Select category...', [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        if (id === 'cnt_create_all') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          let created = 0;
          for (const type of Object.keys(cc.channels)) {
            if (!cc.channels[type].enabled) continue;
            if (cc.channels[type].channelId && interaction.guild.channels.cache.get(cc.channels[type].channelId)) continue;
            try { await createCounterChannel(interaction.guild, type, cc); created++; } catch (e) { console.error(`Counter create error [${type}]:`, e); }
          }
          cc.enabled = true; await saveConfig(config);
          return interaction.editReply({ content: `✅ Created **${created}** counter channel(s)!` });
        }
        if (id === 'cnt_delete_all') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          for (const type of Object.keys(cc.channels)) { await deleteCounterChannel(interaction.guild, type, cc).catch(() => {}); }
          cc.enabled = false; await saveConfig(config);
          return interaction.editReply({ content: '✅ All counter channels deleted.' });
        }
        for (const type of ['members', 'bots', 'online', 'channels', 'roles']) {
          if (id === `cnt_toggle_${type}`) { cc.channels[type].enabled = !cc.channels[type].enabled; await saveConfig(config); return interaction.update(buildCounterSetupPayload(guildId)); }
        }
        if (id === 'cnt_labels') {
          const modal = new ModalBuilder().setCustomId('modal_cnt_labels').setTitle('Edit Counter Labels');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cnt_lbl_members').setLabel('Members label ({count})').setStyle(TextInputStyle.Short).setValue(cc.channels.members.label).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cnt_lbl_bots').setLabel('Bots label ({count})').setStyle(TextInputStyle.Short).setValue(cc.channels.bots.label).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cnt_lbl_online').setLabel('Online label ({count})').setStyle(TextInputStyle.Short).setValue(cc.channels.online.label).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cnt_lbl_channels').setLabel('Channels label ({count})').setStyle(TextInputStyle.Short).setValue(cc.channels.channels.label).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cnt_lbl_roles').setLabel('Roles label ({count})').setStyle(TextInputStyle.Short).setValue(cc.channels.roles.label).setRequired(true)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'cnt_refresh') { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await updateCounters(interaction.guild); return interaction.editReply({ content: '✅ Counters refreshed!' }); }
      }

      // ════ AUTOMOD BUTTONS ════
      if (id.startsWith('am_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const am = getAutomodConfig(guildId);
        if (id === 'am_toggle') { am.enabled = !am.enabled; await saveConfig(config); return interaction.update(buildAutomodSetupPayload(guildId)); }
        if (id === 'am_log') return interaction.reply({ content: '### 📋 Automod log channel', components: [channelDropdown('amd_log', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'am_keywords') {
          const modal = new ModalBuilder().setCustomId('modal_am_keywords').setTitle('Edit Automod Keywords');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('am_kw').setLabel('Keywords (comma separated)').setStyle(TextInputStyle.Paragraph).setValue(am.keywords.join(', ')).setPlaceholder('badword1, badword2').setRequired(false)));
          return interaction.showModal(modal);
        }
        if (id === 'am_action') {
          const modal = new ModalBuilder().setCustomId('modal_am_action').setTitle('Automod Action');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('am_act').setLabel('Action: delete / delete+warn / delete+mute').setStyle(TextInputStyle.Short).setValue(am.action || 'delete').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('am_mute_mins').setLabel('Mute duration (minutes)').setStyle(TextInputStyle.Short).setValue(String(am.muteMinutes ?? 5)).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
      }

      // ════ CLOSE REQUEST ════
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
          if (trCh) { const msgs = await ch.messages.fetch({ limit: 100 }); const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n'); await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] }); }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ Ticket Closed').setColor(0x57F287).setDescription(`Closed by **${interaction.user.tag}**. Deleting in 3 seconds...`).setTimestamp()], components: [] });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
        return;
      }

      // ════ APPLICATION SETUP BUTTONS ════
      if (id.startsWith('ap_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ac = getApplicationConfig(guildId);

        if (id === 'ap_review_channel') return interaction.reply({ content: '### 📢 Select global review channel', components: [channelDropdown('apd_review_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'ap_log_channel')    return interaction.reply({ content: '### 📋 Select log channel', components: [channelDropdown('apd_log_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });

        if (id === 'ap_add_type') {
          const modal = new ModalBuilder().setCustomId('modal_ap_add_type').setTitle('Add Application Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_label').setLabel('Application name').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_questions').setLabel('Questions — one per line (max 60)').setStyle(TextInputStyle.Paragraph).setPlaceholder('What is your age?\nWhy do you want to join?').setMaxLength(4000).setRequired(true)),
          );
          return interaction.showModal(modal);
        }

        if (id === 'ap_edit_type') {
          if (!ac.appTypes.length) return interaction.reply({ content: '❌ No types to edit.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_edit_type').setPlaceholder('Select type...').addOptions(ac.appTypes.map(t => ({ label: `${t.emoji || '•'} ${t.label}`, value: t.id })));
          return interaction.reply({ content: '### ✏️ Select type to edit', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_remove_type') {
          if (!ac.appTypes.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_remove_type').setPlaceholder('Select type...').addOptions(ac.appTypes.map(t => ({ label: t.label, value: t.id })));
          return interaction.reply({ content: '### ➖ Remove application type', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_add_panel') {
          if (!ac.appTypes.length) return interaction.reply({ content: '❌ Create at least one application type first.', flags: MessageFlags.Ephemeral });
          const modal = new ModalBuilder().setCustomId('modal_ap_add_panel').setTitle('Create Application Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_name').setLabel('Panel name').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setPlaceholder('📋 Applications')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_desc').setLabel('Embed description').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('Click a button to apply!')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_color').setLabel('Color hex (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('#5865F2')),
          );
          return interaction.showModal(modal);
        }

        if (id === 'ap_edit_panel') {
          if (!ac.panels.length) return interaction.reply({ content: '❌ No panels to edit.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_edit_panel').setPlaceholder('Select panel...').addOptions(ac.panels.map(p => ({ label: p.name, value: p.id })));
          return interaction.reply({ content: '### ✏️ Select panel to edit', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_remove_panel') {
          if (!ac.panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_remove_panel').setPlaceholder('Select panel...').addOptions(ac.panels.map(p => ({ label: p.name, value: p.id })));
          return interaction.reply({ content: '### 🗑️ Remove panel', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_deploy_panel') {
          if (!ac.panels.length) return interaction.reply({ content: '❌ Create a panel first.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_deploy_panel').setPlaceholder('Select panel to deploy...').addOptions(ac.panels.map(p => ({ label: p.name, value: p.id })));
          return interaction.reply({ content: '### 🚀 Select panel to deploy', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ APPLICATION PANEL EDITOR BUTTONS ════
      if (id.startsWith('appe__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__'); const action = parts[1]; const panelId = parts[2];
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });

        if (action === 'set_channel') return interaction.reply({ content: '### 📬 Select channel to deploy this panel to', components: [channelDropdown(`appe_channel__${panelId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'set_review_channel') return interaction.reply({ content: '### 📢 Override review channel for this panel', components: [channelDropdown(`appe_review_channel__${panelId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });

        if (action === 'add_type') {
          const available = ac.appTypes.filter(t => !panel.appTypeIds.includes(t.id));
          if (!available.length) return interaction.reply({ content: '❌ All types are already added to this panel.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId(`appe_add_type__${panelId}`).setPlaceholder('Select type to add...').addOptions(available.map(t => ({ label: `${t.emoji || '•'} ${t.label}`, value: t.id })));
          return interaction.reply({ content: '### ➕ Add type to panel', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (action === 'remove_type') {
          if (!panel.appTypeIds.length) return interaction.reply({ content: '❌ No types in this panel.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId(`appe_remove_type__${panelId}`).setPlaceholder('Select type to remove...').addOptions(panel.appTypeIds.map(tid => { const t = ac.appTypes.find(x => x.id === tid); return { label: t ? t.label : tid, value: tid }; }));
          return interaction.reply({ content: '### ➖ Remove type from panel', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (action === 'deploy') {
          if (!panel.channel) return interaction.reply({ content: '❌ Set a channel first.', flags: MessageFlags.Ephemeral });
          if (!panel.appTypeIds.length) return interaction.reply({ content: '❌ Add at least one type.', flags: MessageFlags.Ephemeral });
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const ch = interaction.guild.channels.cache.get(panel.channel);
            if (!ch) throw new Error('Channel not found.');
            const embed = new EmbedBuilder()
              .setTitle(panel.title || '📋 Applications')
              .setDescription(panel.description || 'Click a button below to apply!')
              .setColor(hexToInt(panel.color))
              .setThumbnail(LOGO_URL);
            if (panel.image) embed.setImage(panel.image);
            const rows = [];
            const types = panel.appTypeIds.map(tid => ac.appTypes.find(t => t.id === tid)).filter(Boolean);
            for (let i = 0; i < Math.min(types.length, 25); i += 5) {
              const chunk = types.slice(i, i + 5);
              rows.push(new ActionRowBuilder().addComponents(chunk.map(t => safeSetEmoji(new ButtonBuilder().setCustomId(`appopen__${t.id}__${panel.id}`).setLabel(t.label.slice(0, 80)).setStyle(ButtonStyle.Primary), t.emoji))));
            }
            await ch.send({ embeds: [embed], components: rows });
            await saveConfig(config);
            return interaction.editReply({ content: `✅ Panel **${panel.name}** deployed to <#${panel.channel}>!` });
          } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
        }
        if (action === 'edit_embed') {
          const modal = new ModalBuilder().setCustomId(`modal_appe_embed__${panelId}`).setTitle(`Edit Panel: ${panel.name}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setValue(panel.title || '').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_desc').setLabel('Embed description').setStyle(TextInputStyle.Paragraph).setValue(panel.description || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(panel.color || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_panel_image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setValue(panel.image || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'back') return interaction.update(buildApplicationSetupPayload(guildId));
      }

      // ════ APPLICATION TYPE EDITOR BUTTONS ════
      if (id.startsWith('apte__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__'); const action = parts[1]; const typeId = parts[2];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });

        if (action === 'set_required_roles') {
          return interaction.reply({
            content: `### 🔒 Select required roles for **${appType.label}**\nOnly members with these roles can apply.`,
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`apte_required_roles__${typeId}`).setPlaceholder('Select required roles (0 = everyone)...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'set_review_roles') {
          return interaction.reply({
            content: `### 🔑 Select review roles for **${appType.label}**\nOnly members with these roles can accept or deny applications of this type.\n*Select multiple roles — send each one separately or use the dropdown.*`,
            components: [roleDropdown(`apte_review_roles__${typeId}`, 'Select role...')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'set_review_channel') {
          return interaction.reply({
            content: `### 📢 Select review channel for **${appType.label}**\nApplications of this type will be sent to this channel.`,
            components: [channelDropdown(`apte_review_channel__${typeId}`, 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'set_roles') {
          return interaction.reply({
            content: `### 🎭 Select accept roles for **${appType.label}**\nThese roles will be given to applicants on acceptance.`,
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`apte_roles__${typeId}`).setPlaceholder('Select roles (0 for none)...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'set_messages') {
          const modal = new ModalBuilder().setCustomId(`modal_apte_messages__${typeId}`).setTitle(`DM Berichten: ${appType.label}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('accept_msg').setLabel('Accept DM message').setStyle(TextInputStyle.Paragraph).setValue(appType.acceptMessage || '').setPlaceholder('Congratulations {username}! You have been accepted for {type} in {server}! 🎉').setRequired(false).setMaxLength(1500)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deny_msg').setLabel('Deny DM message').setStyle(TextInputStyle.Paragraph).setValue(appType.denyMessage || '').setPlaceholder('Sorry {username}, you have been denied for {type}.\n\nReason: {reason}').setRequired(false).setMaxLength(1500)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'set_grouplink') {
          const modal = new ModalBuilder().setCustomId(`modal_apte_grouplink__${typeId}`).setTitle(`Group Link: ${appType.label}`);
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('group_link').setLabel('Roblox group link (or other link)').setStyle(TextInputStyle.Short).setValue(appType.groupLink || '').setPlaceholder('https://www.roblox.com/groups/...').setRequired(false)));
          return interaction.showModal(modal);
        }
        if (action === 'set_nickname') {
          const modal = new ModalBuilder().setCustomId(`modal_apte_nickname__${typeId}`).setTitle(`Nickname Format: ${appType.label}`);
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('nickname_format')
              .setLabel('Nickname format (empty = disabled)')
              .setStyle(TextInputStyle.Short)
              .setValue(appType.nicknameFormat || '')
              .setPlaceholder('[Lid] | {user}')
              .setRequired(false)
              .setMaxLength(32)
          ));
          return interaction.showModal(modal);
        }
        if (action === 'edit_questions') {
          const modal = new ModalBuilder().setCustomId(`modal_apte_questions__${typeId}`).setTitle(`Edit Questions: ${appType.label}`);
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_questions').setLabel('Questions (one per line, max 60)').setStyle(TextInputStyle.Paragraph).setValue(appType.questions.join('\n')).setRequired(true)));
          return interaction.showModal(modal);
        }
        if (action === 'back') return interaction.update(buildApplicationSetupPayload(guildId));
      }

      // ════ APPLICATION OPEN BUTTON (from deployed panel) ════
      if (id.startsWith('appopen__')) {
        const parts = id.split('__'); const typeId = parts[1]; const panelId = parts[2];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ This application type no longer exists.', flags: MessageFlags.Ephemeral });
        if (!appType.questions || appType.questions.length === 0) return interaction.reply({ content: '❌ No questions configured for this type.', flags: MessageFlags.Ephemeral });
        if (activeAppSessions.has(interaction.user.id)) return interaction.reply({ content: '❌ You already have an active application. Check your DMs!\n\nType `cancel` in the DM to cancel it.', flags: MessageFlags.Ephemeral });
        // Required roles check
        if (appType.requiredRoles?.length && !appType.requiredRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: `❌ You need one of the following roles to apply: ${appType.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Try to open DM first
        let dmChannel;
        try {
          dmChannel = await interaction.user.createDM();
        } catch {
          return interaction.editReply({ content: '❌ I could not open a DM with you. Please enable DMs from server members.' });
        }

        // Create session
        const session = {
          guildId,
          typeId,
          panelId,
          questionIndex: 0,
          answers: [],
          dmChannelId: dmChannel.id,
          guildName: interaction.guild.name,
          startedAt: Date.now(),
        };
        activeAppSessions.set(interaction.user.id, session);

        // Send intro embed
        try {
          const introEmbed = new EmbedBuilder()
            .setTitle(`📋 ${appType.label}`)
            .setColor(0x5865F2)
            .setDescription(
              `Welcome! You are applying for **${appType.label}** in **${interaction.guild.name}**.\n\n` +
              `You have **${appType.questions.length}** question(s) to answer, one at a time.\n` +
              `Type your answer after each question.\n\n` +
              `> Type \`cancel\` at any time to cancel.\n\n━━━━━━━━━━━━━━━━━━━━━━`
            )
            .setFooter({ text: `${interaction.guild.name} • Application System` })
            .setThumbnail(interaction.guild.iconURL({ dynamic: true }));
          await dmChannel.send({ embeds: [introEmbed] });

          // Send first question
          const sent = await sendNextQuestion(interaction.user.id, session, appType);
          if (!sent) {
            activeAppSessions.delete(interaction.user.id);
            return interaction.editReply({ content: '❌ Could not send question. Please check your DMs.' });
          }

          return interaction.editReply({ content: `✅ Your application has started! **Check your DMs** to answer the questions.\n\n> Type \`cancel\` to cancel at any time.` });
        } catch (e) {
          activeAppSessions.delete(interaction.user.id);
          console.error('App DM error:', e);
          return interaction.editReply({ content: '❌ Could not send DM. Please enable DMs from server members in your privacy settings.' });
        }
      }

      // ════ APPLICATION ACCEPT / DENY (review channel) ════
      if (id.startsWith('app__accept__') || id.startsWith('app__acceptsilent__') || id.startsWith('app__deny__')) {
        const parts = id.split('__');
        const action = parts[1]; const applicantId = parts[2]; const typeId = parts[3];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);

        // Permission check: reviewRoles per type, fallback naar hasSetup
        const canReview = appType?.reviewRoles?.length
          ? appType.reviewRoles.some(rId => interaction.member.roles.cache.has(rId)) || hasSetup(interaction.member)
          : hasSetup(interaction.member);
        if (!canReview) return interaction.reply({ content: '❌ You do not have permission to accept or deny applications of this type.', flags: MessageFlags.Ephemeral });
        const applicant = await interaction.guild.members.fetch(applicantId).catch(() => null);

        if (action === 'accept' || action === 'acceptsilent') {
          // Give accept roles
          if (appType?.acceptRoles?.length && applicant) {
            for (const roleId of appType.acceptRoles) {
              const role = interaction.guild.roles.cache.get(roleId);
              if (role) await applicant.roles.add(role).catch(e => console.error('Accept role add error:', e));
            }
          }

          // Set nickname if format is configured
          let newNickname = null;
          if (appType?.nicknameFormat && applicant) {
            newNickname = appType.nicknameFormat
              .replace(/{user}/g, applicant.user.username)
              .replace(/{username}/g, applicant.user.username)
              .replace(/{rank}/g, appType.label)
              .slice(0, 32);
            await applicant.setNickname(newNickname, `Application accepted: ${appType.label}`).catch(e => console.error('Nickname set error:', e));
          }

          const givenRoles = appType?.acceptRoles?.length
            ? appType.acceptRoles.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).filter(Boolean).join(', ')
            : 'None';

          await interaction.update({
            embeds: [new EmbedBuilder().setTitle('✅ Application Accepted').setColor(0x57F287)
              .addFields(
                { name: '👤 Applicant', value: applicant?.user.tag ?? applicantId, inline: true },
                { name: '✅ Accepted by', value: interaction.user.tag, inline: true },
                { name: '🎭 Roles Given', value: givenRoles, inline: true },
                { name: '🏷️ Nickname', value: newNickname ? `\`${newNickname}\`` : '*Not changed*', inline: true },
                { name: '🔔 DM Sent', value: action === 'accept' ? 'Yes' : 'No (silent)', inline: true },
              ).setTimestamp()],
            components: [],
          });

          if (action === 'accept' && applicant) {
            const acceptRoleNames = appType?.acceptRoles?.length
              ? '\n\n**Roles given:** ' + appType.acceptRoles.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).filter(Boolean).join(', ')
              : '';

            // Build custom accept message using variables
            const vars = {
              username: applicant.user.username,
              userMention: `<@${applicant.user.id}>`,
              type: appType?.label ?? 'application',
              server: interaction.guild.name,
            };
            const rawMsg = appType?.acceptMessage
              ? appType.acceptMessage
                  .replace(/{username}/g, vars.username)
                  .replace(/{userMention}/g, vars.userMention)
                  .replace(/{type}/g, vars.type)
                  .replace(/{server}/g, vars.server)
              : `✅ Congratulations **${vars.username}**!\n\nYour **${vars.type}** in **${vars.server}** has been **accepted**! 🎉${acceptRoleNames}`;

            const acceptEmbed = new EmbedBuilder()
              .setTitle('✅ Application Accepted!')
              .setColor(0x57F287)
              .setDescription(rawMsg)
              .setTimestamp();

            // Group link button if set
            const dmComponents = [];
            if (appType?.groupLink && isValidUrl(appType.groupLink)) {
              dmComponents.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('🚀 Join the group!').setStyle(ButtonStyle.Link).setURL(appType.groupLink)
              ));
            }

            await applicant.send({ embeds: [acceptEmbed], components: dmComponents }).catch(() => {});
          }

          // Log
          if (ac.logChannel) {
            const logCh = interaction.guild.channels.cache.get(ac.logChannel);
            if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('✅ Application Accepted').setColor(0x57F287)
              .addFields({ name: 'Applicant', value: applicant?.user.tag ?? applicantId, inline: true }, { name: 'Type', value: appType?.label ?? typeId, inline: true }, { name: 'Accepted by', value: interaction.user.tag, inline: true }, { name: 'DM Sent', value: action === 'accept' ? 'Yes' : 'No', inline: true }).setTimestamp()] });
          }
          return;
        }

        if (action === 'deny') {
          const modal = new ModalBuilder().setCustomId(`modal_app_deny__${applicantId}__${typeId}`).setTitle('Deny Application');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deny_reason').setLabel('Reason for denial').setStyle(TextInputStyle.Paragraph).setPlaceholder('You did not meet the requirements...').setRequired(true).setMaxLength(1000)));
          return interaction.showModal(modal);
        }
      }

      // ════ SAVED MESSAGES BUTTONS ════
      if (id.startsWith('sm_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const sm = getSavedMessagesConfig(guildId);
        if (id === 'sm_new') {
          const modal = new ModalBuilder().setCustomId('modal_sm_new').setTitle('New Saved Message');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_name').setLabel('Name').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'sm_edit') { const msgs = Object.entries(sm.messages); if (!msgs.length) return interaction.reply({ content: '❌ No saved messages.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('smd_edit').setPlaceholder('Select message...').addOptions(msgs.map(([mid, m]) => ({ label: m.name, value: mid }))); return interaction.reply({ content: '### ✏️ Edit message', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 'sm_delete') { const msgs = Object.entries(sm.messages); if (!msgs.length) return interaction.reply({ content: '❌ No saved messages.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('smd_delete').setPlaceholder('Select message...').addOptions(msgs.map(([mid, m]) => ({ label: m.name, value: mid }))); return interaction.reply({ content: '### 🗑️ Delete message', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
      }

      // ════ WELCOMER BUTTONS ════
      if (id.startsWith('wc_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const wc = getWelcomerConfig(guildId);
        if (id === 'wc_channel') return interaction.reply({ content: '### 📢 Welcome channel', components: [channelDropdown('wcd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'wc_toggle') { wc.enabled = !wc.enabled; await saveConfig(config); return interaction.update(buildWelcomerSetupPayload(guildId)); }
        if (id === 'wc_content') {
          const modal = new ModalBuilder().setCustomId('modal_wc_content').setTitle('Edit Welcome Message');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wc_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(wc.title || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wc_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(wc.description || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wc_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(wc.color || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wc_image').setLabel('Banner image URL').setStyle(TextInputStyle.Short).setValue(wc.image || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wc_footer').setLabel('Footer text').setStyle(TextInputStyle.Short).setValue(wc.footer || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
      }

      // ════ AUTOROLE BUTTONS ════
      if (id.startsWith('ar_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ar = getAutoroleConfig(guildId);
        if (id === 'ar_add') return interaction.reply({ content: '### ➕ Select autoroles', components: [roleDropdown('ard_add', 'Select roles...')], flags: MessageFlags.Ephemeral });
        if (id === 'ar_remove') { if (!ar.roles.length) return interaction.reply({ content: '❌ No roles.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('ard_remove').setPlaceholder('Select role...').addOptions(ar.roles.map(id => { const role = interaction.guild.roles.cache.get(id); return { label: role?.name ?? id, value: id }; })); return interaction.reply({ content: '### ➖ Remove autorole', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 'ar_toggle') { ar.enabled = !ar.enabled; await saveConfig(config); return interaction.update(buildAutoroleSetupPayload(guildId)); }
      }

      // ════ VERIFICATION BUTTONS ════
      if (id.startsWith('vc_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        if (id === 'vc_channel') return interaction.reply({ content: '### 📢 Verification channel', components: [channelDropdown('vcd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'vc_role')    return interaction.reply({ content: '### 🎭 Verified role', components: [roleDropdown('vcd_role', 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
        if (id === 'vc_toggle')  { vc.enabled = !vc.enabled; await saveConfig(config); return interaction.update(buildVerificationSetupPayload(guildId)); }
        if (id === 'vc_content') {
          const modal = new ModalBuilder().setCustomId('modal_vc_content').setTitle('Edit Verification Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vc_title').setLabel('Panel title').setStyle(TextInputStyle.Short).setValue(vc.panelTitle || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vc_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(vc.panelDescription || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vc_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(vc.panelColor || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vc_image').setLabel('Image URL').setStyle(TextInputStyle.Short).setValue(vc.panelImage || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'vc_deploy') {
          if (!vc.channel || !vc.verifiedRole) return interaction.reply({ content: '❌ Set channel and role first.', flags: MessageFlags.Ephemeral });
          const ch = interaction.guild.channels.cache.get(vc.channel);
          if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
          const embed = new EmbedBuilder().setTitle(vc.panelTitle).setDescription(vc.panelDescription).setColor(hexToInt(vc.panelColor));
          if (vc.panelImage) embed.setImage(vc.panelImage);
          await ch.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_start').setLabel('✅ Verify').setStyle(ButtonStyle.Success))] });
          return interaction.reply({ content: `✅ Deployed in <#${vc.channel}>!`, flags: MessageFlags.Ephemeral });
        }
      }

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
          // Code gevonden — verifieer de gebruiker
          const vc = getVerificationConfig(guildId);
          const nickname = `(${interaction.user.username}) | ${pending.robloxUsername}`.slice(0, 32);
          try { await interaction.member.setNickname(nickname, 'Roblox verification'); } catch {}
          if (vc.verifiedRole) { const role = interaction.guild.roles.cache.get(vc.verifiedRole); if (role) await interaction.member.roles.add(role); }
          // Sla verificatie op in config
          if (!vc.verifiedUsers) vc.verifiedUsers = {};
          vc.verifiedUsers[interaction.user.id] = { robloxUsername: pending.robloxUsername, robloxId: pending.robloxId, verifiedAt: Date.now() };
          await saveConfig(config);
          pendingVerifications.delete(interaction.user.id);
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Verified!').setColor(0x57F287).addFields(
            { name: '🎮 Roblox Username', value: pending.robloxUsername, inline: true },
            { name: '🆔 Roblox ID', value: `${pending.robloxId}`, inline: true },
            { name: '📛 Nickname', value: `\`${nickname}\``, inline: false },
          ).setDescription('You can now remove the code from your profile description.').setTimestamp()] });
        } catch (e) { return interaction.editReply({ content: `❌ Could not check your profile. Try again later.` }); }
      }

      // ════ TICKET SETUP BUTTONS ════
      if (id.startsWith('t_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        if (id === 't_ping_roles') return interaction.reply({ content: '### 📢 Ping roles', components: [roleDropdown('td_ping_roles', 'Select roles...')], flags: MessageFlags.Ephemeral });
        if (id === 't_transcript') return interaction.reply({ content: '### 📋 Transcript channel', components: [channelDropdown('td_transcript', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 't_channel')    return interaction.reply({ content: '### 📬 Panel channel', components: [channelDropdown('td_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 't_category')   return interaction.reply({ content: '### 📁 Category', components: [channelDropdown('td_category', 'Select category...', [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        if (id === 't_panel_embed') {
          const tc = getTicketConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_t_embed').setTitle('Ticket Panel Embed');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(tc.panelTitle || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(tc.panelDescription || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(tc.panelColor || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_thumbnail').setLabel('Image URL').setStyle(TextInputStyle.Short).setValue(tc.panelThumbnail || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_welcome') {
          const tc = getTicketConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_t_welcome').setTitle('Ticket Welcome Text');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_welcome_text').setLabel('Welcome text (use {user})').setStyle(TextInputStyle.Paragraph).setValue(tc.welcomeText || '').setRequired(true)));
          return interaction.showModal(modal);
        }
        if (id === 't_add_type') {
          const modal = new ModalBuilder().setCustomId('modal_t_add_type').setTitle('Add Ticket Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_label').setLabel('Button Label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_color').setLabel('Color: blue / green / red / grey').setStyle(TextInputStyle.Short).setValue('blue').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_description').setLabel('Short description (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_type_roles') {
          const tc = getTicketConfig(guildId);
          if (!tc.ticketTypes.length) return interaction.reply({ content: '❌ No ticket types yet.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('td_select_type_roles').setPlaceholder('Select type to configure roles...').addOptions(tc.ticketTypes.map(t => ({ label: t.label, value: t.id })));
          return interaction.reply({ content: '### 🔑 Select ticket type to configure roles', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (id === 't_remove_type') { const tc = getTicketConfig(guildId); if (!tc.ticketTypes.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('td_remove_type').setPlaceholder('Select type...').addOptions(tc.ticketTypes.map(t => ({ label: t.label, value: t.id }))); return interaction.reply({ content: '### ➖ Remove ticket type', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 't_deploy') {
          const tc = getTicketConfig(guildId);
          if (!tc.ticketChannel || !tc.ticketTypes.length) return interaction.reply({ content: '❌ Set channel and add types first.', flags: MessageFlags.Ephemeral });
          const ch = interaction.guild.channels.cache.get(tc.ticketChannel);
          if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await ch.send({ embeds: [buildTicketPanelEmbed(tc)], components: buildTicketTypeButtons(tc.ticketTypes) });
          await saveConfig(config);
          return interaction.editReply({ content: `✅ Ticket panel deployed!` });
        }
      }

      // ════ SESSION SETUP BUTTONS ════
      if (id.startsWith('s_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        if (id === 's_channel')       return interaction.reply({ content: '### 📢 Session channel', components: [channelDropdown('sd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 's_ping_roles')    return interaction.reply({ content: '### 👥 Ping roles', components: [roleDropdown('sd_ping_roles', 'Select roles...')], flags: MessageFlags.Ephemeral });
        if (id === 's_allowed_roles') return interaction.reply({ content: '### 🔑 Allowed roles', components: [roleDropdown('sd_allowed_roles', 'Select roles...')], flags: MessageFlags.Ephemeral });
        if (id === 's_join_link') {
          const modal = new ModalBuilder().setCustomId('modal_s_joinlink').setTitle('Default Join Link');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_link_val').setLabel('Join link URL').setStyle(TextInputStyle.Short).setRequired(true)));
          return interaction.showModal(modal);
        }
        if (id === 's_descriptions') {
          const sc = getSessionConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_s_desc').setTitle('Session Descriptions');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_start_desc').setLabel('Start description').setStyle(TextInputStyle.Paragraph).setValue(sc.startDescription || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_vote_desc').setLabel('Vote description').setStyle(TextInputStyle.Paragraph).setValue(sc.voteDescription || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_shutdown_desc').setLabel('Shutdown description').setStyle(TextInputStyle.Paragraph).setValue(sc.shutdownDescription || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 's_images') {
          const sc = getSessionConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_s_images').setTitle('Session Images');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_start_img').setLabel('Start image URL').setStyle(TextInputStyle.Short).setValue(sc.startImage || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_vote_img').setLabel('Vote image URL').setStyle(TextInputStyle.Short).setValue(sc.voteImage || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_shutdown_img').setLabel('Shutdown image URL').setStyle(TextInputStyle.Short).setValue(sc.shutdownImage || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 's_vote_threshold') {
          const sc = getSessionConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_s_threshold').setTitle('Vote Threshold');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_threshold_val').setLabel('Votes needed to auto-start').setStyle(TextInputStyle.Short).setValue(String(sc.voteThreshold ?? 5)).setRequired(true)));
          return interaction.showModal(modal);
        }
      }

      // ════ ANNOUNCEMENT SETUP BUTTONS ════
      if (id.startsWith('an_') || id.startsWith('ane__') || id === 'an__back') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ac = getAnnouncementConfig(guildId);
        if (id === 'an__back') return interaction.update(buildAnnouncementOverview(guildId));
        if (id === 'an_new') {
          const modal = new ModalBuilder().setCustomId('modal_an_new').setTitle('New Announcement Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_name').setLabel('Type name').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'an_edit')   { const types = Object.entries(ac.types); if (!types.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### ✏️ Select type', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('an_sel_edit').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: tid }))))], flags: MessageFlags.Ephemeral }); }
        if (id === 'an_delete') { const types = Object.entries(ac.types); if (!types.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### 🗑️ Select type', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('an_sel_delete').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: tid }))))], flags: MessageFlags.Ephemeral }); }
        if (id.startsWith('ane__')) {
          const parts = id.split('__'); const action = parts[1]; const typeId = parts.slice(2).join('__');
          const t = ac.types[typeId];
          if (!t) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          if (action === 'content') {
            const modal = new ModalBuilder().setCustomId(`modal_an_content__${typeId}`).setTitle(`Edit — ${t.name}`);
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(t.title || '').setMaxLength(80).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(t.description || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(t.color || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_image').setLabel('Image URL').setStyle(TextInputStyle.Short).setValue(t.image || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_emoji').setLabel('Emoji').setStyle(TextInputStyle.Short).setValue(t.emoji || '').setRequired(false)),
            );
            return interaction.showModal(modal);
          }
          if (action === 'channel')   return interaction.reply({ content: `### 📢 Channel for **${t.name}**`, components: [channelDropdown(`anch__${typeId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
          if (action === 'pingrole')  return interaction.reply({ content: `### 🔔 Ping role for **${t.name}**`, components: [roleDropdown(`anpr__${typeId}`, 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
          if (action === 'clearping') { t.pingRole = null; await saveConfig(config); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }
        }
      }

      // ════ SELF ROLE SETUP BUTTONS ════
      if (id.startsWith('sr_') || id.startsWith('sre__') || id === 'sr__back') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const src = getSelfRoleConfig(guildId);
        if (id === 'sr__back') return interaction.update(buildSelfRoleOverview(guildId));
        if (id === 'sr_new') {
          const modal = new ModalBuilder().setCustomId('modal_sr_new').setTitle('Create Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_type').setLabel('Type: buttons / dropdown / reaction').setStyle(TextInputStyle.Short).setValue('buttons').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_max').setLabel('Max roles per user (0 = unlimited)').setStyle(TextInputStyle.Short).setValue('0').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'sr_edit')   { const panels = Object.entries(src.panels); if (!panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### ✏️ Select panel', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sr_sel_edit').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: pid }))))], flags: MessageFlags.Ephemeral }); }
        if (id === 'sr_delete') { const panels = Object.entries(src.panels); if (!panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### 🗑️ Select panel', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sr_sel_delete').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: pid }))))], flags: MessageFlags.Ephemeral }); }
        if (id.startsWith('sre__')) {
          const parts = id.split('__'); const action = parts[1]; const panelId = parts.slice(2).join('__');
          const panel = src.panels[panelId];
          if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
          if (action === 'embed') {
            const modal = new ModalBuilder().setCustomId(`modal_sr_embed__${panelId}`).setTitle('Edit Panel Embed');
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(panel.title).setMaxLength(80).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(panel.description || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(panel.color || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_thumbnail').setLabel('Thumbnail URL').setStyle(TextInputStyle.Short).setValue(panel.thumbnail || '').setRequired(false)),
            );
            return interaction.showModal(modal);
          }
          if (action === 'channel')    return interaction.reply({ content: `### 📢 Channel for **${panel.title}**`, components: [channelDropdown(`srch__${panelId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
          if (action === 'addrole')    return interaction.reply({ content: `### ➕ Add role to **${panel.title}**`, components: [roleDropdown(`srr__add__${panelId}`, 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
          if (action === 'removerole') { if (!panel.roles.length) return interaction.reply({ content: '❌ No roles.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: `### ➖ Remove role`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sr_sel_rmrole__${panelId}`).setPlaceholder('Select role...').addOptions(panel.roles.map(r => ({ label: r.label, value: r.id }))))], flags: MessageFlags.Ephemeral }); }
          if (action === 'deploy') {
            if (!panel.channel || !panel.roles.length) return interaction.reply({ content: '❌ Set channel and add roles first.', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await deploySelfRolePanel(interaction.guild, panelId, panel);
            await saveConfig(config);
            return interaction.editReply({ content: `✅ **${panel.title}** deployed!` });
          }
        }
      }

      // ════ TICKET OPEN ════
      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Ticket type not found.', flags: MessageFlags.Ephemeral });
        // Required roles check
        if (type.requiredRoles?.length && !type.requiredRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: `❌ You need one of the following roles to open this ticket: ${type.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }
        if (openTickets.has(interaction.user.id)) {
          const existing = interaction.guild.channels.cache.get(openTickets.get(interaction.user.id));
          if (existing) return interaction.reply({ content: `❌ You already have a ticket: <#${existing.id}>`, flags: MessageFlags.Ephemeral });
          openTickets.delete(interaction.user.id);
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const category = (type.category ? interaction.guild.channels.cache.get(type.category) : null)
          ?? (tc.ticketCategory ? interaction.guild.channels.cache.get(tc.ticketCategory) : null);
        const perms = [
          { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        for (const rid of tc.pingRoles) { perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }); }
        if (type.viewRoles?.length) { for (const rid of type.viewRoles) { perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }); } }
        const ticketCh = await interaction.guild.channels.create({ name: `ticket-${type.label.toLowerCase().replace(/\s+/g, '-')}-${interaction.user.username}`, type: ChannelType.GuildText, parent: category ?? null, permissionOverwrites: perms, topic: `Ticket by ${interaction.user.tag} | ${type.label}` });
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

      // ════ TICKET CLOSE BUTTON ════
      if (id === 'tkt__claim') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        // Update channel name met claimer
        const embed = interaction.message.embeds[0];
        const alreadyClaimed = embed?.description?.includes('**Claimed by**');
        if (alreadyClaimed) return interaction.reply({ content: '❌ This ticket is already claimed.', flags: MessageFlags.Ephemeral });
        // Update embed met claimer info
        const updatedEmbed = embed
          ? EmbedBuilder.from(embed).setDescription(`${embed.description || ''}\n\n**Claimed by:** ${interaction.user.tag} (<@${interaction.user.id}>)`)
          : new EmbedBuilder().setDescription(`**Claimed by:** ${interaction.user.tag} (<@${interaction.user.id}>)`);
        // Disable claim knop, houd close knop
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tkt__claim').setLabel(`Claimed by ${interaction.user.username}`).setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(true),
          new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        );
        await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] });
        await interaction.reply({ content: `✅ You have claimed this ticket!`, ephemeral: false });
        return;
      }

      if (id === 'tkt__close') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.channel; const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) { const msgs = await ch.messages.fetch({ limit: 100 }); const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n'); await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] }); }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        pendingCloseReqs.delete(ch.id);
        await interaction.reply({ content: '🔒 Closing in 3 seconds...' });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
      }

      // ════ SELF ROLE BUTTON ════
      if (id.startsWith('srp__btn__')) {
        const parts = id.split('__'); const panelId = parts[2]; const roleId = parts[3];
        const src = getSelfRoleConfig(guildId); const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel gone.', flags: MessageFlags.Ephemeral });
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ content: '❌ Role gone.', flags: MessageFlags.Ephemeral });
        if (panel.max > 0 && !interaction.member.roles.cache.has(roleId)) {
          const count = panel.roles.filter(r => interaction.member.roles.cache.has(r.id)).length;
          if (count >= panel.max) return interaction.reply({ content: `❌ Max **${panel.max}** role(s).`, flags: MessageFlags.Ephemeral });
        }
        if (interaction.member.roles.cache.has(roleId)) { await interaction.member.roles.remove(roleId); return interaction.reply({ content: `✅ Removed **${role.name}**.`, flags: MessageFlags.Ephemeral }); }
        else { await interaction.member.roles.add(roleId); return interaction.reply({ content: `✅ Added **${role.name}**.`, flags: MessageFlags.Ephemeral }); }
      }
    }

    // ══ ROLE SELECT MENUS ══
    if (interaction.isRoleSelectMenu()) {
      if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
      const ids = interaction.values;
      if (interaction.customId === 'ard_add')          { const ar = getAutoroleConfig(guildId); for (const id of ids) { if (!ar.roles.includes(id)) ar.roles.push(id); } await saveConfig(config); return interaction.reply({ content: `✅ Autoroles added.`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'vcd_role')          { const vc = getVerificationConfig(guildId); vc.verifiedRole = ids[0]; await saveConfig(config); return interaction.reply({ content: `✅ Verified role: <@&${ids[0]}>.`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_ping_roles')     { getTicketConfig(guildId).pingRoles = ids; await saveConfig(config); return interaction.reply({ content: '✅ Ticket ping roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_ping_roles')     { getSessionConfig(guildId).pingRoles = ids; await saveConfig(config); return interaction.reply({ content: '✅ Session ping roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_allowed_roles')  { getSessionConfig(guildId).allowedRoles = ids; await saveConfig(config); return interaction.reply({ content: '✅ Allowed roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId.startsWith('anpr__'))    { const typeId = interaction.customId.replace('anpr__', ''); getAnnouncementConfig(guildId).types[typeId].pingRole = ids[0]; await saveConfig(config); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }

      // Application type accept roles
      if (interaction.customId.startsWith('apte_review_roles__')) {
        const typeId = interaction.customId.replace('apte_review_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.reviewRoles = ids;
        await saveConfig(config);
        const roleNames = ids.length ? ids.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).join(', ') : 'None (everyone with setup)';
        return interaction.reply({ content: `✅ Review roles for **${appType.label}** set to: **${roleNames}**`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('apte_roles__')) {
        const typeId = interaction.customId.replace('apte_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.acceptRoles = ids; // Could be empty array if none selected
        await saveConfig(config);
        const roleNames = ids.length ? ids.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).join(', ') : 'None';
        return interaction.reply({ content: `✅ Accept roles for **${appType.label}** set to: ${roleNames}`, flags: MessageFlags.Ephemeral });
      }

      // ════ ROLE PERMS ROLE SELECTS ════
      if (interaction.customId === 'rperms_select_role') {
        const roleId = ids[0];
        const role = interaction.guild.roles.cache.get(roleId);
        return interaction.reply({
          content: `### 🔐 Configure permissions for **${role?.name ?? roleId}**\nSelect which roles can **add** this role:`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`rperms_add_roles__${roleId}`).setPlaceholder('Select roles that can ADD this role (0 = everyone)...').setMinValues(0).setMaxValues(10))],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.customId.startsWith('rperms_add_roles__')) {
        const roleId = interaction.customId.replace('rperms_add_roles__', '');
        const rp = getRolePermConfig(guildId);
        if (!rp[roleId]) rp[roleId] = { addRoles: [], removeRoles: [] };
        rp[roleId].addRoles = ids;
        await saveConfig(config);
        await updateCommandListEmbed(interaction.guild);
        const role = interaction.guild.roles.cache.get(roleId);
        return interaction.reply({
          content: `✅ Saved! Now select which roles can **remove** <@&${roleId}>:`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`rperms_remove_roles__${roleId}`).setPlaceholder('Select roles that can REMOVE this role (0 = everyone)...').setMinValues(0).setMaxValues(10))],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.customId.startsWith('rperms_remove_roles__')) {
        const roleId = interaction.customId.replace('rperms_remove_roles__', '');
        const rp = getRolePermConfig(guildId);
        if (!rp[roleId]) rp[roleId] = { addRoles: [], removeRoles: [] };
        rp[roleId].removeRoles = ids;
        await saveConfig(config);
        await updateCommandListEmbed(interaction.guild);
        return interaction.reply({ content: `✅ Role permissions saved for <@&${roleId}>!`, flags: MessageFlags.Ephemeral });
      }

      // ════ REQUEST SETUP ROLE SELECTS ════
      if (interaction.customId.startsWith('reqsetup_roles__')) {
        const type = interaction.customId.replace('reqsetup_roles__', '');
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        cfg.approvalRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Approval roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('hb_book_roles__')) {
        const parts = interaction.customId.replace('hb_book_roles__', '').split('__');
        const panelId = parts[0], bookId = parts[1];
        const hc = getHandbookConfig(guildId);
        const book = hc.panels[panelId]?.books?.find(b => b.id === bookId);
        if (!book) return interaction.reply({ content: '❌ Book not found.', flags: MessageFlags.Ephemeral });
        book.requiredRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Roles set for **${book.label}**: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_view_roles__')) {
        const typeId = interaction.customId.replace('tkt_view_roles__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.viewRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ View roles for **${type.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_required_roles__')) {
        const typeId = interaction.customId.replace('tkt_required_roles__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.requiredRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Required roles for **${type.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('apte_required_roles__')) {
        const typeId = interaction.customId.replace('apte_required_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.requiredRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Required roles for **${appType.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING ROLE SELECTS ════
      if (interaction.customId === 'tr_setup_trainer_roles') {
        const tc = getTrainingConfig(guildId);
        tc.trainerRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Trainer roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_request_roles') {
        const tc = getTrainingConfig(guildId);
        tc.requestRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Request roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_ping_roles') {
        const tc = getTrainingConfig(guildId);
        tc.pingRoles = ids;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Ping roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('srr__add__')) {
        const panelId = interaction.customId.replace('srr__add__', '');
        const src = getSelfRoleConfig(guildId); const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const roleId = ids[0];
        if (panel.roles.some(r => r.id === roleId)) return interaction.reply({ content: '❌ Role already added.', flags: MessageFlags.Ephemeral });
        srPendingRoleAdd.set(interaction.user.id, { panelId, roleId });
        const modal = new ModalBuilder().setCustomId(`modal_sr_rolelabel__${panelId}`).setTitle('Configure Role');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_label').setLabel('Button label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
          panel.type === 'reaction'
            ? new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_reaction').setLabel('Reaction emoji (e.g. ✅)').setStyle(TextInputStyle.Short).setRequired(true))
            : new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_desc').setLabel('Description (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
        );
        return interaction.showModal(modal);
      }
    }

    // ══ CHANNEL SELECT MENUS ══
    if (interaction.isChannelSelectMenu()) {
      if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
      const chId = interaction.values[0];
      if (interaction.customId === 'wcd_channel')         { getWelcomerConfig(guildId).channel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Welcome channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'vcd_channel')         { getVerificationConfig(guildId).channel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Verification channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_transcript')       { getTicketConfig(guildId).transcriptChannel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Transcript: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_channel')          { getTicketConfig(guildId).ticketChannel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Panel channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_category')         { getTicketConfig(guildId).ticketCategory = chId; await saveConfig(config); return interaction.reply({ content: `✅ Category: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_channel')          { getSessionConfig(guildId).channel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Session channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'apd_review_channel')  { getApplicationConfig(guildId).reviewChannel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Global review channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'apd_log_channel')     { getApplicationConfig(guildId).logChannel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Log channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'amd_log')             { getAutomodConfig(guildId).logChannel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Automod log: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId.startsWith('anch__'))      { const typeId = interaction.customId.replace('anch__', ''); getAnnouncementConfig(guildId).types[typeId].channel = chId; await saveConfig(config); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }
      if (interaction.customId.startsWith('srch__'))      { const panelId = interaction.customId.replace('srch__', ''); getSelfRoleConfig(guildId).panels[panelId].channel = chId; await saveConfig(config); return interaction.reply({ content: `✅ Channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'cntd_category')       { getCounterConfig(guildId).categoryId = chId; await saveConfig(config); return interaction.reply({ content: `✅ Counter category: <#${chId}>`, flags: MessageFlags.Ephemeral }); }

      if (interaction.customId.startsWith('apte_review_channel__')) {
        const typeId = interaction.customId.replace('apte_review_channel__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.reviewChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Review channel for **${appType.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      // ════ REQUEST SETUP CHANNEL SELECTS ════
      if (interaction.customId.startsWith('reqsetup_channel__')) {
        const type = interaction.customId.replace('reqsetup_channel__', '');
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        cfg.channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      // ════ ERLC CHANNEL SELECTS ════
      if (interaction.customId.startsWith('erlcd_')) {
        const ec = getErlcLogConfig(guildId);
        const map = { erlcd_kickbans: 'kickBans', erlcd_joinleave: 'joinLeave', erlcd_cmds: 'cmds', erlcd_modcall: 'modCall', erlcd_kills: 'kills' };
        const key = map[interaction.customId];
        if (key) { ec[key] = chId; await saveConfig(config); return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral }); }
      }

      if (interaction.customId.startsWith('tkt_type_category__')) {
        const typeId = interaction.customId.replace('tkt_type_category__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.category = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Category for **${type.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('hb_channel__')) {
        const panelId = interaction.customId.replace('hb_channel__', '');
        const hc = getHandbookConfig(guildId);
        if (!hc.panels[panelId]) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        hc.panels[panelId].channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'cmdlist_channel') {
        const cl = getCommandListConfig(guildId);
        cl.channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Command list channel set to <#${chId}>! Use the **Deploy** button to post it.`, flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING CHANNEL SELECT ════
      if (interaction.customId === 'tr_setup_announce_channel') {
        const tc = getTrainingConfig(guildId);
        tc.announceChannel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Announce channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'tr_setup_channel') {
        const tc = getTrainingConfig(guildId);
        tc.channel = chId;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Training request channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      // Application panel channel
      if (interaction.customId.startsWith('appe_channel__')) {
        const panelId = interaction.customId.replace('appe_channel__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.channel = chId; await saveConfig(config);
        return interaction.reply({ content: `✅ Panel channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      // Application panel review channel override
      if (interaction.customId.startsWith('appe_review_channel__')) {
        const panelId = interaction.customId.replace('appe_review_channel__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.reviewChannel = chId; await saveConfig(config);
        return interaction.reply({ content: `✅ Review channel override set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
    }

    // ══ STRING SELECT MENUS ══
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId; const val = interaction.values[0];

      if (id === 'announce_pick') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ac = getAnnouncementConfig(guildId);
        const t = ac.types[val];
        if (!t) return interaction.reply({ content: '❌ Announcement type not found.', flags: MessageFlags.Ephemeral });
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

      if (id === 'sendmsg_pick') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const sm = getSavedMessagesConfig(guildId);
        const msg = sm.messages[val];
        if (!msg) return interaction.reply({ content: '❌ Saved message not found.', flags: MessageFlags.Ephemeral });
        const targetChannelId = pendingSendMsgChannel.get(interaction.user.id);
        pendingSendMsgChannel.delete(interaction.user.id);
        const targetCh = targetChannelId ? interaction.guild.channels.cache.get(targetChannelId) : interaction.channel;
        if (!targetCh) return interaction.reply({ content: '❌ Target channel not found.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(msg.title || 'Message').setDescription(msg.description || '\u200b').setColor(hexToInt(msg.color));
        if (msg.image) embed.setImage(msg.image);
        if (msg.footer) embed.setFooter({ text: msg.footer });
        await targetCh.send({ embeds: [embed] });
        return interaction.reply({ content: `✅ Sent in <#${targetCh.id}>!`, flags: MessageFlags.Ephemeral });
      }

      if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });

      // Standard selects
      if (id === 'ard_remove')      { const ar = getAutoroleConfig(guildId); ar.roles = ar.roles.filter(r => r !== val); await saveConfig(config); return interaction.reply({ content: `✅ Removed from autoroles.`, flags: MessageFlags.Ephemeral }); }
      if (id === 'smd_delete')      { const sm = getSavedMessagesConfig(guildId); delete sm.messages[val]; await saveConfig(config); return interaction.reply({ content: '✅ Deleted.', flags: MessageFlags.Ephemeral }); }
      if (id === 'an_sel_edit')     { return interaction.update(buildAnnouncementEditor(guildId, val)); }
      if (id === 'an_sel_delete')   { delete getAnnouncementConfig(guildId).types[val]; await saveConfig(config); return interaction.update(buildAnnouncementOverview(guildId)); }
      if (id === 'sr_sel_edit')     { return interaction.update(buildPanelEditor(guildId, val)); }
      if (id === 'sr_sel_delete')   { delete getSelfRoleConfig(guildId).panels[val]; await saveConfig(config); return interaction.update(buildSelfRoleOverview(guildId)); }
      if (id.startsWith('sr_sel_rmrole__')) { const panelId = id.replace('sr_sel_rmrole__', ''); const panel = getSelfRoleConfig(guildId).panels[panelId]; panel.roles = panel.roles.filter(r => r.id !== val); await saveConfig(config); return interaction.reply({ content: `✅ Role removed.`, flags: MessageFlags.Ephemeral }); }
      if (id === 'hb__select_panel') { return interaction.update(buildHandbookPanelEditor(guildId, val)); }
      if (id.startsWith('hbp__select__')) {
        const panelId = id.replace('hbp__select__', '');
        const hc = getHandbookConfig(guildId);
        const panel = hc.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const book = panel.books?.find(b => b.id === val);
        if (!book) return interaction.reply({ content: '❌ Handbook not found.', flags: MessageFlags.Ephemeral });
        if (book.requiredRoles?.length && !book.requiredRoles.some(r => interaction.member.roles.cache.has(r))) {
          return interaction.reply({ content: `❌ You need one of the following roles: ${book.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `📖 **${book.label}**\n${book.url}`, flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith('hb__remove_book__')) {
        const panelId = id.replace('hb__remove_book__', '');
        const hc = getHandbookConfig(guildId);
        const panel = hc.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.books = panel.books.filter(b => b.id !== val);
        await saveConfig(config);
        return interaction.update(buildHandbookPanelEditor(guildId, panelId));
      }

      if (id === 'td_select_type_roles') {
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === val);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`🔧 Configure: ${type.label}`).setColor(0x5865F2)
          .addFields(
            { name: '🔒 Required Roles', value: type.requiredRoles?.length ? type.requiredRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*', inline: true },
            { name: '👁️ View Roles', value: type.viewRoles?.length ? type.viewRoles.map(r => `<@&${r}>`).join(', ') : '*Ping roles only*', inline: true },
            { name: '📁 Category', value: type.category ? `<#${type.category}>` : '*Global category*', inline: true },
          );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkt_type_cfg__required__${val}`).setLabel('Required Roles').setStyle(ButtonStyle.Primary).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__view__${val}`).setLabel('View Roles').setStyle(ButtonStyle.Primary).setEmoji('👁️'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__category__${val}`).setLabel('Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
        );
        return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      }
      if (id === 'td_remove_type')  { const tc = getTicketConfig(guildId); tc.ticketTypes = tc.ticketTypes.filter(t => t.id !== val); await saveConfig(config); return interaction.reply({ content: '✅ Ticket type removed.', flags: MessageFlags.Ephemeral }); }

      // Self role dropdown
      if (id.startsWith('srp__dd__')) {
        const panelId = id.replace('srp__dd__', '');
        const src = getSelfRoleConfig(guildId); const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel gone.', flags: MessageFlags.Ephemeral });
        const allIds = panel.roles.map(r => r.id);
        await interaction.member.roles.remove(interaction.member.roles.cache.filter(r => allIds.includes(r.id)));
        const toAdd = interaction.values.map(rid => interaction.guild.roles.cache.get(rid)).filter(Boolean);
        if (toAdd.length) await interaction.member.roles.add(toAdd);
        return interaction.reply({ content: toAdd.length ? `✅ Roles: ${toAdd.map(r => `**${r.name}**`).join(', ')}` : '✅ All roles removed.', flags: MessageFlags.Ephemeral });
      }

      // ── Application selects ──
      if (id === 'apd_remove_type') {
        const ac = getApplicationConfig(guildId);
        // Remove from all panels too
        for (const panel of ac.panels) { panel.appTypeIds = panel.appTypeIds.filter(tid => tid !== val); }
        ac.appTypes = ac.appTypes.filter(t => t.id !== val);
        await saveConfig(config);
        return interaction.reply({ content: '✅ Application type removed.', flags: MessageFlags.Ephemeral });
      }

      if (id === 'apd_remove_panel') {
        const ac = getApplicationConfig(guildId);
        ac.panels = ac.panels.filter(p => p.id !== val);
        await saveConfig(config);
        return interaction.reply({ content: '✅ Panel removed.', flags: MessageFlags.Ephemeral });
      }

      if (id === 'apd_select_edit_type') {
        // Show type editor
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === val);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const roles = (appType.acceptRoles ?? []).map(id => `<@&${id}>`).join(', ') || 'None';
        const embed = new EmbedBuilder()
          .setTitle(`✏️ Editing Type: ${appType.emoji || ''} ${appType.label}`)
          .setColor(0x5865F2)
          .addFields(
            { name: '📝 Questions', value: `${appType.questions.length} question(s)`, inline: true },
            { name: '🎭 Accept Roles', value: roles, inline: true },
            { name: '📢 Review Channel', value: appType.reviewChannel ? `<#${appType.reviewChannel}>` : '*Global (fallback)*', inline: true },
            { name: '🔑 Review Roles', value: appType.reviewRoles?.length ? appType.reviewRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone with setup*', inline: true },
            { name: '🔗 Group Link', value: appType.groupLink ? `[Click here](${appType.groupLink})` : '*Not set*', inline: true },
            { name: '🏷️ Nickname Format', value: appType.nicknameFormat ? `\`${appType.nicknameFormat}\`` : '*Disabled*', inline: true },
            { name: '✅ Accept Message', value: appType.acceptMessage ? `\`\`\`${appType.acceptMessage.slice(0, 100)}\`\`\`` : '*Default*', inline: false },
            { name: '❌ Deny Message', value: appType.denyMessage ? `\`\`\`${appType.denyMessage.slice(0, 100)}\`\`\`` : '*Default*', inline: false },
            { name: '🔒 Required Roles', value: appType.requiredRoles?.length ? appType.requiredRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*', inline: true },
            { name: '❓ Questions preview', value: appType.questions.slice(0, 5).map((q, i) => `${i + 1}. ${q.slice(0, 80)}`).join('\n') || '*None*', inline: false },
          );
        const r1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`apte__edit_questions__${val}`).setLabel('Edit Questions').setStyle(ButtonStyle.Primary).setEmoji('📝'),
          new ButtonBuilder().setCustomId(`apte__set_roles__${val}`).setLabel('Accept Roles').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
          new ButtonBuilder().setCustomId(`apte__set_required_roles__${val}`).setLabel('Required Roles').setStyle(ButtonStyle.Primary).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`apte__set_review_roles__${val}`).setLabel('Review Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
          new ButtonBuilder().setCustomId(`apte__set_review_channel__${val}`).setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
        );
        const r2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`apte__set_messages__${val}`).setLabel('DM Messages').setStyle(ButtonStyle.Primary).setEmoji('💬'),
          new ButtonBuilder().setCustomId(`apte__set_grouplink__${val}`).setLabel('Group Link').setStyle(ButtonStyle.Primary).setEmoji('🔗'),
          new ButtonBuilder().setCustomId(`apte__set_nickname__${val}`).setLabel('Nickname').setStyle(ButtonStyle.Primary).setEmoji('🏷️'),
          new ButtonBuilder().setCustomId(`apte__back__${val}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
        );
        return interaction.update({ embeds: [embed], components: [r1, r2] });
      }

      if (id === 'apd_select_edit_panel') {
        // Show panel editor
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === val);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const types = panel.appTypeIds.map(tid => ac.appTypes.find(t => t.id === tid)?.label ?? tid).join(', ') || 'None';
        const embed = new EmbedBuilder()
          .setTitle(`✏️ Editing Panel: ${panel.name}`)
          .setColor(hexToInt(panel.color))
          .addFields(
            { name: '📬 Channel', value: panel.channel ? `<#${panel.channel}>` : '*Not set*', inline: true },
            { name: '📢 Review Ch.', value: panel.reviewChannel ? `<#${panel.reviewChannel}>` : 'Global', inline: true },
            { name: '🖼️ Image', value: panel.image ? '✅ Set' : '❌ Not set', inline: true },
            { name: '📝 Types', value: types, inline: false },
          );
        const r1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`appe__set_channel__${panel.id}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📬'),
          new ButtonBuilder().setCustomId(`appe__set_review_channel__${panel.id}`).setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
          new ButtonBuilder().setCustomId(`appe__edit_embed__${panel.id}`).setLabel('Edit Embed').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
        );
        const r2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`appe__add_type__${panel.id}`).setLabel('Add Type').setStyle(ButtonStyle.Success).setEmoji('➕'),
          new ButtonBuilder().setCustomId(`appe__remove_type__${panel.id}`).setLabel('Remove Type').setStyle(ButtonStyle.Danger).setEmoji('➖'),
          new ButtonBuilder().setCustomId(`appe__deploy__${panel.id}`).setLabel('Deploy').setStyle(ButtonStyle.Success).setEmoji('🚀'),
          new ButtonBuilder().setCustomId(`appe__back__${panel.id}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
        );
        return interaction.update({ embeds: [embed], components: [r1, r2] });
      }

      if (id === 'apd_select_deploy_panel') {
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === val);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        if (!panel.channel) return interaction.reply({ content: '❌ This panel has no channel set. Edit the panel first.', flags: MessageFlags.Ephemeral });
        if (!panel.appTypeIds.length) return interaction.reply({ content: '❌ This panel has no types. Edit the panel first.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const ch = interaction.guild.channels.cache.get(panel.channel);
          if (!ch) throw new Error('Channel not found.');
          const embed = new EmbedBuilder()
            .setTitle(panel.title || '📋 Applications')
            .setDescription(panel.description || 'Click a button below to apply!')
            .setColor(hexToInt(panel.color))
            .setThumbnail(LOGO_URL);
          if (panel.image) embed.setImage(panel.image);
          const rows = [];
          const types = panel.appTypeIds.map(tid => ac.appTypes.find(t => t.id === tid)).filter(Boolean);
          for (let i = 0; i < Math.min(types.length, 25); i += 5) {
            const chunk = types.slice(i, i + 5);
            rows.push(new ActionRowBuilder().addComponents(chunk.map(t => safeSetEmoji(new ButtonBuilder().setCustomId(`appopen__${t.id}__${panel.id}`).setLabel(t.label.slice(0, 80)).setStyle(ButtonStyle.Primary), t.emoji))));
          }
          await ch.send({ embeds: [embed], components: rows });
          await saveConfig(config);
          return interaction.editReply({ content: `✅ Panel **${panel.name}** deployed to <#${panel.channel}>!` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }

      // Panel type management from panel editor
      if (id.startsWith('appe_add_type__')) {
        const panelId = id.replace('appe_add_type__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        if (!panel.appTypeIds.includes(val)) { panel.appTypeIds.push(val); await saveConfig(config); }
        return interaction.reply({ content: `✅ Type added to panel!`, flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith('appe_remove_type__')) {
        const panelId = id.replace('appe_remove_type__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.appTypeIds = panel.appTypeIds.filter(tid => tid !== val);
        await saveConfig(config);
        return interaction.reply({ content: `✅ Type removed from panel!`, flags: MessageFlags.Ephemeral });
      }

      if (id === 'smd_edit') {
        const sm = getSavedMessagesConfig(guildId); const msg = sm.messages[val];
        if (!msg) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId(`modal_sm_edit__${val}`).setTitle(`Edit — ${msg.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setValue(msg.title || '').setMaxLength(80).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(msg.description || '').setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(msg.color || '').setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_image').setLabel('Image URL').setStyle(TextInputStyle.Short).setValue(msg.image || '').setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sm_footer').setLabel('Footer').setStyle(TextInputStyle.Short).setValue(msg.footer || '').setRequired(false)),
        );
        return interaction.showModal(modal);
      }
    }

    // ══ MODALS ══
    if (interaction.isModalSubmit()) {
      const mid = interaction.customId;

      // ── Counter labels ──
      if (mid === 'modal_cnt_labels') {
        const cc = getCounterConfig(guildId);
        cc.channels.members.label  = interaction.fields.getTextInputValue('cnt_lbl_members').trim()  || cc.channels.members.label;
        cc.channels.bots.label     = interaction.fields.getTextInputValue('cnt_lbl_bots').trim()     || cc.channels.bots.label;
        cc.channels.online.label   = interaction.fields.getTextInputValue('cnt_lbl_online').trim()   || cc.channels.online.label;
        cc.channels.channels.label = interaction.fields.getTextInputValue('cnt_lbl_channels').trim() || cc.channels.channels.label;
        cc.channels.roles.label    = interaction.fields.getTextInputValue('cnt_lbl_roles').trim()    || cc.channels.roles.label;
        await saveConfig(config);
        await updateCounters(interaction.guild).catch(() => {});
        return interaction.reply({ content: '✅ Labels updated and counters refreshed!', flags: MessageFlags.Ephemeral });
      }

      // ── Automod ──
      if (mid === 'modal_am_keywords') {
        const am = getAutomodConfig(guildId);
        const raw = interaction.fields.getTextInputValue('am_kw').trim();
        am.keywords = raw ? raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
        await saveConfig(config);
        return interaction.reply({ content: `✅ **${am.keywords.length}** keyword(s) set.`, flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_am_action') {
        const am = getAutomodConfig(guildId);
        const act = interaction.fields.getTextInputValue('am_act').trim().toLowerCase();
        const minsRaw = interaction.fields.getTextInputValue('am_mute_mins').trim();
        const mins = parseInt(minsRaw, 10);
        if (!['delete', 'delete+warn', 'delete+mute'].includes(act)) return interaction.reply({ content: '❌ Invalid action.', flags: MessageFlags.Ephemeral });
        am.action = act;
        if (!isNaN(mins) && mins > 0) am.muteMinutes = mins;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Action set to **${act}**.`, flags: MessageFlags.Ephemeral });
      }

      // ── Application deny reason ──
      if (mid.startsWith('modal_app_deny__')) {
        const parts = mid.replace('modal_app_deny__', '').split('__');
        const applicantId = parts[0]; const typeId = parts[1];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        const applicant = await interaction.guild.members.fetch(applicantId).catch(() => null);
        const reason = interaction.fields.getTextInputValue('deny_reason').trim();
        await interaction.update({
          embeds: [new EmbedBuilder().setTitle('❌ Application Denied').setColor(0xED4245)
            .addFields(
              { name: 'Applicant', value: applicant?.user.tag ?? applicantId, inline: true },
              { name: 'Type', value: appType?.label ?? typeId, inline: true },
              { name: 'Denied by', value: interaction.user.tag, inline: true },
              { name: '📝 Reason', value: reason, inline: false },
            ).setTimestamp()],
          components: [],
        });
        if (applicant) {
          const vars = {
            username: applicant.user.username,
            userMention: `<@${applicant.user.id}>`,
            type: appType?.label ?? 'application',
            server: interaction.guild.name,
            reason,
          };
          const rawDenyMsg = appType?.denyMessage
            ? appType.denyMessage
                .replace(/{username}/g, vars.username)
                .replace(/{userMention}/g, vars.userMention)
                .replace(/{type}/g, vars.type)
                .replace(/{server}/g, vars.server)
                .replace(/{reason}/g, vars.reason)
            : `❌ Sorry **${vars.username}**, your **${vars.type}** application in **${vars.server}** has been **denied**.\n\n**Reason:** ${reason}`;

          await applicant.send({ embeds: [new EmbedBuilder().setTitle('❌ Application Denied').setColor(0xED4245)
            .setDescription(rawDenyMsg)
            .setTimestamp()] }).catch(() => {});
        }
        if (ac.logChannel) {
          const logCh = interaction.guild.channels.cache.get(ac.logChannel);
          if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('❌ Application Denied').setColor(0xED4245)
            .addFields({ name: 'Applicant', value: applicant?.user.tag ?? applicantId, inline: true }, { name: 'Type', value: appType?.label ?? typeId, inline: true }, { name: 'Denied by', value: interaction.user.tag, inline: true }, { name: '📝 Reason', value: reason, inline: false }).setTimestamp()] });
        }
        return;
      }

      // ── Add application type ──
      if (mid === 'modal_ap_add_type') {
        const ac = getApplicationConfig(guildId);
        const label = interaction.fields.getTextInputValue('ap_label').trim();
        const emoji = interaction.fields.getTextInputValue('ap_emoji').trim() || null;
        const questionsRaw = interaction.fields.getTextInputValue('ap_questions').trim();
        const questions = questionsRaw.split('\n').map(q => q.trim()).filter(Boolean).slice(0, 60);
        if (!questions.length) return interaction.reply({ content: '❌ At least one question required.', flags: MessageFlags.Ephemeral });
        const newId = genId();
        ac.appTypes.push({ id: newId, label, emoji, questions, acceptRoles: [], acceptMessage: null, denyMessage: null, groupLink: null, nicknameFormat: null });
        await saveConfig(config);
        // Ask for accept roles
        return interaction.reply({
          content: `✅ Application type **${label}** created with **${questions.length}** question(s)!\n\n### 🎭 Select roles to give when accepted (optional — dismiss to skip)`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`apte_roles__${newId}`).setPlaceholder('Select accept roles (optional)...').setMinValues(0).setMaxValues(10))],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Add application panel ──
      if (mid === 'modal_ap_add_panel') {
        const ac = getApplicationConfig(guildId);
        const name  = interaction.fields.getTextInputValue('ap_panel_name').trim();
        const title = interaction.fields.getTextInputValue('ap_panel_title').trim();
        const desc  = interaction.fields.getTextInputValue('ap_panel_desc').trim() || null;
        const color = interaction.fields.getTextInputValue('ap_panel_color').trim() || '#5865F2';
        const pid = genId();
        ac.panels.push({ id: pid, name, title, description: desc, color, channel: null, reviewChannel: null, appTypeIds: [] });
        await saveConfig(config);
        // Open panel editor
        const panel = ac.panels.find(p => p.id === pid);
        const embed = new EmbedBuilder()
          .setTitle(`✏️ Editing Panel: ${panel.name}`)
          .setColor(hexToInt(panel.color))
          .setDescription('Configure this panel using the buttons below.\n\n1. Set the channel\n2. Add application types\n3. Deploy!')
          .addFields(
            { name: '📬 Channel', value: '*Not set*', inline: true },
            { name: '📢 Review Ch.', value: 'Global', inline: true },
            { name: '📝 Types', value: 'None', inline: false },
          );
        const r1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`appe__set_channel__${pid}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📬'),
          new ButtonBuilder().setCustomId(`appe__set_review_channel__${pid}`).setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
          new ButtonBuilder().setCustomId(`appe__edit_embed__${pid}`).setLabel('Edit Embed').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
        );
        const r2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`appe__add_type__${pid}`).setLabel('Add Type').setStyle(ButtonStyle.Success).setEmoji('➕'),
          new ButtonBuilder().setCustomId(`appe__deploy__${pid}`).setLabel('Deploy').setStyle(ButtonStyle.Success).setEmoji('🚀'),
          new ButtonBuilder().setCustomId(`appe__back__${pid}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({ embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral });
      }

      // ── Edit panel embed ──
      if (mid.startsWith('modal_appe_embed__')) {
        const panelId = mid.replace('modal_appe_embed__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.title       = interaction.fields.getTextInputValue('ap_panel_title').trim() || panel.title;
        panel.description = interaction.fields.getTextInputValue('ap_panel_desc').trim() || null;
        panel.color       = interaction.fields.getTextInputValue('ap_panel_color').trim() || panel.color;
        panel.image       = interaction.fields.getTextInputValue('ap_panel_image').trim() || null;
        await saveConfig(config);
        return interaction.reply({ content: '✅ Panel embed updated!', flags: MessageFlags.Ephemeral });
      }

      // ── Edit type questions ──
      if (mid.startsWith('modal_apte_questions__')) {
        const typeId = mid.replace('modal_apte_questions__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const questionsRaw = interaction.fields.getTextInputValue('ap_questions').trim();
        const questions = questionsRaw.split('\n').map(q => q.trim()).filter(Boolean).slice(0, 60);
        if (!questions.length) return interaction.reply({ content: '❌ At least one question required.', flags: MessageFlags.Ephemeral });
        appType.questions = questions;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Questions updated! **${questions.length}** question(s) set.`, flags: MessageFlags.Ephemeral });
      }

      // ── Saved messages ──
      if (mid === 'modal_sm_new') {
        const sm = getSavedMessagesConfig(guildId);
        const name = interaction.fields.getTextInputValue('sm_name').trim();
        if (Object.values(sm.messages).some(m => m.name.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `❌ **${name}** already exists.`, flags: MessageFlags.Ephemeral });
        const newId = genId();
        sm.messages[newId] = { name, title: interaction.fields.getTextInputValue('sm_title').trim(), description: interaction.fields.getTextInputValue('sm_desc').trim(), color: interaction.fields.getTextInputValue('sm_color').trim() || '#5865F2', image: interaction.fields.getTextInputValue('sm_image').trim() || null, footer: null };
        await saveConfig(config);
        return interaction.reply({ content: `✅ Saved message **${name}** created!`, flags: MessageFlags.Ephemeral });
      }
      if (mid.startsWith('modal_sm_edit__')) {
        const msgId = mid.replace('modal_sm_edit__', '');
        const sm = getSavedMessagesConfig(guildId); const msg = sm.messages[msgId];
        if (!msg) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
        const t = interaction.fields.getTextInputValue('sm_title').trim(); const d = interaction.fields.getTextInputValue('sm_desc').trim(); const c = interaction.fields.getTextInputValue('sm_color').trim(); const im = interaction.fields.getTextInputValue('sm_image').trim(); const f = interaction.fields.getTextInputValue('sm_footer').trim();
        if (t) msg.title = t; if (d) msg.description = d; if (c) msg.color = c; msg.image = im || null; msg.footer = f || null;
        await saveConfig(config); return interaction.reply({ content: `✅ Updated!`, flags: MessageFlags.Ephemeral });
      }

      // ── Welcomer ──
      if (mid === 'modal_wc_content') {
        const wc = getWelcomerConfig(guildId);
        const t = interaction.fields.getTextInputValue('wc_title').trim(); const d = interaction.fields.getTextInputValue('wc_desc').trim(); const c = interaction.fields.getTextInputValue('wc_color').trim(); const im = interaction.fields.getTextInputValue('wc_image').trim(); const f = interaction.fields.getTextInputValue('wc_footer').trim();
        if (t) wc.title = t; if (d) wc.description = d; if (c) wc.color = c; wc.image = im || null; wc.footer = f || null;
        await saveConfig(config); return interaction.reply({ content: '✅ Welcome message updated!', flags: MessageFlags.Ephemeral });
      }

      // ── Verification ──
      if (mid === 'modal_vc_content') {
        const vc = getVerificationConfig(guildId);
        const t = interaction.fields.getTextInputValue('vc_title').trim(); const d = interaction.fields.getTextInputValue('vc_desc').trim(); const c = interaction.fields.getTextInputValue('vc_color').trim(); const im = interaction.fields.getTextInputValue('vc_image').trim();
        if (t) vc.panelTitle = t; if (d) vc.panelDescription = d; if (c) vc.panelColor = c; vc.panelImage = im || null;
        await saveConfig(config); return interaction.reply({ content: '✅ Updated!', flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_erlcconfig') {
        const key = interaction.fields.getTextInputValue('erlc_server_key').trim();
        const ec = getErlcLogConfig(guildId);
        ec.serverKey = key;
        await saveConfig(config);
        // Test de key
        try {
          await erlcRequest('/server', 'GET', null, guildId);
          return interaction.reply({ content: `✅ ERLC Server Key saved and **verified**! The connection works.`, flags: MessageFlags.Ephemeral });
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
          // Genereer unieke code
          const code = `NYLRP-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
          pendingVerifications.set(interaction.user.id, {
            code,
            robloxUsername: robloxUser.name,
            robloxId: robloxUser.id,
            expires: Date.now() + 15 * 60 * 1000, // 15 minuten
          });
          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('✏️ Edit my Roblox Profile').setStyle(ButtonStyle.Link).setURL(`https://www.roblox.com/users/${robloxUser.id}/profile`),
            new ButtonBuilder().setCustomId('verify_confirm').setLabel('✅ Done, check my profile').setStyle(ButtonStyle.Success),
          );
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle('🔐 Step 2 — Add the code to your Roblox profile')
              .setColor(0xFEE75C)
              .setDescription([
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
              ].join('\n'))
            ],
            components: [confirmRow],
          });
        } catch (e) { return interaction.editReply({ content: `❌ Could not reach Roblox. Try again later.` }); }
      }

      if (mid.startsWith('modal_reqapprovals__')) {
        const type = mid.replace('modal_reqapprovals__', '');
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        const count = parseInt(interaction.fields.getTextInputValue('approvals_count'));
        if (isNaN(count) || count < 1 || count > 10) return interaction.reply({ content: '❌ Please enter a number between 1 and 10.', flags: MessageFlags.Ephemeral });
        cfg.requiredApprovals = count;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Required approvals set to **${count}**.`, flags: MessageFlags.Ephemeral });
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

        const embed = new EmbedBuilder()
          .setTitle(`📋 ${type} Request`)
          .setColor(isExec ? 0x5865F2 : 0xFEE75C)
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: '👤 Submitted By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
            { name: '⚡ Action', value: action, inline: true },
            { name: '🎯 Person Concerned', value: person, inline: false },
            { name: '📝 Reason', value: reason, inline: false },
            { name: `✅ Approvals (0/${required})`, value: '*No approvals yet*', inline: false },
            { name: '❌ Denials (0)', value: '*No denials yet*', inline: false },
            { name: '📊 Status', value: '⏳ Pending', inline: false },
          )
          .setFooter({ text: `Request ID: ${reqId} • Requires ${required} approvals` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req__approve__${prefix}__${reqId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`req__deny__${prefix}__${reqId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
        );

        const ping = cfg.approvalRoles?.length ? cfg.approvalRoles.map(r => `<@&${r}>`).join(' ') : null;
        await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ Your **${type} Request** has been submitted!`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_hb_create') {
        const hc = getHandbookConfig(guildId);
        const title = interaction.fields.getTextInputValue('hb_title').trim();
        const description = interaction.fields.getTextInputValue('hb_description').trim() || null;
        const panelId = genId();
        hc.panels[panelId] = { title, description, channel: null, messageId: null, books: [] };
        await saveConfig(config);
        return interaction.reply({ content: `✅ Panel **${title}** created! Configure it below.`, flags: MessageFlags.Ephemeral, ...buildHandbookPanelEditor(guildId, panelId) });
      }

      if (mid.startsWith('modal_hb_add_book__')) {
        const panelId = mid.replace('modal_hb_add_book__', '');
        const hc = getHandbookConfig(guildId);
        const panel = hc.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const label = interaction.fields.getTextInputValue('hb_book_label').trim();
        const url   = interaction.fields.getTextInputValue('hb_book_url').trim();
        const bookId = genId();
        if (!panel.books) panel.books = [];
        panel.books.push({ id: bookId, label, url, requiredRoles: [] });
        await saveConfig(config);
        // Ask for required roles
        return interaction.reply({
          content: `✅ Book **${label}** added!\n\n### 🔒 Select required roles for this book (leave empty = everyone can see it):`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`hb_book_roles__${panelId}__${bookId}`).setPlaceholder('Select roles (0 = everyone)...').setMinValues(0).setMaxValues(10))],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Ticket ──
      if (mid === 'modal_t_embed')   { const tc = getTicketConfig(guildId); const t = interaction.fields.getTextInputValue('t_embed_title').trim(); const d = interaction.fields.getTextInputValue('t_embed_desc').trim(); const c = interaction.fields.getTextInputValue('t_embed_color').trim(); const th = interaction.fields.getTextInputValue('t_embed_thumbnail').trim(); if (t) tc.panelTitle = t; if (d) tc.panelDescription = d; if (c) tc.panelColor = c; if (th) tc.panelThumbnail = th; await saveConfig(config); return interaction.reply({ content: '✅ Panel embed updated!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_t_welcome') { const tc = getTicketConfig(guildId); tc.welcomeText = interaction.fields.getTextInputValue('t_welcome_text').trim(); await saveConfig(config); return interaction.reply({ content: '✅ Welcome text saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_t_add_type') { const tc = getTicketConfig(guildId); tc.ticketTypes.push({ id: genId(), label: interaction.fields.getTextInputValue('tt_label').trim(), emoji: interaction.fields.getTextInputValue('tt_emoji').trim() || null, color: interaction.fields.getTextInputValue('tt_color').trim() || 'blue', description: interaction.fields.getTextInputValue('tt_description').trim() || null }); await saveConfig(config); return interaction.reply({ content: `✅ Ticket type added!`, flags: MessageFlags.Ephemeral }); }

      // ── Session ──
      if (mid === 'modal_s_joinlink')  { const rawLink = interaction.fields.getTextInputValue('s_link_val').trim(); if (!isValidUrl(rawLink)) return interaction.reply({ content: '❌ Invalid URL.', flags: MessageFlags.Ephemeral }); getSessionConfig(guildId).joinLink = rawLink; await saveConfig(config); return interaction.reply({ content: `✅ Join link saved!`, flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_tr_announce_msg') {
        const tc = getTrainingConfig(guildId);
        tc.announceMessage = interaction.fields.getTextInputValue('announce_msg').trim() || null;
        await saveConfig(config);
        return interaction.reply({ content: `✅ Announce message saved!`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_trainrequest') {
        const tc = getTrainingConfig(guildId);
        const ch = interaction.guild.channels.cache.get(tc.channel);
        if (!ch) return interaction.reply({ content: '❌ Training channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        const times = interaction.fields.getTextInputValue('tr_times');
        const notes = interaction.fields.getTextInputValue('tr_notes').trim();
        const reqId = genId();
        const embed = new EmbedBuilder()
          .setTitle('📋 Training Request')
          .setColor(0x5865F2)
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: '👤 Requester', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
            { name: '🆔 User ID', value: interaction.user.id, inline: true },
            { name: '🕐 Available Times', value: times, inline: false },
            { name: '📝 Notes', value: notes || '*None*', inline: false },
            { name: '✅ Claimed By', value: '*No one yet*', inline: false },
          )
          .setFooter({ text: `Request ID: ${reqId}` })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tr__claim__${interaction.user.id}__${reqId}`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`tr__unclaim__${interaction.user.id}__${reqId}`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`tr__pass__${interaction.user.id}__${reqId}`).setLabel('✅ Pass').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tr__fail__${interaction.user.id}__${reqId}`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger),
        );
        const ping = tc.pingRoles.length ? tc.pingRoles.map(r => `<@&${r}>`).join(' ') : null;
        await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        // Sla cooldown op
        const cdKey = `${guildId}:${interaction.user.id}`;
        trainRequestCooldowns.set(cdKey, Date.now());
        return interaction.reply({ content: `✅ Your training request has been posted! A trainer will claim it soon.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_send') {
        const content = interaction.fields.getTextInputValue('send_content');
        await interaction.channel.send({ content });
        return interaction.reply({ content: '✅ Message sent!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_s_desc')      { const sc = getSessionConfig(guildId); const s = interaction.fields.getTextInputValue('s_start_desc').trim(); const v = interaction.fields.getTextInputValue('s_vote_desc').trim(); const sh = interaction.fields.getTextInputValue('s_shutdown_desc').trim(); if (s) sc.startDescription = s; if (v) sc.voteDescription = v; if (sh) sc.shutdownDescription = sh; await saveConfig(config); return interaction.reply({ content: '✅ Descriptions saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_s_images')    { const sc = getSessionConfig(guildId); const si = interaction.fields.getTextInputValue('s_start_img').trim(); const vi = interaction.fields.getTextInputValue('s_vote_img').trim(); const hi = interaction.fields.getTextInputValue('s_shutdown_img').trim(); if (si) sc.startImage = si; if (vi) sc.voteImage = vi; if (hi) sc.shutdownImage = hi; await saveConfig(config); return interaction.reply({ content: '✅ Images saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_s_threshold') { const num = parseInt(interaction.fields.getTextInputValue('s_threshold_val').trim(), 10); if (isNaN(num) || num < 1 || num > 999) return interaction.reply({ content: '❌ Enter a number 1-999.', flags: MessageFlags.Ephemeral }); getSessionConfig(guildId).voteThreshold = num; await saveConfig(config); return interaction.reply({ content: `✅ Vote threshold: **${num}**.`, flags: MessageFlags.Ephemeral }); }

      // ── Announcement ──
      if (mid === 'modal_an_new') {
        const ac = getAnnouncementConfig(guildId);
        const name = interaction.fields.getTextInputValue('an_name').trim();
        if (Object.values(ac.types).some(t => t.name.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `❌ **${name}** already exists.`, flags: MessageFlags.Ephemeral });
        const tid = genId();
        ac.types[tid] = { name, emoji: interaction.fields.getTextInputValue('an_emoji').trim() || null, title: interaction.fields.getTextInputValue('an_title').trim(), description: interaction.fields.getTextInputValue('an_desc').trim() || null, color: interaction.fields.getTextInputValue('an_color').trim() || '#ED4245', channel: null, pingRole: null, image: null };
        await saveConfig(config); return interaction.reply({ ...buildAnnouncementEditor(guildId, tid) });
      }
      if (mid.startsWith('modal_an_content__')) {
        const typeId = mid.replace('modal_an_content__', '');
        const t = getAnnouncementConfig(guildId).types[typeId];
        if (!t) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const title = interaction.fields.getTextInputValue('an_c_title').trim(); const desc = interaction.fields.getTextInputValue('an_c_desc').trim(); const color = interaction.fields.getTextInputValue('an_c_color').trim(); const image = interaction.fields.getTextInputValue('an_c_image').trim(); const emoji = interaction.fields.getTextInputValue('an_c_emoji').trim();
        if (title) t.title = title; if (desc) t.description = desc; if (color) t.color = color; if (image) t.image = image; if (emoji) t.emoji = emoji;
        await saveConfig(config); return interaction.update(buildAnnouncementEditor(guildId, typeId));
      }

      // ── Application type: nickname formaat ──
      if (mid.startsWith('modal_apte_nickname__')) {
        const typeId = mid.replace('modal_apte_nickname__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const fmt = interaction.fields.getTextInputValue('nickname_format').trim();
        appType.nicknameFormat = fmt || null;
        await saveConfig(config);
        return interaction.reply({
          content: fmt
            ? [
                `✅ **Nickname format set:** \`${fmt}\``,
                '',
                '**Available variables:**',
                '`{user}` of `{username}` — username of the applicant',
                '`{rank}` — name of the application type',
                '',
                `**Voorbeeld:** \`${fmt.replace(/{user}/g, 'JohnDoe').replace(/{username}/g, 'JohnDoe').replace(/{rank}/g, appType.label)}\``,
              ].join('\n')
            : '✅ Nickname format **disabled**. Nickname will no longer be changed automatically.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Application type: DM Messages ──
      if (mid.startsWith('modal_apte_messages__')) {
        const typeId = mid.replace('modal_apte_messages__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const acceptMsg = interaction.fields.getTextInputValue('accept_msg').trim();
        const denyMsg   = interaction.fields.getTextInputValue('deny_msg').trim();
        appType.acceptMessage = acceptMsg || null;
        appType.denyMessage   = denyMsg   || null;
        await saveConfig(config);
        return interaction.reply({
          content: [
            '✅ **DM messages saved!**',
            '',
            '**Available variables:**',
            '`{username}` — name of the applicant',
            '`{userMention}` — mention of the applicant',
            '`{type}` — name of the application type',
            '`{server}` — name of the server',
            '`{reason}` — reason *(only in deny message)*',
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Application type: groep link ──
      if (mid.startsWith('modal_apte_grouplink__')) {
        const typeId = mid.replace('modal_apte_grouplink__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const link = interaction.fields.getTextInputValue('group_link').trim();
        if (link && !isValidUrl(link)) return interaction.reply({ content: '❌ Invalid URL. Must start with `https://`.', flags: MessageFlags.Ephemeral });
        appType.groupLink = link || null;
        await saveConfig(config);
        return interaction.reply({
          content: link
            ? `✅ Group link set! Upon acceptance the user will receive a **"Join the group!"** button in their DM.`
            : `✅ Group link removed.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Self roles ──
      if (mid === 'modal_sr_new') {
        const src = getSelfRoleConfig(guildId);
        const type = interaction.fields.getTextInputValue('sr_type').trim().toLowerCase();
        if (!['buttons', 'dropdown', 'reaction'].includes(type)) return interaction.reply({ content: '❌ Type must be `buttons`, `dropdown`, or `reaction`.', flags: MessageFlags.Ephemeral });
        const pid = genId();
        src.panels[pid] = { title: interaction.fields.getTextInputValue('sr_title').trim(), description: interaction.fields.getTextInputValue('sr_desc').trim() || null, color: interaction.fields.getTextInputValue('sr_color').trim() || null, thumbnail: null, channel: null, messageId: null, type, max: parseInt(interaction.fields.getTextInputValue('sr_max').trim(), 10) || 0, roles: [] };
        await saveConfig(config); return interaction.reply({ ...buildPanelEditor(guildId, pid) });
      }
      if (mid.startsWith('modal_sr_embed__')) {
        const panelId = mid.replace('modal_sr_embed__', '');
        const panel = getSelfRoleConfig(guildId).panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const t = interaction.fields.getTextInputValue('sr_e_title').trim(); const d = interaction.fields.getTextInputValue('sr_e_desc').trim(); const c = interaction.fields.getTextInputValue('sr_e_color').trim(); const th = interaction.fields.getTextInputValue('sr_e_thumbnail').trim();
        if (t) panel.title = t; if (d) panel.description = d; if (c) panel.color = c; if (th) panel.thumbnail = th;
        await saveConfig(config); return interaction.reply({ content: '✅ Panel embed updated!', flags: MessageFlags.Ephemeral });
      }
      if (mid.startsWith('modal_sr_rolelabel__')) {
        const panelId = mid.replace('modal_sr_rolelabel__', '');
        const src = getSelfRoleConfig(guildId); const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const pending = srPendingRoleAdd.get(interaction.user.id);
        if (!pending || pending.panelId !== panelId) return interaction.reply({ content: '❌ Session expired, try again.', flags: MessageFlags.Ephemeral });
        const label    = interaction.fields.getTextInputValue('sr_rl_label').trim();
        const emoji    = interaction.fields.getTextInputValue('sr_rl_emoji')?.trim() || null;
        const reaction = interaction.fields.getTextInputValue('sr_rl_reaction')?.trim() || null;
        const desc     = interaction.fields.getTextInputValue('sr_rl_desc')?.trim() || null;
        panel.roles.push({ id: pending.roleId, label: label.slice(0, 80), emoji, reaction, description: desc });
        await saveConfig(config); srPendingRoleAdd.delete(interaction.user.id);
        return interaction.reply({ content: `✅ Added <@&${pending.roleId}> to **${panel.title}**!`, flags: MessageFlags.Ephemeral });
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

// Start: eerst DB verbinden, dan bot inloggen
(async () => {
  await connectDB();
  await client.login(process.env.TOKEN);
})();
