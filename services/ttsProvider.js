/**
 * Multi-provider Text-to-Speech with automatic failover.
 *
 * Voice mapping uses Person.voiceProvider + Person.voiceId:
 *   - voiceProvider="elevenlabs" + voiceId=<elevenlabs voice id>  → ElevenLabs
 *   - voiceProvider="openai"     + voiceId=<alloy|echo|...>        → OpenAI tts-1
 *
 * If voiceProvider is missing (legacy data), we try ElevenLabs first, then
 * fall back to OpenAI with a default voice. If a provider fails (paid feature
 * blocked, network, quota), we automatically retry with the other one so the
 * user always gets audio when at least one provider is available.
 */

const elevenLabs = require("./elevenLabsService");
const openai = require("./openaiService");

const ELEVENLABS_PRESET_IDS = new Set(
  (elevenLabs.PRESET_VOICES || []).map((v) => v.voice_id)
);

const OPENAI_VOICE_IDS = new Set(
  (openai.OPENAI_TTS_VOICES || []).map((v) => v.voice_id)
);

const DEFAULT_OPENAI_VOICE = "alloy";
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel

const isElevenLabsConfigured = () => {
  const k = process.env.ELEVENLABS_API_KEY;
  return !!(k && k.trim() && !k.includes("your_") && !k.includes("_here"));
};

const isOpenAIConfigured = () => {
  const k = process.env.OPENAI_API_KEY;
  return !!(k && k.trim() && !k.includes("your_") && !k.includes("_here"));
};

/**
 * Pick the best provider for a given person, considering what's actually
 * configured in .env and what voiceProvider the person was created with.
 */
const resolveProviderChain = (person) => {
  const chain = [];
  const declared = (person?.voiceProvider || "").toLowerCase();

  // Try the user's declared preference first
  if (declared === "elevenlabs" && isElevenLabsConfigured()) {
    chain.push("elevenlabs");
    if (isOpenAIConfigured()) chain.push("openai");
  } else if (declared === "openai" && isOpenAIConfigured()) {
    chain.push("openai");
    if (isElevenLabsConfigured()) chain.push("elevenlabs");
  } else {
    // No declared preference — guess from voiceId shape
    if (
      person?.voiceId &&
      OPENAI_VOICE_IDS.has(person.voiceId) &&
      isOpenAIConfigured()
    ) {
      chain.push("openai");
      if (isElevenLabsConfigured()) chain.push("elevenlabs");
    } else if (isElevenLabsConfigured()) {
      chain.push("elevenlabs");
      if (isOpenAIConfigured()) chain.push("openai");
    } else if (isOpenAIConfigured()) {
      chain.push("openai");
    }
  }
  return chain;
};

const voiceIdFor = (provider, person) => {
  if (provider === "openai") {
    return OPENAI_VOICE_IDS.has(person?.voiceId)
      ? person.voiceId
      : DEFAULT_OPENAI_VOICE;
  }
  // elevenlabs
  return person?.voiceId || DEFAULT_ELEVENLABS_VOICE;
};

/**
 * Generate audio for a chat reply.
 * Returns { filename, providerUsed, attempts } or throws if everything fails.
 */
const synthesize = async (person, text, outDir) => {
  const chain = resolveProviderChain(person);
  if (chain.length === 0) {
    const e = new Error(
      "No TTS provider configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY in backend/.env."
    );
    e.kind = "no_provider";
    throw e;
  }

  const attempts = [];
  let lastErr = null;

  for (const provider of chain) {
    try {
      const voiceId = voiceIdFor(provider, person);
      const filename =
        provider === "openai"
          ? await openai.textToSpeech(voiceId, text, outDir)
          : await elevenLabs.textToSpeech(voiceId, text, outDir);

      if (!filename) {
        attempts.push({ provider, kind: "no_output" });
        continue;
      }
      return { filename, providerUsed: provider, attempts };
    } catch (err) {
      const kind = err.kind || "unknown";
      attempts.push({ provider, kind, message: err.message });
      lastErr = err;
      // Always try the next provider — every error is recoverable by switching
      continue;
    }
  }

  const summary = `All TTS providers failed. ${
    lastErr?.message || ""
  } (tried: ${attempts.map((a) => `${a.provider}:${a.kind}`).join(" → ")})`;
  const e = new Error(summary);
  e.kind = lastErr?.kind || "unknown";
  e.attempts = attempts;
  throw e;
};

/** All voices the user can pick from when creating/editing a person */
const listAvailableVoices = () => {
  const out = { providers: {} };

  // Browser voices are always available — runs in the user's browser, free,
  // no API call, no quota. The actual list is enumerated client-side via
  // window.speechSynthesis.getVoices(); we just advertise that the option
  // exists.
  out.providers.browser = {
    name: "Browser (free, recommended)",
    configured: true,
    free: true,
    cloningPaid: false,
    note: "Uses your browser's built-in voices. Zero API calls, zero quota, works offline. Voices vary by OS.",
    clientSide: true, // tells the UI to enumerate voices via Web Speech API
    voices: [], // populated on the frontend
  };

  if (isElevenLabsConfigured()) {
    out.providers.elevenlabs = {
      name: "ElevenLabs",
      configured: true,
      free: false,
      cloningPaid: true,
      note: "Note: free accounts can no longer use library voices via API. Paid plan ($5+/mo) required for both presets and cloning.",
      voices: elevenLabs.PRESET_VOICES.map((v) => ({
        provider: "elevenlabs",
        ...v,
      })),
    };
  }

  if (isOpenAIConfigured()) {
    out.providers.openai = {
      name: "OpenAI",
      configured: true,
      free: false,
      cloningPaid: false,
      note: "Cost ~$0.015 per 1K characters. Requires available billing credits.",
      voices: openai.OPENAI_TTS_VOICES.map((v) => ({
        provider: "openai",
        ...v,
      })),
    };
  }

  return out;
};

/**
 * Try to clone a voice via ElevenLabs. If the account doesn't have permission,
 * gracefully return a fallback object pointing at a preset voice.
 */
const cloneOrFallback = async (name, files, description, fallbackPresetId) => {
  if (!isElevenLabsConfigured()) {
    return {
      cloned: false,
      reason: "elevenlabs_not_configured",
      voiceProvider: isOpenAIConfigured() ? "openai" : "elevenlabs",
      voiceId: isOpenAIConfigured()
        ? DEFAULT_OPENAI_VOICE
        : fallbackPresetId || DEFAULT_ELEVENLABS_VOICE,
    };
  }

  try {
    const voiceId = await elevenLabs.createVoice(name, files, description);
    return { cloned: true, voiceProvider: "elevenlabs", voiceId };
  } catch (err) {
    if (err.kind === "paid_feature") {
      return {
        cloned: false,
        reason: "paid_feature",
        message: err.message,
        voiceProvider: "elevenlabs",
        voiceId: fallbackPresetId || DEFAULT_ELEVENLABS_VOICE,
      };
    }
    throw err;
  }
};

module.exports = {
  synthesize,
  listAvailableVoices,
  cloneOrFallback,
  resolveProviderChain,
  isElevenLabsConfigured,
  isOpenAIConfigured,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_ELEVENLABS_VOICE,
};
