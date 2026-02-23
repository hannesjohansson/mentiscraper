import { parseCsvFile } from "./csv.js";
import { detectUrlColumn } from "./url_detect.js";

const fileInput = document.getElementById("csvFile");
const workflowSectionEl = document.getElementById("workflowSection");
const statusCardEl = document.getElementById("statusCard");
const logCardEl = document.getElementById("logCard");
const advancedSettingsEl = document.getElementById("advancedSettings");
const urlColumnSelect = document.getElementById("urlColumn");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const downloadBtn = document.getElementById("downloadBtn");
const concurrencyInputEl = document.getElementById("concurrencyInput");
const minDelayInputEl = document.getElementById("minDelayInput");
const maxDelayInputEl = document.getElementById("maxDelayInput");
const settingsSummaryEl = document.getElementById("settingsSummary");
const logEl = document.getElementById("log");
const statusTitleEl = document.getElementById("statusTitle");
const modeBadgeEl = document.getElementById("modeBadge");
const progressFillEl = document.getElementById("progressFill");
const mDoneEl = document.getElementById("mDone");
const mSuccessEl = document.getElementById("mSuccess");
const mFailedEl = document.getElementById("mFailed");
const mQueuedEl = document.getElementById("mQueued");
const mRateEl = document.getElementById("mRate");
const mEtaEl = document.getElementById("mEta");
const successBannerEl = document.getElementById("successBanner");

let rows = [];
let pollTimer = null;
let isPaused = false;
let isRunning = false;
let uiStage = "pre";
const RUN_DEFAULTS = {
  concurrency: 2,
  minDelayMs: 300,
  maxDelayMs: 1600
};

function log(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setModeBadge(mode) {
  modeBadgeEl.className = "badge";
  if (mode === "Running") modeBadgeEl.classList.add("running");
  else if (mode === "Paused") modeBadgeEl.classList.add("paused");
  else if (mode === "Completed") modeBadgeEl.classList.add("completed");
  else modeBadgeEl.classList.add("idle");
  modeBadgeEl.textContent = mode;
  statusTitleEl.textContent = mode;
}

function renderIdleState() {
  setModeBadge("Idle");
  progressFillEl.style.width = "0%";
  statusCardEl.classList.remove("completed");
  successBannerEl.classList.add("hidden");
  successBannerEl.textContent = "";
  downloadBtn.classList.remove("btn-success");
  downloadBtn.classList.add("btn-secondary");
  mDoneEl.textContent = "0/0";
  mSuccessEl.textContent = "0";
  mFailedEl.textContent = "0";
  mQueuedEl.textContent = "0";
  mRateEl.textContent = "0.00/m";
  mEtaEl.textContent = "n/a";
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readRunSettings(normalizeInputs = false) {
  const concurrencyRaw = Number(concurrencyInputEl.value);
  const minRaw = Number(minDelayInputEl.value);
  const maxRaw = Number(maxDelayInputEl.value);

  const settings = {
    concurrency: clampInt(
      Number.isFinite(concurrencyRaw) ? concurrencyRaw : RUN_DEFAULTS.concurrency,
      1,
      8
    ),
    minDelayMs: clampInt(
      Number.isFinite(minRaw) ? minRaw : RUN_DEFAULTS.minDelayMs,
      300,
      120000
    ),
    maxDelayMs: clampInt(
      Number.isFinite(maxRaw) ? maxRaw : RUN_DEFAULTS.maxDelayMs,
      300,
      120000
    )
  };

  if (settings.minDelayMs > settings.maxDelayMs) {
    const swap = settings.minDelayMs;
    settings.minDelayMs = settings.maxDelayMs;
    settings.maxDelayMs = swap;
  }

  if (normalizeInputs) {
    concurrencyInputEl.value = String(settings.concurrency);
    minDelayInputEl.value = String(settings.minDelayMs);
    maxDelayInputEl.value = String(settings.maxDelayMs);
  }
  return settings;
}

function renderSettingsSummary() {
  const s = readRunSettings(false);
  settingsSummaryEl.textContent = `${s.concurrency} workers • ${s.minDelayMs}-${s.maxDelayMs}ms`;
}

function setStage(stage) {
  uiStage = stage;
  const isPre = stage === "pre";
  const isReady = stage === "ready";
  const isRunningStage = stage === "running";
  const isCompleted = stage === "completed";
  const showWorkflow = !isPre;
  const showLog = !isPre;
  const showStatus = isRunningStage || isCompleted;
  const lockSettings = isRunningStage;

  workflowSectionEl.classList.toggle("hidden", !showWorkflow);
  logCardEl.classList.toggle("hidden", !showLog);
  statusCardEl.classList.toggle("hidden", !showStatus);
  advancedSettingsEl.open = false;
  concurrencyInputEl.disabled = lockSettings;
  minDelayInputEl.disabled = lockSettings;
  maxDelayInputEl.disabled = lockSettings;

  if (isReady) setModeBadge("Ready");
}

function setUrlOptions(keys, bestKey) {
  urlColumnSelect.innerHTML = "";
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    urlColumnSelect.appendChild(opt);
  }
  if (bestKey) urlColumnSelect.value = bestKey;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function renderStatus(status) {
  const percent = ((status.progress || 0) * 100).toFixed(1);
  const mode = status.total === 0 ? "Idle" : (status.paused ? "Paused" : "Running");
  const eta = status.etaMs == null ? "n/a" : formatDuration(status.etaMs);
  const rate = Number.isFinite(status.ratePerMinute) ? status.ratePerMinute.toFixed(2) : "0.00";

  setModeBadge(mode);
  progressFillEl.style.width = `${Math.min(100, Math.max(0, Number(percent)))}%`;
  mDoneEl.textContent = `${status.done}/${status.total}`;
  mSuccessEl.textContent = String(status.success ?? 0);
  mFailedEl.textContent = String(status.failed ?? 0);
  mQueuedEl.textContent = String(status.queued ?? 0);
  mRateEl.textContent = `${rate}/m`;
  mEtaEl.textContent = eta;
}

function renderCompletedState(status) {
  statusCardEl.classList.add("completed");
  successBannerEl.classList.remove("hidden");
  const failed = status.failed ?? 0;
  const done = status.done ?? 0;
  const total = status.total ?? 0;
  if (failed > 0) {
    successBannerEl.textContent = `Completed ${done}/${total}. ${failed} failed (check logs/results), ready to download.`;
  } else {
    successBannerEl.textContent = `All done. ${done}/${total} presentations completed successfully. Ready to download JSON.`;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!isRunning) return;
    let status;
    try {
      status = await chrome.runtime.sendMessage({ type: "STATUS" });
    } catch (err) {
      log(`Status error: ${String(err)}`);
      return;
    }
    renderStatus(status);
    statusCardEl.classList.remove("hidden");

    downloadBtn.disabled = status.done === 0;
    downloadBtn.textContent = isRunning ? "Download Partial" : "Download";
    if (isRunning) {
      downloadBtn.classList.remove("btn-success");
      downloadBtn.classList.add("btn-secondary");
    }

    if (status.done === status.total && status.total > 0) {
      isRunning = false;
      pauseBtn.disabled = true;
      pauseBtn.textContent = "Pause";
      downloadBtn.textContent = "Download JSON";
      downloadBtn.classList.remove("btn-secondary");
      downloadBtn.classList.add("btn-success");
      setModeBadge("Completed");
      setStage("completed");
      renderCompletedState(status);
      clearInterval(pollTimer);
      pollTimer = null;
      log("Done.");
    }
  }, 1000);
}

fileInput.addEventListener("change", async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Download";
  pauseBtn.disabled = true;
  pauseBtn.textContent = "Pause";
  isPaused = false;
  isRunning = false;
  setStage("pre");
  renderIdleState();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  logEl.textContent = "";

  const file = fileInput.files?.[0];
  if (!file) return;
  setStage("ready");
  renderSettingsSummary();

  log("Parsing CSV...");
  rows = await parseCsvFile(file);
  if (!rows.length) {
    log("No rows found.");
    startBtn.disabled = true;
    return;
  }

  const scores = detectUrlColumn(rows);
  const keys = scores.map((s) => s.key);
  const best = scores[0];

  setUrlOptions(keys, best?.key);
  startBtn.disabled = false;

  if (best) {
    log(`Best guess URL column: ${best.key} (${best.ok}/${best.total})`);
  }
});

startBtn.addEventListener("click", async () => {
  const urlKey = urlColumnSelect.value;
  if (!urlKey) return;

  const items = rows.map((r, idx) => ({
    rowIndex: idx,
    url: String(r[urlKey] || "").trim(),
    rowData: r
  })).filter((x) => x.url);

  if (!items.length) {
    log("No valid URLs found in selected column.");
    return;
  }

  downloadBtn.disabled = true;
  isRunning = true;
  isPaused = false;
  pauseBtn.disabled = false;
  pauseBtn.textContent = "Pause";
  setStage("running");
  setModeBadge("Running");
  const settings = readRunSettings(true);
  renderSettingsSummary();

  log(`Queued rows: ${items.length}`);
  log(`Settings: ${settings.concurrency} workers, ${settings.minDelayMs}-${settings.maxDelayMs}ms delay`);

  await chrome.runtime.sendMessage({ type: "START", items, settings });
  log("Started with throttling enabled. API requests use browser session cookies.");
  startPolling();
});

pauseBtn.addEventListener("click", async () => {
  if (!isRunning) return;
  if (!isPaused) {
    await chrome.runtime.sendMessage({ type: "PAUSE" });
    isPaused = true;
    pauseBtn.textContent = "Resume";
    setModeBadge("Paused");
    log("Paused queue. In-flight request may still finish.");
    return;
  }

  await chrome.runtime.sendMessage({ type: "RESUME" });
  isPaused = false;
  pauseBtn.textContent = "Pause";
  setModeBadge("Running");
  log("Resumed queue.");
});

downloadBtn.addEventListener("click", async () => {
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_RESULTS" });
  const results = Array.isArray(snapshot?.results) ? snapshot.results.filter(Boolean) : [];
  if (!results.length) return;

  const stamp = isRunning ? "partial" : "complete";
  const blob = new Blob([JSON.stringify(results, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `menti-scrape-${stamp}-${Date.now()}.json`,
    saveAs: true
  });

  URL.revokeObjectURL(url);
});

renderIdleState();
setStage("pre");
renderSettingsSummary();

[concurrencyInputEl, minDelayInputEl, maxDelayInputEl].forEach((el) => {
  el.addEventListener("input", () => {
    renderSettingsSummary();
  });
});