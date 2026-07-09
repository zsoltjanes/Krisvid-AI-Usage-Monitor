"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { getStrings } = require("./i18n");

contextBridge.exposeInMainWorld("usageApi", {
  onUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("usage:update", handler);
    return () => ipcRenderer.removeListener("usage:update", handler);
  },
  refreshNow: () => ipcRenderer.send("usage:refresh-now"),
  getSnapshot: () => ipcRenderer.invoke("usage:get-snapshot"),
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setLang: (lang) => ipcRenderer.send("settings:set-lang", lang),
  setPollInterval: (minutes) => ipcRenderer.send("settings:set-poll-interval", minutes),
  setAlwaysOnTop: (enabled) => ipcRenderer.send("settings:set-always-on-top", enabled),
  minimize: () => ipcRenderer.send("panel:minimize"),
  openExternal: (url) => ipcRenderer.send("shell:open-external", url),
});

contextBridge.exposeInMainWorld("i18n", {
  strings: (lang) => getStrings(lang),
});
