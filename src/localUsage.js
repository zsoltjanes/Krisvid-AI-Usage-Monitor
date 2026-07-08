"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { costForUsage } = require("./pricing");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function listJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Incrementally reads new lines appended to a file since `fromByte`.
 * Returns { lines: string[], newSize: number }.
 */
function readNewLines(filePath, fromByte) {
  const stat = fs.statSync(filePath);
  if (stat.size <= fromByte) {
    // File unchanged or truncated/rotated — if truncated, restart from 0.
    if (stat.size < fromByte) return readNewLines(filePath, 0);
    return { lines: [], newSize: stat.size };
  }
  const fd = fs.openSync(filePath, "r");
  const length = stat.size - fromByte;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, fromByte);
  fs.closeSync(fd);
  const text = buffer.toString("utf8");
  // Only keep complete lines; if the last line has no trailing newline,
  // stop before it so the next incremental read picks it up whole.
  let usableText = text;
  let newSize = stat.size;
  if (!text.endsWith("\n")) {
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) {
      return { lines: [], newSize: fromByte };
    }
    usableText = text.slice(0, lastNl + 1);
    newSize = fromByte + Buffer.byteLength(usableText, "utf8");
  }
  const lines = usableText.split("\n").filter((l) => l.trim().length > 0);
  return { lines, newSize };
}

function projectNameFromPath(filePath) {
  const dir = path.basename(path.dirname(filePath));
  return dir;
}

function dayKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // YYYY-MM-DD (UTC-based, consistent with timestamps)
}

class LocalUsageStore {
  constructor() {
    // path -> { offset, seenIds: Set<string> } — seenIds capped/pruned per file is unnecessary
    // since files are append-only transcripts; dedup key is `${message.id}:${requestId}`.
    this.fileState = new Map();
    this.dedupSeen = new Set();
    this.records = []; // { date, model, cost, tokens, project }
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
    const today = dayKey(new Date().toISOString());
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 6);
    const cutoffKey = dayKey(cutoff.toISOString());

    let todayCost = 0;
    let todayTokens = 0;
    let todayHasUnknownRate = false;

    const byDay = new Map(); // date -> costUsd
    const byModel = new Map(); // model -> { costUsd, tokens }
    const byProject = new Map(); // project -> costUsd

    for (const r of this.records) {
      if (r.date === today) {
        todayTokens += r.tokens;
        if (r.costUsd == null) todayHasUnknownRate = true;
        else todayCost += r.costUsd;
      }

      if (r.date >= cutoffKey) {
        byDay.set(r.date, (byDay.get(r.date) || 0) + (r.costUsd || 0));
      }

      if (r.date >= cutoffKey) {
        const m = byModel.get(r.model) || { costUsd: 0, tokens: 0 };
        m.tokens += r.tokens;
        m.costUsd += r.costUsd || 0;
        byModel.set(r.model, m);
      }

      byProject.set(r.project, (byProject.get(r.project) || 0) + (r.costUsd || 0));
    }

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = dayKey(d.toISOString());
      last7Days.push({ date: key, costUsd: byDay.get(key) || 0 });
    }

    const topProjects = [...byProject.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([project, costUsd]) => ({ project, costUsd }));

    return {
      today: { costUsd: todayCost, tokens: todayTokens, hasUnknownRate: todayHasUnknownRate },
      last7Days,
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
      topProjects,
      updatedAt: new Date().toISOString(),
    };
  }
}

module.exports = { LocalUsageStore, PROJECTS_DIR };
