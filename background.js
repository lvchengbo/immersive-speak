/* Immersive Speak — background service worker.
   Handles Groq API calls (TTS + STT), on-demand engine injection,
   IndexedDB caching, and opt-in analytics. */

importScripts("shared.js");

const API_BASE = "https://api.groq.com/openai/v1";
const TARGET_ATTR = GROQ_TARGET_ATTR;

const getSettings = () => new Promise(resolve => {
  chrome.storage.local.get(GROQ_DEFAULTS, resolve);
});

// ─── Retry / backoff ─────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 800;

async function withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") throw err;
      if (attempt < retries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Audio format helpers ─────────────────────────────────────────────

const mimeForFormat = format => {
  switch ((format || "").toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "opus": return "audio/opus";
    case "aac": return "audio/aac";
    case "flac": return "audio/flac";
    case "wav":
    default: return "audio/wav";
  }
};

const extForFormat = format => {
  switch ((format || "").toLowerCase()) {
    case "mp3": return "mp3";
    case "opus": return "opus";
    case "aac": return "aac";
    case "flac": return "flac";
    case "wav":
    default: return "wav";
  }
};

// ─── Groq API ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const external = options?.signal;
  if (external) {
    if (external.aborted) { controller.abort(); }
    else { external.addEventListener("abort", () => controller.abort(), { once: true }); }
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

const fetchTts = async (text, settings, signal) => {
  return withRetry(async () => {
    const res = await fetchWithTimeout(`${API_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.api_key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.tts_model,
        voice: settings.tts_voice,
        input: text,
        response_format: settings.tts_format
      }),
      signal
    });

    if (!res.ok) {
      const msg = await safeErrorMessage(res);
      throw new Error(`Groq TTS failed: ${msg}`);
    }

    const buffer = await res.arrayBuffer();
    return {
      buffer,
      mime: mimeForFormat(settings.tts_format)
    };
  });
};

const fetchStt = async (audioBuffer, mimeType, settings, signal) => {
  return withRetry(async () => {
    const blob = new Blob([audioBuffer], { type: mimeType || "audio/wav" });
    const form = new FormData();
    form.append("file", blob, `speech.${extForFormat(settings.tts_format)}`);
    form.append("model", settings.stt_model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const lang = settings.stt_language || detectLanguage();
    if (lang) form.append("language", lang);

    const res = await fetchWithTimeout(`${API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.api_key}`
      },
      body: form,
      signal
    });

    if (!res.ok) {
      const msg = await safeErrorMessage(res);
      throw new Error(`Groq STT failed: ${msg}`);
    }

    const json = await res.json();
    return extractWords(json);
  });
};

function detectLanguage() {
  try {
    const lang = navigator.language || "";
    return lang.split("-")[0] || "";
  } catch (_) {
    return "";
  }
}

const fetchAgentSelection = async (blocks, settings, signal) => {
  const res = await fetchWithTimeout(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.api_key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.agent_model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: [
            "Select which webpage blocks should be read aloud.",
            "Return JSON with key read_ids: array of block ids in reading order.",
            "Also return rationales: object mapping id -> short reason.",
            "Only include blocks that are main body content (not nav, ads, menus, footers, sidebars).",
            "If nothing should be read, return {\"read_ids\":[]}.",
            "Return JSON only."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({ blocks })
        }
      ]
    }),
    signal
  });

  if (!res.ok) {
    const msg = await safeErrorMessage(res);
    throw new Error(`Groq agent failed: ${msg}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeAgentResponse(content);
};

const normalizeAgentResponse = content => {
  if (!content) return { readIds: [], rationales: {} };
  const direct = parseAgentJson(content);
  if (direct.readIds.length || Object.keys(direct.rationales).length) return direct;
  const extracted = extractJsonObject(content);
  if (extracted) {
    const parsed = parseAgentJson(extracted);
    if (parsed.readIds.length || Object.keys(parsed.rationales).length) return parsed;
  }
  return { readIds: parseIdsFromText(content), rationales: {} };
};

const parseAgentJson = jsonText => {
  try {
    const parsed = JSON.parse(jsonText);
    const readIds = (() => {
      if (Array.isArray(parsed)) return normalizeIdArray(parsed);
      if (Array.isArray(parsed.read_ids)) return normalizeIdArray(parsed.read_ids);
      if (Array.isArray(parsed.readIds)) return normalizeIdArray(parsed.readIds);
      if (Array.isArray(parsed.ids)) return normalizeIdArray(parsed.ids);
      return [];
    })();
    const rawRationales = parsed.rationales || parsed.reasons || parsed.explanations || {};
    const rationales = {};
    if (rawRationales && typeof rawRationales === "object") {
      for (const [key, value] of Object.entries(rawRationales)) {
        const id = Number.parseInt(key, 10);
        if (!Number.isFinite(id)) continue;
        if (typeof value === "string") rationales[id] = value.slice(0, 140);
      }
    }
    return { readIds, rationales };
  } catch (_) {
    return { readIds: [], rationales: {} };
  }
};

const extractJsonObject = text => {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return "";
  return text.slice(first, last + 1);
};

const parseIdsFromText = text => {
  const matches = String(text).match(/\d+/g);
  if (!matches) return [];
  return normalizeIdArray(matches);
};

const normalizeIdArray = arr => {
  const out = [];
  for (const val of arr) {
    const num = Number.parseInt(val, 10);
    if (Number.isFinite(num)) out.push(num);
  }
  return out;
};

const extractWords = json => {
  if (!json) return [];
  if (Array.isArray(json.words)) return json.words;
  if (Array.isArray(json.segments)) {
    const out = [];
    for (const seg of json.segments) {
      if (Array.isArray(seg.words)) out.push(...seg.words);
    }
    return out;
  }
  return [];
};

const arrayBufferToBase64 = buffer => {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
};

const safeErrorMessage = async res => {
  try {
    const data = await res.json();
    if (data && data.error && data.error.message) return data.error.message;
    return JSON.stringify(data);
  } catch (_) {
    return `${res.status} ${res.statusText}`;
  }
};

// ─── IndexedDB cache ──────────────────────────────────────────────────

const IDB_NAME = "immersive-speak-cache";
const IDB_VERSION = 1;
const IDB_STORE = "tts-chunks";

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function cacheKey(text, model, voice) {
  return `${model}|${voice}|${text}`;
}

async function cacheGet(key) {
  try {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.value || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function cachePut(key, value) {
  try {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put({ key, value, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    // Cache write failure is non-critical
  }
}

async function cacheClear() {
  try {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}
}

async function cacheCount() {
  try {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return 0;
  }
}

// ─── Analytics (opt-in, lightweight) ──────────────────────────────────

let analyticsOptIn = false;
chrome.storage.local.get({ analytics_opt_in: false }, v => {
  analyticsOptIn = v.analytics_opt_in;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.analytics_opt_in) {
    analyticsOptIn = changes.analytics_opt_in.newValue ?? false;
  }
});

const analyticsCounters = {
  activations: 0,
  tts_requests: 0,
  tts_errors: 0,
  stt_errors: 0,
  agent_requests: 0,
  cache_hits: 0
};

function trackEvent(name) {
  if (!analyticsOptIn) return;
  if (name in analyticsCounters) analyticsCounters[name] += 1;
}

// Expose counters for options page
function getAnalyticsSummary() {
  return { ...analyticsCounters, opt_in: analyticsOptIn };
}

// ─── Uninstall survey ─────────────────────────────────────────────────

chrome.runtime.setUninstallURL("https://forms.gle/immersive-speak-feedback");

// ─── Engine injection ─────────────────────────────────────────────────

const injectEngine = async (tabId) => {
  try {
    // Ensure shared.js globals exist (needed for pre-existing tabs after install/reload)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js", "content-engine.js"]
    });
  } catch (err) {
    console.warn("[Immersive Speak] engine injection:", err);
  }
};

// ─── Toolbar click handler ────────────────────────────────────────────

const pickerTabs = new Set();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  trackEvent("activations");

  // Toggle picker off if already active
  if (pickerTabs.has(tab.id)) {
    pickerTabs.delete(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: GROQ_MESSAGES.PICKER_STOP });
    } catch (_) {}
    return;
  }

  const settings = await getSettings();

  // Agent mode: skip picker, go straight to agent
  if (settings.agent_mode) {
    await injectEngine(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: GROQ_MESSAGES.AGENT_START });
    } catch (err) {
      console.warn("[Immersive Speak] sendMessage agent-start:", err);
    }
    return;
  }

  // Manual mode: start content-script picker
  pickerTabs.add(tab.id);
  await injectEngine(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: GROQ_MESSAGES.PICKER_START });
  } catch (err) {
    console.warn("[Immersive Speak] sendMessage picker-start:", err);
    pickerTabs.delete(tab.id);
  }
});

// Clean up picker state when tabs close
chrome.tabs.onRemoved.addListener(tabId => {
  pickerTabs.delete(tabId);
});

// ─── Message handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === GROQ_MESSAGES.PICKER_STOP) {
    const tabId = sender?.tab?.id;
    if (tabId) pickerTabs.delete(tabId);
    return;
  }

  if (msg.type === GROQ_MESSAGES.RESUME_PICKER) {
    // No-op now that CDP picker is removed; kept for compatibility
    return;
  }

  if (msg.type === GROQ_MESSAGES.AGENT_SELECT) {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.api_key) {
          sendResponse({ ok: false, error: i18n("toastMissingKey") });
          return;
        }
        trackEvent("agent_requests");
        const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
        const trimmed = blocks.slice(0, 50).map(block => ({
          id: block.id,
          tag: block.tag,
          words: block.words,
          link_ratio: block.link_ratio,
          text: String(block.text || "").slice(0, 400)
        }));
        if (!trimmed.length) {
          sendResponse({ ok: true, readIds: [] });
          return;
        }
        const result = await fetchAgentSelection(trimmed, settings);
        sendResponse({ ok: true, readIds: result.readIds, rationales: result.rationales });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === GROQ_MESSAGES.SPEECH_TTS) {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.api_key) {
          sendResponse({ ok: false, error: i18n("toastMissingKey") });
          return;
        }
        const text = String(msg.text || "").trim();
        if (!text) {
          sendResponse({ ok: false, error: i18n("toastNoTextProvided") });
          return;
        }
        trackEvent("tts_requests");
        const { buffer, mime } = await fetchTts(text, settings);
        sendResponse({ ok: true, audio: arrayBufferToBase64(buffer), mime });
      } catch (err) {
        trackEvent("tts_errors");
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === GROQ_MESSAGES.INJECT) {
    const tabId = sender?.tab?.id;
    if (tabId) injectEngine(tabId);
    return;
  }

  // Cache management from options page
  if (msg.type === "cache-clear") {
    cacheClear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "cache-count") {
    cacheCount().then(count => sendResponse({ count })).catch(() => sendResponse({ count: 0 }));
    return true;
  }
  if (msg.type === "analytics-summary") {
    sendResponse(getAnalyticsSummary());
    return;
  }
});

// ─── Streaming TTS via ports (with IndexedDB cache + resilient STT) ──

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== GROQ_MESSAGES.PORT) return;

  const controller = new AbortController();

  port.onDisconnect.addListener(() => {
    controller.abort();
  });

  port.onMessage.addListener(async msg => {
    if (msg?.type !== "start") return;

    const settings = await getSettings();
    if (!settings.api_key) {
      try { port.postMessage({ type: "error", error: i18n("toastMissingKey") }); } catch (_) {}
      return;
    }

    const chunks = Array.isArray(msg.chunks) ? msg.chunks : [];
    if (!chunks.length) {
      try { port.postMessage({ type: "error", error: i18n("toastNoTextProvided") }); } catch (_) {}
      return;
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (controller.signal.aborted) break;

        const chunkText = chunks[i];
        const ck = cacheKey(chunkText, settings.tts_model, settings.tts_voice);

        // Check IndexedDB cache first
        const cached = await cacheGet(ck);
        if (cached) {
          trackEvent("cache_hits");
          try {
            port.postMessage({ type: "chunk", index: i, result: cached });
          } catch (_) { break; }
          continue;
        }

        trackEvent("tts_requests");
        const { buffer, mime } = await fetchTts(chunkText, settings, controller.signal);
        if (controller.signal.aborted) break;

        // STT for word timing — resilient: fallback to empty words on failure
        let words = [];
        try {
          words = await fetchStt(buffer, mime, settings, controller.signal);
        } catch (sttErr) {
          if (sttErr?.name === "AbortError") break;
          trackEvent("stt_errors");
          console.warn("[Immersive Speak] STT failed, using fallback timing:", sttErr?.message);
          // words stays [] — content-engine will use buildFallbackMap
        }

        if (controller.signal.aborted) break;

        const result = { audio: arrayBufferToBase64(buffer), mime, words };

        // Store in IndexedDB cache (fire-and-forget)
        cachePut(ck, result);

        try {
          port.postMessage({ type: "chunk", index: i, result });
        } catch (_) {
          break;
        }
      }
      if (!controller.signal.aborted) {
        try { port.postMessage({ type: "done" }); } catch (_) {}
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      trackEvent("tts_errors");
      try {
        port.postMessage({ type: "error", error: err?.message || String(err) });
      } catch (_) {
        // Port may have disconnected
      }
    }
  });
});
