"use strict";

const path = require("path");
const os = require("os");
const { costForUsage } = require("./pricing");
const { listJsonlFiles, readNewLines, dayKey, aggregateRecords } = require("../jsonlStore");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function projectNameFromPath(filePath) {
  const dir = path.basename(path.dirname(filePath));
  return dir;
}

class LocalUsageStore {
  constructor() {
    // path -> { offset } — files are append-only transcripts; dedup key for
    // streamed messages is `${message.id}:${requestId}`.
    this.fileState = new Map();
    this.dedupSeen = new Set();
    this.records = []; // { date, model, costUsd, tokens, project }
  }

  scan() {
    const files = listJsonlFiles(PROJECTS_DIR);
    for (const file of files) {
      this._scanFile(file);
    }
    return this.aggregate();
  }

  _scanFile(filePath) {
    const prev = this.fileState.get(filePath) || { offset: 0 };
    let result;
    try {
      result = readNewLines(filePath, prev.offset);
    } catch {
      return;
    }
    this.fileState.set(filePath, { offset: result.newSize });
    if (result.lines.length === 0) return;

    const project = projectNameFromPath(filePath);

    for (const line of result.lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "assistant" || !entry.message || !entry.message.usage) continue;

      const dedupKey = `${entry.message.id || ""}:${entry.requestId || ""}`;
      if (dedupKey !== ":" && this.dedupSeen.has(dedupKey)) continue;
      if (dedupKey !== ":") this.dedupSeen.add(dedupKey);

      const model = entry.message.model;
      const usage = entry.message.usage;
      const { costUsd } = costForUsage(model, usage);
      const totalTokens =
        (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0);

      this.records.push({
        date: dayKey(entry.timestamp || new Date().toISOString()),
        model: model || "unknown",
        costUsd,
        tokens: totalTokens,
        project,
      });
    }
  }

  aggregate() {
    return aggregateRecords(this.records);
  }
}

module.exports = { LocalUsageStore, PROJECTS_DIR };
