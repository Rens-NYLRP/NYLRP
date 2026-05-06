const mongoose = require('mongoose');

// ── Guild Config (shared with bot) ────────────────────────
const GuildConfigSchema = new mongoose.Schema({ guildId: String, data: mongoose.Schema.Types.Mixed }, { strict: false });
const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', GuildConfigSchema);

// ── Shifts ────────────────────────────────────────────────
const ShiftSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  userId:    { type: String, required: true, index: true },
  username:  String,
  avatar:    String,
  startTime: { type: Number, required: true },
  endTime:   { type: Number, default: null },
  duration:  { type: Number, default: null },
});
const Shift = mongoose.models.Shift || mongoose.model('Shift', ShiftSchema);

// ── Punishment Logs ───────────────────────────────────────
const PunishmentSchema = new mongoose.Schema({
  guildId:         { type: String, required: true, index: true },
  moderatorId:     String,
  moderatorTag:    String,
  targetUsername:  { type: String, required: true },
  targetRobloxId:  String,
  type:            { type: String, enum: ['warn','kick','ban','tempban','note','bolo'], default: 'warn' },
  reason:          String,
  duration:        String,
  expiresAt:       Number,
  active:          { type: Boolean, default: true },
  createdAt:       { type: Number, default: Date.now, index: true },
});
const Punishment = mongoose.models.Punishment || mongoose.model('Punishment', PunishmentSchema);

// ── ERLC Logs (persistent, never deleted) ─────────────────
const ErlcLogSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  type:      { type: String, enum: ['kill','join','leave','command','modcall','ban','chat'], index: true },
  data:      mongoose.Schema.Types.Mixed,
  timestamp: { type: Number, default: Date.now, index: true },
});
const ErlcLog = mongoose.models.ErlcLog || mongoose.model('ErlcLog', ErlcLogSchema);

// ── LOA / RA Requests ─────────────────────────────────────
const LeaveSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, index: true },
  userId:     String,
  username:   String,
  type:       { type: String, enum: ['loa','ra'], default: 'loa' },
  reason:     String,
  startDate:  Number,
  endDate:    Number,
  status:     { type: String, enum: ['pending','approved','denied'], default: 'pending' },
  reviewedBy: String,
  createdAt:  { type: Number, default: Date.now },
});
const Leave = mongoose.models.Leave || mongoose.model('Leave', LeaveSchema);

// ── Activity Logs (audit trail) ───────────────────────────
const ActivitySchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  userId:    String,
  username:  String,
  action:    String,
  details:   mongoose.Schema.Types.Mixed,
  timestamp: { type: Number, default: Date.now, index: true },
});
const Activity = mongoose.models.Activity || mongoose.model('Activity', ActivitySchema);

// ── Dashboard Roles ───────────────────────────────────────
const DashRoleSchema = new mongoose.Schema({
  guildId:       { type: String, required: true, index: true },
  discordRoleId: String,
  roleName:      String,
  permissions: {
    viewPanel:         { type: Boolean, default: true },
    viewLogs:          { type: Boolean, default: true },
    viewMembers:       { type: Boolean, default: true },
    manageShifts:      { type: Boolean, default: false },
    createPunishments: { type: Boolean, default: false },
    manageLOA:         { type: Boolean, default: false },
    manageSettings:    { type: Boolean, default: false },
    viewErlcPanel:     { type: Boolean, default: false },
    runCommands:       { type: Boolean, default: false },
  },
});
const DashRole = mongoose.models.DashRole || mongoose.model('DashRole', DashRoleSchema);

// ── Warnings (separate from punishment logs) ──────────────
const WarningSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, index: true },
  targetUsername: { type: String, required: true, index: true },
  targetRobloxId: String,
  discordUserId:  String,
  reason:         String,
  issuedBy:       String,
  issuedById:     String,
  dmSent:         { type: Boolean, default: false },
  createdAt:      { type: Number, default: Date.now, index: true },
});
const Warning = mongoose.models.Warning || mongoose.model('Warning', WarningSchema);

// ── Chat Logs ─────────────────────────────────────────────
const ChatLogSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  player:    { type: String, required: true },
  team:      String,
  message:   { type: String, required: true },
  timestamp: { type: Number, default: Date.now, index: true },
});
const ChatLog = mongoose.models.ChatLog || mongoose.model('ChatLog', ChatLogSchema);

// ── Announcements ─────────────────────────────────────────
const AnnouncementSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  channelId:   String,
  channelName: String,
  title:       String,
  content:     { type: String, required: true },
  sentBy:      String,
  createdAt:   { type: Number, default: Date.now, index: true },
});
const Announcement = mongoose.models.Announcement || mongoose.model('Announcement', AnnouncementSchema);

// ── BOLO Board ────────────────────────────────────────────
const BoloEntrySchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  playerName:  { type: String, required: true },
  robloxId:    String,
  reason:      String,
  description: String,
  issuedBy:    String,
  issuedById:  String,
  active:      { type: Boolean, default: true, index: true },
  resolvedBy:  String,
  resolvedAt:  Number,
  createdAt:   { type: Number, default: Date.now, index: true },
});
const BoloEntry = mongoose.models.BoloEntry || mongoose.model('BoloEntry', BoloEntrySchema);

// ── Staff Roster ──────────────────────────────────────────
const RosterMemberSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, index: true },
  discordId:      { type: String, required: true },
  username:       { type: String, required: true },
  robloxUsername: String,
  rank:           { type: String, default: 'Staff' },
  avatar:         String,
  joinedAt:       { type: Number, default: Date.now },
});
const RosterMember = mongoose.models.RosterMember || mongoose.model('RosterMember', RosterMemberSchema);

// ── Session Votes ─────────────────────────────────────────
const SessionVoteSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  startedBy:   String,
  startedById: String,
  startedAt:   { type: Number, default: Date.now },
  endedAt:     Number,
  active:      { type: Boolean, default: true, index: true },
  joinLink:    String,
  votes: [{
    userId:   String,
    username: String,
    at:       { type: Number, default: Date.now },
  }],
});
const SessionVote = mongoose.models.SessionVote || mongoose.model('SessionVote', SessionVoteSchema);

module.exports = {
  GuildConfig, Shift, Punishment, ErlcLog, Leave, Activity, DashRole,
  Warning, ChatLog, Announcement, BoloEntry, RosterMember, SessionVote,
};