require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  AttachmentBuilder, MessageFlags, ModalBuilder, TextInputBuilder,
  TextInputStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
} = require('discord.js');

// ════════════════════════════════════════════
// CLIENT
// ════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel],
});

// ════════════════════════════════════════════
// MONGODB MODELS
// ════════════════════════════════════════════
const guildConfigSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // guildId
  tickets: {
    categoryId:       { type: String, default: null },
    logChannelId:      { type: String, default: null },
    supportRoleIds:    { type: [String], default: [] },
    panelChannelId:    { type: String, default: null },
    panelMessageId:    { type: String, default: null },
    panelTitle:        { type: String, default: '🎫 Support Tickets' },
    panelDescription:  { type: String, default: 'Need help? Click the button below (or pick a category) to open a ticket.' },
    panelColor:        { type: String, default: '#5865F2' },
    panelImage:        { type: String, default: null },
    panelThumbnail:    { type: String, default: null },
    types: {
      type: [{
        id: String, label: String, emoji: String, description: String, image: String, thumbnail: String,
        supportRoleIds: { type: [String], default: [] },
        requireReason: { type: Boolean, default: false },
      }],
      default: [{ id: 'general', label: 'General Support', emoji: '🎫', description: 'General questions or help', image: null, thumbnail: null, supportRoleIds: [], requireReason: false }],
    },
    nextNumber: { type: Number, default: 1 },
  },
  moderation: {
    modRoleIds:      { type: [String], default: [] },
    modLogChannelId: { type: String, default: null },
    level2RoleIds:   { type: [String], default: [] },
    level3RoleIds:   { type: [String], default: [] },
  },
  training: {
    channel:         { type: String, default: null },
    announceChannel: { type: String, default: null },
    trainerRoles:    { type: [String], default: [] },
    requestRoles:    { type: [String], default: [] },
    pingRoles:       { type: [String], default: [] },
    types: {
      type: [{ id: String, name: String, roleIds: { type: [String], default: [] } }],
      default: [],
    },
  },
  nicknamePrefixes: {
    type: [{ roleId: String, prefix: String }],
    default: [],
  },
  welcome: {
    enabled:      { type: Boolean, default: false },
    channelId:    { type: String, default: null },
    embedEnabled: { type: Boolean, default: true },
    title:        { type: String, default: '👋 Welcome!' },
    message:      { type: String, default: 'Welcome {user} to **{server}**! You are member #{membercount}.' },
    color:        { type: String, default: '#57F287' },
    image:        { type: String, default: null },
    thumbnail:    { type: String, default: null },
    dmEnabled:    { type: Boolean, default: false },
    dmMessage:    { type: String, default: 'Welcome to {server}! We\'re glad to have you.' },
  },
  coc: {
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    title:     { type: String, default: '🔱 Chain of Command' },
  },
  staffAccess: {
    shrRoleIds: { type: [String], default: [] },
    hrRoleIds: { type: [String], default: [] },
    approvalRoleIds: { type: [String], default: [] },
    requestChannelId: { type: String, default: null },
    infractionChannelId: { type: String, default: null },
  },
  caseManagement: {
    systems: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
}, { strict: false, timestamps: true });
const GuildConfigModel = mongoose.model('GuildConfig', guildConfigSchema);

const ticketSchema = new mongoose.Schema({
  guildId:      { type: String, required: true, index: true },
  channelId:    { type: String, required: true, unique: true },
  number:       { type: Number, default: 0 },
  creatorId:    { type: String, required: true },
  typeId:       { type: String, default: null },
  typeLabel:    { type: String, default: 'Support' },
  status:       { type: String, enum: ['open', 'closed', 'archived'], default: 'open' },
  claimedBy:    { type: String, default: null },
  staffMembers: { type: [String], default: [] },
  priority:     { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  notes:        { type: [{ authorId: String, text: String, createdAt: Date }], default: [] },
  reason:       { type: String, default: null },
  rating:       { type: Number, default: null },
  ratingFeedback: { type: String, default: null },
  createdAt:    { type: Date, default: Date.now },
  closedAt:     { type: Date, default: null },
  archivedAt:   { type: Date, default: null },
}, { timestamps: true });
const TicketModel = mongoose.model('Ticket', ticketSchema);

const warningSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  userId:      { type: String, required: true, index: true },
  moderatorId: { type: String, required: true },
  reason:      { type: String, default: 'No reason provided' },
  createdAt:   { type: Date, default: Date.now },
});
const WarningModel = mongoose.model('Warning', warningSchema);

const modNoteSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  userId:    { type: String, required: true, index: true },
  authorId:  { type: String, required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const ModNoteModel = mongoose.model('ModNote', modNoteSchema);

const tempBanSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  userId:      { type: String, required: true, index: true },
  moderatorId: { type: String, required: true },
  reason:      { type: String, default: 'No reason provided' },
  unbanAt:     { type: Date, required: true, index: true },
  createdAt:   { type: Date, default: Date.now },
});
const TempBanModel = mongoose.model('TempBan', tempBanSchema);

const trainingRequestSchema = new mongoose.Schema({
  guildId:      { type: String, required: true, index: true },
  requesterId:  { type: String, required: true, index: true },
  channelId:    { type: String, required: true },
  messageId:    { type: String, required: true },
  typeId:       { type: String, default: null },
  typeName:     { type: String, default: null },
  status:       { type: String, enum: ['open', 'passed', 'failed'], default: 'open' },
  claimedBy:    { type: [String], default: [] },
  resolvedBy:   { type: String, default: null },
  createdAt:    { type: Date, default: Date.now },
});
const TrainingRequestModel = mongoose.model('TrainingRequest', trainingRequestSchema);

const trainCooldownSchema = new mongoose.Schema({
  _id:      { type: String, required: true }, // `${guildId}:${userId}`
  lastUsed: { type: Date, required: true },
});
const TrainCooldownModel = mongoose.model('TrainCooldown', trainCooldownSchema);

const staffRequestSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  kind: { type: String, enum: ['promotion', 'disciplinary', 'case_infraction'], required: true },
  action: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  requesterId: { type: String, required: true },
  approverId: { type: String, default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'executed', 'failed'], default: 'pending' },
  channelId: { type: String, default: null },
  messageId: { type: String, default: null },
  caseNumber: { type: Number, default: null },
  result: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });
const StaffRequestModel = mongoose.model('StaffRequest', staffRequestSchema);

const caseFileSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  number: { type: Number, required: true },
  system: { type: String, enum: ['ia', 'management', 'supervisor', 'executive'], required: true },
  channelId: { type: String, required: true },
  threadId: { type: String, required: true, unique: true },
  reportingPartyId: { type: String, required: true },
  reportedPartyId: { type: String, required: true },
  reason: { type: String, required: true },
  status: { type: String, enum: ['Open', 'Under Investigation', 'Awaiting Approval', 'Resolved', 'Closed'], default: 'Open' },
  investigatorIds: { type: [String], default: [] },
  supervisorIds: { type: [String], default: [] },
  notes: { type: [{ authorId: String, text: String, createdAt: Date }], default: [] },
  bothSides: { type: String, default: null },
  createdBy: { type: String, required: true },
  closedAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
  nextNumberKey: { type: String, required: true },
}, { timestamps: true });
caseFileSchema.index({ guildId: 1, nextNumberKey: 1, number: 1 }, { unique: true });
const CaseFileModel = mongoose.model('CaseFile', caseFileSchema);

async function postStaffRequest(guild, cfg, data) {
  const channel = cfg.staffAccess?.requestChannelId ? guild.channels.cache.get(cfg.staffAccess.requestChannelId) : null;
  if (!channel) throw new Error('Approval channel is not configured. Set it in /setup → Staff Access.');
  const record = await StaffRequestModel.create({ guildId: guild.id, ...data });
  const roleIds = cfg.staffAccess?.approvalRoleIds?.length ? cfg.staffAccess.approvalRoleIds : (cfg.staffAccess?.shrRoleIds || []);
  const ping = roleIds.map(id => `<@&${id}>`).join(' ');
  const embed = new EmbedBuilder().setTitle(`⏳ Approval Request #${record._id.toString().slice(-6)}`).setColor(0xFEE75C)
    .addFields(
      { name: 'Type', value: data.kind },
      { name: 'Action', value: data.action },
      { name: 'Requested by', value: `<@${data.requesterId}>` },
      { name: 'Details', value: JSON.stringify(data.payload).slice(0, 1000) },
    ).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`staffreq__approve__${record._id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`staffreq__reject__${record._id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
  const message = await channel.send({ content: ping || undefined, embeds: [embed], components: [row], allowedMentions: { roles: roleIds } });
  record.channelId = channel.id; record.messageId = message.id; await record.save();
  return record;
}

async function executeStaffRequest(interaction, record) {
  const p = record.payload;
  if (record.kind === 'promotion') {
    const target = await interaction.guild.members.fetch(p.targetUserId);
    const currentRole = interaction.guild.roles.cache.get(p.currentRoleId);
    const newRole = interaction.guild.roles.cache.get(p.newRoleId);
    if (!target || !currentRole || !newRole || !target.roles.cache.has(currentRole.id)) throw new Error('Promotion target or rank changed; request cannot be executed.');
    const embed = new EmbedBuilder().setTitle('NYLRP | Promotion').setColor(p.promotionType === 'coc' ? 0x5865F2 : 0x57F287)
      .setThumbnail(target.user.displayAvatarURL()).addFields(
        { name: 'Member', value: `<@${p.targetUserId}>`, inline: true },
        { name: 'Department', value: p.department, inline: true },
        { name: 'Promotion Type', value: p.promotionType === 'coc' ? 'CoC' : 'Overig', inline: true },
        { name: 'Previous Rank', value: `<@&${p.currentRoleId}>`, inline: true },
        { name: 'New Rank', value: `<@&${p.newRoleId}>`, inline: true },
        { name: 'Reason', value: p.reason.slice(0, 1024) },
        { name: 'Requested by', value: `<@${record.requesterId}>`, inline: true },
        { name: 'Approved by', value: `<@${interaction.user.id}>`, inline: true },
      ).setTimestamp().setFooter({ text: 'NYLRP Promotion System' });
    await interaction.channel.send({ embeds: [embed] });
    return 'Promotion announcement posted.';
  }
  const user = p.userId ? await interaction.client.users.fetch(p.userId) : null;
  if (record.kind === 'disciplinary') {
    const target = await interaction.guild.members.fetch(p.userId).catch(() => null);
    if (record.action === 'warn') {
      if (!user) throw new Error('Target user not found.');
      await WarningModel.create({ guildId: interaction.guildId, userId: p.userId, moderatorId: interaction.user.id, reason: p.reason });
      await safeDM(user, { content: `⚠️ You were warned in **${interaction.guild.name}**: ${p.reason}` });
      return 'Warning recorded.';
    }
    if (!target) throw new Error('Target must be a current server member.');
    if (record.action === 'mute') { await target.timeout(p.minutes * 60000, p.reason); return 'Mute applied.'; }
    if (record.action === 'kick') { await target.kick(p.reason); return 'Member kicked.'; }
    if (record.action === 'ban') { await interaction.guild.members.ban(p.userId, { reason: p.reason, deleteMessageSeconds: (p.deleteDays || 0) * 86400 }); return 'Member banned.'; }
    if (record.action === 'tempban') {
      const unbanAt = new Date(Date.now() + p.hours * 3600000);
      await interaction.guild.members.ban(p.userId, { reason: p.reason });
      await TempBanModel.findOneAndUpdate({ guildId: interaction.guildId, userId: p.userId }, { guildId: interaction.guildId, userId: p.userId, moderatorId: interaction.user.id, reason: p.reason, unbanAt }, { upsert: true });
      return 'Temporary ban applied.';
    }
    if (record.action === 'demotion') {
      const role = interaction.guild.roles.cache.get(p.roleId);
      if (!role || !target.roles.cache.has(role.id)) throw new Error('The role to remove is no longer assigned.');
      await target.roles.remove(role.id, p.reason); return 'Demotion role removed.';
    }
    if (record.action === 'unmute') { await target.timeout(null, p.reason); return 'Mute removed.'; }
    throw new Error('Unsupported disciplinary action.');
  }
  throw new Error('Unsupported approval request type.');
}

let dbReady = false;
async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ FATAL: MONGODB_URI is not set. Bot cannot start without persistent storage.');
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ MongoDB connected!');
    dbReady = true;
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    console.error('⚠️ Bot running without persistent storage! Add MONGODB_URI to .env');
  }
}
mongoose.connection.on('disconnected', () => { console.warn('⚠️ MongoDB disconnected. Attempting reconnect...'); dbReady = false; });
mongoose.connection.on('reconnected', () => { console.log('✅ MongoDB reconnected.'); dbReady = true; });

// ════════════════════════════════════════════
// GUILD CONFIG CACHE
// ════════════════════════════════════════════
const configCache = new Map();
// Bridges the two-step "select roles, then set a prefix" flow (a modal can't carry an arbitrary list
// of role IDs in its customId due to Discord's 100-char limit), keyed by the staff member's user ID.
const pendingPrefixRoleSelections = new Map();
const pendingCocImports = new Map();

function defaultConfig(guildId) {
  return {
    _id: guildId,
    tickets: {
      categoryId: null,
      logChannelId: null,
      supportRoleIds: [],
      panelChannelId: null,
      panelMessageId: null,
      panelTitle: '🎫 Support Tickets',
      panelDescription: 'Need help? Click the button below (or pick a category) to open a ticket.',
      panelColor: '#5865F2',
      panelImage: null,
      panelThumbnail: null,
      types: [{ id: 'general', label: 'General Support', emoji: '🎫', description: 'General questions or help', image: null, thumbnail: null, supportRoleIds: [], requireReason: false }],
      nextNumber: 1,
    },
    moderation: { modRoleIds: [], modLogChannelId: null, level2RoleIds: [], level3RoleIds: [] },
    training: { channel: null, announceChannel: null, trainerRoles: [], requestRoles: [], pingRoles: [], types: [] },
    nicknamePrefixes: [],
    welcome: {
      enabled: false, channelId: null, embedEnabled: true, title: '👋 Welcome!',
      message: 'Welcome {user} to **{server}**! You are member #{membercount}.',
      color: '#57F287', image: null, thumbnail: null, dmEnabled: false,
      dmMessage: 'Welcome to {server}! We\'re glad to have you.',
    },
    coc: { channelId: null, messageId: null, title: '🔱 Chain of Command', ranks: [] },
    staffAccess: { shrRoleIds: [], hrRoleIds: [], approvalRoleIds: [], requestChannelId: null, infractionChannelId: null },
    caseManagement: { systems: {
      ia: { label: 'Internal Affairs', channelId: null, logChannelId: null, pingRoleIds: [], accessRoleIds: [], createRoleIds: [], investigatorRoleIds: [], supervisorRoleIds: [] },
      management: { label: 'Management', channelId: null, logChannelId: null, pingRoleIds: [], accessRoleIds: [], createRoleIds: [], investigatorRoleIds: [], supervisorRoleIds: [] },
      supervisor: { label: 'Supervisor', channelId: null, logChannelId: null, pingRoleIds: [], accessRoleIds: [], createRoleIds: [], investigatorRoleIds: [], supervisorRoleIds: [] },
      executive: { label: 'Executive', channelId: null, logChannelId: null, pingRoleIds: [], accessRoleIds: [], createRoleIds: [], investigatorRoleIds: [], supervisorRoleIds: [] },
    } },
  };
}

async function getConfig(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId);
  let doc = null;
  try { doc = await GuildConfigModel.findById(guildId).lean(); } catch (e) { console.error('getConfig error:', e.message); }
  const cfg = doc ? {
        ...defaultConfig(guildId), ...doc,
        tickets: { ...defaultConfig(guildId).tickets, ...(doc.tickets || {}) },
        moderation: { ...defaultConfig(guildId).moderation, ...(doc.moderation || {}) },
        training: { ...defaultConfig(guildId).training, ...(doc.training || {}) },
        nicknamePrefixes: doc.nicknamePrefixes || [],
        welcome: { ...defaultConfig(guildId).welcome, ...(doc.welcome || {}) },
        coc: { ...defaultConfig(guildId).coc, ...(doc.coc || {}), ranks: doc.coc?.ranks || [] },
        staffAccess: { ...defaultConfig(guildId).staffAccess, ...(doc.staffAccess || {}) },
        caseManagement: { ...defaultConfig(guildId).caseManagement, ...(doc.caseManagement || {}), systems: { ...defaultConfig(guildId).caseManagement.systems, ...(doc.caseManagement?.systems || {}) } },
      }
                  : defaultConfig(guildId);
  configCache.set(guildId, cfg);
  return cfg;
}

async function saveConfig(guildId) {
  const cfg = configCache.get(guildId);
  if (!cfg) return false;
  if (!dbReady) {
    console.error(`❌ saveConfig(${guildId}): MongoDB not connected — change kept in memory only, will NOT survive a restart.`);
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await GuildConfigModel.findByIdAndUpdate(guildId, { $set: {
        tickets: cfg.tickets, moderation: cfg.moderation, training: cfg.training,
        nicknamePrefixes: cfg.nicknamePrefixes, welcome: cfg.welcome, coc: cfg.coc,
        staffAccess: cfg.staffAccess, caseManagement: cfg.caseManagement,
      } }, { upsert: true });
      return true;
    } catch (e) {
      console.error(`❌ saveConfig(${guildId}) attempt ${attempt}/2 failed:`, e.message);
      if (attempt === 2) return false;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
}

// Generic helper: retries a mongoose write once before giving up, logging clearly either way.
async function safeSave(fn, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { ok: true, result: await fn() };
    } catch (e) {
      console.error(`❌ DB write failed (${label}), attempt ${attempt}/2:`, e.message);
      if (attempt === 2) return { ok: false, result: null };
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return { ok: false, result: null };
}

// Same as safeSave, named for readability at Model.create(...) call sites.
async function safeCreate(Model, data, label) {
  const { ok, result } = await safeSave(() => Model.create(data), label);
  return ok ? result : null;
}

// ════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════
function userDisplay(user) { return user.tag ?? user.username ?? user.id; }

function hexToInt(hex) {
  if (!hex) return 0x5865F2;
  const cleaned = String(hex).trim().replace(/^#/, '');
  const n = parseInt(cleaned, 16);
  return Number.isNaN(n) ? 0x5865F2 : n;
}

function isValidUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function isTicketStaff(member, cfg, ticket = null) {
  if (isAdmin(member)) return true;
  if (cfg.tickets.supportRoleIds.some(rid => member.roles.cache.has(rid))) return true;
  if (ticket) {
    const type = cfg.tickets.types.find(t => t.id === ticket.typeId);
    if (type?.supportRoleIds?.length && type.supportRoleIds.some(rid => member.roles.cache.has(rid))) return true;
  }
  return false;
}

// Resolve which support roles apply for a given ticket type (type-specific overrides, falling back to global)
function resolveSupportRoleIds(cfg, type) {
  return (type?.supportRoleIds && type.supportRoleIds.length) ? type.supportRoleIds : cfg.tickets.supportRoleIds;
}

function hasAnyConfiguredRole(member, ids = []) {
  return Boolean(member && ids?.some(id => member.roles?.cache?.has(id)));
}
function isOwner(member) {
  return Boolean(member && member.id === member.guild?.ownerId);
}
function isSHR(member, cfg) {
  return isOwner(member) || hasAnyConfiguredRole(member, cfg.staffAccess?.shrRoleIds || []);
}
function isHR(member, cfg) {
  return isOwner(member) || hasAnyConfiguredRole(member, cfg.staffAccess?.hrRoleIds || []);
}
function canApproveStaffRequest(member, cfg) {
  const ids = cfg.staffAccess?.approvalRoleIds?.length ? cfg.staffAccess.approvalRoleIds : (cfg.staffAccess?.shrRoleIds || []);
  return isOwner(member) || hasAnyConfiguredRole(member, ids);
}

function isModerator(member, cfg) {
  if (isAdmin(member)) return true;
  return cfg.moderation.modRoleIds.some(rid => member.roles.cache.has(rid));
}

// ── Staff hierarchy: prevents lower-ranked moderators from using the most powerful commands ──
// Level 1 = base staff (anyone in modRoleIds). Level 2/3 require the extra rank roles configured
// via /setup → Moderation. Levels are opt-in: if an admin never configures level2/3RoleIds, every
// staff member in modRoleIds keeps the old (unrestricted) behavior.
// Standard rank hierarchy (highest → lowest) used by /seedrankprefixes. Each entry is matched
// against an existing role's exact name (case-insensitive) — the role itself isn't created.
const STANDARD_RANK_PREFIXES = [
  'F', 'CF', 'EO', 'D', 'DD', 'AD', 'SMGMT', 'JMGMT', 'CoS', 'ACoS',
  'IAD', 'IAAD', 'IAS', 'IAI', 'HA', 'SA', 'JA', 'A', 'HM', 'SM', 'JM', 'M',
];

const COMMAND_LEVELS = {
  warn: 1, warnings: 1, note: 1, notes: 1, clear: 1, slowmode: 1, lock: 1, unlock: 1,
  mute: 2, unmute: 2, kick: 2, nickname: 2, clearwarnings: 2,
  ban: 3, unban: 3, softban: 3, tempban: 3, removerole: 3, giveroles: 3,
};

function getStaffLevel(member, cfg) {
  if (isAdmin(member)) return 3;
  if (!isModerator(member, cfg)) return 0;
  let level = 1;
  if (cfg.moderation.level2RoleIds?.length && cfg.moderation.level2RoleIds.some(rid => member.roles.cache.has(rid))) level = 2;
  if (cfg.moderation.level3RoleIds?.length && cfg.moderation.level3RoleIds.some(rid => member.roles.cache.has(rid))) level = 3;
  return level;
}

function hasCommandClearance(member, cfg, cmd) {
  const required = COMMAND_LEVELS[cmd] || 1;
  if (isAdmin(member)) return true;
  if (!isModerator(member, cfg)) return false;
  if (required <= 1) return true;
  const roles = required === 2 ? cfg.moderation.level2RoleIds : cfg.moderation.level3RoleIds;
  // Not configured yet ⇒ don't restrict (keeps existing setups working until an admin opts in).
  if (!roles || !roles.length) return true;
  return roles.some(rid => member.roles.cache.has(rid));
}

// ── Role-based nickname prefixes (e.g. role "Rang I" → nickname "Rang I Username") ──
function stripKnownPrefixes(currentName, cfg) {
  let name = String(currentName || '').trim();

  // LOA is a protected prefix. If present, keep it at the very front.
  const loaMatch = name.match(/^LOA\s*\|\s*/i);
  const hasLOA = Boolean(loaMatch);
  if (hasLOA) {
    name = name.slice(loaMatch[0].length).trim();
  }

  const prefixes = (cfg.nicknamePrefixes || [])
    .map(p => String(p.prefix || '').trim())
    .filter(Boolean)
    .filter(p => !/^LOA$/i.test(p))
    .sort((a, b) => b.length - a.length);

  // Remove configured rank prefixes while preserving the protected LOA prefix.
  let changed = true;
  while (changed && name) {
    changed = false;
    for (const prefix of prefixes) {
      const escaped = prefix.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
      const match = name.match(new RegExp('^' + escaped + '(?:\\s*\\|\\s*|\\s+)', 'i'));
      if (match) {
        name = name.slice(match[0].length).trim();
        changed = true;
        break;
      }
    }
  }

  return hasLOA ? `LOA | ${name}` : name;
}

async function applyNicknamePrefix(member, cfg) {
  if (!cfg.nicknamePrefixes?.length) return;
  if (member.user.bot) return;
  if (!member.manageable) return;

  const applicable = cfg.nicknamePrefixes
    .filter(p => p.prefix && !/^LOA$/i.test(p.prefix) && member.roles.cache.has(p.roleId))
    .map(p => ({ ...p, position: member.guild.roles.cache.get(p.roleId)?.position ?? -1 }))
    .sort((a, b) => b.position - a.position);

  const currentName = member.nickname || member.user.username;
  const baseName = stripKnownPrefixes(currentName, cfg);
  const rankPrefix = applicable.length ? applicable[0].prefix : null;

  // LOA stays first; the highest rank goes between LOA and the username.
  const hasLOA = /^LOA\s*\|/i.test(baseName);
  const username = hasLOA ? baseName.replace(/^LOA\s*\|\s*/i, '').trim() : baseName;
  const desiredName = hasLOA
    ? (rankPrefix ? `LOA | ${rankPrefix} | ${username}` : `LOA | ${username}`)
    : (rankPrefix ? `${rankPrefix} | ${username}` : username);

  if (desiredName === currentName) return;
  if (desiredName.length > 32) {
    console.error(`❌ Nickname prefix skipped for ${member.id}: "${desiredName}" exceeds Discord's 32-character limit.`);
    return;
  }
  await member.setNickname(desiredName, 'Automatic role-based nickname prefix').catch(e => console.error(`❌ Failed to set nickname prefix for ${member.id}:`, e.message));
}
function isTrainer(member, cfg) {
  if (isAdmin(member)) return true;
  if (!cfg.training.trainerRoles.length) return false;
  return cfg.training.trainerRoles.some(rid => member.roles.cache.has(rid));
}

function canRequestTraining(member, cfg) {
  if (isAdmin(member)) return true;
  if (!cfg.training.requestRoles.length) return true; // no restriction configured
  return cfg.training.requestRoles.some(rid => member.roles.cache.has(rid));
}

async function safeDM(user, payload) {
  try { const dm = await user.createDM(); await dm.send(payload); return true; } catch { return false; }
}

function replaceWelcomePlaceholders(text, member) {
  if (!text) return '';
  const guild = member.guild;
  return String(text)
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{mention}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', guild.name)
    .replaceAll('{membercount}', String(guild.memberCount))
    .replaceAll('{id}', member.id);
}

async function sendWelcomeMessage(member, cfg, channelOverride = null) {
  const welcome = cfg.welcome;
  if (!welcome?.enabled || !welcome.channelId) return false;
  if (member.user.bot) return false;

  const channel = channelOverride || member.guild.channels.cache.get(welcome.channelId);
  if (!channel || !channel.isTextBased()) return false;

  const content = replaceWelcomePlaceholders(welcome.message, member);
  const payload = {};
  if (welcome.embedEnabled) {
    const embed = new EmbedBuilder()
      .setColor(hexToInt(welcome.color))
      .setTitle(replaceWelcomePlaceholders(welcome.title, member))
      .setDescription(content || null)
      .setTimestamp();
    if (isValidUrl(welcome.image)) embed.setImage(welcome.image);
    if (isValidUrl(welcome.thumbnail)) embed.setThumbnail(welcome.thumbnail);
    payload.embeds = [embed];
  } else if (content) {
    payload.content = content;
  }

  if (!payload.content && !payload.embeds?.length) return false;
  await channel.send(payload);
  return true;
}

async function logModAction(guild, cfg, embed) {
  if (!cfg.moderation.modLogChannelId) return;
  const ch = guild.channels.cache.get(cfg.moderation.modLogChannelId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

async function logTicketEvent(guild, cfg, embed) {
  if (!cfg.tickets.logChannelId) return;
  const ch = guild.channels.cache.get(cfg.tickets.logChannelId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

function parseRoleOrUserIds(str) {
  return [...str.matchAll(/(\d{15,25})/g)].map(m => m[1]);
}

// Build a simple text transcript of a channel's message history
async function buildTranscript(channel) {
  const lines = [];
  let lastId;
  for (let i = 0; i < 10; i++) { // up to ~1000 messages
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const msg of batch.values()) {
      const time = msg.createdAt.toISOString();
      const author = `${msg.author?.tag ?? msg.author?.id ?? 'Unknown'}`;
      let content = msg.content || '';
      if (msg.attachments?.size) content += ' ' + [...msg.attachments.values()].map(a => `[attachment: ${a.url}]`).join(' ');
      lines.push(`[${time}] ${author}: ${content}`);
    }
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  lines.reverse();
  return lines.join('\n') || '(no messages)';
}

// ════════════════════════════════════════════
// TICKET HELPERS
// ════════════════════════════════════════════
async function requireTicketChannel(interaction) {
  const ticket = await TicketModel.findOne({ channelId: interaction.channel.id });
  if (!ticket) {
    await interaction.reply({ content: '❌ This command can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return ticket;
}

function buildTicketControlRow(claimed) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tkt__claim').setLabel(claimed ? 'Claimed' : 'Claim Ticket').setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(!!claimed),
    new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
}

function buildPanelComponents(cfg) {
  const types = cfg.tickets.types;
  if (types.length <= 1) {
    const t = types[0] ?? { id: 'general', label: 'Open Ticket', emoji: '🎫' };
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tkt__open__${t.id}`).setLabel(t.label).setEmoji(t.emoji || '🎫').setStyle(ButtonStyle.Primary),
    )];
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tkt__opensel')
    .setPlaceholder('Select a ticket category...')
    .addOptions(types.slice(0, 25).map(t => ({
      label: t.label.slice(0, 100),
      value: t.id,
      description: (t.description || '').slice(0, 100) || undefined,
      emoji: t.emoji || undefined,
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

async function sendOrUpdatePanel(interaction, channel, cfg, guildId) {
  const embed = new EmbedBuilder()
    .setTitle(cfg.tickets.panelTitle)
    .setDescription(cfg.tickets.panelDescription)
    .setColor(hexToInt(cfg.tickets.panelColor));
  if (isValidUrl(cfg.tickets.panelImage)) embed.setImage(cfg.tickets.panelImage);
  if (isValidUrl(cfg.tickets.panelThumbnail)) embed.setThumbnail(cfg.tickets.panelThumbnail);
  const payload = { embeds: [embed], components: buildPanelComponents(cfg) };
  const msg = await channel.send(payload);
  cfg.tickets.panelChannelId = channel.id;
  cfg.tickets.panelMessageId = msg.id;
  await saveConfig(guildId);
  return msg;
}

async function createTicketChannel(interaction, typeId, cfg, reason = null) {
  const guild = interaction.guild;
  const user = interaction.user;
  const type = cfg.tickets.types.find(t => t.id === typeId) ?? { id: typeId, label: 'Support', emoji: '🎫', supportRoleIds: [] };

  // Prevent duplicate open tickets of the same type for this user
  const existing = await TicketModel.findOne({ guildId: guild.id, creatorId: user.id, status: 'open' });
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (existingChannel) {
      const payload = { content: `❌ You already have an open ticket: <#${existing.channelId}>`, flags: MessageFlags.Ephemeral };
      return interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
    }
    // The channel no longer exists (deleted outside the bot) — the record is orphaned. Clean it up and allow a fresh ticket.
    existing.status = 'archived';
    existing.archivedAt = new Date();
    await safeSave(() => existing.save(), 'orphaned ticket cleanup');
  }

  const category = cfg.tickets.categoryId ? guild.channels.cache.get(cfg.tickets.categoryId) : null;
  const roleIdsForType = resolveSupportRoleIds(cfg, type);
  const perms = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  for (const rid of roleIdsForType) {
    perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  }

  const number = cfg.tickets.nextNumber || 1;
  cfg.tickets.nextNumber = number + 1;
  await saveConfig(guild.id);

  const typeSlug = (type.label || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const userSlug = user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ticketCh = await guild.channels.create({
    name: `${typeSlug}-${userSlug}`.slice(0, 90) || `ticket-${number}`,
    type: ChannelType.GuildText,
    parent: category ?? null,
    permissionOverwrites: perms,
    topic: `Ticket #${number} by ${userDisplay(user)} | ${type.label}`,
  });

  const ticketDoc = await safeCreate(TicketModel, {
    guildId: guild.id,
    channelId: ticketCh.id,
    number,
    creatorId: user.id,
    typeId: type.id,
    typeLabel: type.label,
    staffMembers: [],
    reason: reason || null,
  }, `ticket create #${number}`);
  if (!ticketDoc) {
    await ticketCh.send('⚠️ This ticket channel was created, but the database record failed to save. A staff member may need to recreate it if issues occur.').catch(() => {});
  }

  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`${type.emoji || '🎫'} Ticket #${number} — ${type.label}`)
    .setDescription(`Hello <@${user.id}>, thank you for opening a ticket!\nSupport will be with you shortly.\n\n**Type:** ${type.label}`)
    .setColor(hexToInt(cfg.tickets.panelColor))
    .setTimestamp()
    .setFooter({ text: `Opened by ${userDisplay(user)}` });
  if (reason) welcomeEmbed.addFields({ name: '📝 Reason', value: reason.slice(0, 1024) });
  if (isValidUrl(type.image)) welcomeEmbed.setImage(type.image);
  if (isValidUrl(type.thumbnail)) welcomeEmbed.setThumbnail(type.thumbnail);

  const pingContent = roleIdsForType.length
    ? `<@${user.id}>${roleIdsForType.map(id => ` <@&${id}>`).join('')}`
    : `<@${user.id}>`;

  await ticketCh.send({ content: pingContent, embeds: [welcomeEmbed], components: [buildTicketControlRow(false)] });

  await logTicketEvent(guild, cfg, new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎫 Ticket Opened')
    .addFields(
      { name: 'Ticket', value: `<#${ticketCh.id}> (#${number})`, inline: true },
      { name: 'Opened by', value: `${userDisplay(user)} (${user.id})`, inline: true },
      { name: 'Type', value: type.label, inline: true },
    )
    .setTimestamp());

  const replyPayload = { content: `✅ Ticket created: <#${ticketCh.id}>`, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) await interaction.followUp(replyPayload).catch(() => {});
  else await interaction.reply(replyPayload).catch(() => {});
}

async function closeTicket(interaction, ticket, cfg, reason) {
  const channel = interaction.channel;
  const guild = interaction.guild;

  const transcriptText = await buildTranscript(channel).catch(() => '(failed to build transcript)');
  const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: `transcript-${ticket.number || channel.id}.txt` });

  ticket.status = 'closed';
  ticket.closedAt = new Date();
  await safeSave(() => ticket.save(), 'ticket save');

  await channel.permissionOverwrites.edit(ticket.creatorId, { SendMessages: false }).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔒 Ticket Closed')
    .addFields(
      { name: 'Closed by', value: userDisplay(interaction.user), inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: true },
    )
    .setDescription('This channel will be deleted automatically in 10 seconds.')
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});

  await logTicketEvent(guild, cfg, new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔒 Ticket Closed')
    .addFields(
      { name: 'Ticket', value: `#${ticket.number} (${channel.name})`, inline: true },
      { name: 'Closed by', value: userDisplay(interaction.user), inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: true },
    )
    .setTimestamp());
  if (cfg.tickets.logChannelId) {
    const logCh = guild.channels.cache.get(cfg.tickets.logChannelId);
    if (logCh) await logCh.send({ files: [attachment] }).catch(() => {});
  }

  const creator = await guild.members.fetch(ticket.creatorId).catch(() => null);
  if (creator) {
    const ratingRow = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map(n => new ButtonBuilder().setCustomId(`tkt__rate__${ticket._id}__${n}`).setLabel('⭐'.repeat(n)).setStyle(ButtonStyle.Secondary)),
    );
    await safeDM(creator.user, {
      content: `Your ticket in **${guild.name}** was closed.\n\n**How would you rate the support you received?**`,
      files: [attachment],
      components: [ratingRow],
    }).catch(() => {});
  }

  setTimeout(() => channel.delete().catch(e => console.error(`❌ Failed to auto-delete ticket channel ${channel.id}:`, e.message)), 10000);
}

// ════════════════════════════════════════════
// TRAINING HELPERS
// ════════════════════════════════════════════
const TRAIN_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function genId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

async function getTrainCooldownRemaining(guildId, userId) {
  const rec = await TrainCooldownModel.findById(`${guildId}:${userId}`).lean().catch(() => null);
  if (!rec) return 0;
  const remaining = TRAIN_COOLDOWN_MS - (Date.now() - new Date(rec.lastUsed).getTime());
  return remaining > 0 ? remaining : 0;
}

async function setTrainCooldown(guildId, userId) {
  await TrainCooldownModel.findByIdAndUpdate(`${guildId}:${userId}`, { lastUsed: new Date() }, { upsert: true }).catch(() => {});
}

function buildTrainingRequestEmbed({ user, typeName, times, notes, claimed = [], status = 'open', resolvedBy = null }) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Training Request')
    .setColor(status === 'passed' ? 0x57F287 : status === 'failed' ? 0xED4245 : 0x5865F2)
    .setThumbnail(user.displayAvatarURL({ dynamic: true }) ?? null)
    .addFields(
      { name: '👤 Requester', value: `${userDisplay(user)} (<@${user.id}>)`, inline: true },
      { name: '🆔 User ID', value: user.id, inline: true },
      { name: '🎓 Training Type', value: typeName || '*General*', inline: true },
      { name: '🕐 Available Times', value: times, inline: false },
      { name: '📝 Notes', value: notes || '*None*', inline: false },
      { name: '✅ Claimed By', value: claimed.length ? claimed.map(id => `<@${id}>`).join('\n') : '*No one yet*', inline: false },
    )
    .setTimestamp();
  if (status !== 'open') {
    embed.addFields({ name: '📊 Status', value: status === 'passed' ? '✅ Passed' : '❌ Failed', inline: false });
    if (resolvedBy) embed.addFields({ name: status === 'passed' ? '🎓 Passed By' : '❌ Failed By', value: `<@${resolvedBy}>`, inline: true });
  }
  return embed;
}

function buildTrainingButtons(requesterId, typeId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tr__claim__${requesterId}__${typeId}`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`tr__unclaim__${requesterId}__${typeId}`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`tr__pass__${requesterId}__${typeId}`).setLabel('✅ Pass').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`tr__fail__${requesterId}__${typeId}`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

// ════════════════════════════════════════════
// GUI /setup MENU — views & dispatcher
// ════════════════════════════════════════════
function buildSetupHomeEmbed() {
  return new EmbedBuilder()
    .setTitle('⚙️ Server Setup')
    .setColor(0x5865F2)
    .setDescription('Pick a category below to configure. Every selection saves instantly.');
}
function buildStaffAccessSetupView(cfg) {
  const a = cfg.staffAccess || {};
  const embed = new EmbedBuilder().setTitle('🛡️ Staff Access & Approvals').setColor(0x5865F2)
    .setDescription('Configure role IDs here. Server owner always has full access. Approval roles default to SHR when left empty.')
    .addFields(
      { name: 'SHR roles', value: a.shrRoleIds?.length ? a.shrRoleIds.map(x => `<@&${x}>`).join(' ') : '*not configured*' },
      { name: 'HR roles', value: a.hrRoleIds?.length ? a.hrRoleIds.map(x => `<@&${x}>`).join(' ') : '*not configured*' },
      { name: 'Approval roles (SHR / SHRM)', value: a.approvalRoleIds?.length ? a.approvalRoleIds.map(x => `<@&${x}>`).join(' ') : '*uses SHR roles*' },
      { name: 'Request channel', value: a.requestChannelId ? `<#${a.requestChannelId}>` : '*not set*', inline: true },
      { name: 'Infractions channel', value: a.infractionChannelId ? `<#${a.infractionChannelId}>` : '*not set*', inline: true },
    );
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup__staff_shr').setPlaceholder('Select SHR roles').setMinValues(0).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup__staff_hr').setPlaceholder('Select HR roles').setMinValues(0).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup__staff_approval').setPlaceholder('Select approval roles (SHR / SHRM)').setMinValues(0).setMaxValues(25)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup__staff_request_channel').setPlaceholder('Select approvals/request channel').addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup__staff_infraction_channel').setPlaceholder('Select infractions channel').addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setStyle(ButtonStyle.Secondary)),
  ] };
}

function buildCaseSetupView(cfg) {
  const systems = cfg.caseManagement?.systems || {};
  const labels = { ia: 'Internal Affairs', management: 'Management', supervisor: 'Supervisor', executive: 'Executive' };
  const rows = Object.entries(labels).map(([key, label]) => {
    const s = systems[key] || {};
    return { name: label, value: `Channel: ${s.channelId ? `<#${s.channelId}>` : '*not set*'}\nLog: ${s.logChannelId ? `<#${s.logChannelId}>` : '*not set*'}\nCreate/access/investigator/supervisor roles: ${(s.createRoleIds || []).length}/${(s.accessRoleIds || []).length}/${(s.investigatorRoleIds || []).length}/${(s.supervisorRoleIds || []).length}` };
  });
  const embed = new EmbedBuilder().setTitle('📁 Case Management Setup').setColor(0x5865F2)
    .setDescription('Choose a case system to configure. Each system can use its own channel, log channel, ping roles and access roles.')
    .addFields(rows);
  const menu = new StringSelectMenuBuilder().setCustomId('setup__case_system').setPlaceholder('Choose a case system').addOptions(
    Object.entries(labels).map(([value, label]) => ({ label, value })),
  );
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setStyle(ButtonStyle.Secondary)),
  ] };
}

function buildCaseSystemSetupView(cfg, key) {
  const s = cfg.caseManagement.systems[key];
  const label = s.label || key;
  const roleText = ids => ids?.length ? ids.map(x => `<@&${x}>`).join(' ') : '*none*';
  const embed = new EmbedBuilder().setTitle(`📁 ${label} Setup`).setColor(0x5865F2).addFields(
    { name: 'Case channel', value: s.channelId ? `<#${s.channelId}>` : '*not set*' },
    { name: 'Log channel', value: s.logChannelId ? `<#${s.logChannelId}>` : '*not set*' },
    { name: 'Ping roles', value: roleText(s.pingRoleIds) },
    { name: 'Access roles', value: roleText(s.accessRoleIds) },
    { name: 'Create case roles', value: roleText(s.createRoleIds) },
    { name: 'Investigator roles', value: roleText(s.investigatorRoleIds) },
    { name: 'Supervisor roles', value: roleText(s.supervisorRoleIds) },
  );
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`setup__case_channel__${key}`).setPlaceholder('Select case channel').addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`setup__case_log__${key}`).setPlaceholder('Select log channel').addChannelTypes(ChannelType.GuildText)),
    ...['pingRoleIds','accessRoleIds','createRoleIds','investigatorRoleIds','supervisorRoleIds'].map((field, i) => new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId(`setup__case_roles__${key}__${field}`).setPlaceholder(['Ping roles','Access roles','Create case roles','Investigator roles','Supervisor roles'][i]).setMinValues(0).setMaxValues(25),
    )),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup__home__cases').setLabel('Back').setStyle(ButtonStyle.Secondary)),
  ] };
}

function buildSetupHomeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup__home__tickets').setLabel('Tickets').setEmoji('🎫').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__moderation').setLabel('Moderation').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__training').setLabel('Training').setEmoji('🎓').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__prefixes').setLabel('Nickname Prefixes').setEmoji('🏷️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__coc').setLabel('Chain of Command').setEmoji('🔱').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__staff').setLabel('Staff Access').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__home__cases').setLabel('Case Management').setEmoji('📁').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup__home__welcome').setLabel('Welcome').setEmoji('👋').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildWelcomeSetupView(cfg) {
  const w = cfg.welcome || {};
  const embed = new EmbedBuilder()
    .setTitle('👋 Welcome Setup')
    .setColor(hexToInt(w.color))
    .setDescription('Configure the automatic welcome message for new members.')
    .addFields(
      { name: 'Status', value: w.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Channel', value: w.channelId ? '<#' + w.channelId + '>' : '*not set*', inline: true },
      { name: 'Embed', value: w.embedEnabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'DM', value: w.dmEnabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Title', value: w.title || '*not set*', inline: false },
      { name: 'Message', value: (w.message || '*not set*').slice(0, 1024), inline: false },
    );
  const rowChannel = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup__welcome_channel').setPlaceholder('Select the welcome channel').addChannelTypes(ChannelType.GuildText),
  );
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__welcome_edit').setLabel('Edit Message').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__welcome_test').setLabel('Test').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup__welcome_toggle_dm').setLabel(w.dmEnabled ? 'Disable DM' : 'Enable DM').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__welcome_disable').setLabel('Disable').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowChannel, rowButtons] };
}

function buildTicketsSetupView(cfg) {
  const t = cfg.tickets;
  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket Setup')
    .setColor(hexToInt(t.panelColor))
    .setDescription('Use the menus below to configure the ticket system.')
    .addFields(
      { name: 'Category', value: t.categoryId ? `<#${t.categoryId}>` : '*not set*', inline: true },
      { name: 'Log Channel', value: t.logChannelId ? `<#${t.logChannelId}>` : '*not set*', inline: true },
      { name: 'Global Support Roles', value: t.supportRoleIds.length ? t.supportRoleIds.map(r => `<@&${r}>`).join(' ') : '*none*', inline: false },
      { name: 'Panel', value: `**${t.panelTitle}**\n${t.panelDescription}`, inline: false },
      { name: 'Types', value: t.types.length ? t.types.map(x => `${x.emoji || '🎫'} ${x.label}`).join(', ') : '*none*', inline: false },
    );
  const rowCategory = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup__tk_category').setPlaceholder('📁 Select the ticket category').addChannelTypes(ChannelType.GuildCategory),
  );
  const rowLog = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup__tk_logchannel').setPlaceholder('📜 Select the log channel').addChannelTypes(ChannelType.GuildText),
  );
  const rowRoles = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('setup__tk_supportroles').setPlaceholder('🛡️ Select global support roles').setMinValues(0).setMaxValues(25),
  );
  const rowSendPanel = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup__tk_sendpanel').setPlaceholder('📤 Select a channel to send/update the panel').addChannelTypes(ChannelType.GuildText),
  );
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__tk_panelmodal').setLabel('Panel Text/Color').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__tk_types').setLabel('Manage Types').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowCategory, rowLog, rowRoles, rowSendPanel, rowButtons] };
}

function buildTicketTypesView(cfg) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Ticket Types')
    .setColor(0x5865F2)
    .setDescription(cfg.tickets.types.length
      ? cfg.tickets.types.map(t => `${t.emoji || '🎫'} **${t.label}**${t.requireReason ? ' 📝' : ''} — ${t.description || '*no description*'}${t.supportRoleIds?.length ? `\nRoles: ${t.supportRoleIds.map(r => `<@&${r}>`).join(' ')}` : ''}`).join('\n\n')
      : '*No types configured yet.*');
  const components = [];
  if (cfg.tickets.types.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('setup__tk_type_select').setPlaceholder('Select a type to edit...')
        .addOptions(cfg.tickets.types.slice(0, 25).map(t => ({ label: t.label.slice(0, 100), value: t.id, emoji: t.emoji || undefined }))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__tk_type_add').setLabel('Add Type').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup__home__tickets').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components };
}

function buildTicketTypeDetailView(cfg, typeId) {
  const t = cfg.tickets.types.find(x => x.id === typeId);
  if (!t) return null;
  const embed = new EmbedBuilder()
    .setTitle(`${t.emoji || '🎫'} ${t.label}`)
    .setColor(0x5865F2)
    .addFields(
      { name: 'Description', value: t.description || '*none*' },
      { name: 'Support Roles', value: t.supportRoleIds?.length ? t.supportRoleIds.map(r => `<@&${r}>`).join(' ') : '*uses global roles*' },
      { name: 'Require Reason on Open', value: t.requireReason ? '✅ Yes' : '❌ No' },
    );
  const rowRoles = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`setup__tk_type_roles__${typeId}`).setPlaceholder('🛡️ Type-specific support roles (optional)').setMinValues(0).setMaxValues(25),
  );
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup__tk_type_editmodal__${typeId}`).setLabel('Edit Details').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup__tk_type_togglereason__${typeId}`).setLabel(t.requireReason ? 'Disable Reason' : 'Require Reason').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup__tk_type_remove__${typeId}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('setup__tk_types').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowRoles, rowButtons] };
}

function buildModerationSetupView(cfg) {
  const m = cfg.moderation;
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Moderation Setup')
    .setColor(0x5865F2)
    .setDescription('Staff hierarchy: level 1 = base moderator commands (warn, notes, clear, lock...). Level 2 adds kick/mute/nickname. Level 3 adds ban/tempban/roles.\nLeaving a level\'s roles empty means every moderator keeps access to it (unrestricted).')
    .addFields(
      { name: 'Moderator Roles (Level 1 — base access)', value: m.modRoleIds.length ? m.modRoleIds.map(r => `<@&${r}>`).join(' ') : '*none (admins only)*' },
      { name: 'Level 2 Roles (kick / mute / nickname)', value: m.level2RoleIds?.length ? m.level2RoleIds.map(r => `<@&${r}>`).join(' ') : '*unrestricted — all mods*' },
      { name: 'Level 3 Roles (ban / tempban / role edits)', value: m.level3RoleIds?.length ? m.level3RoleIds.map(r => `<@&${r}>`).join(' ') : '*unrestricted — all mods*' },
      { name: 'Mod Log Channel', value: m.modLogChannelId ? `<#${m.modLogChannelId}>` : '*not set*' },
    );
  const rowRoles = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('setup__mod_roles').setPlaceholder('🛡️ Level 1: base moderator roles').setMinValues(0).setMaxValues(25),
  );
  const rowLevel2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('setup__mod_level2roles').setPlaceholder('⚔️ Level 2: kick/mute/nickname roles').setMinValues(0).setMaxValues(25),
  );
  const rowLevel3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('setup__mod_level3roles').setPlaceholder('🔥 Level 3: ban/tempban/role-edit roles').setMinValues(0).setMaxValues(25),
  );
  const rowLog = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup__mod_logchannel').setPlaceholder('📜 Select mod-log channel').addChannelTypes(ChannelType.GuildText),
  );
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowRoles, rowLevel2, rowLevel3, rowLog, rowButtons] };
}

function buildTrainingSetupView(cfg) {
  const t = cfg.training;
  const embed = new EmbedBuilder()
    .setTitle('🎓 Training Setup')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Request Channel', value: t.channel ? `<#${t.channel}>` : '*not set*', inline: true },
      { name: 'Announce Channel', value: t.announceChannel ? `<#${t.announceChannel}>` : '*not set*', inline: true },
      { name: 'Trainer Roles', value: t.trainerRoles.length ? t.trainerRoles.map(r => `<@&${r}>`).join(' ') : '*admins only*' },
      { name: 'Request Roles', value: t.requestRoles.length ? t.requestRoles.map(r => `<@&${r}>`).join(' ') : '*everyone*' },
      { name: 'Ping Roles', value: t.pingRoles.length ? t.pingRoles.map(r => `<@&${r}>`).join(' ') : '*none*' },
      { name: 'Types', value: t.types.length ? t.types.map(x => x.name).join(', ') : '*none (general requests only)*' },
    );
  const rowChannel = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup__tr_channel').setPlaceholder('📥 Select request channel').addChannelTypes(ChannelType.GuildText));
  const rowAnnounce = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup__tr_announce').setPlaceholder('📢 Select announce channel').addChannelTypes(ChannelType.GuildText));
  const rowTrainer = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup__tr_trainerroles').setPlaceholder('🎓 Select trainer roles').setMinValues(0).setMaxValues(25));
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__tr_pingroles_open').setLabel('Ping Roles').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__tr_requestroles_open').setLabel('Request Roles').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__tr_types').setLabel('Manage Types').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowChannel, rowAnnounce, rowTrainer, rowButtons] };
}

function buildTrainingRolesSubView(cfg, kind) {
  const isPing = kind === 'ping';
  const embed = new EmbedBuilder()
    .setTitle(isPing ? '📌 Ping Roles' : '🙋 Request Roles')
    .setColor(0x5865F2)
    .setDescription(isPing ? 'Roles pinged when a new training request is posted.' : 'Roles allowed to use `/trainrequest`. Leave empty to allow everyone.');
  const row = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(isPing ? 'setup__tr_pingroles' : 'setup__tr_requestroles').setMinValues(0).setMaxValues(25).setPlaceholder('Select roles'),
  );
  const rowButtons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup__home__training').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [row, rowButtons] };
}

function buildTrainingTypesView(cfg) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Training Types')
    .setColor(0x5865F2)
    .setDescription(cfg.training.types.length
      ? cfg.training.types.map(t => `🎓 **${t.name}**${t.roleIds.length ? ` — grants ${t.roleIds.map(r => `<@&${r}>`).join(' ')}` : ''}`).join('\n')
      : '*No types configured — general requests only.*');
  const components = [];
  if (cfg.training.types.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('setup__tr_type_select').setPlaceholder('Select a type to edit...')
        .addOptions(cfg.training.types.slice(0, 25).map(t => ({ label: t.name.slice(0, 100), value: t.id }))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__tr_type_add').setLabel('Add Type').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup__home__training').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components };
}

function buildTrainingTypeDetailView(cfg, typeId) {
  const t = cfg.training.types.find(x => x.id === typeId);
  if (!t) return null;
  const embed = new EmbedBuilder()
    .setTitle(`🎓 ${t.name}`)
    .setColor(0x5865F2)
    .addFields({ name: 'Granted Roles on Pass', value: t.roleIds.length ? t.roleIds.map(r => `<@&${r}>`).join(' ') : '*none*' });
  const rowRoles = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`setup__tr_type_roles__${typeId}`).setPlaceholder('🎁 Select granted roles').setMinValues(0).setMaxValues(25));
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup__tr_type_rename__${typeId}`).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup__tr_type_remove__${typeId}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('setup__tr_types').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowRoles, rowButtons] };
}

function buildCocView(cfg) {
  const c = cfg.coc || { title: '🔱 Chain of Command', channelId: null, messageId: null, ranks: [] };
  const lines = (c.ranks || []).map((r, i) => {
    const prefix = r.prefix ? ` [${r.prefix}]` : '';
    return `${i + 1}. <@&${r.roleId}>${prefix}`;
  });

  const rankFields = [];
  let rankChunk = [];

  for (const line of lines) {
    const nextValue = [...rankChunk, line].join('\\n');

    if (nextValue.length > 1024) {
      if (rankChunk.length) {
        rankFields.push({
          name: rankFields.length ? 'Imported Ranks (continued)' : 'Imported Ranks',
          value: rankChunk.join('\\n'),
          inline: false,
        });
      }
      rankChunk = [line];
    } else {
      rankChunk.push(line);
    }
  }

  if (rankChunk.length) {
    rankFields.push({
      name: rankFields.length ? 'Imported Ranks (continued)' : 'Imported Ranks',
      value: rankChunk.join('\\n'),
      inline: false,
    });
  }

  if (!rankFields.length) {
    rankFields.push({
      name: 'Imported Ranks',
      value: '*none*',
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🔱 Chain of Command Setup')
    .setColor(0x5865F2)
    .setDescription('Import your Chain of Command in bulk. Each line uses **Role Name | Prefix**. Prefix is optional.')
    .addFields(
      { name: 'Channel', value: c.channelId ? `<#${c.channelId}>` : '*not set*', inline: true },
      { name: 'Title', value: c.title || '*not set*', inline: true },
      ...rankFields,
    );
  const components = [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('setup__coc_channel').setPlaceholder('Select Chain of Command channel').addChannelTypes(ChannelType.GuildText),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup__coc_import').setLabel('Bulk Import').setEmoji('📥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup__coc_publish').setLabel('Publish / Update').setEmoji('📤').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('setup__coc_title').setLabel('Edit Title').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed], components };
}

function buildCocImportPreview(cfg, parsed) {
  const lines = parsed.length
    ? parsed.map((r, i) => `${i + 1}. <@&${r.roleId}> → \`${r.prefix || 'no prefix'}\``)
    : ['*Nothing to import.*'];

  const fields = [];
  let chunk = [];
  let chunkLength = 0;
  for (const line of lines) {
    if (chunk.length && chunkLength + line.length + 1 > 1000) {
      fields.push({ name: fields.length ? 'Preview (continued)' : 'Preview', value: chunk.join('\\n') });
      chunk = [];
      chunkLength = 0;
    }
    chunk.push(line);
    chunkLength += line.length + 1;
  }
  if (chunk.length) {
    fields.push({ name: fields.length ? 'Preview (continued)' : 'Preview', value: chunk.join('\\n') });
  }

  return {
    embeds: [new EmbedBuilder()
      .setTitle('📥 Chain of Command Import Preview')
      .setColor(0x5865F2)
      .setDescription('Check the roles and prefixes below before saving. This will replace the current Chain of Command import.')
      .addFields(fields)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup__coc_import_confirm').setLabel('Confirm Import').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!parsed.length),
      new ButtonBuilder().setCustomId('setup__coc_import_cancel').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function resolveCocRole(guild, input) {
  const cleaned = input.trim().replace(/^<@&|>$/g, '');
  if (/^\\d{15,25}$/.test(cleaned)) return guild.roles.cache.get(cleaned) || null;

  const normalize = value => String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim();

  const search = normalize(cleaned);
  if (!search) return null;

  const exact = guild.roles.cache.find(r => !r.managed && normalize(r.name) === search);
  if (exact) return exact;

  const words = search.split(' ').filter(Boolean);
  return guild.roles.cache.find(r => {
    if (r.managed) return false;
    const roleName = normalize(r.name);
    return words.every(word => roleName.includes(word));
  }) || null;
}

function parseCocImport(guild, raw) {
  const parsed = [];
  const errors = [];
  const seen = new Set();
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const pieces = line.split('|').map(x => x.trim());
    if (pieces.length < 2) {
      errors.push(`Line ${index + 1}: use Role Name | Prefix`);
      continue;
    }
    const role = resolveCocRole(guild, pieces[0]);
    const prefix = pieces.slice(1).join('|').trim();
    if (!role) {
      errors.push(`Line ${index + 1}: role not found: ${pieces[0]}`);
      continue;
    }
    if (seen.has(role.id)) {
      errors.push(`Line ${index + 1}: duplicate role: ${role.name}`);
      continue;
    }
    seen.add(role.id);
    parsed.push({ roleId: role.id, name: role.name, prefix: prefix.slice(0, 20) });
    if (parsed.length >= 50) {
      errors.push('Only the first 50 valid ranks were imported.');
      break;
    }
  }
  return { parsed, errors };
}

function buildPrefixesView(cfg) {
  const embed = new EmbedBuilder()
    .setTitle('🏷️ Nickname Prefixes')
    .setColor(0x5865F2)
    .setDescription('Give roles a shared prefix and members automatically get renamed, e.g. role **Rang I** → nickname **Rang I Username**. Click **Add Prefix** to pick roles first, then type the prefix once — it\'s applied to all of them. Applied automatically whenever roles change, and if a member has multiple prefixed roles the highest one wins.');
  if (cfg.nicknamePrefixes.length) {
    embed.addFields({
      name: 'Configured',
      value: cfg.nicknamePrefixes.map(p => `<@&${p.roleId}> → \`${p.prefix}\``).join('\n').slice(0, 1024),
    });
  }
  const components = [];
  if (cfg.nicknamePrefixes.length) {
    components.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('setup__np_select').setPlaceholder('Select a configured role to edit or remove').setMinValues(1).setMaxValues(1),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup__np_add').setLabel('Add Prefix').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup__home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components };
}

function buildPrefixDetailView(cfg, roleId) {
  const p = cfg.nicknamePrefixes.find(x => x.roleId === roleId);
  const embed = new EmbedBuilder()
    .setTitle('🏷️ Role Prefix')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Role', value: `<@&${roleId}>` },
      { name: 'Prefix', value: p ? `\`${p.prefix}\`` : '*not set yet*' },
    );
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup__np_editmodal__${roleId}`).setLabel(p ? 'Edit Prefix' : 'Set Prefix').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    ...(p ? [new ButtonBuilder().setCustomId(`setup__np_remove__${roleId}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger)] : []),
    new ButtonBuilder().setCustomId('setup__home__prefixes').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowButtons] };
}

async function handleSetupInteraction(interaction, cfg, guildId) {
  const id = interaction.customId;

  // ── Home / section landing pages ──
  if (interaction.isButton() && id === 'setup__home') return interaction.update({ embeds: [buildSetupHomeEmbed()], components: buildSetupHomeComponents() });
  if (interaction.isButton() && id === 'setup__home__tickets') return interaction.update(buildTicketsSetupView(cfg));
  if (interaction.isButton() && id === 'setup__home__moderation') return interaction.update(buildModerationSetupView(cfg));
  if (interaction.isButton() && id === 'setup__home__training') return interaction.update(buildTrainingSetupView(cfg));
  if (interaction.isButton() && id === 'setup__home__prefixes') return interaction.update(buildPrefixesView(cfg));
  if (interaction.isButton() && id === 'setup__home__coc') return interaction.update(buildCocView(cfg));
  if (interaction.isButton() && id === 'setup__home__welcome') return interaction.update(buildWelcomeSetupView(cfg));
  if (interaction.isButton() && id === 'setup__home__staff') return interaction.update(buildStaffAccessSetupView(cfg));
  if (interaction.isButton() && id === 'setup__home__cases') return interaction.update(buildCaseSetupView(cfg));
  if (interaction.isStringSelectMenu() && id === 'setup__case_system') return interaction.update(buildCaseSystemSetupView(cfg, interaction.values[0]));
  if (interaction.isChannelSelectMenu() && id.startsWith('setup__case_channel__')) {
    const key = id.split('__').pop(); cfg.caseManagement.systems[key].channelId = interaction.values[0] || null;
    await saveConfig(guildId); return interaction.update(buildCaseSystemSetupView(cfg, key));
  }
  if (interaction.isChannelSelectMenu() && id.startsWith('setup__case_log__')) {
    const key = id.split('__').pop(); cfg.caseManagement.systems[key].logChannelId = interaction.values[0] || null;
    await saveConfig(guildId); return interaction.update(buildCaseSystemSetupView(cfg, key));
  }
  if (interaction.isRoleSelectMenu() && id.startsWith('setup__case_roles__')) {
    const [, , key, field] = id.split('__'); cfg.caseManagement.systems[key][field] = interaction.values;
    await saveConfig(guildId); return interaction.update(buildCaseSystemSetupView(cfg, key));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__staff_shr') { cfg.staffAccess.shrRoleIds = interaction.values; await saveConfig(guildId); return interaction.update(buildStaffAccessSetupView(cfg)); }
  if (interaction.isRoleSelectMenu() && id === 'setup__staff_hr') { cfg.staffAccess.hrRoleIds = interaction.values; await saveConfig(guildId); return interaction.update(buildStaffAccessSetupView(cfg)); }
  if (interaction.isRoleSelectMenu() && id === 'setup__staff_approval') { cfg.staffAccess.approvalRoleIds = interaction.values; await saveConfig(guildId); return interaction.update(buildStaffAccessSetupView(cfg)); }
  if (interaction.isChannelSelectMenu() && id === 'setup__staff_request_channel') { cfg.staffAccess.requestChannelId = interaction.values[0] || null; await saveConfig(guildId); return interaction.update(buildStaffAccessSetupView(cfg)); }
  if (interaction.isChannelSelectMenu() && id === 'setup__staff_infraction_channel') { cfg.staffAccess.infractionChannelId = interaction.values[0] || null; await saveConfig(guildId); return interaction.update(buildStaffAccessSetupView(cfg)); }

  if (interaction.isChannelSelectMenu() && id === 'setup__welcome_channel') {
    cfg.welcome.channelId = interaction.values[0] || null;
    cfg.welcome.enabled = Boolean(cfg.welcome.channelId);
    await saveConfig(guildId);
    return interaction.update(buildWelcomeSetupView(cfg));
  }

  if (interaction.isButton() && id === 'setup__welcome_test') {
    if (!cfg.welcome.enabled || !cfg.welcome.channelId) return interaction.reply({ content: '❌ Select a welcome channel first.', flags: MessageFlags.Ephemeral });
    const sent = await sendWelcomeMessage(interaction.member, cfg);
    return interaction.reply({ content: sent ? '✅ Test welcome sent.' : '❌ Could not send the welcome message. Check the channel and bot permissions.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.isButton() && id === 'setup__welcome_disable') {
    cfg.welcome.enabled = false;
    await saveConfig(guildId);
    return interaction.update(buildWelcomeSetupView(cfg));
  }

  if (interaction.isButton() && id === 'setup__welcome_toggle_dm') {
    cfg.welcome.dmEnabled = !cfg.welcome.dmEnabled;
    await saveConfig(guildId);
    return interaction.update(buildWelcomeSetupView(cfg));
  }

  if (interaction.isButton() && id === 'setup__welcome_edit') {
    const modal = new ModalBuilder().setCustomId('setup__welcome_edit_submit').setTitle('Welcome Message');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Embed title').setStyle(TextInputStyle.Short).setValue(cfg.welcome.title || '').setRequired(true).setMaxLength(256)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Welcome message').setStyle(TextInputStyle.Paragraph).setValue(cfg.welcome.message || '').setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Embed color (#57F287)').setStyle(TextInputStyle.Short).setValue(cfg.welcome.color || '#57F287').setRequired(true).setMaxLength(7)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setValue(cfg.welcome.image || '').setRequired(false).setMaxLength(500)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('Thumbnail URL (optional)').setStyle(TextInputStyle.Short).setValue(cfg.welcome.thumbnail || '').setRequired(false).setMaxLength(500)),
    );
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && id === 'setup__welcome_edit_submit') {
    const title = interaction.fields.getTextInputValue('title').trim();
    const message = interaction.fields.getTextInputValue('message').trim();
    const color = interaction.fields.getTextInputValue('color').trim();
    const image = interaction.fields.getTextInputValue('image').trim();
    const thumbnail = interaction.fields.getTextInputValue('thumbnail').trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return interaction.reply({ content: '❌ Color must be a hex value like `#57F287`.', flags: MessageFlags.Ephemeral });
    cfg.welcome.title = title;
    cfg.welcome.message = message;
    cfg.welcome.color = color;
    cfg.welcome.image = image && isValidUrl(image) ? image : null;
    cfg.welcome.thumbnail = thumbnail && isValidUrl(thumbnail) ? thumbnail : null;
    await saveConfig(guildId);
    return interaction.update(buildWelcomeSetupView(cfg));
  }

  // ── Chain of Command ──
  if (interaction.isChannelSelectMenu() && id === 'setup__coc_channel') {
    cfg.coc.channelId = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildCocView(cfg));
  }
  if (interaction.isButton() && id === 'setup__coc_title') {
    const modal = new ModalBuilder().setCustomId('setup__coc_title_submit').setTitle('Chain of Command Title');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(cfg.coc.title || '🔱 Chain of Command').setRequired(true).setMaxLength(256),
    ));
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id === 'setup__coc_import') {
    const modal = new ModalBuilder().setCustomId('setup__coc_import_submit').setTitle('Bulk Import Chain of Command');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ranks').setLabel('Role Name | Prefix (one per line)').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Firefighter | F\nChief Firefighter | CF\nExecutive Officer | EO')
        .setRequired(true).setMaxLength(4000),
    ));
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id === 'setup__coc_import_cancel') return interaction.update(buildCocView(cfg));
  if (interaction.isButton() && id === 'setup__coc_import_confirm') {
    const pending = pendingCocImports.get(interaction.user.id);
    if (!pending || pending.guildId !== guildId) return interaction.reply({ content: '❌ Import expired. Start the bulk import again.', flags: MessageFlags.Ephemeral });
    pendingCocImports.delete(interaction.user.id);
    cfg.coc.ranks = pending.parsed.map(r => ({ roleId: r.roleId, name: r.name, prefix: r.prefix || '' }));
    const importedPrefixes = cfg.coc.ranks.filter(r => r.prefix).map(r => ({ roleId: r.roleId, prefix: r.prefix }));
    const importedRoleIds = new Set(cfg.coc.ranks.map(r => r.roleId));
    cfg.nicknamePrefixes = (cfg.nicknamePrefixes || []).filter(p => !importedRoleIds.has(p.roleId)).concat(importedPrefixes);
    await saveConfig(guildId);
    await interaction.update(buildCocView(cfg));
    const affected = new Map();
    for (const r of importedPrefixes) {
      const role = interaction.guild.roles.cache.get(r.roleId);
      if (role) for (const m of role.members.values()) affected.set(m.id, m);
    }
    const members = [...affected.values()].slice(0, 200);
    for (const m of members) {
      await applyNicknamePrefix(m, cfg);
      await new Promise(r => setTimeout(r, 250));
    }
    return interaction.followUp({ content: `✅ Imported ${cfg.coc.ranks.length} rank(s) and ${importedPrefixes.length} prefix(es). Synced ${members.length} current member(s).`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (interaction.isButton() && id === 'setup__coc_publish') {
    if (!cfg.coc.channelId) return interaction.reply({ content: '❌ Set a Chain of Command channel first.', flags: MessageFlags.Ephemeral });
    const channel = interaction.guild.channels.cache.get(cfg.coc.channelId);
    if (!channel) return interaction.reply({ content: '❌ The configured Chain of Command channel no longer exists.', flags: MessageFlags.Ephemeral });
    const ranks = cfg.coc.ranks || [];
    const description = ranks.length
      ? ranks.map((r, i) => `**${i + 1}.** <@&${r.roleId}>${r.prefix ? ` — \`${r.prefix}\`` : ''}`).join('\\n').slice(0, 4000)
      : '*No ranks imported yet.*';
    const embed = new EmbedBuilder().setTitle(cfg.coc.title || '🔱 Chain of Command').setColor(0x5865F2).setDescription(description).setTimestamp();
    let message = cfg.coc.messageId ? await channel.messages.fetch(cfg.coc.messageId).catch(() => null) : null;
    if (message) await message.edit({ embeds: [embed], components: [] });
    else {
      message = await channel.send({ embeds: [embed] });
      cfg.coc.messageId = message.id;
      await saveConfig(guildId);
    }
    return interaction.reply({ content: `✅ Chain of Command ${message ? 'published/updated' : 'published'} in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }

  // ── Tickets: channel/role selects ──
  if (interaction.isChannelSelectMenu() && id === 'setup__tk_category') {
    cfg.tickets.categoryId = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildTicketsSetupView(cfg));
  }
  if (interaction.isChannelSelectMenu() && id === 'setup__tk_logchannel') {
    cfg.tickets.logChannelId = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildTicketsSetupView(cfg));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__tk_supportroles') {
    cfg.tickets.supportRoleIds = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildTicketsSetupView(cfg));
  }
  if (interaction.isChannelSelectMenu() && id === 'setup__tk_sendpanel') {
    const channel = interaction.guild.channels.cache.get(interaction.values[0]);
    await interaction.deferUpdate().catch(() => {});
    if (channel) await sendOrUpdatePanel(interaction, channel, cfg, guildId).catch(() => {});
    return interaction.editReply(buildTicketsSetupView(cfg)).catch(() => {});
  }
  if (interaction.isButton() && id === 'setup__tk_panelmodal') {
    const modal = new ModalBuilder().setCustomId('setup__tk_panelmodal_submit').setTitle('Ticket Panel Settings');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setValue(cfg.tickets.panelTitle).setRequired(true).setMaxLength(256)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setValue(cfg.tickets.panelDescription).setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Hex Color (e.g. #5865F2)').setStyle(TextInputStyle.Short).setValue(cfg.tickets.panelColor).setRequired(false).setMaxLength(7)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setValue(cfg.tickets.panelImage || '').setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('Thumbnail URL (optional)').setStyle(TextInputStyle.Short).setValue(cfg.tickets.panelThumbnail || '').setRequired(false)),
    );
    return interaction.showModal(modal);
  }

  // ── Tickets: type management ──
  if (interaction.isButton() && id === 'setup__tk_types') return interaction.update(buildTicketTypesView(cfg));
  if (interaction.isStringSelectMenu() && id === 'setup__tk_type_select') {
    return interaction.update(buildTicketTypeDetailView(cfg, interaction.values[0]) || buildTicketTypesView(cfg));
  }
  if (interaction.isButton() && id === 'setup__tk_type_add') {
    const modal = new ModalBuilder().setCustomId('setup__tk_type_add_submit').setTitle('Add Ticket Type');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Label (e.g. Billing Support)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('Thumbnail URL (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
    );
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id.startsWith('setup__tk_type_editmodal__')) {
    const typeId = id.replace('setup__tk_type_editmodal__', '');
    const t = cfg.tickets.types.find(x => x.id === typeId);
    if (!t) return interaction.update(buildTicketTypesView(cfg));
    const modal = new ModalBuilder().setCustomId(`setup__tk_type_edit_submit__${typeId}`).setTitle('Edit Ticket Type');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Label').setStyle(TextInputStyle.Short).setValue(t.label).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setValue(t.emoji || '').setRequired(false).setMaxLength(10)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setValue(t.description || '').setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setValue(t.image || '').setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('Thumbnail URL (optional)').setStyle(TextInputStyle.Short).setValue(t.thumbnail || '').setRequired(false)),
    );
    return interaction.showModal(modal);
  }
  if (interaction.isRoleSelectMenu() && id.startsWith('setup__tk_type_roles__')) {
    const typeId = id.replace('setup__tk_type_roles__', '');
    const t = cfg.tickets.types.find(x => x.id === typeId);
    if (t) { t.supportRoleIds = interaction.values; await saveConfig(guildId); }
    return interaction.update(buildTicketTypeDetailView(cfg, typeId) || buildTicketTypesView(cfg));
  }
  if (interaction.isButton() && id.startsWith('setup__tk_type_togglereason__')) {
    const typeId = id.replace('setup__tk_type_togglereason__', '');
    const t = cfg.tickets.types.find(x => x.id === typeId);
    if (t) { t.requireReason = !t.requireReason; await saveConfig(guildId); }
    return interaction.update(buildTicketTypeDetailView(cfg, typeId) || buildTicketTypesView(cfg));
  }
  if (interaction.isButton() && id.startsWith('setup__tk_type_remove__')) {
    const typeId = id.replace('setup__tk_type_remove__', '');
    cfg.tickets.types = cfg.tickets.types.filter(x => x.id !== typeId);
    await saveConfig(guildId);
    return interaction.update(buildTicketTypesView(cfg));
  }

  // ── Moderation ──
  if (interaction.isRoleSelectMenu() && id === 'setup__mod_roles') {
    cfg.moderation.modRoleIds = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildModerationSetupView(cfg));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__mod_level2roles') {
    cfg.moderation.level2RoleIds = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildModerationSetupView(cfg));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__mod_level3roles') {
    cfg.moderation.level3RoleIds = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildModerationSetupView(cfg));
  }
  if (interaction.isChannelSelectMenu() && id === 'setup__mod_logchannel') {
    cfg.moderation.modLogChannelId = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildModerationSetupView(cfg));
  }

  // ── Training ──
  if (interaction.isChannelSelectMenu() && id === 'setup__tr_channel') {
    cfg.training.channel = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildTrainingSetupView(cfg));
  }
  if (interaction.isChannelSelectMenu() && id === 'setup__tr_announce') {
    cfg.training.announceChannel = interaction.values[0] || null;
    await saveConfig(guildId);
    return interaction.update(buildTrainingSetupView(cfg));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__tr_trainerroles') {
    cfg.training.trainerRoles = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildTrainingSetupView(cfg));
  }
  if (interaction.isButton() && id === 'setup__tr_pingroles_open') return interaction.update(buildTrainingRolesSubView(cfg, 'ping'));
  if (interaction.isButton() && id === 'setup__tr_requestroles_open') return interaction.update(buildTrainingRolesSubView(cfg, 'request'));
  if (interaction.isRoleSelectMenu() && id === 'setup__tr_pingroles') {
    cfg.training.pingRoles = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildTrainingRolesSubView(cfg, 'ping'));
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__tr_requestroles') {
    cfg.training.requestRoles = interaction.values;
    await saveConfig(guildId);
    return interaction.update(buildTrainingRolesSubView(cfg, 'request'));
  }
  if (interaction.isButton() && id === 'setup__tr_types') return interaction.update(buildTrainingTypesView(cfg));
  if (interaction.isStringSelectMenu() && id === 'setup__tr_type_select') {
    return interaction.update(buildTrainingTypeDetailView(cfg, interaction.values[0]) || buildTrainingTypesView(cfg));
  }
  if (interaction.isButton() && id === 'setup__tr_type_add') {
    const modal = new ModalBuilder().setCustomId('setup__tr_type_add_submit').setTitle('Add Training Type');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Type Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id.startsWith('setup__tr_type_rename__')) {
    const typeId = id.replace('setup__tr_type_rename__', '');
    const t = cfg.training.types.find(x => x.id === typeId);
    if (!t) return interaction.update(buildTrainingTypesView(cfg));
    const modal = new ModalBuilder().setCustomId(`setup__tr_type_rename_submit__${typeId}`).setTitle('Rename Training Type');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Type Name').setStyle(TextInputStyle.Short).setValue(t.name).setRequired(true).setMaxLength(100)));
    return interaction.showModal(modal);
  }
  if (interaction.isRoleSelectMenu() && id.startsWith('setup__tr_type_roles__')) {
    const typeId = id.replace('setup__tr_type_roles__', '');
    const t = cfg.training.types.find(x => x.id === typeId);
    if (t) { t.roleIds = interaction.values; await saveConfig(guildId); }
    return interaction.update(buildTrainingTypeDetailView(cfg, typeId) || buildTrainingTypesView(cfg));
  }
  if (interaction.isButton() && id.startsWith('setup__tr_type_remove__')) {
    const typeId = id.replace('setup__tr_type_remove__', '');
    cfg.training.types = cfg.training.types.filter(x => x.id !== typeId);
    await saveConfig(guildId);
    return interaction.update(buildTrainingTypesView(cfg));
  }

  // ── Nickname Prefixes ──
  if (interaction.isRoleSelectMenu() && id === 'setup__np_select') {
    return interaction.update(buildPrefixDetailView(cfg, interaction.values[0]));
  }
  if (interaction.isButton() && id === 'setup__np_add') {
    const row = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('setup__np_addroles').setPlaceholder('Select one or more roles').setMinValues(1).setMaxValues(25),
    );
    const rowBack = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup__home__prefixes').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary));
    return interaction.update({
      embeds: [new EmbedBuilder().setTitle('🏷️ Add Prefix — Step 1: Roles').setColor(0x5865F2).setDescription('Select every role that should share the same prefix. You\'ll be asked for the prefix text next.')],
      components: [row, rowBack],
    });
  }
  if (interaction.isRoleSelectMenu() && id === 'setup__np_addroles') {
    pendingPrefixRoleSelections.set(interaction.user.id, interaction.values);
    setTimeout(() => pendingPrefixRoleSelections.delete(interaction.user.id), 5 * 60 * 1000); // expire after 5 min if abandoned
    const modal = new ModalBuilder().setCustomId('setup__np_addprefix_submit').setTitle('Add Prefix — Step 2: Text');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('prefix').setLabel('Prefix text (e.g. "Rang I")').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
    ));
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id.startsWith('setup__np_editmodal__')) {
    const roleId = id.replace('setup__np_editmodal__', '');
    const existing = cfg.nicknamePrefixes.find(p => p.roleId === roleId);
    const modal = new ModalBuilder().setCustomId(`setup__np_prefixmodal_submit__${roleId}`).setTitle('Set Nickname Prefix');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('prefix').setLabel('Prefix text (e.g. "Rang I")').setStyle(TextInputStyle.Short).setValue(existing?.prefix || '').setRequired(true).setMaxLength(20),
    ));
    return interaction.showModal(modal);
  }
  if (interaction.isButton() && id.startsWith('setup__np_remove__')) {
    const roleId = id.replace('setup__np_remove__', '');
    cfg.nicknamePrefixes = cfg.nicknamePrefixes.filter(p => p.roleId !== roleId);
    await saveConfig(guildId);
    return interaction.update(buildPrefixesView(cfg));
  }


  // ── Modal submits ──
  if (interaction.isModalSubmit() && id === 'setup__np_addprefix_submit') {
    const roleIds = pendingPrefixRoleSelections.get(interaction.user.id);
    pendingPrefixRoleSelections.delete(interaction.user.id);
    if (!roleIds || !roleIds.length) {
      return interaction.reply({ content: '❌ Your role selection expired — please pick the roles again.', flags: MessageFlags.Ephemeral });
    }
    const prefix = interaction.fields.getTextInputValue('prefix').trim();
    if (!prefix) return interaction.reply({ content: '❌ Prefix cannot be empty.', flags: MessageFlags.Ephemeral });

    for (const roleId of roleIds) {
      const existing = cfg.nicknamePrefixes.find(p => p.roleId === roleId);
      if (existing) existing.prefix = prefix;
      else cfg.nicknamePrefixes.push({ roleId, prefix });
    }
    await saveConfig(guildId);
    await interaction.update(buildPrefixesView(cfg));

    // Retroactively apply to every current holder of any selected role (deduped, capped + throttled).
    const affectedMembers = new Map();
    for (const roleId of roleIds) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) continue;
      for (const m of role.members.values()) affectedMembers.set(m.id, m);
    }
    const members = [...affectedMembers.values()].slice(0, 200);
    for (const m of members) {
      await applyNicknamePrefix(m, cfg);
      await new Promise(r => setTimeout(r, 250));
    }
    await interaction.followUp({ content: `✅ Prefix \`${prefix}\` set for ${roleIds.length} role(s). Synced nicknames for ${members.length} current member(s).`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.isModalSubmit() && id.startsWith('setup__np_prefixmodal_submit__')) {
    const roleId = id.replace('setup__np_prefixmodal_submit__', '');
    const prefix = interaction.fields.getTextInputValue('prefix').trim();
    if (!prefix) return interaction.reply({ content: '❌ Prefix cannot be empty.', flags: MessageFlags.Ephemeral });
    const existing = cfg.nicknamePrefixes.find(p => p.roleId === roleId);
    if (existing) existing.prefix = prefix;
    else cfg.nicknamePrefixes.push({ roleId, prefix });
    await saveConfig(guildId);
    await interaction.update(buildPrefixDetailView(cfg, roleId));

    // Retroactively apply to current holders of the role (capped + throttled to avoid rate-limit spikes).
    const role = interaction.guild.roles.cache.get(roleId);
    if (role) {
      const members = [...role.members.values()].slice(0, 200);
      for (const m of members) {
        await applyNicknamePrefix(m, cfg);
        await new Promise(r => setTimeout(r, 250));
      }
      await interaction.followUp({ content: `✅ Prefix set. Synced nicknames for ${members.length} current member(s) with <@&${roleId}>.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.isModalSubmit() && id === 'setup__tk_panelmodal_submit') {
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    const color = interaction.fields.getTextInputValue('color')?.trim();
    const image = interaction.fields.getTextInputValue('image')?.trim();
    const thumbnail = interaction.fields.getTextInputValue('thumbnail')?.trim();
    if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) return interaction.reply({ content: '❌ Invalid hex color.', flags: MessageFlags.Ephemeral });
    if (image && !isValidUrl(image)) return interaction.reply({ content: '❌ Invalid image URL.', flags: MessageFlags.Ephemeral });
    if (thumbnail && !isValidUrl(thumbnail)) return interaction.reply({ content: '❌ Invalid thumbnail URL.', flags: MessageFlags.Ephemeral });
    cfg.tickets.panelTitle = title;
    cfg.tickets.panelDescription = description;
    if (color) cfg.tickets.panelColor = color.startsWith('#') ? color : `#${color}`;
    cfg.tickets.panelImage = image || null;
    cfg.tickets.panelThumbnail = thumbnail || null;
    await saveConfig(guildId);
    return interaction.update(buildTicketsSetupView(cfg));
  }
  if (interaction.isModalSubmit() && id === 'setup__tk_type_add_submit') {
    const label = interaction.fields.getTextInputValue('label');
    const emoji = interaction.fields.getTextInputValue('emoji')?.trim() || '🎫';
    const description = interaction.fields.getTextInputValue('description')?.trim() || '';
    const image = interaction.fields.getTextInputValue('image')?.trim() || null;
    const thumbnail = interaction.fields.getTextInputValue('thumbnail')?.trim() || null;
    if (image && !isValidUrl(image)) return interaction.reply({ content: '❌ Invalid image URL.', flags: MessageFlags.Ephemeral });
    if (thumbnail && !isValidUrl(thumbnail)) return interaction.reply({ content: '❌ Invalid thumbnail URL.', flags: MessageFlags.Ephemeral });
    const typeId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `type${Date.now()}`;
    cfg.tickets.types.push({ id: typeId, label, emoji, description, image, thumbnail, supportRoleIds: [], requireReason: false });
    await saveConfig(guildId);
    return interaction.update(buildTicketTypesView(cfg));
  }
  if (interaction.isModalSubmit() && id.startsWith('setup__tk_type_edit_submit__')) {
    const typeId = id.replace('setup__tk_type_edit_submit__', '');
    const t = cfg.tickets.types.find(x => x.id === typeId);
    if (!t) return interaction.update(buildTicketTypesView(cfg));
    const image = interaction.fields.getTextInputValue('image')?.trim() || null;
    const thumbnail = interaction.fields.getTextInputValue('thumbnail')?.trim() || null;
    if (image && !isValidUrl(image)) return interaction.reply({ content: '❌ Invalid image URL.', flags: MessageFlags.Ephemeral });
    if (thumbnail && !isValidUrl(thumbnail)) return interaction.reply({ content: '❌ Invalid thumbnail URL.', flags: MessageFlags.Ephemeral });
    t.label = interaction.fields.getTextInputValue('label');
    t.emoji = interaction.fields.getTextInputValue('emoji')?.trim() || '🎫';
    t.description = interaction.fields.getTextInputValue('description')?.trim() || '';
    t.image = image;
    t.thumbnail = thumbnail;
    await saveConfig(guildId);
    return interaction.update(buildTicketTypeDetailView(cfg, typeId) || buildTicketTypesView(cfg));
  }
  if (interaction.isModalSubmit() && id === 'setup__tr_type_add_submit') {
    const name = interaction.fields.getTextInputValue('name');
    const typeId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `type${Date.now()}`;
    cfg.training.types.push({ id: typeId, name, roleIds: [] });
    await saveConfig(guildId);
    return interaction.update(buildTrainingTypesView(cfg));
  }
  if (interaction.isModalSubmit() && id.startsWith('setup__tr_type_rename_submit__')) {
    const typeId = id.replace('setup__tr_type_rename_submit__', '');
    const t = cfg.training.types.find(x => x.id === typeId);
    if (t) { t.name = interaction.fields.getTextInputValue('name'); await saveConfig(guildId); }
    return interaction.update(buildTrainingTypeDetailView(cfg, typeId) || buildTrainingTypesView(cfg));
  }

  return interaction.deferUpdate().catch(() => {});
}

// ════════════════════════════════════════════
// SLASH COMMANDS
// ════════════════════════════════════════════
const P = PermissionFlagsBits;
const commands = [
  { name: 'ping', description: 'Check bot latency' },

  // ── Welcome system ──
  { name: 'welcome', description: '[Admin] Configure the server welcome message', default_member_permissions: P.ManageGuild.toString(), options: [
    { name: 'action', type: 3, description: 'What to do', required: true, choices: [
      { name: 'Setup', value: 'setup' }, { name: 'Test', value: 'test' }, { name: 'Disable', value: 'disable' },
    ]},
    { name: 'channel', type: 7, description: 'Channel for welcome messages', required: false, channel_types: [0, 5] },
    { name: 'message', type: 3, description: 'Message. Placeholders: {user}, {server}, {membercount}', required: false, max_length: 1000 },
    { name: 'title', type: 3, description: 'Embed title', required: false, max_length: 256 },
    { name: 'color', type: 3, description: 'Embed color, e.g. #57F287', required: false, max_length: 7 },
    { name: 'image', type: 3, description: 'Optional image URL', required: false, max_length: 500 },
    { name: 'thumbnail', type: 3, description: 'Optional thumbnail URL', required: false, max_length: 500 },
    { name: 'embed', type: 5, description: 'Use an embed', required: false },
    { name: 'dm', type: 5, description: 'Also send the member a DM', required: false },
    { name: 'dm_message', type: 3, description: 'Optional DM message', required: false, max_length: 1000 },
  ]},

  // ── GUI setup menu (admin) ──
  { name: 'setup', description: '[Admin] Open the interactive server setup menu', default_member_permissions: P.ManageGuild.toString() },

  // ── Ticket setup (admin) ──
  { name: 'ticketsetup', description: '[Admin] Configure the ticket system', default_member_permissions: P.ManageGuild.toString(), options: [
    { name: 'category',    type: 1, description: 'Set the category new tickets are created under', options: [
      { name: 'category', type: 7, description: 'Category channel', required: true, channel_types: [4] },
    ]},
    { name: 'logchannel',  type: 1, description: 'Set the channel ticket events/transcripts are logged to', options: [
      { name: 'channel', type: 7, description: 'Log channel', required: true },
    ]},
    { name: 'supportrole', type: 1, description: 'Add or remove a support role', options: [
      { name: 'action', type: 3, description: 'Add or remove', required: true, choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }] },
      { name: 'role',   type: 8, description: 'Role', required: true },
    ]},
    { name: 'addtype',     type: 1, description: 'Add a ticket category/type', options: [
      { name: 'label',       type: 3, description: 'Type label (e.g. "Billing Support")', required: true },
      { name: 'emoji',       type: 3, description: 'Emoji for the button/select option', required: false },
      { name: 'description', type: 3, description: 'Short description', required: false },
      { name: 'image',       type: 3, description: 'Image URL shown in this type\'s ticket welcome embed', required: false },
      { name: 'thumbnail',   type: 3, description: 'Thumbnail URL shown in this type\'s ticket welcome embed', required: false },
    ]},
    { name: 'removetype',  type: 1, description: 'Remove a ticket type by label', options: [
      { name: 'label', type: 3, description: 'Type label to remove', required: true },
    ]},
    { name: 'listtypes',   type: 1, description: 'List all configured ticket types' },
    { name: 'panel',       type: 1, description: 'Send (or resend) the ticket panel', options: [
      { name: 'channel',     type: 7, description: 'Channel to send the panel to', required: true },
      { name: 'title',       type: 3, description: 'Panel title', required: false },
      { name: 'description', type: 3, description: 'Panel description', required: false },
      { name: 'color',       type: 3, description: 'Hex color, e.g. #5865F2', required: false },
      { name: 'image',       type: 3, description: 'Image URL for the panel embed', required: false },
      { name: 'thumbnail',   type: 3, description: 'Thumbnail URL for the panel embed', required: false },
    ]},
  ]},

  // ── Ticket management (used inside a ticket channel) ──
  { name: 'ticket-close',        description: 'Close the current ticket (staff only)', options: [{ name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'ticket-closerequest', description: 'Request that this ticket be closed' },
  { name: 'ticket-claim',        description: 'Claim this ticket (staff only)' },
  { name: 'ticket-add',          description: 'Add a user to this ticket', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'ticket-remove',       description: 'Remove a user from this ticket', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'ticket-rename',       description: 'Rename this ticket channel', options: [{ name: 'name', type: 3, description: 'New name', required: true }] },
  { name: 'ticket-priority',     description: 'Set this ticket\'s priority', options: [{ name: 'level', type: 3, description: 'Priority level', required: true, choices: [
      { name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' },
  ]}]},
  { name: 'ticket-note',         description: 'Add an internal staff note to this ticket', options: [{ name: 'text', type: 3, description: 'Note text', required: true }] },
  { name: 'ticket-transfer',     description: 'Transfer ticket ownership to another user', options: [{ name: 'user', type: 6, description: 'New owner', required: true }] },
  { name: 'ticket-reopen',       description: 'Reopen a closed ticket channel' },
  { name: 'ticket-archive',      description: 'Archive this ticket (read-only)' },
  { name: 'ticket-delete',       description: 'Permanently delete this ticket' },
  { name: 'ticket-info',         description: 'View info about this ticket' },

  // ── Moderation ──
  { name: 'staffrank', description: 'Check a staff member\'s rank clearance level', default_member_permissions: P.ModerateMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who? (default: yourself)', required: false },
  ]},
  { name: 'staff', description: 'List all configured staff members and their clearance level', default_member_permissions: P.ModerateMembers.toString() },
  { name: 'case-create', description: 'Create a new staff case file', options: [
    { name: 'system', type: 3, description: 'Case system', required: true, choices: [{name:'Internal Affairs',value:'ia'},{name:'Management',value:'management'},{name:'Supervisor',value:'supervisor'},{name:'Executive',value:'executive'}] },
    { name: 'reporting_party', type: 6, description: 'Reporting party', required: true },
    { name: 'reported_party', type: 6, description: 'Reported party', required: true },
    { name: 'reason', type: 3, description: 'Reason / summary', required: true, max_length: 900 },
  ]},
  { name: 'case-status', description: 'Update a case status', options: [
    { name: 'number', type: 4, description: 'Case number', required: true },
    { name: 'status', type: 3, description: 'New status', required: true, choices: [{name:'Open',value:'Open'},{name:'Under Investigation',value:'Under Investigation'},{name:'Awaiting Approval',value:'Awaiting Approval'},{name:'Resolved',value:'Resolved'},{name:'Closed',value:'Closed'}] },
  ]},
  { name: 'case-note', description: 'Add a note to a case', options: [{ name:'number',type:4,description:'Case number',required:true },{ name:'note',type:3,description:'Internal note',required:true,max_length:900 }]},
  { name: 'case-close', description: 'Close a case without deleting its record', options: [{ name:'number',type:4,description:'Case number',required:true }]},
  { name: 'case-reopen', description: 'Reopen a previously closed case', options: [{ name:'number',type:4,description:'Case number',required:true }]},
  { name: 'case-infraction', description: 'Propose an infraction from a case for SHR approval', options: [
    { name:'number',type:4,description:'Case number',required:true },{ name:'user',type:6,description:'Member',required:true },
    { name:'action',type:3,description:'Disciplinary action',required:true,choices:[{name:'Warn',value:'warn'},{name:'Mute',value:'mute'},{name:'Kick',value:'kick'},{name:'Ban',value:'ban'},{name:'Tempban',value:'tempban'},{name:'Demotion (remove role)',value:'demotion'}]},
    { name:'reason',type:3,description:'Reason',required:true,max_length:500 },
    { name:'duration',type:4,description:'Minutes for mute / hours for tempban',required:false,min_value:1 },
    { name:'role',type:8,description:'Role to remove for demotion',required:false },
  ]},
  { name: 'promotion', description: 'Create a promotion announcement (SHR direct; HR requests approval)', options: [
    { name: 'member', type: 6, description: 'Member being promoted', required: true },
    { name: 'department', type: 3, description: 'Department', required: true, max_length: 50 },
    { name: 'current_rank', type: 8, description: 'Current rank', required: true },
    { name: 'new_rank', type: 8, description: 'New rank', required: true },
    { name: 'type', type: 3, description: 'Promotion type', required: true, choices: [
      { name: 'CoC', value: 'coc' },
      { name: 'Overig', value: 'overig' },
    ]},
    { name: 'reason', type: 3, description: 'Reason for the promotion', required: true, max_length: 500 },
  ]},

  { name: 'syncprefixes', description: '[Admin] Re-apply all configured nickname prefixes to every member', default_member_permissions: P.ManageGuild.toString() },
  { name: 'seedrankprefixes', description: '[Admin] Auto-configure prefixes for the standard rank hierarchy by matching role names', default_member_permissions: P.ManageGuild.toString() },
  { name: 'warn', description: 'Warn a user', default_member_permissions: P.ModerateMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: true },
  ]},
  { name: 'warnings', description: 'View a user\'s warnings', default_member_permissions: P.ModerateMembers.toString(), options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'clearwarnings', description: 'Clear all warnings for a user', default_member_permissions: P.ModerateMembers.toString(), options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'note', description: 'Add a moderator note to a user (not visible to them)', default_member_permissions: P.ModerateMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'text', type: 3, description: 'Note', required: true },
  ]},
  { name: 'notes', description: 'View moderator notes for a user', default_member_permissions: P.ModerateMembers.toString(), options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'mute', description: 'Timeout (mute) a user', default_member_permissions: P.ModerateMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'minutes', type: 4, description: 'Minutes', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'unmute', description: 'Remove a user\'s timeout', default_member_permissions: P.ModerateMembers.toString(), options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  { name: 'kick', description: 'Kick a user', default_member_permissions: P.KickMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'ban', description: 'Ban a user', default_member_permissions: P.BanMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
    { name: 'delete_days', type: 4, description: 'Days of messages to delete (0-7)', required: false, min_value: 0, max_value: 7 },
  ]},
  { name: 'unban', description: 'Unban a user by ID', default_member_permissions: P.BanMembers.toString(), options: [
    { name: 'userid', type: 3, description: 'User ID', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'softban', description: 'Softban a user (ban + immediate unban to purge messages)', default_member_permissions: P.BanMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'tempban', description: 'Temporarily ban a user', default_member_permissions: P.BanMembers.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'hours', type: 4, description: 'Hours', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'clear', description: 'Bulk delete messages', default_member_permissions: P.ManageMessages.toString(), options: [
    { name: 'amount', type: 4, description: 'How many (max 100)', required: true, min_value: 1, max_value: 100 },
    { name: 'user',   type: 6, description: 'Only delete messages from this user', required: false },
  ]},
  { name: 'slowmode', description: 'Set channel slowmode', default_member_permissions: P.ManageChannels.toString(), options: [{ name: 'seconds', type: 4, description: 'Seconds (0 = off)', required: true, min_value: 0, max_value: 21600 }] },
  { name: 'lock',   description: 'Lock a channel', default_member_permissions: P.ManageChannels.toString(), options: [{ name: 'channel', type: 7, description: 'Channel (default: this one)', required: false }] },
  { name: 'unlock', description: 'Unlock a channel', default_member_permissions: P.ManageChannels.toString(), options: [{ name: 'channel', type: 7, description: 'Channel (default: this one)', required: false }] },
  { name: 'nickname', description: 'Change a user\'s nickname', default_member_permissions: P.ManageNicknames.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'nickname', type: 3, description: 'New nickname (blank to reset)', required: false },
  ]},
  { name: 'removerole', description: 'Remove a role from a user', default_member_permissions: P.ManageRoles.toString(), options: [
    { name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role', required: true },
  ]},
  { name: 'giveroles', description: 'Add one or more roles to a user', default_member_permissions: P.ManageRoles.toString(), options: [
    { name: 'user',  type: 6, description: 'Who?', required: true },
    { name: 'roles', type: 3, description: 'Role IDs or mentions, space separated', required: true },
  ]},

  // ── Training ──
  { name: 'trainingsetup', description: '[Admin] Configure the training request system', default_member_permissions: P.ManageGuild.toString(), options: [
    { name: 'channel',         type: 1, description: 'Set the channel training requests are posted to', options: [
      { name: 'channel', type: 7, description: 'Channel', required: true },
    ]},
    { name: 'announcechannel', type: 1, description: 'Set the channel to announce passed trainings in', options: [
      { name: 'channel', type: 7, description: 'Channel', required: true },
    ]},
    { name: 'trainerrole',     type: 1, description: 'Add or remove a trainer role', options: [
      { name: 'action', type: 3, description: 'Add or remove', required: true, choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }] },
      { name: 'role',   type: 8, description: 'Role', required: true },
    ]},
    { name: 'requestrole',     type: 1, description: 'Add or remove a role allowed to request training (none = everyone)', options: [
      { name: 'action', type: 3, description: 'Add or remove', required: true, choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }] },
      { name: 'role',   type: 8, description: 'Role', required: true },
    ]},
    { name: 'pingrole',        type: 1, description: 'Add or remove a role pinged on new training requests', options: [
      { name: 'action', type: 3, description: 'Add or remove', required: true, choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }] },
      { name: 'role',   type: 8, description: 'Role', required: true },
    ]},
    { name: 'addtype',         type: 1, description: 'Add a training type', options: [
      { name: 'name',  type: 3, description: 'Type name (e.g. "Patrol Training")', required: true },
      { name: 'roles', type: 3, description: 'Role IDs/mentions to grant on pass, space separated', required: false },
    ]},
    { name: 'removetype',      type: 1, description: 'Remove a training type by name', options: [
      { name: 'name', type: 3, description: 'Type name to remove', required: true },
    ]},
    { name: 'listtypes',       type: 1, description: 'List all configured training types' },
  ]},
  { name: 'trainrequest', description: 'Request a trainer' },
];

// ════════════════════════════════════════════
// TEMPBAN SWEEP — checks MongoDB for expired temp-bans so they survive restarts
// ════════════════════════════════════════════
async function sweepExpiredTempBans() {
  if (!dbReady) return;
  let due = [];
  try {
    due = await TempBanModel.find({ unbanAt: { $lte: new Date() } });
  } catch (e) {
    console.error('sweepExpiredTempBans query error:', e.message);
    return;
  }
  for (const rec of due) {
    try {
      const guild = await client.guilds.fetch(rec.guildId).catch(() => null);
      if (guild) await guild.members.unban(rec.userId, 'Tempban expired').catch(() => {});
    } catch (e) {
      console.error(`Tempban sweep unban failed for ${rec.userId}:`, e.message);
    } finally {
      await safeSave(() => TempBanModel.deleteOne({ _id: rec._id }), 'tempban cleanup');
    }
  }
}

// ════════════════════════════════════════════
// READY
// ════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands.`);
  } catch (e) {
    console.error('❌ Command registration failed:', e);
  }

  // Catch up on any temp-bans that expired while the bot was offline, then poll every minute.
  await sweepExpiredTempBans();
  setInterval(() => sweepExpiredTempBans().catch(e => console.error('Tempban sweep error:', e)), 60000);
});

// ════════════════════════════════════════════
// ROLE-BASED NICKNAME PREFIXES
// ════════════════════════════════════════════
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return; // only react to role changes
    const cfg = await getConfig(newMember.guild.id);
    await applyNicknamePrefix(newMember, cfg);
  } catch (e) {
    console.error('guildMemberUpdate (nickname prefix) error:', e.message);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    const cfg = await getConfig(member.guild.id);
    await applyNicknamePrefix(member, cfg);
    await sendWelcomeMessage(member, cfg);
    if (cfg.welcome?.dmEnabled && cfg.welcome?.dmMessage) {
      await safeDM(member.user, { content: replaceWelcomePlaceholders(cfg.welcome.dmMessage, member) });
    }
  } catch (e) {
    console.error('guildMemberAdd (welcome/prefix) error:', e.message);
  }
});

// ════════════════════════════════════════════
// INTERACTIONS
// ════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  try {
    const cid = interaction.customId;

    // ───────── TICKET RATING (can happen in DMs — handle before the guild check) ─────────
    if (interaction.isButton() && cid?.startsWith('tkt__rate__')) {
      const [, , ticketId, starsStr] = cid.split('__');
      const stars = parseInt(starsStr, 10);
      const ticket = await TicketModel.findById(ticketId).catch(() => null);
      if (!ticket) return interaction.reply({ content: '❌ This ticket could not be found anymore.', flags: MessageFlags.Ephemeral });
      if (ticket.rating != null) return interaction.reply({ content: '✅ You already rated this ticket. Thanks!', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`tkt__ratefb__${ticketId}__${stars}`).setTitle(`Rate: ${'⭐'.repeat(stars)}`);
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('feedback').setLabel('Any additional feedback? (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ));
      return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && cid?.startsWith('tkt__ratefb__')) {
      const [, , ticketId, starsStr] = cid.split('__');
      const stars = parseInt(starsStr, 10);
      const feedback = interaction.fields.getTextInputValue('feedback')?.trim() || null;
      const ticket = await TicketModel.findById(ticketId).catch(() => null);
      if (!ticket) return interaction.reply({ content: '❌ This ticket could not be found anymore.', flags: MessageFlags.Ephemeral });
      if (ticket.rating == null) {
        ticket.rating = stars;
        ticket.ratingFeedback = feedback;
        await safeSave(() => ticket.save(), 'ticket save');
        const ratedGuild = await client.guilds.fetch(ticket.guildId).catch(() => null);
        if (ratedGuild) {
          const gcfg = await getConfig(ratedGuild.id);
          await logTicketEvent(ratedGuild, gcfg, new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle('⭐ Ticket Rated')
            .addFields(
              { name: 'Ticket', value: `#${ticket.number}`, inline: true },
              { name: 'Rating', value: '⭐'.repeat(stars), inline: true },
              { name: 'Feedback', value: feedback || '*none*' },
            ).setTimestamp());
        }
      }
      try {
        return await interaction.update({ content: `✅ Thanks for your rating: ${'⭐'.repeat(stars)}`, components: [] });
      } catch {
        return interaction.reply({ content: '✅ Thanks for your feedback!', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    if (!interaction.guild) {
      if (interaction.isRepliable()) await interaction.reply({ content: '❌ This bot only works in servers.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const guildId = interaction.guild.id;

    // Handle the CoC import modal before loading configuration so the interaction
    // is acknowledged immediately and cannot expire while MongoDB is responding.
    if (interaction.isModalSubmit() && cid === 'setup__coc_import_submit') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'Manage Server permission required.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const cfg = await getConfig(guildId);
        const raw = interaction.fields.getTextInputValue('ranks') || '';
        const { parsed, errors } = parseCocImport(interaction.guild, raw);

        if (!parsed.length) {
          return interaction.editReply({ content: `No valid ranks found.\\n${errors.join('\\n').slice(0, 1800)}` }).catch(() => {});
        }

        pendingCocImports.set(interaction.user.id, { guildId, parsed });
        setTimeout(() => pendingCocImports.delete(interaction.user.id), 5 * 60 * 1000);

        const preview = buildCocImportPreview(cfg, parsed);
        if (errors.length) {
          preview.embeds[0].addFields({ name: 'Warnings', value: errors.join('\\n').slice(0, 1024) });
        }

        return interaction.editReply(preview).catch(() => {});
      } catch (error) {
        console.error('[CoC Import] Modal processing failed:', error);
        return interaction.editReply({ content: 'The bulk import could not be processed. Check the bot console for details.' }).catch(() => {});
      }
    }

    const cfg = await getConfig(guildId);

    // ───────── GUI /setup MENU (buttons, selects, modals) ─────────
    if (typeof cid === 'string' && cid.startsWith('setup__')) {
      if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return handleSetupInteraction(interaction, cfg, guildId);
    }

    // ───────── BUTTONS ─────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith('staffreq__')) {
        const [, action, requestId] = id.split('__');
        if (!canApproveStaffRequest(interaction.member, cfg)) return interaction.reply({ content: '❌ Only configured SHR / SHRM approval roles can decide requests.', flags: MessageFlags.Ephemeral });
        const record = await StaffRequestModel.findOne({ _id: requestId, guildId });
        if (!record || record.status !== 'pending') return interaction.reply({ content: 'This request has already been handled or no longer exists.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (action === 'reject') {
          record.status = 'rejected'; record.approverId = interaction.user.id; record.resolvedAt = new Date(); await record.save();
          await interaction.message.edit({ components: [] }).catch(() => {});
          return interaction.editReply('Request rejected.');
        }
        try {
          record.approverId = interaction.user.id;
          record.result = await executeStaffRequest(interaction, record);
          record.status = 'executed'; record.resolvedAt = new Date(); await record.save();
          await interaction.message.edit({ components: [] }).catch(() => {});
          return interaction.editReply(`Approved and executed: ${record.result}`);
        } catch (error) {
          record.status = 'failed'; record.approverId = interaction.user.id; record.result = error.message; record.resolvedAt = new Date(); await record.save();
          return interaction.editReply(`Approval failed: ${error.message}`);
        }
      }

      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        const type = cfg.tickets.types.find(t => t.id === typeId);
        if (type?.requireReason) {
          const modal = new ModalBuilder().setCustomId(`tkt__reasonmodal__${typeId}`).setTitle('Open a Ticket');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reason').setLabel('Please describe your issue').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
          ));
          return interaction.showModal(modal);
        }
        await createTicketChannel(interaction, typeId, cfg);
        return;
      }

      if (id === 'tkt__claim') {
        const ticket = await TicketModel.findOne({ channelId: interaction.channel.id });
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', flags: MessageFlags.Ephemeral });
        if (!isTicketStaff(interaction.member, cfg, ticket)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        if (ticket.claimedBy) return interaction.reply({ content: `❌ Already claimed by <@${ticket.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        ticket.claimedBy = interaction.user.id;
        if (!ticket.staffMembers.includes(interaction.user.id)) ticket.staffMembers.push(interaction.user.id);
        await safeSave(() => ticket.save(), 'ticket save');
        await interaction.update({ components: [buildTicketControlRow(true)] }).catch(() => {});
        await interaction.followUp({ content: `🙋 Ticket claimed by ${userDisplay(interaction.user)}.` }).catch(() => {});
        return;
      }

      if (id === 'tkt__close') {
        const ticket = await TicketModel.findOne({ channelId: interaction.channel.id });
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', flags: MessageFlags.Ephemeral });
        if (!isTicketStaff(interaction.member, cfg, ticket) && interaction.user.id !== ticket.creatorId) {
          return interaction.reply({ content: '❌ Staff or the ticket owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        await closeTicket(interaction, ticket, cfg, 'Closed via button');
        return;
      }

      if (id.startsWith('tr__')) {
        const [, action, requesterId, typeId] = id.split('__');
        if (!isTrainer(interaction.member, cfg)) return interaction.reply({ content: '❌ Only trainers can interact with training requests.', flags: MessageFlags.Ephemeral });

        const req = await TrainingRequestModel.findOne({ guildId, messageId: interaction.message.id });
        if (!req) return interaction.reply({ content: '❌ Could not find this training request in the database.', flags: MessageFlags.Ephemeral });
        if (req.status !== 'open') return interaction.reply({ content: '❌ This training request has already been completed.', flags: MessageFlags.Ephemeral });

        const requester = await client.users.fetch(requesterId).catch(() => null);
        if (!requester) return interaction.reply({ content: '❌ Could not fetch the requester.', flags: MessageFlags.Ephemeral });

        if (action === 'claim') {
          if (req.claimedBy.includes(interaction.user.id)) return interaction.reply({ content: '❌ You already claimed this request.', flags: MessageFlags.Ephemeral });
          req.claimedBy.push(interaction.user.id);
          await safeSave(() => req.save(), 'training request save');
          const embed = buildTrainingRequestEmbed({ user: requester, typeName: req.typeName, times: interaction.message.embeds[0].fields.find(f => f.name === '🕐 Available Times')?.value, notes: interaction.message.embeds[0].fields.find(f => f.name === '📝 Notes')?.value, claimed: req.claimedBy });
          await interaction.update({ embeds: [embed], components: [buildTrainingButtons(requesterId, typeId)] });
          return;
        }

        if (action === 'unclaim') {
          if (!req.claimedBy.includes(interaction.user.id)) return interaction.reply({ content: '❌ You have not claimed this request.', flags: MessageFlags.Ephemeral });
          req.claimedBy = req.claimedBy.filter(id2 => id2 !== interaction.user.id);
          await safeSave(() => req.save(), 'training request save');
          const embed = buildTrainingRequestEmbed({ user: requester, typeName: req.typeName, times: interaction.message.embeds[0].fields.find(f => f.name === '🕐 Available Times')?.value, notes: interaction.message.embeds[0].fields.find(f => f.name === '📝 Notes')?.value, claimed: req.claimedBy });
          await interaction.update({ embeds: [embed], components: [buildTrainingButtons(requesterId, typeId)] });
          return;
        }

        if (action === 'pass' || action === 'fail') {
          const passed = action === 'pass';
          req.status = passed ? 'passed' : 'failed';
          req.resolvedBy = interaction.user.id;
          await safeSave(() => req.save(), 'training request save');
          const embed = buildTrainingRequestEmbed({
            user: requester, typeName: req.typeName,
            times: interaction.message.embeds[0].fields.find(f => f.name === '🕐 Available Times')?.value,
            notes: interaction.message.embeds[0].fields.find(f => f.name === '📝 Notes')?.value,
            claimed: req.claimedBy, status: req.status, resolvedBy: interaction.user.id,
          });
          await interaction.update({ embeds: [embed], components: [buildTrainingButtons(requesterId, typeId, true)] });

          if (passed) {
            const type = cfg.training.types.find(t => t.id === req.typeId);
            const targetMember = await interaction.guild.members.fetch(requesterId).catch(() => null);
            if (type?.roleIds?.length && targetMember) {
              const roleNames = [];
              for (const rid of type.roleIds) {
                await targetMember.roles.add(rid).catch(() => {});
                const r = interaction.guild.roles.cache.get(rid);
                if (r) roleNames.push(r.name);
              }
              await interaction.followUp({ content: `✅ Gave ${type.roleIds.map(r => `<@&${r}>`).join(', ')} to <@${requesterId}> for passing **${type.name}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            if (cfg.training.announceChannel) {
              const announceCh = interaction.guild.channels.cache.get(cfg.training.announceChannel);
              if (announceCh) {
                await announceCh.send({ content: `🎉 Congratulations <@${requesterId}>! You have **passed your training**${req.typeName ? ` (${req.typeName})` : ''}! Well done!` }).catch(() => {});
              }
            }
            await safeDM(requester, { content: `🎉 You passed your training in **${interaction.guild.name}**${req.typeName ? ` (${req.typeName})` : ''}!` });
          } else {
            await safeDM(requester, { content: `❌ Your training request in **${interaction.guild.name}** was marked as failed. You may request again.` });
          }
          return;
        }
        return;
      }
      return;
    }

    // ───────── SELECT MENUS ─────────
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'tkt__opensel') {
        const typeId = interaction.values[0];
        const type = cfg.tickets.types.find(t => t.id === typeId);
        if (type?.requireReason) {
          const modal = new ModalBuilder().setCustomId(`tkt__reasonmodal__${typeId}`).setTitle('Open a Ticket');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reason').setLabel('Please describe your issue').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
          ));
          return interaction.showModal(modal);
        }
        await createTicketChannel(interaction, typeId, cfg);
        return;
      }
      if (interaction.customId === 'tr_select_type') {
        const typeId = interaction.values[0];
        const type = cfg.training.types.find(t => t.id === typeId);
        const modal = new ModalBuilder().setCustomId(`modal_trainrequest__${typeId}`).setTitle(`Training Request${type ? ` — ${type.name}`.slice(0, 25) : ''}`.slice(0, 45));
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_times').setLabel('When are you available? (times/timezone)').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Monday 5-8PM EST, Wednesday 6-9PM EST').setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_notes').setLabel('Anything else the trainer should know?').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. I have done 2 ride-alongs already').setRequired(false).setMaxLength(500)),
        );
        await interaction.showModal(modal);
        return;
      }
      return;
    }

    // ───────── MODAL SUBMIT ─────────
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('tkt__reasonmodal__')) {
        const typeId = interaction.customId.replace('tkt__reasonmodal__', '');
        const reason = interaction.fields.getTextInputValue('reason');
        await createTicketChannel(interaction, typeId, cfg, reason);
        return;
      }
      if (interaction.customId.startsWith('modal_trainrequest__')) {
        const typeId = interaction.customId.replace('modal_trainrequest__', '');
        const type = typeId !== 'none' ? cfg.training.types.find(t => t.id === typeId) : null;
        const ch = cfg.training.channel ? interaction.guild.channels.cache.get(cfg.training.channel) : null;
        if (!ch) return interaction.reply({ content: '❌ Training request channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });

        const times = interaction.fields.getTextInputValue('tr_times');
        const notes = interaction.fields.getTextInputValue('tr_notes')?.trim() || '';

        const embed = buildTrainingRequestEmbed({ user: interaction.user, typeName: type ? type.name : null, times, notes, claimed: [] });
        const row = buildTrainingButtons(interaction.user.id, typeId);
        const ping = cfg.training.pingRoles.length ? cfg.training.pingRoles.map(r => `<@&${r}>`).join(' ') : undefined;
        const msg = await ch.send({ content: ping, embeds: [embed], components: [row] });

        const created = await safeCreate(TrainingRequestModel, {
          guildId, requesterId: interaction.user.id, channelId: ch.id, messageId: msg.id,
          typeId: type ? type.id : null, typeName: type ? type.name : null,
        }, 'training request create');
        await setTrainCooldown(guildId, interaction.user.id);
        if (!created) {
          await ch.send('⚠️ This request was posted, but saving it to the database failed — claim/complete tracking may not work for it.').catch(() => {});
        }

        return interaction.reply({ content: '✅ Your training request has been posted! A trainer will claim it soon.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // ───────── SLASH COMMANDS ─────────
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const member = interaction.member;

    if (cmd === 'ping') {
      return interaction.reply({ content: `🏓 Pong! ${client.ws.ping}ms` });
    }

    if (cmd === 'setup') {
      if (!isAdmin(member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [buildSetupHomeEmbed()], components: buildSetupHomeComponents(), flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'syncprefixes') {
      if (!isAdmin(member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral });
      if (!cfg.nicknamePrefixes.length) return interaction.reply({ content: 'No nickname prefixes are configured yet. Set them up via **/setup → Nickname Prefixes**.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildMembers = await interaction.guild.members.fetch().catch(() => new Map());
      let synced = 0;
      for (const m of guildMembers.values()) {
        if (m.user.bot) continue;
        const hasAnyPrefixRole = cfg.nicknamePrefixes.some(p => m.roles.cache.has(p.roleId));
        const currentName = m.nickname || m.user.username;
        const wouldStrip = stripKnownPrefixes(currentName, cfg) !== currentName;
        if (!hasAnyPrefixRole && !wouldStrip) continue;
        await applyNicknamePrefix(m, cfg);
        synced++;
        await new Promise(r => setTimeout(r, 250));
      }
      return interaction.editReply({ content: `✅ Synced nicknames for ${synced} member(s).` });
    }

    if (cmd === 'seedrankprefixes') {
      if (!isAdmin(member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const matched = [];
      const notFound = [];
      const matchedRoleIds = [];
      for (const abbr of STANDARD_RANK_PREFIXES) {
        const role = interaction.guild.roles.cache.find(r => r.name.trim().toLowerCase() === abbr.toLowerCase());
        if (!role) { notFound.push(abbr); continue; }
        const existing = cfg.nicknamePrefixes.find(p => p.roleId === role.id);
        if (existing) existing.prefix = abbr;
        else cfg.nicknamePrefixes.push({ roleId: role.id, prefix: abbr });
        matched.push(`\`${abbr}\` → <@&${role.id}>`);
        matchedRoleIds.push(role.id);
      }

      if (!matched.length) {
        return interaction.editReply({ content: `❌ None of the standard rank roles (${STANDARD_RANK_PREFIXES.join(', ')}) were found by exact name in this server. Make sure your role names match exactly, or configure them manually via **/setup → Nickname Prefixes**.` });
      }

      await saveConfig(guildId);

      // Retroactively apply to every current holder of a matched role (deduped, capped + throttled).
      const affectedMembers = new Map();
      for (const roleId of matchedRoleIds) {
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) continue;
        for (const m of role.members.values()) affectedMembers.set(m.id, m);
      }
      const members = [...affectedMembers.values()].slice(0, 200);
      for (const m of members) {
        await applyNicknamePrefix(m, cfg);
        await new Promise(r => setTimeout(r, 250));
      }

      const embed = new EmbedBuilder()
        .setTitle('🏷️ Rank Prefixes Seeded')
        .setColor(0x57F287)
        .addFields({ name: `✅ Matched (${matched.length})`, value: matched.join('\n').slice(0, 1024) });
      if (notFound.length) {
        embed.addFields({ name: `⚠️ No role found for (${notFound.length})`, value: `\`${notFound.join('`, `')}\`\nCreate/rename these roles to match exactly, or add them manually via **/setup → Nickname Prefixes**.`.slice(0, 1024) });
      }
      embed.setFooter({ text: `Synced nicknames for ${members.length} current member(s).` });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Ticket setup ──
    if (cmd === 'ticketsetup') {
      if (!isAdmin(member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();

      if (sub === 'category') {
        cfg.tickets.categoryId = interaction.options.getChannel('category').id;
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Ticket category set to <#${cfg.tickets.categoryId}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'logchannel') {
        cfg.tickets.logChannelId = interaction.options.getChannel('channel').id;
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Ticket log channel set to <#${cfg.tickets.logChannelId}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'supportrole') {
        const action = interaction.options.getString('action');
        const role = interaction.options.getRole('role');
        if (action === 'add') {
          if (!cfg.tickets.supportRoleIds.includes(role.id)) cfg.tickets.supportRoleIds.push(role.id);
        } else {
          cfg.tickets.supportRoleIds = cfg.tickets.supportRoleIds.filter(r => r !== role.id);
        }
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Support role ${action === 'add' ? 'added' : 'removed'}: <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'addtype') {
        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji') || '🎫';
        const description = interaction.options.getString('description') || '';
        const image = interaction.options.getString('image') || null;
        const thumbnail = interaction.options.getString('thumbnail') || null;
        if (image && !isValidUrl(image)) return interaction.reply({ content: '❌ Invalid image URL. Must start with `https://`.', flags: MessageFlags.Ephemeral });
        if (thumbnail && !isValidUrl(thumbnail)) return interaction.reply({ content: '❌ Invalid thumbnail URL. Must start with `https://`.', flags: MessageFlags.Ephemeral });
        const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `type${Date.now()}`;
        cfg.tickets.types.push({ id, label, emoji, description, image, thumbnail });
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Ticket type **${label}** added${image ? ' (with image)' : ''}.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'removetype') {
        const label = interaction.options.getString('label').toLowerCase();
        const before = cfg.tickets.types.length;
        cfg.tickets.types = cfg.tickets.types.filter(t => t.label.toLowerCase() !== label);
        if (cfg.tickets.types.length === before) return interaction.reply({ content: '❌ No type found with that label.', flags: MessageFlags.Ephemeral });
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Ticket type removed.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'listtypes') {
        const list = cfg.tickets.types.map(t => `${t.emoji || '🎫'} **${t.label}** — ${t.description || '*no description*'}${t.image ? ' 🖼️' : ''}`).join('\n') || '*No types configured.*';
        return interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'panel') {
        const channel = interaction.options.getChannel('channel');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        if (image && !isValidUrl(image)) return interaction.reply({ content: '❌ Invalid image URL. Must start with `https://`.', flags: MessageFlags.Ephemeral });
        if (thumbnail && !isValidUrl(thumbnail)) return interaction.reply({ content: '❌ Invalid thumbnail URL. Must start with `https://`.', flags: MessageFlags.Ephemeral });
        if (interaction.options.getString('title')) cfg.tickets.panelTitle = interaction.options.getString('title');
        if (interaction.options.getString('description')) cfg.tickets.panelDescription = interaction.options.getString('description');
        if (interaction.options.getString('color')) cfg.tickets.panelColor = interaction.options.getString('color');
        if (image) cfg.tickets.panelImage = image;
        if (thumbnail) cfg.tickets.panelThumbnail = thumbnail;
        await saveConfig(guildId);
        await sendOrUpdatePanel(interaction, channel, cfg, guildId);
        return interaction.reply({ content: `✅ Ticket panel sent to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      }
    }

    // ── Training setup (admin) ──
    if (cmd === 'trainingsetup') {
      if (!isAdmin(member)) return interaction.reply({ content: '❌ Manage Server permission required.', flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();

      if (sub === 'channel') {
        cfg.training.channel = interaction.options.getChannel('channel').id;
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Training request channel set to <#${cfg.training.channel}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'announcechannel') {
        cfg.training.announceChannel = interaction.options.getChannel('channel').id;
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Training announce channel set to <#${cfg.training.announceChannel}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'trainerrole' || sub === 'requestrole' || sub === 'pingrole') {
        const action = interaction.options.getString('action');
        const role = interaction.options.getRole('role');
        const key = sub === 'trainerrole' ? 'trainerRoles' : sub === 'requestrole' ? 'requestRoles' : 'pingRoles';
        if (action === 'add') {
          if (!cfg.training[key].includes(role.id)) cfg.training[key].push(role.id);
        } else {
          cfg.training[key] = cfg.training[key].filter(r => r !== role.id);
        }
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ ${sub} ${action === 'add' ? 'added' : 'removed'}: <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'addtype') {
        const name = interaction.options.getString('name');
        const rolesStr = interaction.options.getString('roles');
        const roleIds = rolesStr ? parseRoleOrUserIds(rolesStr).filter(id => interaction.guild.roles.cache.has(id)) : [];
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `type${Date.now()}`;
        cfg.training.types.push({ id, name, roleIds });
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Training type **${name}** added${roleIds.length ? ` (grants ${roleIds.map(r => `<@&${r}>`).join(', ')} on pass)` : ''}.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'removetype') {
        const name = interaction.options.getString('name').toLowerCase();
        const before = cfg.training.types.length;
        cfg.training.types = cfg.training.types.filter(t => t.name.toLowerCase() !== name);
        if (cfg.training.types.length === before) return interaction.reply({ content: '❌ No training type found with that name.', flags: MessageFlags.Ephemeral });
        await saveConfig(guildId);
        return interaction.reply({ content: '✅ Training type removed.', flags: MessageFlags.Ephemeral });
      }
      if (sub === 'listtypes') {
        const list = cfg.training.types.map(t => `🎓 **${t.name}**${t.roleIds.length ? ` — grants ${t.roleIds.map(r => `<@&${r}>`).join(', ')}` : ''}`).join('\n') || '*No training types configured — `/trainrequest` will use a general request instead.*';
        return interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
      }
    }

    // ── Training request ──
    if (cmd === 'trainrequest') {
      if (!canRequestTraining(member, cfg)) return interaction.reply({ content: '❌ You do not have permission to request a trainer.', flags: MessageFlags.Ephemeral });
      const remaining = await getTrainCooldownRemaining(guildId, interaction.user.id);
      if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        return interaction.reply({ content: `⏳ You can request a trainer again in **${mins} minute${mins !== 1 ? 's' : ''}**.`, flags: MessageFlags.Ephemeral });
      }
      if (!cfg.training.channel) return interaction.reply({ content: '❌ Training request channel not set up. Ask an admin to run `/trainingsetup channel`.', flags: MessageFlags.Ephemeral });

      if (cfg.training.types.length > 0) {
        const typeSelect = new StringSelectMenuBuilder()
          .setCustomId('tr_select_type')
          .setPlaceholder('Select the training type...')
          .addOptions(cfg.training.types.slice(0, 25).map(t => ({ label: t.name.slice(0, 100), value: t.id, description: t.roleIds.length ? 'Role(s) will be assigned on pass' : 'No role assigned' })));
        return interaction.reply({
          content: '### 🎓 Select the type of training you are requesting:',
          components: [new ActionRowBuilder().addComponents(typeSelect)],
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder().setCustomId('modal_trainrequest__none').setTitle('Training Request');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_times').setLabel('When are you available? (times/timezone)').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Monday 5-8PM EST, Wednesday 6-9PM EST').setRequired(true).setMaxLength(500)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_notes').setLabel('Anything else the trainer should know?').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. I have done 2 ride-alongs already').setRequired(false).setMaxLength(500)),
      );
      return interaction.showModal(modal);
    }

    // ── Ticket management commands ──
    if (cmd.startsWith('ticket-')) {
      const ticket = await requireTicketChannel(interaction);
      if (!ticket) return;
      const staff = isTicketStaff(member, cfg, ticket);

      if (cmd === 'ticket-close') {
        if (!staff && interaction.user.id !== ticket.creatorId) return interaction.reply({ content: '❌ Staff or the ticket owner only.', flags: MessageFlags.Ephemeral });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await interaction.reply({ content: '🔒 Closing ticket...' });
        await closeTicket(interaction, ticket, cfg, reason);
        return;
      }
      if (cmd === 'ticket-closerequest') {
        await logTicketEvent(interaction.guild, cfg, new EmbedBuilder().setColor(0xFEE75C).setTitle('🔔 Close Requested').addFields(
          { name: 'Ticket', value: `#${ticket.number} (${interaction.channel.name})`, inline: true },
          { name: 'Requested by', value: userDisplay(interaction.user), inline: true },
        ).setTimestamp());
        return interaction.reply({ content: '🔔 Close request sent. Staff will review shortly.' });
      }
      if (cmd === 'ticket-claim') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        if (ticket.claimedBy) return interaction.reply({ content: `❌ Already claimed by <@${ticket.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        ticket.claimedBy = interaction.user.id;
        if (!ticket.staffMembers.includes(interaction.user.id)) ticket.staffMembers.push(interaction.user.id);
        await safeSave(() => ticket.save(), 'ticket save');
        return interaction.reply({ content: `🙋 Ticket claimed by ${userDisplay(interaction.user)}.` });
      }
      if (cmd === 'ticket-add') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        if (!ticket.staffMembers.includes(user.id)) { ticket.staffMembers.push(user.id); await safeSave(() => ticket.save(), 'ticket save'); }
        return interaction.reply({ content: `✅ Added ${userDisplay(user)} to this ticket.` });
      }
      if (cmd === 'ticket-remove') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
        ticket.staffMembers = ticket.staffMembers.filter(id => id !== user.id);
        await safeSave(() => ticket.save(), 'ticket save');
        return interaction.reply({ content: `✅ Removed ${userDisplay(user)} from this ticket.` });
      }
      if (cmd === 'ticket-rename') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const name = interaction.options.getString('name').toLowerCase().replace(/\s+/g, '-').slice(0, 90);
        await interaction.channel.setName(name).catch(() => {});
        return interaction.reply({ content: `✅ Renamed channel to \`${name}\`.` });
      }
      if (cmd === 'ticket-priority') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        ticket.priority = interaction.options.getString('level');
        await safeSave(() => ticket.save(), 'ticket save');
        return interaction.reply({ content: `✅ Priority set to **${ticket.priority}**.` });
      }
      if (cmd === 'ticket-note') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const text = interaction.options.getString('text');
        ticket.notes.push({ authorId: interaction.user.id, text, createdAt: new Date() });
        await safeSave(() => ticket.save(), 'ticket save');
        return interaction.reply({ content: '📝 Note added (staff only visibility is not enforced by channel perms — keep sensitive notes elsewhere).', flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'ticket-transfer') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        ticket.creatorId = user.id;
        await safeSave(() => ticket.save(), 'ticket save');
        return interaction.reply({ content: `✅ Ticket ownership transferred to ${userDisplay(user)}.` });
      }
      if (cmd === 'ticket-reopen') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        ticket.status = 'open';
        ticket.closedAt = null;
        ticket.archivedAt = null;
        await safeSave(() => ticket.save(), 'ticket save');
        await interaction.channel.permissionOverwrites.edit(ticket.creatorId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        return interaction.reply({ content: '🔓 Ticket reopened.' });
      }
      if (cmd === 'ticket-archive') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        ticket.status = 'archived';
        ticket.archivedAt = new Date();
        await safeSave(() => ticket.save(), 'ticket save');
        await interaction.channel.permissionOverwrites.edit(ticket.creatorId, { SendMessages: false }).catch(() => {});
        for (const rid of cfg.tickets.supportRoleIds) {
          await interaction.channel.permissionOverwrites.edit(rid, { SendMessages: false }).catch(() => {});
        }
        return interaction.reply({ content: '📦 Ticket archived (read-only).' });
      }
      if (cmd === 'ticket-delete') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: '🗑️ Deleting this ticket in 5 seconds...' });
        const transcriptText = await buildTranscript(interaction.channel).catch(() => '(failed to build transcript)');
        const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: `transcript-${ticket.number || interaction.channel.id}.txt` });
        if (cfg.tickets.logChannelId) {
          const logCh = interaction.guild.channels.cache.get(cfg.tickets.logChannelId);
          if (logCh) await logCh.send({ content: `🗑️ Ticket #${ticket.number} deleted by ${userDisplay(interaction.user)}.`, files: [attachment] }).catch(() => {});
        }
        await safeSave(() => TicketModel.deleteOne({ _id: ticket._id }), 'ticket delete');
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }
      if (cmd === 'ticket-info') {
        const embed = new EmbedBuilder()
          .setTitle(`🎫 Ticket #${ticket.number}`)
          .setColor(hexToInt(cfg.tickets.panelColor))
          .addFields(
            { name: 'Status', value: ticket.status, inline: true },
            { name: 'Priority', value: ticket.priority, inline: true },
            { name: 'Type', value: ticket.typeLabel, inline: true },
            { name: 'Creator', value: `<@${ticket.creatorId}>`, inline: true },
            { name: 'Claimed by', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : '*unclaimed*', inline: true },
            { name: 'Staff added', value: ticket.staffMembers.length ? ticket.staffMembers.map(id => `<@${id}>`).join(', ') : '*none*', inline: true },
            { name: 'Created', value: `<t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`, inline: true },
            { name: 'Reason', value: ticket.reason || '*none given*', inline: false },
            { name: 'Notes', value: ticket.notes.length ? ticket.notes.map(n => `• ${n.text} — <@${n.authorId}>`).join('\n').slice(0, 1024) : '*none*', inline: false },
          );
        if (ticket.rating != null) {
          embed.addFields({ name: 'Rating', value: `${'⭐'.repeat(ticket.rating)}${ticket.ratingFeedback ? `\n${ticket.ratingFeedback}` : ''}`, inline: false });
        }
        return interaction.reply({ embeds: [embed] });
      }
      return;
    }

    if (cmd === 'welcome') {
      if (!isAdmin(member)) {
        return interaction.reply({ content: '❌ You do not have permission to configure the welcomer.', flags: MessageFlags.Ephemeral });
      }
      const action = interaction.options.getString('action');
      if (action === 'disable') {
        cfg.welcome.enabled = false;
        await saveConfig(guildId);
        return interaction.reply({ content: '✅ Welcome messages have been disabled.', flags: MessageFlags.Ephemeral });
      }
      if (action === 'setup') {
        const channel = interaction.options.getChannel('channel');
        if (!channel || !channel.isTextBased()) return interaction.reply({ content: '❌ Select a text channel with the channel option.', flags: MessageFlags.Ephemeral });
        const message = interaction.options.getString('message');
        const title = interaction.options.getString('title');
        const color = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const embed = interaction.options.getBoolean('embed');
        const dm = interaction.options.getBoolean('dm');
        const dmMessage = interaction.options.getString('dm_message');
        if (color !== null && !/^#[0-9A-Fa-f]{6}$/.test(color)) return interaction.reply({ content: '❌ Color must be a hex value like #57F287.', flags: MessageFlags.Ephemeral });
        cfg.welcome.enabled = true;
        cfg.welcome.channelId = channel.id;
        if (message !== null) cfg.welcome.message = message;
        if (title !== null) cfg.welcome.title = title;
        if (color !== null) cfg.welcome.color = color;
        if (image !== null) cfg.welcome.image = isValidUrl(image) ? image : null;
        if (thumbnail !== null) cfg.welcome.thumbnail = isValidUrl(thumbnail) ? thumbnail : null;
        if (embed !== null) cfg.welcome.embedEnabled = embed;
        if (dm !== null) cfg.welcome.dmEnabled = dm;
        if (dmMessage !== null) cfg.welcome.dmMessage = dmMessage;
        await saveConfig(guildId);
        return interaction.reply({ content: `✅ Welcomer configured in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      }
      if (action === 'test') {
        if (!cfg.welcome.enabled || !cfg.welcome.channelId) return interaction.reply({ content: '❌ Configure the welcomer first with /welcome action:Setup.', flags: MessageFlags.Ephemeral });
        const sent = await sendWelcomeMessage(member, cfg);
        if (cfg.welcome.dmEnabled) await safeDM(member.user, { content: replaceWelcomePlaceholders(cfg.welcome.dmMessage, member) });
        return interaction.reply({ content: sent ? '✅ Test welcome sent.' : '❌ Could not send the test welcome. Check the channel and bot permissions.', flags: MessageFlags.Ephemeral });
      }
    }

    if (cmd === 'promotion') {
      if (!isSHR(member, cfg) && !isHR(member, cfg)) {
        return interaction.reply({ content: '❌ You need a configured SHR or HR role to request a promotion.', flags: MessageFlags.Ephemeral });
      }

      const targetUser = interaction.options.getUser('member');
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

      const department = interaction.options.getString('department').trim();
      const currentRole = interaction.options.getRole('current_rank');
      const newRole = interaction.options.getRole('new_rank');
      const promotionType = interaction.options.getString('type');
      const reason = interaction.options.getString('reason').trim();

      if (!currentRole || !newRole) {
        return interaction.reply({ content: '❌ Both ranks must be valid Discord roles.', flags: MessageFlags.Ephemeral });
      }

      const cocRanks = cfg.coc?.ranks || [];
      const currentIndex = cocRanks.findIndex(r => r.roleId === currentRole.id);
      const newIndex = cocRanks.findIndex(r => r.roleId === newRole.id);

      if (promotionType === 'coc') {
        if (currentIndex === -1 || newIndex === -1) {
          return interaction.reply({
            content: '❌ For a **CoC** promotion, both the current and new rank must be configured in **/setup → Chain of Command**.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (newIndex >= currentIndex) {
          return interaction.reply({
            content: '❌ The new rank must be higher than the current rank according to the configured Chain of Command.',
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      if (!targetMember.roles.cache.has(currentRole.id)) {
        return interaction.reply({
          content: `❌ ${targetUser} does not currently have the selected **${currentRole.name}** role.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!isSHR(member, cfg)) {
        const request = await postStaffRequest(interaction.guild, cfg, { kind: 'promotion', action: 'promotion', requesterId: interaction.user.id, payload: {
          targetUserId: targetUser.id, department, currentRoleId: currentRole.id, newRoleId: newRole.id, promotionType, reason,
        } });
        return interaction.reply({ content: `✅ Promotion request submitted for SHR approval (request ${request._id.toString().slice(-6)}).`, flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setTitle('NYLRP | Promotion')
        .setColor(promotionType === 'coc' ? 0x5865F2 : 0x57F287)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Department', value: department, inline: true },
          { name: 'Promotion Type', value: promotionType === 'coc' ? 'CoC' : 'Overig', inline: true },
          { name: 'Previous Rank', value: `<@&${currentRole.id}>`, inline: true },
          { name: 'New Rank', value: `<@&${newRole.id}>`, inline: true },
          { name: 'Reason', value: reason.slice(0, 1024), inline: false },
          { name: 'Promoted by', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'NYLRP Promotion System' });

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (cmd === 'staffrank') {
      const target = interaction.options.getUser('user') || interaction.user;
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
      const level = getStaffLevel(targetMember, cfg);
      const levelNames = { 0: '❌ Not staff', 1: '🟢 Level 1 — Base staff', 2: '🟡 Level 2 — Senior staff', 3: '🔴 Level 3 — Full clearance (or admin)' };
      const allowed = Object.entries(COMMAND_LEVELS).filter(([, lvl]) => lvl <= level).map(([c]) => `\`/${c}\``);
      const embed = new EmbedBuilder()
        .setTitle(`🎖️ Staff Rank — ${userDisplay(target)}`)
        .setColor(0x5865F2)
        .addFields(
          { name: 'Clearance', value: levelNames[level] || levelNames[0] },
          { name: 'Commands Available', value: allowed.length ? allowed.join(', ') : '*none*' },
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'staff') {
      if (!isModerator(member, cfg)) return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildMembers = await interaction.guild.members.fetch().catch(() => new Map());
      const staffList = [...guildMembers.values()]
        .map(m => ({ member: m, level: getStaffLevel(m, cfg) }))
        .filter(x => x.level > 0)
        .sort((a, b) => b.level - a.level);
      if (!staffList.length) return interaction.editReply({ content: 'No staff roles are configured yet. Set them up via **/setup → Moderation**.' });
      const emoji = { 1: '🟢', 2: '🟡', 3: '🔴' };
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Staff Hierarchy')
        .setColor(0x5865F2)
        .setDescription(staffList.map(x => `${emoji[x.level] || '⚪'} **Level ${x.level}** — ${userDisplay(x.member.user)}`).join('\n').slice(0, 4000));
      return interaction.editReply({ embeds: [embed] });
    }

    // Case management commands
    if (cmd.startsWith('case-')) {
      const caseNumber = interaction.options.getInteger('number');
      const systemKey = cmd === 'case-create' ? interaction.options.getString('system') : null;
      if (cmd === 'case-create') {
        const sys = cfg.caseManagement.systems[systemKey];
        if (!sys?.channelId) return interaction.reply({ content: '❌ This case system has no channel configured in /setup → Case Management.', flags: MessageFlags.Ephemeral });
        const allowed = isOwner(member) || hasAnyConfiguredRole(member, sys.createRoleIds);
        if (!allowed) return interaction.reply({ content: '❌ You are not allowed to create cases in this system.', flags: MessageFlags.Ephemeral });
        const channel = interaction.guild.channels.cache.get(sys.channelId);
        if (!channel) return interaction.reply({ content: '❌ Configured case channel not found.', flags: MessageFlags.Ephemeral });
        const next = await CaseFileModel.findOne({ guildId, system: systemKey }).sort({ number: -1 }).select('number').lean();
        const number = (next?.number || 0) + 1;
        const reporter = interaction.options.getUser('reporting_party');
        const reported = interaction.options.getUser('reported_party');
        const reason = interaction.options.getString('reason');
        const embed = new EmbedBuilder().setTitle(`${sys.label} | Case #${number}`).setColor(0x5865F2).addFields(
          { name: 'Reporting Party', value: `<@${reporter.id}>`, inline: true },
          { name: 'Reported Party', value: `<@${reported.id}>`, inline: true },
          { name: 'Reason', value: reason },
          { name: 'Status', value: 'Open', inline: true },
          { name: 'User Investigating', value: '*Not assigned*', inline: true },
          { name: 'Supervisor+ Investigating', value: '*Not assigned*', inline: true },
          { name: 'Both Sides of the Story', value: '*Pending*' },
          { name: 'Notes', value: '*No notes yet*' },
        ).setFooter({ text: `Created by ${interaction.user.id}` }).setTimestamp();
        const pingIds = sys.pingRoleIds || [];
        const starter = await channel.send({ content: pingIds.map(x => `<@&${x}>`).join(' ') || undefined, embeds: [embed], allowedMentions: { roles: pingIds } });
        const thread = await starter.startThread({ name: `case-${String(number).padStart(4,'0')}-${reported.username}`.slice(0, 100), autoArchiveDuration: 10080 });
        const record = await CaseFileModel.create({ guildId, number, system: systemKey, channelId: channel.id, threadId: thread.id, reportingPartyId: reporter.id, reportedPartyId: reported.id, reason, createdBy: interaction.user.id, nextNumberKey: `${guildId}:${systemKey}` });
        await interaction.reply({ content: `✅ Case #${number} created: <#${thread.id}>.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const record = await CaseFileModel.findOne({ guildId, number: caseNumber || interaction.options.getInteger('number') });
      if (!record) return interaction.reply({ content: '❌ Case not found.', flags: MessageFlags.Ephemeral });
      const sys = cfg.caseManagement.systems[record.system] || {};
      const hasAccess = isOwner(member) || hasAnyConfiguredRole(member, [...(sys.accessRoleIds || []), ...(sys.investigatorRoleIds || []), ...(sys.supervisorRoleIds || []), ...(sys.createRoleIds || [])]) || record.createdBy === interaction.user.id;
      if (!hasAccess) return interaction.reply({ content: '❌ You do not have access to this case.', flags: MessageFlags.Ephemeral });
      if (cmd === 'case-status') {
        record.status = interaction.options.getString('status'); await record.save();
        const thread = await interaction.guild.channels.fetch(record.threadId).catch(() => null);
        if (thread) await thread.send(`📊 Case status updated to **${record.status}** by <@${interaction.user.id}>.`);
        return interaction.reply({ content: `✅ Case #${record.number} status: ${record.status}.`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'case-note') {
        const note = interaction.options.getString('note');
        record.notes.push({ authorId: interaction.user.id, text: note, createdAt: new Date() }); await record.save();
        const thread = await interaction.guild.channels.fetch(record.threadId).catch(() => null);
        if (thread) await thread.send(`📝 **Case note by <@${interaction.user.id}>:** ${note}`);
        return interaction.reply({ content: `✅ Note added to case #${record.number}.`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'case-close' || cmd === 'case-reopen') {
        record.status = cmd === 'case-close' ? 'Closed' : 'Open';
        record.closedAt = cmd === 'case-close' ? new Date() : null; await record.save();
        const thread = await interaction.guild.channels.fetch(record.threadId).catch(() => null);
        if (thread) { await thread.send(`📁 Case ${cmd === 'case-close' ? 'closed' : 'reopened'} by <@${interaction.user.id}>. Record retained.`); if (cmd === 'case-close') await thread.setArchived(true).catch(() => {}); else await thread.setArchived(false).catch(() => {}); }
        return interaction.reply({ content: `✅ Case #${record.number} ${cmd === 'case-close' ? 'closed' : 'reopened'}; record retained.`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'case-infraction') {
        const user = interaction.options.getUser('user');
        const action = interaction.options.getString('action');
        const reason = interaction.options.getString('reason');
        const duration = interaction.options.getInteger('duration');
        const role = interaction.options.getRole('role');
        if (action === 'demotion' && !role) return interaction.reply({ content: 'A role is required for demotion.', flags: MessageFlags.Ephemeral });
        if (['mute','tempban'].includes(action) && !duration) return interaction.reply({ content: 'A duration is required for this action.', flags: MessageFlags.Ephemeral });
        record.status = 'Awaiting Approval'; await record.save();
        const request = await postStaffRequest(interaction.guild, cfg, { kind: 'disciplinary', action, requesterId: interaction.user.id, caseNumber: record.number, payload: { userId: user.id, reason, minutes: action === 'mute' ? duration : undefined, hours: action === 'tempban' ? duration : undefined, roleId: role?.id, caseNumber: record.number } });
        const thread = await interaction.guild.channels.fetch(record.threadId).catch(() => null);
        if (thread) await thread.send(`⚖️ Proposed ${action} for <@${user.id}>; awaiting SHR approval. Request ${request._id}.`);
        return interaction.reply({ content: `✅ Infraction proposal sent for SHR approval (request ${request._id.toString().slice(-6)}).`, flags: MessageFlags.Ephemeral });
      }
    }

    // ── Moderation commands ──
    if (['warn', 'warnings', 'clearwarnings', 'note', 'notes', 'mute', 'unmute', 'kick', 'ban', 'unban', 'softban', 'tempban', 'clear', 'slowmode', 'lock', 'unlock', 'nickname', 'removerole', 'giveroles'].includes(cmd)) {
      if (!isModerator(member, cfg)) {
        return interaction.reply({ content: '❌ You do not have permission to use moderation commands.', flags: MessageFlags.Ephemeral });
      }
      if (!hasCommandClearance(member, cfg, cmd)) {
        const required = COMMAND_LEVELS[cmd] || 1;
        return interaction.reply({ content: `❌ Your staff rank doesn't have clearance for \`/${cmd}\` (requires level ${required}). Ask an admin to grant your role via **/setup → Moderation**.`, flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'warn') {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        const created = await safeCreate(WarningModel, { guildId, userId: user.id, moderatorId: interaction.user.id, reason }, 'warning create');
        await safeDM(user, { content: `⚠️ You were warned in **${interaction.guild.name}**: ${reason}` });
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ Warning').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `⚠️ **${userDisplay(user)}** warned.${created ? '' : ' (⚠️ not saved to database — will not show in /warnings)'}` });
      }
      if (cmd === 'warnings') {
        const user = interaction.options.getUser('user');
        const list = await WarningModel.find({ guildId, userId: user.id }).sort({ createdAt: -1 }).limit(25);
        if (!list.length) return interaction.reply({ content: `${userDisplay(user)} has no warnings.`, flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`⚠️ Warnings for ${userDisplay(user)}`).setColor(0xFEE75C)
          .setDescription(list.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.moderatorId}> (<t:${Math.floor(w.createdAt.getTime() / 1000)}:R>)`).join('\n').slice(0, 4000));
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'clearwarnings') {
        const user = interaction.options.getUser('user');
        const { ok, result } = await safeSave(() => WarningModel.deleteMany({ guildId, userId: user.id }), 'clearwarnings');
        const deletedCount = ok ? result.deletedCount : 0;
        return interaction.reply({ content: ok ? `✅ Cleared ${deletedCount} warning(s) for ${userDisplay(user)}.` : '❌ Failed to clear warnings — database unavailable, try again shortly.' });
      }
      if (cmd === 'note') {
        const user = interaction.options.getUser('user');
        const text = interaction.options.getString('text');
        const created = await safeCreate(ModNoteModel, { guildId, userId: user.id, authorId: interaction.user.id, text }, 'mod note create');
        return interaction.reply({ content: `📝 Note added for ${userDisplay(user)}.${created ? '' : ' (⚠️ not saved to database)'}`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'notes') {
        const user = interaction.options.getUser('user');
        const list = await ModNoteModel.find({ guildId, userId: user.id }).sort({ createdAt: -1 }).limit(25);
        if (!list.length) return interaction.reply({ content: `No notes for ${userDisplay(user)}.`, flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`📝 Notes for ${userDisplay(user)}`).setColor(0x5865F2)
          .setDescription(list.map((n, i) => `**${i + 1}.** ${n.text} — <@${n.authorId}> (<t:${Math.floor(n.createdAt.getTime() / 1000)}:R>)`).join('\n').slice(0, 4000));
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'mute') {
        const user = interaction.options.getUser('user');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await target.timeout(minutes * 60000, reason).catch(e => { throw e; });
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xEB459E).setTitle('🔇 Muted').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Duration', value: `${minutes}m`, inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔇 **${userDisplay(user)}** muted for ${minutes} minute(s).` });
      }
      if (cmd === 'unmute') {
        const user = interaction.options.getUser('user');
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await target.timeout(null);
        return interaction.reply({ content: `🔊 **${userDisplay(user)}** unmuted.` });
      }
      if (cmd === 'kick') {
        if (!member.permissions.has(P.KickMembers)) return interaction.reply({ content: '❌ Kick Members permission required.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await safeDM(user, { content: `👢 You were kicked from **${interaction.guild.name}**: ${reason}` });
        await target.kick(reason);
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xED4245).setTitle('👢 Kicked').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `👢 **${userDisplay(user)}** kicked.` });
      }
      if (cmd === 'ban') {
        if (!member.permissions.has(P.BanMembers)) return interaction.reply({ content: '❌ Ban Members permission required.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
        await safeDM(user, { content: `🔨 You were banned from **${interaction.guild.name}**: ${reason}` });
        await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xED4245).setTitle('🔨 Banned').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔨 **${userDisplay(user)}** banned.` });
      }
      if (cmd === 'unban') {
        if (!member.permissions.has(P.BanMembers)) return interaction.reply({ content: '❌ Ban Members permission required.', flags: MessageFlags.Ephemeral });
        const userId = interaction.options.getString('userid');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await interaction.guild.members.unban(userId, reason).catch(e => { throw e; });
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0x57F287).setTitle('🔓 Unbanned').addFields(
          { name: 'User ID', value: userId, inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔓 <@${userId}> unbanned.` });
      }
      if (cmd === 'softban') {
        if (!member.permissions.has(P.BanMembers)) return interaction.reply({ content: '❌ Ban Members permission required.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await safeDM(user, { content: `🔨 You were softbanned from **${interaction.guild.name}**: ${reason}` });
        await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds: 86400 });
        await interaction.guild.members.unban(user.id, 'Softban').catch(() => {});
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xED4245).setTitle('🔨 Softbanned').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔨 **${userDisplay(user)}** softbanned (messages purged, user can rejoin).` });
      }
      if (cmd === 'tempban') {
        if (!member.permissions.has(P.BanMembers)) return interaction.reply({ content: '❌ Ban Members permission required.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const hours = interaction.options.getInteger('hours');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const unbanAt = new Date(Date.now() + hours * 3600000);
        await safeDM(user, { content: `🔨 You were temporarily banned from **${interaction.guild.name}** for ${hours}h: ${reason}` });
        await interaction.guild.members.ban(user.id, { reason });
        const { ok } = await safeSave(() => TempBanModel.findOneAndUpdate(
          { guildId, userId: user.id },
          { guildId, userId: user.id, moderatorId: interaction.user.id, reason, unbanAt },
          { upsert: true },
        ), 'tempban record');
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xED4245).setTitle('🔨 Temp-banned').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Duration', value: `${hours}h`, inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔨 **${userDisplay(user)}** temp-banned for ${hours} hour(s).${ok ? ' The unban is stored in MongoDB, so it will still fire even if the bot restarts.' : ' ⚠️ Could not save the auto-unban record — you will need to /unban them manually.'}` });
      }
      if (cmd === 'clear') {
        const amount = interaction.options.getInteger('amount');
        const filterUser = interaction.options.getUser('user');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const fetched = await interaction.channel.messages.fetch({ limit: amount });
        const toDelete = filterUser ? fetched.filter(m => m.author.id === filterUser.id) : fetched;
        const deleted = await interaction.channel.bulkDelete(toDelete, true).catch(() => null);
        return interaction.editReply({ content: `🧹 Deleted ${deleted ? deleted.size : 0} message(s).` });
      }
      if (cmd === 'slowmode') {
        const seconds = interaction.options.getInteger('seconds');
        await interaction.channel.setRateLimitPerUser(seconds);
        return interaction.reply({ content: seconds === 0 ? '✅ Slowmode disabled.' : `✅ Slowmode set to ${seconds}s.` });
      }
      if (cmd === 'lock') {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        return interaction.reply({ content: `🔒 <#${channel.id}> locked.` });
      }
      if (cmd === 'unlock') {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
        return interaction.reply({ content: `🔓 <#${channel.id}> unlocked.` });
      }
      if (cmd === 'nickname') {
        const user = interaction.options.getUser('user');
        const nickname = interaction.options.getString('nickname');
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await target.setNickname(nickname || null);
        return interaction.reply({ content: nickname ? `✅ Nickname for ${userDisplay(user)} set to \`${nickname}\`.` : `✅ Nickname for ${userDisplay(user)} reset.` });
      }
      if (cmd === 'removerole') {
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await target.roles.remove(role.id).catch(e => { throw e; });
        return interaction.reply({ content: `✅ Removed <@&${role.id}> from ${userDisplay(user)}.` });
      }
      if (cmd === 'giveroles') {
        const user = interaction.options.getUser('user');
        const roleIds = parseRoleOrUserIds(interaction.options.getString('roles'));
        if (!roleIds.length) return interaction.reply({ content: '❌ No valid role IDs/mentions found.', flags: MessageFlags.Ephemeral });
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const validRoles = roleIds.filter(id => interaction.guild.roles.cache.has(id));
        await target.roles.add(validRoles).catch(e => { throw e; });
        return interaction.reply({ content: `✅ Added ${validRoles.length} role(s) to ${userDisplay(user)}.` });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err?.message ?? err);
    console.error('  customId:', interaction.customId ?? interaction.commandName ?? '(no id)');
    console.error('  stack:', err?.stack);
    try {
      const msg = { content: `❌ Something went wrong: \`${err?.message?.slice(0, 100) ?? 'unknown error'}\``, flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

// ════════════════════════════════════════════
// HEALTHCHECK SERVER
// ════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('Bot is running'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', discordReady: client.isReady?.() ?? false, dbReady, uptimeSeconds: process.uptime() }));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on port ${PORT}`));

// ════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ════════════════════════════════════════════
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => { console.error('❌ Uncaught Exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); });

// ════════════════════════════════════════════
// START
// ════════════════════════════════════════════
(async () => {
  if (!process.env.TOKEN) {
    console.error('❌ FATAL: TOKEN environment variable is not set.');
    process.exit(1);
  }
  await connectDB();
  await client.login(process.env.TOKEN);
})();