"use strict";

const { fetchQuota, findQuotaFile } = require("./quota");
const { aggregateRecords } = require("../jsonlStore");

// JetBrains exposes only a shared AI-credit quota locally — no per-request
// cost or token data — so the local store is always an empty aggregate,
// which renders as a $0 today section and blank chart/models.
const emptyStore = { scan: () => aggregateRecords([]) };

module.exports = {
  id: "jetbrains",
  name: "JetBrains AI",
  color: "#f97316",
  isAvailable: () => findQuotaFile() != null,
  fetchLimitUsage: async () => fetchQuota(),
  createLocalStore: () => emptyStore,
  readAccountInfo: () => null,
};
