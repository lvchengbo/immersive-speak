# Immersive Speak

A Chrome extension that reads web content aloud with real-time word-by-word highlighting. Powered by [Groq](https://groq.com/) for ultra-fast TTS and STT.

## Features

- **Element Picker** — Click the toolbar icon, then click any element on the page to hear it read aloud. Lightweight content-script overlay — no `debugger` permission required.
- **Word-by-Word Highlighting** — Each word lights up in sync with the audio using the [CSS Custom Highlight API](https://www.w3.org/TR/css-highlight-api-1/).
- **Floating Mini-Player** — Compact play/pause/skip/stop controls appear during playback.
- **Keyboard Navigation** — Use arrow keys to roam word-by-word across paragraphs, Space to pause/resume, Escape to cancel.
- **Agent Mode** — An AI agent automatically identifies the main readable content on the page and reads it in sequence.
- **Speech Mode** — Adds inline play buttons to paragraphs instead of immersive highlighting.
- **Auto-Speak** — Optionally reads aloud when you select text in a paragraph.
- **Streaming Chunks** — Long text is split into chunks and streamed progressively for low-latency playback.
- **IndexedDB Cache** — TTS results are cached locally for instant replays and reduced API usage.
- **Resilient Pipeline** — Automatic retry with exponential backoff; graceful fallback when STT alignment fails.
- **Internationalization** — UI strings use `chrome.i18n`; STT language auto-detected from browser locale.
- **Accessible** — `aria-live` announcements for screen readers, `aria-pressed` on speech buttons, `focus-visible` styles.
- **Dark Mode** — Highlight colors adapt to light and dark themes.
- **Opt-In Analytics** — Lightweight, privacy-respecting usage counters (disabled by default).

## Requirements

- Chrome 105+ (for CSS Custom Highlight API support)
- A [Groq API key](https://console.groq.com/)

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Click the Immersive Speak icon in the toolbar and open **Options** to set your Groq API key.

## Usage

### Manual Mode

1. Click the **Immersive Speak** icon in the Chrome toolbar.
2. A yellow highlight overlay appears — click any element on the page.
3. The extension reads the element's text aloud with word-by-word highlighting.
4. Use the floating mini-player to control playback.

### Agent Mode

1. Enable **Agent mode** in the extension options.
2. Click the toolbar icon — the agent analyzes the page and reads the main content automatically.

### Keyboard Controls

| Key | Action |
|-----|--------|
| `Space` | Pause / Resume playback |
| `Left Arrow` | Move to previous word |
| `Right Arrow` | Move to next word |
| `Escape` | Stop playback / Cancel picker |

### Auto-Speak

Enable **Auto-speak** in options. Selecting text within a paragraph will automatically trigger TTS.

## Configuration

Open the extension options page to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| Groq API Key | Your Groq API key | — |
| TTS Model | Text-to-speech model | `canopylabs/orpheus-v1-english` |
| Voice | TTS voice | `troy` |
| Audio Format | Output format (wav, mp3, opus, aac, flac) | `wav` |
| STT Model | Speech-to-text model for word timing | `whisper-large-v3-turbo` |
| STT Language | Language hint (auto-detected from browser) | auto |
| Max Characters | Characters per chunk | `200` |
| Agent Model | LLM for content selection | `moonshotai/kimi-k2-instruct-0905` |
| Auto-speak | Speak on text selection | On |
| Agent Mode | AI content picker on toolbar click | On |
| Speech Mode | Inline play buttons instead of highlighting | Off |
| Analytics | Anonymous usage analytics | Off |

### Audio Cache

The options page includes a cache management section. Cached TTS results are stored in IndexedDB to speed up repeated playback and reduce API calls. You can view the cache entry count and clear the cache at any time.

## Architecture

```
_locales/           Internationalization message files
shared.js           Shared constants, defaults, and i18n helper
content-stub.js     Lightweight stub injected on all pages (lazy loader)
content-engine.js   Main engine — picker, TTS playback, highlighting, mini-player, keyboard nav
background.js       Service worker — Groq API calls, retry/backoff, IndexedDB cache, analytics
options.html/js/css Settings page with cache management
```

The extension uses a two-stage content script architecture: `content-stub.js` is loaded on every page but does minimal work. The full `content-engine.js` is only injected on-demand when the user activates the extension, keeping memory usage low.

## How It Works

1. **Element picker** — A content-script overlay highlights elements on hover using `document.elementFromPoint`. On click, the element is marked for reading.
2. **Text extraction** — Walks the DOM with TreeWalker to map every visible word to its text node and character offsets.
3. **Chunking** — Splits text into chunks at sentence boundaries, respecting the max character limit.
4. **TTS** — Sends each chunk to Groq's TTS API (with retry and backoff) and streams results back via a long-lived port. Results are cached in IndexedDB.
5. **STT alignment** — Sends the audio back through Groq's STT API to get per-word timestamps. Falls back to evenly-distributed timing if STT fails.
6. **Highlighting** — Uses the CSS Custom Highlight API to highlight each word in real-time as the audio plays, synchronized via `requestAnimationFrame`.

## License

[MIT](LICENSE)
