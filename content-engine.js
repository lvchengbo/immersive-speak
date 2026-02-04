/* Immersive Speak — main engine (lazily injected by background on first activation).
   Handles TTS streaming playback, word-by-word highlighting via CSS Custom Highlight API, and keyboard nav. */
(() => {
  if (window.__groqTtsEngine) return;

  const STYLE_ID = "groq-tts-style";
  const TARGET_ATTR = GROQ_TARGET_ATTR;
  const TARGET_SELECTOR = `[${TARGET_ATTR}]`;
  const READING_ROOT_SELECTOR = "article, main, [role='main']";
  const EXCLUDED_READING_SELECTOR = "nav, aside, [role='navigation'], [role='complementary'], [role='contentinfo'], [role='banner']";
  const LOCAL_SETTINGS_DEFAULTS = {
    max_chars: GROQ_DEFAULTS.max_chars,
    auto_speak: GROQ_DEFAULTS.auto_speak,
    agent_mode: GROQ_DEFAULTS.agent_mode,
    agent_model: GROQ_DEFAULTS.agent_model,
    speech_mode: GROQ_DEFAULTS.speech_mode
  };

  let session = null;
  let lastSelectionText = "";
  let lastSelectionAt = 0;
  let cachedSettings = null;
  let settingsPromise = null;
  let agentRunToken = 0;
  const speechEntries = new Set();

  const SPEECH_ICON_PLAY = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>';
  const SPEECH_ICON_PAUSE = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M3 1h3v14H3zm7 0h3v14h-3z"/></svg>';
  const SPEECH_ICON_LOADING = '<svg viewBox="0 0 16 16" width="12" height="12" class="groq-tts-speech-spin"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="25 12"/></svg>';

  injectStyles();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!cachedSettings) cachedSettings = { ...LOCAL_SETTINGS_DEFAULTS };
    for (const [key, entry] of Object.entries(changes || {})) {
      if (key in LOCAL_SETTINGS_DEFAULTS) {
        cachedSettings[key] = entry?.newValue ?? LOCAL_SETTINGS_DEFAULTS[key];
      }
    }
  });

  // ─── Event listeners ────────────────────────────────────────────────

  document.addEventListener("keydown", evt => {
    if (evt.key === "Escape") {
      speechCleanupAll();
      stopSession("cancelled");
      return;
    }
    handlePlaybackKeys(evt);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || (msg.type !== GROQ_MESSAGES.START && msg.type !== GROQ_MESSAGES.AGENT_START)) return;

    if (msg.type === GROQ_MESSAGES.START) {
      (async () => {
        const target = document.querySelector(TARGET_SELECTOR);
        if (!target) {
          showToast("No element was selected.", true, 2500);
          sendResponse({ ok: false });
          return;
        }
        target.removeAttribute(TARGET_ATTR);

        const text = (target.textContent || "").trim();
        if (!text) {
          showToast("Selected element has no text.", true, 2500);
          sendResponse({ ok: false });
          return;
        }

        const settings = await getLocalSettings();
        if (settings.speech_mode) {
          if (session) stopSession("restart");
          speechModeActivate(target);
          sendResponse({ ok: true });
          return;
        }

        if (session) stopSession("restart");
        await speakParagraph(target, settings.max_chars);
        sendResponse({ ok: true });
      })();

      return true;
    }

    (async () => {
      const settings = await getLocalSettings();
      const ok = settings.speech_mode
        ? await startAgentSpeechMode()
        : await startAgentRead();
      sendResponse({ ok });
    })();
    return true;
  });

  // ─── Session factory ────────────────────────────────────────────────

  function createSession(paragraph, words) {
    const elements = new Map();
    if (paragraph) {
      const state = buildElementState(paragraph, words || []);
      elements.set(paragraph, state);
    }
    return {
      paragraph,
      cancelled: false,
      done: false,
      generateIndicator: null,
      port: null,
      ignorePortDisconnect: false,
      _resolve: null,

      audio: {
        el: null,
        blobUrl: null,
        userPaused: false,
        _cleanup: null
      },

      highlight: {
        wordEntries: [],
        activeWords: null,
        currentWordIndex: null,
        running: false
      },

      chunks: {
        chunkResults: [],
        chunkIndex: 0,
        pendingHighlightIndex: null,
        pendingStartIndex: null
      },

      roam: {
        active: false,
        elements,
        currentElement: paragraph || null,
        currentWordIndex: null,
        debounceTimer: null,
        debounceToken: 0,
        flowRoot: null,
        flow: []
      }
    };
  }

  // ─── Selection handling ─────────────────────────────────────────────

  function handleSelection() {
    (async () => {
      const settings = await getLocalSettings();
      if (!settings.auto_speak) return;

      const selectionInfo = getSelectedParagraph();
      if (!selectionInfo) return;

      const selectionText = window.getSelection()?.toString().trim() || "";
      const now = Date.now();
      if (selectionText && selectionText === lastSelectionText && (now - lastSelectionAt) < 1200) {
        return;
      }
      lastSelectionText = selectionText;
      lastSelectionAt = now;

      if (settings.speech_mode) {
        speechModeActivate(selectionInfo.paragraph);
        return;
      }

      if (session) stopSession("restart");
      await speakParagraph(selectionInfo.paragraph, settings.max_chars);
    })();
  }

  function getSelectedParagraph() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || !node.closest) return null;

    const paragraph = node.closest("p");
    if (!paragraph) return null;
    if (!paragraph.contains(range.startContainer) || !paragraph.contains(range.endContainer)) return null;
    if (paragraph.closest("input, textarea, [contenteditable='true']")) return null;

    return { paragraph };
  }

  // ─── Core pipeline ──────────────────────────────────────────────────

  function disconnectPort({ silent } = {}) {
    if (!session?.port) return;
    if (silent) session.ignorePortDisconnect = true;
    try { session.port.disconnect(); } catch (_) {}
    session.port = null;
  }

  function startChunkStream(chunkTexts, handlers) {
    if (!session || !Array.isArray(chunkTexts) || !chunkTexts.length) return null;
    const port = chrome.runtime.connect({ name: GROQ_MESSAGES.PORT });
    session.port = port;

    port.onMessage.addListener(msg => {
      if (!session || session.cancelled) return;
      if (msg.type === "chunk") {
        handlers?.onChunk?.(msg);
      } else if (msg.type === "done") {
        handlers?.onDone?.(msg);
      } else if (msg.type === "error") {
        handlers?.onError?.(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      if (session?.ignorePortDisconnect) {
        session.ignorePortDisconnect = false;
        return;
      }
      handlers?.onDisconnect?.();
    });

    port.postMessage({ type: "start", chunks: chunkTexts });
    return port;
  }

  function startChunkPlayback(result, wordSlice, startIndex) {
    if (!session || !result || !wordSlice?.length) return Promise.resolve();
    const safeIndex = Math.max(0, Math.min(wordSlice.length - 1, startIndex ?? 0));
    session.chunks.pendingHighlightIndex = safeIndex;
    session.chunks.pendingStartIndex = safeIndex;
    session.done = false;
    disposeAudio();
    return playChunk(result, wordSlice);
  }

  async function speakParagraph(paragraph, maxChars) {
    const allWords = mapWords(paragraph);
    const words = filterVisibleWords(allWords, paragraph);
    const tokens = words.map(w => w.text).filter(Boolean);

    if (!tokens.length) return;

    const chunks = chunkTokens(tokens, maxChars || 200);
    const chunkTexts = chunks.map(c => c.text);
    const generateIndicator = showGenerateIndicator(paragraph);

    const chunkWords = [];
    {
      let offset = 0;
      for (const chunk of chunks) {
        chunkWords.push(words.slice(offset, offset + chunk.count));
        offset += chunk.count;
      }
    }

    session = createSession(paragraph, words);
    session.generateIndicator = generateIndicator;

    showToast("Generating speech...", false, 1200);

    // Promise resolves when all chunks have been played
    const allPlayed = new Promise(resolve => { session._resolve = resolve; });

    let allDelivered = false;
    let playing = false;

    startChunkStream(chunkTexts, {
      onChunk: msg => {
        session.chunks.chunkResults[msg.index] = msg.result;
        const text = chunkTexts[msg.index];
        if (text) cacheChunkResult(text, msg.result);
        if (msg.index === 0) clearGenerateIndicator();
        tryPlayNextChunk();
      },
      onError: msg => {
        stopSession("error");
        showToast(msg?.error || "Groq request failed", true, 3500);
      },
      onDone: () => { allDelivered = true; },
      onDisconnect: () => {
        if (!allDelivered && session && !session.cancelled) {
          stopSession("error");
          showToast("Connection to background lost.", true, 3000);
        }
      }
    });

    async function tryPlayNextChunk() {
      if (playing || !session || session.cancelled || session.roam?.active) return;

      const idx = session.chunks.chunkIndex;
      const result = session.chunks.chunkResults[idx];
      if (!result) return;

      playing = true;
      const wordSlice = chunkWords[idx];

      try {
        await startChunkPlayback(result, wordSlice, 0);
      } catch (_) { /* cleanup handled inside playChunk */ }

      playing = false;
      if (!session || session.cancelled || session.roam?.active) {
        session?._resolve?.();
        return;
      }

      session.chunks.chunkIndex += 1;

      if (session.chunks.chunkIndex >= chunkWords.length) {
        session._resolve?.();
        return;
      }

      tryPlayNextChunk();
    }

    await allPlayed;
    if (session?.roam?.active) return;
    stopSession("done");
  }

  // ─── Word mapping (no DOM modification) ────────────────────────────

  function mapWords(paragraph) {
    const words = [];
    const walker = document.createTreeWalker(
      paragraph,
      NodeFilter.SHOW_TEXT,
      { acceptNode: readableTextFilter }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      const regex = /[^\s]+/g;
      let match;
      while ((match = regex.exec(text))) {
        const raw = match[0];
        const normalized = normalizeWord(raw);
        if (!normalized) continue;
        words.push({
          node,
          start: match.index,
          end: match.index + raw.length,
          text: raw
        });
      }
    }

    return words;
  }

  function buildElementState(element, words) {
    return {
      element,
      words: words || [],
      maxChars: null,
      chunkTexts: [],
      chunkWords: [],
      wordToChunkIndex: [],
      wordToChunkOffset: []
    };
  }

  function readableTextFilter(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    const parent = node.parentElement;
    if (!parent) return NodeFilter.FILTER_REJECT;
    const tag = parent.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
    if (isExcludedFromReading(parent)) return NodeFilter.FILTER_REJECT;
    if (parent.closest("input, textarea, [contenteditable='true']")) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  function chunkTokens(tokens, maxChars) {
    const chunks = [];
    let current = [];
    let length = 0;
    const tolerance = Math.round(maxChars * 0.5);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const addLength = (current.length ? 1 : 0) + token.length;

      if (length + addLength > maxChars && current.length) {
        // Look ahead for a nearby sentence boundary to avoid mid-sentence splits
        let found = -1;
        let totalLen = length;
        for (let j = i; j < tokens.length; j++) {
          totalLen += 1 + tokens[j].length;
          if (totalLen > maxChars + tolerance) break;
          if (isSentenceEnd(tokens[j])) { found = j; break; }
        }

        if (found >= 0) {
          for (let j = i; j <= found; j++) current.push(tokens[j]);
          chunks.push({ text: current.join(" "), count: current.length });
          current = [];
          length = 0;
          i = found;
          continue;
        }

        chunks.push({ text: current.join(" "), count: current.length });
        current = [token];
        length = token.length;
      } else {
        current.push(token);
        length += addLength;
      }
    }

    if (current.length) {
      chunks.push({ text: current.join(" "), count: current.length });
    }

    return chunks;
  }

  function buildChunkMap(words, chunks) {
    const chunkTexts = chunks.map(c => c.text);
    const chunkWords = [];
    const wordToChunkIndex = [];
    const wordToChunkOffset = [];
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const slice = words.slice(offset, offset + chunk.count);
      chunkWords.push(slice);
      for (let j = 0; j < slice.length; j++) {
        wordToChunkIndex[offset + j] = i;
        wordToChunkOffset[offset + j] = j;
      }
      offset += chunk.count;
    }

    return { chunkTexts, chunkWords, wordToChunkIndex, wordToChunkOffset };
  }

  function ensureElementState(element, maxChars) {
    if (!session || !element) return null;
    const roam = session.roam;
    let state = roam.elements.get(element);
    if (!state) {
      const allWords = mapWords(element);
      const words = filterVisibleWords(allWords, element);
      state = buildElementState(element, words);
      roam.elements.set(element, state);
    }

    const max = maxChars || GROQ_DEFAULTS.max_chars;
    if (state.maxChars !== max || !state.chunkTexts.length) {
      const tokens = state.words.map(w => w.text).filter(Boolean);
      const chunks = chunkTokens(tokens, max);
      const map = buildChunkMap(state.words, chunks);
      state.chunkTexts = map.chunkTexts;
      state.chunkWords = map.chunkWords;
      state.wordToChunkIndex = map.wordToChunkIndex;
      state.wordToChunkOffset = map.wordToChunkOffset;
      state.maxChars = max;
    }

    return state;
  }

  function getChunkCache() {
    if (!session) return null;
    const results = session.chunks.chunkResults;
    if (!results.byKey) results.byKey = new Map();
    return results.byKey;
  }

  function cacheChunkResult(chunkText, result) {
    if (!chunkText || !session) return;
    const cache = getChunkCache();
    cache?.set(chunkText, result);
  }

  function filterVisibleWords(words, container) {
    if (!Array.isArray(words) || !words.length) return [];
    const containerRect = container?.getBoundingClientRect?.() || null;
    return words.filter(word => isWordVisible(word, containerRect));
  }

  function isWordVisible(word, containerRect) {
    if (!word || !word.node) return false;
    const parent = word.node.parentElement;
    if (!parent) return false;
    if (isExcludedFromReading(parent)) return false;
    const range = document.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
    const rects = range.getClientRects();
    if (!rects || rects.length === 0) return false;
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue;
      if (containerRect) {
        if (rect.right < containerRect.left || rect.left > containerRect.right) continue;
        if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
      }
      return true;
    }
    return false;
  }

  // ─── CSS Custom Highlight API ──────────────────────────────────────

  function setHighlightByIndex(wordIndex, words) {
    if (!words || wordIndex < 0 || wordIndex >= words.length) return;
    const word = words[wordIndex];
    if (!word || !word.node) return;
    try {
      const range = new Range();
      range.setStart(word.node, word.start);
      range.setEnd(word.node, word.end);
      const highlight = new Highlight(range);
      CSS.highlights.set("groq-tts-current", highlight);
    } catch (_) {
      // Node may have been removed from DOM
    }
    if (session) {
      session.highlight.currentWordIndex = wordIndex;
      if (session.roam?.active) {
        // wordIndex is chunk-relative; convert to element-relative
        const el = session.roam.currentElement;
        const state = el ? session.roam.elements.get(el) : null;
        if (state) {
          const elementIdx = state.words.indexOf(word);
          if (elementIdx !== -1) session.roam.currentWordIndex = elementIdx;
        }
      }
    }
  }

  function clearHighlight() {
    try {
      CSS.highlights.delete("groq-tts-current");
    } catch (_) {}
  }

  // ─── Audio playback ─────────────────────────────────────────────────

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function resultToArrayBuffer(result) {
    if (!result) return null;
    if (result.buffer instanceof ArrayBuffer) return result.buffer;
    if (result.buffer && result.buffer.buffer instanceof ArrayBuffer) {
      return result.buffer.buffer;
    }
    if (result.audio) return base64ToArrayBuffer(result.audio);
    return null;
  }

  function disposeAudio() {
    if (!session) return;
    const a = session.audio;
    if (a._cleanup) { a._cleanup(); a._cleanup = null; }
    if (a.el) {
      a.el.pause();
      a.el.onended = null;
      a.el.onerror = null;
      a.el.onloadedmetadata = null;
      a.el.src = "";
      a.el = null;
    }
    if (a.blobUrl) {
      URL.revokeObjectURL(a.blobUrl);
      a.blobUrl = null;
    }
  }

  async function playChunk(result, words) {
    if (!result || !words.length || !session || session.cancelled) return;

    const audioBuffer = resultToArrayBuffer(result);
    if (!audioBuffer) return;
    const blob = new Blob([audioBuffer], { type: result.mime || "audio/wav" });
    const url = URL.createObjectURL(blob);

    // Reuse existing Audio element to preserve autoplay permission across chunks
    let audio = session.audio.el;
    if (!audio) {
      audio = new Audio();
      session.audio.el = audio;
    }
    audio.onended = null;
    audio.onerror = null;
    audio.onloadedmetadata = null;
    audio.pause();
    if (session.audio.blobUrl) URL.revokeObjectURL(session.audio.blobUrl);
    audio.src = url;
    audio.preload = "auto";
    session.audio.blobUrl = url;

    let timingMap = buildTimingMap(words, result.words);
    timingMap = normalizeTimingMap(words, timingMap);
    updatePlaybackMaps(timingMap, words);

    return new Promise(resolve => {
      let cleaned = false;
      let resumeListeners = null;
      let highlightStarted = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (resumeListeners) {
          for (const { type, handler } of resumeListeners) {
            document.removeEventListener(type, handler, true);
          }
          resumeListeners = null;
        }
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.onloadedmetadata = null;
        resolve();
      };

      session.audio._cleanup = cleanup;

      audio.onerror = () => cleanup();
      audio.onended = () => cleanup();

      audio.onloadedmetadata = () => {
        if (audio.duration && words.length) {
          timingMap = normalizeTimingMap(words, timingMap, audio.duration);
          updatePlaybackMaps(timingMap, words);
        }

        const applyPending = () => {
          if (!session) return;
          const hi = session.chunks.pendingHighlightIndex;
          if (hi != null) {
            const entry = timingMap[hi];
            if (entry) {
              setHighlightByIndex(entry.wordIndex, session.highlight.activeWords);
            }
            session.chunks.pendingHighlightIndex = null;
          }
          const si = session.chunks.pendingStartIndex;
          if (si != null) {
            const entry = timingMap[si];
            if (entry) {
              audio.currentTime = Math.max(0, entry.start + 0.01);
            }
            session.chunks.pendingStartIndex = null;
          }
        };

        const startHL = () => {
          if (highlightStarted) return;
          highlightStarted = true;
          startHighlightLoop(audio, timingMap);
        };

        const attemptPlay = async (fromGesture) => {
          try {
            await audio.play();
            if (session) {
              session.audio.userPaused = false;
              session.chunks.pendingHighlightIndex = null;
              session.chunks.pendingStartIndex = null;
            }
            startHL();
          } catch (err) {
            if (err?.name === "NotAllowedError" && !fromGesture) {
              if (!resumeListeners) {
                const resume = () => {
                  if (resumeListeners) {
                    for (const { type, handler } of resumeListeners) {
                      document.removeEventListener(type, handler, true);
                    }
                    resumeListeners = null;
                  }
                  if (!session || session.cancelled) { cleanup(); return; }
                  attemptPlay(true);
                };
                resumeListeners = [
                  { type: "pointerdown", handler: resume },
                  { type: "mousedown", handler: resume },
                  { type: "keydown", handler: resume }
                ];
                for (const { type, handler } of resumeListeners) {
                  document.addEventListener(type, handler, true);
                }
                showToast(
                  "Audio playback is blocked. Click Resume or the page to continue.",
                  true, 8000,
                  { label: "Resume", onClick: resume }
                );
              }
              return;
            }
            showToast("Audio playback failed. Try again.", true, 3500);
            cleanup();
          }
        };

        applyPending();
        attemptPlay(false);
      };
    });
  }

  // ─── Timing & highlighting ──────────────────────────────────────────

  function buildTimingMap(words, sttWords) {
    if (!Array.isArray(sttWords) || !sttWords.length) return [];
    const normalizedWords = words.map(w => normalizeWord(w.text));
    const normalizedStt = sttWords.map(word => ({
      text: normalizeWord(word.word || word.text || ""),
      start: word.start ?? 0,
      end: word.end ?? 0
    }));

    const map = [];
    const LOOKAHEAD = 3;
    const skipEmptyStt = idx => {
      while (idx < normalizedStt.length && !normalizedStt[idx].text) idx += 1;
      return idx;
    };
    const skipEmptyWord = idx => {
      while (idx < normalizedWords.length && !normalizedWords[idx]) idx += 1;
      return idx;
    };

    let i = skipEmptyStt(0);
    let j = skipEmptyWord(0);
    while (i < normalizedStt.length && j < normalizedWords.length) {
      const w = normalizedStt[i];
      const s = normalizedWords[j];

      if (!s) { j = skipEmptyWord(j + 1); continue; }
      if (!w?.text) { i = skipEmptyStt(i + 1); continue; }

      if (w.text === s) {
        map.push({ wordIndex: j, start: w.start, end: w.end });
        i = skipEmptyStt(i + 1);
        j = skipEmptyWord(j + 1);
        continue;
      }

      let advanced = false;
      for (let wi = 1; wi <= LOOKAHEAD && i + wi < normalizedStt.length; wi++) {
        const next = normalizedStt[i + wi];
        if (!next?.text) continue;
        if (next.text === s) {
          i = skipEmptyStt(i + wi);
          advanced = true;
          break;
        }
      }
      if (advanced) continue;

      for (let sj = 1; sj <= LOOKAHEAD && j + sj < normalizedWords.length; sj++) {
        const next = normalizedWords[j + sj];
        if (!next) continue;
        if (next === w.text) {
          j = skipEmptyWord(j + sj);
          advanced = true;
          break;
        }
      }
      if (advanced) continue;

      map.push({ wordIndex: j, start: w.start, end: w.end });
      i = skipEmptyStt(i + 1);
      j = skipEmptyWord(j + 1);
    }

    return map;
  }

  function buildFallbackMap(words, duration) {
    if (!duration || !words.length) return [];
    const per = duration / words.length;
    return words.map((_, idx) => ({
      wordIndex: idx,
      start: idx * per,
      end: (idx + 1) * per
    }));
  }

  function normalizeTimingMap(words, timingMap, duration) {
    if (!words.length) return [];
    if (!Array.isArray(timingMap)) timingMap = [];

    const entries = new Array(words.length).fill(null);
    let avg = 0;
    let count = 0;

    for (const entry of timingMap) {
      if (!entry || entry.wordIndex == null) continue;
      entries[entry.wordIndex] = { ...entry };
      if (entry.end > entry.start) {
        avg += (entry.end - entry.start);
        count += 1;
      }
    }

    if (!count) {
      avg = duration ? duration / words.length : 0.35;
    } else {
      avg = avg / count;
    }

    const firstKnown = entries.findIndex(e => e);
    if (firstKnown === -1) {
      if (duration) return buildFallbackMap(words, duration);
      return words.map((_, idx) => ({
        wordIndex: idx,
        start: idx * avg,
        end: (idx + 1) * avg
      }));
    }

    for (let i = firstKnown - 1; i >= 0; i--) {
      const next = entries[i + 1];
      const end = next?.start ?? (avg * (i + 1));
      const start = Math.max(0, end - avg);
      entries[i] = { wordIndex: i, start, end };
    }

    let prev = firstKnown;
    for (let i = firstKnown + 1; i < entries.length; i++) {
      if (entries[i]) { prev = i; continue; }
      let next = i + 1;
      while (next < entries.length && !entries[next]) next += 1;
      const gap = next - prev;
      if (next < entries.length) {
        const start = entries[prev]?.end ?? (avg * prev);
        const end = entries[next]?.start ?? (start + avg * gap);
        let step = (end - start) / gap;
        if (!Number.isFinite(step) || step <= 0) step = avg;
        for (let k = 1; k < gap; k++) {
          const s = start + step * (k - 1);
          const e = start + step * k;
          const idx = prev + k;
          entries[idx] = { wordIndex: idx, start: s, end: e };
        }
      } else {
        let start = entries[prev]?.end ?? (avg * prev);
        for (let k = 1; k < gap; k++) {
          const idx = prev + k;
          const end = start + avg;
          entries[idx] = { wordIndex: idx, start, end };
          start = end;
        }
      }
      prev = Math.min(next, entries.length - 1);
    }

    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) {
        const start = i * avg;
        entries[i] = { wordIndex: i, start, end: start + avg };
      }
    }

    const minDur = Math.max(avg * 0.4, 0.04);
    let lastEnd = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const start = Math.max(entry.start ?? lastEnd, lastEnd);
      const end = Math.max(entry.end ?? (start + minDur), start + minDur);
      entry.start = start;
      entry.end = end;
      lastEnd = end;
    }

    return entries;
  }

  function findWordIndexByTime(entries, time) {
    if (!entries.length) return 0;
    let lo = 0;
    let hi = entries.length - 1;
    if (time <= entries[0].start) return 0;
    if (time >= entries[hi].end) return hi;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = entries[mid];
      if (time >= entry.start && time <= entry.end) return mid;
      if (time < entry.start) hi = mid - 1;
      else lo = mid + 1;
    }
    return Math.max(0, Math.min(entries.length - 1, lo));
  }

  function highlightLoop(audio, timingMap) {
    if (!timingMap.length || !session) return;

    const tick = () => {
      if (!session || session.cancelled || audio.paused || audio.ended) {
        if (session) session.highlight.running = false;
        return;
      }

      const t = audio.currentTime;
      const index = findWordIndexByTime(timingMap, t);
      const entry = timingMap[index];
      if (entry && session.highlight.activeWords) {
        setHighlightByIndex(entry.wordIndex, session.highlight.activeWords);
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  function startHighlightLoop(audio, timingMap) {
    if (!session || session.highlight.running) return;
    session.highlight.running = true;
    highlightLoop(audio, timingMap);
  }

  function updatePlaybackMaps(timingMap, words) {
    if (!session) return;
    const h = session.highlight;
    h.wordEntries = timingMap || [];
    h.activeWords = words || null;
    h.currentWordIndex = null;
  }

  // ─── Generate indicator ─────────────────────────────────────────────

  function showGenerateIndicator(target) {
    if (!target || !target.appendChild) return null;
    const indicator = document.createElement("div");
    indicator.className = "groq-tts-generating";
    indicator.setAttribute("aria-hidden", "true");
    target.appendChild(indicator);

    return {
      el: indicator,
      cleanup: () => indicator.remove()
    };
  }

  function clearGenerateIndicator() {
    if (!session?.generateIndicator) return;
    session.generateIndicator.cleanup();
    session.generateIndicator = null;
  }

  // ─── Keyboard playback controls ────────────────────────────────────

  function handlePlaybackKeys(evt) {
    if (!session) return;
    if (isEditableTarget(evt.target)) return;

    if (evt.code === "Space" || evt.key === " ") {
      evt.preventDefault();
      togglePlayPause();
      return;
    }

    if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
      evt.preventDefault();
      const dir = evt.key === "ArrowRight" ? 1 : -1;
      handleRoamNavigation(dir);
    }
  }

  const ROAM_DEBOUNCE_MS = 300;

  function handleRoamNavigation(direction) {
    if (!session) return;
    enterRoamMode();
    abortRoamPlayback();

    const roam = session.roam;
    const maxChars = cachedSettings?.max_chars ?? LOCAL_SETTINGS_DEFAULTS.max_chars;

    let element = roam.currentElement || session.paragraph;
    let state = ensureElementState(element, maxChars);
    if (!state || !state.words.length) return;

    let index = roam.currentWordIndex;
    if (index == null) {
      // Derive element-relative index from chunk-relative highlight position
      const activeWords = session.highlight.activeWords;
      const hlIdx = session.highlight.currentWordIndex;
      if (activeWords && hlIdx != null && hlIdx >= 0 && hlIdx < activeWords.length) {
        const found = state.words.indexOf(activeWords[hlIdx]);
        if (found !== -1) index = found;
      }
      if (index == null) index = 0;
    }

    while (true) {
      const nextIndex = index + direction;
      if (nextIndex >= 0 && nextIndex < state.words.length) {
        index = nextIndex;
        break;
      }
      const nextElement = direction > 0
        ? findReadableElement(element, true)
        : findReadableElement(element, false);
      if (!nextElement) return;
      element = nextElement;
      state = ensureElementState(element, maxChars);
      if (!state || !state.words.length) continue;
      index = direction > 0 ? 0 : state.words.length - 1;
      break;
    }

    if (index < 0 || index >= state.words.length) return;
    session.paragraph = element;
    session.roam.currentElement = element;
    session.roam.currentWordIndex = index;
    setHighlightByIndex(index, state.words);
    scheduleRoamPlayback();
  }

  function enterRoamMode() {
    if (!session?.roam) return;
    session.roam.active = true;
    if (session.cancelled) session.cancelled = false;
    if (session.done) session.done = false;
    ensureRoamFlow(session.roam.currentElement || session.paragraph);
  }

  function abortRoamPlayback() {
    if (!session) return;
    if (session.roam?.debounceTimer) {
      clearTimeout(session.roam.debounceTimer);
      session.roam.debounceTimer = null;
    }
    if (session.roam) session.roam.debounceToken += 1;
    session.chunks.pendingHighlightIndex = null;
    session.chunks.pendingStartIndex = null;
    session.audio.userPaused = true;
    disposeAudio();
    session.highlight.running = false;
    disconnectPort({ silent: true });
    clearGenerateIndicator();
  }

  function scheduleRoamPlayback() {
    if (!session?.roam) return;
    if (session.roam.debounceTimer) clearTimeout(session.roam.debounceTimer);
    const token = ++session.roam.debounceToken;
    session.roam.debounceTimer = setTimeout(() => {
      if (!session || session.roam.debounceToken !== token) return;
      startRoamPlayback(token);
    }, ROAM_DEBOUNCE_MS);
  }

  async function startRoamPlayback(token) {
    if (!session || session.cancelled || !session.roam?.active) return;
    if (session.roam.debounceToken !== token) return;

    const settings = await getLocalSettings();
    if (!session || session.cancelled || session.roam.debounceToken !== token) return;

    const roam = session.roam;
    const element = roam.currentElement || session.paragraph;
    const state = ensureElementState(element, settings.max_chars);
    if (!state || !state.words.length) return;

    let wordIndex = roam.currentWordIndex;
    if (wordIndex == null) {
      wordIndex = 0;
      roam.currentWordIndex = wordIndex;
    }

    const chunkIndex = state.wordToChunkIndex[wordIndex] ?? 0;
    const chunkText = state.chunkTexts[chunkIndex];
    const wordSlice = state.chunkWords[chunkIndex];
    const startIndex = state.wordToChunkOffset[wordIndex] ?? 0;
    if (!chunkText || !wordSlice?.length) return;

    const cache = getChunkCache();
    const cached = cache?.get(chunkText);
    if (cached) {
      startChunkPlayback(cached, wordSlice, startIndex);
      return;
    }

    requestChunkPlayback(chunkText, wordSlice, startIndex, token, element);
  }

  function requestChunkPlayback(chunkText, wordSlice, startIndex, token, element) {
    clearGenerateIndicator();
    if (element) {
      session.generateIndicator = showGenerateIndicator(element);
    }

    disconnectPort({ silent: true });

    startChunkStream([chunkText], {
      onChunk: msg => {
        if (!session || session.cancelled) return;
        if (session.roam.debounceToken !== token) return;
        cacheChunkResult(chunkText, msg.result);
        clearGenerateIndicator();
        startChunkPlayback(msg.result, wordSlice, startIndex);
      },
      onError: msg => {
        if (session.roam.debounceToken !== token) return;
        clearGenerateIndicator();
        showToast(msg?.error || "Groq request failed", true, 3500);
      },
      onDisconnect: () => {
        if (!session || session.cancelled) return;
        if (session.roam.debounceToken !== token) return;
        clearGenerateIndicator();
        showToast("Connection to background lost.", true, 3000);
      }
    });
  }

  const AGENT_MAX_BLOCKS = 50;
  const AGENT_MIN_WORDS = 12;
  const AGENT_SNIPPET_CHARS = 320;

  async function startAgentRead() {
    const settings = await getLocalSettings();
    if (!settings.agent_mode) {
      showToast("Agent mode is disabled in options.", true, 2200);
      return false;
    }

    const token = ++agentRunToken;
    if (session) stopSession("restart");

    const candidates = collectCandidateBlocks();
    if (!candidates.length) {
      showToast("No readable content found.", true, 2200);
      return false;
    }

    showToast("Analyzing page...", false, 1200);
    const agentCandidates = candidates.length > AGENT_MAX_BLOCKS
      ? [...candidates].sort((a, b) => b.words - a.words).slice(0, AGENT_MAX_BLOCKS)
      : candidates;
    const payload = agentCandidates.map(block => ({
      id: block.id,
      tag: block.tag,
      words: block.words,
      link_ratio: block.linkRatio,
      text: block.snippet
    }));

    const selection = await requestAgentSelection(payload);
    if (token !== agentRunToken) return false;
    if (!selection.ok) {
      showToast(selection.error || "Agent request failed", true, 3500);
      return false;
    }

    const readIds = Array.isArray(selection.readIds) ? selection.readIds : [];
    let ordered = [];
    if (readIds.length) {
      const idSet = new Set(readIds);
      ordered = candidates.filter(block => idSet.has(block.id));
    }

    if (!ordered.length) {
      const fallback = [...candidates]
        .sort((a, b) => b.words - a.words)
        .slice(0, Math.min(3, candidates.length));
      if (!fallback.length) {
        showToast("Agent selection empty.", true, 2200);
        return false;
      }
      showToast("Agent returned no results. Reading top sections.", true, 2200);
      ordered = fallback;
    }

    const orderedIds = new Set(ordered.map(block => block.id));
    flashAgentBlocks(ordered, orderedIds);

    for (const block of ordered) {
      if (token !== agentRunToken) break;
      if (session?.roam?.active) break;
      if (session) stopSession("restart");
      await speakParagraph(block.element, settings.max_chars);
      if (token !== agentRunToken) break;
      if (session?.roam?.active) break;
      if (!session) break;
    }

    return true;
  }

  function collectCandidateBlocks(maxBlocks) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: readableTextFilter }
    );

    const seen = new Set();
    const candidates = [];
    let order = 0;

    while (walker.nextNode()) {
      const container = getReadableContainer(walker.currentNode);
      if (!container || seen.has(container)) continue;
      seen.add(container);
      if (!isCandidateBlock(container)) continue;

      const text = (container.textContent || "").trim();
      if (!text) continue;
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < AGENT_MIN_WORDS) continue;

      const linkText = Array.from(container.querySelectorAll("a"))
        .map(a => a.textContent || "")
        .join(" ");
      const linkWords = linkText.split(/\s+/).filter(Boolean).length;
      const linkRatio = words.length ? Math.min(1, linkWords / words.length) : 0;

      candidates.push({
        id: order,
        order,
        element: container,
        tag: container.tagName.toLowerCase(),
        words: words.length,
        linkRatio: Number(linkRatio.toFixed(3)),
        snippet: text.slice(0, AGENT_SNIPPET_CHARS)
      });
      order += 1;
    }

    if (!Number.isFinite(maxBlocks) || maxBlocks <= 0) return candidates;
    if (candidates.length <= maxBlocks) return candidates;

    const top = [...candidates]
      .sort((a, b) => b.words - a.words)
      .slice(0, maxBlocks);
    const keep = new Set(top.map(item => item.id));
    return candidates.filter(item => keep.has(item.id));
  }

  function requestAgentSelection(blocks) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: GROQ_MESSAGES.AGENT_SELECT, blocks },
        response => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response || { ok: false, error: "No response from agent." });
        }
      );
    });
  }

  function flashAgentBlocks(blocks, preselectedIds) {
    if (!Array.isArray(blocks) || !blocks.length) return () => {};
    const elements = [];
    const idSet = preselectedIds && preselectedIds.size ? preselectedIds : null;
    for (const block of blocks) {
      if (idSet && !idSet.has(block.id)) continue;
      const el = block?.element;
      if (!el || !(el instanceof Element)) continue;
      el.classList.add("groq-tts-agent-flash");
      elements.push(el);
    }
    const timeout = setTimeout(() => {
      for (const el of elements) el.classList.remove("groq-tts-agent-flash");
    }, 1400);
    return () => {
      clearTimeout(timeout);
      for (const el of elements) el.classList.remove("groq-tts-agent-flash");
    };
  }

  function togglePlayPause() {
    const audio = session?.audio.el;
    if (!audio) return;
    if (audio.paused || audio.ended) {
      audio.play().then(() => {
        if (session) {
          session.audio.userPaused = false;
          session.done = false;
        }
        startHighlightLoop(audio, session.highlight.wordEntries);
      }).catch(() => {
        showToast("Audio playback is blocked. Click anywhere to resume.", true, 4500);
      });
    } else {
      audio.pause();
      if (session) session.audio.userPaused = true;
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────

  function getReadingRoot(element) {
    if (!element) return document.body;
    return element.closest(READING_ROOT_SELECTOR) || document.body;
  }

  function isExcludedFromReading(element) {
    if (!element || !element.closest) return false;
    if (element.closest("[aria-hidden='true'], [hidden], [inert], [role='img'], img, svg, pre")) return true;
    if (element.closest(EXCLUDED_READING_SELECTOR)) return true;
    return false;
  }

  function buildReadableFlow(root) {
    if (!root) return [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      { acceptNode: readableTextFilter }
    );
    const seen = new Set();
    const flow = [];
    while (walker.nextNode()) {
      const container = getReadableContainer(walker.currentNode);
      if (!container || seen.has(container)) continue;
      if (isExcludedFromReading(container)) continue;
      seen.add(container);
      flow.push(container);
    }
    return flow;
  }

  function ensureRoamFlow(current) {
    if (!session?.roam) return [];
    const root = getReadingRoot(current || session.paragraph);
    const roam = session.roam;
    const needsRebuild = !Array.isArray(roam.flow) || !roam.flow.length
      || roam.flowRoot !== root
      || (current && !roam.flow.includes(current));
    if (needsRebuild) {
      roam.flowRoot = root;
      roam.flow = buildReadableFlow(root);
    }
    return roam.flow || [];
  }

  function resolveReadableContainer(element) {
    if (!element) return null;
    if (element.nodeType === Node.TEXT_NODE) return getReadableContainer(element);
    if (element instanceof Element) {
      if (isCandidateBlock(element)) return element;
      let el = element;
      while (el && el !== document.body) {
        if (isCandidateBlock(el)) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  function findReadableElement(current, forward) {
    if (!current || !document.body) return null;
    const flow = ensureRoamFlow(current);
    if (flow.length) {
      let idx = flow.indexOf(current);
      if (idx === -1) {
        const container = resolveReadableContainer(current);
        if (container) idx = flow.indexOf(container);
      }
      if (idx !== -1) {
        const next = flow[idx + (forward ? 1 : -1)];
        if (next) return next;
      }
    }

    const root = getReadingRoot(current);
    const walker = document.createTreeWalker(
      root, NodeFilter.SHOW_TEXT, { acceptNode: readableTextFilter }
    );

    let edge = current;
    while (edge && (forward ? edge.lastChild : edge.firstChild)) {
      edge = forward ? edge.lastChild : edge.firstChild;
    }
    walker.currentNode = edge || current;

    const step = forward ? () => walker.nextNode() : () => walker.previousNode();
    let node = step();
    while (node) {
      const container = getReadableContainer(node);
      if (container && container !== current && !current.contains(container)) {
        return container;
      }
      node = step();
    }
    return null;
  }

  function getReadableContainer(textNode) {
    let el = textNode.parentElement;
    while (el && el !== document.body) {
      if (isCandidateBlock(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isCandidateBlock(el) {
    if (!el) return false;
    if (isExcludedFromReading(el)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (!el.textContent || !el.textContent.trim()) return false;

    const tag = el.tagName;
    if (tag === "P" || tag === "LI" || tag === "BLOCKQUOTE" || tag === "PRE") return true;
    if (tag === "ARTICLE" || tag === "SECTION" || tag === "DIV") return true;
    if (tag === "TD" || tag === "TH") return true;

    const display = style.display;
    return display === "block" || display === "list-item" || display === "flex" || display === "grid" || display === "table";
  }

  // ─── Speech mode ────────────────────────────────────────────────────

  function speechModeActivate(paragraph) {
    if (paragraph.querySelector(".groq-tts-speech-btn")) return;

    const text = (paragraph.textContent || "").trim();
    if (!text) return;

    const btn = document.createElement("button");
    btn.className = "groq-tts-speech-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Listen");
    btn.setAttribute("data-state", "idle");
    btn.innerHTML = SPEECH_ICON_PLAY;

    let audio = null;
    let blobUrl = null;
    let cachedResult = null;

    const cleanup = () => {
      if (audio) { audio.pause(); audio.onended = null; audio.onerror = null; audio.src = ""; }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      audio = null;
      blobUrl = null;
      cachedResult = null;
      btn.remove();
    };

    btn.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();

      const state = btn.getAttribute("data-state");

      if (state === "playing") {
        if (audio) audio.pause();
        setSpeechBtnState(btn, "paused");
        return;
      }

      if (state === "paused") {
        if (audio) {
          audio.play().catch(() => {});
          setSpeechBtnState(btn, "playing");
        }
        return;
      }

      if (state === "loading") return;

      setSpeechBtnState(btn, "loading");

      try {
        let result = cachedResult;
        if (!result) {
          result = await speechRequestTts(text);
          if (!result.ok) {
            showToast(result.error || "TTS request failed", true, 3500);
            setSpeechBtnState(btn, "idle");
            return;
          }
          cachedResult = result;
        }

        const buffer = base64ToArrayBuffer(result.audio);
        const blob = new Blob([buffer], { type: result.mime || "audio/wav" });
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(blob);

        if (!audio) audio = new Audio();
        audio.src = blobUrl;
        audio.onended = () => setSpeechBtnState(btn, "idle");
        audio.onerror = () => setSpeechBtnState(btn, "idle");

        await audio.play();
        setSpeechBtnState(btn, "playing");
      } catch (err) {
        if (err?.name === "NotAllowedError") {
          showToast("Audio blocked by browser. Click the page first.", true, 3500);
        }
        setSpeechBtnState(btn, "idle");
      }
    });

    paragraph.appendChild(btn);

    const entry = { btn, paragraph, cleanup };
    speechEntries.add(entry);
  }

  function setSpeechBtnState(btn, state) {
    btn.setAttribute("data-state", state);
    if (state === "playing") {
      btn.innerHTML = SPEECH_ICON_PAUSE;
      btn.setAttribute("aria-label", "Pause");
    } else if (state === "loading") {
      btn.innerHTML = SPEECH_ICON_LOADING;
      btn.setAttribute("aria-label", "Loading...");
    } else if (state === "paused") {
      btn.innerHTML = SPEECH_ICON_PLAY;
      btn.setAttribute("aria-label", "Resume");
    } else {
      btn.innerHTML = SPEECH_ICON_PLAY;
      btn.setAttribute("aria-label", "Listen");
    }
  }

  function speechRequestTts(text) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: GROQ_MESSAGES.SPEECH_TTS, text },
        response => {
          const err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message }); return; }
          resolve(response || { ok: false, error: "No response." });
        }
      );
    });
  }

  function speechCleanupAll() {
    for (const entry of speechEntries) entry.cleanup();
    speechEntries.clear();
  }

  async function startAgentSpeechMode() {
    const settings = await getLocalSettings();
    if (!settings.agent_mode) {
      showToast("Agent mode is disabled in options.", true, 2200);
      return false;
    }

    const token = ++agentRunToken;
    if (session) stopSession("restart");

    const candidates = collectCandidateBlocks();
    if (!candidates.length) {
      showToast("No readable content found.", true, 2200);
      return false;
    }

    showToast("Analyzing page...", false, 1200);
    const agentCandidates = candidates.length > AGENT_MAX_BLOCKS
      ? [...candidates].sort((a, b) => b.words - a.words).slice(0, AGENT_MAX_BLOCKS)
      : candidates;
    const payload = agentCandidates.map(block => ({
      id: block.id,
      tag: block.tag,
      words: block.words,
      link_ratio: block.linkRatio,
      text: block.snippet
    }));

    const selection = await requestAgentSelection(payload);
    if (token !== agentRunToken) return false;
    if (!selection.ok) {
      showToast(selection.error || "Agent request failed", true, 3500);
      return false;
    }

    const readIds = Array.isArray(selection.readIds) ? selection.readIds : [];
    let ordered = [];
    if (readIds.length) {
      const idSet = new Set(readIds);
      ordered = candidates.filter(block => idSet.has(block.id));
    }

    if (!ordered.length) {
      const fallback = [...candidates]
        .sort((a, b) => b.words - a.words)
        .slice(0, Math.min(3, candidates.length));
      if (!fallback.length) {
        showToast("Agent selection empty.", true, 2200);
        return false;
      }
      showToast("Agent returned no results. Adding top sections.", true, 2200);
      ordered = fallback;
    }

    const orderedIds = new Set(ordered.map(block => block.id));
    flashAgentBlocks(ordered, orderedIds);

    for (const block of ordered) {
      if (token !== agentRunToken) break;
      speechModeActivate(block.element);
    }

    return true;
  }

  // ─── Session management ─────────────────────────────────────────────

  function stopSession(reason) {
    if (!session) return;
    const keepHighlight = reason === "done";
    session.cancelled = true;

    if (session.roam?.debounceTimer) {
      clearTimeout(session.roam.debounceTimer);
      session.roam.debounceTimer = null;
    }
    if (session.roam) session.roam.active = false;

    // Audio cleanup
    session.audio.userPaused = false;
    disposeAudio();

    // Highlight cleanup
    session.highlight.running = false;

    // Port cleanup
    disconnectPort();

    // Generate indicator cleanup
    if (session.generateIndicator) {
      session.generateIndicator.cleanup();
      session.generateIndicator = null;
    }

    // Clear CSS highlight
    if (!keepHighlight) {
      clearHighlight();
    }

    if (keepHighlight) {
      session.done = true;
    } else {
      session = null;
    }

    if (reason !== "restart") notifyPickerResume();
  }

  // ─── Utilities ──────────────────────────────────────────────────────

  function normalizeWord(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[\u02BC\u2018\u2019\u2032]/g, "'")
      .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  }

  function isSentenceEnd(text) {
    return /[.!?]+[\"')\\]]*$/.test((text || "").trim());
  }

  function isEditableTarget(target) {
    if (!target || target === document.body) return false;
    if (target.isContentEditable) return true;
    const el = target.closest?.("input, textarea, select, [contenteditable='true']");
    return Boolean(el);
  }

  function notifyPickerResume() {
    try {
      chrome.runtime.sendMessage({ type: GROQ_MESSAGES.RESUME_PICKER });
    } catch (err) {
      console.warn("[Immersive Speak]", err);
    }
  }

  function getLocalSettings() {
    if (cachedSettings) return Promise.resolve(cachedSettings);
    if (settingsPromise) return settingsPromise;
    settingsPromise = new Promise(resolve => {
      chrome.storage.local.get(LOCAL_SETTINGS_DEFAULTS, values => {
        cachedSettings = values;
        settingsPromise = null;
        resolve(values);
      });
    });
    return settingsPromise;
  }

  // ─── Toast notifications ────────────────────────────────────────────

  function showToast(message, isError, timeout, action) {
    const toast = document.createElement("div");
    toast.className = "groq-tts-toast";
    if (action && action.label && action.onClick) {
      toast.classList.add("has-action");
      const msg = document.createElement("span");
      msg.className = "message";
      msg.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action";
      button.textContent = action.label;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick();
      });
      toast.append(msg, button);
    } else {
      toast.textContent = message;
    }
    if (isError) toast.style.background = "rgba(176, 40, 40, 0.95)";
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 250);
    }, timeout || 2000);
  }

  // ─── Injected styles ───────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --groq-tts-highlight-bg: #ffe66b;
        --groq-tts-spinner-size: 1em;
        --groq-tts-spinner-border: 0.12em;
        --groq-tts-spinner-ring: rgba(0, 0, 0, 0.18);
        --groq-tts-spinner-accent: #f59e0b;
        --groq-tts-spinner-offset: -0.04em;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --groq-tts-highlight-bg: rgba(255, 214, 102, 0.28);
          --groq-tts-spinner-ring: rgba(255, 255, 255, 0.22);
          --groq-tts-spinner-accent: rgba(255, 214, 102, 0.9);
        }
      }
      ::highlight(groq-tts-current) {
        background-color: var(--groq-tts-highlight-bg);
        color: inherit;
      }
      .groq-tts-generating {
        display: inline-block;
        width: var(--groq-tts-spinner-size);
        height: var(--groq-tts-spinner-size);
        margin-left: 0.4em;
        vertical-align: middle;
        box-sizing: border-box;
        border: var(--groq-tts-spinner-border) solid var(--groq-tts-spinner-ring);
        border-top-color: var(--groq-tts-spinner-accent);
        border-radius: 999px;
        transform-origin: 50% 50%;
        animation: groq-tts-spin 0.8s linear infinite;
        pointer-events: none;
      }
      @keyframes groq-tts-spin {
        from { transform: translateY(var(--groq-tts-spinner-offset)) rotate(0deg); }
        to { transform: translateY(var(--groq-tts-spinner-offset)) rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .groq-tts-generating {
          animation: none;
          transform: translateY(var(--groq-tts-spinner-offset));
        }
        .groq-tts-speech-spin {
          animation: none;
        }
      }
      .groq-tts-toast {
        position: fixed;
        bottom: 16px;
        right: 16px;
        padding: 10px 14px;
        font: 12px/1.4 system-ui, sans-serif;
        background: rgba(30, 30, 30, 0.92);
        color: #fff;
        border-radius: 8px;
        z-index: 2147483647;
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .groq-tts-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .groq-tts-toast.has-action {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .groq-tts-toast .message {
        flex: 1 1 auto;
      }
      .groq-tts-toast .action {
        flex: 0 0 auto;
        color: #fff;
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-radius: 999px;
        padding: 4px 10px;
        font-weight: 600;
        font-size: 11px;
        background: rgba(255, 255, 255, 0.12);
        cursor: pointer;
        font: inherit;
        line-height: 1.2;
        appearance: none;
      }
      .groq-tts-toast .action:hover {
        background: rgba(255, 255, 255, 0.22);
      }
      .groq-tts-agent-flash {
        outline: 2px solid rgba(245, 158, 11, 0.0);
        outline-offset: 4px;
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0);
        animation: groq-tts-agent-flash 1.2s ease-in-out 1;
      }
      @keyframes groq-tts-agent-flash {
        0% {
          outline-color: rgba(245, 158, 11, 0.0);
          box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0);
        }
        35% {
          outline-color: rgba(245, 158, 11, 0.85);
          box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.35);
        }
        100% {
          outline-color: rgba(245, 158, 11, 0.0);
          box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0);
        }
      }
      .groq-tts-speech-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.6em;
        height: 1.6em;
        margin-left: 0.4em;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.08);
        color: inherit;
        cursor: pointer;
        vertical-align: middle;
        line-height: 1;
        opacity: 0.5;
        transition: opacity 150ms ease, background-color 150ms ease;
        appearance: none;
        outline: none;
      }
      .groq-tts-speech-btn:hover {
        opacity: 0.85;
        background: rgba(0, 0, 0, 0.14);
      }
      .groq-tts-speech-btn:focus-visible {
        opacity: 0.85;
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.8);
      }
      .groq-tts-speech-btn[data-state="playing"] {
        opacity: 0.85;
        background: rgba(245, 158, 11, 0.18);
      }
      .groq-tts-speech-btn[data-state="loading"] {
        opacity: 0.7;
        cursor: default;
      }
      .groq-tts-speech-btn svg {
        display: block;
      }
      @keyframes groq-tts-speech-spin {
        to { transform: rotate(360deg); }
      }
      .groq-tts-speech-spin {
        animation: groq-tts-speech-spin 0.8s linear infinite;
        transform-origin: 50% 50%;
        transform-box: fill-box;
      }
      @media (prefers-color-scheme: dark) {
        .groq-tts-speech-btn {
          background: rgba(255, 255, 255, 0.1);
        }
        .groq-tts-speech-btn:hover {
          background: rgba(255, 255, 255, 0.18);
        }
        .groq-tts-speech-btn[data-state="playing"] {
          background: rgba(255, 214, 102, 0.2);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  // ─── Register engine & process pending activation ───────────────────

  window.__groqTtsEngine = {
    handleSelection,
    activate(target) {
      (async () => {
        if (session) stopSession("restart");
        const settings = await getLocalSettings();
        await speakParagraph(target, settings.max_chars);
      })();
    },
    stop: () => stopSession("cancelled"),
    isActive: () => Boolean(session && !session.cancelled)
  };

  const stub = window.__groqTtsStub;
  if (stub) {
    stub.engineLoaded = true;

    const pending = stub.pending;
    if (pending) {
      stub.pending = null;
      if (pending.type === GROQ_MESSAGES.START) {
        const target = document.querySelector(TARGET_SELECTOR);
        if (target) {
          target.removeAttribute(TARGET_ATTR);
          window.__groqTtsEngine.activate(target);
        }
      } else if (pending.type === GROQ_MESSAGES.AGENT_START) {
        startAgentRead();
      }
    }

    const callback = stub.pendingCallback;
    if (callback) {
      stub.pendingCallback = null;
      callback();
    }
  }
})();
