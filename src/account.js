"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

/**
 * Reads the signed-in account's email + organization name from the Claude
 * Code CLI's own config file. Never throws — returns null if unavailable.
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
    };
  } catch {
    return null;
  }
}

module.exports = { readAccountInfo };
