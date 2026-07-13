"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Base directory holding one folder per installed JetBrains IDE
 * (e.g. PhpStorm2026.1, IntelliJIdea2025.3). Platform-specific.
 */
function jetbrainsConfigRoot() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "JetBrains");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "JetBrains");
  }
  return path.join(os.homedir(), ".config", "JetBrains");
}

const QUOTA_FILE = path.join("options", "AIAssistantQuotaManager2.xml");

/**
 * Finds the most recently written AIAssistantQuotaManager2.xml across all
 * installed JetBrains IDEs — the AI quota is shared account-wide, so whichever
 * IDE synced last carries the freshest snapshot. Returns null if none exist.
 */
function findQuotaFile() {
  const root = jetbrainsConfigRoot();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, QUOTA_FILE);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best ? best.file : null;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&#9;/g, "\t")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // last, so already-decoded text isn't re-decoded
}

/** Pulls one <option name="X" value="...JSON..."> payload out of the XML. */
function readOption(xml, name) {
  const re = new RegExp(`<option name="${name}" value="([^"]*)"`);
  const m = xml.match(re);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

/**
 * Reads the shared JetBrains AI credit quota from the local IDE cache.
 * There's no separate cost/token data — only the monthly credit gauge and
 * its reset time. Never throws.
 *
 * quotaInfo carries { current, maximum } where `current` is credits already
 * consumed this cycle; nextRefill.next is when a fresh allotment lands.
 */
function fetchQuota() {
  const file = findQuotaFile();
  if (!file) {
    return { ok: false, error: "no-jetbrains-data", session: null, weekly: null };
  }
  let xml;
  try {
    xml = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: "no-jetbrains-data", session: null, weekly: null };
  }

  const quotaInfo = readOption(xml, "quotaInfo");
  const nextRefill = readOption(xml, "nextRefill");
  if (!quotaInfo) {
    return { ok: false, error: "no-jetbrains-data", session: null, weekly: null };
  }

  const maximum = Number(quotaInfo.maximum);
  const current = Number(quotaInfo.current);
  let percent = null;
  if (Number.isFinite(maximum) && maximum > 0 && Number.isFinite(current)) {
    percent = Math.min(100, (current / maximum) * 100);
  } else if (quotaInfo.type && quotaInfo.type !== "Available") {
    percent = 100; // exhausted / not currently available
  }

  const resetIso = nextRefill && nextRefill.next ? nextRefill.next : null;

  return {
    ok: true,
    error: null,
    session: { percent, resetsAt: resetIso, severity: null, label: "monthlyQuota" },
    weekly: null,
  };
}

module.exports = { fetchQuota, findQuotaFile };
