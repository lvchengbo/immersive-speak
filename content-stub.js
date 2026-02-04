/* Immersive Speak — lightweight stub injected on all pages.
   Registers minimal listeners and lazily loads content-engine.js on first activation. */
(() => {
  if (window.__groqTtsStub) return;

  let engineLoaded = false;
  let engineLoading = false;
  let autoSpeak = GROQ_DEFAULTS.auto_speak;

  window.__groqTtsStub = {
    pending: null,
    pendingCallback: null,
    get engineLoaded() { return engineLoaded; },
    set engineLoaded(v) { engineLoaded = v; }
  };

  chrome.storage.local.get(
    { auto_speak: GROQ_DEFAULTS.auto_speak },
    values => { autoSpeak = values.auto_speak; }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes?.auto_speak) {
      autoSpeak = changes.auto_speak.newValue ?? GROQ_DEFAULTS.auto_speak;
    }
  });

  // --- Auto-speak: detect text selection in paragraphs ---
  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      if (!autoSpeak) return;
      ensureEngine(() => {
        if (window.__groqTtsEngine) {
          window.__groqTtsEngine.handleSelection();
        }
      });
    }, 0);
  });

  // --- Escape to cancel (delegate to engine if loaded) ---
  document.addEventListener("keydown", evt => {
    if (evt.key === "Escape" && engineLoaded && window.__groqTtsEngine) {
      window.__groqTtsEngine.stop();
    }
  });

  // --- Handle toolbar-click activation from background ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (engineLoaded) return false;
    if (!msg || (msg.type !== GROQ_MESSAGES.START && msg.type !== GROQ_MESSAGES.AGENT_START)) return false;

    window.__groqTtsStub.pending = { type: msg.type };
    ensureEngine();
    sendResponse({ ok: true });
    return false;
  });

  // --- Lazy engine loader ---
  function ensureEngine(callback) {
    if (engineLoaded) {
      callback?.();
      return;
    }
    if (callback) {
      window.__groqTtsStub.pendingCallback = callback;
    }
    if (engineLoading) return;
    engineLoading = true;
    chrome.runtime.sendMessage({ type: GROQ_MESSAGES.INJECT });
  }
})();
