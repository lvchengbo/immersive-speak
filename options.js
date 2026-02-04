const ids = Object.keys(GROQ_DEFAULTS);
const MIN_CHARS = 50;
const MAX_CHARS = 1000;

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(GROQ_DEFAULTS, values => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(values[id]);
      else el.value = values[id];
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
      showStatus("Defaults restored");
    });
  });
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

  chrome.storage.local.set(payload, () => {
    showStatus("Saved");
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
