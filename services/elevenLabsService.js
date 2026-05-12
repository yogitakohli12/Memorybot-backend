const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const MOCK = String(process.env.USE_MOCK_AI || "").toLowerCase() === "true";

const getKey = () => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !key.trim() || key.includes("your_elevenlabs_api_key")) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing or still set to the placeholder. Edit backend/.env."
    );
  }
  return key;
};

const getHeaders = () => ({ "xi-api-key": getKey() });

const extractAxiosError = (err, prefix) => {
  let body = err.response?.data;
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      body = body.toString();
    }
  }
  const apiMsg =
    body?.detail?.message ||
    (typeof body?.detail === "string" ? body.detail : null) ||
    body?.message ||
    err.message;

  const status = err.response?.status;
  let hint = "";
  let kind = "unknown";

  const lowerMsg = String(apiMsg || "").toLowerCase();
  if (status === 401) {
    kind = "auth";
    hint = " (invalid ElevenLabs API key)";
  } else if (
    /subscription does not include instant voice cloning/i.test(apiMsg) ||
    /can_not_use_instant_voice_cloning/i.test(apiMsg) ||
    /upgrade your plan/i.test(apiMsg) ||
    /voice_limit_reached/i.test(apiMsg)
  ) {
    kind = "paid_feature";
    hint =
      " — instant voice cloning is a paid ElevenLabs feature ($5/mo Starter+). For now you can pick a free preset voice instead.";
  } else if (status === 422) {
    kind = "bad_request";
    hint = " (invalid request — check audio format)";
  } else if (status === 429) {
    kind = "rate_limit";
    hint = " (rate limit / quota — check your plan)";
  } else if (
    err.code === "ENOTFOUND" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ETIMEDOUT" ||
    /network/i.test(err.message)
  ) {
    kind = "network";
    hint = " (cannot reach api.elevenlabs.io — check internet/firewall)";
  }
  const e = new Error(`${prefix}: ${apiMsg}${hint}`);
  e.kind = kind;
  e.status = status || null;
  return e;
};

/**
 * Create a cloned voice from audio sample(s)
 */
const createVoice = async (name, files = [], description = "") => {
  if (MOCK) return `mock-voice-${Date.now()}`;
  try {
    const form = new FormData();
    form.append("name", name);
    if (description) form.append("description", description);

    for (const filePath of files) {
      form.append("files", fs.createReadStream(filePath), {
        filename: path.basename(filePath),
      });
    }

    const response = await axios.post(`${ELEVENLABS_BASE}/voices/add`, form, {
      headers: { ...getHeaders(), ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });

    return response.data.voice_id;
  } catch (err) {
    const e = extractAxiosError(err, "ElevenLabs createVoice");
    console.error(e.message);
    throw e;
  }
};

/**
 * Convert text to speech and save audio file
 */
const textToSpeech = async (voiceId, text, outDir) => {
  if (MOCK) return null;
  try {
    if (!voiceId) throw new Error("voiceId is required");

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
      {
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.4,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          ...getHeaders(),
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 60_000,
      }
    );

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filename = `tts-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp3`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, response.data);

    return filename;
  } catch (err) {
    const e = extractAxiosError(err, "ElevenLabs TTS");
    console.error(e.message);
    throw e;
  }
};

/**
 * List available voices
 */
const listVoices = async () => {
  if (MOCK) return [];
  try {
    const response = await axios.get(`${ELEVENLABS_BASE}/voices`, {
      headers: getHeaders(),
      timeout: 30_000,
    });
    return response.data.voices || [];
  } catch (err) {
    const e = extractAxiosError(err, "ElevenLabs listVoices");
    console.error(e.message);
    throw e;
  }
};

/**
 * Curated free preset voices that ship with every ElevenLabs account.
 * These voice IDs are publicly known and work on the FREE plan for TTS.
 */
const PRESET_VOICES = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", gender: "female", accent: "American", description: "Calm, conversational" },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", gender: "female", accent: "American", description: "Strong, confident" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", gender: "female", accent: "American", description: "Soft, friendly" },
  { voice_id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", gender: "female", accent: "American", description: "Young, emotional" },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", gender: "male", accent: "American", description: "Deep, smooth" },
  { voice_id: "VR6AewLTigWG4xSOukaG", name: "Arnold", gender: "male", accent: "American", description: "Crisp, mature" },
  { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", gender: "male", accent: "American", description: "Narration, deep" },
  { voice_id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", gender: "male", accent: "American", description: "Raspy, casual" },
  { voice_id: "ThT5KcBeYPX3keUQqHPh", name: "Dorothy", gender: "female", accent: "British", description: "Pleasant, warm" },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni", gender: "male", accent: "American", description: "Well-rounded" },
];

const getPresetVoices = () => PRESET_VOICES;

const ping = async () => {
  if (MOCK) return { ok: true, mock: true };
  try {
    await axios.get(`${ELEVENLABS_BASE}/user`, {
      headers: getHeaders(),
      timeout: 15_000,
    });
    return { ok: true };
  } catch (err) {
    const e = extractAxiosError(err, "ElevenLabs");
    return { ok: false, error: e.message, kind: e.kind };
  }
};

module.exports = {
  createVoice,
  textToSpeech,
  listVoices,
  ping,
  getPresetVoices,
  PRESET_VOICES,
};
