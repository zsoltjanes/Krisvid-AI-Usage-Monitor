"use strict";

// Provider contract — every entry in PROVIDERS implements:
//   id: string — stable key used in the snapshot (renderer + tray key off this)
//   name: string — display name shown in the panel and tray tooltip
//   color: string — the provider's accent color (dot next to the name and
//     its segment in the daily cost chart)
//   isAvailable(): boolean — checked once at startup; unavailable providers
//     (tool not installed on this machine) are left out of the snapshot
//   fetchLimitUsage(): Promise<{ ok, error, session, weekly, retryAfterSec? }>
//     — never throws; session/weekly are { percent, resetsAt, severity } | null
//     and may carry an optional `label` i18n key overriding the default gauge
//     name (e.g. JetBrains AI's monthly quota fills the session slot). A
//     provider with only one window leaves weekly null and it isn't rendered.
//   createLocalStore(): { scan() } — scan() returns the local-cost aggregate
//     ({ today, last7Days, byModel, topProjects, updatedAt }) and may throw
//   readAccountInfo(): { email, organization } | null — never throws
const claude = require("./claude");
const codex = require("./codex");
const jetbrains = require("./jetbrains");

const PROVIDERS = [claude, codex, jetbrains].filter((p) => p.isAvailable());

module.exports = { PROVIDERS };
