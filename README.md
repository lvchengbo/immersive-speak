# Immersive Speak

A Chrome extension that reads web content aloud with real-time word-by-word highlighting. Powered by [Groq](https://groq.com/) for ultra-fast TTS and STT.

## Features

- **Element Picker** — Click the toolbar icon, then click any element on the page to hear it read aloud.
- **Word-by-Word Highlighting** — Each word lights up in sync with the audio using the [CSS Custom Highlight API](https://www.w3.org/TR/css-highlight-api-1/).
- **Keyboard Navigation** — Use arrow keys to roam word-by-word across paragraphs, Space to pause/resume, Escape to cancel.
- **Agent Mode** — An AI agent automatically identifies the main readable content on the page and reads it in sequence.
- **Speech Mode** — Adds inline play buttons to paragraphs instead of immersive highlighting.
- **Auto-Speak** — Optionally reads aloud when you select text in a paragraph.
- **Streaming Chunks** — Long text is split into chunks and streamed progressively for low-latency playback.
- **Dark Mode** — Highlight colors adapt to light and dark themes.

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

### Agent Mode

1. Enable **Agent mode** in the extension options.
2. Click the toolbar icon — the agent analyzes the page and reads the main content automatically.

### Keyboard Controls

| Key | Action |
|-----|--------|
| `Space` | Pause / Resume playback |
| `Left Arrow` | Move to previous word |
| `Right Arrow` | Move to next word |
| `Escape` | Stop playback |

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
| STT Language | Optional language hint | — |
| Max Characters | Characters per chunk | `200` |
| Agent Model | LLM for content selection | `moonshotai/kimi-k2-instruct-0905` |
| Auto-speak | Speak on text selection | On |
| Agent Mode | AI content picker on toolbar click | On |
| Speech Mode | Inline play buttons instead of highlighting | Off |

## Architecture

```
shared.js           Shared constants and defaults
content-stub.js     Lightweight stub injected on all pages (lazy loader)
content-engine.js   Main engine — TTS playback, highlighting, keyboard nav
background.js       Service worker — Groq API calls, CDP element picker
options.html/js/css Settings page
```

The extension uses a two-stage content script architecture: `content-stub.js` is loaded on every page but does minimal work. The full `content-engine.js` is only injected on-demand when the user activates the extension, keeping memory usage low.

## How It Works

1. **Text extraction** — Walks the DOM with TreeWalker to map every visible word to its text node and character offsets.
2. **Chunking** — Splits text into chunks at sentence boundaries, respecting the max character limit.
3. **TTS** — Sends each chunk to Groq's TTS API and streams results back via a long-lived port.
4. **STT alignment** — Sends the audio back through Groq's STT API to get per-word timestamps.
5. **Highlighting** — Uses the CSS Custom Highlight API to highlight each word in real-time as the audio plays, synchronized via `requestAnimationFrame`.

## License

[MIT](LICENSE)
