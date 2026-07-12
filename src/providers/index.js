"use strict";

// Provider contract — every entry in PROVIDERS implements:
//   id: string — stable key used in the snapshot (renderer + tray key off this)
//   name: string — display name shown in the panel and tray tooltip
//   isAvailable(): boolean — checked once at startup; unavailable providers
//     (tool not installed on this machine) are left out of the snapshot
//   fetchLimitUsage(): Promise<{ ok, error, session, weekly, retryAfterSec? }>
//     — never throws; session/weekly are { percent, resetsAt, severity } | null
//   createLocalStore(): { scan() } — scan() returns the local-cost aggregate
//     ({ today, last7Days, byModel, topProjects, updatedAt }) and may throw
//   readAccountInfo(): { email, organization } | null — never throws
const claude = require("./claude");
const codex = require("./codex");

const PROVIDERS = [claude, codex].filter((p) => p.isAvailable());

module.exports = { PROVIDERS };
