const ids = Object.keys(GROQ_DEFAULTS);
const MIN_CHARS = 50;
const MAX_CHARS = 1000;

document.addEventListener("DOMContentLoaded", () => {
  // Apply i18n to all elements with data-i18n attribute
  applyI18n();

  // Auto-detect STT language if not set
  chrome.storage.local.get(GROQ_DEFAULTS, values => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(values[id]);
      else el.value = values[id];
    }

    // Auto-detect language hint from browser locale
    const langInput = document.getElementById("stt_language");
    if (langInput && !values.stt_language) {
      const detected = detectBrowserLanguage();
      if (detected) langInput.placeholder = detected + " (auto)";
    }
  });

  document.getElementById("options-form").addEventListener("submit", event => {
    event.preventDefault();
    saveOptions();
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(GROQ_DEFAULTS[id]);
      else el.value = GROQ_DEFAULTS[id];
    }
    chrome.storage.local.set(GROQ_DEFAULTS, () => {
      showStatus(i18n("statusDefaultsRestored"));
    });
  });

  // Cache management
  const clearCacheBtn = document.getElementById("clear-cache-btn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "cache-clear" }, () => {
        showCacheStatus(i18n("cacheCleared"));
        refreshCacheCount();
      });
    });
  }

  refreshCacheCount();
});

function saveOptions() {
  const payload = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") {
      payload[id] = el.checked;
    } else if (el.type === "number") {
      const raw = Number(el.value);
      const fallback = GROQ_DEFAULTS[id];
      const value = Number.isFinite(raw) ? raw : fallback;
      const clamped = clampNumber(value, MIN_CHARS, MAX_CHARS);
      payload[id] = clamped;
      el.value = clamped;
    }
    else payload[id] = el.value.trim();
  }

  // Auto-detect language if empty
  if (!payload.stt_language) {
    const detected = detectBrowserLanguage();
    if (detected) {
      const langInput = document.getElementById("stt_language");
      if (langInput) langInput.placeholder = detected + " (auto)";
    }
  }

  chrome.storage.local.set(payload, () => {
    showStatus(i18n("statusSaved"));
  });
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function showStatus(text) {
  const status = document.getElementById("status");
  status.textContent = text;
  setTimeout(() => { status.textContent = ""; }, 1200);
}

function showCacheStatus(text) {
  const status = document.getElementById("cache-status");
  if (status) {
    status.textContent = text;
    setTimeout(() => { status.textContent = ""; }, 1200);
  }
}

function refreshCacheCount() {
  chrome.runtime.sendMessage({ type: "cache-count" }, response => {
    const count = response?.count || 0;
    const status = document.getElementById("cache-status");
    if (status && !status.textContent) {
      status.textContent = i18n("cacheEntries", [String(count)]);
    }
  });
}

function detectBrowserLanguage() {
  try {
    const lang = navigator.language || "";
    return lang.split("-")[0] || "";
  } catch (_) {
    return "";
  }
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const msg = i18n(key);
    if (msg && msg !== key) el.textContent = msg;
  });
}
