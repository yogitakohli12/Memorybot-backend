/**
 * Backwards-compatible facade. The real chat/STT logic lives in aiProvider.js
 * which supports OpenAI + Groq with automatic failover. This file also adds
 * an OpenAI TTS implementation that we use as a fallback when ElevenLabs fails
 * or its free quota is exhausted.
 */

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const aiProvider = require("./aiProvider");
const { fetch: customFetch } = require("../utils/httpAgent");

const MOCK = String(process.env.USE_MOCK_AI || "").toLowerCase() === "true";

const QUOTA_LIMITS = {
  free: {
    label: "OpenAI free tier",
    rpm: 3,
    rpd: 200,
    tpm: 40_000,
    note:
      "Free trial credits ($5) expire 3 months after signup. Hard daily cap ~200 requests/day.",
  },
  tier1: {
    label: "OpenAI tier 1 (paid)",
    rpm: 500,
    rpd: 10_000,
    tpm: 200_000,
    note: "Resets monthly; usage caps grow as you spend more.",
  },
  groq: {
    label: "Groq free tier",
    rpm: 30,
    rpd: 1000,
    tpm: 5000,
    note: "Free, no credit card. Works in India without VPN.",
  },
};

/**
 * OpenAI TTS voices — these are built-in and work with the tts-1 model.
 * Cost: ~$0.015 per 1K characters. The $5 trial credits cover ~330,000 chars
 * (roughly 5,000 chat replies of average length), so this is effectively free
 * for development/demo use.
 */
const OPENAI_TTS_VOICES = [
  { voice_id: "alloy", name: "Alloy", gender: "neutral", description: "Warm, friendly" },
  { voice_id: "echo", name: "Echo", gender: "male", description: "Clear, narrative" },
  { voice_id: "fable", name: "Fable", gender: "neutral", description: "Expressive, storyteller" },
  { voice_id: "onyx", name: "Onyx", gender: "male", description: "Deep, authoritative" },
  { voice_id: "nova", name: "Nova", gender: "female", description: "Bright, energetic" },
  { voice_id: "shimmer", name: "Shimmer", gender: "female", description: "Soft, soothing" },
];

let ttsClient = null;
const getTtsClient = () => {
  if (ttsClient) return ttsClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key || !key.trim() || key.includes("your_") || key.includes("_here")) {
    throw new Error(
      "OPENAI_API_KEY is missing — required for OpenAI TTS fallback. Set it in backend/.env."
    );
  }
  ttsClient = new OpenAI({
    apiKey: key,
    timeout: 60_000,
    maxRetries: 1,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    fetch: customFetch,
  });
  return ttsClient;
};

const generateChatResponse = async (person, userMessage, history = []) => {
  if (MOCK) {
    return {
      text: `(${person.name} · mock) I hear you said: "${userMessage}". I'm here.`,
      providerUsed: "mock",
    };
  }

  try {
    const result = await aiProvider.generateChatResponse(
      person,
      userMessage,
      history
    );
    return result;
  } catch (err) {
    const e = new Error(err.message);
    e.kind = err.kind || "unknown";
    e.attempts = err.attempts || [];
    throw e;
  }
};

const transcribeAudio = async (filePath) => {
  if (MOCK) return "(mock transcription) hello, this is a test message.";
  try {
    const { text } = await aiProvider.transcribeAudio(filePath);
    return text;
  } catch (err) {
    const e = new Error(err.message);
    e.kind = err.kind || "unknown";
    e.attempts = err.attempts || [];
    throw e;
  }
};

/**
 * Convert text → speech using OpenAI's tts-1 model.
 * @param {string} voiceId - One of: alloy, echo, fable, onyx, nova, shimmer
 * @param {string} text
 * @param {string} outDir
 * @returns {string} filename of the saved mp3
 */
const textToSpeech = async (voiceId, text, outDir) => {
  if (MOCK) return null;

  const validVoice = OPENAI_TTS_VOICES.find((v) => v.voice_id === voiceId)
    ? voiceId
    : "alloy";

  try {
    const client = getTtsClient();
    const response = await client.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "tts-1",
      voice: validVoice,
      input: text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filename = `tts-openai-${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}.mp3`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filename;
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const code = err?.code || err?.error?.code;
    const apiMsg =
      err?.error?.message || err?.message || String(err);

    let kind = "unknown";
    if (status === 401) kind = "auth";
    else if (
      code === "insufficient_quota" ||
      /insufficient_quota|exceeded your current quota/i.test(apiMsg)
    )
      kind = "quota";
    else if (status === 429) kind = "rate_limit";
    else if (
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      /connection error|fetch failed/i.test(apiMsg)
    )
      kind = "network";

    const e = new Error(`OpenAI TTS: ${apiMsg}`);
    e.kind = kind;
    e.status = status || null;
    throw e;
  }
};

const ping = async () => {
  if (MOCK) return { ok: true, mock: true };
  const providers = await aiProvider.ping();
  const anyOk = Object.values(providers).some((p) => p.ok);
  return {
    ok: anyOk,
    providers,
    activeOrder: aiProvider.PROVIDER_ORDER,
  };
};

module.exports = {
  generateChatResponse,
  transcribeAudio,
  textToSpeech,
  ping,
  QUOTA_LIMITS,
  OPENAI_TTS_VOICES,
};
