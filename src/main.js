"use strict";

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, shell } = require("electron");
const path = require("path");
const { PROVIDERS } = require("./providers");
const { loadSettings, saveSettings, clampPollIntervalMin, DEFAULT_POLL_INTERVAL_MIN } = require("./settings");
const { loadWindowState, saveWindowState } = require("./windowState");
const { getStrings } = require("./i18n");

if (!app.isPackaged) {
  try {
    require("electron-reloader")(module, { ignore: ["dist", "build", "scripts"] });
  } catch {
    // dev dependency not installed — live reload just stays off
  }
}

const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000; // fallback backoff on HTTP 429 without Retry-After
const MOVE_SAVE_DEBOUNCE_MS = 400;

let tray = null;
let panel = null;
const providerRuntimes = PROVIDERS.map((provider) => ({
  provider,
  localStore: provider.createLocalStore(),
}));

let currentSettings = { lang: "hu", pollIntervalMin: DEFAULT_POLL_INTERVAL_MIN, alwaysOnTop: false, view: "aggregate" };
let savedWindowState = null;
let moveSaveTimer = null;
let refreshTimerHandle = null;

function getPollIntervalMs() {
  return clampPollIntervalMin(currentSettings.pollIntervalMin) * 60 * 1000;
}

function emptyProviderSnapshot(provider) {
  return {
    name: provider.name,
    limit: { ok: false, error: "not-loaded", session: null, weekly: null },
    local: null,
    account: null,
  };
}

let snapshot = {
  providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, emptyProviderSnapshot(p)])),
  settings: currentSettings,
  updatedAt: null,
};

// Single instance — clicking a second launch focuses the existing tray panel.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function trayStrings() {
  return getStrings(currentSettings.lang);
}

function severityColor(percent) {
  if (percent == null) return [128, 128, 128];
  if (percent >= 90) return [220, 60, 60];
  if (percent >= 70) return [230, 160, 40];
  return [70, 170, 90];
}

function makeTrayIcon(percent) {
  const size = 16;
  const [r, g, b] = severityColor(percent);
  const buffer = Buffer.alloc(size * size * 4);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const radius = size / 2 - 1.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const inside = dx * dx + dy * dy <= radius * radius;
      if (inside) {
        buffer[idx] = b; // BGRA
        buffer[idx + 1] = g;
        buffer[idx + 2] = r;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function formatPercent(p) {
  return p == null ? "n/a" : `${Math.round(p)}%`;
}

function buildTooltip() {
  const t = trayStrings();
  const blocks = Object.values(snapshot.providers).map((p) => {
    const s = p.limit;
    if (!s.session && !s.weekly) {
      return `${p.name} — ${t.unavailable(s.error)}`;
    }
    const lines = `${p.name}\n${t.session5h}: ${formatPercent(s.session?.percent)}\n${t.weeklyQuota}: ${formatPercent(s.weekly?.percent)}`;
    return s.ok ? lines : `${lines}\n(${t.unavailable(s.error)})`;
  });
  return blocks.join("\n\n") || t.trayLoading;
}

function worstSessionPercent() {
  let worst = null;
  for (const p of Object.values(snapshot.providers)) {
    const pct = p.limit.session?.percent;
    if (pct != null && (worst == null || pct > worst)) worst = pct;
  }
  return worst;
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(worstSessionPercent()));
  tray.setToolTip(buildTooltip());
}

function pushToRenderer() {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send("usage:update", snapshot);
  }
}

async function refreshAll() {
  const limits = await Promise.all(
    providerRuntimes.map(async ({ provider, localStore }) => {
      const prev = snapshot.providers[provider.id];
      const next = { ...prev };
      const limit = await provider.fetchLimitUsage();
      // A transient failure (rate limit, network blip, momentarily expired
      // token) shouldn't blank out gauges that already have good data — keep
      // the last known session/weekly numbers and just surface the error.
      next.limit = limit.ok
        ? limit
        : { ...limit, session: prev.limit.session, weekly: prev.limit.weekly };
      try {
        next.local = localStore.scan();
      } catch {
        // keep previous local snapshot on scan failure
      }
      next.account = provider.readAccountInfo() || prev.account;
      snapshot.providers[provider.id] = next;
      return next.limit;
    })
  );
  snapshot.updatedAt = new Date().toISOString();
  updateTray();
  pushToRenderer();
  return limits;
}

function scheduleNextRefresh() {
  refreshAll()
    .then((limits) => {
      let delay = getPollIntervalMs();
      for (const limit of limits) {
        if (!limit.ok && limit.error === "http-429") {
          const retryMs = limit.retryAfterSec ? limit.retryAfterSec * 1000 : 0;
          delay = Math.max(delay, retryMs, RATE_LIMIT_BACKOFF_MS);
        }
      }
      refreshTimerHandle = setTimeout(scheduleNextRefresh, delay);
    })
    .catch(() => {
      refreshTimerHandle = setTimeout(scheduleNextRefresh, getPollIntervalMs());
    });
}

function setPollInterval(minutes) {
  const clamped = clampPollIntervalMin(minutes);
  if (clamped === currentSettings.pollIntervalMin) return;
  currentSettings = { ...currentSettings, pollIntervalMin: clamped };
  saveSettings(app, currentSettings);
  snapshot.settings = currentSettings;
  pushToRenderer();
  // Re-time the next poll from now using the new interval, without forcing
  // an immediate extra request (important right after a 429 backoff).
  if (refreshTimerHandle) {
    clearTimeout(refreshTimerHandle);
    refreshTimerHandle = setTimeout(scheduleNextRefresh, getPollIntervalMs());
  }
}

function buildContextMenu() {
  const t = trayStrings();
  return Menu.buildFromTemplate([
    { label: t.refreshNow, click: () => refreshAll() },
    {
      label: t.startAtLogin,
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: "separator" },
    { label: t.quit, click: () => app.quit() },
  ]);
}

function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(buildContextMenu());
}

function setAlwaysOnTop(enabled) {
  const value = Boolean(enabled);
  if (value === currentSettings.alwaysOnTop) return;
  currentSettings = { ...currentSettings, alwaysOnTop: value };
  saveSettings(app, currentSettings);
  if (panel && !panel.isDestroyed()) panel.setAlwaysOnTop(value);
  snapshot.settings = currentSettings;
  pushToRenderer();
}

function setView(view) {
  const valid = view === "aggregate" || PROVIDERS.some((p) => p.id === view);
  if (!valid || view === currentSettings.view) return;
  currentSettings = { ...currentSettings, view };
  saveSettings(app, currentSettings);
  snapshot.settings = currentSettings;
  pushToRenderer();
}

function setLanguage(lang) {
  if (lang !== "en" && lang !== "hu") return;
  currentSettings = { ...currentSettings, lang };
  saveSettings(app, currentSettings);
  rebuildTrayMenu();
  updateTray();
  snapshot.settings = currentSettings;
  pushToRenderer();
}

function createPanel() {
  const opts = {
    width: 380,
    // Only one view (a single provider or the combined one) is shown at a
    // time, so the height no longer depends on how many providers there are.
    height: 700,
    show: false,
    frame: false,
    resizable: false,
    minimizable: true,
    fullscreenable: false,
    // Visible in the taskbar so a real OS minimize has somewhere to restore from.
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The default sandboxed preload can't require() local relative modules
      // (blocks preload's own `require("./i18n")`), which silently kills the
      // whole preload script and everything that depends on it. This app only
      // ever loads trusted local file:// content, so disabling the sandbox
      // for the preload is safe.
      sandbox: false,
    },
  };
  if (savedWindowState) {
    opts.x = savedWindowState.x;
    opts.y = savedWindowState.y;
  }
  panel = new BrowserWindow(opts);
  panel.setAlwaysOnTop(Boolean(currentSettings.alwaysOnTop));
  panel.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  panel.webContents.on("console-message", (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  panel.webContents.on("did-fail-load", (_event, code, desc) => {
    console.log(`[renderer] did-fail-load ${code} ${desc}`);
  });

  // Persist the dragged-to position (debounced) so it's restored on next launch.
  panel.on("move", () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (!panel || panel.isDestroyed() || panel.isMinimized()) return;
      const [x, y] = panel.getPosition();
      savedWindowState = { x, y };
      saveWindowState(app, savedWindowState);
    }, MOVE_SAVE_DEBOUNCE_MS);
  });
}

function positionPanelNearTray(bounds) {
  if (!panel) return;
  const { workArea } = screen.getPrimaryDisplay();
  const panelBounds = panel.getBounds();
  let x = Math.round(bounds.x + bounds.width / 2 - panelBounds.width / 2);
  let y = Math.round(bounds.y - panelBounds.height);
  if (y < workArea.y) {
    // Taskbar likely at top or tray in an unusual spot — fall back below.
    y = Math.round(bounds.y + bounds.height);
  }
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - panelBounds.width));
  panel.setPosition(x, y);
}

function togglePanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  if (!panel.isVisible()) {
    if (!savedWindowState) positionPanelNearTray(tray.getBounds());
    panel.show();
    panel.focus();
    pushToRenderer();
    return;
  }
  if (panel.isMinimized()) {
    panel.restore();
    panel.focus();
    return;
  }
  panel.minimize();
}

function createTray() {
  tray = new Tray(makeTrayIcon(null));
  tray.setToolTip(trayStrings().trayLoading);
  tray.on("click", togglePanel);
  rebuildTrayMenu();
}

app.on("second-instance", () => {
  if (tray) togglePanel();
});

app.whenReady().then(() => {
  app.setAppUserModelId("com.janes.wattsy");
  currentSettings = loadSettings(app);
  savedWindowState = loadWindowState(app);
  snapshot.settings = currentSettings;

  createTray();
  createPanel();

  // Stay visible on screen at all times — no auto-hide on blur. The user
  // can drag it, minimize it (real OS minimize/restore via taskbar), or
  // click the tray icon to toggle minimize/restore.
  if (!savedWindowState) positionPanelNearTray(tray.getBounds());
  panel.show();

  ipcMain.on("usage:refresh-now", () => refreshAll());
  ipcMain.handle("usage:get-snapshot", () => snapshot);
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("settings:get", () => currentSettings);
  ipcMain.on("settings:set-lang", (_event, lang) => setLanguage(lang));
  ipcMain.on("settings:set-poll-interval", (_event, minutes) => setPollInterval(minutes));
  ipcMain.on("settings:set-always-on-top", (_event, enabled) => setAlwaysOnTop(enabled));
  ipcMain.on("settings:set-view", (_event, view) => setView(view));
  ipcMain.on("panel:minimize", () => {
    if (panel && !panel.isDestroyed()) panel.minimize();
  });
  ipcMain.on("shell:open-external", (_event, url) => {
    // Only ever open the app's own known links, never an arbitrary
    // renderer-supplied URL.
    const allowed = ["https://janes.hu", "mailto:hello@janes.hu"];
    if (allowed.includes(url)) shell.openExternal(url);
  });

  scheduleNextRefresh();
});

// No app.quit() here on purpose — the app lives in the tray even with no
// windows open.
app.on("window-all-closed", () => {});
