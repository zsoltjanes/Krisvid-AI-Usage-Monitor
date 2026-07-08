"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function readAccessToken() {
  let raw;
  try {
    raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  } catch {
    return { token: null, error: "credentials-missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: null, error: "credentials-invalid" };
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    return { token: null, error: "credentials-invalid" };
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return { token: null, error: "credentials-expired" };
  }
  return { token: oauth.accessToken, error: null };
}

function pickLimit(limits, kind) {
  if (!Array.isArray(limits)) return null;
  return limits.find((l) => l.kind === kind) || null;
}

/**
 * Fetches and normalizes the plan-limit usage snapshot.
 * Never throws — returns { ok, error, session, weekly, raw }.
 */
async function fetchLimitUsage() {
  const { token, error } = readAccessToken();
  if (!token) {
    return { ok: false, error, session: null, weekly: null };
  }

  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });
  } catch {
    return { ok: false, error: "network-error", session: null, weekly: null };
  }

  if (!res.ok) {
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    return {
      ok: false,
      error: `http-${res.status}`,
      session: null,
      weekly: null,
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "parse-error", session: null, weekly: null };
  }

  try {
    const sessionLimit = pickLimit(data.limits, "session") || data.five_hour;
    const weeklyLimit = pickLimit(data.limits, "weekly_all") || data.seven_day;

    const session = sessionLimit
      ? {
          percent: sessionLimit.percent ?? sessionLimit.utilization ?? null,
          resetsAt: sessionLimit.resets_at ?? sessionLimit.resetsAt ?? null,
          severity: sessionLimit.severity ?? null,
        }
      : null;

    const weekly = weeklyLimit
      ? {
          percent: weeklyLimit.percent ?? weeklyLimit.utilization ?? null,
          resetsAt: weeklyLimit.resets_at ?? weeklyLimit.resetsAt ?? null,
          severity: weeklyLimit.severity ?? null,
        }
      : null;

    return { ok: true, error: null, session, weekly, raw: data };
  } catch {
    return { ok: false, error: "shape-error", session: null, weekly: null };
  }
}

module.exports = { fetchLimitUsage };
