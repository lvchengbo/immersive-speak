/* Immersive Speak — shared constants (loaded by background, content, and options) */

const GROQ_DEFAULTS = {
  api_key: "",
  tts_model: "canopylabs/orpheus-v1-english",
  tts_voice: "troy",
  tts_format: "wav",
  stt_model: "whisper-large-v3-turbo",
  stt_language: "",
  max_chars: 200,
  auto_speak: true,
  agent_mode: true,
  agent_model: "moonshotai/kimi-k2-instruct-0905",
  speech_mode: false
};

const GROQ_MESSAGES = {
  START: "groq-tts-start",
  RESUME_PICKER: "groq-tts-resume-picker",
  INJECT: "groq-tts-inject",
  PORT: "groq-tts",
  AGENT_START: "groq-tts-agent-start",
  AGENT_SELECT: "groq-tts-agent-select",
  SPEECH_TTS: "groq-tts-speech-tts"
};

const GROQ_TARGET_ATTR = "data-groq-tts-target";
