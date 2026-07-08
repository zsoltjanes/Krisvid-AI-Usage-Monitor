"use strict";

const fs = require("fs");
const path = require("path");

function settingsPath(app) {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(app) {
  try {
    const raw = fs.readFileSync(settingsPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return { lang: parsed.lang === "en" ? "en" : "hu" };
  } catch {
    return { lang: "hu" };
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

module.exports = { loadSettings, saveSettings };
