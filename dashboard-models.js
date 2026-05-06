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
  duration:  { type: Number, default: null }, // ms
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
  duration:        String, // for tempban
  expiresAt:       Number,
  active:          { type: Boolean, default: true },
  createdAt:       { type: Number, default: Date.now, index: true },
});
const Punishment = mongoose.models.Punishment || mongoose.model('Punishment', PunishmentSchema);

// ── ERLC Logs (persistent, never deleted) ─────────────────
const ErlcLogSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  type:      { type: String, enum: ['kill','join','leave','command','modcall','ban'], index: true },
  data:      mongoose.Schema.Types.Mixed,
  timestamp: { type: Number, default: Date.now, index: true },
});
const ErlcLog = mongoose.models.ErlcLog || mongoose.model('ErlcLog', ErlcLogSchema);

// ── LOA / RA Requests ─────────────────────────────────────
const LeaveSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  userId:    String,
  username:  String,
  type:      { type: String, enum: ['loa','ra'], default: 'loa' },
  reason:    String,
  startDate: Number,
  endDate:   Number,
  status:    { type: String, enum: ['pending','approved','denied'], default: 'pending' },
  reviewedBy: String,
  createdAt: { type: Number, default: Date.now },
});
const Leave = mongoose.models.Leave || mongoose.model('Leave', LeaveSchema);

// ── Activity Logs (audit trail, never deleted) ────────────
const ActivitySchema = new mongoose.Schema({
  guildId:   { type: String, required: true, index: true },
  userId:    String,
  username:  String,
  action:    String, // e.g. "punishment.create", "shift.start"
  details:   mongoose.Schema.Types.Mixed,
  timestamp: { type: Number, default: Date.now, index: true },
});
const Activity = mongoose.models.Activity || mongoose.model('Activity', ActivitySchema);

// ── Dashboard Roles (permission system) ──────────────────
const DashRoleSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, index: true },
  discordRoleId: String,
  roleName:    String,
  permissions: {
    viewPanel:     { type: Boolean, default: true },
    viewLogs:      { type: Boolean, default: true },
    viewMembers:   { type: Boolean, default: true },
    manageShifts:  { type: Boolean, default: false },
    createPunishments: { type: Boolean, default: false },
    manageLOA:     { type: Boolean, default: false },
    manageSettings:{ type: Boolean, default: false },
    viewErlcPanel: { type: Boolean, default: false },
    runCommands:   { type: Boolean, default: false },
  },
});
const DashRole = mongoose.models.DashRole || mongoose.model('DashRole', DashRoleSchema);

module.exports = { GuildConfig, Shift, Punishment, ErlcLog, Leave, Activity, DashRole };
