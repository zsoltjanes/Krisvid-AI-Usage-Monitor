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

// Hour bucket key: the timestamp floored to the start of its local hour,
// as an ISO string — used to group the last-24h chart/model breakdown.
function hourKey(isoTimestamp) {
  const d = new Date(isoTimestamp);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Aggregates usage records ({ date, timestamp, model, costUsd, tokens,
 * project }) into the snapshot shape the renderer's provider block consumes.
 */
function aggregateRecords(records) {
  const now = new Date();
  const today = dayKey(now.toISOString());
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 6);
  const cutoffKey = dayKey(cutoff.toISOString());
  const cutoff24hMs = now.getTime() - 24 * 60 * 60 * 1000;

  let todayCost = 0;
  let todayTokens = 0;
  let todayHasUnknownRate = false;

  const byDay = new Map(); // date -> costUsd
  const byDayModel = new Map(); // date -> Map(model -> costUsd)
  const byModel = new Map(); // model -> { costUsd, tokens }
  const byProject = new Map(); // project -> costUsd
  const byHour = new Map(); // hour bucket -> costUsd
  const byHourModel = new Map(); // hour bucket -> Map(model -> costUsd)
  const byModel24h = new Map(); // model -> { costUsd, tokens }, last 24h only

  for (const r of records) {
    if (r.date === today) {
      todayTokens += r.tokens;
      if (r.costUsd == null) todayHasUnknownRate = true;
      else todayCost += r.costUsd;
    }

    if (r.date >= cutoffKey) {
      byDay.set(r.date, (byDay.get(r.date) || 0) + (r.costUsd || 0));

      const m = byModel.get(r.model) || { costUsd: 0, tokens: 0 };
      m.tokens += r.tokens;
      m.costUsd += r.costUsd || 0;
      byModel.set(r.model, m);

      if (!byDayModel.has(r.date)) byDayModel.set(r.date, new Map());
      const dm = byDayModel.get(r.date);
      dm.set(r.model, (dm.get(r.model) || 0) + (r.costUsd || 0));
    }

    const ts = Date.parse(r.timestamp || r.date);
    if (!Number.isNaN(ts) && ts >= cutoff24hMs) {
      const hk = hourKey(r.timestamp || r.date);
      byHour.set(hk, (byHour.get(hk) || 0) + (r.costUsd || 0));

      const m24 = byModel24h.get(r.model) || { costUsd: 0, tokens: 0 };
      m24.tokens += r.tokens;
      m24.costUsd += r.costUsd || 0;
      byModel24h.set(r.model, m24);

      if (!byHourModel.has(hk)) byHourModel.set(hk, new Map());
      const hm = byHourModel.get(hk);
      hm.set(r.model, (hm.get(r.model) || 0) + (r.costUsd || 0));
    }

    byProject.set(r.project, (byProject.get(r.project) || 0) + (r.costUsd || 0));
  }

  // Map(model -> costUsd) -> [{ model, costUsd }], highest cost first.
  const modelBreakdown = (map) =>
    map
      ? [...map.entries()]
          .filter(([, costUsd]) => costUsd > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([model, costUsd]) => ({ model, costUsd }))
      : [];

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d.toISOString());
    last7Days.push({ date: key, costUsd: byDay.get(key) || 0, models: modelBreakdown(byDayModel.get(key)) });
  }

  const last24Hours = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    last24Hours.push({ date: key, costUsd: byHour.get(key) || 0, models: modelBreakdown(byHourModel.get(key)) });
  }

  const topProjects = [...byProject.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([project, costUsd]) => ({ project, costUsd }));

  return {
    today: { costUsd: todayCost, tokens: todayTokens, hasUnknownRate: todayHasUnknownRate },
    last7Days,
    last24Hours,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    byModel24h: [...byModel24h.entries()].map(([model, v]) => ({ model, ...v })),
    topProjects,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { listJsonlFiles, readNewLines, dayKey, hourKey, aggregateRecords };
