"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { CodexUsageStore, SESSIONS_DIR } = require("./localUsage");
const { readAccountInfo } = require("./account");

// Limits and local usage come from the same session files, so one store
// backs both contract members.
const store = new CodexUsageStore();

module.exports = {
  id: "codex",
  name: "Codex",
  isAvailable: () => fs.existsSync(path.join(os.homedir(), ".codex")) || fs.existsSync(SESSIONS_DIR),
  fetchLimitUsage: async () => {
    try {
      store.scan();
    } catch {
      // limitUsage() below just reports the last known state
    }
    return store.limitUsage();
  },
  createLocalStore: () => store,
  readAccountInfo,
};
