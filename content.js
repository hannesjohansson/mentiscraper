const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getQuestionIdFromUrl() {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("question") || null;
  } catch {
    return null;
  }
}

function dispatchArrowRight() {
  const evDown = new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true });
  const evUp = new KeyboardEvent("keyup", { key: "ArrowRight", code: "ArrowRight", bubbles: true });
  document.dispatchEvent(evDown);
  document.dispatchEvent(evUp);
}

function tryClickNextButton() {
  const candidates = [
    "button[aria-label*='Next']",
    "button[title*='Next']",
    "button[aria-label*='next']",
    "button[title*='next']",
    "[data-testid*='next']",
    "[data-testid*='Next']",
    "button svg[aria-label*='Next']",
  ];

  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const btn = el.closest("button") || el;
    if (btn instanceof HTMLElement) {
      btn.click();
      return true;
    }
  }
  return false;
}

function pickMainContainer() {
  const roots = [
    "main",
    "[role='main']",
    "#root",
    "[data-testid='presentation-view']",
    "[data-testid*='presentation']"
  ];

  for (const sel of roots) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

function extractSlideContent() {
  const root = pickMainContainer();

  const text = root.innerText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4000)
    .join("\n");

  const headings = Array.from(root.querySelectorAll("h1,h2,h3"))
    .map((h) => h.textContent?.trim())
    .filter(Boolean)
    .slice(0, 20);

  const buttons = Array.from(root.querySelectorAll("button"))
    .map((b) => b.textContent?.trim())
    .filter(Boolean)
    .slice(0, 30);

  const inputs = Array.from(root.querySelectorAll("input,textarea"))
    .map((i) => i.getAttribute("placeholder") || i.getAttribute("aria-label") || "")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);

  const images = Array.from(root.querySelectorAll("img"))
    .map((img) => img.getAttribute("alt") || "")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);

  return { text, headings, buttons, inputs, images };
}

function slideSignature() {
  const root = pickMainContainer();
  const t = (root.innerText || "").trim();
  return `${getQuestionIdFromUrl() || ""}::${t.slice(0, 200)}`;
}

async function waitForSlideChange(prevQuestionId, prevSig, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const q = getQuestionIdFromUrl();
    const sig = slideSignature();
    if ((prevQuestionId && q && q !== prevQuestionId) || sig !== prevSig) return true;
    await sleep(200);
  }
  return false;
}

async function scrapePresentation(maxSlides = 200) {
  const slides = [];
  const visited = new Set();

  for (let i = 0; i < maxSlides; i++) {
    const qid = getQuestionIdFromUrl();
    const sig = slideSignature();

    if (visited.has(sig)) break;
    visited.add(sig);

    slides.push({
      index: i,
      url: window.location.href,
      questionId: qid,
      content: extractSlideContent()
    });

    const prevQuestionId = qid;
    const prevSig = sig;

    dispatchArrowRight();
    await sleep(150);

    if (!await waitForSlideChange(prevQuestionId, prevSig, 4000)) {
      const clicked = tryClickNextButton();
      if (clicked) {
        if (!await waitForSlideChange(prevQuestionId, prevSig, 8000)) break;
      } else {
        break;
      }
    }

    await sleep(250);
  }

  return { slideCount: slides.length, slides };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "RUN") return;

  (async () => {
    const { rowIndex, url, rowData } = msg.payload;

    try {
      await sleep(1200);

      const presentation = await scrapePresentation(200);

      chrome.runtime.sendMessage({
        type: "SCRAPE_RESULT",
        rowIndex,
        url,
        rowData,
        presentation,
        error: null
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "SCRAPE_RESULT",
        rowIndex,
        url,
        rowData,
        presentation: null,
        error: String(e)
      });
    }
  })();
});