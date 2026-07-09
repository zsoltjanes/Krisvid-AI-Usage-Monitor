"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_POLL_INTERVAL_MIN = 3;
const MIN_POLL_INTERVAL_MIN = 1;
const MAX_POLL_INTERVAL_MIN = 60;

function settingsPath(app) {
  return path.join(app.getPath("userData"), "settings.json");
}

function clampPollIntervalMin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL_MIN;
  return Math.min(MAX_POLL_INTERVAL_MIN, Math.max(MIN_POLL_INTERVAL_MIN, Math.round(n)));
}

function loadSettings(app) {
  try {
    const raw = fs.readFileSync(settingsPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return {
      lang: parsed.lang === "en" ? "en" : "hu",
      pollIntervalMin: clampPollIntervalMin(parsed.pollIntervalMin ?? DEFAULT_POLL_INTERVAL_MIN),
      alwaysOnTop: Boolean(parsed.alwaysOnTop),
    };
  } catch {
    return { lang: "hu", pollIntervalMin: DEFAULT_POLL_INTERVAL_MIN, alwaysOnTop: false };
  }
}

function saveSettings(app, settings) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsPath(app), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // best-effort persistence; a failed write just means the setting resets next launch
  }
}

module.exports = {
  loadSettings,
  saveSettings,
  clampPollIntervalMin,
  DEFAULT_POLL_INTERVAL_MIN,
  MIN_POLL_INTERVAL_MIN,
  MAX_POLL_INTERVAL_MIN,
};
