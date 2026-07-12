# Wattsy — AI Usage Monitor (electron)

Wattsy is a lightweight Windows tray app that keeps an eye on your AI coding-agent usage — plan limits and local token/cost stats for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex](https://openai.com/codex/) — without having to run `/usage` yourself.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-green) ![license](https://img.shields.io/badge/license-ISC-lightgrey)

Repo: <https://github.com/zsoltjanes/Wattsy-AI-Usage-Monitor-for-Windows>

## Features

- **Multi-provider** — one block per installed tool (Claude Code, OpenAI Codex), each with its own gauges, stats and account info (ⓘ next to the provider name). Providers whose tool isn't installed are simply not shown.
- **Plan limit gauges** — 5-hour session and weekly quota usage (%), with reset countdowns, refreshed every minute.
- **Local cost/token stats** — reads your own local transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`) and estimates USD cost per model, based on published per-model pricing (including cache-write/cache-read rates).
  - Today's spend + token count
  - Last 7 days as a bar chart
  - Per-model breakdown table (last 7 days)
- **Tray-first UI** — small colored dot in the system tray (green/amber/red by session usage), click to open/minimize a small always-on-top-ish panel. Drag it anywhere; the position is remembered.
- **Bilingual** — Hungarian and English, switchable from the panel's settings (⚙) or the tray's right-click menu.
- **Resilient** — a failed or rate-limited poll never blanks the gauges; it keeps showing the last known values and backs off automatically on HTTP 429.

## How it works

Each provider block is fed independently:

**Claude Code**

1. **Plan limits** — calls Anthropic's OAuth usage endpoint using the access token already stored by the Claude Code CLI in `~/.claude/.credentials.json`. This is the same endpoint the CLI's own `/usage` command and community usage trackers use. It is **not an official, documented API** — Anthropic could change or remove it at any time, in which case this app will just show "unavailable" for the plan-limit gauges while the local stats keep working.
2. **Local token/cost stats** — incrementally scans your own `~/.claude/projects/**/*.jsonl` conversation transcripts (the same files Claude Code itself writes), deduplicates streamed messages, and estimates cost from each response's `usage` block and the model's published pricing. Nothing leaves your machine for this part.

**OpenAI Codex**

Everything comes from local files — no network calls at all. The Codex CLI writes `token_count` events (tokens **and** the rate-limit snapshot it got from the API) into its `~/.codex/sessions/**/*.jsonl` rollout files; the app scans those incrementally for both the gauges and the cost stats. One consequence: the Codex gauges are only as fresh as your last Codex request — if you haven't used Codex in a while, an already-reset window is shown as 0%. The account info (ⓘ) comes from the JWT claims in `~/.codex/auth.json`, decoded locally.

No telemetry, no external servers beyond the one Anthropic endpoint above.

## Installing

**Option A — installer (recommended):**

Download the latest `Wattsy Setup *.exe` from [Releases](../../releases) (or build it yourself, see below) and run it. You'll get a Start Menu entry, an optional desktop shortcut, and can enable "Start at login" from the tray menu once installed.

**Option B — run from source:**

```sh
git clone https://github.com/zsoltjanes/Wattsy-AI-Usage-Monitor-for-Windows.git
cd Wattsy-AI-Usage-Monitor-for-Windows
npm install
npm start
```

Requires Node.js and at least one supported tool installed and logged in: Claude Code (`~/.claude/.credentials.json` exists) and/or OpenAI Codex (`~/.codex` exists).

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
  providers/
    index.js        # provider registry + the provider contract
    jsonlStore.js    # shared incremental JSONL reader + record aggregation
    claude/
      index.js       # Claude Code provider (implements the contract)
      poller.js       # Anthropic OAuth usage endpoint client
      localUsage.js    # transcript scan (~/.claude/projects)
      pricing.js        # per-model $ pricing table
      account.js         # signed-in email/org from ~/.claude.json
    codex/
      index.js       # OpenAI Codex provider (implements the contract)
      localUsage.js   # session rollout scan + rate-limit snapshot (~/.codex/sessions)
      pricing.js       # per-model $ pricing table (GPT-5.x)
      account.js        # email/plan from ~/.codex/auth.json JWT claims
  settings.js         # persisted language preference
  windowState.js       # persisted panel position
  i18n.js               # hu/en string tables (shared by tray + renderer)
  preload.js              # contextBridge IPC surface
renderer/
  index.html / app.js / style.css   # the panel UI (vanilla JS, no framework)
scripts/
  generate-icon.js   # builds build/icon.ico
```

The app is provider-based: everything tool-specific lives under its own directory in `src/providers/`, and `main.js` / the renderer only iterate over the registry in `src/providers/index.js`. Adding another tool (e.g. Gemini CLI) means adding one new provider directory that implements the same contract (`id`, `name`, `isAvailable`, `fetchLimitUsage`, `createLocalStore`, `readAccountInfo`) and registering it in `PROVIDERS` — the panel then stacks one block per provider and the tray icon colors by the worst session usage across providers.

## Configuration

- **Language**: gear icon in the panel, or the tray's right-click menu → *Language*. Persisted to `%APPDATA%/ai-usage/settings.json`.
- **Refresh interval**: settings panel (⚙) → *Refresh interval*, 1–30 minutes, default 3. On an HTTP 429 from the usage endpoint, the app backs off automatically regardless of this setting (respecting `Retry-After` when present, otherwise 5 minutes) instead of retrying on schedule.

## Disclaimer

This project is **not affiliated with or endorsed by Anthropic**. It relies on an undocumented endpoint that the official Claude Code CLI also happens to use; that endpoint could change or disappear without notice. Use at your own risk — no warranty of accuracy for the plan-limit numbers.

## License

[ISC](./LICENSE)
