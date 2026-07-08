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
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setLang: (lang) => ipcRenderer.send("settings:set-lang", lang),
  minimize: () => ipcRenderer.send("panel:minimize"),
});

contextBridge.exposeInMainWorld("i18n", {
  strings: (lang) => getStrings(lang),
});
