"use strict";

let currentLang = "hu";
let strings = window.i18n.strings(currentLang);
let latestSnapshot = null;
let currentPollIntervalMin = 3;
let appVersion = null;
let alwaysOnTop = false;
let currentView = "aggregate"; // "aggregate" | provider id

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function makeGauge(label) {
  const root = el("div", "gauge");
  const labelRow = el("div", "gauge-label");
  labelRow.appendChild(el("span", null, label));
  const pct = el("span", null, "–");
  labelRow.appendChild(pct);
  const barWrap = el("div", "bar");
  const bar = el("div", "bar-fill");
  barWrap.appendChild(bar);
  const sub = el("div", "gauge-sub", "–");
  root.append(labelRow, barWrap, sub);
  return { root, pct, bar, sub };
}

function accountLines(account) {
  if (!account) return [];
  const lines = [];
  if (account.email) lines.push(`${strings.emailLabel}: ${account.email}`);
  if (account.organization) lines.push(`${strings.organizationLabel}: ${account.organization}`);
  if (account.plan) lines.push(`${strings.planLabel}: ${account.plan}`);
  return lines;
}

function makeAccountBlock(account) {
  const block = el("div", "account-block");
  for (const line of accountLines(account)) {
    const div = el("div", "account-line", line);
    div.title = line;
    block.appendChild(div);
  }
  return block;
}

function makeTodaySection(costUsd, tokens) {
  const today = el("section", "today");
  const cost = el("div", "today-cost", fmtUsd(costUsd));
  const labelRow = el("div", "today-label-row");
  labelRow.appendChild(el("span", "today-label", strings.todayLabel));
  const info = el("span", "info-icon", "ⓘ");
  info.title = strings.costTooltip;
  labelRow.appendChild(info);
  today.append(cost, labelRow, el("div", "today-tokens", fmtTokens(tokens)));
  return today;
}

function buildChart(days) {
  const chart = el("section", "chart");
  const maxCost = Math.max(0.01, ...days.map((d) => d.costUsd));
  for (const d of days) {
    const wrap = el("div", "chart-bar-wrap");
    const bar = el("div", "chart-bar");
    const pct = Math.max(2, Math.round((d.costUsd / maxCost) * 100));
    bar.style.height = `${pct}%`;
    bar.title = `${d.date}: ${fmtUsd(d.costUsd)}`;
    const label = el("div", "chart-day", d.date.slice(5)); // MM-DD
    wrap.append(bar, label);
    chart.appendChild(wrap);
  }
  return chart;
}

function buildModelsTable(byModel) {
  const models = el("section", "models");
  models.appendChild(el("div", "models-subtitle", strings.modelsSubtitle));
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(
    el("th", null, strings.modelHeader),
    el("th", null, strings.tokensHeader),
    el("th", null, strings.costHeader)
  );
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  // Skip rows with no usage at all — e.g. Claude Code's "<synthetic>"
  // placeholder entries for locally generated (non-API) messages.
  const sortedModels = [...byModel]
    .filter((m) => m.tokens > 0 || m.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
  for (const m of sortedModels) {
    const tr = document.createElement("tr");
    tr.append(el("td", null, m.model), el("td", null, fmtTokens(m.tokens)), el("td", null, fmtUsd(m.costUsd)));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  models.appendChild(table);
  return models;
}

/** Single-provider view: full gauges + that provider's own stats. */
function renderProviderBlock(data) {
  const { limit, local, account } = data;
  const root = el("section", "provider-block");
  // No title row — the view select right above already names the provider;
  // the account info sits at the bottom, above the status line.

  // limit.session/weekly may carry the last known-good values even when the
  // latest poll failed (see main.js refreshAll) — keep showing them instead
  // of blanking the gauge, and just note the error alongside. "not-loaded"
  // is the pre-first-poll placeholder, not an error worth showing.
  const session = limit?.session ?? null;
  const weekly = limit?.weekly ?? null;
  const isError = limit && !limit.ok && limit.error !== "not-loaded";
  const errNote = isError ? ` · ${strings.unavailable(limit.error)}` : "";

  const gauges = el("section", "gauges");
  const sessionGauge = makeGauge(strings.session5h);
  sessionGauge.pct.textContent = fmtPct(session?.percent);
  sessionGauge.bar.style.width = `${Math.min(100, session?.percent ?? 0)}%`;
  sessionGauge.bar.className = `bar-fill ${pctClass(session?.percent)}`;
  sessionGauge.sub.textContent = session
    ? `${fmtReset(session.resetsAt)}${errNote}`
    : isError
      ? strings.unavailable(limit.error)
      : "–";

  const weeklyGauge = makeGauge(strings.weeklyQuota);
  weeklyGauge.pct.textContent = fmtPct(weekly?.percent);
  weeklyGauge.bar.style.width = `${Math.min(100, weekly?.percent ?? 0)}%`;
  weeklyGauge.bar.className = `bar-fill ${pctClass(weekly?.percent)}`;
  weeklyGauge.sub.textContent = weekly ? `${fmtReset(weekly.resetsAt)}${errNote}` : "–";

  gauges.append(sessionGauge.root, weeklyGauge.root);
  root.appendChild(gauges);

  root.appendChild(makeTodaySection(local ? local.today.costUsd : 0, local ? local.today.tokens : 0));
  root.appendChild(buildChart(local ? local.last7Days : []));
  root.appendChild(buildModelsTable(local ? local.byModel : []));
  root.appendChild(makeAccountBlock(account));
  return root;
}

/**
 * Combined view: one compact gauge per provider (limit percentages can't be
 * merged meaningfully) + cost/tokens/chart/models summed across providers.
 */
function renderAggregate(providers, ids) {
  const root = el("section", "provider-block");
  // No title row — the view select right above already names this view.
  const gauges = el("section", "gauges");
  for (const id of ids) {
    const p = providers[id];
    const limit = p.limit || {};
    const session = limit.session ?? null;
    const weekly = limit.weekly ?? null;
    const gauge = makeGauge(p.name);
    gauge.pct.textContent = fmtPct(session?.percent);
    gauge.bar.style.width = `${Math.min(100, session?.percent ?? 0)}%`;
    gauge.bar.className = `bar-fill ${pctClass(session?.percent)}`;
    const isError = limit && !limit.ok && limit.error !== "not-loaded";
    const parts = [];
    if (session) parts.push(`${strings.session5h}: ${fmtReset(session.resetsAt) || fmtPct(session.percent)}`);
    if (weekly) parts.push(`${strings.weeklyQuota}: ${fmtPct(weekly.percent)}`);
    if (isError) parts.push(strings.unavailable(limit.error));
    gauge.sub.textContent = parts.length > 0 ? parts.join(" · ") : "–";
    gauges.appendChild(gauge.root);
  }
  root.appendChild(gauges);

  let todayCost = 0;
  let todayTokens = 0;
  const byDay = new Map(); // date -> costUsd
  const byModel = [];
  for (const id of ids) {
    const local = providers[id].local;
    if (!local) continue;
    todayCost += local.today.costUsd || 0;
    todayTokens += local.today.tokens || 0;
    for (const d of local.last7Days) {
      byDay.set(d.date, (byDay.get(d.date) || 0) + d.costUsd);
    }
    byModel.push(...local.byModel);
  }

  root.appendChild(makeTodaySection(todayCost, todayTokens));
  const chartDays = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, costUsd]) => ({ date, costUsd }));
  root.appendChild(buildChart(chartDays));
  root.appendChild(buildModelsTable(byModel));
  return root;
}

function updateViewSelect(providers, ids) {
  const row = document.querySelector(".view-row");
  const select = document.getElementById("viewSelect");
  if (ids.length < 2) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  select.innerHTML = "";
  const aggregateOpt = el("option", null, strings.combinedView);
  aggregateOpt.value = "aggregate";
  select.appendChild(aggregateOpt);
  for (const id of ids) {
    const opt = el("option", null, providers[id].name);
    opt.value = id;
    select.appendChild(opt);
  }
  select.value = currentView !== "aggregate" && !providers[currentView] ? "aggregate" : currentView;
}

function render(snapshot) {
  latestSnapshot = snapshot;
  const container = document.getElementById("providers");
  const providers = snapshot.providers || {};
  const ids = Object.keys(providers);

  updateViewSelect(providers, ids);

  let view = currentView;
  if (view !== "aggregate" && !providers[view]) view = "aggregate";
  if (ids.length === 1) view = ids[0]; // nothing to combine

  container.innerHTML = "";
  if (view === "aggregate") {
    container.appendChild(renderAggregate(providers, ids));
  } else {
    container.appendChild(renderProviderBlock(providers[view]));
  }

  const status = document.getElementById("statusLine");
  if (snapshot.updatedAt) {
    const t = new Date(snapshot.updatedAt).toLocaleTimeString(currentLang === "hu" ? "hu-HU" : "en-US");
    status.textContent = `${strings.updatedAt(t)} (${strings.everyNMinutes(currentPollIntervalMin)})`;
  } else {
    status.textContent = strings.loading;
  }
}

function applyStaticStrings() {
  document.title = `${strings.appTitle} — ${strings.appTagline}`;
  document.getElementById("appTitle").textContent = strings.appTitle;
  document.getElementById("appTagline").textContent = strings.appTagline;
  document.getElementById("minimizeBtn").title = strings.minimize;
  document.getElementById("settingsBtn").title = strings.settings;
  document.getElementById("refreshBtn").title = strings.refresh;
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
  // The provider view carries its own labels — re-render in the new language.
  if (latestSnapshot) render(latestSnapshot);
}

function applyAlwaysOnTop() {
  document.getElementById("alwaysOnTopCheckbox").checked = alwaysOnTop;
}

function setLanguage(lang) {
  if (lang === currentLang) return;
  currentLang = lang;
  strings = window.i18n.strings(lang);
  applyStaticStrings();
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

document.getElementById("viewSelect").addEventListener("change", (e) => {
  currentView = e.target.value;
  window.usageApi.setView(currentView);
  if (latestSnapshot) render(latestSnapshot);
});

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

function syncSettings(settings) {
  if (!settings) return false;
  let langChanged = false;
  if (settings.lang && settings.lang !== currentLang) {
    currentLang = settings.lang;
    strings = window.i18n.strings(currentLang);
    langChanged = true;
  }
  if (settings.pollIntervalMin) {
    currentPollIntervalMin = settings.pollIntervalMin;
  }
  if (typeof settings.alwaysOnTop === "boolean" && settings.alwaysOnTop !== alwaysOnTop) {
    alwaysOnTop = settings.alwaysOnTop;
    applyAlwaysOnTop();
  }
  if (typeof settings.view === "string") {
    currentView = settings.view;
  }
  return langChanged;
}

window.usageApi.onUpdate((snapshot) => {
  if (syncSettings(snapshot.settings)) {
    applyStaticStrings();
  }
  render(snapshot);
});

(async () => {
  const settings = await window.usageApi.getSettings();
  syncSettings(settings);
  applyStaticStrings();
  applyAlwaysOnTop();
  const snap = await window.usageApi.getSnapshot();
  if (snap) render(snap);

  appVersion = await window.usageApi.getVersion();
  document.getElementById("aboutVersionLine").textContent = strings.versionLabel(appVersion);
})();
