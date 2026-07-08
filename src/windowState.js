"use strict";

const fs = require("fs");
const path = require("path");

function statePath(app) {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(app) {
  try {
    const raw = fs.readFileSync(statePath(app), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // no saved position yet — caller falls back to a default placement
  }
  return null;
}

function saveWindowState(app, state) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(statePath(app), JSON.stringify(state), "utf8");
  } catch {
    // best-effort persistence
  }
}

module.exports = { loadWindowState, saveWindowState };
