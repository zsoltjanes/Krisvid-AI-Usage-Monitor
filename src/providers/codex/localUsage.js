"use strict";

const path = require("path");
const os = require("os");
const { costForUsage } = require("./pricing");
const { listJsonlFiles, readNewLines, dayKey, aggregateRecords } = require("../jsonlStore");

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

/**
 * Scans Codex CLI session rollout files (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
 * Two things come out of the same files:
 *  - usage records from each token_count event's last_token_usage (per request)
 *  - the newest rate_limits snapshot, which doubles as the plan-limit source
 *    (Codex has no separately pollable usage endpoint; the CLI itself learns
 *    its limits from API response headers and writes them into these events).
 */
class CodexUsageStore {
  constructor() {
    // path -> { offset, model, project } — model comes from turn_context
    // events and applies to the token_count events that follow it.
    this.fileState = new Map();
    this.records = []; // { date, model, costUsd, tokens, project }
    this.latestLimits = null; // { atMs, rateLimits }
  }

  scan() {
    const files = listJsonlFiles(SESSIONS_DIR);
    for (const file of files) {
      this._scanFile(file);
    }
    return this.aggregate();
  }

  _scanFile(filePath) {
    const prev = this.fileState.get(filePath) || { offset: 0, model: null, project: null };
    let result;
    try {
      result = readNewLines(filePath, prev.offset);
    } catch {
      return;
    }
    const state = { offset: result.newSize, model: prev.model, project: prev.project };
    this.fileState.set(filePath, state);
    if (result.lines.length === 0) return;

    for (const line of result.lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry.payload;
      if (!payload) continue;

      if (entry.type === "session_meta" && payload.cwd) {
        state.project = path.basename(payload.cwd);
        continue;
      }
      if (entry.type === "turn_context" && payload.model) {
        state.model = payload.model;
        continue;
      }
      if (entry.type !== "event_msg" || payload.type !== "token_count") continue;

      if (payload.rate_limits) {
        const atMs = Date.parse(entry.timestamp || "") || 0;
        if (!this.latestLimits || atMs >= this.latestLimits.atMs) {
          this.latestLimits = { atMs, rateLimits: payload.rate_limits };
        }
      }

      const usage = payload.info && payload.info.last_token_usage;
      if (!usage) continue;
      const { costUsd } = costForUsage(state.model, usage);
      const timestamp = entry.timestamp || new Date().toISOString();
      this.records.push({
        date: dayKey(timestamp),
        timestamp,
        model: state.model || "unknown",
        costUsd,
        tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
        project: state.project || "unknown",
      });
    }
  }

  aggregate() {
    return aggregateRecords(this.records);
  }

  /**
   * Plan-limit snapshot from the newest rate_limits seen in the session
   * files. A window whose reset time has already passed is reported as 0%
   * (the stale percentage no longer reflects reality).
   */
  limitUsage() {
    if (!this.latestLimits) {
      return { ok: false, error: "no-codex-data", session: null, weekly: null };
    }
    const { primary, secondary } = this.latestLimits.rateLimits;
    const toGauge = (win) => {
      if (!win || win.used_percent == null) return null;
      const resetMs = win.resets_at ? win.resets_at * 1000 : null;
      const expired = resetMs != null && resetMs <= Date.now();
      return {
        percent: expired ? 0 : win.used_percent,
        resetsAt: expired || resetMs == null ? null : new Date(resetMs).toISOString(),
        severity: null,
      };
    };
    return { ok: true, error: null, session: toGauge(primary), weekly: toGauge(secondary) };
  }
}

module.exports = { CodexUsageStore, SESSIONS_DIR };
