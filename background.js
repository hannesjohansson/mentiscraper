const state = {
  queue: [],
  inFlight: [],
  results: [],
  runId: 0,
  running: 0,
  concurrency: 5,
  done: 0,
  total: 0,
  success: 0,
  failed: 0,
  paused: false,
  startedAt: 0,
  nextAllowedAt: 0,
  throttle: {
    minDelayMs: 150,
    maxDelayMs: 700
  }
};
const PERSIST_KEY = "mentiScrapeStateV1";
let hydrating = false;

const hydratePromise = hydrateState();

chrome.action.onClicked.addListener(() => {
  openDashboardTab();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START") {
    applyRunSettings(msg.settings);
    state.queue = msg.items.slice();
    state.inFlight = [];
    state.results = new Array(msg.items.length);
    state.runId += 1;
    state.running = 0;
    state.done = 0;
    state.total = msg.items.length;
    state.success = 0;
    state.failed = 0;
    state.paused = false;
    state.startedAt = Date.now();
    state.nextAllowedAt = Date.now();

    pump();
    persistState();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "STATUS") {
    (async () => {
      await hydratePromise;
      const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
      const progress = state.total ? state.done / state.total : 0;
      const ratePerMinute = elapsedMs > 0 ? (state.done * 60000) / elapsedMs : 0;
      const remaining = Math.max(0, state.total - state.done);
      const etaMs = ratePerMinute > 0 ? (remaining / ratePerMinute) * 60000 : null;

      sendResponse({
        running: state.running,
        done: state.done,
        total: state.total,
        queued: state.queue.length,
        inFlight: state.inFlight.length,
        success: state.success,
        failed: state.failed,
        paused: state.paused,
        progress,
        elapsedMs,
        ratePerMinute,
        etaMs,
        settings: {
          concurrency: state.concurrency,
          minDelayMs: state.throttle.minDelayMs,
          maxDelayMs: state.throttle.maxDelayMs
        }
      });
    })();
    return true; // async sendResponse
  }

  if (msg.type === "GET_RESULTS") {
    (async () => {
      await hydratePromise;
      sendResponse({ results: state.results });
    })();
    return true; // async sendResponse
  }

  if (msg.type === "PAUSE") {
    state.paused = true;
    persistState();
    sendResponse({ ok: true, paused: state.paused });
    return true;
  }

  if (msg.type === "RESUME") {
    state.paused = false;
    pump();
    persistState();
    sendResponse({ ok: true, paused: state.paused });
    return true;
  }

  if (msg.type === "UPDATE_SETTINGS") {
    applyRunSettings(msg.settings);
    // Make new settings take effect immediately.
    state.nextAllowedAt = Date.now();
    persistState();
    // If concurrency increased, start additional workers immediately.
    if (!state.paused && state.done < state.total) pump();
    sendResponse({
      ok: true,
      settings: {
        concurrency: state.concurrency,
        minDelayMs: state.throttle.minDelayMs,
        maxDelayMs: state.throttle.maxDelayMs
      }
    });
    return true;
  }

  if (msg.type === "RESET") {
    resetRunState();
    persistState();
    sendResponse({ ok: true });
    return true;
  }
});

function openDashboardTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

function resetRunState() {
  state.runId += 1;
  state.queue = [];
  state.inFlight = [];
  state.results = [];
  state.running = 0;
  state.done = 0;
  state.total = 0;
  state.success = 0;
  state.failed = 0;
  state.paused = false;
  state.startedAt = 0;
  state.nextAllowedAt = Date.now();
}

function applyRunSettings(settings) {
  const rawConcurrency = Number(settings?.concurrency);
  const rawMinDelay = Number(settings?.minDelayMs);
  const rawMaxDelay = Number(settings?.maxDelayMs);

  const concurrency = clampInt(Number.isFinite(rawConcurrency) ? rawConcurrency : state.concurrency, 1, 8);
  let minDelayMs = clampInt(
    Number.isFinite(rawMinDelay) ? rawMinDelay : state.throttle.minDelayMs,
    100,
    120000
  );
  let maxDelayMs = clampInt(
    Number.isFinite(rawMaxDelay) ? rawMaxDelay : state.throttle.maxDelayMs,
    100,
    120000
  );

  if (minDelayMs > maxDelayMs) {
    const swap = minDelayMs;
    minDelayMs = maxDelayMs;
    maxDelayMs = swap;
  }

  state.concurrency = concurrency;
  state.throttle.minDelayMs = minDelayMs;
  state.throttle.maxDelayMs = maxDelayMs;
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pump() {
  if (state.paused) return;

  while (state.running < state.concurrency && state.queue.length) {
    const item = state.queue.shift();
    const runIdForTask = state.runId;
    state.inFlight.push(item);
    state.running += 1;
    persistState();
    runOne(item)
      .then((result) => {
        if (runIdForTask !== state.runId) return;
        state.results[item.rowIndex] = result;
        state.success += 1;
      })
      .catch((e) => {
        if (runIdForTask !== state.runId) return;
        state.results[item.rowIndex] = {
          rowIndex: item.rowIndex,
          url: item.url,
          source_columns: Object.keys(item.rowData || {}),
          source_row: { ...(item.rowData || {}) },
          rowData: item.rowData,
          apiUrl: null,
          presentation: null,
          error: String(e)
        };
        state.failed += 1;
      })
      .finally(() => {
        if (runIdForTask !== state.runId) return;
        removeInFlight(item.rowIndex);
        state.running -= 1;
        state.done += 1;
        persistState();
        pump();
      });
  }
}

function removeInFlight(rowIndex) {
  const idx = state.inFlight.findIndex((x) => x.rowIndex === rowIndex);
  if (idx !== -1) state.inFlight.splice(idx, 1);
}

async function runOne(item) {
  const presentationId = extractPresentationId(item.url);
  if (!presentationId) {
    throw new Error(`Could not extract presentation ID from URL: ${item.url}`);
  }

  const apiUrl = `https://api.mentimeter.com/presentation/series/${encodeURIComponent(presentationId)}`;
  await waitForThrottleSlot();
  const raw = await fetchJsonWithRetry(apiUrl);
  const presentation = reducePresentation(raw);

  return {
    rowIndex: item.rowIndex,
    url: item.url,
    source_columns: Object.keys(item.rowData || {}),
    source_row: { ...(item.rowData || {}) },
    rowData: item.rowData,
    apiUrl,
    presentation,
    error: null
  };
}

async function waitForThrottleSlot() {
  // Deterministic scheduling: each request "reserves" its start time.
  // This avoids races between concurrent workers and makes live settings updates effective.
  const delay = randomInt(state.throttle.minDelayMs, state.throttle.maxDelayMs);
  const startAt = Math.max(Date.now(), state.nextAllowedAt);
  state.nextAllowedAt = startAt + delay;
  const waitMs = startAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

async function fetchJsonWithRetry(apiUrl) {
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(apiUrl, 30000);

      if (response.ok) {
        return await response.json();
      }

      const apiError = await parseApiErrorResponse(response);
      if (isSeriesNotFoundError(apiError)) {
        throw new Error("Presentation can't be accessed");
      }

      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        throw new Error(`API request failed (${response.status}) for ${apiUrl}`);
      }

      const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"));
      const delayMs = retryAfter ?? computeBackoffMs(attempt);
      await sleep(delayMs);
      continue;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      await sleep(computeBackoffMs(attempt));
    }
  }

  throw lastError ?? new Error(`Failed to fetch API response for ${apiUrl}`);
}

async function parseApiErrorResponse(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function isSeriesNotFoundError(payload) {
  if (!payload || typeof payload !== "object") return false;
  const code = String(payload.code || "").toLowerCase();
  const message = String(payload.message || "").toLowerCase();
  const status = Number(payload.status);
  return status === 404 && code === "not_found" && message.includes("series not found");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // credentials: "include" ensures existing browser cookies are used.
    return await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status) {
  return [403, 408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function computeBackoffMs(attempt) {
  const base = 1000 * (2 ** (attempt - 1));
  const jitter = randomInt(200, 1200);
  return Math.min(20000, base + jitter);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistState() {
  if (hydrating) return;
  const snapshot = {
    queue: state.queue,
    inFlight: state.inFlight,
    results: state.results,
    runId: state.runId,
    running: state.running,
    concurrency: state.concurrency,
    done: state.done,
    total: state.total,
    success: state.success,
    failed: state.failed,
    paused: state.paused,
    startedAt: state.startedAt,
    nextAllowedAt: state.nextAllowedAt,
    throttle: state.throttle
  };
  chrome.storage.local.set({ [PERSIST_KEY]: snapshot });
}

async function hydrateState() {
  hydrating = true;
  try {
    const loaded = await chrome.storage.local.get(PERSIST_KEY);
    const snapshot = loaded?.[PERSIST_KEY];
    if (!snapshot) return;

    state.queue = Array.isArray(snapshot.queue) ? snapshot.queue.slice() : [];
    state.inFlight = Array.isArray(snapshot.inFlight) ? snapshot.inFlight.slice() : [];
    state.results = Array.isArray(snapshot.results) ? snapshot.results.slice() : [];
    state.runId = Number.isFinite(snapshot.runId) ? snapshot.runId : 0;
    state.running = 0;
    state.concurrency = clampInt(
      Number.isFinite(snapshot.concurrency) ? snapshot.concurrency : state.concurrency,
      1,
      8
    );
    state.done = Number.isFinite(snapshot.done) ? snapshot.done : 0;
    state.total = Number.isFinite(snapshot.total) ? snapshot.total : 0;
    state.success = Number.isFinite(snapshot.success) ? snapshot.success : 0;
    state.failed = Number.isFinite(snapshot.failed) ? snapshot.failed : 0;
    state.paused = Boolean(snapshot.paused);
    state.startedAt = Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : 0;
    state.nextAllowedAt = Number.isFinite(snapshot.nextAllowedAt) ? snapshot.nextAllowedAt : Date.now();

    const minDelay = clampInt(snapshot?.throttle?.minDelayMs ?? state.throttle.minDelayMs, 100, 120000);
    const maxDelay = clampInt(snapshot?.throttle?.maxDelayMs ?? state.throttle.maxDelayMs, 100, 120000);
    state.throttle.minDelayMs = Math.min(minDelay, maxDelay);
    state.throttle.maxDelayMs = Math.max(minDelay, maxDelay);

    // If worker was suspended mid-request, retry those items first.
    if (state.inFlight.length > 0) {
      state.queue = [...state.inFlight, ...state.queue];
      state.inFlight = [];
    }

    if (!state.paused && state.done < state.total) {
      pump();
    } else {
      persistState();
    }
  } catch {
    // Keep defaults on hydrate failure.
  } finally {
    hydrating = false;
  }
}

function extractPresentationId(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const presentationIdx = parts.findIndex((p) => p === "presentation");
    if (presentationIdx !== -1 && parts[presentationIdx + 1]) {
      return parts[presentationIdx + 1];
    }
    const seriesIdx = parts.findIndex((p) => p === "series");
    if (seriesIdx !== -1 && parts[seriesIdx + 1]) {
      return parts[seriesIdx + 1];
    }
    return null;
  } catch {
    return null;
  }
}

function plainText(input) {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
  const out = [];
  walkText(input, out);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function walkText(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walkText(child, out);
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.text === "string" && node.text.trim()) out.push(node.text.trim());
  if (Array.isArray(node.content)) walkText(node.content, out);
}

function boolOrNull(value) {
  if (value == null) return null;
  return Boolean(value);
}

function reduceQuestion(interactiveContent, questionType) {
  const choices = Array.isArray(interactiveContent?.choices) ? interactiveContent.choices : [];
  const choiceTitles = choices
    .map((c) => plainText(c?.title))
    .filter(Boolean)
    .map((title) => ({ title }));

  const hasMarkedCorrect = choices.some((c) => c?.marked_correct === true);
  const correctMode = interactiveContent?.correct_answer_mode;
  const hasCorrectAnswers = hasMarkedCorrect || (correctMode != null && correctMode !== "disabled");

  const responseRange = interactiveContent?.response_range;
  const hasResponseRange =
    responseRange != null &&
    (typeof responseRange.min === "number" || typeof responseRange.max === "number");

  const voteSettings = interactiveContent?.vote_settings;
  const maxEntriesDefined =
    interactiveContent?.max_entries != null ||
    voteSettings?.max_entries != null ||
    voteSettings?.max_entries_per_response != null;

  return {
    question_title: plainText(interactiveContent?.title),
    question_description: plainText(interactiveContent?.description),
    question_type: questionType || "unknown",
    response_policy: interactiveContent?.response_policy ?? null,
    response_mode: interactiveContent?.response_mode ?? null,
    choice_count: choices.length,
    choices: choiceTitles,
    has_correct_answers: hasCorrectAnswers,
    scoring_enabled: boolOrNull(interactiveContent?.scoring),
    countdown_enabled: boolOrNull(interactiveContent?.countdown),
    has_response_range: hasResponseRange,
    response_range: hasResponseRange
      ? {
          min: typeof responseRange.min === "number" ? responseRange.min : null,
          max: typeof responseRange.max === "number" ? responseRange.max : null
        }
      : null,
    max_entries_defined: maxEntriesDefined
  };
}

function reducePresentation(raw) {
  const slideDeck = raw?.slide_deck ?? {};
  const slides = Array.isArray(slideDeck.slides) ? slideDeck.slides : [];
  const participation = slideDeck.participation_settings ?? {};
  const qaSettings = slideDeck.qa_settings ?? {};
  const liveChatSettings = slideDeck.live_chat_settings ?? {};
  const languageSettings = slideDeck.language_settings ?? {};
  const ownership = slideDeck.ownership_settings ?? {};

  const reducedSlides = [];
  const slideTypeDistribution = {};
  let totalQuestionCount = 0;
  let questionSlideCount = 0;

  for (const slide of slides) {
    const slideType = slide?.static_content?.type ?? "unknown";
    slideTypeDistribution[slideType] = (slideTypeDistribution[slideType] || 0) + 1;

    const interactive = Array.isArray(slide?.interactive_contents) ? slide.interactive_contents : [];
    if (interactive.length > 0) questionSlideCount += 1;
    totalQuestionCount += interactive.length;

    const titleFromStyled = plainText(slide?.static_content?.styledTitle);
    const slideTitle = titleFromStyled || plainText(slide?.title);

    reducedSlides.push({
      slide_type: slideType,
      slide_title: slideTitle,
      questions: interactive.map((q) => reduceQuestion(q, slideType))
    });
  }

  return {
    slide_count: slides.length,
    question_slide_count: questionSlideCount,
    slide_type_distribution: slideTypeDistribution,
    total_question_count: totalQuestionCount,
    participation_mode: participation.participation_mode ?? null,
    participation_policy: participation.participation_policy ?? null,
    participation_identity_mode: participation.participation_identity_mode ?? null,
    participation_authentication_mode: participation.participation_authentication_mode ?? null,
    qa_enabled: qaSettings.enablement_scope != null && qaSettings.enablement_scope !== "disabled",
    live_chat_enabled:
      liveChatSettings.live_chat_mode != null && liveChatSettings.live_chat_mode !== "disabled",
    collaboration_mode: ownership.collaboration_mode ?? null,
    presentation_language: languageSettings.presentation_language ?? null,
    slides: reducedSlides
  };
}