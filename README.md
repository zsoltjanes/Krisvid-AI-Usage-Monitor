# Claude Code Usage Monitor for Windows

A lightweight Windows tray app that keeps an eye on your [Claude Code](https://claude.com/claude-code) usage — plan limits and local token/cost stats — without having to run `/usage` yourself.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-green) ![license](https://img.shields.io/badge/license-ISC-lightgrey)

Repo: <https://github.com/zsoltjanes/Claude-Code-Usage-monitor-for-Windows>

## Features

- **Plan limit gauges** — 5-hour session and weekly quota usage (%), with reset countdowns, refreshed every minute.
- **Local cost/token stats** — reads your own `~/.claude/projects/**/*.jsonl` transcripts and estimates USD cost per model, based on published per-model pricing (including 5m/1h cache-write and cache-read multipliers).
  - Today's spend + token count
  - Last 7 days as a bar chart
  - Per-model breakdown table (last 7 days)
- **Tray-first UI** — small colored dot in the system tray (green/amber/red by session usage), click to open/minimize a small always-on-top-ish panel. Drag it anywhere; the position is remembered.
- **Bilingual** — Hungarian and English, switchable from the panel's settings (⚙) or the tray's right-click menu.
- **Resilient** — a failed or rate-limited poll never blanks the gauges; it keeps showing the last known values and backs off automatically on HTTP 429.

## How it works

Two independent data sources feed the panel:

1. **Plan limits** — calls Anthropic's OAuth usage endpoint using the access token already stored by the Claude Code CLI in `~/.claude/.credentials.json`. This is the same endpoint the CLI's own `/usage` command and community usage trackers use. It is **not an official, documented API** — Anthropic could change or remove it at any time, in which case this app will just show "unavailable" for the plan-limit gauges while the local stats keep working.
2. **Local token/cost stats** — incrementally scans your own `~/.claude/projects/**/*.jsonl` conversation transcripts (the same files Claude Code itself writes), deduplicates streamed messages, and estimates cost from each response's `usage` block and the model's published pricing. Nothing leaves your machine for this part.

No telemetry, no external servers beyond the one Anthropic endpoint above.

## Installing

**Option A — installer (recommended):**

Download the latest `Claude Usage Monitor Setup *.exe` from [Releases](../../releases) (or build it yourself, see below) and run it. You'll get a Start Menu entry, an optional desktop shortcut, and can enable "Start at login" from the tray menu once installed.

**Option B — run from source:**

```sh
git clone https://github.com/zsoltjanes/Claude-Code-Usage-monitor-for-Windows.git
cd Claude-Code-Usage-monitor-for-Windows
npm install
npm start
```

Requires Node.js and a Claude Code installation that has already logged in at least once (so `~/.claude/.credentials.json` exists).

> **Running inside Claude Code's own terminal:** the Claude Code CLI sets `ELECTRON_RUN_AS_NODE=1` in its shell, which makes any Electron app run as plain Node and crash with `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`. Unset it first: `env -u ELECTRON_RUN_AS_NODE npm start` (bash) or clear the env var in PowerShell/cmd. A normal terminal window doesn't have this problem.

## Building an installer

```sh
npm run dist
```

This regenerates the app icon (`build/icon.ico`, a small hand-rolled PNG-in-ICO — no image dependency needed) and produces a Windows NSIS installer under `dist/`.

## Project layout

```
src/
  main.js          # app lifecycle, tray, panel window, poll scheduling
  poller.js         # Anthropic OAuth usage endpoint client
  localUsage.js      # incremental JSONL scan + aggregation
  pricing.js         # per-model $ pricing table
  settings.js         # persisted language preference
  windowState.js       # persisted panel position
  i18n.js               # hu/en string tables (shared by tray + renderer)
  preload.js              # contextBridge IPC surface
renderer/
  index.html / app.js / style.css   # the panel UI (vanilla JS, no framework)
scripts/
  generate-icon.js   # builds build/icon.ico
```

## Configuration

- **Language**: gear icon in the panel, or the tray's right-click menu → *Language*. Persisted to `%APPDATA%/ai-usage/settings.json`.
- **Poll interval**: fixed at 1 minute (`POLL_INTERVAL_MS` in `src/main.js`). On an HTTP 429 from the usage endpoint, the app backs off automatically (respecting `Retry-After` when present, otherwise 5 minutes) instead of retrying every minute.

## Disclaimer

This project is **not affiliated with or endorsed by Anthropic**. It relies on an undocumented endpoint that the official Claude Code CLI also happens to use; that endpoint could change or disappear without notice. Use at your own risk — no warranty of accuracy for the plan-limit numbers.

## License

[ISC](./LICENSE)
