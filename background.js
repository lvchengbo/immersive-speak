/* Immersive Speak — background service worker.
   Handles Groq API calls (TTS + STT), CDP element picker, streaming delivery,
   and on-demand engine injection. */

importScripts("shared.js");

const API_BASE = "https://api.groq.com/openai/v1";
const TARGET_ATTR = GROQ_TARGET_ATTR;

const getSettings = () => new Promise(resolve => {
  chrome.storage.local.get(GROQ_DEFAULTS, resolve);
});

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

const fetchTts = async (text, settings, signal) => {
  const res = await fetch(`${API_BASE}/audio/speech`, {
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
};

const fetchStt = async (audioBuffer, mimeType, settings, signal) => {
  const blob = new Blob([audioBuffer], { type: mimeType || "audio/wav" });
  const form = new FormData();
  form.append("file", blob, `speech.${extForFormat(settings.tts_format)}`);
  form.append("model", settings.stt_model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (settings.stt_language) form.append("language", settings.stt_language);

  const res = await fetch(`${API_BASE}/audio/transcriptions`, {
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
};

const fetchAgentSelection = async (blocks, settings, signal) => {
  const res = await fetch(`${API_BASE}/chat/completions`, {
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

// ─── CDP session management ───────────────────────────────────────────

const PROTOCOL_VERSION = "1.3";

const highlightConfig = {
  borderColor:  { r: 255, g: 200, b: 0, a: 0.9 },
  contentColor: { r: 255, g: 230, b: 100, a: 0.3 },
  showInfo: true
};

const sessions = new Map();

const send = (debuggee, method, params = {}) =>
  new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(result);
    });
  });

const pauseInspect = async (debuggee) => {
  try {
    await send(debuggee, "Overlay.setInspectMode", { mode: "none" });
  } catch (err) {
    console.debug("[Immersive Speak] pauseInspect:", err);
  }
};

const resumeInspect = async (debuggee) => {
  try {
    await send(debuggee, "Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig
    });
  } catch (err) {
    console.debug("[Immersive Speak] resumeInspect:", err);
  }
};

const detach = async debuggee => {
  try {
    await send(debuggee, "Overlay.setInspectMode", { mode: "none" });
  } catch (err) {
    console.debug("[Immersive Speak] overlay disable:", err);
  }
  try {
    await chrome.debugger.detach(debuggee);
  } catch (err) {
    console.debug("[Immersive Speak] detach:", err);
  }
};

const startSession = async (tabId) => {
  if (sessions.has(tabId)) return;
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, PROTOCOL_VERSION);
    await send(debuggee, "DOM.enable");
    await send(debuggee, "Overlay.enable");
    sessions.set(tabId, { debuggee });
    await send(debuggee, "Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig
    });
  } catch (err) {
    console.warn("[Immersive Speak] startSession:", err);
    sessions.delete(tabId);
    await detach(debuggee);
  }
};

const injectEngine = async (tabId) => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-engine.js"]
    });
  } catch (err) {
    console.warn("[Immersive Speak] engine injection:", err);
  }
};

const handleNode = async (session, backendNodeId) => {
  const { debuggee } = session;
  const tabId = debuggee.tabId;
  try {
    const { object } = await send(debuggee, "DOM.resolveNode", { backendNodeId });
    await send(debuggee, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.setAttribute("${TARGET_ATTR}", "true"); }`
    });
  } catch (err) {
    console.warn("[Immersive Speak] handleNode resolve:", err);
  }

  sessions.delete(tabId);
  await detach(debuggee);

  await injectEngine(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, { type: GROQ_MESSAGES.START });
  } catch (err) {
    console.warn("[Immersive Speak] sendMessage groq-tts-start:", err);
  }
};

// ─── CDP event listeners ──────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Overlay.inspectNodeRequested" || !params?.backendNodeId) return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  handleNode(session, params.backendNodeId);
});

chrome.debugger.onDetach.addListener(source => {
  sessions.delete(source.tabId);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (sessions.has(tab.id)) {
    const { debuggee } = sessions.get(tab.id);
    sessions.delete(tab.id);
    await detach(debuggee);
    return;
  }
  const settings = await getSettings();
  if (settings.agent_mode) {
    await injectEngine(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: GROQ_MESSAGES.AGENT_START });
    } catch (err) {
      console.warn("[Immersive Speak] sendMessage groq-tts-agent-start:", err);
    }
    return;
  }
  await startSession(tab.id);
});

// ─── Message handler (picker resume + engine injection) ───────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === GROQ_MESSAGES.RESUME_PICKER) {
    const tabId = sender?.tab?.id;
    if (tabId && sessions.has(tabId)) {
      const { debuggee } = sessions.get(tabId);
      resumeInspect(debuggee);
    }
    return;
  }

  if (msg.type === GROQ_MESSAGES.AGENT_SELECT) {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.api_key) {
          sendResponse({ ok: false, error: "Missing Groq API key. Set it in the extension options." });
          return;
        }
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
          sendResponse({ ok: false, error: "Missing Groq API key. Set it in the extension options." });
          return;
        }
        const text = String(msg.text || "").trim();
        if (!text) {
          sendResponse({ ok: false, error: "No text provided." });
          return;
        }
        const { buffer, mime } = await fetchTts(text, settings);
        sendResponse({ ok: true, audio: arrayBufferToBase64(buffer), mime });
      } catch (err) {
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
});

// ─── Streaming TTS via ports ──────────────────────────────────────────

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
      try { port.postMessage({ type: "error", error: "Missing Groq API key. Set it in the extension options." }); } catch (_) {}
      return;
    }

    const chunks = Array.isArray(msg.chunks) ? msg.chunks : [];
    if (!chunks.length) {
      try { port.postMessage({ type: "error", error: "No text provided." }); } catch (_) {}
      return;
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (controller.signal.aborted) break;
        const { buffer, mime } = await fetchTts(chunks[i], settings, controller.signal);
        if (controller.signal.aborted) break;
        const words = await fetchStt(buffer, mime, settings, controller.signal);
        if (controller.signal.aborted) break;
        try {
          port.postMessage({
            type: "chunk",
            index: i,
            result: { audio: arrayBufferToBase64(buffer), mime, words }
          });
        } catch (_) {
          break;
        }
      }
      if (!controller.signal.aborted) {
        try { port.postMessage({ type: "done" }); } catch (_) {}
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      try {
        port.postMessage({ type: "error", error: err?.message || String(err) });
      } catch (_) {
        // Port may have disconnected
      }
    }
  });
});
