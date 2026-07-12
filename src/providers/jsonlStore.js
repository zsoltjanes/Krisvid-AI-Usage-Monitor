"use strict";

const fs = require("fs");
const path = require("path");

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

function dayKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // YYYY-MM-DD (UTC-based, consistent with timestamps)
}

/**
 * Aggregates usage records ({ date, model, costUsd, tokens, project }) into
 * the snapshot shape the renderer's provider block consumes.
 */
function aggregateRecords(records) {
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

  for (const r of records) {
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

module.exports = { listJsonlFiles, readNewLines, dayKey, aggregateRecords };
