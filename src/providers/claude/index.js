"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchLimitUsage } = require("./poller");
const { LocalUsageStore } = require("./localUsage");
const { readAccountInfo } = require("./account");

module.exports = {
  id: "claude",
  name: "Claude Code",
  isAvailable: () => fs.existsSync(path.join(os.homedir(), ".claude")),
  fetchLimitUsage,
  createLocalStore: () => new LocalUsageStore(),
  readAccountInfo,
};
