"use strict";

let currentLang = "hu";
let strings = window.i18n.strings(currentLang);
let latestSnapshot = null;
let currentPollIntervalMin = 3;
let appVersion = null;
let alwaysOnTop = false;

function pctClass(percent) {
  if (percent == null) return "";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "";
}

function fmtPct(p) {
  return p == null ? "n/a" : `${Math.round(p)}%`;
}

function fmtReset(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = d - now;
  if (diffMs <= 0) return strings.resetsSoon;
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return strings.resetsInDays(days);
  }
  if (hours > 0) return strings.resetsIn(hours, mins);
  return strings.resetsInMinutes(mins);
}

function fmtUsd(v) {
  if (v == null) return "$0.00";
  return `$${v.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ${strings.tokenSuffix}`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K ${strings.tokenSuffix}`;
  return `${n} ${strings.tokenSuffix}`;
}

function applyStaticStrings() {
  document.title = strings.appTitle;
  document.getElementById("appTitle").textContent = strings.appTitle;
  document.getElementById("minimizeBtn").title = strings.minimize;
  document.getElementById("settingsBtn").title = strings.settings;
  document.getElementById("refreshBtn").title = strings.refresh;
  document.getElementById("session5hLabel").textContent = strings.session5h;
  document.getElementById("weeklyQuotaLabel").textContent = strings.weeklyQuota;
  document.getElementById("todayLabel").textContent = strings.todayLabel;
  document.getElementById("costInfoIcon").title = strings.costTooltip;
  document.getElementById("modelsSubtitle").textContent = strings.modelsSubtitle;
  document.getElementById("thModel").textContent = strings.modelHeader;
  document.getElementById("thTokens").textContent = strings.tokensHeader;
  document.getElementById("thCost").textContent = strings.costHeader;
  document.getElementById("settingsTitle").textContent = strings.settings;
  document.getElementById("backBtn").title = strings.back;
  document.getElementById("languageLabel").textContent = strings.language;
  document.getElementById("intervalLabel").textContent = strings.refreshInterval;
  for (const option of document.getElementById("intervalSelect").options) {
    option.textContent = strings.minutesUnit(option.value);
  }
  document.getElementById("windowLabel").textContent = strings.windowSection;
  document.getElementById("alwaysOnTopLabel").textContent = strings.alwaysOnTop;
  document.getElementById("aboutBtnLabel").textContent = `ⓘ ${strings.about}`;
  document.getElementById("aboutCreatedByLabel").textContent = strings.aboutCreatedBy;
  document.getElementById("aboutBuiltWith").textContent = strings.aboutBuiltWith;
  if (appVersion) {
    document.getElementById("aboutVersionLine").textContent = strings.versionLabel(appVersion);
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  const { limit, local, account, updatedAt } = snapshot;

  const emailLine = document.getElementById("accountEmailLine");
  const orgLine = document.getElementById("accountOrgLine");
  if (account && account.email) {
    const emailText = `${strings.emailLabel}: ${account.email}`;
    emailLine.textContent = emailText;
    emailLine.title = emailText;
  } else {
    emailLine.textContent = "–";
    emailLine.title = "";
  }
  if (account && account.organization) {
    const orgText = `${strings.organizationLabel}: ${account.organization}`;
    orgLine.textContent = orgText;
    orgLine.title = orgText;
    orgLine.classList.remove("hidden");
  } else {
    orgLine.classList.add("hidden");
  }

  // limit.session/weekly may carry the last known-good values even when the
  // latest poll failed (see main.js refreshAll) — keep showing them instead
  // of blanking the gauge, and just note the error alongside.
  const session = limit?.session ?? null;
  const weekly = limit?.weekly ?? null;
  const errNote = limit && !limit.ok ? ` · ${strings.unavailable(limit.error)}` : "";

  document.getElementById("sessionPct").textContent = fmtPct(session?.percent);
  const sessionBar = document.getElementById("sessionBar");
  sessionBar.style.width = `${Math.min(100, session?.percent ?? 0)}%`;
  sessionBar.className = `bar-fill ${pctClass(session?.percent)}`;
  document.getElementById("sessionReset").textContent = session
    ? `${fmtReset(session.resetsAt)}${errNote}`
    : limit && !limit.ok
      ? strings.unavailable(limit.error)
      : "–";

  document.getElementById("weeklyPct").textContent = fmtPct(weekly?.percent);
  const weeklyBar = document.getElementById("weeklyBar");
  weeklyBar.style.width = `${Math.min(100, weekly?.percent ?? 0)}%`;
  weeklyBar.className = `bar-fill ${pctClass(weekly?.percent)}`;
  document.getElementById("weeklyReset").textContent = weekly
    ? `${fmtReset(weekly.resetsAt)}${errNote}`
    : "–";

  if (local) {
    document.getElementById("todayCost").textContent = fmtUsd(local.today.costUsd);
    document.getElementById("todayTokens").textContent = fmtTokens(local.today.tokens);

    const chart = document.getElementById("chart");
    chart.innerHTML = "";
    const maxCost = Math.max(0.01, ...local.last7Days.map((d) => d.costUsd));
    for (const d of local.last7Days) {
      const wrap = document.createElement("div");
      wrap.className = "chart-bar-wrap";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      const pct = Math.max(2, Math.round((d.costUsd / maxCost) * 100));
      bar.style.height = `${pct}%`;
      bar.title = `${d.date}: ${fmtUsd(d.costUsd)}`;
      const label = document.createElement("div");
      label.className = "chart-day";
      label.textContent = d.date.slice(5); // MM-DD
      wrap.appendChild(bar);
      wrap.appendChild(label);
      chart.appendChild(wrap);
    }

    const rows = document.getElementById("modelRows");
    rows.innerHTML = "";
    const sortedModels = [...local.byModel].sort((a, b) => b.costUsd - a.costUsd);
    for (const m of sortedModels) {
      const tr = document.createElement("tr");
      const tdModel = document.createElement("td");
      tdModel.textContent = m.model;
      const tdTokens = document.createElement("td");
      tdTokens.textContent = fmtTokens(m.tokens);
      const tdCost = document.createElement("td");
      tdCost.textContent = fmtUsd(m.costUsd);
      tr.appendChild(tdModel);
      tr.appendChild(tdTokens);
      tr.appendChild(tdCost);
      rows.appendChild(tr);
    }
  }

  const status = document.getElementById("statusLine");
  if (updatedAt) {
    const t = new Date(updatedAt).toLocaleTimeString(currentLang === "hu" ? "hu-HU" : "en-US");
    status.textContent = `${strings.updatedAt(t)} (${strings.everyNMinutes(currentPollIntervalMin)})`;
  } else {
    status.textContent = strings.loading;
  }
}

function applyAlwaysOnTop() {
  document.getElementById("alwaysOnTopCheckbox").checked = alwaysOnTop;
}

function setLanguage(lang) {
  if (lang === currentLang) return;
  currentLang = lang;
  strings = window.i18n.strings(lang);
  applyStaticStrings();
  if (latestSnapshot) render(latestSnapshot);
}

function openSettings() {
  document.getElementById("langHuRadio").checked = currentLang === "hu";
  document.getElementById("langEnRadio").checked = currentLang === "en";
  document.getElementById("intervalSelect").value = String(currentPollIntervalMin);
  document.getElementById("alwaysOnTopCheckbox").checked = alwaysOnTop;
  document.getElementById("settingsView").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsView").classList.add("hidden");
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("backBtn").addEventListener("click", closeSettings);
document.getElementById("minimizeBtn").addEventListener("click", () => window.usageApi.minimize());
document.getElementById("alwaysOnTopCheckbox").addEventListener("change", (e) => {
  alwaysOnTop = e.target.checked;
  window.usageApi.setAlwaysOnTop(alwaysOnTop);
});
document.getElementById("refreshBtn").addEventListener("click", () => window.usageApi.refreshNow());

document.getElementById("aboutBtn").addEventListener("click", () => {
  document.getElementById("aboutModal").classList.remove("hidden");
});
document.getElementById("aboutCloseBtn").addEventListener("click", () => {
  document.getElementById("aboutModal").classList.add("hidden");
});
document.getElementById("aboutModalBackdrop").addEventListener("click", () => {
  document.getElementById("aboutModal").classList.add("hidden");
});

for (const link of document.querySelectorAll(".about-row a[data-url]")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    window.usageApi.openExternal(link.dataset.url);
  });
}

for (const radio of document.querySelectorAll('input[name="lang"]')) {
  radio.addEventListener("change", (e) => {
    if (!e.target.checked) return;
    const lang = e.target.value;
    setLanguage(lang);
    window.usageApi.setLang(lang);
  });
}

document.getElementById("intervalSelect").addEventListener("change", (e) => {
  const minutes = parseInt(e.target.value, 10);
  if (!Number.isFinite(minutes)) return;
  currentPollIntervalMin = minutes;
  window.usageApi.setPollInterval(minutes);
  if (latestSnapshot) render(latestSnapshot);
});

window.usageApi.onUpdate((snapshot) => {
  if (snapshot.settings && snapshot.settings.lang && snapshot.settings.lang !== currentLang) {
    currentLang = snapshot.settings.lang;
    strings = window.i18n.strings(currentLang);
    applyStaticStrings();
  }
  if (snapshot.settings && snapshot.settings.pollIntervalMin) {
    currentPollIntervalMin = snapshot.settings.pollIntervalMin;
  }
  if (snapshot.settings && typeof snapshot.settings.alwaysOnTop === "boolean" && snapshot.settings.alwaysOnTop !== alwaysOnTop) {
    alwaysOnTop = snapshot.settings.alwaysOnTop;
    applyAlwaysOnTop();
  }
  render(snapshot);
});

(async () => {
  const settings = await window.usageApi.getSettings();
  if (settings && settings.lang) {
    currentLang = settings.lang;
    strings = window.i18n.strings(currentLang);
  }
  if (settings && settings.pollIntervalMin) {
    currentPollIntervalMin = settings.pollIntervalMin;
  }
  if (settings && typeof settings.alwaysOnTop === "boolean") {
    alwaysOnTop = settings.alwaysOnTop;
  }
  applyStaticStrings();
  applyAlwaysOnTop();
  const snap = await window.usageApi.getSnapshot();
  if (snap && snap.updatedAt) render(snap);

  appVersion = await window.usageApi.getVersion();
  document.getElementById("aboutVersionLine").textContent = strings.versionLabel(appVersion);
})();
