require('dotenv').config();
const http = require('http');
const path     = require('path');
const mongoose = require('mongoose');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder,
  AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  Options,
} = require('discord.js');

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
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager:    50,   // max 50 berichten per kanaal (was onbeperkt)
    GuildMemberManager: 200, // max 200 members per guild in cache
    PresenceManager:   0,    // presences niet cachen (online teller doet fetch zelf)
    ReactionManager:   0,
    ReactionUserManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 }, // elke 5 min, berichten ouder dan 10 min weggooien
    guildMembers: { interval: 900, filter: () => member => !member.user?.bot && member.id !== member.guild.ownerId }, // elke 15 min niet-bot members opschonen
  },
});

// ════════════════════════════════════════════
// CONFIG — MONGODB PERSISTENT STORAGE
// ════════════════════════════════════════════

// MongoDB schema: één document per guild, plus één 'global' doc
const configSchema = new mongoose.Schema({
  _id:  { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { strict: false });

const ConfigModel = mongoose.model('Config', configSchema);

const ticketSchema = new mongoose.Schema({
  guildId:       { type: String, required: true, index: true },
  channelId:     { type: String, required: true, unique: true },
  creatorId:     { type: String, required: true },
  typeId:        { type: String, default: null },
  typeLabel:     { type: String, default: 'Support' },
  status:        { type: String, enum: ['open','closed','archived'], default: 'open' },
  claimedBy:     { type: String, default: null },
  staffMembers:  { type: [String], default: [] },
  priority:      { type: String, enum: ['low','normal','high','urgent'], default: 'normal' },
  notes:         { type: [{ authorId: String, text: String, createdAt: Date }], default: [] },
  createdAt:     { type: Date, default: Date.now },
  closedAt:      { type: Date, default: null },
  archivedAt:    { type: Date, default: null },
  autoCloseAt:   { type: Date, default: null },
  transcriptUrl: { type: String, default: null },
  metadata:      { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const TicketModel = mongoose.model('Ticket', ticketSchema);

async function createTicketRecord(data) {
  try {
    return await TicketModel.create(data);
  } catch (e) {
    console.error('createTicketRecord error:', e.message);
    return null;
  }
}

async function getTicketRecord(channelId) {
  try {
    return await TicketModel.findOne({ channelId });
  } catch (e) {
    console.error('getTicketRecord error:', e.message);
    return null;
  }
}

async function updateTicketRecord(channelId, update) {
  try {
    return await TicketModel.findOneAndUpdate({ channelId }, update, { returnDocument: 'after' });
  } catch (e) {
    console.error('updateTicketRecord error:', e.message);
    return null;
  }
}

// In-memory config cache (zelfde structuur als voorheen)
let config = {};
let dbReady = false;

// Verbinding maken met MongoDB
async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ FATAL: MONGODB_URI is not set. Bot cannot start without persistent storage.');
    process.exit(1);
  }
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

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected. Attempting reconnect...');
  dbReady = false;
});
mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected.');
  dbReady = true;
});

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
      { upsert: true, returnDocument: 'after' }
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
// (voor backwards-compat met alle bestaande await saveGuildConfig(guildId) calls)
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
  // Negeer alleen veilige Discord API errors die geen crash rechtvaardigen
  const SAFE_IGNORE = [10062, 40060, 10008];
  if (SAFE_IGNORE.includes(err?.code)) {
    console.warn('⚠️ Discord API warning (ignored):', err.message);
    return;
  }
  // 50013 (Missing Permissions) en 50035 (Invalid Form Body) duiden op bugs/misconfiguratie
  console.error('❌ Uncaught Exception:', err);
  await saveAllConfigs().catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // Negeer alleen veilige Discord API errors
  const SAFE_IGNORE = [10062, 40060, 10008];
  if (SAFE_IGNORE.includes(reason?.code)) {
    console.warn('⚠️ Discord API warning (ignored):', reason.message);
    return;
  }
  console.error('❌ Unhandled Rejection:', reason);
  saveAllConfigs().catch(() => {});
});

function createDefaultConfig(guildId) {
  config[guildId] = {};
  saveGuildConfig(guildId).catch(() => {});
  return config[guildId];
}

function getGuildConfig(guildId) {
  if (!config[guildId]) createDefaultConfig(guildId);
  return config[guildId];
}

function getGuildLogoUrl(guildId) {
  const gc = getGuildConfig(guildId);
  return gc.botConfig?.logoUrl || gc.logoUrl || '';
}

async function updateSetting(guildId, key, value) {
  const gc = getGuildConfig(guildId);
  gc[key] = value;
  await saveGuildConfig(guildId);
}

function getHandbookConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.handbooks) gc.handbooks = { panels: {} }; // panelId → { title, description, color, channel, messageId, books: [{ id, label, url, requiredRoles[] }] }
  return gc.handbooks;
}

function getTicketConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticket) gc.ticket = { pingRoles: [], transcriptChannel: null, ticketChannel: null, ticketCategory: null, panelTitle: '🎫 Support Tickets', panelDescription: 'Click a button below to open a support ticket.', panelColor: '#5865F2', panelThumbnail: null, welcomeText: 'Hello {user}, thank you for opening a ticket!', ticketTypes: [] };
  // Fallback to main server for ticket types and global settings if not set locally
  if (!isMainServer(guildId)) {
    const mainTicket = getMainConfig('ticket');
    if (mainTicket) {
      if (!gc.ticket.ticketTypes?.length)   gc.ticket.ticketTypes   = mainTicket.ticketTypes   ?? [];
      if (!gc.ticket.pingRoles?.length)     gc.ticket.pingRoles     = mainTicket.pingRoles     ?? [];
      if (!gc.ticket.welcomeText)           gc.ticket.welcomeText   = mainTicket.welcomeText   ?? 'Hello {user}, thank you for opening a ticket!';
      if (!gc.ticket.panelTitle)            gc.ticket.panelTitle    = mainTicket.panelTitle    ?? '🎫 Support Tickets';
      if (!gc.ticket.panelDescription)      gc.ticket.panelDescription = mainTicket.panelDescription ?? 'Click a button below to open a support ticket.';
      if (!gc.ticket.panelColor)            gc.ticket.panelColor    = mainTicket.panelColor    ?? '#5865F2';
    }
  }
  // Patch bestaande types
  for (const t of gc.ticket.ticketTypes) {
    if (!t.requiredRoles)        t.requiredRoles        = [];
    if (!t.viewRoles)            t.viewRoles            = [];
    if (!t.category)             t.category             = null;
    // Per-type overrides (null = use global)
    if (t.welcomeText        === undefined) t.welcomeText        = null;
    if (t.pingRoles          === undefined) t.pingRoles          = null; // null = use global
    if (t.transcriptChannel  === undefined) t.transcriptChannel  = null;
    if (t.embedColor         === undefined) t.embedColor         = null;
    if (t.embedImage         === undefined) t.embedImage         = null;
    if (t.closeMessage       === undefined) t.closeMessage       = null;
    if (t.dmOnOpen           === undefined) t.dmOnOpen           = null; // null = use global setting
    if (t.panelTitle         === undefined) t.panelTitle         = null;
    if (t.panelDescription   === undefined) t.panelDescription   = null;
    if (t.maxOpen            === undefined) t.maxOpen            = null;
    if (t.cooldownMinutes    === undefined) t.cooldownMinutes    = null;
    if (t.logChannel         === undefined) t.logChannel         = null;
    if (t.autoCloseHours     === undefined) t.autoCloseHours     = null; // null = disabled
    // Per-type pre-check (null = use global)
    if (t.preCheck           === undefined) t.preCheck           = {
      enabled:        null,
      rulesText:      null,
      minimumAmount:  null,
      amountLabel:    null,
      amountDenialMessage: null,
    };
    // Per-type intake form fields (array of { id, label, placeholder, required, style })
    if (!Array.isArray(t.intakeFields)) t.intakeFields = [];
    // Patch bestaande velden met ontbrekende properties
    for (const f of t.intakeFields) {
      if (!f.id)                    f.id          = genId();
      if (typeof f.label !== 'string') f.label    = 'Field';
      if (f.placeholder === undefined) f.placeholder = null;
      if (typeof f.required !== 'boolean') f.required = true;
      if (!f.style)                 f.style       = 'short';
    }
  }
  return gc.ticket;
}
function getQOTDConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.qotd) gc.qotd = {};
  const q = gc.qotd;

  // Core settings
  if (typeof q.enabled      !== 'boolean') q.enabled      = false;
  if (!q.channel)                          q.channel      = null;
  if (!q.time)                             q.time         = '09:00';
  if (!q.timezone)                         q.timezone     = 'UTC';
  if (!q.pingRole)                         q.pingRole     = null;
  if (typeof q.autoGenerate !== 'boolean') q.autoGenerate = false;
  if (!q.lastPosted)                       q.lastPosted   = null;
  if (!q.lastQuestion)                     q.lastQuestion = null;

  // Question library — each entry: { id, text, used, createdAt, lastUsedAt, usageCount }
  if (!Array.isArray(q.library))   q.library   = [];
  // Shuffle queue — array of ids in randomized order, popped from front
  if (!Array.isArray(q.queue))     q.queue     = [];
  // Behavior when all questions used: 'reshuffle' | 'stop'
  if (!q.onExhaust)                q.onExhaust = 'reshuffle';

  return q;
}

// Fisher-Yates shuffle
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQOTDQueue(qc) {
  // Build queue from unused questions, shuffled
  const unused = qc.library.filter(q => !q.used).map(q => q.id);
  if (!unused.length) return [];
  const shuffled = shuffleArray(unused);
  // Prevent immediate repeat — if last question is first in new queue, move it
  if (qc.lastQuestion && shuffled[0] === qc.lastQuestion && shuffled.length > 1) {
    const last = shuffled.shift();
    shuffled.push(last);
  }
  return shuffled;
}

function getNextQOTDQuestion(qc) {
  // Ensure queue is populated
  if (!qc.queue.length) {
    if (qc.onExhaust === 'stop') return null;
    // Mark all as unused and rebuild
    for (const q of qc.library) {
      q.used = false;
    }
    qc.queue = buildQOTDQueue(qc);
    if (!qc.queue.length) return null;
  }
  const id = qc.queue.shift();
  const question = qc.library.find(q => q.id === id);
  if (!question) return getNextQOTDQuestion(qc); // skip deleted
  // Mark as used
  question.used      = true;
  question.lastUsedAt = new Date().toISOString();
  question.usageCount = (question.usageCount ?? 0) + 1;
  return question;
}

function getTicketInactivityConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticketInactivity) gc.ticketInactivity = {
    enabled: false,
    warnAfterMinutes: 1440,   // 24 hours
    closeAfterMinutes: 2880,  // 48 hours
    warnMessage: '⚠️ This ticket has been inactive for {time}. It will be closed automatically in {closeIn} if there is no response.',
    dmOnClose: true,
  };
  return gc.ticketInactivity;
}

function getStaffRankConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.staffRanks) gc.staffRanks = { ranks: [] };
  if (!Array.isArray(gc.staffRanks.ranks)) gc.staffRanks.ranks = [];
  return gc.staffRanks;
}

function getMemberRankLevel(member, guildId) {
  const src = getStaffRankConfig(guildId);
  let highest = 0;
  for (const rank of src.ranks) {
    if (rank.roleId && member.roles.cache.has(rank.roleId)) {
      if (rank.level > highest) highest = rank.level;
    }
  }
  return highest;
}

function meetsMinimumRank(member, guildId, minimumLevel) {
  if (!minimumLevel || minimumLevel <= 0) return true;
  if (isFoundership(member) || hasSetup(member)) return true;
  return getMemberRankLevel(member, guildId) >= minimumLevel;
}

function getTicketV2Config(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticketV2) gc.ticketV2 = { logChannel: null, transcriptChannel: null, types: [], openTickets: {} };
  if (!gc.ticketV2.types)       gc.ticketV2.types       = [];
  if (!gc.ticketV2.openTickets) gc.ticketV2.openTickets = {};
  return gc.ticketV2;
}

function getTicketRatingConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticketRating) gc.ticketRating = {
    enabled: false,
    logChannel: null,
    publicChannel: null,
  };
  if (typeof gc.ticketRating.enabled !== 'boolean') gc.ticketRating.enabled = false;
  if (!gc.ticketRating.logChannel)    gc.ticketRating.logChannel    = null;
  if (!gc.ticketRating.publicChannel) gc.ticketRating.publicChannel = null;
  return gc.ticketRating;
}

function getTicketPreCheckConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.ticketPreCheck) gc.ticketPreCheck = {};
  const pc = gc.ticketPreCheck;

  // Sanitize every field — MongoDB Mixed type can return anything
  if (typeof pc.enabled !== 'boolean')                pc.enabled       = false;
  if (typeof pc.rulesText !== 'string' || !pc.rulesText)
                                                       pc.rulesText     = 'By opening a ticket you agree to follow all server rules.';
  if (typeof pc.minimumAmount !== 'number' || isNaN(pc.minimumAmount))
                                                       pc.minimumAmount = 0;
  if (typeof pc.amountLabel !== 'string' || !pc.amountLabel)
                                                       pc.amountLabel   = 'Amount';
  if (typeof pc.amountDenialMessage !== 'string' || !pc.amountDenialMessage)
                                                       pc.amountDenialMessage = 'You do not meet the minimum {amountLabel} requirement ({required} required, you have {current}).';

  // Hard-cap lengths so setValue never throws
  pc.rulesText            = pc.rulesText.slice(0, 1000);
  pc.amountLabel          = pc.amountLabel.slice(0, 40);
  pc.amountDenialMessage  = pc.amountDenialMessage.slice(0, 800);

  return pc;
}

// Resolve per-type ticket setting, falling back to global
function resolveTicketSetting(type, tc, pc, key) {
  switch (key) {
    case 'welcomeText':       return type.welcomeText       ?? tc.welcomeText ?? 'Hello {user}, thank you for opening a ticket!';
    case 'pingRoles':         return Array.isArray(type.pingRoles) ? type.pingRoles : (tc.pingRoles ?? []);
    case 'transcriptChannel': return type.transcriptChannel ?? tc.transcriptChannel ?? null;
    case 'embedColor':        return type.embedColor        ?? tc.panelColor  ?? '#5865F2';
    case 'embedImage':        return type.embedImage        ?? null;
    case 'closeMessage':      return type.closeMessage      ?? '🔒 Closing in 3 seconds...';
    case 'dmOnOpen':          return type.dmOnOpen          ?? false;
    case 'panelTitle':        return type.panelTitle        ?? tc.panelTitle  ?? '🎫 Support Tickets';
    case 'panelDescription':  return type.panelDescription  ?? tc.panelDescription ?? 'Click a button below.';
    case 'preCheck.enabled':        return type.preCheck?.enabled        ?? pc.enabled        ?? false;
    case 'preCheck.rulesText':      return type.preCheck?.rulesText      ?? pc.rulesText      ?? 'By opening a ticket you agree to follow all server rules.';
    case 'preCheck.minimumAmount':  return type.preCheck?.minimumAmount  ?? pc.minimumAmount  ?? 0;
    case 'preCheck.amountLabel':    return type.preCheck?.amountLabel    ?? pc.amountLabel    ?? 'Amount';
    case 'preCheck.amountDenialMessage': return type.preCheck?.amountDenialMessage ?? pc.amountDenialMessage ?? 'You do not meet the minimum {amountLabel} requirement ({required} required, you have {current}).';
    default: return null;
  }
}

// Safe DM helper — never crashes the bot
async function safeDM(user, payload) {
  try {
    const dm = await user.createDM();
    await dm.send(payload);
    return true;
  } catch {
    return false;
  }
}

function getSessionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.session) gc.session = { channel: null, pingRoles: [], allowedRoles: [], joinLink: null, startImage: null, startDescription: null, voteImage: null, voteDescription: null, shutdownImage: null, shutdownDescription: null, voteThreshold: 5 };
  if (gc.session.voteThreshold === undefined) gc.session.voteThreshold = 5;
  if (!isMainServer(guildId)) {
    const mainSession = getMainConfig('session');
    if (mainSession) {
      if (!gc.session.pingRoles?.length)    gc.session.pingRoles    = mainSession.pingRoles    ?? [];
      if (!gc.session.allowedRoles?.length) gc.session.allowedRoles = mainSession.allowedRoles ?? [];
      if (!gc.session.joinLink)             gc.session.joinLink     = mainSession.joinLink     ?? null;
      if (!gc.session.voteThreshold)        gc.session.voteThreshold = mainSession.voteThreshold ?? 5;
      if (!gc.session.startDescription)     gc.session.startDescription  = mainSession.startDescription  ?? null;
      if (!gc.session.voteDescription)      gc.session.voteDescription   = mainSession.voteDescription   ?? null;
      if (!gc.session.shutdownDescription)  gc.session.shutdownDescription = mainSession.shutdownDescription ?? null;
      if (!gc.session.startImage)           gc.session.startImage   = mainSession.startImage   ?? null;
      if (!gc.session.voteImage)            gc.session.voteImage    = mainSession.voteImage    ?? null;
      if (!gc.session.shutdownImage)        gc.session.shutdownImage = mainSession.shutdownImage ?? null;
    }
  }
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
    transcriptChannel: null,
    appTypes: [],
    submissions: {},
  };
  if (gc.applications.transcriptChannel === undefined) gc.applications.transcriptChannel = null;
  if (!gc.applications.submissions) gc.applications.submissions = {};
  if (!isMainServer(guildId)) {
    const mainApps = getMainConfig('applications');
    if (mainApps) {
      if (!gc.applications.appTypes?.length)  gc.applications.appTypes  = mainApps.appTypes  ?? [];
      if (!gc.applications.panels?.length)    gc.applications.panels    = mainApps.panels    ?? [];
      if (!gc.applications.reviewChannel)     gc.applications.reviewChannel = mainApps.reviewChannel ?? null;
    }
  }
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
function getAntipingConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.antiping) gc.antiping = {
    enabled: false,
    exemptRoles: [],
    exemptChannels: [],
    action: 'delete', // 'delete' | 'delete+warn' | 'delete+mute'
    muteMinutes: 5,
    logChannel: null,
    warnMessage: '⚠️ {user}, you are not allowed to ping @everyone or @here in this server.',
  };
  return gc.antiping;
}

function getRolePingProtectionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.rolePingProtection) gc.rolePingProtection = {
    enabled: false,
    protectedRoles: [],   // role IDs die niet gepingd mogen worden
    allowedRoles: [],     // role IDs die WEL mogen pingen
    allowedUsers: [],     // user IDs die WEL mogen pingen (whitelist)
    action: 'delete',     // 'delete' | 'delete+warn' | 'delete+mute'
    muteMinutes: 5,
    logChannel: null,
    warnMessage: '⚠️ {user}, you are not allowed to ping {role}.',
  };
  return gc.rolePingProtection;
}

function getAutomodConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.automod) gc.automod = { enabled: false, keywords: [], logChannel: null, action: 'delete', muteMinutes: 5 };
  return gc.automod;
}


function getVoteConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.voteSystem) gc.voteSystem = { mainServer: false, logChannel: null };
  return gc.voteSystem;
}

function getGlobalAnnouncementConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.globalAnnouncement) gc.globalAnnouncement = { announcementChannel: null, announcementPingRoles: [] };
  return gc.globalAnnouncement;
}

async function logTicketAction(guild, guildId, action, data = {}) {
  try {
    const tc = getTicketConfig(guildId);
    const logChId = data.logChannel ?? tc.transcriptChannel ?? null;
    if (!logChId) return;
    const ch = guild.channels.cache.get(logChId);
    if (!ch) return;
    const colorMap = {
      created: 0x57F287, claimed: 0x5865F2, unclaimed: 0xFEE75C,
      closed: 0xED4245, reopened: 0x57F287, archived: 0x99AAB5,
      deleted: 0xED4245, staff_added: 0x57F287, staff_removed: 0xED4245,
      renamed: 0x5865F2, transferred: 0xFEE75C, priority: 0xEB459E,
    };
    const embed = new EmbedBuilder()
      .setTitle(`🎫 Ticket ${action.charAt(0).toUpperCase() + action.slice(1).replace('_', ' ')}`)
      .setColor(colorMap[action] ?? 0x5865F2)
      .setTimestamp();
    if (data.channel)   embed.addFields({ name: '📋 Channel',   value: embedSafe.fieldVal(data.channel),   inline: true });
    if (data.user)      embed.addFields({ name: '👤 User',       value: embedSafe.fieldVal(data.user),      inline: true });
    if (data.staff)     embed.addFields({ name: '👮 Staff',      value: embedSafe.fieldVal(data.staff),     inline: true });
    if (data.type)      embed.addFields({ name: '🎫 Type',       value: embedSafe.fieldVal(data.type),      inline: true });
    if (data.reason)    embed.addFields({ name: '📝 Reason',     value: embedSafe.fieldVal(data.reason),    inline: false });
    if (data.extra)     embed.addFields({ name: 'ℹ️ Info',       value: embedSafe.fieldVal(data.extra),     inline: false });
    await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

async function postQOTD(guild, guildId, force = false) {
  const qc = getQOTDConfig(guildId);
  if (!qc.enabled && !force) return;
  if (!qc.channel) throw new Error('No QOTD channel set.');

  const ch = guild.channels.cache.get(qc.channel);
  if (!ch) throw new Error('QOTD channel not found.');

  const today = new Date().toISOString().slice(0, 10);
  if (!force && qc.lastPosted === today) return;

  let questionText = null;

  if (qc.autoGenerate) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `Generate ONE fun, engaging "Question of the Day" for a Discord community server called "${guild.name}". Make it conversational, interesting and suitable for all ages. Return ONLY the question itself, nothing else.`,
          }],
        }),
      });
      if (!res.ok) {
        console.error('QOTD AI generation HTTP error:', res.status, await res.text().catch(() => ''));
      } else {
        const data = await res.json();
        questionText = data.content?.[0]?.text?.trim() ?? null;
      }
    } catch (e) {
      console.error('QOTD AI generation error:', e);
    }
  }

  // Use library queue if no AI question
  if (!questionText) {
    const entry = getNextQOTDQuestion(qc);
    if (!entry) throw new Error(qc.onExhaust === 'stop' ? 'All questions have been used. Reset usage to continue.' : 'No questions available.');
    questionText      = entry.text;
    qc.lastQuestion   = entry.id;
  }

  const unusedCount = qc.library.filter(q => !q.used).length;
  const totalCount  = qc.library.length;

  const embed = new EmbedBuilder()
    .setTitle('❓ Question of the Day')
    .setDescription(embedSafe.desc(`**${questionText}**`))
    .setColor(0xEB459E)
    .setFooter({ text: `${new Date().toDateString()} • ${unusedCount} questions remaining` })
    .setTimestamp();

  const ping = qc.pingRole ? `<@&${qc.pingRole}>` : null;
  const msg = await ch.send({ content: ping ?? undefined, embeds: [embed] });

  try {
    await msg.startThread({
      name: `QOTD ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      autoArchiveDuration: 1440,
    });
  } catch {}

  qc.lastPosted   = today;
  await saveGuildConfig(guildId);
}

async function broadcastVoteSuccess(question, voteId) {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      if (!guild) continue;
      const gac = getGlobalAnnouncementConfig(guildId);
      if (!gac.announcementChannel) continue;
      const ch = guild.channels.cache.get(gac.announcementChannel);
      if (!ch) continue;
      const pingContent = gac.announcementPingRoles?.length
        ? gac.announcementPingRoles.map(r => `<@&${r}>`).join(' ')
        : undefined;
      const embed = new EmbedBuilder()
        .setTitle('✅ Vote Passed!')
        .setColor(0x57F287)
        .setDescription(embedSafe.desc(`**${question}**\n\nA vote has passed across all servers.`))
        .setFooter({ text: `Vote ID: ${voteId}` })
        .setTimestamp();
      await ch.send({ content: pingContent, embeds: [embed] }).catch(() => {});
    } catch { /* skip guild on error */ }
  }
}

function getLOAConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.loa) gc.loa = {
    approvalRoles: [],
    loaRole: null,
    logChannel: null,
    prefix: '[LOA]',
    requiredApprovals: 1,
    active: {},
  };
  return gc.loa;
}

function getInfractionConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.infractions) gc.infractions = {
    // Progression: levels 1-3 = Warning 1-3, levels 4-6 = Strike 1-3, level 7 = Termination
    // hierarchy[i].roleId — optional role to assign at progression level i+1 (i = 0..6)
    hierarchy:          [],
    logChannel:         null,
    embedTitle:         '⚠️ {levelLabel} — {username}',
    embedDescription:   '**{userMention}** has received **{levelLabel}** ({type}).\n\n**Reason:** {reason}\n**Moderator:** {moderator}',
    embedColor:         '#ED4245',
    dmMessage:          '⚠️ You have received **{levelLabel}** in **{server}**.\n\n**Type:** {type}\n**Reason:** {reason}\n\nIf you have questions, please contact a staff member.',
    terminationMessage: '🚨 **{userMention}** has reached **Termination** ({progressionLevel}/{maxLevel}).\n\nStaff action is required.',
    userStrikes:        {}, // userId → number (0-7, progression level reached)
    userHistory:        {}, // userId → [{ type, reason, moderator, date, level }]
  };
  if (!gc.infractions.hierarchy)          gc.infractions.hierarchy          = [];
  if (!gc.infractions.userStrikes)        gc.infractions.userStrikes        = {};
  if (!gc.infractions.userHistory)        gc.infractions.userHistory        = {};
  if (!gc.infractions.logChannel)         gc.infractions.logChannel         = null;
  if (!gc.infractions.embedTitle)         gc.infractions.embedTitle         = '⚠️ {levelLabel} — {username}';
  if (!gc.infractions.embedDescription)   gc.infractions.embedDescription   = '**{userMention}** has received **{levelLabel}** ({type}).\n\n**Reason:** {reason}\n**Moderator:** {moderator}';
  if (!gc.infractions.embedColor)         gc.infractions.embedColor         = '#ED4245';
  if (!gc.infractions.dmMessage)          gc.infractions.dmMessage          = '⚠️ You have received **{levelLabel}** in **{server}**.\n\n**Type:** {type}\n**Reason:** {reason}\n\nIf you have questions, please contact a staff member.';
  if (!gc.infractions.terminationMessage) gc.infractions.terminationMessage = '🚨 **{userMention}** has reached **Termination** ({progressionLevel}/{maxLevel}).\n\nStaff action is required.';
  return gc.infractions;
}

// Fixed progression: Warning 1-3 (levels 1-3), Strike 1-3 (levels 4-6), Termination (level 7)
const INFRACTION_PROGRESSION = [
  { label: 'Warning 1',   category: 'Warning' },
  { label: 'Warning 2',   category: 'Warning' },
  { label: 'Warning 3',   category: 'Warning' },
  { label: 'Strike 1',    category: 'Strike' },
  { label: 'Strike 2',    category: 'Strike' },
  { label: 'Strike 3',    category: 'Strike' },
  { label: 'Termination', category: 'Termination' },
];
function getProgressionEntry(level) {
  const idx = Math.max(0, Math.min(level - 1, INFRACTION_PROGRESSION.length - 1));
  return INFRACTION_PROGRESSION[idx];
}

// Removes all progression-level roles from a member, then assigns the role for `level` (if any).
// `level` is 1-7 (Termination = 7). level <= 0 means no role assigned.
async function applyInfractionLevelRole(member, ic, level) {
  for (const entry of ic.hierarchy) {
    if (entry?.roleId && member.roles.cache.has(entry.roleId)) {
      await member.roles.remove(entry.roleId).catch(() => {});
    }
  }
  if (level >= 1) {
    const roleId = ic.hierarchy[level - 1]?.roleId;
    if (roleId) {
      const role = member.guild.roles.cache.get(roleId);
      if (role) await member.roles.add(role).catch(() => {});
    }
  }
}

function getPermissionsConfig(guildId) {
  if (!guildId) return { adminRoles: [], modRoles: [], staffRoles: [], shrRoles: [] };
  const gc = getGuildConfig(guildId);
  if (!gc.permissions) gc.permissions = { adminRoles: [], modRoles: [], staffRoles: [], shrRoles: [] };
  if (!isMainServer(guildId)) {
    const mainPerms = getMainConfig('permissions');
    if (mainPerms) {
      if (!gc.permissions.adminRoles?.length) gc.permissions.adminRoles = mainPerms.adminRoles ?? [];
      if (!gc.permissions.modRoles?.length)   gc.permissions.modRoles   = mainPerms.modRoles   ?? [];
      if (!gc.permissions.staffRoles?.length) gc.permissions.staffRoles = mainPerms.staffRoles ?? [];
      if (!gc.permissions.shrRoles?.length)   gc.permissions.shrRoles   = mainPerms.shrRoles   ?? [];
    }
  }
  return gc.permissions;
}

function getDepartmentsConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.departments) gc.departments = {
    isMainServer: false,
    departments: [],  // [{ id, name, guildId, announcementChannelId }]
  };
  if (!Array.isArray(gc.departments.departments)) gc.departments.departments = [];
  return gc.departments;
}

// Returns the departments list from whichever guild is configured as main server
function getMainServerDepartments() {
  for (const [gId, gc] of Object.entries(config)) {
    if (gc.departments?.isMainServer) return gc.departments.departments ?? [];
  }
  return [];
}

// Returns the main server guildId
function getMainServerId() {
  for (const [gId, gc] of Object.entries(config)) {
    if (gc.departments?.isMainServer) return gId;
  }
  return null;
}

// Returns main server config for a given key, used as fallback
function getMainConfig(key) {
  const mainId = getMainServerId();
  if (!mainId || !config[mainId]) return null;
  return config[mainId][key] ?? null;
}

// Resolves a guild config value with fallback to main server
function resolveConfig(guildId, key) {
  const local = config[guildId]?.[key];
  if (local !== undefined && local !== null) return local;
  return getMainConfig(key);
}

// Haal dept-lokale override op, of main server waarde als fallback
function getDeptValue(guildId, path) {
  const keys = path.split('.');
  let local = config[guildId];
  for (const k of keys) { if (local == null) break; local = local[k]; }
  if (local != null && local !== '' && !(Array.isArray(local) && local.length === 0)) return local;
  const mainId = getMainServerId();
  if (!mainId || mainId === guildId) return local;
  let main = config[mainId];
  for (const k of keys) { if (main == null) break; main = main[k]; }
  return main ?? local;
}
async function setDeptValue(guildId, path, value) {
  const keys = path.split('.');
  let obj = config[guildId];
  if (!obj) { config[guildId] = {}; obj = config[guildId]; }
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  await saveGuildConfig(guildId);
}

// Sends announcement to all department servers after a successful vote
async function sendCrossServerAnnouncement(hostUser, joinLink, voterMentions) {
  const depts = getMainServerDepartments();
  for (const dept of depts) {
    try {
      // Bot uses webhook if available, falls back to bot being in guild
      const guild = client.guilds.cache.get(dept.guildId);
      const webhookUrl = dept.webhookUrl;

      // Try webhook first (works without bot being in server)
      if (webhookUrl && isValidUrl(webhookUrl)) {
        const embed = {
          title: '🟢 Session Started!',
          description: `A session has been started by **${typeof hostUser === "string" ? hostUser : userDisplay(hostUser)}**!`,
          fields: [{ name: '🗳️ Voted by', value: voterMentions || '*Vote passed*', inline: false }],
          color: 0x57F287,
          timestamp: new Date().toISOString(),
        };
        const body = { embeds: [embed] };
        if (joinLink && isValidUrl(joinLink)) body.content = `[🚀 Join Session](${joinLink})`;
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {});
        continue;
      }

      // Fallback: bot must be in guild
      if (!guild) continue;
      const ch = guild.channels.cache.get(dept.announcementChannelId);
      if (!ch) continue;
      const embed = new EmbedBuilder()
        .setTitle('🟢 Session Started!')
        .setColor(0x57F287)
        .setDescription(`A session has been started by **${typeof hostUser === "string" ? hostUser : userDisplay(hostUser)}**!`)
        .addFields({ name: '🗳️ Voted by', value: voterMentions || '*Vote passed*', inline: false })
        .setTimestamp();
      const comps = [];
      if (joinLink && isValidUrl(joinLink)) {
        comps.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(joinLink.trim())
        ));
      }
      await ch.send({ embeds: [embed], components: comps }).catch(() => {});
    } catch { /* skip on error */ }
  }
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
    case 'members': { return guild.memberCount; }
    case 'bots':    { return guild.members.cache.filter(m => m.user.bot).size; }
    case 'online':  { return guild.members.cache.filter(m => !m.user.bot && m.presence && ['online', 'idle', 'dnd'].includes(m.presence.status)).size; }
    case 'channels': return guild.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).size;
    case 'roles':    return guild.roles.cache.size - 1;
    default: return 0;
  }
}
async function updateCounters(guild) {
  const cc = getCounterConfig(guild.id);
  if (!cc.enabled) return;
  // Only fetch all members when the 'online' counter is enabled (requires presence cache)
  // For member/bot/channel/role counts we can use cached values to avoid opcode 8 rate limits
  const needsOnline = cc.channels.online?.enabled && cc.channels.online?.channelId;
  if (needsOnline) {
    try { await guild.members.fetch(); } catch (e) { console.error('Member fetch error:', e); }
  }
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
setInterval(async () => {
  if (!dbReady) return;
  for (const guild of client.guilds.cache.values()) {
    await updateCounters(guild).catch(console.error);
  }
}, 15 * 60 * 1000);

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
    await saveGuildConfig(guild.id);
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
    const sel = new StringSelectMenuBuilder().setCustomId('hb__select_panel').setPlaceholder('Select panel to edit...').addOptions(panels.slice(0, 25).map(([id, p]) => ({ label: p.title, value: String(id) })));
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
    const sel = new StringSelectMenuBuilder().setCustomId(`hb__remove_book__${panelId}`).setPlaceholder('Remove a book...').addOptions(panel.books.slice(0, 25).map(b => ({ label: b.label, value: String(b.id) })));
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

function buildChainSetupPayload(guildId) {
  const cc = getChainConfig(guildId);
  const chain = cc.chain;
  const chainList = chain.length
    ? chain.map((e, i) => `**${i + 1}.** <@&${e.roleId}>`).join('\n')
    : '*No ranks configured yet.*';
  const promoteRolesList = cc.promoteRoles?.length
    ? cc.promoteRoles.map(id => `<@&${id}>`).join(', ')
    : '*None — only SHR can use /promote*';

  const embed = new EmbedBuilder()
    .setTitle('⛓️ Chain of Command Setup')
    .setColor(0xEB459E)
    .setDescription(
      'Configure the promotion chain. Ranks are ordered from lowest to highest.\n\n' +
      '**Current Chain:**\n' + chainList
    )
    .addFields(
      { name: '📋 Log Channel', value: cc.logChannel ? `<#${cc.logChannel}>` : '*Not set*', inline: true },
      { name: '📊 Total Ranks', value: `${chain.length}`, inline: true },
      { name: '🎖️ Promote Roles', value: promoteRolesList, inline: false },
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('coc_action')
    .setPlaceholder('Select an action...')
    .addOptions(
      { label: 'Add Rank', value: 'add_rank', emoji: '➕', description: 'Add a role to the chain' },
      { label: 'Remove Rank', value: 'remove_rank', emoji: '➖', description: 'Remove a role from the chain' },
      { label: 'Move Rank Up', value: 'move_up', emoji: '⬆️', description: 'Move a rank one position up' },
      { label: 'Move Rank Down', value: 'move_down', emoji: '⬇️', description: 'Move a rank one position down' },
      { label: 'Log Channel', value: 'log_channel', emoji: '📋', description: 'Set the promotion log channel' },
      { label: 'Promote Roles', value: 'promote_roles', emoji: '🎖️', description: 'Set who can use /promote (besides SHR)' },
      { label: 'Clear Chain', value: 'clear', emoji: '🗑️', description: 'Remove all ranks from the chain' },
    );

  const r1 = new ActionRowBuilder().addComponents(select);

  return { embeds: [embed], components: [r1], flags: MessageFlags.Ephemeral };
}

function buildStaffReviewSetupPayload(guildId) {
  const src = getStaffReviewConfig(guildId);

  // Compute overall stats
  const allReviews = Object.values(src.reviews ?? {}).flat();
  const totalCount = allReviews.length;
  const avgScore   = totalCount ? (allReviews.reduce((s, r) => s + r.rating, 0) / totalCount).toFixed(2) : null;

  const embed = new EmbedBuilder().setTitle('⭐ Staff Review Setup').setColor(0x5865F2)
    .addFields(
      { name: '📢 Review Channel',          value: src.channel ? `<#${src.channel}>` : '*Not set*',                                              inline: true },
      { name: '👮 Reviewable Staff Roles',  value: src.staffRoles.length ? src.staffRoles.map(r => `<@&${r}>`).join(', ') : '*Any staff member*', inline: true },
      { name: '📊 Total Reviews',           value: totalCount ? `${totalCount} review(s) — avg ⭐ ${avgScore}/5` : '*No reviews yet*',            inline: false },
    )
    .setDescription('Allow members to submit a star rating + written review for any staff member.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sr2_setup__channel').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('sr2_setup__staff_roles').setLabel('Staff Roles').setStyle(ButtonStyle.Primary).setEmoji('👮'),
    new ButtonBuilder().setCustomId('sr2_setup__leaderboard').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary).setEmoji('🏆'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildTrainingSetupPayload(guildId) {
  const tc = getTrainingConfig(guildId);
  const typesValue = tc.types.length
    ? tc.types.map(t => `• **${t.name}** → ${t.roleId ? `<@&${t.roleId}>` : '*No role set*'}`).join('\n')
    : '*No training types configured*';
  const embed = new EmbedBuilder().setTitle('🎓 Training Request Setup').setColor(0x5865F2)
    .addFields(
      { name: '📢 Request Channel', value: tc.channel ? `<#${tc.channel}>` : '*Not set*', inline: true },
      { name: '🔑 Trainer Roles', value: tc.trainerRoles.length ? tc.trainerRoles.map(r => `<@&${r}>`).join(', ') : '*Not set (setup only)*', inline: true },
      { name: '📋 Request Roles', value: tc.requestRoles.length ? tc.requestRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*', inline: true },
      { name: '🔔 Ping Roles', value: tc.pingRoles.length ? tc.pingRoles.map(r => `<@&${r}>`).join(', ') : '*None*', inline: true },
      { name: '📣 Announce Channel', value: tc.announceChannel ? `<#${tc.announceChannel}>` : '*Not set*', inline: true },
      { name: '💬 Announce Message', value: tc.announceMessage ? `\`${tc.announceMessage.slice(0, 80)}...\`` : '*Default*', inline: false },
      { name: '🎓 Training Types', value: typesValue, inline: false },
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
    new ButtonBuilder().setCustomId('tr_setup__add_type').setLabel('Add Training Type').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('tr_setup__remove_type').setLabel('Remove Type').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
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
async function addWarning(guildId, userId, warn) { const gc = getGuildConfig(guildId); if (!gc.warnings) gc.warnings = {}; if (!gc.warnings[userId]) gc.warnings[userId] = []; gc.warnings[userId].push(warn); await saveGuildConfig(guildId); }
async function clearWarnings(guildId, userId) { const gc = getGuildConfig(guildId); if (!gc.warnings) gc.warnings = {}; gc.warnings[userId] = []; await saveGuildConfig(guildId); }
function getNotes(guildId, userId) { const gc = getGuildConfig(guildId); if (!gc.notes) gc.notes = {}; if (!gc.notes[userId]) gc.notes[userId] = []; return gc.notes[userId]; }
async function addNote(guildId, userId, note) { const gc = getGuildConfig(guildId); if (!gc.notes) gc.notes = {}; if (!gc.notes[userId]) gc.notes[userId] = []; gc.notes[userId].push(note); await saveGuildConfig(guildId); }

// ════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════

function hasStaff(m) {
  if (!m?.roles?.cache) return false;
  const pc = getPermissionsConfig(m.guild?.id);
  if (pc.staffRoles?.length) return pc.staffRoles.some(id => m.roles.cache.has(id));
  return false;
}
function hasSHR(m) {
  if (!m?.roles?.cache) return false;
  const pc = getPermissionsConfig(m.guild?.id);
  if (pc.shrRoles?.length) return pc.shrRoles.some(id => m.roles.cache.has(id));
  return false;
}
function hasSetup(m) {
  if (!m) return false;
  try {
    // 1. Server owner always passes
    if (m.guild?.ownerId === m.id) return true;
    // 2. Configured admin roles
    const pc = getPermissionsConfig(m.guild?.id);
    if (pc.adminRoles?.length && m.roles?.cache) {
      if (pc.adminRoles.some(rid => m.roles.cache.has(rid))) return true;
    }
    // 3. Discord Administrator permission via member.permissions
    if (m.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    // 4. Check each role's permissions directly (most reliable in partner servers)
    if (m.roles?.cache) {
      for (const [, role] of m.roles.cache) {
        if (role.permissions?.has(PermissionFlagsBits.Administrator)) return true;
      }
    }
  } catch (e) {
    console.error('hasSetup error:', e);
  }
  return false;
}
function hasAnyStaff(m) { return hasStaff(m) || hasSHR(m) || hasSetup(m); }

function isMainServer(guildId) {
  const dc = getDepartmentsConfig(guildId);
  return dc.isMainServer === true;
}

// Returns true if this customId is a channel-select button (allowed in non-main servers)
function buildDepartmentSetupPayload(guildId) {
  const mainId = getMainServerId();
  const isMain = isMainServer(guildId);

  const fmt   = (arr) => arr?.length ? arr.map(r => `<@&${r}>`).join(', ') : '*Niet ingesteld*';
  const fmtCh = (id)  => id ? `<#${id}>` : '*Niet ingesteld*';
  const fmtFb = (id, fallbackId) => {
    if (id) return `<#${id}>`;
    if (fallbackId) return `<#${fallbackId}> *(van main)*`;
    return '*Niet ingesteld*';
  };
  const fmtRFb = (arr, fallbackArr) => {
    if (arr?.length) return arr.map(r => `<@&${r}>`).join(', ');
    if (fallbackArr?.length) return fallbackArr.map(r => `<@&${r}>`).join(', ') + ' *(van main)*';
    return '*Niet ingesteld*';
  };

  // Lokale waarden (alleen wat lokaal is ingesteld)
  const gc = config[guildId] ?? {};
  const mc = mainId && !isMain ? (config[mainId] ?? {}) : {};

  const embed1 = new EmbedBuilder()
    .setTitle('⚙️ Department Server Setup')
    .setColor(0x5865F2)
    .setDescription(
      `**Lokale instellingen** voor deze department server.\n` +
      `Waarden met *(van main)* worden overgenomen van de main server.\n` +
      `> Stel lokaal in om de main server instelling te overschrijven.`
    )
    .addFields(
      { name: '━━━ 🎫 Tickets ━━━',       value: '\u200b', inline: false },
      { name: '📬 Panel Channel',           value: fmtFb(gc.ticket?.ticketChannel, mc.ticket?.ticketChannel),         inline: true },
      { name: '📋 Transcript',              value: fmtFb(gc.ticket?.transcriptChannel, mc.ticket?.transcriptChannel), inline: true },
      { name: '📁 Category',               value: fmtFb(gc.ticket?.ticketCategory, mc.ticket?.ticketCategory),        inline: true },
      { name: '📢 Ping Roles',             value: fmtRFb(gc.ticket?.pingRoles, mc.ticket?.pingRoles),                 inline: true },
      { name: '━━━ 🎮 Sessions ━━━',      value: '\u200b', inline: false },
      { name: '📢 Session Channel',         value: fmtFb(gc.session?.channel, mc.session?.channel),                   inline: true },
      { name: '👥 Ping Roles',             value: fmtRFb(gc.session?.pingRoles, mc.session?.pingRoles),               inline: true },
      { name: '🔑 Allowed Roles',          value: fmtRFb(gc.session?.allowedRoles, mc.session?.allowedRoles),         inline: true },
      { name: '━━━ 👋 Welcomer ━━━',      value: '\u200b', inline: false },
      { name: '📢 Welcome Channel',         value: fmtFb(gc.welcomer?.channel, mc.welcomer?.channel),                 inline: true },
      { name: '✅ Enabled',                value: gc.welcomer?.enabled ? 'Ja' : mc.welcomer?.enabled ? 'Ja *(main)*' : 'Nee', inline: true },
      { name: '━━━ ✅ Verification ━━━',  value: '\u200b', inline: false },
      { name: '📢 Verify Channel',          value: fmtFb(gc.verification?.channel, mc.verification?.channel),         inline: true },
      { name: '🎭 Verified Role',           value: gc.verification?.verifiedRole ? `<@&${gc.verification.verifiedRole}>` : mc.verification?.verifiedRole ? `<@&${mc.verification.verifiedRole}> *(main)*` : '*Niet ingesteld*', inline: true },
      { name: '━━━ 📋 Applications ━━━',  value: '\u200b', inline: false },
      { name: '📢 Review Channel',          value: fmtFb(gc.applications?.reviewChannel, mc.applications?.reviewChannel), inline: true },
      { name: '📋 Log Channel',             value: fmtFb(gc.applications?.logChannel, mc.applications?.logChannel),   inline: true },
      { name: '━━━ 🎓 Training ━━━',      value: '\u200b', inline: false },
      { name: '📢 Request Channel',         value: fmtFb(gc.training?.channel, mc.training?.channel),                 inline: true },
      { name: '📣 Announce Channel',        value: fmtFb(gc.training?.announceChannel, mc.training?.announceChannel), inline: true },
      { name: '🔑 Trainer Roles',           value: fmtRFb(gc.training?.trainerRoles, mc.training?.trainerRoles),     inline: true },
      { name: '📋 Request Roles',           value: fmtRFb(gc.training?.requestRoles, mc.training?.requestRoles),      inline: true },
      { name: '━━━ 🏖️ LOA ━━━',           value: '\u200b', inline: false },
      { name: '🎭 LOA Role',                value: gc.loa?.loaRole ? `<@&${gc.loa.loaRole}>` : mc.loa?.loaRole ? `<@&${mc.loa.loaRole}> *(main)*` : '*Niet ingesteld*', inline: true },
    );

  const embed2 = new EmbedBuilder()
    .setColor(0x5865F2)
    .addFields(
      { name: '🔑 Approval Roles',         value: fmtRFb(gc.loa?.approvalRoles, mc.loa?.approvalRoles),             inline: true },
      { name: '📋 Log Channel',             value: fmtFb(gc.loa?.logChannel, mc.loa?.logChannel),                    inline: true },
      { name: '━━━ 🎭 Autorole ━━━',      value: '\u200b', inline: false },
      { name: '✅ Enabled',                value: gc.autorole?.enabled ? 'Ja' : mc.autorole?.enabled ? 'Ja *(main)*' : 'Nee', inline: true },
      { name: '🎭 Roles',                  value: fmtRFb(gc.autorole?.roles, mc.autorole?.roles),                    inline: true },
      { name: '━━━ 👑 Permissions ━━━',   value: '\u200b', inline: false },
      { name: '👑 Admin Roles',            value: fmtRFb(gc.permissions?.adminRoles, mc.permissions?.adminRoles),    inline: true },
      { name: '🛡️ Mod Roles',             value: fmtRFb(gc.permissions?.modRoles, mc.permissions?.modRoles),        inline: true },
      { name: '👤 Staff Roles',            value: fmtRFb(gc.permissions?.staffRoles, mc.permissions?.staffRoles),    inline: true },
      { name: '⭐ SHR Roles',              value: fmtRFb(gc.permissions?.shrRoles, mc.permissions?.shrRoles),        inline: true },
      { name: '━━━ 📡 ERLC ━━━',          value: '\u200b', inline: false },
      { name: '🔨 Kick/Ban',               value: fmtFb(gc.erlcLogs?.kickBans, mc.erlcLogs?.kickBans),              inline: true },
      { name: '📥 Join/Leave',             value: fmtFb(gc.erlcLogs?.joinLeave, mc.erlcLogs?.joinLeave),            inline: true },
      { name: '⌨️ Commands',               value: fmtFb(gc.erlcLogs?.cmds, mc.erlcLogs?.cmds),                      inline: true },
      { name: '🚨 Mod Call',               value: fmtFb(gc.erlcLogs?.modCall, mc.erlcLogs?.modCall),                inline: true },
      { name: '💀 Kill Logs',              value: fmtFb(gc.erlcLogs?.kills, mc.erlcLogs?.kills),                    inline: true },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dept_setup__ticket_channel').setLabel('Ticket Channel').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
    new ButtonBuilder().setCustomId('dept_setup__transcript').setLabel('Transcript').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('dept_setup__ticket_category').setLabel('Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
    new ButtonBuilder().setCustomId('dept_setup__ticket_ping_roles').setLabel('Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('dept_setup__session_channel').setLabel('Session Ch.').setStyle(ButtonStyle.Primary).setEmoji('🎮'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dept_setup__session_ping_roles').setLabel('Session Pings').setStyle(ButtonStyle.Primary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('dept_setup__session_allowed_roles').setLabel('Session Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('dept_setup__welcome_channel').setLabel('Welcome Ch.').setStyle(ButtonStyle.Primary).setEmoji('👋'),
    new ButtonBuilder().setCustomId('dept_setup__verify_channel').setLabel('Verify Ch.').setStyle(ButtonStyle.Primary).setEmoji('✅'),
    new ButtonBuilder().setCustomId('dept_setup__verify_role').setLabel('Verify Role').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dept_setup__app_review').setLabel('App Review Ch.').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('dept_setup__app_log').setLabel('App Log Ch.').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('dept_setup__training_channel').setLabel('Training Ch.').setStyle(ButtonStyle.Primary).setEmoji('🎓'),
    new ButtonBuilder().setCustomId('dept_setup__training_announce').setLabel('Training Announce').setStyle(ButtonStyle.Primary).setEmoji('📣'),
    new ButtonBuilder().setCustomId('dept_setup__training_roles').setLabel('Training Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
  );
  const r4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dept_setup__loa_role').setLabel('LOA Role').setStyle(ButtonStyle.Secondary).setEmoji('🏖️'),
    new ButtonBuilder().setCustomId('dept_setup__loa_approval_roles').setLabel('LOA Approvals').setStyle(ButtonStyle.Secondary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('dept_setup__loa_log').setLabel('LOA Log').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('dept_setup__autorole').setLabel('Autorole').setStyle(ButtonStyle.Secondary).setEmoji('🎭'),
    new ButtonBuilder().setCustomId('dept_setup__perms').setLabel('Permissions').setStyle(ButtonStyle.Secondary).setEmoji('👑'),
  );
  const r5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dept_setup__erlc_kickbans').setLabel('ERLC Kick/Ban').setStyle(ButtonStyle.Secondary).setEmoji('🔨'),
    new ButtonBuilder().setCustomId('dept_setup__erlc_joinleave').setLabel('ERLC Join/Leave').setStyle(ButtonStyle.Secondary).setEmoji('📥'),
    new ButtonBuilder().setCustomId('dept_setup__erlc_cmds').setLabel('ERLC Cmds').setStyle(ButtonStyle.Secondary).setEmoji('⌨️'),
    new ButtonBuilder().setCustomId('dept_setup__erlc_modcall').setLabel('ERLC Mod Call').setStyle(ButtonStyle.Secondary).setEmoji('🚨'),
    new ButtonBuilder().setCustomId('dept_setup__erlc_kills').setLabel('ERLC Kills').setStyle(ButtonStyle.Secondary).setEmoji('💀'),
  );

  return { embeds: [embed1, embed2], components: [r1, r2, r3, r4, r5], flags: MessageFlags.Ephemeral };
}
function isChannelSelectButton(id) {
  const channelBtns = [
    's_channel', 't_channel', 't_transcript', 't_category',
    'wc_channel', 'vcd_channel', 'sd_channel', 'ar_channel',
    'vc_channel', 'vc_deploy',
    'am_log', 'tr_setup__channel', 'tr_setup__announce_channel',
    'cmdlist__channel', 'erlc_set_kickbans', 'erlc_set_joinleave',
    'erlc_set_cmds', 'erlc_set_modcall', 'erlc_set_kills',
    'ap_review_channel', 'ap_log_channel',
    'vote_setup__log', 'vote_setup__announce_channel',
  ];
  if (channelBtns.includes(id)) return true;
  if (id.startsWith('hb__set_channel__')) return true;
  if (id.startsWith('loa__')) return true;
  if (id.startsWith('appe__set_channel__')) return true;
  if (id.startsWith('appe__set_review_channel__')) return true;
  if (id.startsWith('apte__set_review_channel__')) return true;
  if (id.startsWith('reqsetup__channel__')) return true;
  if (id.startsWith('ane__channel__')) return true;
  if (id.startsWith('sre__channel__')) return true;
  if (id.startsWith('srch__')) return true;
  if (id.startsWith('tkt_type_log__')) return true;
  if (id.startsWith('tkt_type_cfg__logchannel__')) return true;
  if (id === 't_rating_channel') return true;
  if (id === 't_rating_public') return true;
  return false;
}

const trainRequestCooldowns = new Map(); // userId → timestamp
const ticketCooldowns = new Map(); // `${guildId}:${userId}:${typeId}` → timestamp

function getTrainingConfig(guildId) {
  if (!config[guildId]) config[guildId] = {};
  const gc = config[guildId];
  if (!gc.training) gc.training = { channel: null, trainerRoles: [], requestRoles: [], pingRoles: [], announceChannel: null, announceMessage: null };
  if (!gc.training.trainerRoles)    gc.training.trainerRoles    = [];
  if (!gc.training.requestRoles)    gc.training.requestRoles    = [];
  if (!gc.training.pingRoles)       gc.training.pingRoles       = [];
  if (!gc.training.announceChannel) gc.training.announceChannel = null;
  if (!gc.training.announceMessage) gc.training.announceMessage = null;
  if (!gc.training.types)           gc.training.types           = [];
  if (!isMainServer(guildId)) {
    const mainTraining = getMainConfig('training');
    if (mainTraining) {
      if (!gc.training.trainerRoles?.length)  gc.training.trainerRoles  = mainTraining.trainerRoles  ?? [];
      if (!gc.training.requestRoles?.length)  gc.training.requestRoles  = mainTraining.requestRoles  ?? [];
      if (!gc.training.pingRoles?.length)     gc.training.pingRoles     = mainTraining.pingRoles     ?? [];
      if (!gc.training.announceMessage)       gc.training.announceMessage = mainTraining.announceMessage ?? null;
    }
  }
  return gc.training;
}

function getChainConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.chainOfCommand) gc.chainOfCommand = {
    chain: [], // [{ roleId, position }] gesorteerd op position ascending
    logChannel: null,
    promoteRoles: [], // rollen die /promote mogen gebruiken voor 1-staps CoC promoties
  };
  if (!Array.isArray(gc.chainOfCommand.chain)) gc.chainOfCommand.chain = [];
  if (!Array.isArray(gc.chainOfCommand.promoteRoles)) gc.chainOfCommand.promoteRoles = [];
  // Zorg dat chain altijd gesorteerd is op positie
  gc.chainOfCommand.chain.sort((a, b) => a.position - b.position);
  return gc.chainOfCommand;
}

// Mag deze member /promote gebruiken (instelbare promote-rollen of SHR)?
function hasPromoteAccess(m, guildId) {
  if (hasSHR(m)) return true;
  const cc = getChainConfig(guildId);
  if (!cc.promoteRoles?.length) return false;
  return cc.promoteRoles.some(id => m.roles.cache.has(id));
}

// Geeft de huidige rank positie van een member in de chain terug, -1 als geen
function getMemberChainPosition(member, chain) {
  for (const entry of chain) {
    if (member.roles.cache.has(entry.roleId)) return entry.position;
  }
  return -1;
}

// Geeft de volgende rank in de chain terug, null als al hoogste
function getNextChainRank(currentPosition, chain) {
  const sorted = [...chain].sort((a, b) => a.position - b.position);
  const current = sorted.find(e => e.position === currentPosition);
  if (!current) {
    // Geen huidige rank — geef de eerste rank in de chain
    return sorted[0] ?? null;
  }
  const currentIndex = sorted.indexOf(current);
  return sorted[currentIndex + 1] ?? null;
}

// Promoveer een member één stap omhoog in de chain
async function promoteInChain(guild, targetMember, promotedBy, guildId, skipTo = null) {
  const cc = getChainConfig(guildId);
  const chain = cc.chain;
  if (!chain.length) return { success: false, reason: 'No chain configured.' };

  const currentPosition = getMemberChainPosition(targetMember, chain);
  const isAtTop = currentPosition === chain[chain.length - 1]?.position;
  if (isAtTop) return { success: false, reason: 'Already at the highest rank in the chain.' };

  // SHR skip: ga naar een specifieke rank
  const targetEntry = skipTo
    ? chain.find(e => e.roleId === skipTo)
    : getNextChainRank(currentPosition, chain);

  if (!targetEntry) return { success: false, reason: 'No next rank found.' };

  const newRole = guild.roles.cache.get(targetEntry.roleId);
  if (!newRole) return { success: false, reason: 'Target role not found in server.' };

  // Verwijder alle huidige chain rollen
  for (const entry of chain) {
    if (targetMember.roles.cache.has(entry.roleId)) {
      await targetMember.roles.remove(entry.roleId).catch(() => {});
    }
  }

  // Geef nieuwe rank rol
  await targetMember.roles.add(newRole).catch(() => {});

  // DM naar gebruiker
  await targetMember.user.send({
    embeds: [new EmbedBuilder()
      .setTitle('⬆️ You have been promoted!')
      .setColor(0x57F287)
      .setDescription(`You have been promoted to **${newRole.name}** in **${guild.name}**!`)
      .addFields(
        { name: '🎭 New Rank', value: newRole.name, inline: true },
        { name: '👮 Promoted by', value: userDisplay(promotedBy), inline: true },
      )
      .setTimestamp()
    ]
  }).catch(() => {});

  // Log
  if (cc.logChannel) {
    const logCh = guild.channels.cache.get(cc.logChannel);
    if (logCh) {
      await logCh.send({
        embeds: [new EmbedBuilder()
          .setTitle('⬆️ Chain Promotion')
          .setColor(0x57F287)
          .addFields(
            { name: '👤 User', value: `${userDisplay(targetMember.user)} (<@${targetMember.id}>)`, inline: true },
            { name: '🎭 New Rank', value: newRole.name, inline: true },
            { name: '👮 Promoted by', value: `${userDisplay(promotedBy)}`, inline: true },
          )
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }

  // Announcement
  await sendPromotionAnnounce(guild, targetMember.user, newRole.name, promotedBy, 'promotion').catch(() => {});

  return { success: true, newRole };
}

function getStaffReviewConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.staffReview) gc.staffReview = { channel: null, staffRoles: [], reviews: {} };
  if (!gc.staffReview.staffRoles) gc.staffReview.staffRoles = [];
  if (!gc.staffReview.reviews)    gc.staffReview.reviews    = {};
  return gc.staffReview;
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
  if (hasSetup(member)) return true;
  if (hasSHR(member)) return true;
  const sc = getSessionConfig(guildId);
  if (!sc.allowedRoles?.length) return hasAnyStaff(member);
  return sc.allowedRoles.some(id => member.roles.cache.has(id));
}

const openTickets        = new Map();
const ticketRulesPending = new Map(); // userId → { typeId, guildId, intakeAnswers? }
const ticketIntakeData   = new Map(); // userId → intakeAnswers[] — bewaard tot ticket aangemaakt is
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
const activeAppSessions  = new Map();
const activeGeneralVotes = new Map(); // voteId → { messageId, channelId, question, yes[], no[], endsAt, guildId }
// ════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════
function genId() { return Math.random().toString(36).slice(2, 8); }

// Cryptographically secure verification code (Part 13a)
const crypto = require('crypto');
function genVerificationCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// Safe display name — .tag is deprecated in DJS v14 (Part 4)
function userDisplay(user) {
  if (!user) return 'Unknown';
  return user.discriminator && user.discriminator !== '0'
    ? `${user.username}#${user.discriminator}`
    : user.username;
}

// Embed field/title/desc length validation helpers (Part 5e)
const embedSafe = {
  title:     (s) => String(s ?? '').slice(0, 256)  || '\u200b',
  desc:      (s) => String(s ?? '').slice(0, 4096) || '\u200b',
  fieldName: (s) => String(s ?? '').slice(0, 256)  || '\u200b',
  fieldVal:  (s) => String(s ?? '').slice(0, 1024) || '\u200b',
  footer:    (s) => String(s ?? '').slice(0, 2048) || '\u200b',
  author:    (s) => String(s ?? '').slice(0, 256)  || '\u200b',
};
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

// Session TTL cleanup — prevent unbounded growth (Part 9a)
const APP_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minuten
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of activeAppSessions.entries()) {
    if (now - (session.startedAt ?? 0) > APP_SESSION_TIMEOUT_MS) {
      activeAppSessions.delete(userId);
      client.users.fetch(userId).then(u =>
        u.send('⏰ Your application session has expired due to inactivity.')
      ).catch(() => {});
    }
  }
}, 10 * 60 * 1000); // elke 10 minuten

// pendingVerifications cleanup — prevent unbounded growth (Part 9b)
setInterval(() => {
  const now = Date.now();
  for (const [uid, pv] of pendingVerifications.entries()) {
    if (pv?.expires && now > pv.expires) pendingVerifications.delete(uid);
  }
}, 5 * 60 * 1000); // elke 5 minuten

const ERLC_BASE = 'https://api.policeroleplay.community/v1';
async function erlcRequest(p, method = 'GET', body = null, guildId = null) {
  const key = guildId ? (getErlcLogConfig(guildId).serverKey || process.env.ERLC_API_KEY) : process.env.ERLC_API_KEY;
  const opts = { method, headers: { 'Server-Key': key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) };
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
    .setTitle(embedSafe.title(`📋 ${appType.label} — Question ${qIndex + 1}/${total}`))
    .setDescription(embedSafe.desc(`**${question}**`))
    .setFooter({ text: embedSafe.footer(`Type your answer below. Type "cancel" to cancel your application. • ${session.guildName}`) });

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

  // Bewaar de submission zodat we later (bij accept/deny) een transcript kunnen sturen
  ac.submissions[appId] = {
    userId,
    typeId: appType.id,
    questions: appType.questions.slice(),
    answers: session.answers.slice(),
    submittedAt: new Date().toISOString(),
  };
  await saveGuildConfig(session.guildId);

  const applicantDisplay = applicant
    ? `${userDisplay(applicant)} (<@${userId}>)`
    : `<@${userId}>`;

  const headerFields = [
    { name: '👤 Applicant', value: applicantDisplay.slice(0, 1024), inline: true },
    { name: '🆔 User ID',   value: String(userId).slice(0, 1024), inline: true },
    { name: '📅 Submitted', value: new Date().toUTCString(), inline: false },
  ];

  // Helper: bereken embed size (Discord telt title + description + fields + footer)
  const fieldSize = f => (f.name?.length ?? 0) + (f.value?.length ?? 0);
  const EMBED_MAX = 5800; // iets onder 6000 als veiligheidsmarge
  const MAX_FIELDS = 24; // laat 1 slot over als veiligheidsmarge (hard limit is 25)

  // Bouw embeds waarbij we per embed de totale grootte bewaken
  const embeds = [];
  let currentFields = [...headerFields];
  let isFirst = true;
  let page = 1;

  const calcTitleLen = (isFirstEmbed) => {
    const t = isFirstEmbed
      ? `📋 New Application — ${appType.emoji || ''} ${appType.label}`.slice(0, 256)
      : `📋 Application (continued) — ${appType.label} — Page ${page}`.slice(0, 256);
    return t.length;
  };
  const footerLen = `Application ID: ${appId} • Continued below ↓`.length;

  let currentSize = calcTitleLen(true) + footerLen + headerFields.reduce((s, f) => s + fieldSize(f), 0);

  const flushEmbed = (isLast) => {
    const rawTitle = isFirst
      ? `📋 New Application — ${appType.emoji || ''} ${appType.label}`
      : `📋 Application (continued) — ${appType.label} — Page ${page}`;
    const title = rawTitle.slice(0, 256);
    const footer = `Application ID: ${appId}${!isLast ? ' • Continued below ↓' : ''}`.slice(0, 2048);
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
    currentSize = calcTitleLen(false) + footerLen;
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

/**
 * Send a full transcript (all questions + answers + final decision) to the
 * configured application transcript channel, if one is set.
 */
async function sendApplicationTranscript(guild, ac, appId, decision) {
  if (!ac.transcriptChannel) return;
  const transcriptCh = guild.channels.cache.get(ac.transcriptChannel);
  if (!transcriptCh) return;

  const submission = ac.submissions?.[appId];
  if (!submission) return;

  const appType = ac.appTypes.find(t => t.id === submission.typeId);
  const applicant = await client.users.fetch(submission.userId).catch(() => null);
  const applicantDisplay = applicant ? `${userDisplay(applicant)} (<@${submission.userId}>)` : `<@${submission.userId}>`;

  const decisionColor = decision.result === 'accepted' ? 0x57F287 : 0xED4245;
  const decisionLabel = decision.result === 'accepted' ? '✅ Accepted' : '❌ Denied';

  const headerFields = [
    { name: '👤 Applicant', value: applicantDisplay.slice(0, 1024), inline: true },
    { name: '📋 Type',      value: appType?.label ?? submission.typeId, inline: true },
    { name: '📊 Decision',  value: decisionLabel, inline: true },
    { name: '👮 Moderator', value: decision.moderator, inline: true },
    { name: '📅 Submitted', value: new Date(submission.submittedAt).toUTCString(), inline: false },
  ];
  if (decision.reason) headerFields.push({ name: '📝 Reason', value: decision.reason.slice(0, 1024), inline: false });

  const answerFields = submission.questions.map((q, i) => ({
    name: `❓ ${q.slice(0, 250)}`,
    value: (submission.answers[i] ?? '*No answer*').slice(0, 1024),
    inline: false,
  }));

  const fieldSize = f => (f.name?.length ?? 0) + (f.value?.length ?? 0);
  const EMBED_MAX = 5800;
  const MAX_FIELDS = 24;

  const embeds = [];
  let currentFields = [...headerFields];
  let isFirst = true;
  let page = 1;
  let currentSize = headerFields.reduce((s, f) => s + fieldSize(f), 0) + 256;

  const flushEmbed = () => {
    const title = isFirst
      ? `📝 Application Transcript — ${appType?.label ?? submission.typeId}`
      : `📝 Application Transcript (continued) — Page ${page}`;
    embeds.push(new EmbedBuilder()
      .setTitle(title.slice(0, 256))
      .setColor(decisionColor)
      .addFields(...currentFields)
      .setFooter({ text: `Application ID: ${appId}` })
      .setThumbnail(isFirst ? (applicant?.displayAvatarURL({ dynamic: true }) ?? null) : null)
      .setTimestamp());
    isFirst = false;
    page++;
    currentFields = [];
    currentSize = 256;
  };

  for (const field of answerFields) {
    const fSize = fieldSize(field);
    if (currentFields.length >= MAX_FIELDS || (currentSize + fSize > EMBED_MAX && currentFields.length > 0)) {
      flushEmbed();
    }
    currentFields.push(field);
    currentSize += fSize;
  }
  flushEmbed();

  const EMBEDS_PER_MSG = 10;
  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MSG) {
    await transcriptCh.send({ embeds: embeds.slice(i, i + EMBEDS_PER_MSG) }).catch(() => {});
  }
}

// ════════════════════════════════════════════
// AUTOMOD
// ════════════════════════════════════════════}


function buildVoteSystemSetupPayload(guildId) {
  const vc = getVoteConfig(guildId);
  const embed = new EmbedBuilder()
    .setTitle('🗳️ Vote System Setup')
    .setColor(0x5865F2)
    .setDescription('Configure the vote system.\n\n**Only guilds marked as Main Server can start votes.**')
    .addFields(
      { name: '🏠 Main Server', value: vc.mainServer ? '✅ Yes' : '❌ No', inline: true },
      { name: '📋 Log Channel', value: vc.logChannel ? `<#${vc.logChannel}>` : '*Not set*', inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_setup__toggle').setLabel(vc.mainServer ? 'Disable Main Server' : 'Enable Main Server').setStyle(vc.mainServer ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji('🏠'),
    new ButtonBuilder().setCustomId('vote_setup__log').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('vote_setup__announce_channel').setLabel('Announce Channel').setStyle(ButtonStyle.Primary).setEmoji('📣'),
    new ButtonBuilder().setCustomId('vote_setup__announce_roles').setLabel('Announce Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('🔔'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}
function getFoundershipConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.foundership) gc.foundership = { roles: [] };
  if (!Array.isArray(gc.foundership.roles)) gc.foundership.roles = [];
  return gc.foundership;
}

function isFoundership(member) {
  if (!member?.roles?.cache || !member?.guild?.id) return false;
  const fc = getFoundershipConfig(member.guild.id);
  return fc.roles.some(id => member.roles.cache.has(id));
}

function getBotConfig(guildId) {
  const gc = getGuildConfig(guildId);
  if (!gc.botConfig) gc.botConfig = { logoUrl: '' };
  return gc.botConfig;
}

function buildStaffRankSetupPayload(guildId) {
  const src = getStaffRankConfig(guildId);
  const rankList = src.ranks.length
    ? src.ranks.sort((a, b) => b.level - a.level).map(r => `**Level ${r.level}** — ${r.name} — ${r.roleId ? `<@&${r.roleId}>` : '*No role*'}`).join('\n')
    : '*No ranks configured yet*';
  const embed = new EmbedBuilder().setTitle('⭐ Staff Rank Setup').setColor(0xFEE75C)
    .setDescription('Configure staff rank levels for minimum rank restrictions on ticket types.\n\n' + rankList);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('staffrank__add').setLabel('Add Rank').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('staffrank__remove').setLabel('Remove Rank').setStyle(ButtonStyle.Danger).setEmoji('➖'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildFoundershipSetupPayload(guildId) {
  const fc = getFoundershipConfig(guildId);
  const embed = new EmbedBuilder().setTitle('👑 Foundership Setup').setColor(0xED4245)
    .setDescription('Foundership roles have permanent access to all tickets and cannot be removed.\n\n**Current Foundership Roles:**\n' + (fc.roles.length ? fc.roles.map(r => `<@&${r}>`).join(', ') : '*None configured*'));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('foundership__set_roles').setLabel('Set Foundership Roles').setStyle(ButtonStyle.Primary).setEmoji('👑'),
    new ButtonBuilder().setCustomId('foundership__clear_roles').setLabel('Clear All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildTicketV2LogSetupPayload(guildId) {
  const v2 = getTicketV2Config(guildId);
  const embed = new EmbedBuilder().setTitle('🎫 Ticket V2 Logging').setColor(0x5865F2)
    .addFields(
      { name: '📋 Log Channel',        value: v2.logChannel        ? `<#${v2.logChannel}>`        : '*Not set*', inline: true },
      { name: '📝 Transcript Channel', value: v2.transcriptChannel ? `<#${v2.transcriptChannel}>` : '*Not set*', inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticketv2__log_channel').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('ticketv2__transcript_channel').setLabel('Transcript Channel').setStyle(ButtonStyle.Primary).setEmoji('📝'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildTicketV2TypeManagerPayload(guildId) {
  const v2 = getTicketV2Config(guildId);
  const typeList = v2.types?.length
    ? v2.types.map(t => `**${t.ticketTypeName}**\n　Category: ${t.categoryId ? `<#${t.categoryId}>` : '*None*'} | Min. Rank: ${t.minimumStaffRank || 'None'} | Auto-close: ${t.autoCloseHours ? `${t.autoCloseHours}h` : 'Off'}`).join('\n\n')
    : '*No V2 type configurations yet.*';
  const embed = new EmbedBuilder().setTitle('🎫 Ticket Type Manager (V2)').setColor(0x5865F2)
    .setDescription('Add extra configuration per ticket type.\n\n' + typeList);
  const btns = [new ButtonBuilder().setCustomId('ticketv2type__add').setLabel('Add Config').setStyle(ButtonStyle.Success).setEmoji('➕')];
  if (v2.types?.length) {
    btns.push(
      new ButtonBuilder().setCustomId('ticketv2type__edit').setLabel('Edit Config').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('ticketv2type__remove').setLabel('Remove Config').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}

function buildBotConfigSetupPayload(guildId) {
  const bc = getBotConfig(guildId);
  const embed = new EmbedBuilder()
    .setTitle('🤖 Bot Configuration')
    .setColor(0x5865F2)
    .setDescription('General bot settings for this server.')
    .addFields(
      { name: '🖼️ Logo URL', value: bc.logoUrl ? `[Set](${bc.logoUrl})` : '*Not set*', inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('botcfg__logo').setLabel('Set Logo URL').setStyle(ButtonStyle.Primary).setEmoji('🖼️'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildInfractionSetupPayload(guildId) {
  const ic = getInfractionConfig(guildId);
  const hierarchyList = INFRACTION_PROGRESSION.map((p, i) => {
    const roleId = ic.hierarchy[i]?.roleId;
    const icon = p.category === 'Termination' ? '🚨' : p.category === 'Strike' ? '🔴' : '🟡';
    return `${icon} **${i + 1}.** \`${p.label}\` — ${roleId ? `<@&${roleId}>` : '*No role*'}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Infraction System Setup')
    .setColor(0xED4245)
    .setDescription(
      'Fixed progression: **3 Warnings → 3 Strikes → Termination**. Every infraction (Warning or Strike) advances the user one level. ' +
      'Optionally assign a role per level — previous level roles are automatically removed.\n\n' +
      '**Variables:** `{user}` `{userMention}` `{username}` `{reason}` `{moderator}` `{type}` `{levelLabel}` `{progressionLevel}` `{maxLevel}` `{server}`'
    )
    .addFields(
      { name: '📊 Progression',       value: hierarchyList,                                              inline: false },
      { name: '📢 Log Channel',       value: ic.logChannel ? `<#${ic.logChannel}>` : '*Not set*',         inline: true  },
      { name: '🏷️ Embed Title',      value: `\`${ic.embedTitle}\``,                                      inline: false },
      { name: '📝 Embed Description', value: `\`\`\`${ic.embedDescription.slice(0, 200)}\`\`\``,          inline: false },
      { name: '💬 DM Message',        value: `\`\`\`${ic.dmMessage.slice(0, 200)}\`\`\``,                 inline: false },
      { name: '🚨 Termination Message', value: `\`\`\`${ic.terminationMessage.slice(0, 200)}\`\`\``,      inline: false },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('inf__set_role').setLabel('Set Level Role').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
    new ButtonBuilder().setCustomId('inf__log_channel').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('inf__edit_embed').setLabel('Edit Embed').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
    new ButtonBuilder().setCustomId('inf__edit_dm').setLabel('Edit DM Message').setStyle(ButtonStyle.Primary).setEmoji('💬'),
    new ButtonBuilder().setCustomId('inf__edit_color').setLabel('Edit Color').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
    new ButtonBuilder().setCustomId('inf__edit_termination').setLabel('Edit Termination Msg').setStyle(ButtonStyle.Danger).setEmoji('🚨'),
  );

  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildPermissionsSetupPayload(guildId) {
  const pc = getPermissionsConfig(guildId);
  const fmt = (arr) => arr.length ? arr.map(r => `<@&${r}>`).join(', ') : '*Not set*';
  const embed = new EmbedBuilder()
    .setTitle('🔐 Permissions Setup')
    .setColor(0x5865F2)
    .setDescription('Configure which roles have access to each permission level.')
    .addFields(
      { name: '👑 Admin Roles',  value: fmt(pc.adminRoles),  inline: false },
      { name: '🛡️ Mod Roles',   value: fmt(pc.modRoles),    inline: false },
      { name: '👤 Staff Roles',  value: fmt(pc.staffRoles),  inline: false },
      { name: '⭐ SHR Roles',    value: fmt(pc.shrRoles),    inline: false },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('perms__admin').setLabel('Admin Roles').setStyle(ButtonStyle.Primary).setEmoji('👑'),
    new ButtonBuilder().setCustomId('perms__mod').setLabel('Mod Roles').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('perms__staff').setLabel('Staff Roles').setStyle(ButtonStyle.Primary).setEmoji('👤'),
    new ButtonBuilder().setCustomId('perms__shr').setLabel('SHR Roles').setStyle(ButtonStyle.Primary).setEmoji('⭐'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildDepartmentsSetupPayload(guildId) {
  const dc = getDepartmentsConfig(guildId);
  const depts = dc.departments ?? [];
  const embed = new EmbedBuilder()
    .setTitle('🏢 Departments Setup')
    .setColor(0xEB459E)
    .setDescription(
      `**This server is:** ${dc.isMainServer ? '✅ Main Server' : '❌ Not the main server'}\n\n` +
      (depts.length
        ? depts.map((d, i) =>
            `**${i + 1}. ${d.name}**\nServer ID: \`${d.guildId}\`\nAnnouncement Channel ID: \`${d.announcementChannelId || '*Not set*'}\``
          ).join('\n\n')
        : '*No departments configured yet.*')
    );
  const btns = [
    new ButtonBuilder().setCustomId('dept__toggle_main').setLabel(dc.isMainServer ? 'Unset Main Server' : 'Set as Main Server').setStyle(dc.isMainServer ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji('🏠'),
    new ButtonBuilder().setCustomId('dept__add').setLabel('Add Department').setStyle(ButtonStyle.Success).setEmoji('➕'),
  ];
  if (depts.length) {
    btns.push(
      new ButtonBuilder().setCustomId('dept__remove').setLabel('Remove').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], flags: MessageFlags.Ephemeral };
}

function buildAntipingSetupPayload(guildId) {
  const ap = getAntipingConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🔔 Antiping Setup').setColor(0xED4245)
    .setDescription('Prevent non-staff from using @everyone and @here.\n\n**Actions:** `delete` | `delete+warn` | `delete+mute`')
    .addFields(
      { name: '✅ Enabled',       value: ap.enabled ? 'Yes' : 'No',                                           inline: true },
      { name: '⚙️ Action',        value: ap.action || 'delete',                                               inline: true },
      { name: '⏱️ Mute (min)',    value: `${ap.muteMinutes ?? 5}`,                                            inline: true },
      { name: '📋 Log Channel',   value: ap.logChannel ? `<#${ap.logChannel}>` : '*Not set*',                 inline: true },
      { name: '🔑 Exempt Roles',  value: ap.exemptRoles?.length ? ap.exemptRoles.map(r => `<@&${r}>`).join(', ') : '*None (staff auto-exempt)*', inline: false },
      { name: '📢 Exempt Channels', value: ap.exemptChannels?.length ? ap.exemptChannels.map(c => `<#${c}>`).join(', ') : '*None*', inline: false },
      { name: '💬 Warn Message',  value: `\`\`\`${String(ap.warnMessage ?? '').slice(0, 100)}\`\`\``,        inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_toggle').setLabel(ap.enabled ? 'Disable' : 'Enable').setStyle(ap.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(ap.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('ap_action').setLabel('Set Action').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
    new ButtonBuilder().setCustomId('ap_log').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('ap_exempt_roles').setLabel('Exempt Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('ap_exempt_channels').setLabel('Exempt Channels').setStyle(ButtonStyle.Primary).setEmoji('📢'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_warn_message').setLabel('Warn Message').setStyle(ButtonStyle.Primary).setEmoji('💬'),
  );
  return { embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral };
}

function buildRolePingProtectionSetupPayload(guildId) {
  const rpp = getRolePingProtectionConfig(guildId);
  const embed = new EmbedBuilder().setTitle('🔔 Role Ping Protection').setColor(0xED4245)
    .setDescription('Prevent users from pinging specific roles (e.g. Founders, Owners).\n\nUsers with **allowed roles**, **admin roles**, or **Foundership** can always ping.')
    .addFields(
      { name: '✅ Enabled',           value: rpp.enabled ? 'Yes' : 'No',                                                                             inline: true },
      { name: '⚙️ Action',            value: rpp.action || 'delete',                                                                                 inline: true },
      { name: '⏱️ Mute (min)',        value: `${rpp.muteMinutes ?? 5}`,                                                                              inline: true },
      { name: '📋 Log Channel',       value: rpp.logChannel ? `<#${rpp.logChannel}>` : '*Not set*',                                                   inline: true },
      { name: '🛡️ Protected Roles',  value: rpp.protectedRoles?.length ? rpp.protectedRoles.map(r => `<@&${r}>`).join(', ') : '*None set*',          inline: false },
      { name: '✅ Allowed to Ping',   value: rpp.allowedRoles?.length ? rpp.allowedRoles.map(r => `<@&${r}>`).join(', ') : '*Admins/Foundership only*', inline: false },
      { name: '💬 Warn Message',      value: `\`\`\`${String(rpp.warnMessage ?? '').slice(0, 100)}\`\`\``,                                           inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rpp__toggle').setLabel(rpp.enabled ? 'Disable' : 'Enable').setStyle(rpp.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(rpp.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('rpp__protected_roles').setLabel('Protected Roles').setStyle(ButtonStyle.Danger).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('rpp__allowed_roles').setLabel('Allowed to Ping').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('rpp__log').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('rpp__settings').setLabel('Action & Message').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
  );
  const r2rpp = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rpp__whitelist_user').setLabel('Whitelist User').setStyle(ButtonStyle.Success).setEmoji('👤'),
    new ButtonBuilder().setCustomId('rpp__clear_whitelist').setLabel('Clear Whitelist').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  return { embeds: [embed], components: [r1, r2rpp], flags: MessageFlags.Ephemeral };
}

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
      { name: '📝 Transcript Channel',    value: ac.transcriptChannel ? `<#${ac.transcriptChannel}>` : '*Not set*', inline: true },
      { name: '📝 Application Types',    value: typeList, inline: false },
      { name: '🖼️ Panels',              value: panelList, inline: false },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_review_channel').setLabel('Review Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('ap_log_channel').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('ap_transcript_channel').setLabel('Transcript Channel').setStyle(ButtonStyle.Primary).setEmoji('📝'),
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
// Shared staff review leaderboard embed builder (Part 15a)
function buildStaffLeaderboardEmbed(guildId) {
  const src = getStaffReviewConfig(guildId);
  const reviews = src.reviews ?? {};
  const entries = Object.entries(reviews)
    .map(([uid, revs]) => {
      const avg = revs.length ? (revs.reduce((s, r) => s + r.rating, 0) / revs.length) : 0;
      return { uid, count: revs.length, avg };
    })
    .filter(e => e.count > 0)
    .sort((a, b) => b.avg - a.avg || b.count - a.count)
    .slice(0, 10);

  if (!entries.length) return null;
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.map((e, i) => {
    const stars = '⭐'.repeat(Math.round(e.avg));
    return `${medals[i] ?? `**${i + 1}.**`} <@${e.uid}> — ${stars} **${e.avg.toFixed(2)}/5** *(${e.count} review${e.count !== 1 ? 's' : ''})*`;
  });
  return new EmbedBuilder()
    .setTitle('🏆 Staff Review Leaderboard')
    .setColor(0xF1C40F)
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

// Shared application panel message builder (Part 15b)
function buildApplicationPanelMessage(panel, ac, guildId) {
  const logoUrl = getGuildLogoUrl(guildId);
  const embed = new EmbedBuilder()
    .setTitle(embedSafe.title(panel.title || '📋 Applications'))
    .setDescription(embedSafe.desc(panel.description || 'Click a button below to apply!'))
    .setColor(hexToInt(panel.color));
  if (logoUrl) embed.setThumbnail(logoUrl);
  if (panel.image) embed.setImage(panel.image);
  const rows = [];
  const types = panel.appTypeIds.map(tid => ac.appTypes.find(t => t.id === tid)).filter(Boolean);
  for (let i = 0; i < Math.min(types.length, 25); i += 5) {
    const chunk = types.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(chunk.map(t => safeSetEmoji(new ButtonBuilder().setCustomId(`appopen__${t.id}__${panel.id}`).setLabel(t.label.slice(0, 80)).setStyle(ButtonStyle.Primary), t.emoji))));
  }
  return { embeds: [embed], components: rows };
}

function buildTicketPanelEmbed(tc) {
  const embed = new EmbedBuilder().setTitle(embedSafe.title(tc.panelTitle || '🎫 Support Tickets')).setDescription(embedSafe.desc(tc.panelDescription || 'Click a button below.')).setColor(hexToInt(tc.panelColor));
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
  const pc = getTicketPreCheckConfig(guildId);
  const safeAmountLabel = String(pc.amountLabel ?? 'Amount').slice(0, 20);
  embed.addFields(
    { name: '🔒 Pre-Check', value: pc.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
    { name: `📊 Min. ${safeAmountLabel}`, value: pc.minimumAmount > 0 ? `${pc.minimumAmount}` : '*Not set*', inline: true },
  );
  const rc = getTicketRatingConfig(guildId);
  embed.addFields(
    { name: '⭐ Rating System',   value: rc.enabled ? '✅ Enabled' : '❌ Disabled',              inline: true },
    { name: '📋 Rating Log',      value: rc.logChannel    ? `<#${rc.logChannel}>`    : '*Not set*', inline: true },
    { name: '📢 Public Reviews',  value: rc.publicChannel ? `<#${rc.publicChannel}>` : '*Not set*', inline: true },
  );
  // Sanity check — zorg dat amountLabel niet in embed fields crasht
  const safeLabel = String(pc?.amountLabel ?? 'Amount').slice(0, 20);
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_deploy').setLabel('Deploy Panel').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('t_precheck').setLabel('Pre-Check').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('t_rating').setLabel('Rating System').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
    new ButtonBuilder().setCustomId('t_inactivity').setLabel('Inactivity').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
  );
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
  const embed = new EmbedBuilder().setTitle(embedSafe.title(panel.title)).setDescription(embedSafe.desc(panel.description || 'Select your roles below.')).setColor(hexToInt(panel.color)).setFooter({ text: panel.type === 'reaction' ? 'React to get a role' : 'Click to toggle your role' });
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
  const embed = new EmbedBuilder().setTitle('🟢 Session Started!').setColor(0x57F287).setDescription(embedSafe.desc(desc)).setTimestamp().setFooter({ text: embedSafe.footer(`By ${userDisplay(hostUser)}`) });
  if (sc.startImage) embed.setImage(sc.startImage);
  const comps = [];
  if (isValidUrl(rawLink)) comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🚀 Join Session').setStyle(ButtonStyle.Link).setURL(rawLink.trim())));

  // Bouw content: ping roles + voters (als ze er zijn)
  const parts = [];
  if (ping) parts.push(ping);
  if (voterMentions) parts.push(`🗳️ **Voters:** ${voterMentions}`);
  const content = parts.length ? parts.join('\n') : undefined;

  await sCh.send({ content, embeds: [embed], components: comps });
}

// ════════════════════════════════════════════
// TICKET CREATION HELPER
// ════════════════════════════════════════════
async function createTicketChannel(interaction, type, tc, pc, guildId, alreadyUpdated = false) {
  try {
    const guild = interaction.guild;
    if (!guild) throw new Error('Guild not found.');
    const user  = interaction.user;
    const member = interaction.member;
    if (!user) throw new Error('User not found.');

    // Resolve per-type settings (fallback to global)
    const resolvedPingRoles         = resolveTicketSetting(type, tc, pc, 'pingRoles');
    const resolvedWelcomeText       = resolveTicketSetting(type, tc, pc, 'welcomeText');
    const resolvedEmbedColor        = resolveTicketSetting(type, tc, pc, 'embedColor');
    const resolvedEmbedImage        = resolveTicketSetting(type, tc, pc, 'embedImage');
    const resolvedDmOnOpen          = resolveTicketSetting(type, tc, pc, 'dmOnOpen');

    // V2 category lookup: check V2 type config eerst, dan legacy
    let category = null;
    const v2cfg = getTicketV2Config(guildId);
    const v2type = v2cfg.types?.find(t => t.ticketTypeName === type.label);
    if (v2type?.categoryId) {
      category = guild.channels.cache.get(v2type.categoryId) ?? null;
    }
    if (!category) {
      category = (type.category ? guild.channels.cache.get(type.category) : null)
        ?? (tc.ticketCategory ? guild.channels.cache.get(tc.ticketCategory) : null);
    }

    const perms = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const rid of resolvedPingRoles) {
      perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    if (type.viewRoles?.length) {
      for (const rid of type.viewRoles) {
        perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
      }
    }

    // Add foundership roles to perms
    const fc = getFoundershipConfig(guildId);
    for (const rid of fc.roles) {
      perms.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
    }

    const ticketCh = await guild.channels.create({
      name: `ticket-${type.label.toLowerCase().replace(/\s+/g, '-')}-${user.username}`,
      type: ChannelType.GuildText,
      parent: category ?? null,
      permissionOverwrites: perms,
      topic: `Ticket by ${userDisplay(user)} | ${type.label}`,
    });

    // Create DB record
    await createTicketRecord({
      guildId,
      channelId: ticketCh.id,
      creatorId: user.id,
      typeId: type.id,
      typeLabel: type.label,
      staffMembers: resolvedPingRoles,
    }).catch(() => {});

    openTickets.set(user.id, ticketCh.id);
    // Store per-type cooldown
    if (type.cooldownMinutes) {
      const cdKey = `${guildId}:${user.id}:${type.id}`;
      ticketCooldowns.set(cdKey, Date.now());
    }

    const vars = { userMention: `<@${user.id}>`, username: user.username, userTag: userDisplay(user) };
    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`${type.emoji || '🎫'} Ticket — ${type.label}`)
      .setDescription(`${replaceVars(resolvedWelcomeText, vars)}\n\n**Type:** ${type.label}`)
      .setColor(hexToInt(resolvedEmbedColor))
      .setTimestamp()
      .setFooter({ text: `By ${userDisplay(user)}` });
    if (resolvedEmbedImage) welcomeEmbed.setImage(resolvedEmbedImage);

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tkt__claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
      new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    );

    const pingContent = resolvedPingRoles.length
      ? `<@${user.id}>${resolvedPingRoles.map(id => ` <@&${id}>`).join('')}`
      : `<@${user.id}>`;

    await ticketCh.send({
      content: pingContent,
      embeds: [welcomeEmbed],
      components: [closeRow],
    });

    // ── Intake form antwoorden in ticket ──
    const intakeAnswers = ticketIntakeData.get(user.id) ?? null;
    if (intakeAnswers && intakeAnswers.length > 0) {
      ticketIntakeData.delete(user.id);
      const intakeEmbed = new EmbedBuilder()
        .setTitle('📋 Intake Form Answers')
        .setColor(0x5865F2)
        .addFields(intakeAnswers.map(a => ({
          name: String(a.label).slice(0, 256),
          value: String(a.answer || '*No answer*').slice(0, 1024),
          inline: false,
        })))
        .setFooter({ text: `Submitted by ${userDisplay(user)}` })
        .setTimestamp();
      await ticketCh.send({ embeds: [intakeEmbed] });
    }

    // DM user on open if enabled
    if (resolvedDmOnOpen) {
      await safeDM(user, {
        embeds: [new EmbedBuilder()
          .setTitle(`${type.emoji || '🎫'} Ticket Opened`)
          .setColor(hexToInt(resolvedEmbedColor))
          .setDescription(`Your ticket has been created in **${guild.name}**.\n\n**Type:** ${type.label}`)
          .addFields({ name: '📍 Channel', value: `<#${ticketCh.id}>`, inline: true })
          .setTimestamp()
        ],
      });
    }

    // ── Staff info panel ──
    try {
      const vc = getVerificationConfig(guildId);
      const verifyData = vc.verifiedUsers?.[user.id];
      const pcCheck = getTicketPreCheckConfig(guildId);

      const infoFields = [
        { name: '👤 Discord User', value: `${userDisplay(user)} (<@${user.id}>)`, inline: true },
        { name: '🆔 Discord ID', value: user.id, inline: true },
        { name: '📅 Account Created', value: user.createdAt.toDateString(), inline: true },
        { name: '📥 Joined Server', value: member.joinedAt?.toDateString() ?? 'Unknown', inline: true },
        { name: '🎫 Ticket Type', value: type.label, inline: true },
        { name: '✅ Rules Accepted', value: pcCheck.enabled ? '✅ Yes' : '⬜ Not required', inline: true },
      ];

      if (verifyData) {
        infoFields.push(
          { name: '🎮 Roblox Username', value: verifyData.robloxUsername ?? 'Unknown', inline: true },
          { name: '🆔 Roblox ID', value: `${verifyData.robloxId ?? 'Unknown'}`, inline: true },
          { name: '📅 Verified At', value: new Date(verifyData.verifiedAt).toDateString(), inline: true },
        );
        if (pcCheck.minimumAmount > 0) {
          const userAmount = verifyData.serviceAmount ?? 0;
          infoFields.push({
            name: `📊 ${pcCheck.amountLabel || 'Amount'}`,
            value: `${userAmount} / ${pcCheck.minimumAmount} required ${userAmount >= pcCheck.minimumAmount ? '✅' : '❌'}`,
            inline: true,
          });
        }
      } else {
        infoFields.push({ name: '🎮 Roblox Account', value: '❌ Not verified', inline: true });
      }

      const infoEmbed = new EmbedBuilder()
        .setTitle('📋 User Information — Staff Only')
        .setColor(0xFEE75C)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(...infoFields)
        .setFooter({ text: 'Auto-generated pre-check info' })
        .setTimestamp();

      await ticketCh.send({ embeds: [infoEmbed] });
    } catch (infoErr) {
      console.error('Ticket info panel error:', infoErr);
    }

    // Reply to interaction — caller must have deferred or replied/updated first
    const replyPayload = { content: `✅ Ticket created: <#${ticketCh.id}>`, flags: MessageFlags.Ephemeral };
    try {
      if (alreadyUpdated || interaction.replied) {
        await interaction.followUp(replyPayload).catch(() => {});
      } else if (interaction.deferred) {
        await interaction.editReply(replyPayload).catch(() => {});
      } else {
        // Fallback: should not normally happen — caller should defer first
        await interaction.reply(replyPayload).catch(() => {});
      }
    } catch {}

  } catch (e) {
    console.error('createTicketChannel error:', e?.message, e?.stack);
    const errPayload = { content: `❌ Could not create ticket: ${e.message}`, flags: MessageFlags.Ephemeral };
    try {
      if (alreadyUpdated || interaction.replied) {
        await interaction.followUp(errPayload).catch(() => {});
      } else if (interaction.deferred) {
        await interaction.editReply(errPayload).catch(() => {});
      } else {
        await interaction.reply(errPayload).catch(() => {});
      }
    } catch {}
  }
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
  { name: 'promote', description: 'Promote a user via the Chain of Command (SHR can override rank)', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: '[SHR only] Override: skip directly to this rank', required: false }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'demote', description: '[SHR] Demote a user from a role', options: [{ name: 'user', type: 6, description: 'Who?', required: true }, { name: 'role', type: 8, description: 'Role to demote from', required: true }, { name: 'reason', type: 3, description: 'Reason', required: false }] },
  { name: 'verify', description: 'Verify your Roblox account' },
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
  { name: 'startvote', description: 'Start a yes/no vote', options: [
    { name: 'question', type: 3, description: 'The vote question', required: true },
    { name: 'duration', type: 4, description: 'Duration in minutes (default: 5)', required: false },
  ]},
  
  { name: 'loa', description: 'Leave of Absence commands', options: [
    { name: 'request', type: 1, description: 'Submit a LOA request' },
    { name: 'list', type: 1, description: 'View all active LOAs' },
    { name: 'end', type: 1, description: '[Staff] End someone\'s LOA early', options: [{ name: 'user', type: 6, description: 'Who?', required: true }] },
  ]},
  { name: 'setup', description: '[SHR] Open the setup menu' },
  { name: 'reviewstaff', description: 'Leave a review for a staff member or view the leaderboard', options: [
    { name: 'staff', type: 6, description: 'Which staff member do you want to review?', required: false },
    { name: 'leaderboard', type: 5, description: 'Show the staff review leaderboard', required: false },
  ]},
  { name: 'infract', description: '[SHR] Give a user an infraction', options: [
    { name: 'user',   type: 6, description: 'Who?',   required: true  },
    { name: 'type',   type: 3, description: 'Type of infraction', required: true, choices: [
      { name: 'Warning', value: 'warning' },
      { name: 'Strike',  value: 'strike'  },
    ]},
    { name: 'reason', type: 3, description: 'Reason', required: true  },
  ]},
  { name: 'infractions', description: '[SHR] View infractions of a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'clearinfractions', description: '[SHR] Clear all infractions of a user', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'setinfractions', description: '[SHR] Override a user\'s infraction progression level', options: [
    { name: 'user',  type: 6, description: 'Who?', required: true },
    { name: 'level', type: 4, description: 'New progression level (0-7, 0 = clean, 7 = Termination)', required: true, min_value: 0, max_value: 7 },
  ]},
  { name: 'ticket-addstaff', description: 'Add a staff member to this ticket', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'ticket-removestaff', description: 'Remove a staff member from this ticket', options: [
    { name: 'user', type: 6, description: 'Who?', required: true },
  ]},
  { name: 'ticket-rename', description: 'Rename this ticket channel', options: [
    { name: 'name', type: 3, description: 'New name', required: true },
  ]},
  { name: 'ticket-priority', description: 'Set ticket priority', options: [
    { name: 'level', type: 3, description: 'Priority level', required: true, choices: [
      { name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' },
      { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' },
    ]},
  ]},
  { name: 'ticket-note', description: 'Add a note to this ticket', options: [
    { name: 'text', type: 3, description: 'Note text', required: true },
  ]},
  { name: 'ticket-transfer', description: 'Transfer ticket ownership', options: [{ name: 'user', type: 6, description: 'New owner', required: true }] },
  { name: 'ticket-kick', description: 'Remove a user from this ticket', options: [{ name: 'user', type: 6, description: 'Who to remove?', required: true }] },
  { name: 'ticket-reopen', description: 'Reopen a closed ticket channel' },
  { name: 'ticket-archive', description: 'Archive this ticket (make read-only)' },
  { name: 'ticket-delete', description: 'Permanently delete this ticket' },
  { name: 'ticket-info', description: 'View info about this ticket' },
  { name: 'foundership', description: '[Admin] Manage foundership roles', options: [
    { name: 'add', type: 1, description: 'Add foundership role', options: [{ name: 'role', type: 8, description: 'Role', required: true }] },
    { name: 'remove', type: 1, description: 'Remove foundership role', options: [{ name: 'role', type: 8, description: 'Role', required: true }] },
    { name: 'list', type: 1, description: 'List foundership roles' },
  ]},
];

// ════════════════════════════════════════════
// READY
// ════════════════════════════════════════════
// ════ LOA EXPIRY CHECK ════
async function checkLOAExpiry() {
  if (!dbReady) return;
  const now = Date.now();
  for (const [gId, gc] of Object.entries(config)) {
    const lc = getLOAConfig(gId);
    if (!lc.active || !Object.keys(lc.active).length) continue;
    const guild = client.guilds.cache.get(gId);
    if (!guild) continue;
    for (const [userId, loa] of Object.entries(lc.active)) {
      if (now < loa.endsAt) continue;
      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
          if (lc.loaRole) await member.roles.remove(lc.loaRole).catch(() => {});
          await member.setNickname(loa.originalNickname ?? null).catch(() => {});
        }
        if (lc.logChannel) {
          const ch = guild.channels.cache.get(lc.logChannel);
          if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle('✅ LOA Ended').setColor(0x57F287)
            .addFields({ name: '👤 User', value: `<@${userId}>`, inline: true }, { name: '📅 Ended', value: new Date().toUTCString(), inline: true })
            .setTimestamp()] }).catch(() => {});
        }
        await client.users.fetch(userId).then(u => u.send({ embeds: [new EmbedBuilder().setTitle('✅ Your LOA has ended').setColor(0x57F287).setDescription(`Your Leave of Absence in **${guild.name}** has ended. Welcome back!`).setTimestamp()] })).catch(() => {});
      } catch {}
      delete lc.active[userId];
    }
    await saveGuildConfig(gId).catch(() => {});
  }
}

// ════ LOA SETUP PAYLOAD ════
function buildQOTDSetupPayload(guildId) {
  const qc = getQOTDConfig(guildId);
  const total    = qc.library.length;
  const used     = qc.library.filter(q => q.used).length;
  const unused   = total - used;
  const inQueue  = qc.queue.length;

  const embed = new EmbedBuilder()
    .setTitle('❓ Question of the Day Setup')
    .setColor(0xEB459E)
    .setDescription('Post a daily question automatically at a set time.\n\n**Library Stats:**')
    .addFields(
      { name: '✅ Enabled',        value: qc.enabled ? 'Yes' : 'No',                                  inline: true },
      { name: '📢 Channel',        value: qc.channel ? `<#${qc.channel}>` : '*Not set*',               inline: true },
      { name: '⏰ Time (UTC)',     value: `\`${qc.time ?? '09:00'}\``,                                  inline: true },
      { name: '🔔 Ping Role',      value: qc.pingRole ? `<@&${qc.pingRole}>` : '*None*',                inline: true },
      { name: '🤖 Auto-Generate',  value: qc.autoGenerate ? '✅ AI' : '❌ Manual',                     inline: true },
      { name: '🔁 On Exhaust',     value: qc.onExhaust === 'stop' ? '🛑 Stop' : '🔄 Reshuffle',       inline: true },
      { name: '📚 Total',          value: `${total}`,                                                    inline: true },
      { name: '✅ Unused',         value: `${unused}`,                                                   inline: true },
      { name: '📋 Queue',          value: `${inQueue} in queue`,                                         inline: true },
      { name: '📅 Last Posted',    value: qc.lastPosted ?? '*Never*',                                    inline: true },
      { name: '💬 Last Question',  value: qc.lastQuestion ? qc.library.find(q => q.id === qc.lastQuestion)?.text?.slice(0, 50) ?? '*Unknown*' : '*None*', inline: false },
    );

  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qotd__toggle').setLabel(qc.enabled ? 'Disable' : 'Enable').setStyle(qc.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(qc.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('qotd__channel').setLabel('Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('qotd__time').setLabel('Time').setStyle(ButtonStyle.Primary).setEmoji('⏰'),
    new ButtonBuilder().setCustomId('qotd__pingrole').setLabel('Ping Role').setStyle(ButtonStyle.Primary).setEmoji('🔔'),
    new ButtonBuilder().setCustomId('qotd__exhaust').setLabel(qc.onExhaust === 'stop' ? 'Set: Reshuffle' : 'Set: Stop').setStyle(ButtonStyle.Secondary).setEmoji('🔁'),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qotd__add_question').setLabel('Add One').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('qotd__bulk_import').setLabel('Bulk Import').setStyle(ButtonStyle.Success).setEmoji('📥'),
    new ButtonBuilder().setCustomId('qotd__shuffle').setLabel('Shuffle Queue').setStyle(ButtonStyle.Primary).setEmoji('🔀'),
    new ButtonBuilder().setCustomId('qotd__reset_usage').setLabel('Reset Usage').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
    new ButtonBuilder().setCustomId('qotd__post_now').setLabel('Post Now').setStyle(ButtonStyle.Success).setEmoji('🚀'),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qotd__view_questions').setLabel('View Questions').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('qotd__remove_dupes').setLabel('Remove Duplicates').setStyle(ButtonStyle.Secondary).setEmoji('🧹'),
    new ButtonBuilder().setCustomId('qotd__export').setLabel('Export').setStyle(ButtonStyle.Secondary).setEmoji('📤'),
    new ButtonBuilder().setCustomId('qotd__clear_questions').setLabel('Delete All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    new ButtonBuilder().setCustomId('qotd__autogenerate').setLabel(qc.autoGenerate ? 'Disable AI' : 'Enable AI').setStyle(qc.autoGenerate ? ButtonStyle.Danger : ButtonStyle.Secondary).setEmoji('🤖'),
  );
  return { embeds: [embed], components: [r1, r2, r3], flags: MessageFlags.Ephemeral };
}

function buildTicketInactivitySetupPayload(guildId) {
  const ic = getTicketInactivityConfig(guildId);
  const embed = new EmbedBuilder()
    .setTitle('⏱️ Ticket Inactivity Setup')
    .setColor(0xFEE75C)
    .setDescription('Automatically warn and close inactive tickets.\n\n**Variables:** `{time}` `{closeIn}` `{channel}`')
    .addFields(
      { name: '✅ Enabled',          value: ic.enabled ? 'Yes' : 'No',                                         inline: true },
      { name: '⚠️ Warn After',       value: `${ic.warnAfterMinutes ?? 1440} min (${Math.round((ic.warnAfterMinutes ?? 1440)/60)}h)`, inline: true },
      { name: '🔒 Close After',      value: `${ic.closeAfterMinutes ?? 2880} min (${Math.round((ic.closeAfterMinutes ?? 2880)/60)}h)`, inline: true },
      { name: '📩 DM on Auto-Close', value: ic.dmOnClose ? 'Yes' : 'No',                                       inline: true },
      { name: '💬 Warn Message',     value: `\`\`\`${String(ic.warnMessage ?? '').slice(0, 100)}\`\`\``,       inline: false },
    );
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tkt_inactivity__toggle').setLabel(ic.enabled ? 'Disable' : 'Enable').setStyle(ic.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji(ic.enabled ? '🔴' : '🟢'),
    new ButtonBuilder().setCustomId('tkt_inactivity__settings').setLabel('Edit Settings').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
    new ButtonBuilder().setCustomId('tkt_inactivity__dm').setLabel(ic.dmOnClose ? 'Disable DM' : 'Enable DM').setStyle(ic.dmOnClose ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji('📩'),
  );
  return { embeds: [embed], components: [r1], flags: MessageFlags.Ephemeral };
}

function buildLOASetupPayload(guildId) {
  const lc = getLOAConfig(guildId);
  const activeList = Object.entries(lc.active);
  const embed = new EmbedBuilder().setTitle('🏖️ Leave of Absence Setup').setColor(0x5865F2)
    .addFields(
      { name: '🎭 LOA Role', value: lc.loaRole ? `<@&${lc.loaRole}>` : '*Not set*', inline: true },
      { name: '🔑 Approval Roles', value: lc.approvalRoles?.length ? lc.approvalRoles.map(r => `<@&${r}>`).join(', ') : '*Not set*', inline: true },
      { name: '✅ Required Approvals', value: `${lc.requiredApprovals ?? 1}`, inline: true },
      { name: '📋 Log Channel', value: lc.logChannel ? `<#${lc.logChannel}>` : '*Not set*', inline: true },
      { name: '🏷️ Prefix', value: `\`${lc.prefix ?? '[LOA]'}\``, inline: true },
      { name: '📊 Active LOAs', value: activeList.length ? activeList.map(([uid, l]) => `<@${uid}> — <t:${Math.floor(l.endsAt/1000)}:R>`).join('\n') : '*None*', inline: false },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('loa__set_role').setLabel('LOA Role').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
    new ButtonBuilder().setCustomId('loa__set_approval_roles').setLabel('Approval Roles').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('loa__set_approvals').setLabel('Required Approvals').setStyle(ButtonStyle.Primary).setEmoji('✅'),
    new ButtonBuilder().setCustomId('loa__set_log').setLabel('Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('loa__set_prefix').setLabel('Prefix').setStyle(ButtonStyle.Primary).setEmoji('🏷️'),
  );
  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

client.once('clientReady', async () => {
  console.log(`✅ Bot online as ${userDisplay(client.user)} | DB: ${dbReady ? '✅ Verbonden' : '❌ Niet verbonden'}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    const commandHash = crypto.createHash('md5').update(JSON.stringify(commands)).digest('hex');
    const gc = config['_global'] ?? {};
    if (gc._commandHash !== commandHash) {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      gc._commandHash = commandHash;
      config['_global'] = gc;
      await saveGuildConfig('_global').catch(() => {});
      console.log('✅ Commands registered (hash changed)');
    } else {
      console.log('✅ Commands up-to-date (skipped re-register)');
    }
  }
  catch (e) { console.error('❌ Command registration failed:', e); }
  for (const guild of client.guilds.cache.values()) { await updateCounters(guild).catch(console.error); }

  // Restore open tickets from database (Part 9d)
  try {
    const openTicketRecords = await TicketModel.find({ status: 'open' });
    for (const t of openTicketRecords) {
      if (t.creatorId && t.channelId) openTickets.set(t.creatorId, t.channelId);
    }
    console.log(`✅ Restored ${openTicketRecords.length} open ticket(s) from database.`);
  } catch (e) {
    console.error('❌ Failed to restore open tickets:', e.message);
  }

  // ════ LOA EXPIRY CHECK (moved inside clientReady — Part 10c) ════
  setInterval(() => checkLOAExpiry().catch(console.error), 60_000);

  // ════ QOTD DAILY SCHEDULER ════
  // Check every minute if it's time to post QOTD
  setInterval(async () => {
    if (!dbReady) return;
    const now = new Date();
    const currentTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);

    for (const guild of client.guilds.cache.values()) {
      try {
        const qc = getQOTDConfig(guild.id);
        if (!qc.enabled) continue;
        if (qc.lastPosted === today) continue;
        if (currentTime !== qc.time) continue;
        await postQOTD(guild, guild.id).catch(e => console.error(`QOTD error [${guild.name}]:`, e));
      } catch { /* skip guild */ }
    }
  }, 60_000);

  // ════ TICKET AUTO-CLOSE (MongoDB autoCloseAt) ════
  // Auto-close tickets past autoCloseAt
  setInterval(async () => {
    if (!dbReady) return;
    try {
      const overdueTickets = await TicketModel.find({ status: 'open', autoCloseAt: { $lte: new Date() } }).catch(() => []);
      for (const t of overdueTickets) {
        try {
          const guild = client.guilds.cache.get(t.guildId);
          if (!guild) continue;
          const ch = guild.channels.cache.get(t.channelId);
          if (!ch) { await TicketModel.findOneAndUpdate({ channelId: t.channelId }, { status: 'closed', closedAt: new Date() }); continue; }
          await ch.send({ embeds: [new EmbedBuilder().setTitle('🔒 Auto-Closed').setColor(0xED4245).setDescription('This ticket was automatically closed due to inactivity or auto-close setting.').setTimestamp()] }).catch(() => {});
          await TicketModel.findOneAndUpdate({ channelId: t.channelId }, { status: 'closed', closedAt: new Date() });
          openTickets.delete(t.creatorId);
          setTimeout(() => ch.delete().catch(() => {}), 5000);
        } catch {}
      }
    } catch {}
  }, 5 * 60_000);

  setInterval(async () => {
    if (!dbReady) return;
    for (const guild of client.guilds.cache.values()) {
      try {
        const ic = getTicketInactivityConfig(guild.id);
        if (!ic.enabled) continue;
        const tc = getTicketConfig(guild.id);
        const warnMs  = (ic.warnAfterMinutes  ?? 1440) * 60_000;
        const closeMs = (ic.closeAfterMinutes ?? 2880) * 60_000;

        for (const [userId, channelId] of openTickets.entries()) {
          try {
            const ch = guild.channels.cache.get(channelId);
            if (!ch) continue;

            // Fetch last message — prefer cache to avoid API rate limits
            let lastMsg = ch.messages.cache.size ? ch.messages.cache.last() : null;
            if (!lastMsg) {
              const messages = await ch.messages.fetch({ limit: 1 }).catch(() => null);
              if (!messages) continue;
              lastMsg = messages.first();
              if (!lastMsg) continue;
            }

            const inactiveSince = Date.now() - lastMsg.createdTimestamp;
            const timeStr = inactiveSince > 3600000
              ? `${Math.floor(inactiveSince / 3600000)} hour(s)`
              : `${Math.floor(inactiveSince / 60000)} minute(s)`;
            const closeInMs = closeMs - inactiveSince;
            const closeInStr = closeInMs > 3600000
              ? `${Math.floor(closeInMs / 3600000)} hour(s)`
              : `${Math.floor(closeInMs / 60000)} minute(s)`;

            // Auto-close
            if (inactiveSince >= closeMs) {
              // DM the user
              if (ic.dmOnClose) {
                const user = await client.users.fetch(userId).catch(() => null);
                if (user) {
                  await safeDM(user, {
                    embeds: [new EmbedBuilder()
                      .setTitle('🔒 Ticket Auto-Closed')
                      .setColor(0xED4245)
                      .setDescription(`Your ticket **${ch.name}** in **${guild.name}** was automatically closed due to **${timeStr}** of inactivity.`)
                      .setTimestamp()
                    ],
                  });
                }
              }
              // Send close message and delete
              await ch.send({ embeds: [new EmbedBuilder()
                .setTitle('🔒 Ticket Closed — Inactivity')
                .setColor(0xED4245)
                .setDescription(`This ticket has been automatically closed after **${timeStr}** of inactivity.`)
                .setTimestamp()
              ]}).catch(() => {});
              openTickets.delete(userId);
              await updateTicketRecord(channelId, { status: 'closed', closedAt: new Date() }).catch(() => {});
              await logTicketAction(guild, guild.id, 'closed', { channel: channelId, user: userId, by: client.user.id, extra: 'Auto-closed due to inactivity' }).catch(() => {});
              setTimeout(() => ch.delete().catch(() => {}), 5000);
              continue;
            }

            // Warn — only send once (check if last message is already a bot warning)
            if (inactiveSince >= warnMs) {
              if (lastMsg.author.id === client.user.id && lastMsg.embeds?.[0]?.title?.includes('Inactive')) continue;
              const warnText = (ic.warnMessage ?? '⚠️ This ticket has been inactive for {time}. It will be closed in {closeIn} if there is no response.')
                .replace(/{time}/g, timeStr)
                .replace(/{closeIn}/g, closeInStr)
                .replace(/{channel}/g, `<#${channelId}>`);
              await ch.send({ embeds: [new EmbedBuilder()
                .setTitle('⚠️ Ticket Inactive')
                .setColor(0xFEE75C)
                .setDescription(warnText)
                .setTimestamp()
              ]}).catch(() => {});
            }
          } catch { /* skip ticket */ }
        }
      } catch { /* skip guild */ }
    }
  }, 5 * 60_000); // Check every 5 minutes

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


client.on('guildCreate', async guild => {
  createDefaultConfig(guild.id);

  // Pre-initialize all subsystems so no handler ever hits undefined
  getSessionConfig(guild.id);
  getTicketConfig(guild.id);
  getAnnouncementConfig(guild.id);
  getSelfRoleConfig(guild.id);
  getWelcomerConfig(guild.id);
  getAutoroleConfig(guild.id);
  getVerificationConfig(guild.id);
  getApplicationConfig(guild.id);
  getSavedMessagesConfig(guild.id);
  getAutomodConfig(guild.id);
  getCounterConfig(guild.id);
  getVoteConfig(guild.id);
  getPermissionsConfig(guild.id);
  getDepartmentsConfig(guild.id);
  getGlobalAnnouncementConfig(guild.id);
  getBotConfig(guild.id);
  getInfractionConfig(guild.id);
  getLOAConfig(guild.id);
  getQOTDConfig(guild.id);
  getAntipingConfig(guild.id);
  getTicketInactivityConfig(guild.id);
  getTicketV2Config(guild.id);
  getFoundershipConfig(guild.id);
  getStaffRankConfig(guild.id);
  getChainConfig(guild.id);
  await saveGuildConfig(guild.id);
  console.log(`✅ Joined guild: ${guild.name} (${guild.id}) — config initialized.`);
});

const counterUpdatePending = new Set();
function scheduleCounterUpdate(guild) {
  if (counterUpdatePending.has(guild.id)) return;
  counterUpdatePending.add(guild.id);
  setTimeout(async () => {
    counterUpdatePending.delete(guild.id);
    await updateCounters(guild).catch(console.error);
  }, 10_000); // batch updates binnen een venster van 10 seconden
}
client.on('guildMemberAdd', member => scheduleCounterUpdate(member.guild));
client.on('guildMemberRemove', member => scheduleCounterUpdate(member.guild));

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

  // ── Role Ping Protection ──
  try {
    const rpp = getRolePingProtectionConfig(guildId);
    const hasMentionedRole = rpp.protectedRoles?.length && message.mentions.roles.size > 0 && rpp.protectedRoles.find(rid => message.mentions.roles.has(rid));
    const hasMentionedUserWithRole = rpp.protectedRoles?.length && message.mentions.users.size > 0 && (() => {
      for (const [uid] of message.mentions.users) {
        const mentionedMember = message.guild.members.cache.get(uid);
        if (mentionedMember && rpp.protectedRoles.some(rid => mentionedMember.roles.cache.has(rid))) return true;
      }
      return false;
    })();
    if (rpp.enabled && (hasMentionedRole || hasMentionedUserWithRole)) {
      const member = message.member;
      if (member) {
        const pingedProtectedRole = hasMentionedRole || rpp.protectedRoles.find(rid => {
          for (const [uid] of message.mentions.users) {
            const m = message.guild.members.cache.get(uid);
            if (m && m.roles.cache.has(rid)) return true;
          }
          return false;
        });
        if (pingedProtectedRole) {
          const isAllowed = hasSetup(member)
            || isFoundership(member)
            || (rpp.allowedRoles?.length && rpp.allowedRoles.some(r => member.roles.cache.has(r)))
            || (rpp.allowedUsers?.length && rpp.allowedUsers.includes(message.author.id));
          if (!isAllowed) {
            const protectedRole = message.guild.roles.cache.get(pingedProtectedRole);
            const warnText = (rpp.warnMessage || '⚠️ {user}, you are not allowed to ping {role}.')
              .replace(/{user}/g, `<@${message.author.id}>`)
              .replace(/{role}/g, protectedRole ? `@${protectedRole.name}` : 'that role');
            const action = rpp.action || 'delete';

            if (action === 'warn') {
              // Ping supprimeren: bericht editen en mentions strippen
              const stripped = message.content
                .replace(/<@&[0-9]+>/g, '[role ping verwijderd]')
                .replace(/<@!?[0-9]+>/g, m => {
                  const uid = m.replace(/<@!?/, '').replace('>', '');
                  const tgt = message.guild.members.cache.get(uid);
                  if (tgt && rpp.protectedRoles?.some(rid => tgt.roles.cache.has(rid))) return '[ping verwijderd]';
                  return m;
                });
              await message.edit(stripped).catch(() => {});
            } else {
              // delete / delete+warn / delete+mute: bericht verwijderen
              await message.delete().catch(() => {});
            }

            // Altijd DM sturen
            await message.author.send({
              embeds: [new EmbedBuilder()
                .setTitle('⚠️ Warning — Ping Not Allowed')
                .setColor(0xFEE75C)
                .setDescription(warnText.replace(`<@${message.author.id}>`, 'You'))
                .addFields(
                  { name: '📢 Server', value: message.guild.name, inline: true },
                  { name: '💬 Channel', value: `<#${message.channel.id}>`, inline: true },
                  { name: '🎭 Pinged Role/Person', value: protectedRole ? `@${protectedRole.name}` : 'protected role', inline: true },
                  { name: '⚙️ Action', value: action, inline: true },
                )
                .setFooter({ text: 'This message is only visible to you.' })
                .setTimestamp()
              ]
            }).catch(() => {});

            // Warn opslaan (altijd)
            await addWarning(guildId, message.author.id, {
              reason: `Role ping protection: pinged ${protectedRole?.name ?? pingedProtectedRole}`,
              moderator: 'Automod',
              date: new Date().toUTCString(),
            });
            if (action === 'delete+mute') {
              await member.timeout((rpp.muteMinutes ?? 5) * 60000, 'Role ping protection').catch(() => {});
            }
            if (rpp.logChannel) {
              const logCh = message.guild.channels.cache.get(rpp.logChannel);
              if (logCh) await logCh.send({ embeds: [new EmbedBuilder()
                .setTitle('🔔 Role Ping Blocked')
                .setColor(0xED4245)
                .addFields(
                  { name: '👤 User',             value: `${userDisplay(message.author)} (<@${message.author.id}>)`, inline: true },
                  { name: '📢 Channel',           value: `<#${message.channel.id}>`,                        inline: true },
                  { name: '🎭 Attempted Ping',    value: protectedRole ? `<@&${protectedRole.id}>` : pingedProtectedRole, inline: true },
                  { name: '⚙️ Action',            value: rpp.action || 'delete',                            inline: true },
                  { name: '💬 Message',           value: message.content.slice(0, 500),                     inline: false },
                ).setTimestamp()
              ]}).catch(() => {});
            }
          }
        }
      }
    }
  } catch (rppErr) { console.error('Role ping protection error:', rppErr); }

  const am = getAutomodConfig(guildId);
  if (!am.enabled || !am.keywords.length) return;
  try {
    const ap = getAntipingConfig(guildId);
    if (ap.enabled && (message.content.includes('@everyone') || message.content.includes('@here'))) {
      const member = message.member;
      if (member) {
        const isExempt = hasAnyStaff(member)
          || member.permissions.has(PermissionFlagsBits.Administrator)
          || member.permissions.has(PermissionFlagsBits.MentionEveryone)
          || (ap.exemptRoles?.length && ap.exemptRoles.some(r => member.roles.cache.has(r)))
          || (ap.exemptChannels?.length && ap.exemptChannels.includes(message.channel.id));
        if (!isExempt) {
          await message.delete().catch(() => {});
          const warnText = (ap.warnMessage || '⚠️ {user}, you are not allowed to ping @everyone or @here.')
            .replace(/{user}/g, `<@${message.author.id}>`);
          const warnMsg = await message.channel.send({ content: warnText }).catch(() => null);
          if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), 5000);
          if (ap.action === 'delete+warn') {
            await addWarning(guildId, message.author.id, { reason: 'Antiping: used @everyone/@here', moderator: 'Antiping', date: new Date().toUTCString() });
          } else if (ap.action === 'delete+mute') {
            await member.timeout((ap.muteMinutes ?? 5) * 60000, 'Antiping: used @everyone/@here').catch(() => {});
          }
          if (ap.logChannel) {
            const logCh = message.guild.channels.cache.get(ap.logChannel);
            if (logCh) await logCh.send({ embeds: [new EmbedBuilder()
              .setTitle('🔔 Antiping Triggered')
              .setColor(0xED4245)
              .addFields(
                { name: '👤 User',    value: `${userDisplay(message.author)} (<@${message.author.id}>)`, inline: true },
                { name: '📢 Channel', value: `<#${message.channel.id}>`,                         inline: true },
                { name: '⚙️ Action',  value: ap.action || 'delete',                              inline: true },
                { name: '💬 Message', value: message.content.slice(0, 500),                       inline: false },
              ).setTimestamp()
            ]}).catch(() => {});
          }
        }
      }
    }
  } catch (apErr) { console.error('Antiping error:', apErr); }

  if (!am.enabled || !am.keywords.length) return;
  const member = message.member;
  if (!member || !member.roles?.cache) return;
  if (hasAnyStaff(member) || member.permissions.has(PermissionFlagsBits.Administrator)) return;
  const content = message.content.toLowerCase();
  const triggered = am.keywords.find(kw => content.includes(kw.toLowerCase()));
  if (!triggered) return;
  try {
    await message.delete().catch(() => {});
    const logEmbed = new EmbedBuilder().setTitle('🛡️ Automod Triggered').setColor(0xED4245)
      .addFields(
        { name: '👤 User', value: `${userDisplay(message.author)} (<@${message.author.id}>)`, inline: true },
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
  if (!dbReady) return;
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
    const vars = { userMention: `<@${member.user.id}>`, username: member.user.username, userTag: userDisplay(member.user), memberCount: member.guild.memberCount.toString(), server: member.guild.name };
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

  // Rating buttons en modals komen uit DMs — die mogen geen guildId hebben
  const isDMRating = !guildId && (
    (interaction.isButton() && interaction.customId.startsWith('rating__')) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rating__'))
  );

  if (!guildId && !isDMRating) {
    try { if (interaction.isRepliable()) await interaction.reply({ content: '❌ Server only.', flags: MessageFlags.Ephemeral }); } catch {}
    return;
  }

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
      let user = null, member = null, reason = 'No reason provided';
      try { user   = interaction.options.getUser('user') ?? null;   } catch {}
      try { member = user ? interaction.options.getMember('user') : null; } catch {}
      try { reason = interaction.options.getString('reason') ?? 'No reason provided'; } catch {}

      if (cmd === 'invite') {
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('📨 Invite Link')
        .setColor(0x5865F2)
        .setDescription('Click the button below to add the bot to your server!\n\n> You need **Administrator** permissions on the server.')
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Add Bot')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl)
          .setEmoji('🤖')
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}
      
      if (cmd === 'close') {
        const closeRecord = await getTicketRecord(interaction.channel.id);
        if (!closeRecord || closeRecord.status === 'closed') {
          return interaction.reply({ content: '❌ This channel is not an open ticket.', flags: MessageFlags.Ephemeral });
        }
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.channel;
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${userDisplay(m.author)}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        pendingCloseReqs.delete(ch.id);
        await interaction.reply({ content: `🔒 Ticket closed by **${userDisplay(interaction.user)}**. Deleting in 3 seconds...` });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
      }
      if (cmd === 'closerequest') {
        const ch = interaction.channel;
        if (pendingCloseReqs.has(ch.id)) return interaction.reply({ content: '❌ A close request is already pending.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🔒 Close Request').setDescription(`**${userDisplay(interaction.user)}** has requested to close this ticket.\n\nStaff can accept or deny below.`).setColor(0xFEE75C).setTimestamp();
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
        // If training types are configured, show a dropdown first
        if (tc.types && tc.types.length > 0) {
          const typeSelect = new StringSelectMenuBuilder()
            .setCustomId('tr_select_type')
            .setPlaceholder('Select the training type...')
            .addOptions(tc.types.slice(0, 25).map(t => ({ label: t.name, value: String(t.id), description: t.roleId ? `Role: will be assigned on pass` : 'No role assigned' })));
          return interaction.reply({
            content: '### 🎓 Select the type of training you are requesting:',
            components: [new ActionRowBuilder().addComponents(typeSelect)],
            flags: MessageFlags.Ephemeral,
          });
        }
        // No types configured — open modal directly
        const modal = new ModalBuilder().setCustomId('modal_trainrequest__none').setTitle('Training Request');
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

      if (cmd === 'ping') { const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true, flags: MessageFlags.Ephemeral }); return interaction.editReply(`🏓 Pong! Bot: ${sent.createdTimestamp - interaction.createdTimestamp}ms | API: ${client.ws.ping}ms`); }
      if (cmd === 'avatar') { const t = interaction.options.getUser('user') ?? interaction.user; return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🖼️ ${t.username}'s Avatar`).setImage(t.displayAvatarURL({ size: 1024, dynamic: true })).setColor(0x5865F2)], flags: MessageFlags.Ephemeral }); }
      if (cmd === 'serverinfo') {
        const g = interaction.guild; await g.fetch(); const owner = await g.fetchOwner();
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📊 ${g.name}`).setThumbnail(g.iconURL({ dynamic: true })).setColor(0x5865F2).addFields({ name: '👑 Owner', value: userDisplay(owner.user), inline: true }, { name: '👥 Members', value: `${g.memberCount}`, inline: true }, { name: '📅 Created', value: g.createdAt.toDateString(), inline: true }, { name: '💬 Channels', value: `${g.channels.cache.size}`, inline: true }, { name: '🎭 Roles', value: `${g.roles.cache.size}`, inline: true }).setTimestamp()], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'roleinfo') { const role = interaction.options.getRole('role'); return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🎭 ${role.name}`).setColor(role.color || 0x5865F2).addFields({ name: '🆔 ID', value: role.id, inline: true }, { name: '🎨 Color', value: role.hexColor, inline: true }, { name: '👥 Members', value: `${role.members.size}`, inline: true }).setTimestamp()], flags: MessageFlags.Ephemeral }); }
      if (cmd === 'poll') {
        const question = interaction.options.getString('question');
        const opts = [interaction.options.getString('option1'), interaction.options.getString('option2'), interaction.options.getString('option3'), interaction.options.getString('option4')].filter(Boolean);
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const embed = new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(opts.map((o, i) => `${emojis[i]} ${o}`).join('\n\n')).setColor(0x5865F2).setFooter({ text: `Poll by ${userDisplay(interaction.user)}` }).setTimestamp();
        const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
        for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]);
      }
      if (cmd === 'userinfo') {
        const tu = interaction.options.getUser('user'); const tm = interaction.options.getMember('user');
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`👤 ${userDisplay(tu)}`).setThumbnail(tu.displayAvatarURL({ dynamic: true })).setColor(0x5865F2).addFields({ name: '🆔 ID', value: tu.id, inline: true }, { name: '📅 Created', value: tu.createdAt.toDateString(), inline: true }, { name: '📥 Joined', value: tm?.joinedAt?.toDateString() ?? 'Unknown', inline: true }, { name: '🎭 Roles', value: tm?.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None', inline: false }).setTimestamp()] });
      }
      if (cmd === 'warn') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await addWarning(guildId, user.id, { reason, moderator: userDisplay(interaction.user), date: new Date().toUTCString() });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('⚠️ Warning Issued').setColor(0xFEE75C).addFields({ name: 'User', value: userDisplay(user), inline: true }, { name: 'Warnings', value: `${getWarnings(guildId, user.id).length}`, inline: true }, { name: 'Reason', value: reason }).setTimestamp()], flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'mute') {
        if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral });
        await member.timeout(interaction.options.getInteger('minutes') * 60000, reason);
        return interaction.reply({ content: `🔇 **${userDisplay(user)}** muted. Reason: ${reason}`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'unmute') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await member.timeout(null); return interaction.reply({ content: `🔊 **${userDisplay(user)}** unmuted.`, flags: MessageFlags.Ephemeral }); }
      if (cmd === 'slowmode') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); const s = interaction.options.getInteger('seconds'); await interaction.channel.setRateLimitPerUser(s); return interaction.reply({ content: `✅ Slowmode: **${s}s**.`, flags: MessageFlags.Ephemeral }); }
      if (cmd === 'lock')   { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }); return interaction.reply({ content: '🔒 Channel **locked**.', flags: MessageFlags.Ephemeral }); }
      if (cmd === 'unlock') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: true }); return interaction.reply({ content: '🔓 Channel **unlocked**.', flags: MessageFlags.Ephemeral }); }
      if (cmd === 'clear')  { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff or SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const del = await interaction.channel.bulkDelete(Math.min(interaction.options.getInteger('amount'), 100), true); return interaction.editReply({ content: `✅ Deleted **${del.size}** messages.` }); }
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

      if (cmd === 'ban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        if (!user) return interaction.reply({ content: '❌ User not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await interaction.guild.members.ban(user, { deleteMessageSeconds: 604800, reason });
          return interaction.editReply({ content: `🔨 **${userDisplay(user)}** banned. Reason: ${reason}` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'unban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const userId2 = interaction.options.getString('userid');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await interaction.guild.members.unban(userId2, reason);
          return interaction.editReply({ content: `✅ User \`${userId2}\` unbanned.` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'kick') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        if (!member) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await member.kick(reason);
          return interaction.editReply({ content: `👢 **${userDisplay(user)}** kicked. Reason: ${reason}` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'softban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        if (!user) return interaction.reply({ content: '❌ User not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await interaction.guild.members.ban(user, { deleteMessageSeconds: 604800, reason });
          await interaction.guild.members.unban(user.id, 'softban');
          return interaction.editReply({ content: `🔨 **${userDisplay(user)}** softbanned (kicked + messages deleted).` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'tempban') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        if (!user) return interaction.reply({ content: '❌ User not found.', flags: MessageFlags.Ephemeral });
        const hours = interaction.options.getInteger('hours');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await interaction.guild.members.ban(user, { deleteMessageSeconds: 86400, reason });
          setTimeout(async () => {
            await interaction.guild.members.unban(user.id, 'tempban expired').catch(() => {});
          }, hours * 3600000);
          return interaction.editReply({ content: `🔨 **${userDisplay(user)}** temp-banned for **${hours}h**. Reason: ${reason}` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'nickname') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        if (!member) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const nick = interaction.options.getString('nickname') ?? null;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await member.setNickname(nick, `Changed by ${userDisplay(interaction.user)}`);
          return interaction.editReply({ content: nick ? `✅ Nickname set to \`${nick}\`.` : `✅ Nickname cleared.` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'addrole') {
        const role = interaction.options.getRole('role');
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const rp = getRolePermConfig(guildId);
        const perms = rp[role.id];
        const canAdd = hasSetup(interaction.member) || !perms?.addRoles?.length || perms.addRoles.some(r => interaction.member.roles.cache.has(r));
        if (!canAdd) return interaction.reply({ content: `❌ You don't have permission to add <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await targetMember.roles.add(role);
          return interaction.editReply({ content: `✅ Added <@&${role.id}> to **${userDisplay(targetMember.user)}**.` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'removerole') {
        const role = interaction.options.getRole('role');
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const rp = getRolePermConfig(guildId);
        const perms = rp[role.id];
        const canRemove = hasSetup(interaction.member) || !perms?.removeRoles?.length || perms.removeRoles.some(r => interaction.member.roles.cache.has(r));
        if (!canRemove) return interaction.reply({ content: `❌ You don't have permission to remove <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await targetMember.roles.remove(role);
          return interaction.editReply({ content: `✅ Removed <@&${role.id}> from **${userDisplay(targetMember.user)}**.` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }
      if (cmd === 'giveroles') {
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const rolesRaw = interaction.options.getString('roles');
        const roleIds = rolesRaw.match(/\d{17,20}/g) ?? [];
        if (!roleIds.length) return interaction.reply({ content: '❌ No valid role IDs found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let added = 0, failed = 0;
        for (const rid of roleIds) {
          const role = interaction.guild.roles.cache.get(rid);
          if (!role) { failed++; continue; }
          try { await targetMember.roles.add(role); added++; } catch { failed++; }
        }
        return interaction.editReply({ content: `✅ Added **${added}** role(s) to **${userDisplay(targetMember.user)}**${failed ? ` (${failed} failed)` : ''}.` });
      }
      if (cmd === 'verify') {
        const vc = getVerificationConfig(guildId);
        if (!vc.enabled) return interaction.reply({ content: '❌ Verification is not enabled on this server.', flags: MessageFlags.Ephemeral });
        if (vc.verifiedRole && interaction.member.roles.cache.has(vc.verifiedRole)) return interaction.reply({ content: '✅ You are already verified!', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId('modal_verify_username').setTitle('Roblox Verification — Step 1');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true).setMinLength(3).setMaxLength(20)));
        return interaction.showModal(modal);
      }
      if (cmd === 'unverify') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        if (vc.verifiedRole) {
          await targetMember.roles.remove(vc.verifiedRole).catch(() => {});
        }
        if (vc.verifiedUsers?.[user.id]) {
          delete vc.verifiedUsers[user.id];
          await saveGuildConfig(guildId);
        }
        await targetMember.setNickname(null, 'Unverified by staff').catch(() => {});
        return interaction.reply({ content: `✅ **${userDisplay(user)}** has been unverified.`, flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'removeverifiedroles') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        if (!vc.verifiedRole) return interaction.reply({ content: '❌ No verified role set up.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const role = interaction.guild.roles.cache.get(vc.verifiedRole);
        if (!role) return interaction.editReply('❌ Verified role not found.');
        if (interaction.guild.memberCount > 5000) {
          return interaction.editReply('❌ This server is too large for a mass role removal. Use a bot designed for bulk operations.');
        }
        const members = await interaction.guild.members.fetch().catch(() => null);
        if (!members) return interaction.editReply('❌ Could not fetch members.');
        let removed = 0, failed = 0;
        for (const [, member] of members) {
          if (member.user.bot) continue;
          if (!member.roles.cache.has(vc.verifiedRole)) continue;
          try { await member.roles.remove(vc.verifiedRole, 'Mass unverify by staff'); removed++; }
          catch { failed++; }
          await new Promise(r => setTimeout(r, 600));
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

      if (cmd === 'warnings') { if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral }); const warns = getWarnings(guildId, user.id); if (!warns.length) return interaction.reply({ content: `✅ No warnings.`, flags: MessageFlags.Ephemeral }); return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`⚠️ Warnings — ${userDisplay(user)}`).setColor(0xFEE75C).setDescription(warns.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.moderator}*`).join('\n'))] }); }
      if (cmd === 'reviewstaff') {
        const src = getStaffReviewConfig(guildId);
        if (!src.channel) return interaction.reply({ content: '❌ Staff review channel is not set up. Ask an admin to run `/setup`.', flags: MessageFlags.Ephemeral });

        // Leaderboard flag
        if (interaction.options.getBoolean('leaderboard')) {
          const lbEmbed = buildStaffLeaderboardEmbed(guildId);
          if (!lbEmbed) return interaction.reply({ content: '📭 No reviews have been submitted yet.', flags: MessageFlags.Ephemeral });
          return interaction.reply({ embeds: [lbEmbed] });
        }

        const targetUser = interaction.options.getUser('staff');
        if (!targetUser) return interaction.reply({ content: '❌ Please specify a staff member or use `leaderboard: True`.', flags: MessageFlags.Ephemeral });
        if (targetUser.id === interaction.user.id) return interaction.reply({ content: '❌ You cannot review yourself.', flags: MessageFlags.Ephemeral });
        if (targetUser.bot) return interaction.reply({ content: '❌ You cannot review a bot.', flags: MessageFlags.Ephemeral });
        if (src.staffRoles.length) {
          const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
          const isStaff = targetMember && src.staffRoles.some(r => targetMember.roles.cache.has(r));
          if (!isStaff) return interaction.reply({ content: `❌ **${userDisplay(targetUser)}** is not a staff member.`, flags: MessageFlags.Ephemeral });
        }
        const ratingRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`sr2_rating__${targetUser.id}`)
            .setPlaceholder('Select a star rating...')
            .addOptions([
              { label: '⭐ 1 — Very poor', value: '1' },
              { label: '⭐⭐ 2 — Poor', value: '2' },
              { label: '⭐⭐⭐ 3 — Average', value: '3' },
              { label: '⭐⭐⭐⭐ 4 — Good', value: '4' },
              { label: '⭐⭐⭐⭐⭐ 5 — Excellent', value: '5' },
            ])
        );
        return interaction.reply({
          content: `### ⭐ Rate **${userDisplay(targetUser)}**\nSelect a star rating below. You'll then be asked to write a short review.`,
          components: [ratingRow],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (cmd === 'promote') {
        const targetMember = interaction.options.getMember('user');
        const overrideRole = interaction.options.getRole('role'); // SHR-only override
        const promoteReason = interaction.options.getString('reason') ?? 'No reason provided';
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

        const isSHR = hasSHR(interaction.member);

        // Toegang: SHR altijd, anders alleen instelbare promote-rollen
        if (!hasPromoteAccess(interaction.member, guildId)) {
          return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        }

        // Override (rol-keuze) is exclusief voor SHR
        if (overrideRole && !isSHR) {
          return interaction.reply({ content: '❌ Only SHR can specify a target rank to override the Chain of Command order.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const cc = getChainConfig(guildId);
        if (!cc.chain.length) {
          return interaction.editReply({ content: '❌ No Chain of Command is configured. Set it up via `/setup` → Chain of Command.' });
        }

        const currentPosition = getMemberChainPosition(targetMember, cc.chain);
        const isAtTop = currentPosition === cc.chain[cc.chain.length - 1]?.position;
        if (isAtTop) return interaction.editReply({ content: '❌ This member is already at the highest rank in the chain.' });

        // SHR override: spring naar een specifieke rank (moet wel in de chain staan)
        let skipTo = null;
        if (overrideRole) {
          if (!cc.chain.some(e => e.roleId === overrideRole.id)) {
            return interaction.editReply({ content: '❌ That role is not part of the Chain of Command.' });
          }
          skipTo = overrideRole.id;
        }

        const result = await promoteInChain(interaction.guild, targetMember, interaction.user, guildId, skipTo);
        if (!result.success) return interaction.editReply({ content: `❌ ${result.reason}` });

        // Stuur gecombineerd bericht in het announce kanaal
        const tc = getTrainingConfig(guildId);
        if (tc.announceChannel) {
          const announceCh = interaction.guild.channels.cache.get(tc.announceChannel);
          if (announceCh) {
            const defaultMsg = (tc.announceMessage || '🎉 Congratulations <@{user}>! You have been promoted to **{role}**!')
              .replace(/{user}/g, targetMember.user.id)
              .replace(/{role}/g, result.newRole.name)
              .replace(/{promotedBy}/g, userDisplay(interaction.user))
              .replace(/{server}/g, interaction.guild.name);
            const announceEmbed = new EmbedBuilder()
              .setTitle('⬆️ Promotion!')
              .setColor(0x57F287)
              .setDescription(embedSafe.desc(defaultMsg))
              .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }))
              .addFields(
                { name: '👤 User', value: `${userDisplay(targetMember.user)}`, inline: true },
                { name: '🎭 New Rank', value: result.newRole.name, inline: true },
                { name: '📝 Reason', value: embedSafe.fieldVal(promoteReason), inline: false },
                { name: '👮 By', value: userDisplay(interaction.user), inline: true },
              )
              .setTimestamp();
            await announceCh.send({ content: `<@${targetMember.user.id}>`, embeds: [announceEmbed] }).catch(() => {});
          }
        } else {
          await interaction.channel.send({ content: `<@${targetMember.user.id}>`, embeds: [new EmbedBuilder().setTitle('⬆️ Promotion!').setColor(0x57F287).setDescription(`Congratulations <@${targetMember.user.id}>! You have been promoted to **${result.newRole.name}**!`).setTimestamp()] }).catch(() => {});
        }

        return interaction.editReply({ content: `✅ **${userDisplay(targetMember.user)}** promoted to **${result.newRole.name}** via Chain of Command${skipTo ? ' (SHR override)' : ''}.` });
      }

      if (cmd === 'demote') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const targetMember = interaction.options.getMember('user');
        const role = interaction.options.getRole('role');
        const demoteReason = interaction.options.getString('reason') ?? 'No reason provided';
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await targetMember.roles.remove(role, demoteReason);
        } catch (e) {
          return interaction.editReply({ content: `❌ Could not remove role: ${e.message}` });
        }
        const tc = getTrainingConfig(guildId);
        if (tc.announceChannel) {
          const announceCh = interaction.guild.channels.cache.get(tc.announceChannel);
          if (announceCh) {
            const announceEmbed = new EmbedBuilder()
              .setTitle('⬇️ Demotion')
              .setColor(0xED4245)
              .setDescription(`**${userDisplay(targetMember.user)}** has been demoted from **${role.name}**.`)
              .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }))
              .addFields(
                { name: '👤 User', value: `${userDisplay(targetMember.user)}`, inline: true },
                { name: '🎭 Role Removed', value: role.name, inline: true },
                { name: '📝 Reason', value: demoteReason, inline: false },
                { name: '👮 By', value: userDisplay(interaction.user), inline: true },
              )
              .setTimestamp();
            await announceCh.send({ content: `<@${targetMember.user.id}>`, embeds: [announceEmbed] }).catch(() => {});
          }
        } else {
          await interaction.channel.send({ content: `<@${targetMember.user.id}>`, embeds: [new EmbedBuilder().setTitle('⬇️ Demotion').setColor(0xED4245).setDescription(`<@${targetMember.user.id}> has been demoted from **${role.name}**.`).setTimestamp()] }).catch(() => {});
        }
        return interaction.editReply({ content: `✅ **${userDisplay(targetMember.user)}** demoted from **${role.name}**.` });
      }

      if (cmd === 'clearwarnings') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await clearWarnings(guildId, user.id); return interaction.reply({ content: `✅ Cleared warnings for **${userDisplay(user)}**.`, flags: MessageFlags.Ephemeral }); }
      if (cmd === 'note')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await addNote(guildId, user.id, { text: interaction.options.getString('text'), moderator: userDisplay(interaction.user), date: new Date().toUTCString() }); return interaction.reply({ content: `✅ Note added.`, flags: MessageFlags.Ephemeral }); }
      if (cmd === 'notes') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); const notes = getNotes(guildId, user.id); if (!notes.length) return interaction.reply({ content: `📝 No notes.`, flags: MessageFlags.Ephemeral }); return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setTitle(`📝 Notes — ${userDisplay(user)}`).setColor(0x5865F2).setDescription(notes.map((n, i) => `**${i + 1}.** ${n.text} — *${n.moderator}*`).join('\n'))] }); }

      if (cmd === 'announce') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
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
        await ch.send({ embeds: [embed] }); return interaction.reply({ content: `✅ Sent to <#${ch.id}>!`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'giveaway') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ch = interaction.options.getChannel('channel'); const prize = interaction.options.getString('prize');
        const minutes = interaction.options.getInteger('minutes'); const winners = interaction.options.getInteger('winners');
        const endsAt = new Date(Date.now() + minutes * 60000);
        const embed = new EmbedBuilder().setTitle('🎉 GIVEAWAY 🎉').setColor(0xEB459E).setDescription(`**Prize:** ${prize}\n\nReact with 🎉 to enter!\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>`).setFooter({ text: `By ${userDisplay(interaction.user)}` }).setTimestamp(endsAt);
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
        return interaction.reply({ content: `✅ Giveaway started in <#${ch.id}>!`, flags: MessageFlags.Ephemeral });
      }
      if (cmd === 'punish') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const t = interaction.options.getString('type');
        if (t === 'warn') { await addWarning(guildId, user.id, { reason, moderator: userDisplay(interaction.user), date: new Date().toUTCString() }); return interaction.reply({ content: `⚠️ **${userDisplay(user)}** warned.`, flags: MessageFlags.Ephemeral }); }
        if (t === 'mute') { await member.timeout(600000, reason); return interaction.reply({ content: `🔇 **${userDisplay(user)}** muted 10min.`, flags: MessageFlags.Ephemeral }); }
        if (t === 'kick') { await member.kick(reason); return interaction.reply({ content: `👢 **${userDisplay(user)}** kicked.`, flags: MessageFlags.Ephemeral }); }
        if (t === 'ban')  { await interaction.guild.members.ban(user, { reason }); return interaction.reply({ content: `🔨 **${userDisplay(user)}** banned.`, flags: MessageFlags.Ephemeral }); }
      }
      if (cmd === 'players') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); try { const data = await erlcRequest('/server/players'); const list = Object.values(data); if (!list.length) return interaction.editReply('No players.'); return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`👥 Players (${list.length})`).setDescription(list.map((p, i) => `${i + 1}. **${p.Player}** — ${p.Team || 'None'}`).join('\n').slice(0, 4000)).setColor(0x5865F2)] }); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'serverstatus') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); try { const d = await erlcRequest('/server'); return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🖥️ ERLC Status').setColor(0x57F287).addFields({ name: 'Name', value: d.Name || 'Unknown', inline: true }, { name: 'Players', value: `${d.CurrentPlayers ?? 0}/${d.MaxPlayers ?? 0}`, inline: true }, { name: 'Key', value: d.JoinKey || 'N/A', inline: true }).setTimestamp()] }); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'erlckick') { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const u = interaction.options.getString('username'); try { await erlcRequest('/server/command', 'POST', { command: `:kick ${u}` }); return interaction.editReply(`✅ **${u}** kicked from ERLC.`); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'erlcban')  { if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral }); await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const u = interaction.options.getString('username'); try { await erlcRequest('/server/command', 'POST', { command: `:ban ${u}` }); return interaction.editReply(`✅ **${u}** banned from ERLC.`); } catch (e) { return interaction.editReply(`❌ ${e.message}`); } }
      if (cmd === 'session') {
        if (!isMainServer(guildId)) return interaction.reply({ content: '❌ Sessions can only be started from the main server.', flags: MessageFlags.Ephemeral });
        if (!canRunSession(interaction.member, guildId)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        const sc = getSessionConfig(guildId);
        if (!sc.channel) return interaction.reply({ content: '❌ Session channel not set.', flags: MessageFlags.Ephemeral });
        const sCh = interaction.guild.channels.cache.get(sc.channel);
        if (!sCh) return interaction.reply({ content: '❌ Session channel not found.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const vars = { userMention: `<@${interaction.user.id}>`, username: interaction.user.username, userTag: userDisplay(interaction.user), memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
        if (sub === 'start') { const rawLink = interaction.options.getString('link') ?? sc.joinLink ?? null; try { await postSessionStart(interaction.guild, sc, interaction.user, rawLink, vars); return interaction.editReply({ content: `✅ Session started!` }); } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); } }
        if (sub === 'vote') {
          const threshold = interaction.options.getInteger('votes') ?? sc.voteThreshold ?? 5;
          const ping = sc.pingRoles?.length ? sc.pingRoles.map(id => `<@&${id}>`).join(' ') : null;
          const embed = new EmbedBuilder().setTitle('🗳️ Session Vote!').setColor(0xFEE75C).setDescription(`${replaceVars(sc.voteDescription ?? '**{host}** wants to host a session!\n\nClick the button below to vote!', vars)}\n\n**Votes: 0/${threshold}**`).setTimestamp().setFooter({ text: `By ${userDisplay(interaction.user)}` });
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
          const embed = new EmbedBuilder().setTitle('🔴 Session Ended!').setColor(0xED4245).setDescription(replaceVars(sc.shutdownDescription ?? 'The session has ended!', vars)).setTimestamp().setFooter({ text: `By ${userDisplay(interaction.user)}` });
          if (sc.shutdownImage) embed.setImage(sc.shutdownImage);
          await sCh.send({ embeds: [embed] }); // Geen ping bij shutdown
          return interaction.editReply({ content: '✅ Shutdown posted!' });
        }
      }
      if (cmd === 'startvote') {
        const vc = getVoteConfig(guildId);
        if (!vc.mainServer) return interaction.reply({ content: '❌ This server is not configured as a Main Server. Enable it via `/setup votesystem`.', flags: MessageFlags.Ephemeral });
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to start a vote.', flags: MessageFlags.Ephemeral });
        const question = interaction.options.getString('question');
        const duration = interaction.options.getInteger('duration') ?? 5;
        const endsAt = Date.now() + duration * 60000;
        const voteId = genId();
        const embed = new EmbedBuilder()
          .setTitle('🗳️ Vote Started!')
          .setColor(0x5865F2)
          .setDescription(`**${question}**`)
          .addFields(
            { name: '✅ Yes', value: '0 votes', inline: true },
            { name: '❌ No',  value: '0 votes', inline: true },
            { name: '⏱️ Ends', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
          )
          .setFooter({ text: `Vote ID: ${voteId} • Started by ${userDisplay(interaction.user)}` })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`vote__yes__${voteId}`).setLabel('✅ Yes').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`vote__no__${voteId}`).setLabel('❌ No').setStyle(ButtonStyle.Danger),
        );
        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        // Store active vote state
        activeGeneralVotes.set(voteId, { messageId: msg.id, channelId: interaction.channel.id, question, yes: [], no: [], endsAt, guildId });
        // Auto-close after duration
        setTimeout(async () => {
          const voteData = activeGeneralVotes.get(voteId);
          if (!voteData) return;
          activeGeneralVotes.delete(voteId);
          const yesCount = voteData.yes.length;
          const noCount  = voteData.no.length;
          const total    = yesCount + noCount;
          const success  = yesCount > noCount;
          const resultEmbed = new EmbedBuilder()
            .setTitle(`🗳️ Vote Ended — ${success ? '✅ Passed' : '❌ Failed'}`)
            .setColor(success ? 0x57F287 : 0xED4245)
            .setDescription(`**${question}**`)
            .addFields(
              { name: '✅ Yes', value: `${yesCount} vote${yesCount !== 1 ? 's' : ''}`, inline: true },
              { name: '❌ No',  value: `${noCount} vote${noCount !== 1 ? 's' : ''}`,  inline: true },
              { name: '📊 Total', value: `${total}`, inline: true },
              { name: '📋 Result', value: success ? '✅ **Passed**' : '❌ **Failed**', inline: false },
            )
            .setFooter({ text: `Vote ID: ${voteId}` })
            .setTimestamp();
          const resolvedGuild = client.guilds.cache.get(voteData.guildId);
          if (resolvedGuild) {
            const ch = resolvedGuild.channels.cache.get(voteData.channelId);
            if (ch) {
              const origMsg = await ch.messages.fetch(voteData.messageId).catch(() => null);
              if (origMsg) await origMsg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
            }
            const vc2 = getVoteConfig(voteData.guildId);
            if (vc2.logChannel) {
              const logCh = resolvedGuild.channels.cache.get(vc2.logChannel);
              if (logCh) await logCh.send({ embeds: [resultEmbed] }).catch(() => {});
            }
          }
          if (success) {
            await broadcastVoteSuccess(question, voteId).catch(console.error);
          }
        }, duration * 60000);
        return;
      }

      if (cmd === 'infract') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ic = getInfractionConfig(guildId);

        const targetMember = interaction.options.getMember('user');
        const targetUser   = interaction.options.getUser('user');
        const infrType     = interaction.options.getString('type'); // 'warning' | 'strike'
        const infrReason   = interaction.options.getString('reason');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Progress one level (max 7 = Termination), regardless of warning/strike choice
        if (!ic.userStrikes) ic.userStrikes = {};
        if (!ic.userHistory) ic.userHistory = {};
        const maxLevel    = INFRACTION_PROGRESSION.length; // 7
        const currentLevel = ic.userStrikes[targetUser.id] ?? 0;
        const newLevel    = Math.min(currentLevel + 1, maxLevel);
        ic.userStrikes[targetUser.id] = newLevel;

        const progEntry  = getProgressionEntry(newLevel);
        const levelLabel = progEntry.label;
        const typeLabel  = infrType === 'strike' ? 'Strike' : 'Warning';

        // Update history
        if (!ic.userHistory[targetUser.id]) ic.userHistory[targetUser.id] = [];
        ic.userHistory[targetUser.id].push({
          type: typeLabel, reason: infrReason, moderator: userDisplay(interaction.user),
          date: new Date().toUTCString(), level: newLevel,
        });

        // Rol toewijzen volgens progressie level
        await applyInfractionLevelRole(targetMember, ic, newLevel);

        await saveGuildConfig(guildId);

        // Variabelen
        const replaceVarsInfr = (text) => {
          if (!text) return text;
          return text
            .replace(/{user}/g,             targetUser.id)
            .replace(/{userMention}/g,      `<@${targetUser.id}>`)
            .replace(/{username}/g,         targetUser.username)
            .replace(/{reason}/g,           infrReason)
            .replace(/{moderator}/g,        userDisplay(interaction.user))
            .replace(/{type}/g,             typeLabel)
            .replace(/{levelLabel}/g,       levelLabel)
            .replace(/{progressionLevel}/g, `${newLevel}`)
            .replace(/{maxLevel}/g,         `${maxLevel}`)
            .replace(/{server}/g,           interaction.guild.name);
        };

        const isTermination = newLevel >= maxLevel;
        const levelRoleId   = ic.hierarchy[newLevel - 1]?.roleId;

        // Embed in channel
        const infrEmbed = new EmbedBuilder()
          .setTitle(replaceVarsInfr(ic.embedTitle))
          .setDescription(replaceVarsInfr(ic.embedDescription))
          .setColor(hexToInt(ic.embedColor))
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `${levelLabel} (${newLevel}/${maxLevel})${isTermination ? ' — TERMINATION' : ''} • By ${userDisplay(interaction.user)}` })
          .setTimestamp();

        // Ping de gebruiker in het kanaal
        await interaction.channel.send({ content: `<@${targetUser.id}>`, embeds: [infrEmbed] }).catch(() => {});
        await interaction.editReply({ content: `✅ ${typeLabel} issued — user is now at **${levelLabel}** (${newLevel}/${maxLevel}).` });

        // DM naar gebruiker
        await targetUser.send({ embeds: [new EmbedBuilder()
          .setTitle(replaceVarsInfr(ic.embedTitle))
          .setDescription(replaceVarsInfr(ic.dmMessage))
          .setColor(hexToInt(ic.embedColor))
          .setFooter({ text: `${levelLabel} (${newLevel}/${maxLevel})` })
          .setTimestamp()
        ]}).catch(() => {});

        // Log channel
        if (ic.logChannel) {
          const logCh = interaction.guild.channels.cache.get(ic.logChannel);
          if (logCh) {
            await logCh.send({ embeds: [new EmbedBuilder()
              .setTitle(`⚠️ Infraction Logged — ${levelLabel}`)
              .setColor(hexToInt(ic.embedColor))
              .addFields(
                { name: '👤 User',       value: `${userDisplay(targetUser)} (<@${targetUser.id}>)`, inline: true  },
                { name: '📋 Type',       value: typeLabel,           inline: true  },
                { name: '📊 Progression', value: `${levelLabel} (${newLevel}/${maxLevel})`, inline: true  },
                { name: '🎭 Role Given', value: levelRoleId ? `<@&${levelRoleId}>` : '*None*', inline: true },
                { name: '📝 Reason',     value: infrReason,           inline: false },
                { name: '👮 Moderator',  value: userDisplay(interaction.user),  inline: true  },
              )
              .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
              .setTimestamp()
            ]}).catch(() => {});

            // Extra termination warning
            if (isTermination) {
              await logCh.send({ embeds: [new EmbedBuilder()
                .setTitle('🚨 Termination Reached')
                .setColor(0x992D22)
                .setDescription(replaceVarsInfr(ic.terminationMessage))
                .setTimestamp()
              ]}).catch(() => {});
            }
          }
        }
        return;
      }

      if (cmd === 'infractions') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ic = getInfractionConfig(guildId);
        const targetUser  = interaction.options.getUser('user');
        const maxLevel    = INFRACTION_PROGRESSION.length;
        const level       = ic.userStrikes?.[targetUser.id] ?? 0;
        const history     = ic.userHistory?.[targetUser.id] ?? [];

        const progressionDisplay = INFRACTION_PROGRESSION.map((p, i) => {
          const num = i + 1;
          const isCurrent = num === level;
          const icon = p.category === 'Termination' ? '🚨' : p.category === 'Strike' ? '🔴' : '🟡';
          return `${isCurrent ? '▶️' : icon} **${num}.** \`${p.label}\`${isCurrent ? ' ← current' : ''}`;
        }).join('\n');

        const historyDisplay = history.length
          ? history.slice(-10).reverse().map((h, i) =>
              `**${getProgressionEntry(h.level).label}** (${h.type}) — ${h.reason}\n　*by ${h.moderator} on ${h.date}*`
            ).join('\n\n')
          : '*No infractions recorded*';

        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle(`⚠️ Infractions — ${userDisplay(targetUser)}`)
          .setColor(level >= maxLevel ? 0x992D22 : 0xED4245)
          .addFields(
            { name: '📊 Current Level', value: level > 0 ? `${getProgressionEntry(level).label} (${level}/${maxLevel})` : `Clean (0/${maxLevel})`, inline: true },
            { name: '📈 Progression',   value: progressionDisplay, inline: false },
            { name: '📜 Recent History (last 10)', value: historyDisplay, inline: false },
          )
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setTimestamp()
        ], flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'foundership') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ Admin only.', flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        const fc = getFoundershipConfig(guildId);
        if (sub === 'add') {
          const role = interaction.options.getRole('role');
          if (!fc.roles.includes(role.id)) fc.roles.push(role.id);
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ <@&${role.id}> added as Foundership role.`, flags: MessageFlags.Ephemeral });
        }
        if (sub === 'remove') {
          const role = interaction.options.getRole('role');
          fc.roles = fc.roles.filter(r => r !== role.id);
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ <@&${role.id}> removed from Foundership.`, flags: MessageFlags.Ephemeral });
        }
        if (sub === 'list') {
          return interaction.reply({ content: fc.roles.length ? `**Foundership Roles:** ${fc.roles.map(r => `<@&${r}>`).join(', ')}` : '*No foundership roles set.*', flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'ticket-addstaff') {
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const record = await getTicketRecord(interaction.channel.id);
        const canManage = hasSetup(interaction.member) || isFoundership(interaction.member) || record?.creatorId === interaction.user.id;
        if (!canManage) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        try {
          await interaction.channel.permissionOverwrites.edit(targetMember, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
          });
          if (record) await updateTicketRecord(interaction.channel.id, { $addToSet: { staffMembers: targetUser.id } });
          await logTicketAction(interaction.guild, guildId, 'staff_added', {
            channel: `<#${interaction.channel.id}>`,
            user: `<@${targetUser.id}>`,
            staff: userDisplay(interaction.user),
          });
          return interaction.reply({ content: `✅ <@${targetUser.id}> added to this ticket.` });
        } catch (e) {
          return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'ticket-removestaff') {
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        if (isFoundership(targetMember)) return interaction.reply({ content: '❌ Cannot remove Foundership access.', flags: MessageFlags.Ephemeral });
        const record = await getTicketRecord(interaction.channel.id);
        const canManage = hasSetup(interaction.member) || isFoundership(interaction.member) || record?.creatorId === interaction.user.id;
        if (!canManage) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        try {
          await interaction.channel.permissionOverwrites.delete(targetMember);
          if (record) await updateTicketRecord(interaction.channel.id, { $pull: { staffMembers: targetUser.id } });
          await logTicketAction(interaction.guild, guildId, 'staff_removed', {
            channel: `<#${interaction.channel.id}>`,
            user: `<@${targetUser.id}>`,
            staff: userDisplay(interaction.user),
          });
          return interaction.reply({ content: `✅ <@${targetUser.id}> removed from this ticket.` });
        } catch (e) {
          return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'ticket-rename') {
        const record = await getTicketRecord(interaction.channel.id);
        const canManage = hasSetup(interaction.member) || isFoundership(interaction.member) || record?.creatorId === interaction.user.id;
        if (!canManage) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const newName = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
        try {
          await interaction.channel.setName(newName);
          await logTicketAction(interaction.guild, guildId, 'renamed', { channel: newName, staff: userDisplay(interaction.user) });
          return interaction.reply({ content: `✅ Channel renamed to \`${newName}\`.` });
        } catch (e) {
          return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'ticket-priority') {
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const level = interaction.options.getString('level');
        const colorMap = { low: '🟢', normal: '🔵', high: '🟡', urgent: '🔴' };
        await updateTicketRecord(interaction.channel.id, { priority: level });
        await logTicketAction(interaction.guild, guildId, 'priority', { channel: `<#${interaction.channel.id}>`, extra: `Set to **${colorMap[level]} ${level}** by ${userDisplay(interaction.user)}` });
        return interaction.reply({ content: `${colorMap[level]} Priority set to **${level}**.` });
      }

      if (cmd === 'ticket-note') {
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const text = interaction.options.getString('text');
        await updateTicketRecord(interaction.channel.id, { $push: { notes: { authorId: interaction.user.id, text, createdAt: new Date() } } });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📝 Note Added').setColor(0x5865F2).setDescription(text).setFooter({ text: `By ${userDisplay(interaction.user)}` }).setTimestamp()], flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'ticket-reopen') {
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const record2 = await getTicketRecord(interaction.channel.id);
        if (!record2) return interaction.reply({ content: '❌ Not a tracked ticket.', flags: MessageFlags.Ephemeral });
        if (record2.status === 'open') return interaction.reply({ content: '❌ Ticket is already open.', flags: MessageFlags.Ephemeral });
        await updateTicketRecord(interaction.channel.id, { status: 'open', closedAt: null });
        await interaction.channel.permissionOverwrites.edit(record2.creatorId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        await logTicketAction(interaction.guild, guildId, 'reopened', { channel: `<#${interaction.channel.id}>`, staff: userDisplay(interaction.user) });
        return interaction.reply({ content: '🔓 Ticket reopened.' });
      }

      if (cmd === 'ticket-archive') {
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        const record2 = await getTicketRecord(interaction.channel.id);
        if (!record2) return interaction.reply({ content: '❌ Not a tracked ticket.', flags: MessageFlags.Ephemeral });
        await updateTicketRecord(interaction.channel.id, { status: 'archived', archivedAt: new Date() });
        await interaction.channel.permissionOverwrites.edit(record2.creatorId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => {});
        await interaction.channel.setName(`archived-${interaction.channel.name}`.slice(0, 100)).catch(() => {});
        await logTicketAction(interaction.guild, guildId, 'archived', { channel: `<#${interaction.channel.id}>`, staff: userDisplay(interaction.user) });
        return interaction.reply({ content: '📦 Ticket archived. The channel is now read-only for the ticket owner.' });
      }

      if (cmd === 'ticket-delete') {
        if (!hasSetup(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Admin or Foundership only.', flags: MessageFlags.Ephemeral });
        const record2 = await getTicketRecord(interaction.channel.id).catch(() => null);
        await logTicketAction(interaction.guild, guildId, 'deleted', { channel: interaction.channel.name, staff: userDisplay(interaction.user) }).catch(() => {});
        if (record2) await updateTicketRecord(interaction.channel.id, { status: 'closed', closedAt: new Date() }).catch(() => {});
        for (const [uid, cid] of openTickets.entries()) { if (cid === interaction.channel.id) { openTickets.delete(uid); break; } }
        await interaction.reply({ content: '🗑️ Deleting ticket in 3 seconds...' });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
        return;
      }

      if (cmd === 'ticket-info') {
        const record2 = await getTicketRecord(interaction.channel.id);
        if (!record2) return interaction.reply({ content: '❌ Not a tracked ticket.', flags: MessageFlags.Ephemeral });
        const priorityEmoji = { low: '🟢', normal: '🔵', high: '🟠', urgent: '🔴' };
        const embed = new EmbedBuilder()
          .setTitle('🎫 Ticket Info')
          .setColor(0x5865F2)
          .addFields(
            { name: '👤 Opened by',   value: `<@${record2.creatorId}>`,                                                              inline: true },
            { name: '🎫 Type',        value: record2.typeLabel || 'Unknown',                                                          inline: true },
            { name: '📊 Status',      value: record2.status,                                                                          inline: true },
            { name: '🔴 Priority',    value: `${priorityEmoji[record2.priority] || '🔵'} ${record2.priority}`,                       inline: true },
            { name: '🙋 Claimed by',  value: record2.claimedBy ? `<@${record2.claimedBy}>` : '*Unclaimed*',                          inline: true },
            { name: '📅 Opened',      value: new Date(record2.createdAt).toUTCString(),                                               inline: false },
            { name: '👥 Staff',       value: record2.staffMembers?.length ? record2.staffMembers.map(s => `<@${s}>`).join(', ') : '*None*', inline: false },
            { name: '📝 Notes',       value: record2.notes?.length ? record2.notes.map(n => `**<@${n.authorId}>:** ${n.text}`).join('\n').slice(0, 1024) : '*None*', inline: false },
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'ticket-kick') {
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        const record = await getTicketRecord(interaction.channel.id);
        const canManage = hasSetup(interaction.member) || isFoundership(interaction.member) || hasAnyStaff(interaction.member);
        if (!canManage) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        if (!targetMember) return interaction.reply({ content: '❌ Member niet gevonden.', flags: MessageFlags.Ephemeral });
        if (record?.creatorId === targetUser.id) return interaction.reply({ content: '❌ Je kunt de ticket eigenaar niet verwijderen.', flags: MessageFlags.Ephemeral });
        if (isFoundership(targetMember)) return interaction.reply({ content: '❌ Je kunt een Foundership lid niet verwijderen.', flags: MessageFlags.Ephemeral });
        try {
          await interaction.channel.permissionOverwrites.delete(targetMember);
          await interaction.reply({ content: `✅ <@${targetUser.id}> is uit het ticket verwijderd.` });
          await logTicketAction(interaction.guild, interaction.guildId, 'staff_removed', {
            channel: `<#${interaction.channel.id}>`,
            user: `<@${targetUser.id}>`,
            staff: userDisplay(interaction.user),
          });
        } catch (e) {
          return interaction.reply({ content: `❌ Mislukt: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (cmd === 'ticket-transfer') {
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        const record = await getTicketRecord(interaction.channel.id);
        const canManage = hasSetup(interaction.member) || isFoundership(interaction.member) || record?.creatorId === interaction.user.id;
        if (!canManage) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        try {
          if (targetMember) {
            await interaction.channel.permissionOverwrites.edit(targetMember, {
              ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
            });
          }
          await updateTicketRecord(interaction.channel.id, { creatorId: targetUser.id });
          await logTicketAction(interaction.guild, guildId, 'transferred', {
            channel: `<#${interaction.channel.id}>`,
            user: `<@${targetUser.id}>`,
            staff: userDisplay(interaction.user),
          });
          return interaction.reply({ content: `✅ Ticket transferred to <@${targetUser.id}>.` });
        } catch (e) {
          return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'clearinfractions') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ic = getInfractionConfig(guildId);
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        if (!ic.userStrikes) ic.userStrikes = {};
        ic.userStrikes[targetUser.id] = 0;
        if (!ic.userHistory) ic.userHistory = {};
        ic.userHistory[targetUser.id] = [];
        // Verwijder alle progressie-rollen
        if (targetMember) await applyInfractionLevelRole(targetMember, ic, 0);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Infractions cleared for **${userDisplay(targetUser)}**.`, flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'setinfractions') {
        if (!hasSHR(interaction.member)) return interaction.reply({ content: '❌ SHR only.', flags: MessageFlags.Ephemeral });
        const ic = getInfractionConfig(guildId);
        const targetUser   = interaction.options.getUser('user');
        const targetMember = interaction.options.getMember('user');
        const newLevel     = interaction.options.getInteger('level');
        const maxLevel     = INFRACTION_PROGRESSION.length;
        if (newLevel < 0 || newLevel > maxLevel) return interaction.reply({ content: `❌ Level must be between 0 and ${maxLevel}.`, flags: MessageFlags.Ephemeral });

        if (!ic.userStrikes) ic.userStrikes = {};
        const oldLevel = ic.userStrikes[targetUser.id] ?? 0;
        ic.userStrikes[targetUser.id] = newLevel;

        if (!ic.userHistory) ic.userHistory = {};
        if (!ic.userHistory[targetUser.id]) ic.userHistory[targetUser.id] = [];
        ic.userHistory[targetUser.id].push({
          type: 'Override', reason: `Level manually set by ${userDisplay(interaction.user)} (${oldLevel} → ${newLevel})`,
          moderator: userDisplay(interaction.user), date: new Date().toUTCString(), level: newLevel,
        });

        if (targetMember) await applyInfractionLevelRole(targetMember, ic, newLevel);
        await saveGuildConfig(guildId);

        const levelLabel = newLevel > 0 ? getProgressionEntry(newLevel).label : 'Clean';
        return interaction.reply({ content: `✅ **${userDisplay(targetUser)}** infraction level overridden to **${levelLabel}** (${newLevel}/${maxLevel}).`, flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'loa') {
        const sub = interaction.options.getSubcommand();
        const lc = getLOAConfig(guildId);

        if (sub === 'request') {
          const modal = new ModalBuilder().setCustomId('modal_loa_request').setTitle('Leave of Absence Request');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('loa_reason').setLabel('Reason for LOA').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('loa_days').setLabel('How many days? (1-60)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
          );
          return interaction.showModal(modal);
        }

        
          if (sub === 'list') {
          const active = Object.entries(lc.active).filter(([uid]) => !uid.startsWith('pending_'));
          if (!active.length) return interaction.reply({ content: '📋 No active LOAs.', flags: MessageFlags.Ephemeral });
          const embed = new EmbedBuilder().setTitle('🏖️ Active LOAs').setColor(0x5865F2)
            .setDescription(active.map(([uid, l]) => `<@${uid}> — **${l.reason.slice(0,60)}**\nEnds: <t:${Math.floor(l.endsAt/1000)}:R>`).join('\n\n'))
            .setTimestamp();
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (sub === 'end') {
          if (!hasAnyStaff(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
          const target = interaction.options.getUser('user');
          const loaData = lc.active[target.id];
          if (!loaData) return interaction.reply({ content: `❌ **${userDisplay(target)}** has no active LOA.`, flags: MessageFlags.Ephemeral });
          const targetMember = interaction.options.getMember('user');
          if (targetMember) {
            if (lc.loaRole) await targetMember.roles.remove(lc.loaRole).catch(() => {});
            await targetMember.setNickname(loaData.originalNickname ?? null).catch(() => {});
          }
          delete lc.active[target.id];
          await saveGuildConfig(guildId);
          if (lc.logChannel) {
            const ch = interaction.guild.channels.cache.get(lc.logChannel);
            if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle('🛑 LOA Ended Early').setColor(0xED4245)
              .addFields({ name: '👤 User', value: `<@${target.id}>`, inline: true }, { name: '👮 Ended By', value: userDisplay(interaction.user), inline: true })
              .setTimestamp()] }).catch(() => {});
          }
          await target.send({ embeds: [new EmbedBuilder().setTitle('🛑 LOA Ended Early').setColor(0xED4245).setDescription(`Your LOA in **${interaction.guild.name}** was ended early by **${userDisplay(interaction.user)}**.`).setTimestamp()] }).catch(() => {});
          return interaction.reply({ content: `✅ LOA for **${userDisplay(target)}** ended.`, flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'setup') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        // Department servers get a limited setup menu; main server and unconfigured servers get the full menu
        // Department servers krijgen nu ook het volledige setup menu
        {
          const embed = new EmbedBuilder()
            .setTitle('⚙️ Setup Menu')
            .setColor(0x5865F2)
            .setDescription('Select a category to configure:')
            .addFields(
              { name: '🎫 Moderation', value: '`tickets` `automod` `verification`', inline: true },
            );
          const select = new StringSelectMenuBuilder()
            .setCustomId('setup_menu')
            .setPlaceholder('Select a category to configure...')
            .addOptions(
              { label: 'Tickets', value: 'tickets', emoji: '🎫' },
              { label: 'Sessions', value: 'sessions', emoji: '🎮' },
              { label: 'Staff Review', value: 'staffreview', emoji: '⭐' },
              { label: 'Self Roles', value: 'selfroles', emoji: '🎭' },
              { label: 'Announcements', value: 'announcements', emoji: '📣' },
              { label: 'Welcomer', value: 'welcomer', emoji: '👋' },
              { label: 'Autorole', value: 'autorole', emoji: '🎭' },
              { label: 'Verification', value: 'verification', emoji: '✅' },
              { label: 'Applications', value: 'applications', emoji: '📋' },
              { label: 'Automod', value: 'automod', emoji: '🛡️' },
              { label: 'Counters', value: 'counters', emoji: '📊' },
              { label: 'Training', value: 'training', emoji: '🎓' },
              { label: 'ERLC Logs', value: 'erlclogs', emoji: '📡' },
              { label: 'Role Perms', value: 'roleperms', emoji: '🔐' },
              { label: 'Permissions', value: 'permissions', emoji: '👑' },
              { label: 'Departments', value: 'departments', emoji: '🏢' },
              { label: 'Handbooks', value: 'handbooks', emoji: '📚' },
              { label: 'Saved Msgs', value: 'savedmessages', emoji: '💾' },
              { label: 'Cmd List', value: 'commandlist', emoji: '📜' },
              { label: 'Vote System', value: 'votesystem', emoji: '🗳️' },
              { label: 'Exec Request', value: 'execrequest', emoji: '📋' },
              { label: 'Bot Config', value: 'botconfig', emoji: '🤖' },
              { label: 'Founder Req', value: 'founderrequest', emoji: '📋' },
              { label: 'Infractions', value: 'infractions', emoji: '⚠️' },
              { label: 'LOA', value: 'loa', emoji: '🏖️' },
              { label: 'Chain of Command', value: 'chainofcommand', emoji: '⛓️' },
            );
          const row = new ActionRowBuilder().addComponents(select);
          return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
        }
      }

      if (cmd === 'dept-setup') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const deptPayload = buildDepartmentSetupPayload(guildId, interaction.guild);
        return interaction.reply({ ...deptPayload, flags: MessageFlags.Ephemeral });
      }
    } // end isChatInputCommand

    // ══ BUTTONS ══
    if (interaction.isButton()) {
      // ════ LOA SETUP BUTTONS ════
      if (interaction.customId.startsWith('loa__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = interaction.customId.replace('loa__', '');
        const lc = getLOAConfig(guildId);

        if (action === 'set_role') return interaction.reply({ content: '### 🎭 Select LOA role', components: [roleDropdown('load_role', 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
        if (action === 'set_approval_roles') return interaction.reply({ content: '### 🔑 Select approval roles', components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('load_approval_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'set_log') return interaction.reply({ content: '### 📋 Select log channel', components: [channelDropdown('load_log_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'set_approvals') {
          const modal = new ModalBuilder().setCustomId('modal_loa_approvals').setTitle('Required Approvals');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('loa_approvals_count').setLabel('How many approvals required?').setStyle(TextInputStyle.Short).setValue(`${lc.requiredApprovals ?? 1}`).setRequired(true).setMaxLength(2)));
          return interaction.showModal(modal);
        }
        if (action === 'set_prefix') {
          const modal = new ModalBuilder().setCustomId('modal_loa_prefix').setTitle('LOA Nickname Prefix');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('loa_prefix_val').setLabel('Prefix (e.g. [LOA])').setStyle(TextInputStyle.Short).setValue(lc.prefix ?? '[LOA]').setRequired(true).setMaxLength(20)));
          return interaction.showModal(modal);
        }
      }

      // ════ LOA APPROVE / DENY ════
      if (interaction.customId.startsWith('loa_approve__') || interaction.customId.startsWith('loa_deny__')) {
        const parts = interaction.customId.split('__');
        const action = parts[0] === 'loa_approve' ? 'approve' : 'deny';
        const targetId = parts[1];
        const lc = getLOAConfig(guildId);
        const canVote = lc.approvalRoles?.length
          ? lc.approvalRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member)
          : hasSetup(interaction.member);
        if (!canVote) return interaction.reply({ content: '❌ You do not have permission to approve or deny LOA requests.', flags: MessageFlags.Ephemeral });

        const embed = interaction.message.embeds[0];
        const statusField = embed?.fields?.find(f => f.name === '📊 Status');
        if (statusField?.value !== '⏳ Pending') return interaction.reply({ content: '❌ Already decided.', flags: MessageFlags.Ephemeral });

        const required = lc.requiredApprovals ?? 1;
        const approvalsField = embed.fields.find(f => f.name?.startsWith('✅ Approvals'));
        const currentApprovals = approvalsField?.value === '*None yet*' ? [] : (approvalsField?.value?.split('\n') ?? []);
        if (currentApprovals.some(v => v.includes(interaction.user.id)) && action === 'approve') return interaction.reply({ content: '❌ Already voted.', flags: MessageFlags.Ephemeral });

        if (action === 'approve') currentApprovals.push(`${userDisplay(interaction.user)} (<@${interaction.user.id}>)`);
        const approved = currentApprovals.length >= required;
        const newStatus = approved ? '✅ Approved' : action === 'deny' ? '❌ Denied' : '⏳ Pending';
        const newColor = approved ? 0x57F287 : action === 'deny' ? 0xED4245 : 0x5865F2;

        const updatedEmbed = EmbedBuilder.from(embed)
          .setColor(newColor)
          .spliceFields(embed.fields.findIndex(f => f.name?.startsWith('✅ Approvals')), 1, { name: `✅ Approvals (${currentApprovals.length}/${required})`, value: currentApprovals.join('\n') || '*None yet*', inline: false })
          .spliceFields(embed.fields.findIndex(f => f.name === '📊 Status'), 1, { name: '📊 Status', value: newStatus, inline: false });

        const disabled = approved || action === 'deny';
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`loa_approve__${targetId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
          new ButtonBuilder().setCustomId(`loa_deny__${targetId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
        );
        await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

        if (approved) {
          const loaPending = lc.active[`pending_${targetId}`];
          if (loaPending) {
            delete lc.active[`pending_${targetId}`];
            lc.active[targetId] = loaPending;
            await saveGuildConfig(guildId);
            const member = await interaction.guild.members.fetch(targetId).catch(() => null);
            if (member) {
              if (lc.loaRole) await member.roles.add(lc.loaRole).catch(() => {});
              const prefix = lc.prefix ?? '[LOA]';
              const currentNick = member.nickname ?? member.user.username;
              const newNick = `${prefix} ${currentNick}`.slice(0, 32);
              await member.setNickname(newNick).catch(() => {});
            }
            await client.users.fetch(targetId).then(u => u.send({ embeds: [new EmbedBuilder().setTitle('✅ LOA Approved!').setColor(0x57F287).setDescription(`Your LOA in **${interaction.guild.name}** has been **approved**!\n\nEnds: <t:${Math.floor(loaPending.endsAt/1000)}:R>`).setTimestamp()] })).catch(() => {});
          }
          await interaction.followUp({ content: `✅ LOA approved!` }).catch(() => {});
        }
        if (action === 'deny') {
          delete lc.active[`pending_${targetId}`];
          await saveGuildConfig(guildId);
          await client.users.fetch(targetId).then(u => u.send({ embeds: [new EmbedBuilder().setTitle('❌ LOA Denied').setColor(0xED4245).setDescription(`Your LOA request in **${interaction.guild.name}** was denied.`).setTimestamp()] })).catch(() => {});
          await interaction.followUp({ content: `❌ LOA denied.` }).catch(() => {});
        }
        return;
      }
      const id = interaction.customId;

      // Non-main server: block all setup buttons except channel-select buttons
      // Always allow: executive/foundership requests, tickets, verification, session vote, general vote, close requests, self role, application open
      const isSetupButton = id.startsWith('setup_menu__') || id.startsWith('t_') || id.startsWith('s_') ||
        id.startsWith('wc_') || id.startsWith('vc_') || id.startsWith('ar_') || id.startsWith('am_') ||
        id.startsWith('cnt_') || id.startsWith('tr_setup__') || id.startsWith('hb__') ||
        id.startsWith('appe__') || id.startsWith('apte__') || id.startsWith('ap_') ||
        id.startsWith('sr_') || id.startsWith('sre__') || id.startsWith('an_') || id.startsWith('ane__') ||
        id.startsWith('perms__') || id.startsWith('dept__') || id.startsWith('botcfg__') ||
        id.startsWith('vote_setup__') || id.startsWith('cmdlist__') || id.startsWith('reqsetup__') ||
        id.startsWith('erlc_') || id.startsWith('rperms__') || id.startsWith('sm_') ||
        id === 'an__back' || id === 'sr__back';
      const deptAllowedButtons = id.startsWith('foundership__') || id.startsWith('ticketv2__') || id.startsWith('ticketv2type__') || id.startsWith('staffrank__');
      if (isSetupButton && !isMainServer(guildId) && !isChannelSelectButton(id) && !deptAllowedButtons) {
        return interaction.reply({ content: '❌ This can only be configured on the main server.', flags: MessageFlags.Ephemeral });
      }

      // ════ FOUNDERSHIP SETUP BUTTONS ════
      if (id.startsWith('foundership__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const fc = getFoundershipConfig(guildId);
        const action = id.replace('foundership__', '');
        if (action === 'set_roles') {
          return interaction.reply({
            content: '### 👑 Select Foundership roles\nThese roles get permanent access to all tickets.',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('foundership_save_roles').setPlaceholder('Select Foundership roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'clear_roles') {
          fc.roles = [];
          await saveGuildConfig(guildId);
          return interaction.reply({ content: '✅ Foundership roles cleared.', flags: MessageFlags.Ephemeral });
        }
      }

      // ════ TICKET V2 LOG BUTTONS ════
      if (id.startsWith('ticketv2__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('ticketv2__', '');
        if (action === 'log_channel')        return interaction.reply({ content: '### 📋 Select ticket log channel',  components: [channelDropdown('ticketv2_log_channel',        'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'transcript_channel') return interaction.reply({ content: '### 📝 Select transcript channel',  components: [channelDropdown('ticketv2_transcript_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
      }

      // ════ STAFF RANK SETUP BUTTONS ════
      if (id.startsWith('staffrank__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const src = getStaffRankConfig(guildId);
        const action = id.replace('staffrank__', '');
        if (action === 'add') {
          const modal = new ModalBuilder().setCustomId('modal_staffrank_add').setTitle('Add Staff Rank');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rank_name').setLabel('Rank name (e.g. Moderator)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rank_level').setLabel('Level (higher = more senior, e.g. 5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'remove') {
          if (!src.ranks.length) return interaction.reply({ content: '❌ No ranks to remove.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('staffrank_remove_sel').setPlaceholder('Select rank to remove...').addOptions(src.ranks.map(r => ({ label: `Level ${r.level} — ${r.name}`, value: String(r.id ?? '') })));
          return interaction.reply({ content: '### ➖ Remove rank', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ TICKET V2 TYPE MANAGER ════
      if (id.startsWith('ticketv2type__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const v2 = getTicketV2Config(guildId);
        const action = id.replace('ticketv2type__', '');
        if (action === 'add') {
          const modal = new ModalBuilder().setCustomId('modal_ticketv2type_add').setTitle('Add V2 Type Config');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v2type_name').setLabel('Ticket type name (must match exactly)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v2type_minrank').setLabel('Minimum staff rank level (0 = none)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3).setValue('0')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v2type_autoclose').setLabel('Auto-close after hours (0 = off)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setValue('0')),
          );
          return interaction.showModal(modal);
        }
        if (action === 'edit') {
          if (!v2.types?.length) return interaction.reply({ content: '❌ No V2 type configs.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('ticketv2type_edit_sel').setPlaceholder('Select type to edit...').addOptions(v2.types.map(t => ({ label: t.ticketTypeName, value: String(t.id) })));
          return interaction.reply({ content: '### ✏️ Select type config to edit', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (action === 'remove') {
          if (!v2.types?.length) return interaction.reply({ content: '❌ No V2 type configs.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('ticketv2type_remove_sel').setPlaceholder('Select type to remove...').addOptions(v2.types.map(t => ({ label: t.ticketTypeName, value: String(t.id) })));
          return interaction.reply({ content: '### 🗑️ Select type config to remove', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (action.startsWith('setcat__')) {
          const typeId = action.replace('setcat__', '');
          return interaction.reply({ content: '### 📁 Select category for this ticket type', components: [channelDropdown(`ticketv2type_cat__${typeId}`, 'Select category...', [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ INFRACTION SETUP BUTTONS ════
      if (id.startsWith('inf__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const ic = getInfractionConfig(guildId);
        const action = id.replace('inf__', '');

        if (action === 'set_role') {
          const sel = new StringSelectMenuBuilder()
            .setCustomId('inf_select_level')
            .setPlaceholder('Select a progression level...')
            .addOptions(INFRACTION_PROGRESSION.map((p, i) => ({
              label: `${i + 1}. ${p.label}`,
              description: ic.hierarchy[i]?.roleId ? `Current: role set` : 'No role set',
              value: `${i}`,
              emoji: p.category === 'Termination' ? '🚨' : p.category === 'Strike' ? '🔴' : '🟡',
            })));
          return interaction.reply({
            content: '### 🎭 Select which level you want to assign a role to',
            components: [new ActionRowBuilder().addComponents(sel)],
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'log_channel') {
          return interaction.reply({
            content: '### 📢 Select log channel for strikes',
            components: [channelDropdown('inf_log_channel', 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'edit_embed') {
          const modal = new ModalBuilder().setCustomId('modal_inf_embed').setTitle('Edit Strike Embed');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inf_title').setLabel('Embed title').setStyle(TextInputStyle.Short).setValue(ic.embedTitle || '').setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inf_desc').setLabel('Embed description').setStyle(TextInputStyle.Paragraph).setValue(ic.embedDescription || '').setRequired(true).setMaxLength(2000)),
          );
          return interaction.showModal(modal);
        }

        if (action === 'edit_dm') {
          const modal = new ModalBuilder().setCustomId('modal_inf_dm').setTitle('Edit Strike DM Message');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inf_dm').setLabel('DM message').setStyle(TextInputStyle.Paragraph).setValue(ic.dmMessage || '').setRequired(true).setMaxLength(2000)),
          );
          return interaction.showModal(modal);
        }

        if (action === 'edit_color') {
          const modal = new ModalBuilder().setCustomId('modal_inf_color').setTitle('Edit Strike Embed Color');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inf_color').setLabel('Hex color (e.g. #ED4245)').setStyle(TextInputStyle.Short).setValue(ic.embedColor || '#ED4245').setRequired(true).setMaxLength(7)),
          );
          return interaction.showModal(modal);
        }

        if (action === 'edit_termination') {
          const modal = new ModalBuilder().setCustomId('modal_inf_termination').setTitle('Edit Termination Message');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inf_termination').setLabel('Termination message (sent to log channel)').setStyle(TextInputStyle.Paragraph).setValue(ic.terminationMessage || '').setRequired(true).setMaxLength(2000)),
          );
          return interaction.showModal(modal);
        }
      }

      // ════ DEPARTMENT SERVER SETUP BUTTONS ════
      if (id.startsWith('dept_setup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('dept_setup__', '');

        // ── Channels ──
        if (action === 'ticket_channel')        return interaction.reply({ content: '### 🎫 Ticket panel channel',         components: [channelDropdown('td_channel',               'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'transcript')            return interaction.reply({ content: '### 📋 Transcript channel',            components: [channelDropdown('td_transcript',             'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'ticket_category')       return interaction.reply({ content: '### 📁 Ticket category',              components: [channelDropdown('td_category',               'Select category...',  [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        if (action === 'session_channel')       return interaction.reply({ content: '### 🎮 Session channel',              components: [channelDropdown('sd_channel',                'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'welcome_channel')       return interaction.reply({ content: '### 👋 Welcome channel',              components: [channelDropdown('wcd_channel',               'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'verify_channel')        return interaction.reply({ content: '### ✅ Verification channel',         components: [channelDropdown('vcd_channel',               'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'app_review')            return interaction.reply({ content: '### 📋 App review channel',           components: [channelDropdown('apd_review_channel',        'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'app_log')               return interaction.reply({ content: '### 📝 App log channel',              components: [channelDropdown('apd_log_channel',           'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'training_channel')      return interaction.reply({ content: '### 🎓 Training request channel',     components: [channelDropdown('tr_setup_channel',          'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'training_announce')     return interaction.reply({ content: '### 📣 Training announce channel',    components: [channelDropdown('tr_setup_announce_channel', 'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'loa_log')               return interaction.reply({ content: '### 📋 LOA log channel',              components: [channelDropdown('load_log_channel',          'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'erlc_kickbans')         return interaction.reply({ content: '### 🔨 ERLC kick/ban channel',        components: [channelDropdown('erlcd_kickbans',            'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'erlc_joinleave')        return interaction.reply({ content: '### 📥 ERLC join/leave channel',      components: [channelDropdown('erlcd_joinleave',           'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'erlc_cmds')             return interaction.reply({ content: '### ⌨️ ERLC commands channel',        components: [channelDropdown('erlcd_cmds',                'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'erlc_modcall')          return interaction.reply({ content: '### 🚨 ERLC mod call channel',        components: [channelDropdown('erlcd_modcall',             'Select channel...')],                              flags: MessageFlags.Ephemeral });
        if (action === 'erlc_kills')            return interaction.reply({ content: '### 💀 ERLC kill log channel',        components: [channelDropdown('erlcd_kills',               'Select channel...')],                              flags: MessageFlags.Ephemeral });

        // ── Roles ──
        if (action === 'ticket_ping_roles')     return interaction.reply({ content: '### 📢 Ticket ping roles\n*Leave empty to inherit from main server*',     components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('td_ping_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))],     flags: MessageFlags.Ephemeral });
        if (action === 'session_ping_roles')    return interaction.reply({ content: '### 👥 Session ping roles\n*Leave empty to inherit from main server*',     components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('sd_ping_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))],     flags: MessageFlags.Ephemeral });
        if (action === 'session_allowed_roles') return interaction.reply({ content: '### 🔑 Session allowed roles\n*Leave empty to inherit from main server*',  components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('sd_allowed_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))],  flags: MessageFlags.Ephemeral });
        if (action === 'verify_role')           return interaction.reply({ content: '### 🎭 Verified role',                                                      components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('vcd_role').setPlaceholder('Select role...').setMinValues(1).setMaxValues(1))],                   flags: MessageFlags.Ephemeral });
        if (action === 'loa_role')              return interaction.reply({ content: '### 🏖️ LOA role',                                                           components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('load_role').setPlaceholder('Select role...').setMinValues(1).setMaxValues(1))],                    flags: MessageFlags.Ephemeral });
        if (action === 'loa_approval_roles')    return interaction.reply({ content: '### 🔑 LOA approval roles\n*Leave empty to inherit from main server*',     components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('load_approval_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'autorole')              return interaction.reply({ content: '### 🎭 Autoroles\n*Leave empty to inherit from main server*',               components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('ard_add').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))],              flags: MessageFlags.Ephemeral });
        if (action === 'training_roles') {
          return interaction.reply({
            content: '### 🔑 Training roles\n*Select trainer roles for this department*',
            components: [
              new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('tr_setup_trainer_roles').setPlaceholder('Trainer roles...').setMinValues(0).setMaxValues(10)),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'perms') {
          const pc2 = getPermissionsConfig(guildId);
          const fmt2 = (arr) => arr?.length ? arr.map(r => `<@&${r}>`).join(', ') : '*Inherited from main*';
          const permEmbed = new EmbedBuilder()
            .setTitle('👑 Department Permission Roles')
            .setColor(0x5865F2)
            .setDescription('Set role overrides for this department. Leave empty to inherit from main server.')
            .addFields(
              { name: '👑 Admin',  value: fmt2(config[guildId]?.permissions?.adminRoles),  inline: true },
              { name: '🛡️ Mod',   value: fmt2(config[guildId]?.permissions?.modRoles),    inline: true },
              { name: '👤 Staff', value: fmt2(config[guildId]?.permissions?.staffRoles),  inline: true },
              { name: '⭐ SHR',   value: fmt2(config[guildId]?.permissions?.shrRoles),    inline: true },
            );
          const permRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dept_setup__perms_admin').setLabel('Admin').setStyle(ButtonStyle.Primary).setEmoji('👑'),
            new ButtonBuilder().setCustomId('dept_setup__perms_mod').setLabel('Mod').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
            new ButtonBuilder().setCustomId('dept_setup__perms_staff').setLabel('Staff').setStyle(ButtonStyle.Primary).setEmoji('👤'),
            new ButtonBuilder().setCustomId('dept_setup__perms_shr').setLabel('SHR').setStyle(ButtonStyle.Primary).setEmoji('⭐'),
          );
          return interaction.reply({ embeds: [permEmbed], components: [permRow], flags: MessageFlags.Ephemeral });
        }

        // ── Permission sub-buttons ──
        const roleMap2 = { perms_admin: 'admin', perms_mod: 'mod', perms_staff: 'staff', perms_shr: 'shr' };
        const labelMap2 = { admin: 'Admin', mod: 'Mod', staff: 'Staff', shr: 'SHR' };
        if (roleMap2[action]) {
          const level = roleMap2[action];
          return interaction.reply({
            content: `### 🔐 Select **${labelMap2[level]}** roles\n*Leave empty to inherit from main server*`,
            components: [new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId(`perms_save__${level}`)
                .setPlaceholder(`Select ${labelMap2[level]} roles (0 = inherit from main)...`)
                .setMinValues(0)
                .setMaxValues(10)
            )],
            flags: MessageFlags.Ephemeral,
          });
        }
      }

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
        const userTag = `${userDisplay(interaction.user)} (<@${interaction.user.id}>)`;
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

        if (approved) await interaction.followUp({ content: `✅ **Request approved!** Required ${required} approvals reached.` }).catch(() => {});
        if (denied)   await interaction.followUp({ content: `❌ **Request denied!** Required ${required} denials reached.` }).catch(() => {});
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
          currentClaims.push(`<@${interaction.user.id}> (${userDisplay(interaction.user)})`);
          const updatedEmbed = EmbedBuilder.from(embed).spliceFields(embed.fields.findIndex(f => f.name === '✅ Claimed By'), 1, { name: '✅ Claimed By', value: currentClaims.join('\n'), inline: false });
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
          return;
        }

        if (action === 'unclaim') {
          const newClaims = currentClaims.filter(c => !c.includes(interaction.user.id));
          if (newClaims.length === currentClaims.length) return interaction.reply({ content: '❌ You have not claimed this request.', flags: MessageFlags.Ephemeral });
          const updatedEmbed = EmbedBuilder.from(embed).spliceFields(embed.fields.findIndex(f => f.name === '✅ Claimed By'), 1, { name: '✅ Claimed By', value: newClaims.length ? newClaims.join('\n') : '*No one yet*', inline: false });
          await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
          // V2 unclaim
          const unclaimRec = await getTicketRecord(interaction.channel?.id).catch(() => null);
          if (unclaimRec && unclaimRec.claimedBy === interaction.user.id) {
            await updateTicketRecord(interaction.channel.id, { claimedBy: null }).catch(() => {});
            await logTicketAction(interaction.guild, guildId, 'unclaimed', { channel: interaction.channel.id, by: interaction.user.id }).catch(() => {});
          }
          return;
        }

        if (action === 'pass' || action === 'fail') {
          const passed = action === 'pass';
          // typeId is stored as 5th part of customId: tr__pass__userId__reqId__typeId
          const typeId = parts[4] ?? 'none';
          const tcInner = getTrainingConfig(guildId);
          const trainingType = typeId !== 'none' ? tcInner.types.find(t => t.id === typeId) : null;

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
          updatedEmbed = updatedEmbed.addFields({ name: passed ? '🎓 Passed By' : '❌ Failed By', value: `<@${interaction.user.id}> (${userDisplay(interaction.user)})`, inline: true });
          await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

          if (passed) {
            const targetUser = await client.users.fetch(requestUserId).catch(() => null);
            const typeName = trainingType ? trainingType.name : 'their training';
            if (targetUser) await sendPromotionAnnounce(interaction.guild, targetUser, typeName, interaction.user, 'training');

            const targetMemberForPromo = await interaction.guild.members.fetch(requestUserId).catch(() => null);
            const cc = getChainConfig(guildId);

            if (cc.chain.length > 0 && targetMemberForPromo) {
              // Chain geconfigureerd — automatisch één stap omhoog
              const result = await promoteInChain(interaction.guild, targetMemberForPromo, interaction.user, guildId);
              if (result.success) {
                await interaction.followUp({ content: `✅ **${userDisplay(targetMemberForPromo.user)}** automatically promoted to **${result.newRole.name}** via chain of command.`, flags: MessageFlags.Ephemeral });
              } else {
                await interaction.followUp({ content: `⚠️ Training passed but chain promotion failed: ${result.reason}`, flags: MessageFlags.Ephemeral });
              }
            } else if (trainingType?.roleId && targetMemberForPromo) {
              // Geen chain — gebruik training type rol
              await targetMemberForPromo.roles.add(trainingType.roleId).catch(() => {});
              await interaction.followUp({ content: `✅ Automatically gave <@&${trainingType.roleId}> to <@${requestUserId}> for passing **${trainingType.name}**.`, flags: MessageFlags.Ephemeral });
            } else {
              // Geen chain, geen type rol — handmatige selectie
              await interaction.followUp({
                content: `### 🎭 Optionally give a role to <@${requestUserId}> for passing${trainingType ? ` **${trainingType.name}**` : ''}:`,
                components: [new ActionRowBuilder().addComponents(
                  new RoleSelectMenuBuilder().setCustomId(`tr_pass_role__${requestUserId}`).setPlaceholder('Select role to give (optional)...').setMinValues(0).setMaxValues(1)
                )],
                flags: MessageFlags.Ephemeral,
              });
            }
          }

          // DM naar aanvrager
          const targetUser = await client.users.fetch(requestUserId).catch(() => null);
          if (targetUser) {
            const typeLine = trainingType ? `\n**Training:** ${trainingType.name}` : '';
            const dmEmbed = new EmbedBuilder()
              .setTitle(passed ? '🎓 Training Passed!' : '❌ Training Failed')
              .setColor(passed ? 0x57F287 : 0xED4245)
              .setDescription(passed
                ? `Congratulations! **${userDisplay(interaction.user)}** has marked your training as **passed**! 🎉${typeLine}`
                : `**${userDisplay(interaction.user)}** has marked your training as **failed**. Don't give up — keep practicing!${typeLine}`)
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
          const vars = { userMention: `<@${voteData.hostId}>`, username: hostUser.username ?? 'Unknown', userTag: userDisplay(hostUser) ?? 'Unknown', memberCount: interaction.guild.memberCount.toString(), server: interaction.guild.name };
          const voterMentions = voteData.voters.map(id => `<@${id}>`).join(' ');
          await postSessionStart(interaction.guild, sc, hostUser, voteData.joinLink, vars, voterMentions);
          // Cross-server announcement to all departments
          await sendCrossServerAnnouncement(hostUser, voteData.joinLink, voterMentions).catch(console.error);
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
        const action = parts[1];
        const typeId = parts.slice(2).join('__');
        if (!action || !typeId) return interaction.reply({ content: '❌ Malformed button ID.', flags: MessageFlags.Ephemeral });
        if (action === 'required') return interaction.reply({ content: `### 🔒 Select required roles`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`tkt_required_roles__${typeId}`).setPlaceholder('Select required roles (0 = everyone)...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'view')     return interaction.reply({ content: `### 👁️ Select view roles`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`tkt_view_roles__${typeId}`).setPlaceholder('Select view roles (0 = none)...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'category') return interaction.reply({ content: `### 📁 Select category for this ticket type`, components: [channelDropdown(`tkt_type_category__${typeId}`, 'Select category...', [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        if (action === 'ping_roles') return interaction.reply({ content: `### 📢 Select ping roles for this type\n*Leave empty to use global ping roles*`, components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`tkt_type_ping_roles__${typeId}`).setPlaceholder('Select ping roles (empty = use global)...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (action === 'transcript') return interaction.reply({ content: `### 📋 Select transcript channel for this type\n*Leave empty to use global*`, components: [channelDropdown(`tkt_type_transcript__${typeId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (action === 'embed') {
          const tc2 = getTicketConfig(guildId);
          const t2  = tc2.ticketTypes.find(t => t.id === typeId);
          if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          const safeWelcome  = String(t2.welcomeText  ?? '').slice(0, 1000);
          const safeColor    = String(t2.embedColor   ?? '').slice(0, 7);
          const safeImage    = String(t2.embedImage   ?? '').slice(0, 500);
          const safeClose    = String(t2.closeMessage ?? '').slice(0, 200);
          const safeDmOnOpen = t2.dmOnOpen === true ? 'yes' : t2.dmOnOpen === false ? 'no' : 'global';
          const safeTitle    = String(t2.label ?? 'Type').slice(0, 40);
          const modal = new ModalBuilder().setCustomId(`modal_tkt_type_embed__${typeId}`).setTitle(`Embed: ${safeTitle}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_welcome').setLabel('Welcome text (empty = global)').setStyle(TextInputStyle.Paragraph).setValue(safeWelcome).setRequired(false).setMaxLength(1000)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_color').setLabel('Color hex (empty = global)').setStyle(TextInputStyle.Short).setValue(safeColor).setRequired(false).setMaxLength(7)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_image').setLabel('Image URL (empty = none)').setStyle(TextInputStyle.Short).setValue(safeImage).setRequired(false).setMaxLength(500)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_close_msg').setLabel('Close message (empty = global)').setStyle(TextInputStyle.Short).setValue(safeClose).setRequired(false).setMaxLength(200)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_dm_open').setLabel('DM on open? (yes / no / global)').setStyle(TextInputStyle.Short).setValue(safeDmOnOpen).setRequired(false).setMaxLength(6)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'limits') {
          const tc2 = getTicketConfig(guildId);
          const t2  = tc2.ticketTypes.find(t => t.id === typeId);
          if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          const modal = new ModalBuilder().setCustomId(`modal_tkt_type_limits__${typeId}`).setTitle(`Limits: ${String(t2.label).slice(0, 40)}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_cooldown').setLabel('Cooldown in minutes (0 = none)').setStyle(TextInputStyle.Short).setValue(t2.cooldownMinutes != null ? `${t2.cooldownMinutes}` : '0').setRequired(false).setMaxLength(5)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_max_open').setLabel('Max open tickets of this type (0 = unlimited)').setStyle(TextInputStyle.Short).setValue(t2.maxOpen != null ? `${t2.maxOpen}` : '0').setRequired(false).setMaxLength(3)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tkt_auto_close').setLabel('Auto-close after X hours (0 = disabled)').setStyle(TextInputStyle.Short).setValue(t2.autoCloseHours != null ? `${t2.autoCloseHours}` : '0').setRequired(false).setMaxLength(4)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'logchannel') {
          const tc2 = getTicketConfig(guildId);
          const t2  = tc2.ticketTypes.find(t => t.id === typeId);
          if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          return interaction.reply({ content: `### 📋 Select log channel for **${t2.label}** tickets`, components: [channelDropdown(`tkt_type_log__${typeId}`, 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'intake') {
          const tc2 = getTicketConfig(guildId);
          const t2  = tc2.ticketTypes.find(t => t.id === typeId);
          if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          if (!Array.isArray(t2.intakeFields)) t2.intakeFields = [];
          const fieldList = t2.intakeFields.length
            ? t2.intakeFields.map((f, i) => `**${i+1}.** ${f.label} ${f.required ? '*(required)*' : '*(optional)*'}`).join('\n')
            : '*No fields yet*';
          const embed = new EmbedBuilder()
            .setTitle(`📋 Intake Form — ${t2.label}`)
            .setColor(0x5865F2)
            .setDescription('Users fill this form when opening a ticket.\nMax **4 fields** (Discord modal limit).\n\n' + fieldList);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`tkt_intake__add__${typeId}`).setLabel('Add Field').setStyle(ButtonStyle.Success).setEmoji('➕').setDisabled(t2.intakeFields.length >= 4),
            new ButtonBuilder().setCustomId(`tkt_intake__clear__${typeId}`).setLabel('Clear All').setStyle(ButtonStyle.Danger).setEmoji('🗑️').setDisabled(!t2.intakeFields.length),
          );
          return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
        }
        if (action === 'precheck') {
          const tc2 = getTicketConfig(guildId);
          const t2  = tc2.ticketTypes.find(t => t.id === typeId);
          if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
          if (!t2.preCheck || typeof t2.preCheck !== 'object') t2.preCheck = {};

          // Converteer alles veilig — null/undefined/object worden nooit doorgegeven aan setValue
          const pcEnabled = t2.preCheck.enabled === true ? 'yes'
                          : t2.preCheck.enabled === false ? 'no'
                          : 'global';

          const pcRules  = (t2.preCheck.rulesText != null && typeof t2.preCheck.rulesText === 'string')
                          ? t2.preCheck.rulesText.slice(0, 1000)
                          : '';

          const pcMinAmt = (t2.preCheck.minimumAmount != null && !isNaN(Number(t2.preCheck.minimumAmount)))
                          ? String(Number(t2.preCheck.minimumAmount))
                          : '';

          const pcLabel  = (t2.preCheck.amountLabel != null && typeof t2.preCheck.amountLabel === 'string')
                          ? t2.preCheck.amountLabel.slice(0, 40)
                          : '';

          const pcDenial = (t2.preCheck.amountDenialMessage != null && typeof t2.preCheck.amountDenialMessage === 'string')
                          ? t2.preCheck.amountDenialMessage.slice(0, 800)
                          : '';

          const modalTitle = `Pre-Check: ${String(t2.label ?? '').slice(0, 33)}`;

          const modal = new ModalBuilder()
            .setCustomId(`modal_tkt_type_precheck__${typeId}`)
            .setTitle(modalTitle);

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_enabled').setLabel('Enabled? (yes / no / global)').setStyle(TextInputStyle.Short).setValue(pcEnabled).setRequired(false).setMaxLength(6)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_rules').setLabel('Rules text (empty = global)').setStyle(TextInputStyle.Paragraph).setValue(pcRules).setRequired(false).setMaxLength(1000)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_min_amount').setLabel('Min. amount (empty = global)').setStyle(TextInputStyle.Short).setValue(pcMinAmt).setRequired(false).setMaxLength(10)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_amount_label').setLabel('Amount label (empty = global)').setStyle(TextInputStyle.Short).setValue(pcLabel).setRequired(false).setMaxLength(40)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_denial_msg').setLabel('Denial message (empty = global)').setStyle(TextInputStyle.Paragraph).setValue(pcDenial).setRequired(false).setMaxLength(800)
            ),
          );
          return interaction.showModal(modal);
        }
      }

      // ════ QOTD SETUP BUTTONS ════
      if (id.startsWith('qotd__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const qc = getQOTDConfig(guildId);
        const action = id.replace('qotd__', '');

        if (action === 'toggle') {
          qc.enabled = !qc.enabled;
          await saveGuildConfig(guildId);
          return interaction.update(buildQOTDSetupPayload(guildId));
        }
        if (action === 'channel') {
          return interaction.reply({ content: '### 📢 Select QOTD channel', components: [channelDropdown('qotd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'pingrole') {
          return interaction.reply({ content: '### 🔔 Select ping role for QOTD', components: [roleDropdown('qotd_pingrole', 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
        }
        if (action === 'autogenerate') {
          qc.autoGenerate = !qc.autoGenerate;
          await saveGuildConfig(guildId);
          return interaction.update(buildQOTDSetupPayload(guildId));
        }
        if (action === 'exhaust') {
          qc.onExhaust = qc.onExhaust === 'stop' ? 'reshuffle' : 'stop';
          await saveGuildConfig(guildId);
          return interaction.update(buildQOTDSetupPayload(guildId));
        }
        if (action === 'shuffle') {
          qc.queue = buildQOTDQueue(qc);
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ Queue shuffled! **${qc.queue.length}** questions in queue.`, flags: MessageFlags.Ephemeral });
        }
        if (action === 'reset_usage') {
          for (const q of qc.library) q.used = false;
          qc.queue = buildQOTDQueue(qc);
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ Usage reset! All **${qc.library.length}** questions marked as unused and queue rebuilt.`, flags: MessageFlags.Ephemeral });
        }
        if (action === 'remove_dupes') {
          const seen = new Set();
          const before = qc.library.length;
          qc.library = qc.library.filter(q => {
            const key = q.text.toLowerCase().trim();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          const removed = before - qc.library.length;
          qc.queue = buildQOTDQueue(qc);
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ Removed **${removed}** duplicate(s). Library now has **${qc.library.length}** questions.`, flags: MessageFlags.Ephemeral });
        }
        if (action === 'export') {
          if (!qc.library.length) return interaction.reply({ content: '❌ No questions to export.', flags: MessageFlags.Ephemeral });
          const text = qc.library.map(q => q.text).join('\n');
          // Send as file attachment
          const buffer = Buffer.from(text, 'utf8');
          const file = new AttachmentBuilder(buffer, { name: `qotd-${guildId}-${Date.now()}.txt` });
          return interaction.reply({ content: `✅ Exported **${qc.library.length}** questions.`, files: [file], flags: MessageFlags.Ephemeral });
        }
        if (action === 'time') {
          const modal = new ModalBuilder().setCustomId('modal_qotd_time').setTitle('Set QOTD Time');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('qotd_time').setLabel('Time in UTC (HH:MM, e.g. 09:00)').setStyle(TextInputStyle.Short).setValue(qc.time ?? '09:00').setRequired(true).setMaxLength(5)
            )
          );
          return interaction.showModal(modal);
        }
        if (action === 'add_question') {
          const modal = new ModalBuilder().setCustomId('modal_qotd_add').setTitle('Add Question');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('qotd_question').setLabel('Question').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder('What is your favorite memory in this server?')
            )
          );
          return interaction.showModal(modal);
        }
        if (action === 'bulk_import') {
          const modal = new ModalBuilder()
            .setCustomId('modal_qotd_bulk')
            .setTitle('Bulk Import');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('qotd_bulk')
                .setLabel('Questions — one per line')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(4000)
                .setPlaceholder('What is your favorite game?\nIf you could have any superpower?')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('qotd_dedup')
                .setLabel('Remove duplicates? (yes / no)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(3)
                .setValue('yes')
            ),
          );
          return interaction.showModal(modal);
        }
        if (action === 'view_questions') {
          if (!qc.library.length) return interaction.reply({ content: '❌ No questions in library.', flags: MessageFlags.Ephemeral });
          const page1 = qc.library.slice(0, 25);
          const list  = page1.map((q, i) => `**${i+1}.** ${q.used ? '~~' : ''}${q.text.slice(0, 70)}${q.used ? '~~' : ''}`).join('\n');
          const more  = qc.library.length > 25 ? `\n\n*...and ${qc.library.length - 25} more*` : '';
          return interaction.reply({ content: `### 📋 QOTD Library (${qc.library.length} total, ${qc.library.filter(q=>!q.used).length} unused)\n${list}${more}`, flags: MessageFlags.Ephemeral });
        }
        if (action === 'clear_questions') {
          qc.library = [];
          qc.queue   = [];
          await saveGuildConfig(guildId);
          return interaction.reply({ content: '✅ All questions deleted.', flags: MessageFlags.Ephemeral });
        }
        if (action === 'post_now') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            await postQOTD(interaction.guild, guildId, true);
            return interaction.editReply({ content: '✅ QOTD posted!' });
          } catch (e) {
            return interaction.editReply({ content: `❌ ${e.message}` });
          }
        }
      }

      // ════ TICKET INACTIVITY BUTTONS ════
      if (id.startsWith('tkt_inactivity__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const ic = getTicketInactivityConfig(guildId);
        const action = id.replace('tkt_inactivity__', '');
        if (action === 'toggle') {
          ic.enabled = !ic.enabled;
          await saveGuildConfig(guildId);
          return interaction.update(buildTicketInactivitySetupPayload(guildId));
        }
        if (action === 'dm') {
          ic.dmOnClose = !ic.dmOnClose;
          await saveGuildConfig(guildId);
          return interaction.update(buildTicketInactivitySetupPayload(guildId));
        }
        if (action === 'settings') {
          const modal = new ModalBuilder().setCustomId('modal_tkt_inactivity').setTitle('Ticket Inactivity Settings');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('warn_minutes').setLabel('Warn after (minutes)').setStyle(TextInputStyle.Short).setValue(String(ic.warnAfterMinutes ?? 1440)).setRequired(true).setMaxLength(6)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('close_minutes').setLabel('Close after (minutes)').setStyle(TextInputStyle.Short).setValue(String(ic.closeAfterMinutes ?? 2880)).setRequired(true).setMaxLength(6)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('warn_message').setLabel('Warning message').setStyle(TextInputStyle.Paragraph).setValue(String(ic.warnMessage ?? '')).setRequired(false).setMaxLength(500)),
          );
          return interaction.showModal(modal);
        }
      }

      if (id === 't_inactivity') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        return interaction.reply(buildTicketInactivitySetupPayload(guildId));
      }

      // ════ TICKET INTAKE FORM BUTTONS ════
      if (id.startsWith('tkt_intake__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const intakeParts  = id.split('__');
        const intakeAction = intakeParts[1];
        const intakeTypeId = intakeParts[2];
        const tc2 = getTicketConfig(guildId);
        const t2  = tc2.ticketTypes.find(t => t.id === intakeTypeId);
        if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        if (!Array.isArray(t2.intakeFields)) t2.intakeFields = [];

        if (intakeAction === 'add') {
          if (t2.intakeFields.length >= 4) return interaction.reply({ content: '❌ Max 4 fields allowed.', flags: MessageFlags.Ephemeral });
          const modal = new ModalBuilder()
            .setCustomId(`modal_intake_add__${intakeTypeId}`)
            .setTitle('Add Intake Field');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('intake_label').setLabel('Field label (e.g. Server Name)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(45).setPlaceholder('Server Name')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('intake_placeholder').setLabel('Placeholder text (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('e.g. New York Liberty RP')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('intake_required').setLabel('Required? (yes / no)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue('yes')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('intake_long').setLabel('Long answer? (yes = paragraph, no = short)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue('no')
            ),
          );
          return interaction.showModal(modal);
        }

        if (intakeAction === 'clear') {
          t2.intakeFields = [];
          await saveGuildConfig(guildId);
          return interaction.reply({ content: `✅ Intake fields cleared for **${t2.label}**.`, flags: MessageFlags.Ephemeral });
        }
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
          await saveGuildConfig(guildId);
          return interaction.editReply({ content: `✅ Handbook panel deployed in <#${panel.channel}>!` });
        }
        if (action === 'delete_panel') { delete hc.panels[panelId]; await saveGuildConfig(guildId); return interaction.update(buildHandbookSetupPayload(guildId)); }
      }


      // ════ GENERAL VOTE BUTTONS ════
      if (id.startsWith('vote__')) {
        const parts  = id.split('__');
        const choice = parts[1]; // yes or no
        const voteId = parts[2];
        const voteData = activeGeneralVotes.get(voteId);
        if (!voteData) return interaction.reply({ content: '❌ This vote is no longer active.', flags: MessageFlags.Ephemeral });
        if (Date.now() > voteData.endsAt) {
          activeGeneralVotes.delete(voteId);
          return interaction.reply({ content: '❌ This vote has already ended.', flags: MessageFlags.Ephemeral });
        }
        const userId = interaction.user.id;
        if (voteData.yes.includes(userId) || voteData.no.includes(userId)) {
          return interaction.reply({ content: '❌ You have already voted!', flags: MessageFlags.Ephemeral });
        }
        if (choice === 'yes') voteData.yes.push(userId);
        if (choice === 'no')  voteData.no.push(userId);
        const yesCount = voteData.yes.length;
        const noCount  = voteData.no.length;
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .spliceFields(0, 1, { name: '✅ Yes', value: `${yesCount} vote${yesCount !== 1 ? 's' : ''}`, inline: true })
          .spliceFields(1, 1, { name: '❌ No',  value: `${noCount} vote${noCount !== 1 ? 's' : ''}`,  inline: true });
        await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
        return;
      }

      // ════ VOTE SETUP BUTTONS ════
      if (id.startsWith('vote_setup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('vote_setup__', '');
        const vc = getVoteConfig(guildId);
        if (action === 'toggle') {
          vc.mainServer = !vc.mainServer;
          await saveGuildConfig(guildId);
          return interaction.update(buildVoteSystemSetupPayload(guildId));
        }
        if (action === 'log') {
          return interaction.reply({ content: '### 📋 Select log channel for votes', components: [channelDropdown('vote_setup_log', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'announce_channel') {
          return interaction.reply({ content: '### 📣 Select announcement channel for successful votes', components: [channelDropdown('vote_setup_announce_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'announce_roles') {
          return interaction.reply({
            content: '### 🔔 Select roles to ping on successful vote announcements',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('vote_setup_announce_roles').setPlaceholder('Select roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      // ════ PERMISSIONS SETUP BUTTONS ════
      if (id.startsWith('perms__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const level = id.replace('perms__', '');
        const labelMap = { admin: 'Admin', mod: 'Mod', staff: 'Staff', shr: 'SHR' };
        if (!labelMap[level]) return;
        return interaction.reply({
          content: `### 🔐 Select **${labelMap[level]}** roles`,
          components: [new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(`perms_save__${level}`)
              .setPlaceholder(`Select ${labelMap[level]} roles...`)
              .setMinValues(0)
              .setMaxValues(10)
          )],
          flags: MessageFlags.Ephemeral,
        });
      }


      // ════ DEPARTMENT CONFIG BUTTONS (legacy — no-op) ════
      if (id.startsWith('dept_cfg__')) {
        return interaction.reply({ content: '❌ This is no longer supported. Use the Departments setup menu.', flags: MessageFlags.Ephemeral });
      }
      if (false && id.startsWith('dept_cfg__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const parts = id.split('__');
        const action = parts[1];
        const deptId = parts[2];
        const dc = getDepartmentsConfig(guildId);
        const dept = dc.list.find(d => d.id === deptId);
        if (!dept) return interaction.reply({ content: '❌ Department not found.', flags: MessageFlags.Ephemeral });
        if (action === 'role') {
          return interaction.reply({
            content: `### 🎭 Select role for **${dept.name}**`,
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`dept_set_role__${deptId}`).setPlaceholder('Select role...').setMinValues(1).setMaxValues(1))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'channel') {
          return interaction.reply({
            content: `### 📢 Select channel for **${dept.name}**`,
            components: [channelDropdown(`dept_set_channel__${deptId}`, 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'lead') {
          return interaction.reply({
            content: `### 👑 Select lead role for **${dept.name}**`,
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`dept_set_lead__${deptId}`).setPlaceholder('Select lead role...').setMinValues(1).setMaxValues(1))],
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      // ════ DEPARTMENTS SETUP BUTTONS ════
      if (id.startsWith('dept__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('dept__', '');
        const dc = getDepartmentsConfig(guildId);

        if (action === 'toggle_main') {
          dc.isMainServer = !dc.isMainServer;
          await saveGuildConfig(guildId);
          return interaction.update(buildDepartmentsSetupPayload(guildId));
        }

        if (action === 'add') {
          const modal = new ModalBuilder().setCustomId('modal_dept_add').setTitle('Add Department Server');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dept_name').setLabel('Department name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dept_guild_id').setLabel('Department Server ID').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20).setPlaceholder('Right-click server → Copy Server ID')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dept_webhook_url').setLabel('Webhook URL (from that server channel)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('https://discord.com/api/webhooks/...')),
          );
          return interaction.showModal(modal);
        }

        if (action === 'remove') {
          const depts = dc.departments ?? [];
          if (!depts.length) return interaction.reply({ content: '❌ No departments.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('dept_sel_remove').setPlaceholder('Select department to remove...').addOptions(depts.map(d => ({ label: d.name, value: String(d.id), description: `Server: ${d.guildId}` })));
          return interaction.reply({ content: '### 🗑️ Select department to remove', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ BOT CONFIG BUTTONS ════
      if (id.startsWith('botcfg__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('botcfg__', '');
        if (action === 'logo') {
          const bc = getBotConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_botcfg_logo').setTitle('Set Logo URL');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('logo_url').setLabel('Logo image URL (leave empty to clear)').setStyle(TextInputStyle.Short).setValue(bc.logoUrl || '').setRequired(false).setPlaceholder('https://example.com/logo.png')
            )
          );
          return interaction.showModal(modal);
        }
      }

      // ════ SETUP MENU BUTTONS ════
      if (id.startsWith('setup_menu__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const sub = id.replace('setup_menu__', '');
        const payloadMap = {
          roleping:      () => buildRolePingProtectionSetupPayload(guildId),
          foundership:   () => buildFoundershipSetupPayload(guildId),
          ticketv2logs:  () => buildTicketV2LogSetupPayload(guildId),
          staffranks:    () => buildStaffRankSetupPayload(guildId),
          ticketv2types: () => buildTicketV2TypeManagerPayload(guildId),
          tickets:       () => buildTicketSetupPayload(guildId),
          sessions:      () => buildSessionSetupPayload(guildId),
          selfroles:     () => buildSelfRoleOverview(guildId),
          announcements: () => buildAnnouncementOverview(guildId),
          welcomer:      () => buildWelcomerSetupPayload(guildId),
          autorole:      () => buildAutoroleSetupPayload(guildId),
          verification:  () => buildVerificationSetupPayload(guildId),
          applications:  () => buildApplicationSetupPayload(guildId),
          savedmessages: () => buildSavedMessagesPayload(guildId),
          automod:       () => buildAutomodSetupPayload(guildId),
          counters:      () => buildCounterSetupPayload(guildId),
          training:      () => buildTrainingSetupPayload(guildId),
          erlclogs:      () => buildErlcLogSetupPayload(guildId),
          execrequest:   () => buildRequestSetupPayload(guildId, 'exec'),
          founderrequest:() => buildRequestSetupPayload(guildId, 'founder'),
          roleperms:     () => buildRolePermsSetupPayload(guildId),
          commandlist:   () => buildCommandListSetupPayload(guildId),
          handbooks:     () => buildHandbookSetupPayload(guildId),
          permissions:   () => buildPermissionsSetupPayload(guildId),
          departments:   () => buildDepartmentsSetupPayload(guildId),
          votesystem:    () => buildVoteSystemSetupPayload(guildId),
          botconfig:     () => buildBotConfigSetupPayload(guildId),
          chainofcommand:() => buildChainSetupPayload(guildId),
          dept_overview: () => buildDepartmentSetupPayload(guildId),
          roleping:      () => buildRolePingProtectionSetupPayload(guildId),
          infractions:   () => buildInfractionSetupPayload(guildId),
          loa:           () => buildLOASetupPayload(guildId),
          qotd:          () => buildQOTDSetupPayload(guildId),
        };
        if (payloadMap[sub]) return interaction.reply(payloadMap[sub]());
      }

      // ════ ROLE PERMS SETUP BUTTONS ════
      if (id.startsWith('rperms__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('rperms__', '');
        if (action === 'clear') {
          config[guildId].rolePerms = {};
          await saveGuildConfig(guildId);
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
        if (id === 'erlc_toggle') { ec.enabled = !ec.enabled; await saveGuildConfig(guildId); return interaction.update(buildErlcLogSetupPayload(guildId)); }
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
        if (action === 'add_type') {
          const modal = new ModalBuilder().setCustomId('modal_tr_add_type').setTitle('Add Training Type');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_type_name').setLabel('Training type name').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Moderator Training').setRequired(true).setMaxLength(50)),
          );
          return interaction.showModal(modal);
        }
        if (action === 'remove_type') {
          const tc2 = getTrainingConfig(guildId);
          if (!tc2.types.length) return interaction.reply({ content: '❌ No training types to remove.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('tr_sel_remove_type').setPlaceholder('Select type to remove...').addOptions(tc2.types.map(t => ({ label: t.name, value: String(t.id) })));
          return interaction.reply({ content: '### 🗑️ Select training type to remove:', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ CHAIN OF COMMAND SETUP BUTTONS ════
      if (id.startsWith('coc__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cc = getChainConfig(guildId);
        const action = id.replace('coc__', '');

        if (action === 'add_rank') {
          // Toon role dropdown — alle rollen die nog niet in de chain zitten
          const existingIds = cc.chain.map(e => e.roleId);
          return interaction.reply({
            content: '### ➕ Select a role to add to the chain\n*Roles already in the chain are excluded.*',
            components: [new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId('coc_add_role')
                .setPlaceholder('Select role to add...')
                .setMinValues(1)
                .setMaxValues(1)
            )],
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'remove_rank') {
          if (!cc.chain.length) return interaction.reply({ content: '❌ No ranks in chain.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder()
            .setCustomId('coc_remove_rank')
            .setPlaceholder('Select rank to remove...')
            .addOptions(cc.chain.map((e, i) => {
              const role = interaction.guild.roles.cache.get(e.roleId);
              return { label: `${i + 1}. ${role?.name ?? e.roleId}`, value: String(e.roleId) };
            }));
          return interaction.reply({ content: '### ➖ Select rank to remove', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (action === 'move_up') {
          if (!cc.chain.length) return interaction.reply({ content: '❌ No ranks in chain.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder()
            .setCustomId('coc_move_up')
            .setPlaceholder('Select rank to move up...')
            .addOptions(cc.chain.map((e, i) => {
              const role = interaction.guild.roles.cache.get(e.roleId);
              return { label: `${i + 1}. ${role?.name ?? e.roleId}`, value: String(e.roleId) };
            }));
          return interaction.reply({ content: '### ⬆️ Select rank to move one position up', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (action === 'move_down') {
          if (!cc.chain.length) return interaction.reply({ content: '❌ No ranks in chain.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder()
            .setCustomId('coc_move_down')
            .setPlaceholder('Select rank to move down...')
            .addOptions(cc.chain.map((e, i) => {
              const role = interaction.guild.roles.cache.get(e.roleId);
              return { label: `${i + 1}. ${role?.name ?? e.roleId}`, value: String(e.roleId) };
            }));
          return interaction.reply({ content: '### ⬇️ Select rank to move one position down', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (action === 'log_channel') {
          return interaction.reply({
            content: '### 📋 Select log channel for chain promotions',
            components: [channelDropdown('coc_log_channel', 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'clear') {
          cc.chain = [];
          await saveGuildConfig(guildId);
          return interaction.update(buildChainSetupPayload(guildId));
        }
      }

      // ════ STAFF REVIEW SETUP BUTTONS ════
      if (id.startsWith('sr2_setup__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const action = id.replace('sr2_setup__', '');
        if (action === 'channel') {
          return interaction.reply({ content: '### 📢 Select the channel where staff reviews will be posted.', components: [channelDropdown('sr2d_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (action === 'staff_roles') {
          return interaction.reply({
            content: '### 👮 Select which roles count as staff (members with these roles can be reviewed). Leave empty = anyone can be reviewed.',
            components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('sr2d_staff_roles').setPlaceholder('Select staff roles...').setMinValues(0).setMaxValues(10))],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'leaderboard') {
          const lbEmbed = buildStaffLeaderboardEmbed(guildId);
          if (!lbEmbed) return interaction.reply({ content: '📭 No reviews have been submitted yet.', flags: MessageFlags.Ephemeral });
          return interaction.reply({ embeds: [lbEmbed], flags: MessageFlags.Ephemeral });
        }
      }

      // ════ COUNTER BUTTONS ════
      if (id.startsWith('cnt_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const cc = getCounterConfig(guildId);
        if (id === 'cnt_toggle') { cc.enabled = !cc.enabled; await saveGuildConfig(guildId); return interaction.update(buildCounterSetupPayload(guildId)); }
        if (id === 'cnt_category') return interaction.reply({ content: '### 📁 Select category', components: [channelDropdown('cntd_category', 'Select category...', [ChannelType.GuildCategory])], flags: MessageFlags.Ephemeral });
        if (id === 'cnt_create_all') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          let created = 0;
          for (const type of Object.keys(cc.channels)) {
            if (!cc.channels[type].enabled) continue;
            if (cc.channels[type].channelId && interaction.guild.channels.cache.get(cc.channels[type].channelId)) continue;
            try { await createCounterChannel(interaction.guild, type, cc); created++; } catch (e) { console.error(`Counter create error [${type}]:`, e); }
          }
          cc.enabled = true; await saveGuildConfig(guildId);
          return interaction.editReply({ content: `✅ Created **${created}** counter channel(s)!` });
        }
        if (id === 'cnt_delete_all') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          for (const type of Object.keys(cc.channels)) { await deleteCounterChannel(interaction.guild, type, cc).catch(() => {}); }
          cc.enabled = false; await saveGuildConfig(guildId);
          return interaction.editReply({ content: '✅ All counter channels deleted.' });
        }
        for (const type of ['members', 'bots', 'online', 'channels', 'roles']) {
          if (id === `cnt_toggle_${type}`) { cc.channels[type].enabled = !cc.channels[type].enabled; await saveGuildConfig(guildId); return interaction.update(buildCounterSetupPayload(guildId)); }
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

      // ════ ANTIPING BUTTONS ════
      if (id.startsWith('ap_') && !id.startsWith('ap_add') && !id.startsWith('ap_edit') && !id.startsWith('ap_remove') && !id.startsWith('ap_review') && !id.startsWith('ap_log_') && !id.startsWith('ap_deploy')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const ap = getAntipingConfig(guildId);
        if (id === 'ap_toggle') { ap.enabled = !ap.enabled; await saveGuildConfig(guildId); return interaction.update(buildAntipingSetupPayload(guildId)); }
        if (id === 'ap_log') return interaction.reply({ content: '### 📋 Select antiping log channel', components: [channelDropdown('apingd_log', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'ap_exempt_roles') return interaction.reply({ content: '### 🔑 Select exempt roles\n*These roles can use @everyone/@here*', components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('apingd_exempt_roles').setPlaceholder('Select exempt roles...').setMinValues(0).setMaxValues(10))], flags: MessageFlags.Ephemeral });
        if (id === 'ap_exempt_channels') return interaction.reply({ content: '### 📢 Select exempt channels\n*@everyone/@here is allowed in these channels*', components: [channelDropdown('apingd_exempt_channels', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'ap_action') {
          const modal = new ModalBuilder().setCustomId('modal_ap_action').setTitle('Antiping Action');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_act').setLabel('delete/warn/delete+warn/delete+mute').setStyle(TextInputStyle.Short).setValue(ap.action || 'delete').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_mute_mins').setLabel('Mute duration (minutes)').setStyle(TextInputStyle.Short).setValue(String(ap.muteMinutes ?? 5)).setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'ap_warn_message') {
          const modal = new ModalBuilder().setCustomId('modal_ap_warn_message').setTitle('Antiping Warn Message');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ap_warn_msg').setLabel('Message (use {user})').setStyle(TextInputStyle.Paragraph).setValue(ap.warnMessage || '').setRequired(false).setMaxLength(500)));
          return interaction.showModal(modal);
        }
      }

      // ════ ROLE PING PROTECTION BUTTONS ════
      if (id.startsWith('rpp__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const rpp = getRolePingProtectionConfig(guildId);
        const action = id.replace('rpp__', '');
        if (action === 'toggle') {
          rpp.enabled = !rpp.enabled;
          await saveGuildConfig(guildId);
          return interaction.update(buildRolePingProtectionSetupPayload(guildId));
        }
        if (action === 'protected_roles') {
          return interaction.reply({
            content: '### 🛡️ Select roles that **cannot** be pinged by regular users\n*(e.g. Founders, Owner, Board)*',
            components: [new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('rppd_protected_roles').setPlaceholder('Select protected roles...').setMinValues(0).setMaxValues(10)
            )],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'allowed_roles') {
          return interaction.reply({
            content: '### ✅ Select roles that **are allowed** to ping protected roles\n*(e.g. HR, Management, SHR)*',
            components: [new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('rppd_allowed_roles').setPlaceholder('Select allowed roles...').setMinValues(0).setMaxValues(10)
            )],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'log') {
          return interaction.reply({
            content: '### 📋 Select log channel',
            components: [channelDropdown('rppd_log', 'Select channel...')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'whitelist_user') {
          return interaction.reply({
            content: '### 👤 Selecteer gebruikers voor de whitelist',
            components: [new ActionRowBuilder().addComponents(
              new UserSelectMenuBuilder().setCustomId('rppd_whitelist_users').setPlaceholder('Selecteer gebruikers...').setMinValues(1).setMaxValues(10)
            )],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (action === 'clear_whitelist') {
          const rppC = getRolePingProtectionConfig(guildId);
          rppC.allowedUsers = [];
          await saveGuildConfig(guildId);
          return interaction.reply({ content: '✅ Whitelist geleegd.', flags: MessageFlags.Ephemeral });
        }
        if (action === 'settings') {
          const modal = new ModalBuilder().setCustomId('modal_rpp_settings').setTitle('Role Ping Protection Settings');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('rpp_action').setLabel('delete/warn/delete+warn/delete+mute').setStyle(TextInputStyle.Short).setValue(rpp.action || 'delete').setRequired(true).setMaxLength(20)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('rpp_mute_mins').setLabel('Mute duration (minutes)').setStyle(TextInputStyle.Short).setValue(String(rpp.muteMinutes ?? 5)).setRequired(false).setMaxLength(4)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('rpp_warn_msg').setLabel('Warn message ({user} {role})').setStyle(TextInputStyle.Paragraph).setValue(rpp.warnMessage || '').setRequired(false).setMaxLength(500)
            ),
          );
          return interaction.showModal(modal);
        }
      }

      // ════ AUTOMOD BUTTONS ════
      if (id.startsWith('am_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const am = getAutomodConfig(guildId);
        if (id === 'am_toggle') { am.enabled = !am.enabled; await saveGuildConfig(guildId); return interaction.update(buildAutomodSetupPayload(guildId)); }
        if (id === 'am_log') return interaction.reply({ content: '### 📋 Automod log channel', components: [channelDropdown('amd_log', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'am_keywords') {
          const modal = new ModalBuilder().setCustomId('modal_am_keywords').setTitle('Edit Automod Keywords');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('am_kw').setLabel('Keywords (comma separated)').setStyle(TextInputStyle.Paragraph).setValue(am.keywords.join(', ')).setPlaceholder('badword1, badword2').setRequired(false)));
          return interaction.showModal(modal);
        }
        if (id === 'am_action') {
          const modal = new ModalBuilder().setCustomId('modal_am_action').setTitle('Automod Action');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('am_act').setLabel('delete/warn/delete+warn/delete+mute').setStyle(TextInputStyle.Short).setValue(am.action || 'delete').setRequired(true)),
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
          return interaction.update({ embeds: [new EmbedBuilder().setTitle('❌ Close Request Denied').setColor(0xED4245).setDescription(`**${userDisplay(interaction.user)}** denied the close request.`).setTimestamp()], components: [] });
        }
        pendingCloseReqs.delete(ch.id);
        const tc = getTicketConfig(guildId);
        if (tc.transcriptChannel) {
          const trCh = interaction.guild.channels.cache.get(tc.transcriptChannel);
          if (trCh) { const msgs = await ch.messages.fetch({ limit: 100 }); const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${userDisplay(m.author)}: ${m.content || '[embed]'}`).join('\n'); await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] }); }
        }
        for (const [uid, cid] of openTickets.entries()) { if (cid === ch.id) { openTickets.delete(uid); break; } }
        await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ Ticket Closed').setColor(0x57F287).setDescription(`Closed by **${userDisplay(interaction.user)}**. Deleting in 3 seconds...`).setTimestamp()], components: [] });
        setTimeout(() => ch.delete().catch(() => {}), 3000);
        return;
      }

      // ════ APPLICATION SETUP BUTTONS ════
      if (id.startsWith('ap_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const ac = getApplicationConfig(guildId);

        if (id === 'ap_review_channel') return interaction.reply({ content: '### 📢 Select global review channel', components: [channelDropdown('apd_review_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'ap_log_channel')    return interaction.reply({ content: '### 📋 Select log channel', components: [channelDropdown('apd_log_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'ap_transcript_channel') return interaction.reply({ content: '### 📝 Select application transcript channel\n*A full transcript (all questions + answers + decision) will be posted here whenever an application is accepted or denied.*', components: [channelDropdown('apd_transcript_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });

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
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_edit_type').setPlaceholder('Select type...').addOptions(ac.appTypes.map(t => ({ label: `${t.emoji || '•'} ${t.label}`, value: String(t.id) })));
          return interaction.reply({ content: '### ✏️ Select type to edit', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_remove_type') {
          if (!ac.appTypes.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_remove_type').setPlaceholder('Select type...').addOptions(ac.appTypes.map(t => ({ label: t.label, value: String(t.id) })));
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
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_edit_panel').setPlaceholder('Select panel...').addOptions(ac.panels.map(p => ({ label: p.name, value: String(p.id) })));
          return interaction.reply({ content: '### ✏️ Select panel to edit', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_remove_panel') {
          if (!ac.panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_remove_panel').setPlaceholder('Select panel...').addOptions(ac.panels.map(p => ({ label: p.name, value: String(p.id) })));
          return interaction.reply({ content: '### 🗑️ Remove panel', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }

        if (id === 'ap_deploy_panel') {
          if (!ac.panels.length) return interaction.reply({ content: '❌ Create a panel first.', flags: MessageFlags.Ephemeral });
          const sel = new StringSelectMenuBuilder().setCustomId('apd_select_deploy_panel').setPlaceholder('Select panel to deploy...').addOptions(ac.panels.map(p => ({ label: p.name, value: String(p.id) })));
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
            const payload = buildApplicationPanelMessage(panel, ac, guildId);
            await ch.send(payload);
            await saveGuildConfig(guildId);
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
        const action = parts[1]; const applicantId = parts[2]; const typeId = parts[3]; const appId = parts[4];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);

        // Permission check: reviewRoles per type, fallback naar hasSetup
        const canReview = appType?.reviewRoles?.length
          ? appType.reviewRoles.some(rId => interaction.member.roles.cache.has(rId)) || hasSetup(interaction.member)
          : hasSetup(interaction.member);
        if (!canReview) return interaction.reply({ content: '❌ You do not have permission to accept or deny applications of this type.', flags: MessageFlags.Ephemeral });
        const applicant = await interaction.guild.members.fetch(applicantId).catch(() => null);

        if (action === 'accept' || action === 'acceptsilent') {
          // Chain of command promotie bij application accept
          const cc = getChainConfig(guildId);
          if (cc.chain.length > 0 && applicant) {
            const result = await promoteInChain(interaction.guild, applicant, interaction.user, guildId);
            if (!result.success) {
              // Chain promotie mislukt — val terug op acceptRoles
              if (appType?.acceptRoles?.length) {
                for (const roleId of appType.acceptRoles) {
                  const role = interaction.guild.roles.cache.get(roleId);
                  if (role) await applicant.roles.add(role).catch(e => console.error('Accept role add error:', e));
                }
              }
            }
          } else {
            // Geen chain — gebruik acceptRoles zoals voorheen
            if (appType?.acceptRoles?.length && applicant) {
              for (const roleId of appType.acceptRoles) {
                const role = interaction.guild.roles.cache.get(roleId);
                if (role) await applicant.roles.add(role).catch(e => console.error('Accept role add error:', e));
              }
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
                { name: '👤 Applicant', value: userDisplay(applicant?.user) ?? applicantId, inline: true },
                { name: '✅ Accepted by', value: userDisplay(interaction.user), inline: true },
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
              .addFields({ name: 'Applicant', value: userDisplay(applicant?.user) ?? applicantId, inline: true }, { name: 'Type', value: appType?.label ?? typeId, inline: true }, { name: 'Accepted by', value: userDisplay(interaction.user), inline: true }, { name: 'DM Sent', value: action === 'accept' ? 'Yes' : 'No', inline: true }).setTimestamp()] });
          }

          // Transcript
          await sendApplicationTranscript(interaction.guild, ac, appId, {
            result: 'accepted',
            moderator: userDisplay(interaction.user),
          });
          return;
        }

        if (action === 'deny') {
          const modal = new ModalBuilder().setCustomId(`modal_app_deny__${applicantId}__${typeId}__${appId}`).setTitle('Deny Application');
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
        if (id === 'sm_edit') { const msgs = Object.entries(sm.messages); if (!msgs.length) return interaction.reply({ content: '❌ No saved messages.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('smd_edit').setPlaceholder('Select message...').addOptions(msgs.map(([mid, m]) => ({ label: m.name, value: String(mid) }))); return interaction.reply({ content: '### ✏️ Edit message', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 'sm_delete') { const msgs = Object.entries(sm.messages); if (!msgs.length) return interaction.reply({ content: '❌ No saved messages.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('smd_delete').setPlaceholder('Select message...').addOptions(msgs.map(([mid, m]) => ({ label: m.name, value: String(mid) }))); return interaction.reply({ content: '### 🗑️ Delete message', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
      }

      // ════ WELCOMER BUTTONS ════
      if (id.startsWith('wc_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const wc = getWelcomerConfig(guildId);
        if (id === 'wc_channel') return interaction.reply({ content: '### 📢 Welcome channel', components: [channelDropdown('wcd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'wc_toggle') { wc.enabled = !wc.enabled; await saveGuildConfig(guildId); return interaction.update(buildWelcomerSetupPayload(guildId)); }
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
        if (id === 'ar_remove') { if (!ar.roles.length) return interaction.reply({ content: '❌ No roles.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('ard_remove').setPlaceholder('Select role...').addOptions(ar.roles.map(id => { const role = interaction.guild.roles.cache.get(id); return { label: role?.name ?? id, value: String(id) }; })); return interaction.reply({ content: '### ➖ Remove autorole', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 'ar_toggle') { ar.enabled = !ar.enabled; await saveGuildConfig(guildId); return interaction.update(buildAutoroleSetupPayload(guildId)); }
      }

      // ════ VERIFICATION BUTTONS ════
      if (id.startsWith('vc_')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const vc = getVerificationConfig(guildId);
        if (id === 'vc_channel') return interaction.reply({ content: '### 📢 Verification channel', components: [channelDropdown('vcd_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        if (id === 'vc_role')    return interaction.reply({ content: '### 🎭 Verified role', components: [roleDropdown('vcd_role', 'Select role...', 1, 1)], flags: MessageFlags.Ephemeral });
        if (id === 'vc_toggle')  { vc.enabled = !vc.enabled; await saveGuildConfig(guildId); return interaction.update(buildVerificationSetupPayload(guildId)); }
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
          await saveGuildConfig(guildId);
          pendingVerifications.delete(interaction.user.id);
          return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Verified!').setColor(0x57F287).addFields(
            { name: '🎮 Roblox Username', value: pending.robloxUsername, inline: true },
            { name: '🆔 Roblox ID', value: `${pending.robloxId}`, inline: true },
            { name: '📛 Nickname', value: `\`${nickname}\``, inline: false },
          ).setDescription('You can now remove the code from your profile description.').setTimestamp()] });
        } catch (e) { return interaction.editReply({ content: `❌ Could not check your profile. Try again later.` }); }
      }

      if (id.startsWith('rating__')) {
        const parts      = id.split('__');
        const stars      = parseInt(parts[1], 10);
        const userId     = parts[2];
        const ratingGId  = parts[3];
        const ticketName = parts.slice(4).join('__');

        // Disable alle knoppen zodat je maar 1x kunt raten
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rating__1__done`).setLabel('⭐').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(`rating__2__done`).setLabel('⭐⭐').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(`rating__3__done`).setLabel('⭐⭐⭐').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(`rating__4__done`).setLabel('⭐⭐⭐⭐').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(`rating__5__done`).setLabel('⭐⭐⭐⭐⭐').setStyle(ButtonStyle.Success).setDisabled(true),
        );

        // Vraag om een reden via modal
        const modal = new ModalBuilder()
          .setCustomId(`modal_rating__${stars}__${userId}__${ratingGId}__${ticketName}`)
          .setTitle(`Rate your experience — ${'⭐'.repeat(stars)}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('rating_reason')
              .setLabel('Tell us about your experience (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(500)
              .setPlaceholder('The support was fast and helpful...')
          )
        );
        await interaction.message.edit({ components: [disabledRow] }).catch(() => {});
        return interaction.showModal(modal);
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
          const sel = new StringSelectMenuBuilder().setCustomId('td_select_type_roles').setPlaceholder('Select type to configure roles...').addOptions(tc.ticketTypes.map(t => ({ label: t.label, value: String(t.id) })));
          return interaction.reply({ content: '### 🔑 Select ticket type to configure roles', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral });
        }
        if (id === 't_remove_type') { const tc = getTicketConfig(guildId); if (!tc.ticketTypes.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); const sel = new StringSelectMenuBuilder().setCustomId('td_remove_type').setPlaceholder('Select type...').addOptions(tc.ticketTypes.map(t => ({ label: t.label, value: String(t.id) }))); return interaction.reply({ content: '### ➖ Remove ticket type', components: [new ActionRowBuilder().addComponents(sel)], flags: MessageFlags.Ephemeral }); }
        if (id === 't_rating') {
          const rc = getTicketRatingConfig(guildId);
          const modal = new ModalBuilder().setCustomId('modal_t_rating').setTitle('Rating System Settings');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('rating_enabled').setLabel('Enable rating system? (yes / no)').setStyle(TextInputStyle.Short).setValue(rc.enabled ? 'yes' : 'no').setRequired(true).setMaxLength(3)
            ),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_rating_channel') {
          return interaction.reply({ content: '### 📋 Select staff rating log channel', components: [channelDropdown('td_rating_channel', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (id === 't_rating_public') {
          return interaction.reply({ content: '### 📢 Select public reviews channel\nEveryone can see ratings here.', components: [channelDropdown('td_rating_public', 'Select channel...')], flags: MessageFlags.Ephemeral });
        }
        if (id === 't_precheck') {
          const pc = getTicketPreCheckConfig(guildId);
          // Garanteer alle waarden zijn strings van correcte lengte
          const pcEnabled  = pc.enabled ? 'yes' : 'no';
          const pcRules    = String(pc.rulesText ?? '').slice(0, 1000);
          const pcMinAmt   = String(pc.minimumAmount ?? 0);
          const pcLabel    = String(pc.amountLabel ?? 'Amount').slice(0, 40);
          const pcDenial   = String(pc.amountDenialMessage ?? '').slice(0, 800);
          const modal = new ModalBuilder().setCustomId('modal_t_precheck').setTitle('Pre-Check');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_enabled').setLabel('Enabled? (yes / no)').setStyle(TextInputStyle.Short).setValue(pcEnabled).setRequired(true).setMaxLength(3)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_rules').setLabel('Rules text').setStyle(TextInputStyle.Paragraph).setValue(pcRules).setRequired(false).setMaxLength(1000)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_min_amount').setLabel('Min. amount (0 = off)').setStyle(TextInputStyle.Short).setValue(pcMinAmt).setRequired(false).setMaxLength(10)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_amount_label').setLabel('Amount label (e.g. Robux)').setStyle(TextInputStyle.Short).setValue(pcLabel).setRequired(false).setMaxLength(40)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('pc_denial_msg').setLabel('Denial message').setStyle(TextInputStyle.Paragraph).setValue(pcDenial).setRequired(false).setMaxLength(800)
            ),
          );
          return interaction.showModal(modal);
        }
        if (id === 't_deploy') {
          const tc = getTicketConfig(guildId);
          if (!tc.ticketChannel || !tc.ticketTypes.length) return interaction.reply({ content: '❌ Set channel and add types first.', flags: MessageFlags.Ephemeral });
          const ch = interaction.guild.channels.cache.get(tc.ticketChannel);
          if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await ch.send({ embeds: [buildTicketPanelEmbed(tc)], components: buildTicketTypeButtons(tc.ticketTypes) });
          await saveGuildConfig(guildId);
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
        if (id === 'an_edit')   { const types = Object.entries(ac.types); if (!types.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### ✏️ Select type', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('an_sel_edit').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: String(tid) }))))], flags: MessageFlags.Ephemeral }); }
        if (id === 'an_delete') { const types = Object.entries(ac.types); if (!types.length) return interaction.reply({ content: '❌ No types.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### 🗑️ Select type', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('an_sel_delete').setPlaceholder('Select type...').addOptions(types.map(([tid, t]) => ({ label: `${t.emoji || '📢'} ${t.name}`, value: String(tid) }))))], flags: MessageFlags.Ephemeral }); }
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
          if (action === 'clearping') { t.pingRole = null; await saveGuildConfig(guildId); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }
        }
      }

      // ════ SELF ROLE SETUP BUTTONS ════
      if (id.startsWith('sr_') || id.startsWith('sre__') || id === 'sr__back') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
        const src = getSelfRoleConfig(guildId);
        if (id === 'sr__back') return interaction.update(buildSelfRoleOverview(guildId));
        if (id === 'sr_new') {
          const modal = new ModalBuilder().setCustomId('modal_sr_new').setTitle('Create Self Role Panel');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_color').setLabel('Color hex').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_type').setLabel('Type: dropdown / buttons (dropdown recommended)').setStyle(TextInputStyle.Short).setValue('dropdown').setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr_max').setLabel('Max roles per user (0 = unlimited)').setStyle(TextInputStyle.Short).setValue('0').setRequired(false)),
          );
          return interaction.showModal(modal);
        }
        if (id === 'sr_edit')   { const panels = Object.entries(src.panels); if (!panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### ✏️ Select panel', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sr_sel_edit').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: String(pid) }))))], flags: MessageFlags.Ephemeral }); }
        if (id === 'sr_delete') { const panels = Object.entries(src.panels); if (!panels.length) return interaction.reply({ content: '❌ No panels.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: '### 🗑️ Select panel', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sr_sel_delete').setPlaceholder('Select panel...').addOptions(panels.map(([pid, p]) => ({ label: p.title, value: String(pid) }))))], flags: MessageFlags.Ephemeral }); }
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
          if (action === 'removerole') { if (!panel.roles.length) return interaction.reply({ content: '❌ No roles.', flags: MessageFlags.Ephemeral }); return interaction.reply({ content: `### ➖ Remove role`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sr_sel_rmrole__${panelId}`).setPlaceholder('Select role...').addOptions(panel.roles.map(r => ({ label: r.label, value: String(r.id) }))))], flags: MessageFlags.Ephemeral }); }
          if (action === 'deploy') {
            if (!panel.channel || !panel.roles.length) return interaction.reply({ content: '❌ Set channel and add roles first.', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await deploySelfRolePanel(interaction.guild, panelId, panel);
            await saveGuildConfig(guildId);
            return interaction.editReply({ content: `✅ **${panel.title}** deployed!` });
          }
        }
      }

      // ════ TICKET OPEN — with pre-check flow ════
      if (id.startsWith('tkt__open__')) {
        const typeId = id.replace('tkt__open__', '');
        const tc = getTicketConfig(guildId);
        const pc = getTicketPreCheckConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Ticket type not found.', flags: MessageFlags.Ephemeral });

        // Required roles check
        if (type.requiredRoles?.length && !type.requiredRoles.some(r => interaction.member.roles.cache.has(r)) && !hasSetup(interaction.member)) {
          return interaction.reply({ content: `❌ You need one of the following roles to open this ticket: ${type.requiredRoles.map(r => `<@&${r}>`).join(', ')}`, flags: MessageFlags.Ephemeral });
        }

        // Minimum rank check
        if (type.minimumStaffRank && type.minimumStaffRank > 0) {
          if (!meetsMinimumRank(interaction.member, guildId, type.minimumStaffRank)) {
            return interaction.reply({ content: `❌ You need a staff rank higher than **level ${type.minimumStaffRank}** to open this ticket type.`, flags: MessageFlags.Ephemeral });
          }
        }

        // Duplicate ticket check — ook V2 records checken
        if (openTickets.has(interaction.user.id)) {
          const existingId = openTickets.get(interaction.user.id);
          const existing = interaction.guild.channels.cache.get(existingId);
          if (existing) return interaction.reply({ content: `❌ You already have an open ticket: <#${existing.id}>`, flags: MessageFlags.Ephemeral });
          openTickets.delete(interaction.user.id);
        }
        // Extra V2 check — scan open tickets in DB
        const v2check = getTicketV2Config(guildId);
        const existingV2 = Object.entries(v2check.openTickets ?? {}).find(([chId, rec]) =>
          rec.userId === interaction.user.id && rec.status === 'open' && interaction.guild.channels.cache.has(chId)
        );
        if (existingV2) {
          return interaction.reply({ content: `❌ You already have an open ticket: <#${existingV2[0]}>`, flags: MessageFlags.Ephemeral });
        }
        // Ruim oude intake data op bij elke nieuwe poging
        ticketIntakeData.delete(interaction.user.id);

        // Per-type cooldown check
        if (type.cooldownMinutes) {
          const cdKey = `${guildId}:${interaction.user.id}:${typeId}`;
          const lastUsed = ticketCooldowns.get(cdKey);
          if (lastUsed) {
            const remaining = type.cooldownMinutes * 60000 - (Date.now() - lastUsed);
            if (remaining > 0) {
              const mins = Math.ceil(remaining / 60000);
              return interaction.reply({ content: `⏳ You can open another **${type.label}** ticket in **${mins}** minute${mins !== 1 ? 's' : ''}.`, flags: MessageFlags.Ephemeral });
            }
          }
        }

        // Per-type max open tickets check
        if (type.maxOpen) {
          const openCount = interaction.guild.channels.cache.filter(ch =>
            ch.topic?.includes(`| ${type.label}`) && ch.name.includes('ticket-')
          ).size;
          if (openCount >= type.maxOpen) {
            return interaction.reply({ content: `❌ The maximum number of **${type.label}** tickets (**${type.maxOpen}**) is currently open. Please wait for one to close.`, flags: MessageFlags.Ephemeral });
          }
        }

       // ── Intake form (shown before rules) ──
        if (Array.isArray(type.intakeFields) && type.intakeFields.length > 0) {
          const intakeModal = new ModalBuilder()
            .setCustomId(`modal_intake_submit__${typeId}`)
            .setTitle(`📋 ${String(type.label).slice(0, 40)}`);
          for (const field of type.intakeFields.slice(0, 4)) {
            const input = new TextInputBuilder()
              .setCustomId(`intake_${field.id}`)
              .setLabel(String(field.label).slice(0, 45))
              .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
              .setRequired(field.required ?? true)
              .setMaxLength(field.style === 'paragraph' ? 1000 : 200);
            if (field.placeholder) input.setPlaceholder(String(field.placeholder).slice(0, 100));
            intakeModal.addComponents(new ActionRowBuilder().addComponents(input));
          }
          return interaction.showModal(intakeModal);
        }

        // ── Per-type pre-check (fallback to global) ──
        const resolvedPreCheckEnabled = resolveTicketSetting(type, tc, pc, 'preCheck.enabled');
        const resolvedRulesText       = resolveTicketSetting(type, tc, pc, 'preCheck.rulesText');

        if (resolvedPreCheckEnabled === true) {
          ticketRulesPending.set(interaction.user.id, { typeId, guildId, messageId: null });
          const rulesEmbed = new EmbedBuilder()
            .setTitle('📋 Ticket Rules')
            .setDescription(resolvedRulesText)
            .setColor(0x5865F2)
            .setFooter({ text: 'You must accept the rules to open a ticket.' });
          const rulesRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`tkt__rules_accept__${typeId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tkt__rules_decline').setLabel('❌ Decline').setStyle(ButtonStyle.Danger),
          );
          return interaction.reply({ embeds: [rulesEmbed], components: [rulesRow], flags: MessageFlags.Ephemeral });
        }

        // No pre-check — create ticket directly
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await createTicketChannel(interaction, type, tc, pc, guildId, false);
        } catch (e) {
          console.error('createTicketChannel (direct) error:', e);
          ticketIntakeData.delete(interaction.user.id);
          await interaction.editReply({ content: `❌ Could not create ticket: ${e.message}` }).catch(() => {});
        }
        return;
      }

      // ════ TICKET RULES — Accept ════
      if (id.startsWith('tkt__rules_accept__')) {
        const typeId = id.replace('tkt__rules_accept__', '');
        const pending = ticketRulesPending.get(interaction.user.id);
        if (!pending || pending.typeId !== typeId) {
          return interaction.reply({ content: '❌ Session expired. Please click the ticket button again.', flags: MessageFlags.Ephemeral });
        }
        const savedIntakeAnswers = Array.isArray(pending.intakeAnswers) ? pending.intakeAnswers : null;
        ticketRulesPending.delete(interaction.user.id);

        const tc = getTicketConfig(guildId);
        const pc = getTicketPreCheckConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.update({ content: '❌ Ticket type no longer exists.', embeds: [], components: [] });

        // ── Minimum amount check (per-type or global) ──
        const resolvedMinAmount    = resolveTicketSetting(type, tc, pc, 'preCheck.minimumAmount');
        const resolvedAmountLabel  = resolveTicketSetting(type, tc, pc, 'preCheck.amountLabel');
        const resolvedDenialMsg    = resolveTicketSetting(type, tc, pc, 'preCheck.amountDenialMessage');

        if (resolvedMinAmount > 0) {
          try {
            const vc = getVerificationConfig(guildId);
            const userData = (vc.verifiedUsers ?? {})[interaction.user.id];
            const userAmount = userData?.serviceAmount ?? 0;

            console.log(`[PRECHECK] minAmount=${resolvedMinAmount} userAmount=${userAmount} userId=${interaction.user.id}`);

            if (userAmount < resolvedMinAmount) {
              const denialText = (resolvedDenialMsg || 'You do not meet the minimum {amountLabel} requirement ({required} required, you have {current}).')
                .replace(/{amountLabel}/g, resolvedAmountLabel)
                .replace(/{required}/g, `${resolvedMinAmount}`)
                .replace(/{current}/g, `${userAmount}`);

              await safeDM(interaction.user, {
                embeds: [new EmbedBuilder()
                  .setTitle('❌ Ticket Denied')
                  .setColor(0xED4245)
                  .setDescription(denialText)
                  .addFields(
                    { name: `📊 Your ${resolvedAmountLabel}`, value: `${userAmount}`, inline: true },
                    { name: '✅ Required', value: `${resolvedMinAmount}`, inline: true },
                  )
                  .setFooter({ text: interaction.guild.name })
                  .setTimestamp()
                ],
              });

              return interaction.update({
                embeds: [new EmbedBuilder().setTitle('❌ Ticket Denied').setColor(0xED4245).setDescription(`You do not meet the requirements. Check your DMs for details.`).setTimestamp()],
                components: [],
              });
            }
          } catch (minCheckErr) {
            console.error('[PRECHECK] minAmount check error:', minCheckErr);
          }
        }

        // Sla intake antwoorden op in aparte map zodat createTicketChannel ze kan ophalen
        if (savedIntakeAnswers) {
          ticketIntakeData.set(interaction.user.id, savedIntakeAnswers);
        }

        // Passed all checks — update message then create ticket via followUp
        await interaction.update({ embeds: [new EmbedBuilder().setTitle('⏳ Creating ticket...').setColor(0x5865F2)], components: [] });
        try {
          await createTicketChannel(interaction, type, tc, pc, guildId, true);
        } catch (e) {
          console.error('createTicketChannel (precheck) error:', e);
          await interaction.followUp({ content: `❌ Could not create ticket: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }

      // ════ TICKET RULES — Decline ════
      if (id === 'tkt__rules_decline') {
        ticketRulesPending.delete(interaction.user.id);
        ticketIntakeData.delete(interaction.user.id);
        return interaction.update({
          embeds: [new EmbedBuilder().setTitle('❌ Ticket Cancelled').setColor(0xED4245).setDescription('You declined the rules. No ticket was created.').setTimestamp()],
          components: [],
        });
      }

      // ════ TICKET CLOSE BUTTON ════
      if (id === 'tkt__claim') {
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        // Log claim to DB
        await updateTicketRecord(interaction.channel.id, { claimedBy: interaction.user.id }).catch(() => {});
        await logTicketAction(interaction.guild, guildId, 'claimed', { channel: `<#${interaction.channel.id}>`, staff: userDisplay(interaction.user) });
        // Update channel name met claimer
        const embed = interaction.message.embeds[0];
        const alreadyClaimed = embed?.description?.includes('**Claimed by**');
        if (alreadyClaimed) return interaction.reply({ content: '❌ This ticket is already claimed.', flags: MessageFlags.Ephemeral });
        // Update embed met claimer info
        const updatedEmbed = embed
          ? EmbedBuilder.from(embed).setDescription(`${embed.description || ''}\n\n**Claimed by:** ${userDisplay(interaction.user)} (<@${interaction.user.id}>)`)
          : new EmbedBuilder().setDescription(`**Claimed by:** ${userDisplay(interaction.user)} (<@${interaction.user.id}>)`);
        // Disable claim knop, houd close knop
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tkt__claim').setLabel(`Claimed by ${interaction.user.username}`).setStyle(ButtonStyle.Primary).setEmoji('🙋').setDisabled(true),
          new ButtonBuilder().setCustomId('tkt__close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        );
        await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] });
        await interaction.reply({ content: `✅ You have claimed this ticket!` });
        return;
      }

      if (id === 'tkt__close') {
        const record = await getTicketRecord(interaction.channel.id);
        // Hard guard: only proceed if this channel is actually a tracked open ticket
        if (!record || record.status === 'closed') {
          return interaction.reply({ content: '❌ This channel is not an open ticket.', flags: MessageFlags.Ephemeral });
        }
        const isCreator = record.creatorId === interaction.user.id;
        if (!hasAnyStaff(interaction.member) && !isFoundership(interaction.member) && !isCreator) {
          return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const ch = interaction.channel;
        const tc = getTicketConfig(guildId);
        const pc = getTicketPreCheckConfig(guildId);

        // Find which ticket type this channel belongs to (by topic or name match)
        const topic = ch.topic ?? '';
        const matchedType = tc.ticketTypes.find(t =>
          topic.includes(t.label) || ch.name.includes(t.label.toLowerCase().replace(/\s+/g, '-'))
        ) ?? null;

        const resolvedTranscript = matchedType
          ? resolveTicketSetting(matchedType, tc, pc, 'transcriptChannel')
          : (tc.transcriptChannel ?? null);
        const resolvedCloseMsg = matchedType
          ? resolveTicketSetting(matchedType, tc, pc, 'closeMessage')
          : '🔒 Closing in 3 seconds...';
        // Per-type log channel for close events
        const resolvedLogChannel = matchedType?.logChannel ?? null;

        if (resolvedTranscript) {
          const trCh = interaction.guild.channels.cache.get(resolvedTranscript);
          if (trCh) {
            const msgs = await ch.messages.fetch({ limit: 100 });
            const text = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
              .map(m => `[${new Date(m.createdTimestamp).toUTCString()}] ${userDisplay(m.author)}: ${m.content || '[embed]'}`).join('\n');
            await trCh.send({ embeds: [new EmbedBuilder().setTitle(`📋 Transcript: ${ch.name}`).setDescription(`\`\`\`\n${text.slice(0, 3990) || 'No messages.'}\n\`\`\``).setColor(0x5865F2).setTimestamp()] });
          }
        }
        // Zoek de ticket opener op voor rating DM
        let ticketOpenerId = null;
        for (const [uid, cid] of openTickets.entries()) {
          if (cid === ch.id) { ticketOpenerId = uid; openTickets.delete(uid); break; }
        }
        pendingCloseReqs.delete(ch.id);

        // Stuur rating DM naar ticket opener
        const rc = getTicketRatingConfig(guildId);
        if (rc.enabled && ticketOpenerId) {
          try {
            const ticketOpener = await client.users.fetch(ticketOpenerId).catch(() => null);
            if (ticketOpener) {
              const ratingEmbed = new EmbedBuilder()
                .setTitle('⭐ Rate your support experience')
                .setColor(0x5865F2)
                .setDescription(`Your ticket **${ch.name}** in **${interaction.guild.name}** has been closed.\n\nHow would you rate your experience? Click a star below!`)
                .setFooter({ text: 'Your feedback helps us improve!' })
                .setTimestamp();
              // Beperk ticket naam tot 30 tekens zodat customId onder 100 blijft
              const safeTicketName = ch.name.slice(0, 30);
              const ratingRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`rating__1__${ticketOpenerId}__${guildId}__${safeTicketName}`).setLabel('⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`rating__2__${ticketOpenerId}__${guildId}__${safeTicketName}`).setLabel('⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`rating__3__${ticketOpenerId}__${guildId}__${safeTicketName}`).setLabel('⭐⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`rating__4__${ticketOpenerId}__${guildId}__${safeTicketName}`).setLabel('⭐⭐⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`rating__5__${ticketOpenerId}__${guildId}__${safeTicketName}`).setLabel('⭐⭐⭐⭐⭐').setStyle(ButtonStyle.Success),
              );
              await safeDM(ticketOpener, { embeds: [ratingEmbed], components: [ratingRow] });
            }
          } catch (ratingErr) {
            console.error('Rating DM error:', ratingErr);
          }
        }

        // Per-type log channel
        if (resolvedLogChannel) {
          const logCh = interaction.guild.channels.cache.get(resolvedLogChannel);
          if (logCh) {
            await logCh.send({ embeds: [new EmbedBuilder()
              .setTitle('🔒 Ticket Closed')
              .setColor(0xED4245)
              .addFields(
                { name: '📋 Channel', value: ch.name, inline: true },
                { name: '👮 Closed By', value: userDisplay(interaction.user), inline: true },
                { name: '🎫 Type', value: matchedType?.label ?? 'Unknown', inline: true },
              )
              .setTimestamp()
            ] }).catch(() => {});
          }
        }

        // Update DB record
        await updateTicketRecord(ch.id, { status: 'closed', closedAt: new Date() });

        // Log close action
        await logTicketAction(interaction.guild, guildId, 'closed', {
          channel: ch.name,
          staff: userDisplay(interaction.user),
          type: record?.typeLabel ?? 'Unknown',
          logChannel: resolvedLogChannel,
        });

        await interaction.editReply({ content: resolvedCloseMsg });
        setTimeout(async () => {
          try {
            const freshCh = interaction.guild?.channels.cache.get(ch.id);
            if (freshCh) await freshCh.delete();
          } catch {}
        }, 3000);
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

      // ════ GIVEROLES SELECT ════
      if (interaction.customId.startsWith('giveroles__')) {
        const targetUserId = interaction.customId.replace('giveroles__', '');
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });
        const rp = getRolePermConfig(guildId);
        const added = [], denied = [];
        for (const roleId of ids) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (!role) continue;
          const perms = rp[roleId];
          const canAdd = perms?.addRoles?.length
            ? perms.addRoles.some(r => interaction.member.roles.cache.has(r)) || hasSetup(interaction.member)
            : hasSetup(interaction.member);
          if (!canAdd) { denied.push(role.name); continue; }
          await targetMember.roles.add(role).catch(() => {});
          added.push(role.name);
        }
        let msg = '';
        if (added.length)  msg += `✅ Added: **${added.join(', ')}**\n`;
        if (denied.length) msg += `❌ No permission: **${denied.join(', ')}**`;
        return interaction.reply({ content: msg.trim() || '⚠️ Nothing changed.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('staffrank_role__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const rankId = interaction.customId.replace('staffrank_role__', '');
        const src = getStaffRankConfig(guildId);
        const rank = src.ranks.find(r => r.id === rankId);
        if (!rank) return interaction.reply({ content: '❌ Rank not found.', flags: MessageFlags.Ephemeral });
        rank.roleId = interaction.values[0] ?? null;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: rank.roleId ? `✅ Role <@&${rank.roleId}> linked to **${rank.name}**!` : `✅ No role linked to **${rank.name}**.`, flags: MessageFlags.Ephemeral });
      }

      // ════ CHAIN OF COMMAND ROLE ADD ════
      if (interaction.customId === 'coc_add_role') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cc = getChainConfig(guildId);
        const roleId = ids[0];
        if (cc.chain.some(e => e.roleId === roleId)) {
          return interaction.reply({ content: '❌ This role is already in the chain.', flags: MessageFlags.Ephemeral });
        }
        // Voeg toe aan het einde van de chain
        const maxPosition = cc.chain.length ? Math.max(...cc.chain.map(e => e.position)) : 0;
        cc.chain.push({ roleId, position: maxPosition + 1 });
        cc.chain.sort((a, b) => a.position - b.position);
        await saveGuildConfig(guildId);
        const role = interaction.guild.roles.cache.get(roleId);
        return interaction.reply({
          content: `✅ **${role?.name ?? roleId}** added to the chain at position **${maxPosition + 1}**!\n\nUse **Move Up/Down** to reorder.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ════ STAFF REVIEW STAFF ROLES ════
      if (interaction.customId === 'sr2d_staff_roles') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        getStaffReviewConfig(guildId).staffRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: ids.length ? `✅ Staff roles set: ${ids.map(r => `<@&${r}>`).join(', ')}` : '✅ Cleared — anyone can be reviewed.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'foundership_save_roles') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const fc = getFoundershipConfig(guildId);
        fc.roles = interaction.values;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Foundership roles set: ${interaction.values.length ? interaction.values.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'qotd_pingrole') {
        const qc = getQOTDConfig(guildId);
        qc.pingRole = interaction.values[0] ?? null;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ QOTD ping role set to <@&${interaction.values[0]}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'load_role') {
        const lc = getLOAConfig(guildId);
        lc.loaRole = ids[0];
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ LOA role set to <@&${ids[0]}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'load_approval_roles') {
        const lc = getLOAConfig(guildId);
        lc.approvalRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Approval roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      // Infraction level role — allowed everywhere, handle before main server check
      if (interaction.customId.startsWith('inf_level_role__')) {
        const ic = getInfractionConfig(guildId);
        const index = parseInt(interaction.customId.replace('inf_level_role__', ''), 10);
        const progEntry = INFRACTION_PROGRESSION[index];
        if (!isNaN(index) && progEntry) {
          if (!ic.hierarchy[index]) ic.hierarchy[index] = { roleId: null };
          ic.hierarchy[index].roleId = interaction.values[0] ?? null;
          await saveGuildConfig(guildId);
          return interaction.reply({
            content: interaction.values[0]
              ? `✅ Role <@&${interaction.values[0]}> set for **${progEntry.label}** (Level ${index + 1})!`
              : `✅ No role set for **${progEntry.label}** — this infraction will be recorded without giving a role.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({ content: '❌ Level not found.', flags: MessageFlags.Ephemeral });
      }

      // Dept setup role selects — allowed on non-main servers too
      if (interaction.customId.startsWith('perms_save__')) {
        const level = interaction.customId.replace('perms_save__', '');
        const pc = getPermissionsConfig(guildId);
        const keyMap = { admin: 'adminRoles', mod: 'modRoles', staff: 'staffRoles', shr: 'shrRoles' };
        const key = keyMap[level];
        if (!key) return interaction.reply({ content: '❌ Unknown level.', flags: MessageFlags.Ephemeral });
        pc[key] = interaction.values;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ **${level.toUpperCase()}** roles updated: ${interaction.values.length ? interaction.values.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      // All other role selects: main server only (department servers can still set overrides)
      if (!isMainServer(guildId) && !interaction.customId.startsWith('td_ping_roles') && !interaction.customId.startsWith('sd_ping_roles') && !interaction.customId.startsWith('sd_allowed_roles') && !interaction.customId.startsWith('load_role') && !interaction.customId.startsWith('load_approval_roles') && !interaction.customId.startsWith('ard_add') && !interaction.customId.startsWith('tr_setup_trainer_roles') && !interaction.customId.startsWith('vcd_role')) {
        return interaction.reply({ content: '❌ Role configuration can only be done on the main server.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'ard_add')          { const ar = getAutoroleConfig(guildId); for (const id of ids) { if (!ar.roles.includes(id)) ar.roles.push(id); } await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Autoroles added.`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_ping_roles')     { getTicketConfig(guildId).pingRoles = ids; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Ticket ping roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_ping_roles')     { getSessionConfig(guildId).pingRoles = ids; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Session ping roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_allowed_roles')  { getSessionConfig(guildId).allowedRoles = ids; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Allowed roles set.', flags: MessageFlags.Ephemeral }); }
      if (interaction.customId.startsWith('anpr__'))    { const typeId = interaction.customId.replace('anpr__', ''); getAnnouncementConfig(guildId).types[typeId].pingRole = ids[0]; await saveGuildConfig(guildId); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }

      // Application type accept roles
      if (interaction.customId.startsWith('apte_review_roles__')) {
        const typeId = interaction.customId.replace('apte_review_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.reviewRoles = ids;
        await saveGuildConfig(guildId);
        const roleNames = ids.length ? ids.map(id => interaction.guild.roles.cache.get(id)?.name ?? id).join(', ') : 'None (everyone with setup)';
        return interaction.reply({ content: `✅ Review roles for **${appType.label}** set to: **${roleNames}**`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('apte_roles__')) {
        const typeId = interaction.customId.replace('apte_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.acceptRoles = ids; // Could be empty array if none selected
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
        await updateCommandListEmbed(interaction.guild);
        return interaction.reply({ content: `✅ Role permissions saved for <@&${roleId}>!`, flags: MessageFlags.Ephemeral });
      }

      // ════ REQUEST SETUP ROLE SELECTS ════
      if (interaction.customId.startsWith('reqsetup_roles__')) {
        const type = interaction.customId.replace('reqsetup_roles__', '');
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        cfg.approvalRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Approval roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('hb_book_roles__')) {
        const parts = interaction.customId.replace('hb_book_roles__', '').split('__');
        const panelId = parts[0], bookId = parts[1];
        const hc = getHandbookConfig(guildId);
        const book = hc.panels[panelId]?.books?.find(b => b.id === bookId);
        if (!book) return interaction.reply({ content: '❌ Book not found.', flags: MessageFlags.Ephemeral });
        book.requiredRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Roles set for **${book.label}**: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_type_ping_roles__')) {
        const typeId = interaction.customId.replace('tkt_type_ping_roles__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.pingRoles = ids.length ? ids : null; // null = use global
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Ping roles for **${type.label}**: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Reset to global*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_view_roles__')) {
        const typeId = interaction.customId.replace('tkt_view_roles__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.viewRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ View roles for **${type.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_required_roles__')) {
        const typeId = interaction.customId.replace('tkt_required_roles__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.requiredRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Required roles for **${type.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('apte_required_roles__')) {
        const typeId = interaction.customId.replace('apte_required_roles__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.requiredRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Required roles for **${appType.label}** set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING ROLE SELECTS ════
      if (interaction.customId === 'tr_setup_trainer_roles') {
        const tc = getTrainingConfig(guildId);
        tc.trainerRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Trainer roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_request_roles') {
        const tc = getTrainingConfig(guildId);
        tc.requestRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Request roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*Everyone*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'tr_setup_ping_roles') {
        const tc = getTrainingConfig(guildId);
        tc.pingRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Ping roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId.startsWith('dept_set_role__')) {
        const deptId = interaction.customId.replace('dept_set_role__', '');
        const dc = getDepartmentsConfig(guildId);
        const dept = dc.list.find(d => d.id === deptId);
        if (!dept) return interaction.reply({ content: '❌ Department not found.', flags: MessageFlags.Ephemeral });
        dept.role = ids[0];
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Role for **${dept.name}** set to <@&${ids[0]}>.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId.startsWith('dept_set_lead__')) {
        const deptId = interaction.customId.replace('dept_set_lead__', '');
        const dc = getDepartmentsConfig(guildId);
        const dept = dc.list.find(d => d.id === deptId);
        if (!dept) return interaction.reply({ content: '❌ Department not found.', flags: MessageFlags.Ephemeral });
        dept.leadRole = ids[0];
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Lead role for **${dept.name}** set to <@&${ids[0]}>.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'apingd_exempt_roles') {
        const ap = getAntipingConfig(guildId);
        ap.exemptRoles = interaction.values;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Exempt roles: ${interaction.values.length ? interaction.values.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'rppd_whitelist_users') {
        const rppW = getRolePingProtectionConfig(guildId);
        if (!rppW.allowedUsers) rppW.allowedUsers = [];
        for (const uid of interaction.values) {
          if (!rppW.allowedUsers.includes(uid)) rppW.allowedUsers.push(uid);
        }
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ ${interaction.values.map(u => `<@${u}>`).join(', ')} toegevoegd!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'rppd_protected_roles') {
        const rpp = getRolePingProtectionConfig(guildId);
        rpp.protectedRoles = interaction.values;
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: interaction.values.length
            ? `✅ Protected roles set: ${interaction.values.map(r => `<@&${r}>`).join(', ')}\n\nNow these roles cannot be pinged by regular users.`
            : '✅ Protected roles cleared.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.customId === 'rppd_allowed_roles') {
        const rpp = getRolePingProtectionConfig(guildId);
        rpp.allowedRoles = interaction.values;
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: interaction.values.length
            ? `✅ Allowed roles set: ${interaction.values.map(r => `<@&${r}>`).join(', ')}\n\nThese roles (+ admins/foundership) can ping protected roles.`
            : '✅ Allowed roles cleared. Only admins/foundership can now ping protected roles.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.customId === 'vote_setup_announce_roles') {
        const gac = getGlobalAnnouncementConfig(guildId);
        gac.announcementPingRoles = ids;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Announce ping roles set to: ${ids.length ? ids.map(r => `<@&${r}>`).join(', ') : '*None*'}`, flags: MessageFlags.Ephemeral });
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
      if (interaction.customId === 'ticketv2_log_channel')        { const v2 = getTicketV2Config(guildId); v2.logChannel        = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Ticket log channel: <#${chId}>`,  flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'ticketv2_transcript_channel') { const v2 = getTicketV2Config(guildId); v2.transcriptChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Transcript channel: <#${chId}>`,  flags: MessageFlags.Ephemeral }); }
      if (interaction.customId.startsWith('ticketv2type_cat__'))  { const typeId = interaction.customId.replace('ticketv2type_cat__', ''); const v2 = getTicketV2Config(guildId); const t = v2.types?.find(t => t.id === typeId); if (!t) return interaction.reply({ content: '❌ Type config not found.', flags: MessageFlags.Ephemeral }); t.categoryId = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Category set to <#${chId}> for **${t.ticketTypeName}**!`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'coc_log_channel')     { getChainConfig(guildId).logChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Chain log channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sr2d_channel')        { getStaffReviewConfig(guildId).channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Staff review channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'wcd_channel')         { getWelcomerConfig(guildId).channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Welcome channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'vcd_channel')         { getVerificationConfig(guildId).channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Verification channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_transcript')       { getTicketConfig(guildId).transcriptChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Transcript: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_rating_channel')  { getTicketRatingConfig(guildId).logChannel    = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Staff rating log channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'qotd_channel')       { getQOTDConfig(guildId).channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ QOTD channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_rating_public')   { getTicketRatingConfig(guildId).publicChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Public reviews channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_channel')          { getTicketConfig(guildId).ticketChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Panel channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'td_category')         { getTicketConfig(guildId).ticketCategory = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Category: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'sd_channel')          { getSessionConfig(guildId).channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Session channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'apd_review_channel')  { getApplicationConfig(guildId).reviewChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Global review channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'apd_log_channel')     { getApplicationConfig(guildId).logChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Log channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'apd_transcript_channel') { getApplicationConfig(guildId).transcriptChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Application transcript channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'amd_log')             { getAutomodConfig(guildId).logChannel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Automod log: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId.startsWith('anch__'))      { const typeId = interaction.customId.replace('anch__', ''); getAnnouncementConfig(guildId).types[typeId].channel = chId; await saveGuildConfig(guildId); return interaction.update(buildAnnouncementEditor(guildId, typeId)); }
      if (interaction.customId.startsWith('srch__'))      { const panelId = interaction.customId.replace('srch__', ''); getSelfRoleConfig(guildId).panels[panelId].channel = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Channel: <#${chId}>`, flags: MessageFlags.Ephemeral }); }
      if (interaction.customId === 'cntd_category')       { getCounterConfig(guildId).categoryId = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Counter category: <#${chId}>`, flags: MessageFlags.Ephemeral }); }

      if (interaction.customId.startsWith('apte_review_channel__')) {
        const typeId = interaction.customId.replace('apte_review_channel__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        appType.reviewChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Review channel for **${appType.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      // ════ REQUEST SETUP CHANNEL SELECTS ════
      if (interaction.customId.startsWith('reqsetup_channel__')) {
        const type = interaction.customId.replace('reqsetup_channel__', '');
        const cfg = type === 'exec' ? getExecRequestConfig(guildId) : getFounderRequestConfig(guildId);
        cfg.channel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      // ════ ERLC CHANNEL SELECTS ════
      if (interaction.customId.startsWith('erlcd_')) {
        const ec = getErlcLogConfig(guildId);
        const map = { erlcd_kickbans: 'kickBans', erlcd_joinleave: 'joinLeave', erlcd_cmds: 'cmds', erlcd_modcall: 'modCall', erlcd_kills: 'kills' };
        const key = map[interaction.customId];
        if (key) { ec[key] = chId; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral }); }
      }

      if (interaction.customId.startsWith('tkt_type_log__')) {
        const typeId = interaction.customId.replace('tkt_type_log__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Log channel for **${type.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId.startsWith('tkt_type_transcript__')) {
        const typeId = interaction.customId.replace('tkt_type_transcript__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.transcriptChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Transcript channel for **${type.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('tkt_type_category__')) {
        const typeId = interaction.customId.replace('tkt_type_category__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        type.category = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Category for **${type.label}** set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId.startsWith('hb_channel__')) {
        const panelId = interaction.customId.replace('hb_channel__', '');
        const hc = getHandbookConfig(guildId);
        if (!hc.panels[panelId]) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        hc.panels[panelId].channel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'load_log_channel') {
        const lc = getLOAConfig(guildId);
        lc.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ LOA log channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'inf_log_channel') {
        const ic = getInfractionConfig(guildId);
        ic.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Infraction log channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'vote_setup_log') {
        const vc = getVoteConfig(guildId);
        vc.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Vote log channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'vote_setup_announce_channel') {
        const gac = getGlobalAnnouncementConfig(guildId);
        gac.announcementChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Vote announcement channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId.startsWith('dept_set_channel__')) {
        const deptId = interaction.customId.replace('dept_set_channel__', '');
        const dc = getDepartmentsConfig(guildId);
        const dept = dc.list.find(d => d.id === deptId);
        if (!dept) return interaction.reply({ content: '❌ Department not found.', flags: MessageFlags.Ephemeral });
        dept.channel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Channel for **${dept.name}** set to <#${chId}>.`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'apingd_log') {
        const ap = getAntipingConfig(guildId);
        ap.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Antiping log channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'apingd_exempt_channels') {
        const ap = getAntipingConfig(guildId);
        if (!ap.exemptChannels) ap.exemptChannels = [];
        if (!ap.exemptChannels.includes(chId)) ap.exemptChannels.push(chId);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ <#${chId}> added to exempt channels.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'rppd_log') {
        const rpp = getRolePingProtectionConfig(guildId);
        rpp.logChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Log channel: <#${chId}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'cmdlist_channel') {
        const cl = getCommandListConfig(guildId);
        cl.channel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Command list channel set to <#${chId}>! Use the **Deploy** button to post it.`, flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING CHANNEL SELECT ════
      if (interaction.customId === 'tr_setup_announce_channel') {
        const tc = getTrainingConfig(guildId);
        tc.announceChannel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Announce channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'tr_setup_channel') {
        const tc = getTrainingConfig(guildId);
        tc.channel = chId;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Training request channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }

      // Application panel channel
      if (interaction.customId.startsWith('appe_channel__')) {
        const panelId = interaction.customId.replace('appe_channel__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.channel = chId; await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Panel channel set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
      // Application panel review channel override
      if (interaction.customId.startsWith('appe_review_channel__')) {
        const panelId = interaction.customId.replace('appe_review_channel__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.reviewChannel = chId; await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Review channel override set to <#${chId}>!`, flags: MessageFlags.Ephemeral });
      }
    }

    // ══ STRING SELECT MENUS ══
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId; const val = interaction.values[0];

      // ════ TRAINING TYPE SELECTION ════
      if (id === 'tr_select_type') {
        const tc = getTrainingConfig(guildId);
        const trainingType = tc.types.find(t => t.id === val);
        if (!trainingType) return interaction.reply({ content: '❌ Training type not found.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId(`modal_trainrequest__${val}`).setTitle(`Training Request — ${trainingType.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_times').setLabel('When are you available? (times/timezone)').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Monday 5-8PM EST, Wednesday 6-9PM EST').setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tr_notes').setLabel('Anything else the trainer should know?').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. I have done 2 ride-alongs already').setRequired(false).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }

      // ════ INFRACTION LEVEL SELECTION (which level to assign a role to) ════
      if (id === 'inf_select_level') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const index = parseInt(val, 10);
        const progEntry = INFRACTION_PROGRESSION[index];
        if (!progEntry) return interaction.reply({ content: '❌ Level not found.', flags: MessageFlags.Ephemeral });
        return interaction.reply({
          content: `### 🎭 Select the role to assign for **${progEntry.label}** (Level ${index + 1})\n*Leave empty to remove the role for this level.*`,
          components: [new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(`inf_level_role__${index}`)
              .setPlaceholder('Select role for this level...')
              .setMinValues(0)
              .setMaxValues(1)
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ════ CENTRAL SETUP MENU (dropdown) ════
      if (id === 'setup_menu') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const payloadMap = {
          tickets:       () => buildTicketSetupPayload(guildId),
          sessions:      () => buildSessionSetupPayload(guildId),
          selfroles:     () => buildSelfRoleOverview(guildId),
          announcements: () => buildAnnouncementOverview(guildId),
          welcomer:      () => buildWelcomerSetupPayload(guildId),
          autorole:      () => buildAutoroleSetupPayload(guildId),
          verification:  () => buildVerificationSetupPayload(guildId),
          applications:  () => buildApplicationSetupPayload(guildId),
          savedmessages: () => buildSavedMessagesPayload(guildId),
          automod:       () => buildAutomodSetupPayload(guildId),
          counters:      () => buildCounterSetupPayload(guildId),
          training:      () => buildTrainingSetupPayload(guildId),
          staffreview:   () => buildStaffReviewSetupPayload(guildId),
          erlclogs:      () => buildErlcLogSetupPayload(guildId),
          execrequest:   () => buildRequestSetupPayload(guildId, 'exec'),
          founderrequest:() => buildRequestSetupPayload(guildId, 'founder'),
          roleperms:     () => buildRolePermsSetupPayload(guildId),
          commandlist:   () => buildCommandListSetupPayload(guildId),
          handbooks:     () => buildHandbookSetupPayload(guildId),
          permissions:   () => buildPermissionsSetupPayload(guildId),
          departments:   () => buildDepartmentsSetupPayload(guildId),
          votesystem:    () => buildVoteSystemSetupPayload(guildId),
          infractions:   () => buildInfractionSetupPayload(guildId),
          loa:           () => buildLOASetupPayload(guildId),
          qotd:          () => buildQOTDSetupPayload(guildId),
          roleping:      () => buildRolePingProtectionSetupPayload(guildId),
          botconfig:     () => buildBotConfigSetupPayload(guildId),
          chainofcommand:() => buildChainSetupPayload(guildId),
        };
        const builder = payloadMap[val];
        if (!builder) return interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
        return interaction.reply(builder());
      }

      // ════ STAFF REVIEW RATING PICK ════
      if (id.startsWith('sr2_rating__')) {
        const targetUserId = id.replace('sr2_rating__', '');
        const rating = val;
        const stars = '⭐'.repeat(parseInt(rating));
        const modal = new ModalBuilder().setCustomId(`modal_sr2_review__${targetUserId}__${rating}`).setTitle(`Review — ${stars}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sr2_text').setLabel('Write your review').setStyle(TextInputStyle.Paragraph).setPlaceholder('Share your experience with this staff member...').setRequired(true).setMinLength(10).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }

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
        const embed = new EmbedBuilder().setTitle(`${t.emoji || '📢'} ${t.title || t.name}`).setDescription(t.description || '*No description*').setColor(hexToInt(t.color)).setFooter({ text: `By ${userDisplay(interaction.user)}` }).setTimestamp();
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

      // Standard selects (setup-only from here)
      const needsSetup = !['hbp__select__', 'srp__dd__'].some(prefix => id.startsWith(prefix)) && id !== 'announce_pick' && id !== 'sendmsg_pick';
      if (needsSetup && !hasSetup(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use setup.', flags: MessageFlags.Ephemeral });
      // Channel selects allowed on non-main, everything else blocked
      const isChannelSelectMenu = [
        'wcd_channel', 'vcd_channel', 'td_transcript', 'td_channel', 'td_category',
        'sd_channel', 'apd_review_channel', 'apd_log_channel', 'amd_log', 'cntd_category',
        'cmdlist_channel', 'tr_setup_channel', 'tr_setup_announce_channel',
        'vote_setup_log', 'vote_setup_announce_channel',
      ];
      const isChannelSelectMenuDynamic = id.startsWith('anch__') || id.startsWith('srch__') ||
        id.startsWith('hb_channel__') || id.startsWith('appe_channel__') ||
        id.startsWith('appe_review_channel__') || id.startsWith('apte_review_channel__') ||
        id.startsWith('reqsetup_channel__') || id.startsWith('erlcd_') ||
        id.startsWith('tkt_type_category__') || id.startsWith('tkt_type_log__') ||
        id.startsWith('dept_set_channel__') ||
        id === 'td_rating_channel' || id === 'td_rating_public';
      const isPublicSelect = ['hbp__select__', 'srp__dd__', 'announce_pick', 'sendmsg_pick'].some(p => id.startsWith(p) || id === p);
      if (needsSetup && !isMainServer(guildId) && !isChannelSelectMenu.includes(id) && !isChannelSelectMenuDynamic && !isPublicSelect) {
        return interaction.reply({ content: '❌ This can only be configured on the main server.', flags: MessageFlags.Ephemeral });
      }

      if (id === 'ticketv2type_remove_sel') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const v2 = getTicketV2Config(guildId);
        v2.types = (v2.types ?? []).filter(t => t.id !== val);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ V2 type config removed.', flags: MessageFlags.Ephemeral });
      }

      if (id === 'ticketv2type_edit_sel') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const v2 = getTicketV2Config(guildId);
        const t = v2.types?.find(t => t.id === val);
        if (!t) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId(`modal_ticketv2type_edit__${val}`).setTitle(`Edit: ${t.ticketTypeName.slice(0, 30)}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v2type_minrank').setLabel('Minimum staff rank level (0 = none)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(t.minimumStaffRank || 0)).setMaxLength(3)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('v2type_autoclose').setLabel('Auto-close after hours (0 = off)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(t.autoCloseHours || 0)).setMaxLength(4)),
        );
        return interaction.showModal(modal);
      }

      if (id === 'staffrank_remove_sel') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const src = getStaffRankConfig(guildId);
        src.ranks = src.ranks.filter(r => String(r.id) !== String(val));
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Rank removed.', flags: MessageFlags.Ephemeral });
      }

      // ════ CHAIN OF COMMAND SELECTS ════
      if (id === 'coc_remove_rank') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cc = getChainConfig(guildId);
        const role = interaction.guild.roles.cache.get(val);
        cc.chain = cc.chain.filter(e => e.roleId !== val);
        // Hernum posities
        cc.chain.forEach((e, i) => { e.position = i + 1; });
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ **${role?.name ?? val}** removed from the chain.`, flags: MessageFlags.Ephemeral });
      }

      if (id === 'coc_move_up') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cc = getChainConfig(guildId);
        const idx = cc.chain.findIndex(e => e.roleId === val);
        if (idx <= 0) return interaction.reply({ content: '❌ Already at the top.', flags: MessageFlags.Ephemeral });
        // Swap met vorige
        [cc.chain[idx], cc.chain[idx - 1]] = [cc.chain[idx - 1], cc.chain[idx]];
        cc.chain.forEach((e, i) => { e.position = i + 1; });
        await saveGuildConfig(guildId);
        const role = interaction.guild.roles.cache.get(val);
        return interaction.reply({ content: `✅ **${role?.name ?? val}** moved up to position **${idx}**.`, flags: MessageFlags.Ephemeral });
      }

      if (id === 'coc_move_down') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const cc = getChainConfig(guildId);
        const idx = cc.chain.findIndex(e => e.roleId === val);
        if (idx < 0 || idx >= cc.chain.length - 1) return interaction.reply({ content: '❌ Already at the bottom.', flags: MessageFlags.Ephemeral });
        // Swap met volgende
        [cc.chain[idx], cc.chain[idx + 1]] = [cc.chain[idx + 1], cc.chain[idx]];
        cc.chain.forEach((e, i) => { e.position = i + 1; });
        await saveGuildConfig(guildId);
        const role = interaction.guild.roles.cache.get(val);
        return interaction.reply({ content: `✅ **${role?.name ?? val}** moved down to position **${idx + 2}**.`, flags: MessageFlags.Ephemeral });
      }

      // ════ TRAINING TYPE REMOVE ════
      if (id === 'tr_sel_remove_type') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const tc = getTrainingConfig(guildId);
        const removed = tc.types.find(t => t.id === val);
        tc.types = tc.types.filter(t => t.id !== val);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Removed training type **${removed?.name}**.`, flags: MessageFlags.Ephemeral });
      }

      if (id === 'dept_sel_remove') {
        const dc = getDepartmentsConfig(guildId);
        dc.departments = (dc.departments ?? []).filter(d => d.id !== val);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Department removed.', flags: MessageFlags.Ephemeral });
      }
      // dept_sel_edit removed — departments now configured by ID only

      if (id === 'ard_remove')      { const ar = getAutoroleConfig(guildId); ar.roles = ar.roles.filter(r => r !== val); await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Removed from autoroles.`, flags: MessageFlags.Ephemeral }); }
      if (id === 'smd_delete')      { const sm = getSavedMessagesConfig(guildId); delete sm.messages[val]; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Deleted.', flags: MessageFlags.Ephemeral }); }
      if (id === 'an_sel_edit')     { return interaction.update(buildAnnouncementEditor(guildId, val)); }
      if (id === 'an_sel_delete')   { delete getAnnouncementConfig(guildId).types[val]; await saveGuildConfig(guildId); return interaction.update(buildAnnouncementOverview(guildId)); }
      if (id === 'sr_sel_edit')     { return interaction.update(buildPanelEditor(guildId, val)); }
      if (id === 'sr_sel_delete')   { delete getSelfRoleConfig(guildId).panels[val]; await saveGuildConfig(guildId); return interaction.update(buildSelfRoleOverview(guildId)); }
      if (id.startsWith('sr_sel_rmrole__')) { const panelId = id.replace('sr_sel_rmrole__', ''); const panel = getSelfRoleConfig(guildId).panels[panelId]; panel.roles = panel.roles.filter(r => r.id !== val); await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Role removed.`, flags: MessageFlags.Ephemeral }); }
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
        await saveGuildConfig(guildId);
        return interaction.update(buildHandbookPanelEditor(guildId, panelId));
      }

      if (id === 'td_select_type_roles') {
        const tc = getTicketConfig(guildId);
        const pc = getTicketPreCheckConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === val);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle(`🔧 Configure: ${type.emoji || '🎫'} ${type.label}`).setColor(0x5865F2)
          .setDescription('Settings marked *global* inherit from the global ticket/pre-check config.')
          .addFields(
            { name: '🔒 Required Roles',    value: type.requiredRoles?.length ? type.requiredRoles.map(r => `<@&${r}>`).join(', ') : '*Everyone*', inline: true },
            { name: '👁️ View Roles',        value: type.viewRoles?.length ? type.viewRoles.map(r => `<@&${r}>`).join(', ') : '*Ping roles only*', inline: true },
            { name: '📁 Category',          value: type.category ? `<#${type.category}>` : '*Global*', inline: true },
            { name: '📢 Ping Roles',        value: type.pingRoles?.length ? type.pingRoles.map(r => `<@&${r}>`).join(', ') : '*Global*', inline: true },
            { name: '📋 Transcript Ch.',    value: type.transcriptChannel ? `<#${type.transcriptChannel}>` : '*Global*', inline: true },
            { name: '🎨 Embed Color',       value: type.embedColor ? `\`${type.embedColor}\`` : '*Global*', inline: true },
            { name: '🖼️ Embed Image',      value: type.embedImage ? '✅ Set' : '*None*', inline: true },
            { name: '💬 Welcome Text',      value: type.welcomeText ? `\`${String(type.welcomeText).slice(0, 40)}...\`` : '*Global*', inline: true },
            { name: '🔒 Close Message',     value: type.closeMessage ? `\`${type.closeMessage.slice(0, 40)}\`` : '*Global*', inline: true },
            { name: '📩 DM on Open',        value: type.dmOnOpen === true ? '✅ Yes' : type.dmOnOpen === false ? '❌ No' : '*Global*', inline: true },
            { name: '🔐 Pre-Check',         value: type.preCheck?.enabled === true ? '✅ Enabled' : type.preCheck?.enabled === false ? '❌ Disabled' : '*Global*', inline: true },
            { name: '📊 Min. Amount',       value: type.preCheck?.minimumAmount != null ? `${type.preCheck.minimumAmount}` : '*Global*', inline: true },
            { name: '⏱️ Cooldown',          value: type.cooldownMinutes ? `${type.cooldownMinutes} min` : '*None*', inline: true },
            { name: '🔢 Max Open',          value: type.maxOpen ? `${type.maxOpen}` : '*Unlimited*', inline: true },
            { name: '📋 Log Channel',       value: type.logChannel ? `<#${type.logChannel}>` : '*None*', inline: true },
            { name: '📋 Intake Form',       value: Array.isArray(type.intakeFields) && type.intakeFields.length ? type.intakeFields.map((f, i) => `${i+1}. **${f.label}** ${f.required ? '*(required)*' : '*(optional)*'}`).join('\n') : '*No intake fields*', inline: false },
          );
        const r1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkt_type_cfg__required__${val}`).setLabel('Required Roles').setStyle(ButtonStyle.Primary).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__view__${val}`).setLabel('View Roles').setStyle(ButtonStyle.Primary).setEmoji('👁️'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__category__${val}`).setLabel('Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__ping_roles__${val}`).setLabel('Ping Roles').setStyle(ButtonStyle.Primary).setEmoji('📢'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__transcript__${val}`).setLabel('Transcript Ch.').setStyle(ButtonStyle.Primary).setEmoji('📋'),
        );
        const r2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkt_type_cfg__embed__${val}`).setLabel('Embed & Welcome').setStyle(ButtonStyle.Primary).setEmoji('🎨'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__precheck__${val}`).setLabel('Pre-Check').setStyle(ButtonStyle.Secondary).setEmoji('🔐'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__limits__${val}`).setLabel('Limits').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__logchannel__${val}`).setLabel('Log Channel').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
          new ButtonBuilder().setCustomId(`tkt_type_cfg__intake__${val}`).setLabel('Intake Form').setStyle(ButtonStyle.Success).setEmoji('📋'),
        );
        return interaction.reply({ embeds: [embed], components: [r1, r2], flags: MessageFlags.Ephemeral });
      }
      if (id === 'td_remove_type')  { const tc = getTicketConfig(guildId); tc.ticketTypes = tc.ticketTypes.filter(t => t.id !== val); await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Ticket type removed.', flags: MessageFlags.Ephemeral }); }

      // Self role dropdown (public)
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
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Application type removed.', flags: MessageFlags.Ephemeral });
      }

      if (id === 'apd_remove_panel') {
        const ac = getApplicationConfig(guildId);
        ac.panels = ac.panels.filter(p => p.id !== val);
        await saveGuildConfig(guildId);
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
          const payload = buildApplicationPanelMessage(panel, ac, guildId);
          await ch.send(payload);
          await saveGuildConfig(guildId);
          return interaction.editReply({ content: `✅ Panel **${panel.name}** deployed to <#${panel.channel}>!` });
        } catch (e) { return interaction.editReply({ content: `❌ ${e.message}` }); }
      }

      // Panel type management from panel editor
      if (id.startsWith('appe_add_type__')) {
        const panelId = id.replace('appe_add_type__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        if (!panel.appTypeIds.includes(val)) { panel.appTypeIds.push(val); await saveGuildConfig(guildId); }
        return interaction.reply({ content: `✅ Type added to panel!`, flags: MessageFlags.Ephemeral });
      }
      if (id.startsWith('appe_remove_type__')) {
        const panelId = id.replace('appe_remove_type__', '');
        const ac = getApplicationConfig(guildId);
        const panel = ac.panels.find(p => p.id === panelId);
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        panel.appTypeIds = panel.appTypeIds.filter(tid => tid !== val);
        await saveGuildConfig(guildId);
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

      // ── Infractions ──
      if (mid.startsWith('modal_ticketv2type_edit__')) {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const typeId = mid.replace('modal_ticketv2type_edit__', '');
        const v2 = getTicketV2Config(guildId);
        const t = v2.types?.find(t => t.id === typeId);
        if (!t) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
        const minRank   = parseInt(interaction.fields.getTextInputValue('v2type_minrank').trim() || '0', 10);
        const autoClose = parseInt(interaction.fields.getTextInputValue('v2type_autoclose').trim() || '0', 10);
        t.minimumStaffRank = isNaN(minRank) ? 0 : minRank;
        t.autoCloseHours   = isNaN(autoClose) ? 0 : autoClose;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ V2 config for **${t.ticketTypeName}** updated!`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_ticketv2type_add') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const v2 = getTicketV2Config(guildId);
        if (!Array.isArray(v2.types)) v2.types = [];
        const name      = interaction.fields.getTextInputValue('v2type_name').trim();
        const minRank   = parseInt(interaction.fields.getTextInputValue('v2type_minrank').trim() || '0', 10);
        const autoClose = parseInt(interaction.fields.getTextInputValue('v2type_autoclose').trim() || '0', 10);
        if (v2.types.find(t => t.ticketTypeName.toLowerCase() === name.toLowerCase())) {
          return interaction.reply({ content: `❌ A V2 config for **${name}** already exists.`, flags: MessageFlags.Ephemeral });
        }
        const newTypeId = genId();
        v2.types.push({
          id: newTypeId,
          ticketTypeName: name,
          categoryId: null,
          minimumStaffRank: isNaN(minRank) ? 0 : minRank,
          autoCloseHours: isNaN(autoClose) ? 0 : autoClose,
          formQuestions: [],
          requiredPermissions: [],
        });
        await saveGuildConfig(guildId);
        const catBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticketv2type__setcat__${newTypeId}`).setLabel('Set Category').setStyle(ButtonStyle.Primary).setEmoji('📁'),
        );
        return interaction.reply({ content: `✅ V2 config for **${name}** created!\n\nOptionally set a category:`, components: [catBtn], flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_staffrank_add') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const src = getStaffRankConfig(guildId);
        const name  = interaction.fields.getTextInputValue('rank_name').trim();
        const level = parseInt(interaction.fields.getTextInputValue('rank_level').trim(), 10);
        if (isNaN(level) || level < 1 || level > 100) return interaction.reply({ content: '❌ Level must be 1-100.', flags: MessageFlags.Ephemeral });
        const rankId = genId();
        src.ranks.push({ id: rankId, name, level, roleId: null });
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: `✅ Rank **${name}** (Level ${level}) added!\n\n### 🎭 Select the Discord role for this rank (optional):`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`staffrank_role__${rankId}`).setPlaceholder('Select role...').setMinValues(0).setMaxValues(1))],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (mid === 'modal_loa_request') {
        const lc = getLOAConfig(guildId);
        const reason = interaction.fields.getTextInputValue('loa_reason').trim();
        const daysRaw = parseInt(interaction.fields.getTextInputValue('loa_days').trim(), 10);
        if (isNaN(daysRaw) || daysRaw < 1 || daysRaw > 60) return interaction.reply({ content: '❌ Days must be between 1 and 60.', flags: MessageFlags.Ephemeral });
        const endsAt = Date.now() + daysRaw * 86_400_000;
        const reqId = genId();
        const loaData = { reason, endsAt, days: daysRaw, originalNickname: interaction.member.nickname ?? null, requestedAt: Date.now() };
        lc.active[`pending_${interaction.user.id}`] = loaData;
        await saveGuildConfig(guildId);
        const required = lc.requiredApprovals ?? 1;
        const embed = new EmbedBuilder()
          .setTitle('🏖️ LOA Request')
          .setColor(0x5865F2)
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: '👤 Requester', value: `${userDisplay(interaction.user)} (<@${interaction.user.id}>)`, inline: true },
            { name: '📅 Duration', value: `**${daysRaw}** day(s)`, inline: true },
            { name: '⏰ Ends', value: `<t:${Math.floor(endsAt/1000)}:R>`, inline: true },
            { name: '📝 Reason', value: reason, inline: false },
            { name: `✅ Approvals (0/${required})`, value: '*None yet*', inline: false },
            { name: '📊 Status', value: '⏳ Pending', inline: false },
          )
          .setFooter({ text: `Request ID: ${reqId}` })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`loa_approve__${interaction.user.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`loa_deny__${interaction.user.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
        );
        if (lc.logChannel) {
          const ch = interaction.guild.channels.cache.get(lc.logChannel);
          const ping = lc.approvalRoles?.length ? lc.approvalRoles.map(r => `<@&${r}>`).join(' ') : null;
          if (ch) await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        }
        return interaction.reply({ content: `✅ Your LOA request has been submitted! You will be notified when it is reviewed.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_loa_approvals') {
        const lc = getLOAConfig(guildId);
        const count = parseInt(interaction.fields.getTextInputValue('loa_approvals_count'), 10);
        if (isNaN(count) || count < 1 || count > 10) return interaction.reply({ content: '❌ Enter a number between 1 and 10.', flags: MessageFlags.Ephemeral });
        lc.requiredApprovals = count;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Required approvals set to **${count}**.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_loa_prefix') {
        const lc = getLOAConfig(guildId);
        lc.prefix = interaction.fields.getTextInputValue('loa_prefix_val').trim();
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ LOA prefix set to \`${lc.prefix}\`.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_inf_embed') {
        const ic = getInfractionConfig(guildId);
        ic.embedTitle       = interaction.fields.getTextInputValue('inf_title').trim();
        ic.embedDescription = interaction.fields.getTextInputValue('inf_desc').trim();
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Infraction embed updated!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_inf_dm') {
        const ic = getInfractionConfig(guildId);
        ic.dmMessage = interaction.fields.getTextInputValue('inf_dm').trim();
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ DM message updated!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_inf_color') {
        const ic = getInfractionConfig(guildId);
        ic.embedColor = interaction.fields.getTextInputValue('inf_color').trim();
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Color updated!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_inf_termination') {
        const ic = getInfractionConfig(guildId);
        ic.terminationMessage = interaction.fields.getTextInputValue('inf_termination').trim();
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Termination message updated!', flags: MessageFlags.Ephemeral });
      }

      // ── Bot config ──
      if (mid === 'modal_botcfg_logo') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const bc = getBotConfig(guildId);
        const url = interaction.fields.getTextInputValue('logo_url').trim();
        if (url && !isValidUrl(url)) return interaction.reply({ content: '❌ Invalid URL.', flags: MessageFlags.Ephemeral });
        bc.logoUrl = url || '';
        getGuildConfig(guildId).botConfig = bc;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: url ? `✅ Logo URL set!` : '✅ Logo URL cleared.', flags: MessageFlags.Ephemeral });
      }

      // ── Department add ──
      // ════ STAFF REVIEW MODAL SUBMIT ════
      if (mid.startsWith('modal_sr2_review__')) {
        const parts2 = mid.split('__');
        const targetUserId = parts2[2];
        const rating = parseInt(parts2[3]);
        const reviewText = interaction.fields.getTextInputValue('sr2_text').trim();

        // Guard: rating must be 1-5
        if (isNaN(rating) || rating < 1 || rating > 5) {
          return interaction.reply({ content: '❌ Invalid rating. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const src = getStaffReviewConfig(guildId);
        const ch = interaction.guild.channels.cache.get(src.channel);
        if (!ch) return interaction.reply({ content: '❌ Review channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        const targetUser = await client.users.fetch(targetUserId).catch(() => null);

        // Save review to config
        if (!src.reviews[targetUserId]) src.reviews[targetUserId] = [];
        src.reviews[targetUserId].push({ rating, text: reviewText, by: interaction.user.id, at: Date.now() });
        await saveGuildConfig(guildId);

        // Compute updated average
        const allRevs = src.reviews[targetUserId];
        const avgRating = (allRevs.reduce((s, r) => s + r.rating, 0) / allRevs.length).toFixed(2);
        const avgStars  = '⭐'.repeat(Math.round(parseFloat(avgRating)));

        const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
        const colorMap = { 1: 0xED4245, 2: 0xFEE75C, 3: 0xFEE75C, 4: 0x57F287, 5: 0x57F287 };
        const embedColor = colorMap[rating] ?? 0x5865F2;
        const embed = new EmbedBuilder()
          .setTitle(`${stars} Staff Review`)
          .setColor(embedColor)
          .setThumbnail(targetUser?.displayAvatarURL({ dynamic: true }) ?? null)
          .addFields(
            { name: '👮 Staff Member', value: targetUser ? `${userDisplay(targetUser)} (<@${targetUserId}>)` : `<@${targetUserId}>`, inline: true },
            { name: '⭐ Rating', value: `${rating}/5 — ${stars}`, inline: true },
            { name: '📊 Average Score', value: `${avgStars} **${avgRating}/5** *(${allRevs.length} review${allRevs.length !== 1 ? 's' : ''})*`, inline: false },
            { name: '✍️ Review', value: reviewText, inline: false },
            { name: '📝 Submitted by', value: `${userDisplay(interaction.user)} (<@${interaction.user.id}>)`, inline: true },
          )
          .setTimestamp();
        await ch.send({ embeds: [embed] });
        return interaction.reply({ content: `✅ Your review for **${targetUser?.tag ?? 'this staff member'}** has been submitted!`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_dept_add') {
        const dc = getDepartmentsConfig(guildId);
        if (!dc.isMainServer) return interaction.reply({ content: '❌ Only the main server can add departments. Enable "Set as Main Server" first.', flags: MessageFlags.Ephemeral });
        const name        = interaction.fields.getTextInputValue('dept_name').trim();
        const deptGuildId = interaction.fields.getTextInputValue('dept_guild_id').trim();
        const webhookUrl  = interaction.fields.getTextInputValue('dept_webhook_url').trim();
        if (!/^\d{17,20}$/.test(deptGuildId)) return interaction.reply({ content: '❌ Invalid Server ID.', flags: MessageFlags.Ephemeral });
        if (!isValidUrl(webhookUrl) || !webhookUrl.includes('discord.com/api/webhooks')) return interaction.reply({ content: '❌ Invalid webhook URL. Must be a Discord webhook URL.', flags: MessageFlags.Ephemeral });
        if (dc.departments.some(d => d.guildId === deptGuildId)) return interaction.reply({ content: `❌ Server \`${deptGuildId}\` is already linked.`, flags: MessageFlags.Ephemeral });
        dc.departments.push({ id: genId(), name, guildId: deptGuildId, announcementChannelId: null, webhookUrl });
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Department **${name}** added via webhook!\n\n**How to create a webhook:** Go to the department server → channel settings → Integrations → Webhooks → New Webhook → Copy URL.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_cnt_labels') {
        const cc = getCounterConfig(guildId);
        cc.channels.members.label  = interaction.fields.getTextInputValue('cnt_lbl_members').trim()  || cc.channels.members.label;
        cc.channels.bots.label     = interaction.fields.getTextInputValue('cnt_lbl_bots').trim()     || cc.channels.bots.label;
        cc.channels.online.label   = interaction.fields.getTextInputValue('cnt_lbl_online').trim()   || cc.channels.online.label;
        cc.channels.channels.label = interaction.fields.getTextInputValue('cnt_lbl_channels').trim() || cc.channels.channels.label;
        cc.channels.roles.label    = interaction.fields.getTextInputValue('cnt_lbl_roles').trim()    || cc.channels.roles.label;
        await saveGuildConfig(guildId);
        await updateCounters(interaction.guild).catch(() => {});
        return interaction.reply({ content: '✅ Labels updated and counters refreshed!', flags: MessageFlags.Ephemeral });
      }

      // ── Automod ──
      if (mid === 'modal_ap_action') {
        const ap = getAntipingConfig(guildId);
        const act = interaction.fields.getTextInputValue('ap_act').trim().toLowerCase();
        const minsRaw = interaction.fields.getTextInputValue('ap_mute_mins').trim();
        const mins = parseInt(minsRaw, 10);
        if (!['delete', 'warn', 'delete+warn', 'delete+mute'].includes(act)) return interaction.reply({ content: '❌ Invalid action.', flags: MessageFlags.Ephemeral });
        ap.action = act;
        if (!isNaN(mins) && mins > 0) ap.muteMinutes = mins;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Antiping action: **${act}**.`, flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_ap_warn_message') {
        const ap = getAntipingConfig(guildId);
        ap.warnMessage = interaction.fields.getTextInputValue('ap_warn_msg').trim() || '⚠️ {user}, you are not allowed to ping @everyone or @here.';
        await saveGuildConfig(guildId);
        return interaction.reply({ content: '✅ Warn message saved!', flags: MessageFlags.Ephemeral });
      }
      // modal_rpp_whitelist vervangen door rppd_whitelist_users UserSelectMenu
      if (mid === 'modal_rpp_settings') {
        const rpp = getRolePingProtectionConfig(guildId);
        const act = interaction.fields.getTextInputValue('rpp_action').trim().toLowerCase();
        const validActs = ['delete', 'delete+warn', 'delete+mute', 'warn'];
        if (!validActs.includes(act)) return interaction.reply({ content: `❌ Ongeldige actie. Gebruik: delete / warn / delete+warn / delete+mute`, flags: MessageFlags.Ephemeral });
        const minsRaw = interaction.fields.getTextInputValue('rpp_mute_mins').trim();
        const warnMsg = interaction.fields.getTextInputValue('rpp_warn_msg').trim();
        if (!['delete', 'warn', 'delete+warn', 'delete+mute'].includes(act)) return interaction.reply({ content: '❌ Invalid action. Use: delete / warn / delete+warn / delete+mute', flags: MessageFlags.Ephemeral });
        rpp.action = act;
        const mins = parseInt(minsRaw, 10);
        if (!isNaN(mins) && mins > 0) rpp.muteMinutes = mins;
        if (warnMsg) rpp.warnMessage = warnMsg;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Settings saved!\n**Action:** ${act} | **Mute:** ${rpp.muteMinutes}min`, flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_am_keywords') {
        const am = getAutomodConfig(guildId);
        const raw = interaction.fields.getTextInputValue('am_kw').trim();
        am.keywords = raw ? raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ **${am.keywords.length}** keyword(s) set.`, flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_am_action') {
        const am = getAutomodConfig(guildId);
        const act = interaction.fields.getTextInputValue('am_act').trim().toLowerCase();
        const minsRaw = interaction.fields.getTextInputValue('am_mute_mins').trim();
        const mins = parseInt(minsRaw, 10);
        if (!['delete', 'warn', 'delete+warn', 'delete+mute'].includes(act)) return interaction.reply({ content: '❌ Invalid action.', flags: MessageFlags.Ephemeral });
        am.action = act;
        if (!isNaN(mins) && mins > 0) am.muteMinutes = mins;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Action set to **${act}**.`, flags: MessageFlags.Ephemeral });
      }

      // ── Application deny reason ──
      if (mid.startsWith('modal_app_deny__')) {
        const parts = mid.replace('modal_app_deny__', '').split('__');
        const applicantId = parts[0]; const typeId = parts[1]; const appId = parts[2];
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        const applicant = await interaction.guild.members.fetch(applicantId).catch(() => null);
        const reason = interaction.fields.getTextInputValue('deny_reason').trim();
        await interaction.update({
          embeds: [new EmbedBuilder().setTitle('❌ Application Denied').setColor(0xED4245)
            .addFields(
              { name: 'Applicant', value: userDisplay(applicant?.user) ?? applicantId, inline: true },
              { name: 'Type', value: appType?.label ?? typeId, inline: true },
              { name: 'Denied by', value: userDisplay(interaction.user), inline: true },
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
            .addFields({ name: 'Applicant', value: userDisplay(applicant?.user) ?? applicantId, inline: true }, { name: 'Type', value: appType?.label ?? typeId, inline: true }, { name: 'Denied by', value: userDisplay(interaction.user), inline: true }, { name: '📝 Reason', value: reason, inline: false }).setTimestamp()] });
        }

        // Transcript
        await sendApplicationTranscript(interaction.guild, ac, appId, {
          result: 'denied',
          moderator: userDisplay(interaction.user),
          reason,
        });
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Questions updated! **${questions.length}** question(s) set.`, flags: MessageFlags.Ephemeral });
      }

      // ── Saved messages ──
      if (mid === 'modal_sm_new') {
        const sm = getSavedMessagesConfig(guildId);
        const name = interaction.fields.getTextInputValue('sm_name').trim();
        if (Object.values(sm.messages).some(m => m.name.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `❌ **${name}** already exists.`, flags: MessageFlags.Ephemeral });
        const newId = genId();
        sm.messages[newId] = { name, title: interaction.fields.getTextInputValue('sm_title').trim(), description: interaction.fields.getTextInputValue('sm_desc').trim(), color: interaction.fields.getTextInputValue('sm_color').trim() || '#5865F2', image: interaction.fields.getTextInputValue('sm_image').trim() || null, footer: null };
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Saved message **${name}** created!`, flags: MessageFlags.Ephemeral });
      }
      if (mid.startsWith('modal_sm_edit__')) {
        const msgId = mid.replace('modal_sm_edit__', '');
        const sm = getSavedMessagesConfig(guildId); const msg = sm.messages[msgId];
        if (!msg) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
        const t = interaction.fields.getTextInputValue('sm_title').trim(); const d = interaction.fields.getTextInputValue('sm_desc').trim(); const c = interaction.fields.getTextInputValue('sm_color').trim(); const im = interaction.fields.getTextInputValue('sm_image').trim(); const f = interaction.fields.getTextInputValue('sm_footer').trim();
        if (t) msg.title = t; if (d) msg.description = d; if (c) msg.color = c; msg.image = im || null; msg.footer = f || null;
        await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Updated!`, flags: MessageFlags.Ephemeral });
      }

      // ── Welcomer ──
      if (mid === 'modal_wc_content') {
        const wc = getWelcomerConfig(guildId);
        const t = interaction.fields.getTextInputValue('wc_title').trim(); const d = interaction.fields.getTextInputValue('wc_desc').trim(); const c = interaction.fields.getTextInputValue('wc_color').trim(); const im = interaction.fields.getTextInputValue('wc_image').trim(); const f = interaction.fields.getTextInputValue('wc_footer').trim();
        if (t) wc.title = t; if (d) wc.description = d; if (c) wc.color = c; wc.image = im || null; wc.footer = f || null;
        await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Welcome message updated!', flags: MessageFlags.Ephemeral });
      }

      // ── Verification ──
      if (mid === 'modal_vc_content') {
        const vc = getVerificationConfig(guildId);
        const t = interaction.fields.getTextInputValue('vc_title').trim(); const d = interaction.fields.getTextInputValue('vc_desc').trim(); const c = interaction.fields.getTextInputValue('vc_color').trim(); const im = interaction.fields.getTextInputValue('vc_image').trim();
        if (t) vc.panelTitle = t; if (d) vc.panelDescription = d; if (c) vc.panelColor = c; vc.panelImage = im || null;
        await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Updated!', flags: MessageFlags.Ephemeral });
      }
      if (mid === 'modal_erlcconfig') {
        const key = interaction.fields.getTextInputValue('erlc_server_key').trim();
        const ec = getErlcLogConfig(guildId);
        ec.serverKey = key;
        await saveGuildConfig(guildId);
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
          const code = `VERIFY-${genVerificationCode()}`;
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
        await saveGuildConfig(guildId);
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
            { name: '👤 Submitted By', value: `${userDisplay(interaction.user)} (<@${interaction.user.id}>)`, inline: true },
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
        // Ask for required roles
        return interaction.reply({
          content: `✅ Book **${label}** added!\n\n### 🔒 Select required roles for this book (leave empty = everyone can see it):`,
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`hb_book_roles__${panelId}__${bookId}`).setPlaceholder('Select roles (0 = everyone)...').setMinValues(0).setMaxValues(10))],
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Ticket ──
      if (mid.startsWith('modal_rating__')) {
        const parts      = mid.replace('modal_rating__', '').split('__');
        const stars      = parseInt(parts[0], 10);
        const userId     = parts[1];
        const ratingGuildId = parts[2];
        const ticketName = parts.slice(3).join('__');
        const reason     = interaction.fields.getTextInputValue('rating_reason').trim() || null;
        const starStr    = '⭐'.repeat(stars);

        // Bevestig aan de gebruiker
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('✅ Thanks for your feedback!')
            .setColor(stars >= 4 ? 0x57F287 : stars >= 3 ? 0xFEE75C : 0xED4245)
            .setDescription(`You rated your experience **${starStr}** (${stars}/5).${reason ? `\n\n**Your feedback:**\n${reason}` : ''}`)
            .setTimestamp()
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});

        const ratingGuild = client.guilds.cache.get(ratingGuildId);
        if (ratingGuild) {
          try {
            const rc = getTicketRatingConfig(ratingGuildId);
            const member = await ratingGuild.members.fetch(userId).catch(() => null);

            const staffEmbed = new EmbedBuilder()
              .setTitle(`⭐ Ticket Rating — ${starStr}`)
              .setColor(stars >= 4 ? 0x57F287 : stars >= 3 ? 0xFEE75C : 0xED4245)
              .addFields(
                { name: '👤 User',     value: member ? `${userDisplay(member.user)} (<@${userId}>)` : `<@${userId}>`, inline: true },
                { name: '⭐ Rating',   value: `${starStr} (${stars}/5)`, inline: true },
                { name: '🎫 Ticket',   value: ticketName,                 inline: true },
                { name: '💬 Feedback', value: reason ?? '*No feedback given*', inline: false },
              )
              .setThumbnail(member?.user.displayAvatarURL({ dynamic: true }) ?? null)
              .setTimestamp();

            // Staff log kanaal — volledige info
            if (rc.enabled && rc.logChannel) {
              const logCh = ratingGuild.channels.cache.get(rc.logChannel);
              if (logCh) await logCh.send({ embeds: [staffEmbed] }).catch(() => {});
            }

            // Publiek kanaal — zonder gebruikersnaam voor privacy
            if (rc.enabled && rc.publicChannel) {
              const pubCh = ratingGuild.channels.cache.get(rc.publicChannel);
              if (pubCh) {
                const publicEmbed = new EmbedBuilder()
                  .setTitle(`⭐ New Review — ${starStr}`)
                  .setColor(stars >= 4 ? 0x57F287 : stars >= 3 ? 0xFEE75C : 0xED4245)
                  .setDescription(reason ? `*"${reason}"*` : '*No written feedback.*')
                  .addFields(
                    { name: '⭐ Rating',  value: `${starStr} (${stars}/5)`, inline: true },
                    { name: '🎫 Ticket', value: ticketName,                  inline: true },
                  )
                  .setFooter({ text: 'Anonymous review' })
                  .setTimestamp();
                await pubCh.send({ embeds: [publicEmbed] }).catch(() => {});
              }
            }
          } catch (logErr) {
            console.error('Rating log error:', logErr);
          }
        }
        return;
      }

      if (mid.startsWith('modal_intake_submit__')) {
        const intakeTypeId = mid.replace('modal_intake_submit__', '');
        const tc = getTicketConfig(guildId);
        const pc = getTicketPreCheckConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === intakeTypeId);
        if (!type) return interaction.reply({ content: '❌ Ticket type no longer exists.', flags: MessageFlags.Ephemeral });

        // Verzamel intake antwoorden
        const intakeAnswers = [];
        for (const field of (type.intakeFields ?? [])) {
          let answer = '';
          try { answer = interaction.fields.getTextInputValue(`intake_${field.id}`).trim(); } catch {}
          intakeAnswers.push({ label: field.label, answer });
        }

        // Sla intake op in beide maps
        ticketIntakeData.set(interaction.user.id, intakeAnswers);
        ticketRulesPending.set(interaction.user.id, { typeId: intakeTypeId, guildId, intakeAnswers });

        // Nu pre-check doen of direct ticket aanmaken
        const resolvedPreCheckEnabled = resolveTicketSetting(type, tc, pc, 'preCheck.enabled');
        const resolvedRulesText       = resolveTicketSetting(type, tc, pc, 'preCheck.rulesText');

        if (resolvedPreCheckEnabled === true) {
          const rulesEmbed = new EmbedBuilder()
            .setTitle('📋 Ticket Rules')
            .setDescription(resolvedRulesText)
            .setColor(0x5865F2)
            .setFooter({ text: 'You must accept the rules to open a ticket.' });
          const rulesRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`tkt__rules_accept__${intakeTypeId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tkt__rules_decline').setLabel('❌ Decline').setStyle(ButtonStyle.Danger),
          );
          return interaction.reply({ embeds: [rulesEmbed], components: [rulesRow], flags: MessageFlags.Ephemeral });
        }

        // Geen pre-check — direct ticket aanmaken
        ticketRulesPending.delete(interaction.user.id);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await createTicketChannel(interaction, type, tc, pc, guildId, false);
        } catch (e) {
          console.error('createTicketChannel (intake) error:', e);
          ticketIntakeData.delete(interaction.user.id);
          await interaction.editReply({ content: `❌ Could not create ticket: ${e.message}` }).catch(() => {});
        }
        return;
      }

      if (mid === 'modal_qotd_time') {
        const qc = getQOTDConfig(guildId);
        const time = interaction.fields.getTextInputValue('qotd_time').trim();
        if (!/^\d{2}:\d{2}$/.test(time)) return interaction.reply({ content: '❌ Invalid format. Use HH:MM (e.g. 09:00).', flags: MessageFlags.Ephemeral });
        const [h, m] = time.split(':').map(Number);
        if (h > 23 || m > 59) return interaction.reply({ content: '❌ Invalid time.', flags: MessageFlags.Ephemeral });
        qc.time = time;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ QOTD time set to **${time} UTC**.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_qotd_add') {
        const qc   = getQOTDConfig(guildId);
        const text = interaction.fields.getTextInputValue('qotd_question').trim();
        if (!text) return interaction.reply({ content: '❌ Question cannot be empty.', flags: MessageFlags.Ephemeral });
        const entry = { id: genId(), text, used: false, createdAt: new Date().toISOString(), lastUsedAt: null, usageCount: 0 };
        qc.library.push(entry);
        qc.queue.push(entry.id);
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Question added! Library now has **${qc.library.length}** question(s).`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_qotd_bulk') {
        const resolvedGuildId = guildId ?? interaction.guildId;
        if (!resolvedGuildId) return interaction.reply({ content: '❌ Could not determine server.', flags: MessageFlags.Ephemeral });
        const qc = getQOTDConfig(resolvedGuildId);

        let raw = '';
        let dedupRaw = 'yes';
        try { raw = interaction.fields.getTextInputValue('qotd_bulk') ?? ''; } catch {}
        try { dedupRaw = interaction.fields.getTextInputValue('qotd_dedup')?.trim().toLowerCase() ?? 'yes'; } catch {}

        const dedup = dedupRaw !== 'no';

        const lines = raw.split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && l.length <= 500);

        if (!lines.length) {
          return interaction.reply({ content: '❌ No valid questions found. Make sure each question is on its own line.', flags: MessageFlags.Ephemeral });
        }

        const existingTexts = new Set(qc.library.map(q => q.text.toLowerCase().trim()));
        let duplicatesInImport = 0;
        let duplicatesAgainstLibrary = 0;
        const seen = new Set();
        const toAdd = [];

        for (const line of lines) {
          const key = line.toLowerCase();
          if (dedup && seen.has(key)) { duplicatesInImport++; continue; }
          seen.add(key);
          if (dedup && existingTexts.has(key)) { duplicatesAgainstLibrary++; continue; }
          toAdd.push(line);
        }

        if (!toAdd.length) {
          return interaction.reply({
            content: [
              `❌ No new questions to add.`,
              `**Detected:** ${lines.length}`,
              duplicatesInImport       ? `**Duplicates in import:** ${duplicatesInImport}` : '',
              duplicatesAgainstLibrary ? `**Already in library:** ${duplicatesAgainstLibrary}` : '',
            ].filter(Boolean).join('\n'),
            flags: MessageFlags.Ephemeral,
          });
        }

        const now = new Date().toISOString();
        const newEntries = toAdd.map(text => ({
          id: genId(), text, used: false, createdAt: now, lastUsedAt: null, usageCount: 0,
        }));
        qc.library.push(...newEntries);

        const newIds      = shuffleArray(newEntries.map(e => e.id));
        const insertPoint = Math.floor(Math.random() * (qc.queue.length + 1));
        qc.queue.splice(insertPoint, 0, ...newIds);

        await saveGuildConfig(resolvedGuildId);

        return interaction.reply({
          content: [
            `✅ **Bulk import complete!**`,
            ``,
            `📥 **Detected:** ${lines.length}`,
            `✅ **Added:** ${toAdd.length}`,
            duplicatesInImport       ? `🔁 **Duplicates in import:** ${duplicatesInImport}` : '',
            duplicatesAgainstLibrary ? `📚 **Already in library:** ${duplicatesAgainstLibrary}` : '',
            ``,
            `📚 **Total:** ${qc.library.length} | **Queue:** ${qc.queue.length} | **Unused:** ${qc.library.filter(q => !q.used).length}`,
          ].filter(Boolean).join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (mid === 'modal_tkt_inactivity') {
        const ic = getTicketInactivityConfig(guildId);
        const warnRaw  = parseInt(interaction.fields.getTextInputValue('warn_minutes').trim(), 10);
        const closeRaw = parseInt(interaction.fields.getTextInputValue('close_minutes').trim(), 10);
        const warnMsg  = interaction.fields.getTextInputValue('warn_message').trim();
        if (!isNaN(warnRaw)  && warnRaw  > 0) ic.warnAfterMinutes  = warnRaw;
        if (!isNaN(closeRaw) && closeRaw > 0) ic.closeAfterMinutes = closeRaw;
        if (warnMsg) ic.warnMessage = warnMsg;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Inactivity settings saved!\n**Warn:** ${ic.warnAfterMinutes}min | **Close:** ${ic.closeAfterMinutes}min`, flags: MessageFlags.Ephemeral });
      }

      if (mid.startsWith('modal_intake_add__')) {
        const intakeTypeId = mid.replace('modal_intake_add__', '');
        const tc2 = getTicketConfig(guildId);
        const t2  = tc2.ticketTypes.find(t => t.id === intakeTypeId);
        if (!t2) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        if (!Array.isArray(t2.intakeFields)) t2.intakeFields = [];
        if (t2.intakeFields.length >= 4) return interaction.reply({ content: '❌ Max 4 fields.', flags: MessageFlags.Ephemeral });

        const label       = interaction.fields.getTextInputValue('intake_label').trim();
        const placeholder = interaction.fields.getTextInputValue('intake_placeholder').trim() || null;
        const required    = interaction.fields.getTextInputValue('intake_required').trim().toLowerCase() !== 'no';
        const isLong      = interaction.fields.getTextInputValue('intake_long').trim().toLowerCase() === 'yes';

        t2.intakeFields.push({
          id:          genId(),
          label,
          placeholder,
          required,
          style: isLong ? 'paragraph' : 'short',
        });
        await saveGuildConfig(guildId);

        const fieldList = t2.intakeFields.map((f, i) => `**${i+1}.** ${f.label} ${f.required ? '*(required)*' : '*(optional)*'}`).join('\n');
        const embed = new EmbedBuilder()
          .setTitle(`📋 Intake Form — ${t2.label}`)
          .setColor(0x57F287)
          .setDescription(`✅ Field **${label}** added!\n\n${fieldList}`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkt_intake__add__${intakeTypeId}`).setLabel('Add Field').setStyle(ButtonStyle.Success).setEmoji('➕').setDisabled(t2.intakeFields.length >= 4),
          new ButtonBuilder().setCustomId(`tkt_intake__clear__${intakeTypeId}`).setLabel('Clear All').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        );
        return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_t_rating') {
        const rc = getTicketRatingConfig(guildId);
        const val = interaction.fields.getTextInputValue('rating_enabled').trim().toLowerCase();
        rc.enabled = val === 'yes' || val === 'true';
        await saveGuildConfig(guildId);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('t_rating_channel').setLabel('Staff Log Channel').setStyle(ButtonStyle.Primary).setEmoji('📋'),
          new ButtonBuilder().setCustomId('t_rating_public').setLabel('Public Reviews Channel').setStyle(ButtonStyle.Primary).setEmoji('📢'),
        );
        return interaction.reply({
          content: `✅ Rating system **${rc.enabled ? 'enabled' : 'disabled'}**!\n\nNow set the channels:`,
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (mid === 'modal_t_precheck') {
        const pc = getTicketPreCheckConfig(guildId);
        const enabledRaw = interaction.fields.getTextInputValue('pc_enabled').trim().toLowerCase();
        pc.enabled = enabledRaw === 'yes' || enabledRaw === 'true' || enabledRaw === '1';
        const rulesText = interaction.fields.getTextInputValue('pc_rules').trim();
        if (rulesText) pc.rulesText = rulesText;
        const minAmtRaw = parseInt(interaction.fields.getTextInputValue('pc_min_amount').trim(), 10);
        pc.minimumAmount = isNaN(minAmtRaw) || minAmtRaw < 0 ? 0 : minAmtRaw;
        const label = interaction.fields.getTextInputValue('pc_amount_label').trim();
        if (label) pc.amountLabel = label;
        const denialMsg = interaction.fields.getTextInputValue('pc_denial_msg').trim();
        if (denialMsg) pc.amountDenialMessage = denialMsg;
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: [
            `✅ Pre-check settings saved!`,
            `**Enabled:** ${pc.enabled ? 'Yes' : 'No'}`,
            `**Min. ${pc.amountLabel}:** ${pc.minimumAmount || 'Disabled'}`,
            ``,
            `> To store a user's ${pc.amountLabel}, set \`verifiedUsers[userId].serviceAmount\` in MongoDB, or hook it into your verification flow.`,
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }
      if (mid.startsWith('modal_tkt_type_limits__')) {
        const typeId = mid.replace('modal_tkt_type_limits__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const cooldown   = parseInt(interaction.fields.getTextInputValue('tkt_cooldown').trim(), 10);
        const maxOpen    = parseInt(interaction.fields.getTextInputValue('tkt_max_open').trim(), 10);
        let autoCloseRaw = 0;
        try { autoCloseRaw = parseInt(interaction.fields.getTextInputValue('tkt_auto_close').trim(), 10); } catch {}
        type.cooldownMinutes = (!isNaN(cooldown) && cooldown > 0) ? cooldown : null;
        type.maxOpen         = (!isNaN(maxOpen)  && maxOpen  > 0) ? maxOpen  : null;
        type.autoCloseHours  = (!isNaN(autoCloseRaw) && autoCloseRaw > 0) ? autoCloseRaw : null;
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: [
            `✅ Limits saved for **${type.label}**!`,
            `**Cooldown:** ${type.cooldownMinutes ? `${type.cooldownMinutes} minutes` : 'None'}`,
            `**Max open:** ${type.maxOpen ?? 'Unlimited'}`,
            `**Auto-close:** ${type.autoCloseHours ? `${type.autoCloseHours} hours` : 'Disabled'}`,
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }
      if (mid.startsWith('modal_tkt_type_embed__')) {
        const typeId = mid.replace('modal_tkt_type_embed__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const wt       = interaction.fields.getTextInputValue('tkt_welcome').trim();
        const color    = interaction.fields.getTextInputValue('tkt_color').trim();
        const image    = interaction.fields.getTextInputValue('tkt_image').trim();
        const closeMsg = interaction.fields.getTextInputValue('tkt_close_msg').trim();
        const dmRaw    = interaction.fields.getTextInputValue('tkt_dm_open').trim().toLowerCase();
        type.welcomeText    = wt       || null;
        type.embedColor     = color    || null;
        type.embedImage     = image    || null;
        type.closeMessage   = closeMsg || null;
        type.dmOnOpen       = dmRaw === 'yes' ? true : dmRaw === 'no' ? false : null; // null = global
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Embed settings saved for **${type.label}**!\n*Empty fields fall back to global.*`, flags: MessageFlags.Ephemeral });
      }

      if (mid.startsWith('modal_tkt_type_precheck__')) {
        const typeId = mid.replace('modal_tkt_type_precheck__', '');
        const tc = getTicketConfig(guildId);
        const type = tc.ticketTypes.find(t => t.id === typeId);
        if (!type) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        if (!type.preCheck) type.preCheck = {};
        const enabledRaw  = interaction.fields.getTextInputValue('pc_enabled').trim().toLowerCase();
        const rulesText   = interaction.fields.getTextInputValue('pc_rules').trim();
        const minAmtRaw   = interaction.fields.getTextInputValue('pc_min_amount').trim();
        const amtLabel    = interaction.fields.getTextInputValue('pc_amount_label').trim();
        const denialMsg   = interaction.fields.getTextInputValue('pc_denial_msg').trim();
        type.preCheck.enabled        = enabledRaw === 'yes' ? true : enabledRaw === 'no' ? false : null;
        type.preCheck.rulesText      = rulesText  || null;
        type.preCheck.minimumAmount  = minAmtRaw  ? (parseInt(minAmtRaw, 10) || 0) : null;
        type.preCheck.amountLabel    = amtLabel   || null;
        type.preCheck.amountDenialMessage = denialMsg || null;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Pre-check settings saved for **${type.label}**!\n*Empty fields fall back to global.*`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_t_embed')   { const tc = getTicketConfig(guildId); const t = interaction.fields.getTextInputValue('t_embed_title').trim(); const d = interaction.fields.getTextInputValue('t_embed_desc').trim(); const c = interaction.fields.getTextInputValue('t_embed_color').trim(); const th = interaction.fields.getTextInputValue('t_embed_thumbnail').trim(); if (t) tc.panelTitle = t; if (d) tc.panelDescription = d; if (c) tc.panelColor = c; if (th) tc.panelThumbnail = th; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Panel embed updated!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_t_welcome') { const tc = getTicketConfig(guildId); tc.welcomeText = interaction.fields.getTextInputValue('t_welcome_text').trim(); await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Welcome text saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_t_add_type') { const tc = getTicketConfig(guildId); tc.ticketTypes.push({ id: genId(), label: interaction.fields.getTextInputValue('tt_label').trim(), emoji: interaction.fields.getTextInputValue('tt_emoji').trim() || null, color: interaction.fields.getTextInputValue('tt_color').trim() || 'blue', description: interaction.fields.getTextInputValue('tt_description').trim() || null }); await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Ticket type added!`, flags: MessageFlags.Ephemeral }); }

      // ── Session ──
      if (mid === 'modal_s_joinlink')  { const rawLink = interaction.fields.getTextInputValue('s_link_val').trim(); if (!isValidUrl(rawLink)) return interaction.reply({ content: '❌ Invalid URL.', flags: MessageFlags.Ephemeral }); getSessionConfig(guildId).joinLink = rawLink; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Join link saved!`, flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_tr_add_type') {
        if (!hasSetup(interaction.member)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
        const tc = getTrainingConfig(guildId);
        const name = interaction.fields.getTextInputValue('tr_type_name').trim();
        const newId = genId();
        tc.types.push({ id: newId, name, roleId: null });
        await saveGuildConfig(guildId);
        return interaction.reply({
          content: `✅ Training type **${name}** added!\n\n### 🎭 Select the role to assign when someone **passes** this training (optional — dismiss to skip):`,
          components: [new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId(`tr_type_role__${newId}`).setPlaceholder('Select role to give on pass...').setMinValues(0).setMaxValues(1)
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (mid === 'modal_tr_announce_msg') {
        const tc = getTrainingConfig(guildId);
        tc.announceMessage = interaction.fields.getTextInputValue('announce_msg').trim() || null;
        await saveGuildConfig(guildId);
        return interaction.reply({ content: `✅ Announce message saved!`, flags: MessageFlags.Ephemeral });
      }

      if (mid.startsWith('modal_trainrequest__')) {
        const typeId = mid.replace('modal_trainrequest__', '');
        const tc = getTrainingConfig(guildId);
        const trainingType = typeId !== 'none' ? tc.types.find(t => t.id === typeId) : null;
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
            { name: '👤 Requester', value: `${userDisplay(interaction.user)} (<@${interaction.user.id}>)`, inline: true },
            { name: '🆔 User ID', value: interaction.user.id, inline: true },
            { name: '🎓 Training Type', value: trainingType ? trainingType.name : '*General*', inline: true },
            { name: '🕐 Available Times', value: times, inline: false },
            { name: '📝 Notes', value: notes || '*None*', inline: false },
            { name: '✅ Claimed By', value: '*No one yet*', inline: false },
          )
          .setFooter({ text: `Request ID: ${reqId}` })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tr__claim__${interaction.user.id}__${reqId}`).setLabel('🙋 Claim Training').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`tr__unclaim__${interaction.user.id}__${reqId}`).setLabel('↩️ Unclaim').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`tr__pass__${interaction.user.id}__${reqId}__${typeId}`).setLabel('✅ Pass').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tr__fail__${interaction.user.id}__${reqId}`).setLabel('❌ Fail').setStyle(ButtonStyle.Danger),
        );
        const ping = tc.pingRoles.length ? tc.pingRoles.map(r => `<@&${r}>`).join(' ') : null;
        await ch.send({ content: ping ?? undefined, embeds: [embed], components: [row] });
        const cdKey = `${guildId}:${interaction.user.id}`;
        trainRequestCooldowns.set(cdKey, Date.now());
        return interaction.reply({ content: `✅ Your training request has been posted! A trainer will claim it soon.`, flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_send') {
        const content = interaction.fields.getTextInputValue('send_content');
        await interaction.channel.send({ content });
        return interaction.reply({ content: '✅ Message sent!', flags: MessageFlags.Ephemeral });
      }

      if (mid === 'modal_s_desc')      { const sc = getSessionConfig(guildId); const s = interaction.fields.getTextInputValue('s_start_desc').trim(); const v = interaction.fields.getTextInputValue('s_vote_desc').trim(); const sh = interaction.fields.getTextInputValue('s_shutdown_desc').trim(); if (s) sc.startDescription = s; if (v) sc.voteDescription = v; if (sh) sc.shutdownDescription = sh; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Descriptions saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_s_images')    { const sc = getSessionConfig(guildId); const si = interaction.fields.getTextInputValue('s_start_img').trim(); const vi = interaction.fields.getTextInputValue('s_vote_img').trim(); const hi = interaction.fields.getTextInputValue('s_shutdown_img').trim(); if (si) sc.startImage = si; if (vi) sc.voteImage = vi; if (hi) sc.shutdownImage = hi; await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Images saved!', flags: MessageFlags.Ephemeral }); }
      if (mid === 'modal_s_threshold') { const num = parseInt(interaction.fields.getTextInputValue('s_threshold_val').trim(), 10); if (isNaN(num) || num < 1 || num > 999) return interaction.reply({ content: '❌ Enter a number 1-999.', flags: MessageFlags.Ephemeral }); getSessionConfig(guildId).voteThreshold = num; await saveGuildConfig(guildId); return interaction.reply({ content: `✅ Vote threshold: **${num}**.`, flags: MessageFlags.Ephemeral }); }

      // ── Announcement ──
      if (mid === 'modal_an_new') {
        const ac = getAnnouncementConfig(guildId);
        const name = interaction.fields.getTextInputValue('an_name').trim();
        if (Object.values(ac.types).some(t => t.name.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `❌ **${name}** already exists.`, flags: MessageFlags.Ephemeral });
        const tid = genId();
        ac.types[tid] = { name, emoji: interaction.fields.getTextInputValue('an_emoji').trim() || null, title: interaction.fields.getTextInputValue('an_title').trim(), description: interaction.fields.getTextInputValue('an_desc').trim() || null, color: interaction.fields.getTextInputValue('an_color').trim() || '#ED4245', channel: null, pingRole: null, image: null };
        await saveGuildConfig(guildId); return interaction.reply({ ...buildAnnouncementEditor(guildId, tid) });
      }
      if (mid.startsWith('modal_an_content__')) {
        const typeId = mid.replace('modal_an_content__', '');
        const t = getAnnouncementConfig(guildId).types[typeId];
        if (!t) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const title = interaction.fields.getTextInputValue('an_c_title').trim(); const desc = interaction.fields.getTextInputValue('an_c_desc').trim(); const color = interaction.fields.getTextInputValue('an_c_color').trim(); const image = interaction.fields.getTextInputValue('an_c_image').trim(); const emoji = interaction.fields.getTextInputValue('an_c_emoji').trim();
        if (title) t.title = title; if (desc) t.description = desc; if (color) t.color = color; if (image) t.image = image; if (emoji) t.emoji = emoji;
        await saveGuildConfig(guildId); return interaction.update(buildAnnouncementEditor(guildId, typeId));
      }

      // ── Application type: nickname formaat ──
      if (mid.startsWith('modal_apte_nickname__')) {
        const typeId = mid.replace('modal_apte_nickname__', '');
        const ac = getApplicationConfig(guildId);
        const appType = ac.appTypes.find(t => t.id === typeId);
        if (!appType) return interaction.reply({ content: '❌ Type not found.', flags: MessageFlags.Ephemeral });
        const fmt = interaction.fields.getTextInputValue('nickname_format').trim();
        appType.nicknameFormat = fmt || null;
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
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
        await saveGuildConfig(guildId);
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
        if (!['buttons', 'dropdown'].includes(type)) return interaction.reply({ content: '❌ Type must be `dropdown` or `buttons`. Reaction roles are no longer supported.', flags: MessageFlags.Ephemeral });
        const pid = genId();
        src.panels[pid] = { title: interaction.fields.getTextInputValue('sr_title').trim(), description: interaction.fields.getTextInputValue('sr_desc').trim() || null, color: interaction.fields.getTextInputValue('sr_color').trim() || null, thumbnail: null, channel: null, messageId: null, type, max: parseInt(interaction.fields.getTextInputValue('sr_max').trim(), 10) || 0, roles: [] };
        await saveGuildConfig(guildId); return interaction.reply({ ...buildPanelEditor(guildId, pid) });
      }
      if (mid.startsWith('modal_sr_embed__')) {
        const panelId = mid.replace('modal_sr_embed__', '');
        const panel = getSelfRoleConfig(guildId).panels[panelId];
        if (!panel) return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        const t = interaction.fields.getTextInputValue('sr_e_title').trim(); const d = interaction.fields.getTextInputValue('sr_e_desc').trim(); const c = interaction.fields.getTextInputValue('sr_e_color').trim(); const th = interaction.fields.getTextInputValue('sr_e_thumbnail').trim();
        if (t) panel.title = t; if (d) panel.description = d; if (c) panel.color = c; if (th) panel.thumbnail = th;
        await saveGuildConfig(guildId); return interaction.reply({ content: '✅ Panel embed updated!', flags: MessageFlags.Ephemeral });
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
        await saveGuildConfig(guildId); srPendingRoleAdd.delete(interaction.user.id);
        return interaction.reply({ content: `✅ Added <@&${pending.roleId}> to **${panel.title}**!`, flags: MessageFlags.Ephemeral });
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

// Render healthcheck server
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('Bot is running');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
});

//Start: eerst DB verbinden, dan bot inloggen //
(async () => {
  if (!process.env.TOKEN) {
    console.error('❌ FATAL: TOKEN environment variable is not set.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY not set — QOTD AI generation will fall back to the question library.');
  }
  await connectDB();
  await client.login(process.env.TOKEN);
})();
// End of bots
