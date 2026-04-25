require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Keep Render alive ──
http.createServer((req, res) => res.end('Bot is running!')).listen(process.env.PORT || 10000);

process.chdir(path.dirname(require.main.filename));

// ════════════════════════════════════════════
// CLIENT
// ════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load config:', e); }
  return {};
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('Failed to save config:', e); }
}

let config = loadConfig();

function getGuildConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  return config[guildId];
}

function getTicketConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticket) gc.ticket = {
    pingRoles: [], transcriptChannel: null, ticketChannel: null,
    ticketCategory: null, panelTitle: '🎫 Support Tickets',
    panelDescription: 'Click a button below to open a support ticket.',
    panelColor: '#5865F2', panelThumbnail: null,
    welcomeText: 'Hello {user}, thank you for opening a ticket!', ticketTypes: [],
  };
  return gc.ticket;
}

function getSessionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.session) gc.session = {
    channel: null, pingRoles: [], allowedRoles: [], joinLink: null,
    startImage: null, startDescription: null, voteImage: null,
    voteDescription: null, shutdownImage: null, shutdownDescription: null,
  };
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

// Warnings storage
function getWarnings(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  if (!gc.warnings[userId]) gc.warnings[userId] = [];
  return gc.warnings[userId];
}

function addWarning(guildId, userId, warn) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  if (!gc.warnings[userId]) gc.warnings[userId] = [];
  gc.warnings[userId].push(warn);
  saveConfig(config);
}

function clearWarnings(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.warnings) gc.warnings = {};
  gc.warnings[userId] = [];
  saveConfig(config);
}

// Notes storage
function getNotes(guildId, userId) {
  const gc = getGuildConfig(guildId);
  if (!gc.notes) gc.notes = {};
  if (!gc.notes[userId]) gc.notes[userId] = [];
  return gc.notes[userId];
}

function addNote(guildId, userId, note) {
  const gc = getGuildConfig(guildId);
  if (!gc.notes) gc.notes = {};
  if (!gc.notes[userId]) gc.notes[userId] = [];
  gc.notes[userId].push(note);
  saveConfig(config);
}

// ════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════
const STAFF_ROLE      = '《 𝑵𝒀𝑳𝑹𝑷 | Staff Team》';
const SHR_ROLE        = 'SHR';
const WELCOME_CHANNEL = 'welcome';
const LOGO_URL        = 'https://cdn.discordapp.com/attachments/1363047391263064166/1484556795321122917/image.png';

const hasStaff    = m => m.roles.cache.some(r => r.name === STAFF_ROLE);
const hasSHR      = m => m.roles.cache.some(r => r.name === SHR_ROLE);
const hasAnyStaff = m => hasStaff(m) || hasSHR(m);

function canRunSession(member, guildId) {
  if (hasSHR(member)) return true;
  const sc = getSessionConfig(guildId);
  if (!sc.allowedRoles?.length) return hasAnyStaff(member);
  return sc.allowedRoles.some(id => member.roles.cache.has(id));
}

const openTickets      = new Map();
const srPendingRoleAdd = new Map();

// ════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════
function genId() { return Math.random().toString(36).slice(2, 8); }

function hexToInt(hex) {
  if (!hex) return 0x5865F2;
  const val = parseInt(hex.replace('#', ''), 16);
  return isNaN(val) ? 0x5865F2 : val;
}

function colorToButtonStyle(color) {
  if (!color) return ButtonStyle.Secondary;
  const c = color.toLowerCase().trim();
  if (c === 'green'  || c === 'success') return ButtonStyle.Success;
  if (c === 'red'    || c === 'danger')  return ButtonStyle.Danger;
  if (c === 'grey'   || c === 'gray' || c === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}

function replaceVars(text, interaction) {
  if (!text) return text;
  const now = new Date();
  return text
    .replace(/{user}/g,        `<@${interaction.user.id}>`)
    .replace(/{host}/g,        interaction.user.username)
    .replace(/{hostMention}/g, `<@${interaction.user.id}>`)
    .replace(/{hostTag}/g,     interaction.user.tag)
    .replace(/{time}/g,        now.toUTCString())
    .replace(/{date}/g,        now.toDateString())
    .replace(/{memberCount}/g, interaction.guild?.memberCount?.toString() ?? '')
    .replace(/{server}/g,      interaction.guild?.name ?? '');
}

function safeSetEmoji(btn, emoji) {
  if (!emoji || emoji === 'null' || emoji === 'undefined') return btn;
  try { btn.setEmoji(emoji); } catch {}
  return btn;
}

// ════════════════════════════════════════════
// ERLC API
// ════════════════════════════════════════════
const ERLC_BASE = 'https://api.policeroleplay.community/v1';

async function erlcRequest(p, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Server-Key': process.env.ERLC_API_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ERLC_BASE}${p}`, opts);
  if (!res.ok) throw new Error(`ERLC ${res.status}: ${res.statusText}`);
  return res.json();
}

// ════════════════════════════════════════════
// DROPDOWN HELPERS
// ════════════════════════════════════════════
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
// TICKET PANEL BUILDERS
// ════════════════════════════════════════════
function buildTicketPanelEmbed(tc) {
  const embed = new EmbedBuilder()
    .setTitle(tc.panelTitle || '🎫 Support Tickets')
    .setDescription(tc.panelDescription || 'Click a button below to open a ticket.')
    .setColor(hexToInt(tc.panelColor));
  if (tc.panelThumbnail) embed.setImage(tc.panelThumbnail); // ✅ FIX: setImage instead of setThumbnail
  return embed;
}

function buildTicketTypeButtons(ticketTypes) {
  const rows = [];
  for (let i = 0; i < Math.min(ticketTypes.length, 25); i += 5) {
    const chunk = ticketTypes.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(
      chunk.map(t => {
        const btn = new ButtonBuilder()
          .setCustomId(`tkt__open__${t.id}`)
          .setLabel(t.label.slice(0, 80))
          .setStyle(colorToButtonStyle(t.color));
        return safeSetEmoji(btn, t.emoji);
      })
    ));
  }
  return rows;
}

// ════════════════════════════════════════════
// TICKET SETUP PAYLOAD
// ════════════════════════════════════════════
function buildTicketSetupPayload(guildId) {
  const tc = getTicketConfig(guildId);
  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket System Setup').setColor(0x5865F2)
    .setDescription('Configure every aspect of the ticket system below.')
    .addFields(
      { name: '📢 Ping Roles',      value: tc.pingRoles.length ? tc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '📋 Transcript Ch.',  value: tc.transcriptChannel ? `<#${tc.transcriptChannel}>` : '*Not set*', inline: true },
      { name: '📬 Panel Channel',   value: tc.ticketChannel ? `<#${tc.ticketChannel}>` : '*Not set*', inline: true },
      { name: '📁 Category',        value: tc.ticketCategory ? `<#${tc.ticketCategory}>` : '*Not set*', inline: true },
      { name: '🎨 Panel Title',     value: tc.panelTitle || '*Not set*', inline: true },
      { name: '🖌️ Panel Color',     value: tc.panelColor || '*Not set*', inline: true },
      { name: '🖼️ Panel Image',     value: tc.panelThumbnail ? '✅ Set' : '❌ Not set', inline: true },
      { name: '💬 Welcome Text',    value: tc.welcomeText ? `\`\`\`${tc.welcomeText.slice(0, 150)}\`\`\`` : '*Not set*', inline: false },
      { name: '🏷️ Ticket Types',    value: tc.ticketTypes.length ? tc.ticketTypes.map(t => `${t.emoji || '•'} \`${t.label}\``).join('\n') : '*No types yet*', inline: false },
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
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_deploy').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'),
  );
  return { embeds: [embed], components: [r1, r2, r3], ephemeral: true };
}

// ════════════════════════════════════════════
// SESSION SETUP PAYLOAD
// ════════════════════════════════════════════
function buildSessionSetupPayload(guildId) {
  const sc = getSessionConfig(guildId);
  const embed = new EmbedBuilder()
    .setTitle('🎮 Session System Setup').setColor(0x57F287)
    .setDescription('**Variables:** `{host}` `{hostMention}` `{time}` `{date}` `{memberCount}` `{server}`')
    .addFields(
      { name: '📢 Channel',    value: sc.channel ? `<#${sc.channel}>` : '*Not set*', inline: true },
      { name: '👥 Ping Roles', value: sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔑 Allowed',    value: sc.allowedRoles?.length ? sc.allowedRoles.map(id => `<@&${id}>`).join(', ') : '*Not set*', inline: true },
      { name: '🔗 Join Link',  value: sc.joinLink ?? '*Not set*', inline: false },
      { name: '🟢 Start',      value: sc.startDescription ? `\`\`\`${sc.startDescription.slice(0, 150)}\`\`\`` : '*Not set*', inline: false },
      { name: '🗳️ Vote',       value: sc.voteDescription ? `\`\`\`${sc.voteDescription.slice(0, 150)}\`\`\`` : '*Not set*', inline: false },
      { name: '🔴 Shutdown',   value: sc.shutdownDescription ? `\`\`\`${sc.shutdownDescription.slice(0, 150)}\`\`\`` : '*Not set*', inline: false },
      { name: '🖼️ Images',     value: `Start: ${sc.startImage ? '✅' : '❌'} | Vote: ${sc.voteImage ? '✅' : '❌'} | Shutdown: ${sc.shutdownImage ? '✅' : '❌'}`, inline: false },
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
  );
  return { embeds: [embed], components: [r1, r2], ephemeral: true };
}

// ════════════════════════════════════════════
// ANNOUNCEMENT SETUP PAYLOAD
// ════════════════════════════════════════════
function buildAnnouncementOverview(guildId) {
  const ac = getAnnouncementConfig(guildId);
  const types = Object.entries(ac.types);
  const embed = new EmbedBuilder()
    .setTitle('📣 Announcement System Setup').setColor(0xED4245)
    .setDescription(types.length === 0
      ? '*No announcement types yet. Click **New Type** to create one.*'
      : types.map(([tid, t]) =>
          `**${t.emoji || '📢'} ${t.name}** \`[${tid}]\`\n` +
          `Channel: ${t.channel ? `<#${t.channel}>` : '❌'} | Ping: ${t.pingRole ? `<@&${t.pingRole}>` : 'None'} | Color: ${t.color || '#ED4245'}`
        ).join('\n\n')
    )
    .setFooter({ text: 'Use /announce <type> to send an announcement' });

  const btns = [new ButtonBuilder().setCustomId('an_new').setLabel('New Type').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (types.length) {
    btns.push(
      new ButtonBuilder().setCustomId('an_edit').setLabel('Edit Type').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('an_delete').setLabel('Delete Type').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], ephemeral: true };
}

function buildAnnouncementEditor(guildId, typeId) {
  const ac = getAnnouncementConfig(guildId);
  const t = ac.types[typeId];
  const embed = new EmbedBuilder()
    .setTitle(`✏️ Editing — ${t.emoji || '📢'} ${t.name}`).setColor(hexToInt(t.color))
    .addFields(
      { name: '📛 Name', value: t.name, inline: true },
      { name: '😀 Emoji', value: t.emoji || '*Not set*', inline: true },
      { name: '🎨 Color', value: t.color || '#ED4245', inline: true },
      { name: '📢 Channel', value: t.channel ? `<#${t.channel}>` : '*Not set*', inline: true },
      { name: '🔔 Ping Role', value: t.pingRole ? `<@&${t.pingRole}>` : '*None*', inline: true },
      { name: '📌 Title', value: t.title || '*Not set*', inline: false },
      { name: '📝 Description', value: t.description ? `\`\`\`${t.description.slice(0, 200)}\`\`\`` : '*Not set*', inline: false },
      { name: '🖼️ Image', value: t.image ? '✅ Set' : '❌ Not set', inline: true },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ane__content__${typeId}`).setLabel('Edit Content').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`ane__channel__${typeId}`).setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId(`ane__pingrole__${typeId}`).setLabel('Set Ping Role').setStyle(ButtonStyle.Primary).setEmoji('🔔'),
    new ButtonBuilder().setCustomId(`ane__clearping__${typeId}`).setLabel('Clear Ping').setStyle(ButtonStyle.Secondary).setEmoji('🚫'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('an__back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [r1, r2], ephemeral: true };
}

// ════════════════════════════════════════════
// SELFROLE OVERVIEW
// ════════════════════════════════════════════
function buildSelfRoleOverview(guildId) {
  const src = getSelfRoleConfig(guildId);
  const panels = Object.entries(src.panels);
  const embed = new EmbedBuilder()
    .setTitle('🎨 Self Role Setup').setColor(0xEB459E)
    .setDescription(panels.length === 0
      ? '*No panels yet. Click **New Panel** to create one.*'
      : panels.map(([pid, p]) => `**${p.title}** \`[${pid}]\` (${p.type || 'buttons'}) — ${p.roles.length} roles | ch: ${p.channel ? `<#${p.channel}>` : '❌'}`).join('\n'));

  const btns = [new ButtonBuilder().setCustomId('sr_new').setLabel('New Panel').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (panels.length) {
    btns.push(
      new ButtonBuilder().setCustomId('sr_edit').setLabel('Edit Panel').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('sr_delete').setLabel('Delete Panel').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)] };
}

// ════════════════════════════════════════════
// PANEL EDITOR
// ════════════════════════════════════════════
function buildPanelEditor(guildId, panelId) {
  const src = getSelfRoleConfig(guildId);
  const p = src.panels[panelId];
  const embed = new EmbedBuilder()
    .setTitle(`✏️ Editing — ${p.title}`).setColor(hexToInt(p.color))
    .addFields(
      { name: '📛 Title', value: p.title, inline: true },
      { name: '🎨 Color', value: p.color || '#EB459E', inline: true },
      { name: '🔀 Type', value: p.type || 'buttons', inline: true },
      { name: '📢 Channel', value: p.channel ? `<#${p.channel}>` : '*Not set*', inline: true },
      { name: '🔢 Max Roles', value: p.max != null ? (p.max === 0 ? 'Unlimited' : String(p.max)) : 'Unlimited', inline: true },
      { name: '📝 Description', value: p.description || '*Not set*', inline: false },
      { name: '🖼️ Thumbnail', value: p.thumbnail ? '✅ Set' : '❌ Not set', inline: true },
      { name: '🎭 Roles', value: p.roles.length ? p.roles.map(r => `${r.emoji || '•'} <@&${r.id}> — \`${r.label}\``).join('\n') : '*No roles yet*', inline: false },
    );
  if (p.thumbnail) embed.setThumbnail(p.thumbnail);

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
  return { embeds: [embed], components: [r1, r2] };
}

// ════════════════════════════════════════════
// DEPLOY SELFROLE PANEL
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
      .setCustomId(`srp__dd__${panelId}`).setPlaceholder('Choose your roles…')
      .setMinValues(0).setMaxValues(maxVals).addOptions(options);
    const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
    panel.messageId = msg.id;
    return;
  }

  // Button panel
  const rows = [];
  for (let i = 0; i < Math.min(panel.roles.length, 25); i += 5) {
    const chunk = panel.roles.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(
      chunk.map(r => {
        const btn = new ButtonBuilder()
          .setCustomId(`srp__btn__${panelId}__${r.id}`)
          .setLabel(r.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary);
        return safeSetEmoji(btn, r.emoji);
      })
    ));
  }
  const msg = await channel.send({ embeds: [embed], components: rows });
  panel.messageId = msg.id;
}

// ════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════
const commands = [
  // ── NORMAL COMMANDS ──
  { name: 'ping', description: 'Check bot latency' },
  { name: 'avatar', description: 'Show a user\'s avatar', options: [
    { name: 'user', type: 6, description: 'Who?', required: false },
  ]},
  { name: 'serverinfo', description: 'Show server information' },
  { name: 'roleinfo', description: 'Show info about a role', options: [
    { name: 'role', type: 8, description: 'Which role?', required: true },
  ]},
  { name: 'poll', description: 'Create a poll', options: [
    { name: 'question', type: 3, description: 'Poll question', required: true },
    { name: 'option1', type: 3, description: 'Option 1', required: true },
    { name: 'option2', type: 3, description: 'Option 2', required: true },
    { name: 'option3', type: 3, description: 'Option 3', required: false },
    { name: 'option4', type: 3, description: 'Option 4', required: false },
  ]},
  { name: 'userinfo', description: 'Show user information', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'warn', description: 'Warn a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: true },
  ]},
  { name: 'mute', description: 'Mute a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'minutes', type: 4, description: 'Minutes', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'unmute', description: 'Unmute a user', options: [{ name: 'user', type: 6, description: 'Who?', required: true }]},
  { name: 'slowmode', description: 'Set slowmode', options: [{ name: 'seconds', type: 4, description: 'Seconds (0=off)', required: true }]},
  { name: 'lock', description: 'Lock channel' },
  { name: 'unlock', description: 'Unlock channel' },
  { name: 'clear', description: 'Delete messages', options: [{ name: 'amount', type: 4, description: 'How many (max 100)', required: true }]},
  { name: 'session', description: 'Session commands', options: [
    { name: 'start', type: 1, description: 'Start session', options: [{ name: 'link', type: 3, description: 'Join link override', required: false }]},
    { name: 'vote', type: 1, description: 'Start vote' },
    { name: 'shutdown', type: 1, description: 'Shutdown session' },
  ]},

  // ── SHR COMMANDS ──
  { name: 'ban', description: '[SHR] Ban user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'unban', description: '[SHR] Unban user by ID', options: [
    { name: 'userid', type: 3, description: 'User ID', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'softban', description: '[SHR] Softban (ban + unban to delete messages)', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'tempban', description: '[SHR] Temporarily ban a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'hours', type: 4, description: 'Duration in hours', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'kick', description: '[SHR] Kick user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'addrole', description: '[SHR] Add role', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'role', type: 8, description: 'Role', required: true },
  ]},
  { name: 'removerole', description: '[SHR] Remove role', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'role', type: 8, description: 'Role', required: true },
  ]},
  { name: 'nickname', description: '[SHR] Change a user\'s nickname', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'nickname', type: 3, description: 'New nickname (leave empty to reset)', required: false },
  ]},
  { name: 'warnings', description: '[SHR] View warnings for a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'clearwarnings', description: '[SHR] Clear all warnings for a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'note', description: '[SHR] Add a note to a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'text', type: 3, description: 'Note text', required: true },
  ]},
  { name: 'notes', description: '[SHR] View notes for a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'announce', description: '[SHR] Send a saved announcement type', options: [
    { name: 'type', type: 3, description: 'Announcement type name', required: true },
    { name: 'message', type: 3, description: 'Optional extra message to add', required: false },
  ]},
  { name: 'embed', description: '[SHR] Send a custom embed', options: [
    { name: 'channel', type: 7, description: 'Channel', required: true },
    { name: 'title', type: 3, description: 'Title', required: true },
    { name: 'description', type: 3, description: 'Description', required: true },
    { name: 'color', type: 3, description: 'Hex color', required: false },
    { name: 'image', type: 3, description: 'Image URL', required: false },
    { name: 'footer', type: 3, description: 'Footer text', required: false },
  ]},
  { name: 'giveaway', description: '[SHR] Start a giveaway', options: [
    { name: 'channel', type: 7, description: 'Channel', required: true },
    { name: 'prize', type: 3, description: 'What are you giving away?', required: true },
    { name: 'minutes', type: 4, description: 'Duration in minutes', required: true },
    { name: 'winners', type: 4, description: 'Number of winners', required: true },
  ]},
  { name: 'punish', description: '[SHR] Punish user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
    { name: 'type', type: 3, description: 'Type', required: true, choices: [
      { name: 'Warn', value: 'warn' }, { name: 'Mute 10min', value: 'mute' },
      { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' },
    ]},
    { name: 'reason', type: 3, description: 'Reason', required: true },
  ]},
  { name: 'players', description: '[SHR] ERLC players' },
  { name: 'serverstatus', description: '[SHR] ERLC server status' },
  { name: 'erlckick', description: '[SHR] Kick ERLC player', options: [
    { name: 'username', type: 3, description: 'Roblox username', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'erlcban', description: '[SHR] Ban ERLC player', options: [
    { name: 'username', type: 3, description: 'Roblox username', required: true },
    { name: 'reason', type: 3, description: 'Reason', required: false },
  ]},
  { name: 'setup', description: '[SHR] Setup', options: [
    { name: 'tickets', type: 1, description: 'Ticket system' },
    { name: 'sessions', type: 1, description: 'Session system' },
    { name: 'selfroles', type: 1, description: 'Self role system' },
    { name: 'announcements', type: 1, description: 'Announcement system' },
  ]},
];

// Active giveaways
const activeGiveaways = new Map();

// ════════════════════════════════════════════
// READY
// ════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Online as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Commands registered');
  } catch (e) { console.error('❌ Command registration failed:', e); }
});

// ════════════════════════════════════════════
// WELCOME
// ════════════════════════════════════════════
client.on('guildMemberAdd', async member => {
  try {
    const ch = member.guild.channels.cache.find(c => c.name === WELCOME_CHANNEL && c.type === ChannelType.GuildText);
    if (!ch) return;
    await ch.send({
      content: `👋 Welcome ${member}!`,
      embeds: [new EmbedBuilder()
        .setTitle('Welcome to NYLRP!')
        .setDescription(`Hello, welcome to **NYLRP**! We now have **${member.guild.memberCount}** members.`)
        .setThumbnail(LOGO_URL).setColor(0x2f3136).setTimestamp()],
    });
  } catch (e) { console.error('Welcome error:', e); }
});

// ════════════════════════════════════════════
// REACTION SELFROLE
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
          if (role.reaction && role.reaction === reaction.emoji.toString()) { targetPanel = panel; targetRole = role; break; }
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
        return user.send(`❌ You can only have **${targetPanel.max}** role(s). Remove one first!`).catch(() => {});
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
          if (role.reaction && role.reaction === reaction.emoji.toString()) { targetRole = role; break; }
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
// INTERACTIONS
// ════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;
  try {

    // ── SLASH COMMANDS ──
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const user = interaction.options.getUser('user') ?? null;
      const member = user ? interaction.options.getMember('user') : null;
      const reason = interaction.options.getString('reason') ?? 'No reason provided';

      // ── NORMAL COMMANDS ──

      if (cmd === 'ping') {
        const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        return interaction.editReply(`🏓 Pong!\n**Bot latency:** ${latency}ms\n**API latency:** ${client.ws.ping}ms`);
      }

      if (cmd === 'avatar') {
        const target = interaction.options.getUser('user') ?? interaction.user;
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle(`🖼️ ${target.username}'s Avatar`)
          .setImage(target.displayAvatarURL({ size: 1024, dynamic: true }))
          .setColor(0x5865F2)
          .addFields({ name: 'Links', value: `[PNG](${target.displayAvatarURL({ format: 'png', size: 1024 })}) | [JPG](${target.displayAvatarURL({ format: 'jpg', size: 1024 })}) | [WEBP](${target.displayAvatarURL({ format: 'webp', size: 1024 })})` })
        ]});
      }

      if (cmd === 'serverinfo') {
        const g = interaction.guild;
        await g.fetch();
        const owner = await g.fetchOwner();
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle(`📊 ${g.name}`)
          .setThumbnail(g.iconURL({ dynamic: true }))
          .setColor(0x5865F2)
          .addFields(
            { name: '👑 Owner', value: `${owner.user.tag}`, inline: true },
            { name: '👥 Members', value: `${g.memberCount}`, inline: true },
            { name: '📅 Created', value: g.createdAt.toDateString(), inline: true },
            { name: '💬 Channels', value: `${g.channels.cache.size}`, inline: true },
            { name: '🎭 Roles', value: `${g.roles.cache.size}`, inline: true },
            { name: '😀 Emojis', value: `${g.emojis.cache.size}`, inline: true },
            { name: '🔒 Verification', value: g.verificationLevel.toString(), inline: true },
            { name: '🆔 Server ID', value: g.id, inline: true },
          )
          .setTimestamp()
        ]});
      }

      if (cmd === 'roleinfo') {
        const role = interaction.options.getRole('role');
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle(`🎭 ${role.name}`)
          .setColor(role.color || 0x5865F2)
          .addFields(
            { name: '🆔 ID', value: role.id, inline: true },
            { name: '🎨 Color', value: role.hexColor, inline: true },
            { name: '📌 Position', value: `${role.position}`, inline: true },
            { name: '👥 Members', value: `${role.members.size}`, inline: true },
            { name: '🤖 Managed', value: role.managed ? 'Yes' : 'No', inline: true },
            { name: '💬 Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
            { name: '📅 Created', value: role.createdAt.toDateString(), inline: true },
          )
          .setTimestamp()
        ]});
      }

      if (cmd === 'poll') {
        const question = interaction.options.getString('question');
        const options = [
          interaction.options.getString('option1'),
          interaction.options.getString('option2'),
          interaction.options.getString('option3'),
          interaction.options.getString('option4'),
        ].filter(Boolean);
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const desc = options.map((o, i) => `${emojis[i]} ${o}`).join('\n\n');
        const embed = new EmbedBuilder()
          .setTitle(`📊 ${question}`)
          .setDescription(desc)
          .setColor(0x5865F2)
          .setFooter({ text: `Poll by ${interaction.user.tag}` })
          .setTimestamp();
        const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
        for (let i = 0; i < options.length; i++) await msg.react(emojis[i]);
      }

      if (cmd === 'userinfo') {
        const targetUser = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
          .setTitle(`👤 ${targetUser.tag}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setColor(0x5865F2)
          .addFields(
            { name: '🆔 ID', value: targetUser.id, inline: true },
            { name: '🤖 Bot', value: targetUser.bot ? 'Yes' : 'No', inline: true },
            { name: '📅 Account Created', value: targetUser.createdAt.toDateString(), inline: true },
            { name: '📥 Joined Server', value: targetMember?.joinedAt?.toDateString() ?? 'Unknown', inline: true },
            { name: '📛 Nickname', value: targetMember?.nickname ?? 'None', inline: true },
            { name: '🎭 Roles', value: targetMember?.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None', inline: false },
          ).setTimestamp()] });
      }

      if (cmd === 'warn') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        const warnData = { reason, moderator: interaction.user.tag, date: new Date().toUTCString() };
        addWarning(guildId, user.id, warnData);
        const warnCount = getWarnings(guildId, user.id).length;
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('⚠️ Warning Issued')
          .setColor(0xFEE75C)
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Moderator', value: interaction.user.tag, inline: true },
            { name: 'Total Warnings', value: `${warnCount}`, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'mute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        const mins = interaction.options.getInteger('minutes');
        await member.timeout(mins * 60000, reason);
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('🔇 User Muted')
          .setColor(0xED4245)
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Duration', value: `${mins} minutes`, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'unmute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        await member.timeout(null);
        return interaction.reply(`🔊 **${user.tag}** unmuted.`);
      }

      if (cmd === 'slowmode') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        const s = interaction.options.getInteger('seconds');
        await interaction.channel.setRateLimitPerUser(s);
        return interaction.reply(`✅ Slowmode: **${s}s**.`);
      }

      if (cmd === 'lock') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        return interaction.reply('🔒 Channel **locked**.');
      }

      if (cmd === 'unlock') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: true });
        return interaction.reply('🔓 Channel **unlocked**.');
      }

      if (cmd === 'clear') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', ephemeral: true });
        const del = await interaction.channel.bulkDelete(Math.min(interaction.options.getInteger('amount'), 100), true);
        return interaction.reply({ content: `✅ Deleted **${del.size}** messages.`, ephemeral: true });
      }

      // ── SHR COMMANDS ──

      if (cmd === 'ban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.guild.members.ban(user, { reason });
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('🔨 User Banned')
          .setColor(0xED4245)
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Moderator', value: interaction.user.tag, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'unban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const userId = interaction.options.getString('userid');
        await interaction.guild.members.unban(userId, reason).catch(e => { throw new Error(`Could not unban: ${e.message}`); });
        return interaction.reply(`✅ User **${userId}** unbanned.\n**Reason:** ${reason}`);
      }

      if (cmd === 'softban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.guild.members.ban(user, { reason, deleteMessageSeconds: 604800 });
        await interaction.guild.members.unban(user.id, 'Softban');
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('🪃 User Softbanned')
          .setColor(0xED4245)
          .setDescription('User was banned and unbanned to clear their messages.')
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Moderator', value: interaction.user.tag, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'tempban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const hours = interaction.options.getInteger('hours');
        await interaction.guild.members.ban(user, { reason });
        setTimeout(async () => {
          await interaction.guild.members.unban(user.id, 'Tempban expired').catch(() => {});
        }, hours * 3600000);
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('⏱️ User Temp Banned')
          .setColor(0xED4245)
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Duration', value: `${hours} hours`, inline: true },
            { name: 'Moderator', value: interaction.user.tag, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'kick') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await member.kick(reason);
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle('👢 User Kicked')
          .setColor(0xED4245)
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Moderator', value: interaction.user.tag, inline: true },
            { name: 'Reason', value: reason, inline: false },
          ).setTimestamp()
        ]});
      }

      if (cmd === 'addrole') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const role = interaction.options.getRole('role');
        await member.roles.add(role);
        return interaction.reply(`✅ Added **${role.name}** to **${user.tag}**.`);
      }

      if (cmd === 'removerole') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const role = interaction.options.getRole('role');
        await member.roles.remove(role);
        return interaction.reply(`✅ Removed **${role.name}** from **${user.tag}**.`);
      }

      if (cmd === 'nickname') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const nick = interaction.options.getString('nickname') ?? null;
        await member.setNickname(nick, `Changed by ${interaction.user.tag}`);
        return interaction.reply(nick ? `✅ Nickname of **${user.tag}** set to **${nick}**.` : `✅ Nickname of **${user.tag}** reset.`);
      }

      if (cmd === 'warnings') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const warns = getWarnings(guildId, user.id);
        if (!warns.length) return interaction.reply({ content: `✅ **${user.tag}** has no warnings.`, ephemeral: true });
        return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
          .setTitle(`⚠️ Warnings — ${user.tag}`)
          .setColor(0xFEE75C)
          .setDescription(warns.map((w, i) => `**${i + 1}.** ${w.reason}\n*by ${w.moderator} — ${w.date}*`).join('\n\n'))
          .setFooter({ text: `Total: ${warns.length} warning(s)` })
        ]});
      }

      if (cmd === 'clearwarnings') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        clearWarnings(guildId, user.id);
        return interaction.reply(`✅ Cleared all warnings for **${user.tag}**.`);
      }

      if (cmd === 'note') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const text = interaction.options.getString('text');
        addNote(guildId, user.id, { text, moderator: interaction.user.tag, date: new Date().toUTCString() });
        return interaction.reply({ content: `✅ Note added for **${user.tag}**.`, ephemeral: true });
      }

      if (cmd === 'notes') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const notes = getNotes(guildId, user.id);
        if (!notes.length) return interaction.reply({ content: `📝 **${user.tag}** has no notes.`, ephemeral: true });
        return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
          .setTitle(`📝 Notes — ${user.tag}`)
          .setColor(0x5865F2)
          .setDescription(notes.map((n, i) => `**${i + 1}.** ${n.text}\n*by ${n.moderator} — ${n.date}*`).join('\n\n'))
          .setFooter({ text: `Total: ${notes.length} note(s)` })
        ]});
      }

      if (cmd === 'announce') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const typeName = interaction.options.getString('type').toLowerCase().trim();
        const extraMsg = interaction.options.getString('message') ?? null;
        const ac = getAnnouncementConfig(guildId);
        // Find by name (case-insensitive)
        const entry = Object.entries(ac.types).find(([, t]) => t.name.toLowerCase() === typeName);
        if (!entry) return interaction.reply({ content: `❌ No announcement type found with name **${typeName}**. Set one up with \`/setup announcements\`.`, ephemeral: true });
        const [, t] = entry;
        if (!t.channel) return interaction.reply({ content: `❌ No channel set for **${t.name}**. Edit it in \`/setup announcements\`.`, ephemeral: true });
        const ch = interaction.guild.channels.cache.get(t.channel);
        if (!ch) return interaction.reply({ content: '❌ Announcement channel not found.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const embed = new EmbedBuilder()
          .setTitle(`${t.emoji || '📢'} ${t.title || t.name}`)
          .setDescription(extraMsg ? `${t.description || ''}\n\n${extraMsg}`.trim() : (t.description || '*No description set.*'))
          .setColor(hexToInt(t.color))
          .setFooter({ text: `Announced by ${interaction.user.tag}` })
          .setTimestamp();
        if (t.image) embed.setImage(t.image);
        const pingContent = t.pingRole ? `<@&${t.pingRole}>` : undefined;
        await ch.send({ content: pingContent, embeds: [embed] });
        return interaction.editReply({ content: `✅ **${t.name}** announcement sent in <#${t.channel}>!` });
      }

      if (cmd === 'embed') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const ch = interaction.options.getChannel('channel');
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const color = interaction.options.getString('color') ?? '#5865F2';
        const image = interaction.options.getString('image');
        const footer = interaction.options.getString('footer');
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor(hexToInt(color));
        if (image) embed.setImage(image);
        if (footer) embed.setFooter({ text: footer });
        await ch.send({ embeds: [embed] });
        return interaction.reply({ content: `✅ Embed sent in <#${ch.id}>!`, ephemeral: true });
      }

      if (cmd === 'giveaway') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const ch = interaction.options.getChannel('channel');
        const prize = interaction.options.getString('prize');
        const minutes = interaction.options.getInteger('minutes');
        const winners = interaction.options.getInteger('winners');
        const endsAt = new Date(Date.now() + minutes * 60000);
        const embed = new EmbedBuilder()
          .setTitle('🎉 GIVEAWAY 🎉')
          .setColor(0xEB459E)
          .setDescription(`**Prize:** ${prize}\n\nReact with 🎉 to enter!\n\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>`)
          .setFooter({ text: `Hosted by ${interaction.user.tag}` })
          .setTimestamp(endsAt);
        const msg = await ch.send({ embeds: [embed] });
        await msg.react('🎉');
        activeGiveaways.set(msg.id, { prize, winners, channelId: ch.id, messageId: msg.id, guildId });
        setTimeout(async () => {
          try {
            const gMsg = await ch.messages.fetch(msg.id);
            const reaction = gMsg.reactions.cache.get('🎉');
            if (!reaction) return;
            const users = await reaction.users.fetch();
            const entries = users.filter(u => !u.bot);
            if (!entries.size) {
              return ch.send('🎉 Giveaway ended — no valid entries!');
            }
            const picked = entries.random(Math.min(winners, entries.size));
            const winnerMentions = (Array.isArray(picked) ? picked : [picked]).map(u => `<@${u.id}>`).join(', ');
            await ch.send({ embeds: [new EmbedBuilder()
              .setTitle('🎉 Giveaway Ended!')
              .setColor(0xEB459E)
              .setDescription(`**Prize:** ${prize}\n**Winner(s):** ${winnerMentions}\n\nCongratulations! 🎊`)
              .setTimestamp()
            ]});
            activeGiveaways.delete(msg.id);
          } catch (e) { console.error('Giveaway end error:', e); }
        }, minutes * 60000);
        return interaction.reply({ content: `✅ Giveaway started in <#${ch.id}>!`, ephemeral: true });
      }

      if (cmd === 'punish') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const t = interaction.options.getString('type');
        if (t === 'warn') {
          addWarning(guildId, user.id, { reason, moderator: interaction.user.tag, date: new Date().toUTCString() });
          return interaction.reply(`⚠️ **${user.tag}** warned.\n**Reason:** ${reason}`);
        }
        if (t === 'mute') { await member.timeout(600000, reason); return interaction.reply(`🔇 **${user.tag}** muted 10min.\n**Reason:** ${reason}`); }
        if (t === 'kick') { await member.kick(reason); return interaction.reply(`👢 **${user.tag}** kicked.\n**Reason:** ${reason}`); }
        if (t === 'ban') { await interaction.guild.members.ban(user, { reason }); return interaction.reply(`🔨 **${user.tag}** banned.\n**Reason:** ${reason}`); }
      }

      if (cmd === 'players') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        try {
          const data = await erlcRequest('/server/players');
          const list = Object.values(data);
          if (!list.length) return interaction.editReply('No players in server.');
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`👥 Players (${list.length})`).setColor(0x5865F2)
            .setDescription(list.map((p, i) => `${i + 1}. **${p.Player}** — ${p.Team || 'No team'}`).join('\n').slice(0, 4000)).setTimestamp()] });
        } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }

      if (cmd === 'serverstatus') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        try {
          const d = await erlcRequest('/server');
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🖥️ ERLC Status').setColor(0x57F287)
            .addFields(
              { name: 'Name', value: d.Name || 'Unknown', inline: true },
              { name: 'Players', value: `${d.CurrentPlayers ?? 0}/${d.MaxPlayers ?? 0}`, inline: true },
              { name: 'Key', value: d.JoinKey || 'N/A', inline: true },
            ).setTimestamp()] });
        } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }

      if (cmd === 'erlckick') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const u = interaction.options.getString('username');
        const r = interaction.options.getString('reason') ?? 'No reason';
        try { await erlcRequest('/server/command', 'POST', { command: `:kick ${u}` }); return interaction.editReply(`✅ **${u}** kicked.\n**Reason:** ${r}`); }
        catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }

      if (cmd === 'erlcban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const u = interaction.options.getString('username');
        const r = interaction.options.getString('reason') ?? 'No reason';
        try { await erlcRequest('/server/command', 'POST', { command: `:ban ${u}` }); return interaction.editReply(`✅ **${u}** banned.\n**Reason:** ${r}`); }
        catch (e) { return interaction.editReply(`❌ ${e.message}`); }
      }

      if (cmd === 'setup') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'tickets')       return interaction.reply(buildTicketSetupPayload(guildId));
        if (sub === 'sessions')      return interaction.reply(buildSessionSetupPayload(guildId));
        if (sub === 'selfroles')     return interaction.reply({ ...buildSelfRoleOverview(guildId), ephemeral: true });
        if (sub === 'announcements') return interaction.reply(buildAnnouncementOverview(guildId));
      }

      // ── SESSION COMMAND (fixed with deferReply) ──
      if (cmd === 'session') {
        if (!canRunSession(interaction.member, guildId)) return interaction.reply({ content: '❌ No permission.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const sc = getSessionConfig(guildId);
        if (!sc.channel) return interaction.reply({ content: '❌ Session channel not set.', ephemeral: true });
        const sCh = interaction.guild.channels.cache.get(sc.channel);
        if (!sCh) return interaction.reply({ content: '❌ Session channel not found.', ephemeral: true });

        // ✅ FIX: defer immediately to prevent "you ran into a problem"
        await interaction.deferReply({ ephemeral: true });

        const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;

        if (sub === 'start') {
          const link = interaction.options.getString('link') ?? sc.joinLink ?? null;
          const desc = replaceVars(sc.startDescription ?? 'A session has started! {hostMention} is hosting.', interaction);
          const embed = new EmbedBuilder().setTitle('🟢 Session Started!').setColor(0x57F287).setDescription(desc).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.startImage) embed.setImage(sc.startImage);
          const comps = [];
          if (link) comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(link)));
          await sCh.send({ content: ping ?? undefined, embeds: [embed], components: comps });
          return interaction.editReply({ content: `✅ Session started in <#${sc.channel}>!` });
        }
        if (sub === 'vote') {
          const desc = replaceVars(sc.voteDescription ?? 'A session vote has started!', interaction);
          const embed = new EmbedBuilder().setTitle('🗳️ Session Vote!').setColor(0xFEE75C).setDescription(desc).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.voteImage) embed.setImage(sc.voteImage);
          const msg = await sCh.send({ content: ping ?? undefined, embeds: [embed] });
          await msg.react('✅'); await msg.react('❌');
          return interaction.editReply({ content: '✅ Vote posted!' });
        }
        if (sub === 'shutdown') {
          const desc = replaceVars(sc.shutdownDescription ?? 'The session has ended. Thanks for playing!', interaction);
          const embed = new EmbedBuilder().setTitle('🔴 Session Ended!').setColor(0xED4245).setDescription(desc).setTimestamp().setFooter({ text: `By ${interaction.user.tag}` });
          if (sc.shutdownImage) embed.setImage(sc.shutdownImage);
          await sCh.send({ content: ping ?? undefined, embeds: [embed] });
          return interaction.editReply({ content: '✅ Shutdown posted!' });
        }
      }
    }

    // ── BUTTONS ──
    if (interaction.isButton()) {
      const id = interaction.customId;

      // ANNOUNCEMENT SETUP
      if (id.startsWith('an_') || id.startsWith('ane__') || id === 'an__back') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const ac = getAnnouncementConfig(guildId);

        if (id === 'an__back') return interaction.update(buildAnnouncementOverview(guildId));

        if (id === 'an_new') {
          const modal = new ModalBuilder().setCustomId('modal_an_new').setTitle('New Announcement Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_name').setLabel('Type name (e.g. "maintenance", "update")').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_emoji').setLabel('Emoji (optional, e.g. 🔧)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_desc').setLabel('Description (use {host}, {time}, {server})').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_color').setLabel('Color hex (e.g. #ED4245)').setStyle(TextInputStyle.Short).setRequired(false)),
          );
          return interaction.showModal(modal);
        }

        if (id === 'an_edit') {
          const types = Object.entries(ac.types);
          if (!types.length) return interaction.reply({ content: '❌ No types to edit.', ephemeral: true });
          const sel = new StringSelectMenuBuilder().setCustomId('an_sel_edit').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: tid })));
          return interaction.reply({ content: '### ✏️ Select announcement type', components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
        }

        if (id === 'an_delete') {
          const types = Object.entries(ac.types);
          if (!types.length) return interaction.reply({ content: '❌ No types to delete.', ephemeral: true });
          const sel = new StringSelectMenuBuilder().setCustomId('an_sel_delete').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: tid })));
          return interaction.reply({ content: '### 🗑️ Select announcement type to delete', components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
        }

        if (id.startsWith('ane__')) {
          const parts = id.split('__');
          const action = parts[1];
          const typeId = parts.slice(2).join('__');
          const t = ac.types[typeId];
          if (!t) return interaction.reply({ content: '❌ Type not found.', ephemeral: true });

          if (action === 'content') {
            const modal = new ModalBuilder().setCustomId(`modal_an_content__${typeId}`).setTitle(`Edit — ${t.name}`);
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setValue(t.title || '').setMaxLength(80).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(t.description || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_color').setLabel('Color hex (e.g. #ED4245)').setStyle(TextInputStyle.Short).setValue(t.color || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setValue(t.image || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('an_c_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setValue(t.emoji || '').setRequired(false)),
            );
            return interaction.showModal(modal);
          }
          if (action === 'channel') return interaction.reply({ content: `### 📢 Channel for **${t.name}**`, components: [channelDropdown(`anch__${typeId}`, 'Select channel...')], ephemeral: true });
          if (action === 'pingrole') return interaction.reply({ content: `### 🔔 Ping role for **${t.name}**`, components: [roleDropdown(`anpr__${typeId}`, 'Select role...', 1, 1)], ephemeral: true });
          if (action === 'clearping') {
            t.pingRole = null;
            saveConfig(config);
            return interaction.update(buildAnnouncementEditor(guildId, typeId));
          }
        }
      }

      // TICKET SETUP
      if (id.startsWith('t_')) {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        if (id === 't_ping_roles') return interaction.reply({ content: '### 📢 Ping roles', components: [roleDropdown('td_ping_roles', 'Select roles...')], ephemeral: true });
        if (id === 't_transcript') return interaction.reply({ content: '### 📋 Transcript channel', components: [channelDropdown('td_transcript', 'Select channel...')], ephemeral: true });
        if (id === 't_channel')    return interaction.reply({ content: '### 📬 Panel channel', components: [channelDropdown('td_channel', 'Select channel...')], ephemeral: true });
        if (id === 't_category')   return interaction.reply({ content: '### 📁 Category', components: [channelDropdown('td_category', 'Select category...', [ChannelType.GuildCategory])], ephemeral: true });
        if (id === 't_panel_embed') {
          const tc = getTicketConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_t_embed').setTitle('Ticket Panel Embed');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(tc.panelTitle || '').setMaxLength(80).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(tc.panelDescription || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_color').setLabel('Color (hex, e.g. #5865F2)').setStyle(TextInputStyle.Short).setValue(tc.panelColor || '').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t_embed_thumbnail').setLabel('Image URL (shows below embed)').setStyle(TextInputStyle.Short).setValue(tc.panelThumbnail || '').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_welcome') {
          const tc = getTicketConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_t_welcome').setTitle('Ticket Welcome Text');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('t_welcome_text').setLabel('Welcome text (use {user} for mention)').setStyle(TextInputStyle.Paragraph).setValue(tc.welcomeText || '').setRequired(true)
          ));
          return interaction.showModal(modal);
        }
        if (id === 't_add_type') {
          const modal = new ModalBuilder().setCustomId('modal_t_add_type').setTitle('Add Ticket Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_label').setLabel('Button Label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_emoji').setLabel('Emoji (optional, e.g. 🎫)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_color').setLabel('Color: blue / green / red / grey').setStyle(TextInputStyle.Short).setValue('blue').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tt_description').setLabel('Short description (optional)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_remove_type') {
          const tc = getTicketConfig(guildId);
          if (!tc.ticketTypes.length) return interaction.reply({ content: '❌ No types to remove.', ephemeral: true });
          const sel = new StringSelectMenuBuilder().setCustomId('td_remove_type').setPlaceholder('Select type to remove...')
            .addOptions(tc.ticketTypes.map(t => ({ label: t.label, value: t.id })));
          return interaction.reply({ content: '### ➖ Remove ticket type', components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
        }
        if (id === 't_deploy') {
          const tc = getTicketConfig(guildId);
          if (!tc.ticketChannel) return interaction.reply({ content: '❌ Set a panel channel first.', ephemeral: true });
          if (!tc.ticketTypes.length) return interaction.reply({ content: '❌ Add at least one ticket type first.', ephemeral: true });
          const ch = interaction.guild.channels.cache.get(tc.ticketChannel);
          if (!ch) return interaction.reply({ content: '❌ Panel channel not found.', ephemeral: true });
          try {
            await interaction.deferReply({ ephemeral: true });
            await ch.send({ embeds: [buildTicketPanelEmbed(tc)], components: buildTicketTypeButtons(tc.ticketTypes) });
            saveConfig(config);
            return interaction.editReply({ content: `✅ Ticket panel deployed in <#${tc.ticketChannel}>!` });
          } catch (e) {
            console.error('Ticket deploy error:', e);
            if (interaction.deferred) return interaction.editReply({ content: `❌ Failed: ${e.message}` });
            return interaction.reply({ content: `❌ Failed: ${e.message}`, ephemeral: true });
          }
        }
      }

      // SESSION SETUP
      if (id.startsWith('s_')) {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        if (id === 's_channel')       return interaction.reply({ content: '### 📢 Session channel', components: [channelDropdown('sd_channel', 'Select channel...')], ephemeral: true });
        if (id === 's_ping_roles')    return interaction.reply({ content: '### 👥 Ping roles', components: [roleDropdown('sd_ping_roles', 'Select roles...')], ephemeral: true });
        if (id === 's_allowed_roles') return interaction.reply({ content: '### 🔑 Allowed roles', components: [roleDropdown('sd_allowed_roles', 'Select roles...')], ephemeral: true });
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
          const modal = new ModalBuilder().setCustomId('modal_s_images').setTitle('Session Images');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_start_img').setLabel('Start image URL').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_vote_img').setLabel('Vote image URL').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('s_shutdown_img').setLabel('Shutdown image URL').setStyle(TextInputStyle.Short).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
      }

      // SELFROLE SETUP
      if (id.startsWith('sr_') || id.startsWith('sre__')) {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const src = getSelfRoleConfig(guildId);

        if (id === 'sr_new') {
          const modal = new ModalBuilder().setCustomId('modal_sr_new').setTitle('Create Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_desc').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_color').setLabel('Color hex (e.g. #EB459E)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_type').setLabel('Type: buttons / dropdown / reaction').setStyle(TextInputStyle.Short).setValue('buttons').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_max').setLabel('Max roles per user (0 = unlimited)').setStyle(TextInputStyle.Short).setValue('0').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'sr__back') return interaction.update(buildSelfRoleOverview(guildId));
        if (id === 'sr_edit') {
          const panels = Object.entries(src.panels);
          if (!panels.length) return interaction.reply({ content: '❌ No panels.', ephemeral: true });
          const sel = new StringSelectMenuBuilder().setCustomId('sr_sel_edit').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: pid })));
          return interaction.reply({ content: '### ✏️ Select panel', components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
        }
        if (id === 'sr_delete') {
          const panels = Object.entries(src.panels);
          if (!panels.length) return interaction.reply({ content: '❌ No panels.', ephemeral: true });
          const sel = new StringSelectMenuBuilder().setCustomId('sr_sel_delete').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: pid })));
          return interaction.reply({ content: '### 🗑️ Select panel', components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
        }

        if (id.startsWith('sre__')) {
          const parts = id.split('__');
          const action = parts[1];
          const panelId = parts.slice(2).join('__');
          const panel = src.panels[panelId];
          if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });

          if (action === 'embed') {
            const modal = new ModalBuilder().setCustomId(`modal_sr_embed__${panelId}`).setTitle('Edit Panel Embed');
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(panel.title).setMaxLength(80).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(panel.description || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setValue(panel.color || '').setRequired(false)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_e_thumbnail').setLabel('Thumbnail URL (optional)').setStyle(TextInputStyle.Short).setValue(panel.thumbnail || '').setRequired(false)),
            );
            return interaction.showModal(modal);
          }
          if (action === 'channel') return interaction.reply({ content: `### 📢 Channel for **${panel.title}**`, components: [channelDropdown(`srch__${panelId}`, 'Select channel...')], ephemeral: true });
          if (action === 'addrole') return interaction.reply({ content: `### ➕ Add role to **${panel.title}**`, components: [roleDropdown(`srr__add__${panelId}`, 'Select role...', 1, 1)], ephemeral: true });
          if (action === 'removerole') {
            if (!panel.roles.length) return interaction.reply({ content: '❌ No roles.', ephemeral: true });
            const sel = new StringSelectMenuBuilder().setCustomId(`sr_sel_rmrole__${panelId}`).setPlaceholder('Select role to remove...').addOptions(panel.roles.map(r => ({ label: r.label, value: r.id })));
            return interaction.reply({ content: `### ➖ Remove role from **${panel.title}**`, components: [new ActionRowBuilder().addComponents(sel)], ephemeral: true });
          }
          if (action === 'deploy') {
            if (!panel.channel) return interaction.reply({ content: '❌ Set a channel first.', ephemeral: true });
            if (!panel.roles.length) return interaction.reply({ content: '❌ Add at least one role.', ephemeral: true });
            try {
              await interaction.deferReply({ ephemeral: true });
              await deploySelfRolePanel(interaction.guild, panelId, panel);
              saveConfig(config);
              return interaction.editReply({ content: `✅ **${panel.title}** deployed in <#${panel.channel}>!` });
            } catch (e) {
              console.error('SelfRole deploy error:', e);
              if (interaction.deferred) return interaction.editReply({ content: `❌ Failed: ${e.message}` });
              return interaction.reply({ content: `❌ Failed: ${e.message}`, ephemeral: true });
            }
          }
        }
      }

      // TICKET OPEN
      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Ticket type no longer exists.', ephemeral: true });
        if (openTickets.has(interaction.user.id)) {
          const existing = interaction.guild.channels.cache.get(openTickets.get(interaction.user.id));
          if (existing) return interaction.reply({ content: `❌ You already have an open ticket: <#${existing.id}>`, ephemeral: true });
          openTickets.delete(interaction.user.id);
        }
        await interaction.deferReply({ ephemeral: true });
        const shrRole = interaction.guild.roles.cache.find(r => r.name === SHR_ROLE);
        const category = tc.ticketCategory ? interaction.guild.channels.cache.get(tc.ticketCategory) : null;
        const perms = [
          { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        if (shrRole) perms.push({ id: shrRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        for (const rid of tc.pingRoles) {
          if (shrRole && rid === shrRole.id) continue;
          perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        }
        const ticketCh = await interaction.guild.channels.create({
          name: `ticket-${type.label.toLowerCase().replace(/\s+/g, '-')}-${interaction.user.username}`,
          type: ChannelType.GuildText, parent: category ?? null, permissionOverwrites: perms,
          topic: `Ticket by ${interaction.user.tag} | ${type.label}`,
        });
        openTickets.set(interaction.user.id, ticketCh.id);
        const welcomeText = replaceVars(tc.welcomeText || 'Hello {user}, thank you for opening a ticket!', interaction);
        const pingTxt = tc.pingRoles.map(id => `<@&${id}>`).join(' ');
        const embed = new EmbedBuilder()
          .setTitle(`${type.emoji || '🎫'} Ticket — ${type.label}`)
          .setDescription(`${welcomeText}\n\n**Type:** ${type.label}${type.description ? `\n*${type.description}*` : ''}`)
          .setColor(hexToInt(tc.panelColor)).setTimestamp().setFooter({ text: `Opened by ${interaction.user.tag}` });
        // ✅ FIX: use setImage for ticket welcome too
        if (tc.panelThumbnail) embed.setImage(tc.panelThumbnail);
        await ticketCh.send({
          content: `<@${interaction.user.id}>${pingTxt ? ' ' + pingTxt : ''}`,
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'))],
        });
        return interaction.editReply({ content: `✅ Ticket created: <#${ticketCh.id}>` });
      }

      // TICKET CLOSE
      if (id === 'tkt__close') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
        const ch = interaction.channel;
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
              .map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${m.author.tag}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        await interaction.reply({ content: '🔒 Closing in 3 seconds...' });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
      }

      // SELFROLE BUTTON
      if (id.startsWith('srp__btn__')) {
        const parts = id.split('__');
        const panelId = parts[2];
        const roleId = parts[3];
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel no longer exists.', ephemeral: true });
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ content: '❌ Role no longer exists.', ephemeral: true });
        if (panel.max > 0 && !interaction.member.roles.cache.has(roleId)) {
          const count = panel.roles.filter(r => interaction.member.roles.cache.has(r.id)).length;
          if (count >= panel.max) return interaction.reply({ content: `❌ You can only have **${panel.max}** role(s). Remove one first.`, ephemeral: true });
        }
        if (interaction.member.roles.cache.has(roleId)) {
          await interaction.member.roles.remove(roleId);
          return interaction.reply({ content: `✅ Removed **${role.name}**.`, ephemeral: true });
        } else {
          await interaction.member.roles.add(roleId);
          return interaction.reply({ content: `✅ Added **${role.name}**.`, ephemeral: true });
        }
      }
    }

    // ── ROLE SELECT MENUS ──
    if (interaction.isRoleSelectMenu()) {
      if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
      const ids = interaction.values;
      if (interaction.customId === 'td_ping_roles')    { getTicketConfig(guildId).pingRoles = ids; saveConfig(config); return interaction.reply({ content: '✅ Ticket ping roles set.', ephemeral: true }); }
      if (interaction.customId === 'sd_ping_roles')    { getSessionConfig(guildId).pingRoles = ids; saveConfig(config); return interaction.reply({ content: '✅ Session ping roles set.', ephemeral: true }); }
      if (interaction.customId === 'sd_allowed_roles') { getSessionConfig(guildId).allowedRoles = ids; saveConfig(config); return interaction.reply({ content: '✅ Allowed roles set.', ephemeral: true }); }
      if (interaction.customId.startsWith('srr__add__')) {
        const panelId = interaction.customId.replace('srr__add__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        const roleId = ids[0];
        if (panel.roles.some(r => r.id === roleId)) return interaction.reply({ content: '❌ Role already added.', ephemeral: true });
        srPendingRoleAdd.set(interaction.user.id, { panelId, roleId });
        const modal = new ModalBuilder().setCustomId(`modal_sr_rolelabel__${panelId}`).setTitle(panel.type === 'reaction' ? 'Configure Role Reaction' : 'Configure Role Button');
        if (panel.type === 'reaction') {
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_reaction').setLabel('Reaction emoji (e.g. ✅)').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_label').setLabel('Label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_desc').setLabel('Description (optional)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
          );
        } else {
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_label').setLabel('Button label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_emoji').setLabel('Emoji (optional, e.g. 🔔)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_rl_desc').setLabel('Description (optional)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
          );
        }
        return interaction.showModal(modal);
      }
    }

    // ── CHANNEL SELECT MENUS ──
    if (interaction.isChannelSelectMenu()) {
      if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
      const chId = interaction.values[0];
      if (interaction.customId === 'td_transcript') { getTicketConfig(guildId).transcriptChannel = chId; saveConfig(config); return interaction.reply({ content: `✅ Transcript: <#${chId}>`, ephemeral: true }); }
      if (interaction.customId === 'td_channel')    { getTicketConfig(guildId).ticketChannel = chId; saveConfig(config); return interaction.reply({ content: `✅ Panel channel: <#${chId}>`, ephemeral: true }); }
      if (interaction.customId === 'td_category')   { getTicketConfig(guildId).ticketCategory = chId; saveConfig(config); return interaction.reply({ content: `✅ Category: <#${chId}>`, ephemeral: true }); }
      if (interaction.customId === 'sd_channel')    { getSessionConfig(guildId).channel = chId; saveConfig(config); return interaction.reply({ content: `✅ Session channel: <#${chId}>`, ephemeral: true }); }
      if (interaction.customId.startsWith('srch__')) {
        const panelId = interaction.customId.replace('srch__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        panel.channel = chId;
        saveConfig(config);
        return interaction.reply({ content: `✅ Channel set to <#${chId}>.`, ephemeral: true });
      }
    }

    // ── STRING SELECT MENUS ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const val = interaction.values[0];
      if (id === 'sr_sel_edit') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const src = getSelfRoleConfig(guildId);
        if (!src.panels[val]) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        return interaction.update(buildPanelEditor(guildId, val));
      }
      if (id === 'sr_sel_delete') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const src = getSelfRoleConfig(guildId);
        delete src.panels[val];
        saveConfig(config);
        return interaction.update(buildSelfRoleOverview(guildId));
      }
      if (id.startsWith('sr_sel_rmrole__')) {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const panelId = id.replace('sr_sel_rmrole__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        panel.roles = panel.roles.filter(r => r.id !== val);
        saveConfig(config);
        return interaction.reply({ content: `✅ Role removed from **${panel.title}**.`, ephemeral: true });
      }
      if (id === 'td_remove_type') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', ephemeral: true });
        const tc = getTicketConfig(guildId);
        tc.ticketTypes = tc.ticketTypes.filter(t => t.id !== val);
        saveConfig(config);
        return interaction.reply({ content: '✅ Ticket type removed.', ephemeral: true });
      }
      if (id.startsWith('srp__dd__')) {
        const panelId = id.replace('srp__dd__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel no longer exists.', ephemeral: true });
        const selectedRoleIds = interaction.values;
        const allPanelRoleIds = panel.roles.map(r => r.id);
        const toRemove = interaction.member.roles.cache.filter(r => allPanelRoleIds.includes(r.id));
        if (toRemove.size > 0) await interaction.member.roles.remove(toRemove);
        const toAdd = selectedRoleIds.map(rid => interaction.guild.roles.cache.get(rid)).filter(Boolean);
        if (toAdd.length > 0) await interaction.member.roles.add(toAdd);
        return interaction.reply({ content: toAdd.length > 0 ? `✅ Updated your roles: ${toAdd.map(r => `**${r.name}**`).join(', ')}` : '✅ Removed all roles from this panel.', ephemeral: true });
      }
    }

    // ── MODALS ──
    if (interaction.isModalSubmit()) {
      const mid = interaction.customId;
      if (mid === 'modal_t_embed') {
        const tc = getTicketConfig(guildId);
        const t = interaction.fields.getTextInputValue('t_embed_title').trim();
        const d = interaction.fields.getTextInputValue('t_embed_desc').trim();
        const c = interaction.fields.getTextInputValue('t_embed_color').trim();
        const th = interaction.fields.getTextInputValue('t_embed_thumbnail').trim();
        if (t) tc.panelTitle = t;
        if (d) tc.panelDescription = d;
        if (c) tc.panelColor = c;
        if (th) tc.panelThumbnail = th;
        saveConfig(config);
        return interaction.reply({ content: '✅ Panel embed updated!', ephemeral: true });
      }
      if (mid === 'modal_t_welcome') {
        const tc = getTicketConfig(guildId);
        tc.welcomeText = interaction.fields.getTextInputValue('t_welcome_text').trim();
        saveConfig(config);
        return interaction.reply({ content: '✅ Welcome text saved!', ephemeral: true });
      }
      if (mid === 'modal_t_add_type') {
        const tc = getTicketConfig(guildId);
        const label = interaction.fields.getTextInputValue('tt_label').trim();
        const emoji = interaction.fields.getTextInputValue('tt_emoji').trim();
        const color = interaction.fields.getTextInputValue('tt_color').trim();
        const desc = interaction.fields.getTextInputValue('tt_description').trim();
        tc.ticketTypes.push({ id: genId(), label, emoji: emoji || null, color: color || 'blue', description: desc || null });
        saveConfig(config);
        return interaction.reply({ content: `✅ Type **${label}** added!`, ephemeral: true });
      }
      if (mid === 'modal_s_joinlink') {
        getSessionConfig(guildId).joinLink = interaction.fields.getTextInputValue('s_link_val').trim();
        saveConfig(config);
        return interaction.reply({ content: '✅ Join link saved!', ephemeral: true });
      }
      if (mid === 'modal_s_desc') {
        const sc = getSessionConfig(guildId);
        const s = interaction.fields.getTextInputValue('s_start_desc').trim();
        const v = interaction.fields.getTextInputValue('s_vote_desc').trim();
        const sh = interaction.fields.getTextInputValue('s_shutdown_desc').trim();
        if (s) sc.startDescription = s;
        if (v) sc.voteDescription = v;
        if (sh) sc.shutdownDescription = sh;
        saveConfig(config);
        return interaction.reply({ content: '✅ Descriptions saved!', ephemeral: true });
      }
      if (mid === 'modal_s_images') {
        const sc = getSessionConfig(guildId);
        const si = interaction.fields.getTextInputValue('s_start_img').trim();
        const vi = interaction.fields.getTextInputValue('s_vote_img').trim();
        const hi = interaction.fields.getTextInputValue('s_shutdown_img').trim();
        if (si) sc.startImage = si;
        if (vi) sc.voteImage = vi;
        if (hi) sc.shutdownImage = hi;
        saveConfig(config);
        return interaction.reply({ content: '✅ Images saved!', ephemeral: true });
      }
      if (mid === 'modal_sr_new') {
        const src = getSelfRoleConfig(guildId);
        const title = interaction.fields.getTextInputValue('sr_title').trim();
        const desc = interaction.fields.getTextInputValue('sr_desc').trim();
        const color = interaction.fields.getTextInputValue('sr_color').trim();
        const type = interaction.fields.getTextInputValue('sr_type').trim().toLowerCase();
        const maxIn = interaction.fields.getTextInputValue('sr_max').trim();
        const max = parseInt(maxIn, 10);
        if (!['buttons', 'dropdown', 'reaction'].includes(type)) return interaction.reply({ content: '❌ Type must be `buttons`, `dropdown`, or `reaction`.', ephemeral: true });
        const pid = genId();
        src.panels[pid] = { title, description: desc || null, color: color || null, thumbnail: null, channel: null, messageId: null, type, max: isNaN(max) ? 0 : max, roles: [] };
        saveConfig(config);
        return interaction.reply({ ...buildPanelEditor(guildId, pid), ephemeral: true });
      }
      if (mid.startsWith('modal_sr_embed__')) {
        const panelId = mid.replace('modal_sr_embed__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        const t = interaction.fields.getTextInputValue('sr_e_title').trim();
        const d = interaction.fields.getTextInputValue('sr_e_desc').trim();
        const c = interaction.fields.getTextInputValue('sr_e_color').trim();
        const th = interaction.fields.getTextInputValue('sr_e_thumbnail').trim();
        if (t) panel.title = t;
        if (d) panel.description = d;
        if (c) panel.color = c;
        if (th) panel.thumbnail = th;
        saveConfig(config);
        return interaction.reply({ content: '✅ Panel embed updated!', ephemeral: true });
      }
      if (mid.startsWith('modal_sr_rolelabel__')) {
        const panelId = mid.replace('modal_sr_rolelabel__', '');
        const src = getSelfRoleConfig(guildId);
        const panel = src.panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', ephemeral: true });
        const pending = srPendingRoleAdd.get(interaction.user.id);
        if (!pending || pending.panelId !== panelId) return interaction.reply({ content: '❌ Session expired, try again.', ephemeral: true });
        if (panel.type === 'reaction') {
          const reaction = interaction.fields.getTextInputValue('sr_rl_reaction').trim();
          const label = interaction.fields.getTextInputValue('sr_rl_label').trim();
          const desc = interaction.fields.getTextInputValue('sr_rl_desc').trim();
          panel.roles.push({ id: pending.roleId, label: label.slice(0, 80), reaction, description: desc || null });
        } else {
          const label = interaction.fields.getTextInputValue('sr_rl_label').trim();
          const emoji = interaction.fields.getTextInputValue('sr_rl_emoji').trim();
          const desc = interaction.fields.getTextInputValue('sr_rl_desc').trim();
          panel.roles.push({ id: pending.roleId, label: label.slice(0, 80), emoji: emoji || null, description: desc || null });
        }
        saveConfig(config);
        srPendingRoleAdd.delete(interaction.user.id);
        return interaction.reply({ content: `✅ Added <@&${pending.roleId}> to **${panel.title}**!`, ephemeral: true });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

client.login(process.env.TOKEN);
