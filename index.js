require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  AttachmentBuilder, MessageFlags,
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
      type: [{ id: String, label: String, emoji: String, description: String, image: String, thumbnail: String }],
      default: [{ id: 'general', label: 'General Support', emoji: '🎫', description: 'General questions or help', image: null, thumbnail: null }],
    },
    nextNumber: { type: Number, default: 1 },
  },
  moderation: {
    modRoleIds:      { type: [String], default: [] },
    modLogChannelId: { type: String, default: null },
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
      types: [{ id: 'general', label: 'General Support', emoji: '🎫', description: 'General questions or help', image: null, thumbnail: null }],
      nextNumber: 1,
    },
    moderation: { modRoleIds: [], modLogChannelId: null },
  };
}

async function getConfig(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId);
  let doc = null;
  try { doc = await GuildConfigModel.findById(guildId).lean(); } catch (e) { console.error('getConfig error:', e.message); }
  const cfg = doc ? { ...defaultConfig(guildId), ...doc, tickets: { ...defaultConfig(guildId).tickets, ...(doc.tickets || {}) }, moderation: { ...defaultConfig(guildId).moderation, ...(doc.moderation || {}) } }
                  : defaultConfig(guildId);
  configCache.set(guildId, cfg);
  return cfg;
}

async function saveConfig(guildId) {
  const cfg = configCache.get(guildId);
  if (!cfg || !dbReady) return;
  try {
    await GuildConfigModel.findByIdAndUpdate(guildId, { $set: { tickets: cfg.tickets, moderation: cfg.moderation } }, { upsert: true });
  } catch (e) { console.error('saveConfig error:', e.message); }
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

function isTicketStaff(member, cfg) {
  if (isAdmin(member)) return true;
  return cfg.tickets.supportRoleIds.some(rid => member.roles.cache.has(rid));
}

function isModerator(member, cfg) {
  if (isAdmin(member)) return true;
  return cfg.moderation.modRoleIds.some(rid => member.roles.cache.has(rid));
}

async function safeDM(user, payload) {
  try { const dm = await user.createDM(); await dm.send(payload); return true; } catch { return false; }
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

async function createTicketChannel(interaction, typeId, cfg) {
  const guild = interaction.guild;
  const user = interaction.user;
  const type = cfg.tickets.types.find(t => t.id === typeId) ?? { id: typeId, label: 'Support', emoji: '🎫' };

  // Prevent duplicate open tickets of the same type for this user
  const existing = await TicketModel.findOne({ guildId: guild.id, creatorId: user.id, status: 'open' });
  if (existing) {
    const payload = { content: `❌ You already have an open ticket: <#${existing.channelId}>`, flags: MessageFlags.Ephemeral };
    return interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
  }

  const category = cfg.tickets.categoryId ? guild.channels.cache.get(cfg.tickets.categoryId) : null;
  const perms = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  for (const rid of cfg.tickets.supportRoleIds) {
    perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  }

  const number = cfg.tickets.nextNumber || 1;
  cfg.tickets.nextNumber = number + 1;
  await saveConfig(guild.id);

  const ticketCh = await guild.channels.create({
    name: `ticket-${String(number).padStart(4, '0')}-${user.username}`.toLowerCase().slice(0, 90),
    type: ChannelType.GuildText,
    parent: category ?? null,
    permissionOverwrites: perms,
    topic: `Ticket #${number} by ${userDisplay(user)} | ${type.label}`,
  });

  await TicketModel.create({
    guildId: guild.id,
    channelId: ticketCh.id,
    number,
    creatorId: user.id,
    typeId: type.id,
    typeLabel: type.label,
    staffMembers: [],
  }).catch(() => {});

  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`${type.emoji || '🎫'} Ticket #${number} — ${type.label}`)
    .setDescription(`Hello <@${user.id}>, thank you for opening a ticket!\nSupport will be with you shortly.\n\n**Type:** ${type.label}`)
    .setColor(hexToInt(cfg.tickets.panelColor))
    .setTimestamp()
    .setFooter({ text: `Opened by ${userDisplay(user)}` });
  if (isValidUrl(type.image)) welcomeEmbed.setImage(type.image);
  if (isValidUrl(type.thumbnail)) welcomeEmbed.setThumbnail(type.thumbnail);

  const pingContent = cfg.tickets.supportRoleIds.length
    ? `<@${user.id}>${cfg.tickets.supportRoleIds.map(id => ` <@&${id}>`).join('')}`
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
  await ticket.save().catch(() => {});

  await channel.permissionOverwrites.edit(ticket.creatorId, { SendMessages: false }).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔒 Ticket Closed')
    .addFields(
      { name: 'Closed by', value: userDisplay(interaction.user), inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: true },
    )
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
    await safeDM(creator.user, {
      content: `Your ticket in **${guild.name}** was closed.`,
      files: [attachment],
    }).catch(() => {});
  }
}

// ════════════════════════════════════════════
// SLASH COMMANDS
// ════════════════════════════════════════════
const P = PermissionFlagsBits;
const commands = [
  { name: 'ping', description: 'Check bot latency' },

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
      await TempBanModel.deleteOne({ _id: rec._id }).catch(() => {});
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
// INTERACTIONS
// ════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) await interaction.reply({ content: '❌ This bot only works in servers.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const guildId = interaction.guild.id;
    const cfg = await getConfig(guildId);

    // ───────── BUTTONS ─────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        await createTicketChannel(interaction, typeId, cfg);
        return;
      }

      if (id === 'tkt__claim') {
        const ticket = await TicketModel.findOne({ channelId: interaction.channel.id });
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', flags: MessageFlags.Ephemeral });
        if (!isTicketStaff(interaction.member, cfg)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        if (ticket.claimedBy) return interaction.reply({ content: `❌ Already claimed by <@${ticket.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        ticket.claimedBy = interaction.user.id;
        if (!ticket.staffMembers.includes(interaction.user.id)) ticket.staffMembers.push(interaction.user.id);
        await ticket.save();
        await interaction.update({ components: [buildTicketControlRow(true)] }).catch(() => {});
        await interaction.followUp({ content: `🙋 Ticket claimed by ${userDisplay(interaction.user)}.` }).catch(() => {});
        return;
      }

      if (id === 'tkt__close') {
        const ticket = await TicketModel.findOne({ channelId: interaction.channel.id });
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel.', flags: MessageFlags.Ephemeral });
        if (!isTicketStaff(interaction.member, cfg) && interaction.user.id !== ticket.creatorId) {
          return interaction.reply({ content: '❌ Staff or the ticket owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        await closeTicket(interaction, ticket, cfg, 'Closed via button');
        return;
      }
      return;
    }

    // ───────── SELECT MENUS ─────────
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'tkt__opensel') {
        const typeId = interaction.values[0];
        await createTicketChannel(interaction, typeId, cfg);
        return;
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

    // ── Ticket management commands ──
    if (cmd.startsWith('ticket-')) {
      const ticket = await requireTicketChannel(interaction);
      if (!ticket) return;
      const staff = isTicketStaff(member, cfg);

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
        await ticket.save();
        return interaction.reply({ content: `🙋 Ticket claimed by ${userDisplay(interaction.user)}.` });
      }
      if (cmd === 'ticket-add') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        if (!ticket.staffMembers.includes(user.id)) { ticket.staffMembers.push(user.id); await ticket.save(); }
        return interaction.reply({ content: `✅ Added ${userDisplay(user)} to this ticket.` });
      }
      if (cmd === 'ticket-remove') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
        ticket.staffMembers = ticket.staffMembers.filter(id => id !== user.id);
        await ticket.save();
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
        await ticket.save();
        return interaction.reply({ content: `✅ Priority set to **${ticket.priority}**.` });
      }
      if (cmd === 'ticket-note') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const text = interaction.options.getString('text');
        ticket.notes.push({ authorId: interaction.user.id, text, createdAt: new Date() });
        await ticket.save();
        return interaction.reply({ content: '📝 Note added (staff only visibility is not enforced by channel perms — keep sensitive notes elsewhere).', flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'ticket-transfer') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        ticket.creatorId = user.id;
        await ticket.save();
        return interaction.reply({ content: `✅ Ticket ownership transferred to ${userDisplay(user)}.` });
      }
      if (cmd === 'ticket-reopen') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        ticket.status = 'open';
        ticket.closedAt = null;
        ticket.archivedAt = null;
        await ticket.save();
        await interaction.channel.permissionOverwrites.edit(ticket.creatorId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        return interaction.reply({ content: '🔓 Ticket reopened.' });
      }
      if (cmd === 'ticket-archive') {
        if (!staff) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        ticket.status = 'archived';
        ticket.archivedAt = new Date();
        await ticket.save();
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
        await TicketModel.deleteOne({ _id: ticket._id }).catch(() => {});
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
            { name: 'Notes', value: ticket.notes.length ? ticket.notes.map(n => `• ${n.text} — <@${n.authorId}>`).join('\n').slice(0, 1024) : '*none*', inline: false },
          );
        return interaction.reply({ embeds: [embed] });
      }
      return;
    }

    // ── Moderation commands ──
    if (['warn', 'warnings', 'clearwarnings', 'note', 'notes', 'mute', 'unmute', 'kick', 'ban', 'unban', 'softban', 'tempban', 'clear', 'slowmode', 'lock', 'unlock', 'nickname', 'removerole', 'giveroles'].includes(cmd)) {
      if (!isModerator(member, cfg)) {
        return interaction.reply({ content: '❌ You do not have permission to use moderation commands.', flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'warn') {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        await WarningModel.create({ guildId, userId: user.id, moderatorId: interaction.user.id, reason });
        await safeDM(user, { content: `⚠️ You were warned in **${interaction.guild.name}**: ${reason}` });
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ Warning').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Moderator', value: userDisplay(interaction.user), inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `⚠️ **${userDisplay(user)}** warned.` });
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
        const { deletedCount } = await WarningModel.deleteMany({ guildId, userId: user.id });
        return interaction.reply({ content: `✅ Cleared ${deletedCount} warning(s) for ${userDisplay(user)}.` });
      }
      if (cmd === 'note') {
        const user = interaction.options.getUser('user');
        const text = interaction.options.getString('text');
        await ModNoteModel.create({ guildId, userId: user.id, authorId: interaction.user.id, text });
        return interaction.reply({ content: `📝 Note added for ${userDisplay(user)}.`, flags: MessageFlags.Ephemeral });
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
        await TempBanModel.findOneAndUpdate(
          { guildId, userId: user.id },
          { guildId, userId: user.id, moderatorId: interaction.user.id, reason, unbanAt },
          { upsert: true },
        );
        await logModAction(interaction.guild, cfg, new EmbedBuilder().setColor(0xED4245).setTitle('🔨 Temp-banned').addFields(
          { name: 'User', value: userDisplay(user), inline: true }, { name: 'Duration', value: `${hours}h`, inline: true }, { name: 'Reason', value: reason },
        ).setTimestamp());
        return interaction.reply({ content: `🔨 **${userDisplay(user)}** temp-banned for ${hours} hour(s). The unban is stored in MongoDB, so it will still fire even if the bot restarts.` });
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
