# Wattsy — project notes for Claude Code

Electron tray app that monitors AI coding-agent usage (plan limits + local
token/cost stats). Multi-provider: **Claude Code**, **OpenAI Codex**,
**JetBrains AI** (AI Assistant / Junie).

## Architecture

- `src/main.js` — Electron main: tray icon (logo + severity dot), the panel
  window, polling loop (`refreshAll` / `scheduleNextRefresh`), IPC, settings.
- `src/providers/` — one folder per provider, all implementing the same
  contract documented at the top of `src/providers/index.js`:
  `id`, `name`, `color`, `isAvailable()`, `fetchLimitUsage()`,
  `createLocalStore()`, `readAccountInfo()`. Register new providers in the
  `PROVIDERS` array there.
- `src/providers/jsonlStore.js` — shared helpers for the JSONL-based providers
  (incremental file reads + `aggregateRecords` → the renderer's local shape).
- `src/i18n.js` — all UI strings + the selectable-language list. Single source
  of truth for languages (see below).
- `renderer/app.js` + `renderer/style.css` + `renderer/index.html` — the panel
  UI. Talks to main only through `window.usageApi` / `window.i18n` exposed by
  `src/preload.js` (contextIsolation on, sandbox off).

## Providers — key facts

- **Limit gauges**: `fetchLimitUsage()` returns `{ ok, error, session, weekly }`
  where each gauge is `{ percent, resetsAt, severity, label? }` or null. A
  provider with only one window leaves `weekly` null → the renderer shows a
  single gauge. `label` is an optional i18n key overriding the default gauge
  name (JetBrains uses `"monthlyQuota"` in the session slot).
- **Colors**: Claude `#4a7fd6` (blue), Codex `#10a37f` (green), JetBrains
  `#f97316` (orange). Rendered as a dot after the provider name and as the
  provider's stacked segment in the daily-cost chart.
- **Claude Code**: OAuth token from `~/.claude/.credentials.json` → Anthropic
  usage endpoint (undocumented). Local stats scan `~/.claude/projects/**/*.jsonl`.
- **Codex**: local files only — rate-limit snapshots + token counts in
  `~/.codex/sessions/**/*.jsonl`; account from `~/.codex/auth.json`.
- **JetBrains AI**: local files only — reads the shared AI-credit quota from
  `AIAssistantQuotaManager2.xml` in the JetBrains config dir (Win
  `%APPDATA%/JetBrains/<IDE>`, mac `~/Library/Application Support/JetBrains`,
  Linux `~/.config/JetBrains`), newest IDE wins. The XML `option value` holds
  HTML-entity-encoded JSON; `quotaInfo.current` = credits **used**,
  `.maximum` = cap, `nextRefill.next` = reset. No cost/token data → empty
  chart/models, single "monthly quota" gauge.
- **GitHub Copilot is intentionally NOT integrated** — the only per-user
  real-time source is the `copilot_internal/user` endpoint, which GitHub
  restricts to official clients (ToS-gray). Decided to skip. Do not add it
  without an explicit fresh go-ahead.

## i18n — data-driven, don't hardcode languages

Languages live only in `src/i18n.js`: the `STRINGS` map + the `LANGUAGES`
list (`{ code, label (endonym), locale }`). `SUPPORTED_LANGS`, `DEFAULT_LANG`
(`"hu"`), `isSupportedLang`, `localeFor` derive from it. Supported: hu, en,
de, fr, es. The settings-panel radios are built from `window.i18n.languages`
in `renderer/app.js` (`buildLangOptions`) — adding a language = add a `STRINGS`
block + a `LANGUAGES` entry, nothing else. Validation in `settings.js` and
`main.js` uses `isSupportedLang`. Never reintroduce `=== "en"/"hu"` checks.

## Running / verifying the app (Windows, from Claude Code's shell)

- Launch dev build: `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .`
  The CLI shell sets `ELECTRON_RUN_AS_NODE=1` (electron runs as plain Node and
  crashes on `app.isPackaged`); the `npx electron` shim is unreliable. Use the
  direct exe.
- **Single instance**: only one Wattsy runs at a time. A leaked dev instance
  silently blocks new launches (instant exit, no screenshot written). Find via
  `tasklist //v //fi "IMAGENAME eq electron.exe" //fo csv | grep -i wattsy` and
  kill with `taskkill //fi "WINDOWTITLE eq Wattsy*" //t //f`. The **installed**
  app is `%LOCALAPPDATA%/Programs/Wattsy/Wattsy.exe` (title also "Wattsy") —
  stop it before running the dev build, restart it after. Never kill unrelated
  `electron.exe`.
- **Screenshot to verify UI**: temporarily add an env-guarded hook in `main.js`
  after `scheduleNextRefresh()` that, on `AI_USAGE_SCREENSHOT`, waits ~12s then
  `panel.webContents.capturePage()` → PNG (optionally click `#settingsBtn` via
  `executeJavaScript` first, guarded by another env var, with a ~500ms repaint
  delay). Remove the hook after. Screenshots go to the scratchpad dir.
- **Forcing a view/lang for a screenshot**: edit
  `%APPDATA%/ai-usage/settings.json` (`view`, `lang`) before launching, then
  restore it afterward — test runs otherwise persist stray values.
- **PowerShell is deny-listed** in this project's Bash; use tasklist/taskkill/
  node one-liners. Reading credential stores (e.g. `github-copilot/oauth.json`)
  is blocked by the safety classifier — don't try.

## Conventions

- No telemetry. Only outbound request is the Anthropic usage endpoint; every
  other provider is pure local file reads.
- Polling keeps last-known-good gauge values on a failed/`http-429` poll and
  backs off (see `refreshAll` + `scheduleNextRefresh`).
