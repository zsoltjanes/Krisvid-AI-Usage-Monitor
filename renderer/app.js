"use strict";

let currentLang = "hu";
let strings = window.i18n.strings(currentLang);
let latestSnapshot = null;
let currentPollIntervalMin = 3;
let appVersion = null;
let alwaysOnTop = false;
let currentView = "aggregate"; // "aggregate" | provider id

// Collapsed/expanded state per collapsible section, and the selected time
// range for the chart+models block — kept across re-renders (render()
// rebuilds the DOM on every poll) and across app restarts.
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore (e.g. storage disabled)
  }
}
const collapsedSections = loadJson("krisvid-collapsed-sections", {});
let statsRange = loadJson("krisvid-stats-range", "7d"); // "7d" | "24h"

// The preferred tallest window height before the models table starts scrolling
// internally. main.js clamps to a slightly higher hard ceiling so a tall fixed
// area (gauges + chart) can still leave a couple of table rows visible.
const PANEL_MAX_HEIGHT = 640;
// The models table never shrinks below this while scrolling (≈2 rows visible).
const MODELS_MIN_HEIGHT = 76;

// Ask the main process to resize the window to fit the current content, so the
// app is only as tall as what it shows (shorter with the Details section
// collapsed, taller when open). Measured after layout via requestAnimationFrame.
//
// When content fits, the window matches it exactly (no scrollbar anywhere).
// When it would exceed PANEL_MAX_HEIGHT, we cap only the models table's height
// so the window stops at the max and just that table scrolls — everything
// above it (gauges, Details button, today total, chart) stays fixed. The cap
// is dynamic because the fixed content's height varies by view (1–3 providers,
// optional account block), so a static CSS max-height can't know the room left.
function syncWindowHeight() {
  if (!window.usageApi || !window.usageApi.setPanelHeight) return;
  requestAnimationFrame(() => {
    const settingsView = document.getElementById("settingsView");
    if (settingsView && !settingsView.classList.contains("hidden")) {
      // The settings overlay is absolute (inset:0), so it doesn't add to the
      // panel's own height — measure its content directly.
      window.usageApi.setPanelHeight(settingsView.scrollHeight);
      return;
    }
    const panel = document.querySelector(".panel");
    const models = document.querySelector(".models");
    if (models) models.style.maxHeight = "none"; // measure natural height first
    let target = panel.offsetHeight;
    if (models && target > PANEL_MAX_HEIGHT) {
      const chrome = target - models.offsetHeight; // everything except the table
      const modelsHeight = Math.max(MODELS_MIN_HEIGHT, PANEL_MAX_HEIGHT - chrome);
      models.style.maxHeight = `${modelsHeight}px`;
      target = chrome + modelsHeight; // usually PANEL_MAX_HEIGHT; a bit more if chrome is tall
    }
    window.usageApi.setPanelHeight(target);
  });
}

function pctClass(percent) {
  if (percent == null) return "";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "";
}

function fmtPct(p) {
  return p == null ? "n/a" : `${Math.round(p)}%`;
}

// A gauge may name its own label via an i18n key (e.g. JetBrains AI's
// "monthlyQuota"); otherwise fall back to the window's default label.
function gaugeLabel(gauge, fallback) {
  return (gauge && gauge.label && strings[gauge.label]) || fallback;
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

const FALLBACK_CHART_COLOR = "#4a7fd6";

function makeGauge(label, color) {
  const root = el("div", "gauge");
  const labelRow = el("div", "gauge-label");
  const name = el("span", null, label);
  if (color) {
    const dot = el("span", "provider-dot");
    dot.style.background = color;
    name.appendChild(dot);
  }
  labelRow.appendChild(name);
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

/**
 * Cost chart. Each bucket is { date, costUsd, parts, models } where parts is
 * [{ name, color, costUsd }] — one segment per provider, so the combined
 * view shows a stacked bar in each provider's color — and models is
 * [{ model, costUsd }], the per-model cost breakdown for that bucket (shown
 * on hover; falls back to the per-provider breakdown when no model data is
 * available, e.g. JetBrains AI). `granularity` picks between daily buckets
 * (7-day view, date is a YYYY-MM-DD key) and hourly buckets (24h view, date
 * is a full ISO timestamp).
 */
function buildChart(days, granularity = "day") {
  const isHourly = granularity === "hour";
  // Two aligned rows: the bars on top, then the axis labels underneath (a
  // separate row, so labels sit below the chart rather than inside it). Both
  // rows use the same equal-flex column layout so labels line up under bars.
  const chart = el("section", isHourly ? "chart hourly" : "chart");
  const barsRow = el("div", "chart-bars");
  const labelsRow = el("div", "chart-labels");
  const maxCost = Math.max(0.01, ...days.map((d) => d.costUsd));
  days.forEach((d, i) => {
    // The track is the full-height column slot (equal for every bucket); the
    // bar is the colored fill that rises from the bottom by cost. In the
    // hourly view the track is tinted so all 24 equal slots are visible even
    // for empty hours.
    const track = el("div", "chart-track");
    const bar = el("div", "chart-bar");
    const pct = Math.max(2, Math.round((d.costUsd / maxCost) * 100));
    bar.style.height = `${pct}%`;
    const parts = (d.parts || []).filter((p) => p.costUsd > 0);
    for (const p of parts) {
      const seg = el("div", "chart-seg");
      seg.style.flexGrow = p.costUsd;
      seg.style.background = p.color || FALLBACK_CHART_COLOR;
      bar.appendChild(seg);
    }
    track.appendChild(bar);
    const isHour = granularity === "hour";
    const dateObj = isHour ? new Date(d.date) : null;
    const tooltipDate = isHour ? dateObj.toLocaleString(window.i18n.locale(currentLang)) : d.date;
    const lines = [`${tooltipDate}: ${fmtUsd(d.costUsd)}`];
    const models = (d.models || []).filter((m) => m.costUsd > 0);
    if (models.length > 0) lines.push(...models.map((m) => `${m.model}: ${fmtUsd(m.costUsd)}`));
    else if (parts.length > 1) lines.push(...parts.map((p) => `${p.name}: ${fmtUsd(p.costUsd)}`));
    track.title = lines.join("\n"); // hover the whole column, not just the thin fill
    barsRow.appendChild(track);

    // Hourly view: label only every 4th slot (24 labels would be too cramped).
    const labelText = isHour
      ? i % 4 === 0
        ? `${String(dateObj.getHours()).padStart(2, "0")}:00`
        : ""
      : d.date.slice(5); // MM-DD
    labelsRow.appendChild(el("div", "chart-label-cell", labelText));
  });
  chart.append(barsRow, labelsRow);
  return chart;
}

function buildModelsTable(byModel) {
  const models = el("section", "models");
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

/**
 * Wraps `contentEl` in a centered header button (with a chevron) that toggles
 * its visibility. `key` identifies the section for persisting collapsed state
 * across re-renders and app restarts. Everything that belongs to the section —
 * including its own controls, like the range <select> — lives inside
 * `contentEl` so it only shows while expanded.
 */
function makeCollapsible(key, title, contentEl) {
  const wrap = el("section", "collapsible");
  const collapsed = !!collapsedSections[key];
  wrap.classList.toggle("collapsed", collapsed);

  const header = el("div", "collapsible-header");
  const titleRow = el("div", "collapsible-title-row");
  titleRow.append(el("span", "collapsible-chevron", "▾"), el("span", null, title));
  header.appendChild(titleRow);
  header.addEventListener("click", () => {
    collapsedSections[key] = !collapsedSections[key];
    wrap.classList.toggle("collapsed", collapsedSections[key]);
    saveJson("krisvid-collapsed-sections", collapsedSections);
    syncWindowHeight(); // window shrinks when collapsed, grows when expanded
  });

  const body = el("div", "collapsible-body");
  body.appendChild(contentEl);
  wrap.append(header, body);
  return wrap;
}

/**
 * The today-cost + chart + models-table block, with a range <select> (7 days
 * / 24 hours) that swaps the chart and table at once (today's total is
 * range-independent, it's always "today"). `ranges` is { "7d": { days,
 * byModel }, "24h": { days, byModel } }.
 */
function buildStatsSection(todayCostUsd, todayTokens, ranges) {
  const select = document.createElement("select");
  select.className = "range-select";
  for (const [value, label] of [
    ["7d", strings.rangeLast7Days],
    ["24h", strings.rangeLast24Hours],
  ]) {
    const opt = el("option", null, label);
    opt.value = value;
    select.appendChild(opt);
  }
  select.value = statsRange;

  const statsBody = el("div");
  const renderStatsBody = () => {
    const r = ranges[statsRange] || ranges["7d"];
    statsBody.replaceChildren(buildChart(r.days, statsRange === "24h" ? "hour" : "day"), buildModelsTable(r.byModel));
  };
  renderStatsBody();
  select.addEventListener("change", () => {
    statsRange = select.value;
    saveJson("krisvid-stats-range", statsRange);
    renderStatsBody();
    syncWindowHeight(); // row count differs between ranges → height may change
  });

  // The range select belongs to the Details section, so it lives inside the
  // body (right-aligned above the content) and only shows while expanded.
  const selectRow = el("div", "range-select-row");
  selectRow.appendChild(select);

  const body = el("div");
  body.append(selectRow, makeTodaySection(todayCostUsd, todayTokens), statsBody);

  return makeCollapsible("stats", strings.statsTitle, body);
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
  const sessionGauge = makeGauge(gaugeLabel(session, strings.session5h));
  sessionGauge.pct.textContent = fmtPct(session?.percent);
  sessionGauge.bar.style.width = `${Math.min(100, session?.percent ?? 0)}%`;
  sessionGauge.bar.className = `bar-fill ${pctClass(session?.percent)}`;
  sessionGauge.sub.textContent = session
    ? `${fmtReset(session.resetsAt)}${errNote}`
    : isError
      ? strings.unavailable(limit.error)
      : "–";
  gauges.appendChild(sessionGauge.root);

  // Providers without a second window (e.g. JetBrains AI, which only has a
  // monthly quota) leave weekly null — show a single gauge rather than an
  // empty "–" one.
  if (weekly) {
    const weeklyGauge = makeGauge(gaugeLabel(weekly, strings.weeklyQuota));
    weeklyGauge.pct.textContent = fmtPct(weekly.percent);
    weeklyGauge.bar.style.width = `${Math.min(100, weekly.percent ?? 0)}%`;
    weeklyGauge.bar.className = `bar-fill ${pctClass(weekly.percent)}`;
    weeklyGauge.sub.textContent = `${fmtReset(weekly.resetsAt)}${errNote}`;
    gauges.appendChild(weeklyGauge.root);
  }
  root.appendChild(gauges);

  const toParts = (d) => ({ ...d, parts: [{ name: data.name, color: data.color, costUsd: d.costUsd }] });
  root.appendChild(
    buildStatsSection(local ? local.today.costUsd : 0, local ? local.today.tokens : 0, {
      "7d": { days: (local ? local.last7Days : []).map(toParts), byModel: local ? local.byModel : [] },
      "24h": { days: (local ? local.last24Hours : []).map(toParts), byModel: local ? local.byModel24h : [] },
    })
  );
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
    const gauge = makeGauge(p.name, p.color);
    gauge.pct.textContent = fmtPct(session?.percent);
    gauge.bar.style.width = `${Math.min(100, session?.percent ?? 0)}%`;
    gauge.bar.className = `bar-fill ${pctClass(session?.percent)}`;
    const isError = limit && !limit.ok && limit.error !== "not-loaded";
    const parts = [];
    if (session) {
      parts.push(`${gaugeLabel(session, strings.session5h)}: ${fmtReset(session.resetsAt) || fmtPct(session.percent)}`);
    }
    if (weekly) parts.push(`${gaugeLabel(weekly, strings.weeklyQuota)}: ${fmtPct(weekly.percent)}`);
    if (isError) parts.push(strings.unavailable(limit.error));
    gauge.sub.textContent = parts.length > 0 ? parts.join(" · ") : "–";
    gauges.appendChild(gauge.root);
  }
  root.appendChild(gauges);

  let todayCost = 0;
  let todayTokens = 0;
  const byDay = new Map(); // date -> [{ name, color, costUsd }]
  const byDayModel = new Map(); // date -> Map(model -> costUsd), merged across providers
  const byHour = new Map(); // hour bucket -> [{ name, color, costUsd }]
  const byHourModel = new Map(); // hour bucket -> Map(model -> costUsd), merged across providers
  const byModel = [];
  const byModel24h = [];
  const mergeModels = (bucketModelMap, date, models) => {
    if (!bucketModelMap.has(date)) bucketModelMap.set(date, new Map());
    const m = bucketModelMap.get(date);
    for (const entry of models || []) m.set(entry.model, (m.get(entry.model) || 0) + entry.costUsd);
  };
  for (const id of ids) {
    const p = providers[id];
    const local = p.local;
    if (!local) continue;
    todayCost += local.today.costUsd || 0;
    todayTokens += local.today.tokens || 0;
    for (const d of local.last7Days) {
      if (!byDay.has(d.date)) byDay.set(d.date, []);
      byDay.get(d.date).push({ name: p.name, color: p.color, costUsd: d.costUsd });
      mergeModels(byDayModel, d.date, d.models);
    }
    for (const d of local.last24Hours) {
      if (!byHour.has(d.date)) byHour.set(d.date, []);
      byHour.get(d.date).push({ name: p.name, color: p.color, costUsd: d.costUsd });
      mergeModels(byHourModel, d.date, d.models);
    }
    byModel.push(...local.byModel);
    byModel24h.push(...local.byModel24h);
  }

  const toChartDays = (byBucket, byBucketModel) =>
    [...byBucket.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, parts]) => ({
        date,
        costUsd: parts.reduce((sum, p) => sum + p.costUsd, 0),
        parts,
        models: [...(byBucketModel.get(date) || new Map()).entries()]
          .filter(([, costUsd]) => costUsd > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([model, costUsd]) => ({ model, costUsd })),
      }));
  root.appendChild(
    buildStatsSection(todayCost, todayTokens, {
      "7d": { days: toChartDays(byDay, byDayModel), byModel },
      "24h": { days: toChartDays(byHour, byHourModel), byModel: byModel24h },
    })
  );
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
    const t = new Date(snapshot.updatedAt).toLocaleTimeString(window.i18n.locale(currentLang));
    status.textContent = `${strings.updatedAt(t)} (${strings.everyNMinutes(currentPollIntervalMin)})`;
  } else {
    status.textContent = strings.loading;
  }

  syncWindowHeight(); // provider count / row count changes affect content height
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

// The language radios are built from the shared i18n language list so adding a
// language never means touching the markup — each option shows its endonym.
function buildLangOptions() {
  const container = document.getElementById("langOptions");
  container.innerHTML = "";
  for (const { code, label } of window.i18n.languages) {
    const option = el("label", "lang-option");
    const input = el("input");
    input.type = "radio";
    input.name = "lang";
    input.value = code;
    input.checked = code === currentLang;
    input.addEventListener("change", (e) => {
      if (!e.target.checked) return;
      setLanguage(code);
      window.usageApi.setLang(code);
    });
    option.append(input, el("span", null, label));
    container.appendChild(option);
  }
}

function openSettings() {
  for (const radio of document.querySelectorAll('input[name="lang"]')) {
    radio.checked = radio.value === currentLang;
  }
  document.getElementById("intervalSelect").value = String(currentPollIntervalMin);
  document.getElementById("alwaysOnTopCheckbox").checked = alwaysOnTop;
  document.getElementById("settingsView").classList.remove("hidden");
  syncWindowHeight(); // settings content may be taller than the main view
}

function closeSettings() {
  document.getElementById("settingsView").classList.add("hidden");
  syncWindowHeight(); // back to the (usually shorter) main view
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

buildLangOptions();

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
  syncWindowHeight(); // size the window even if the first snapshot isn't in yet
})();
