"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

function planLabel(planType) {
  if (!planType) return null;
  return `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
}

/**
 * Reads the signed-in account's email, organization and plan from the Codex
 * CLI's auth.json. They live in the OAuth id_token's JWT claims — decoded
 * locally, never verified or sent anywhere. Never throws — returns null if
 * unavailable.
 */
function readAccountInfo() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const idToken = parsed.tokens && parsed.tokens.id_token;
    if (!idToken) return null;
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    const auth = claims["https://api.openai.com/auth"] || {};
    const orgs = Array.isArray(auth.organizations) ? auth.organizations : [];
    const defaultOrg = orgs.find((o) => o.is_default) || orgs[0] || null;
    return {
      email: claims.email || null,
      organization: defaultOrg ? defaultOrg.title || null : null,
      plan: planLabel(auth.chatgpt_plan_type),
    };
  } catch {
    return null;
  }
}

module.exports = { readAccountInfo };
