"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");
const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

function readSubscriptionPlan() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const type = parsed.claudeAiOauth && parsed.claudeAiOauth.subscriptionType;
    if (!type) return null;
    return `Claude ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  } catch {
    return null;
  }
}

/**
 * Reads the signed-in account's email + organization name from the Claude
 * Code CLI's own config file, and the subscription plan from its credentials
 * file. Never throws — returns null if unavailable.
 */
function readAccountInfo() {
  try {
    const raw = fs.readFileSync(CLAUDE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const acct = parsed.oauthAccount;
    if (!acct) return null;
    return {
      email: acct.emailAddress || null,
      organization: acct.organizationName || null,
      plan: readSubscriptionPlan(),
    };
  } catch {
    return null;
  }
}

module.exports = { readAccountInfo };
