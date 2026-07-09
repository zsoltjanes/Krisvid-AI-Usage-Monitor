"use strict";

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, shell } = require("electron");
const path = require("path");
const { fetchLimitUsage } = require("./poller");
const { LocalUsageStore } = require("./localUsage");
const { loadSettings, saveSettings, clampPollIntervalMin, DEFAULT_POLL_INTERVAL_MIN } = require("./settings");
const { loadWindowState, saveWindowState } = require("./windowState");
const { getStrings } = require("./i18n");
const { readAccountInfo } = require("./account");

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
const localStore = new LocalUsageStore();

let currentSettings = { lang: "hu", pollIntervalMin: DEFAULT_POLL_INTERVAL_MIN };
let savedWindowState = null;
let moveSaveTimer = null;
let refreshTimerHandle = null;

function getPollIntervalMs() {
  return clampPollIntervalMin(currentSettings.pollIntervalMin) * 60 * 1000;
}

let snapshot = {
  limit: { ok: false, error: "not-loaded", session: null, weekly: null },
  local: null,
  account: null,
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
  const s = snapshot.limit;
  if (!s.session && !s.weekly) {
    return t.trayUnavailable(s.error);
  }
  const sessionPct = formatPercent(s.session?.percent);
  const weeklyPct = formatPercent(s.weekly?.percent);
  const tooltip = t.trayTooltip(sessionPct, weeklyPct);
  return s.ok ? tooltip : `${tooltip}\n(${t.unavailable(s.error)})`;
}

function updateTray() {
  if (!tray) return;
  const percent = snapshot.limit.session?.percent ?? null;
  tray.setImage(makeTrayIcon(percent));
  tray.setToolTip(buildTooltip());
}

function pushToRenderer() {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send("usage:update", snapshot);
  }
}

async function refreshAll() {
  const limit = await fetchLimitUsage();
  if (limit.ok) {
    snapshot.limit = limit;
  } else {
    // A transient failure (rate limit, network blip, momentarily expired
    // token) shouldn't blank out gauges that already have good data — keep
    // the last known session/weekly numbers and just surface the error.
    snapshot.limit = { ...limit, session: snapshot.limit.session, weekly: snapshot.limit.weekly };
  }
  try {
    snapshot.local = localStore.scan();
  } catch {
    // keep previous local snapshot on scan failure
  }
  snapshot.account = readAccountInfo() || snapshot.account;
  snapshot.updatedAt = new Date().toISOString();
  updateTray();
  pushToRenderer();
  return limit;
}

function scheduleNextRefresh() {
  refreshAll()
    .then((limit) => {
      let delay = getPollIntervalMs();
      if (!limit.ok && limit.error === "http-429") {
        const retryMs = limit.retryAfterSec ? limit.retryAfterSec * 1000 : 0;
        delay = Math.max(getPollIntervalMs(), retryMs, RATE_LIMIT_BACKOFF_MS);
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
    height: 620,
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
  app.setAppUserModelId("com.claude.usage-monitor");
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
