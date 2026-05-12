/**
 * Multi-provider AI layer with automatic failover.
 *
 * Why this exists: many Indian / college / corporate ISPs block direct egress
 * to api.openai.com. Groq is OpenAI-API-compatible, has a free tier with no
 * credit card, hosts Whisper for transcription, and api.groq.com is reachable
 * from networks that block OpenAI.
 *
 * Provider order:
 *   - AI_PROVIDER=openai      → OpenAI only
 *   - AI_PROVIDER=groq        → Groq only
 *   - AI_PROVIDER=auto (default) → try OpenAI first, fall back to Groq
 *                                  on network/auth errors. Failed provider
 *                                  is "skipped" for 5 min to avoid retries.
 */

const OpenAI = require("openai");
const fs = require("fs");
const { fetch: customFetch } = require("../utils/httpAgent");

const PROVIDER_ORDER = (() => {
  const v = (process.env.AI_PROVIDER || "auto").toLowerCase();
  if (v === "openai") return ["openai"];
  if (v === "groq") return ["groq"];
  return ["openai", "groq"]; // auto
})();

// Short cooldown so a transient network blip doesn't lock the user out for 5 min.
// 20s is enough to avoid hammering a truly-down provider during a single chat
// turn, but short enough that the next user retry actually retries.
const SKIP_TTL_MS = 20 * 1000;
const skippedUntil = {}; // { openai: timestamp, groq: timestamp }

const PROVIDERS = {
  openai: {
    name: "OpenAI",
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    keyPrefixHint: "sk-",
    chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    sttModel: process.env.OPENAI_WHISPER_MODEL || "whisper-1",
    signupUrl: "https://platform.openai.com/api-keys",
    freeNote:
      "Free trial credits ($5) expire 3 months after signup. Hard cap ~200 req/day.",
    rpm: 3,
    rpd: 200,
  },
  groq: {
    name: "Groq",
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    keyPrefixHint: "gsk_",
    chatModel: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
    sttModel: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3",
    signupUrl: "https://console.groq.com/keys",
    freeNote:
      "Free tier: 30 req/min, 1000 req/day for chat. 20 req/min, 2000 req/day for Whisper. No credit card required.",
    rpm: 30,
    rpd: 1000,
  },
};

const clients = {}; // cached OpenAI SDK instances per provider

const getClient = (providerKey) => {
  if (clients[providerKey]) return clients[providerKey];

  const cfg = PROVIDERS[providerKey];
  const key = process.env[cfg.keyEnv];
  if (!key || !key.trim() || key.includes("your_") || key.includes("_here")) {
    throw new Error(
      `${cfg.name} key (${cfg.keyEnv}) not set. Get one at ${cfg.signupUrl} and put it in backend/.env.`
    );
  }

  clients[providerKey] = new OpenAI({
    apiKey: key,
    baseURL: cfg.baseURL,
    timeout: 60_000,
    maxRetries: 1,
    fetch: customFetch,
  });
  return clients[providerKey];
};

const isProviderConfigured = (providerKey) => {
  const cfg = PROVIDERS[providerKey];
  const key = process.env[cfg.keyEnv];
  return !!(key && key.trim() && !key.includes("your_") && !key.includes("_here"));
};

const isSkipped = (providerKey) => {
  const until = skippedUntil[providerKey];
  if (!until) return false;
  if (Date.now() > until) {
    delete skippedUntil[providerKey];
    return false;
  }
  return true;
};

const markSkip = (providerKey) => {
  skippedUntil[providerKey] = Date.now() + SKIP_TTL_MS;
};

const classifyError = (err) => {
  const status = err?.status || err?.response?.status;
  const code = err?.code || err?.error?.code;
  const type = err?.error?.type || err?.type;
  const msg =
    err?.error?.message || err?.message || String(err);

  if (status === 401) return "auth";
  if (
    code === "insufficient_quota" ||
    type === "insufficient_quota" ||
    /insufficient_quota|exceeded your current quota/i.test(msg)
  )
    return "quota";
  if (code === "billing_hard_limit_reached") return "billing";
  if (status === 429) return "rate_limit";
  if (status === 404) return "model";
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    /connection error|fetch failed|network/i.test(msg)
  )
    return "network";
  return "unknown";
};

/** Decide whether to try the next provider after a failure. */
const isFailoverableKind = (kind) =>
  ["network", "auth", "quota", "billing"].includes(kind);

const friendlyMessage = (kind, providerKey, rawMsg) => {
  const cfg = PROVIDERS[providerKey];
  const tips = {
    auth: `${cfg.name} API key invalid. Get a fresh one at ${cfg.signupUrl}.`,
    quota: `${cfg.name} credits/quota exhausted. ${cfg.freeNote}`,
    billing: `${cfg.name} billing limit reached.`,
    rate_limit: `${cfg.name} rate limit hit (free tier ~${cfg.rpm} req/min). Wait and retry.`,
    model: `${cfg.name} model not available for this account.`,
    network: `Cannot reach ${cfg.baseURL}. Likely ISP/firewall blocking.`,
    unknown: rawMsg,
  };
  return tips[kind] || rawMsg;
};

/**
 * Run an action against the configured provider chain, failing over on
 * network/auth/quota errors. Returns { result, providerUsed, attempts }.
 * If everything fails, throws an Error with .kind and .attempts.
 */
const runWithFailover = async (action) => {
  const attempts = [];
  let lastErr = null;

  for (const providerKey of PROVIDER_ORDER) {
    if (!isProviderConfigured(providerKey)) {
      attempts.push({
        provider: providerKey,
        skipped: true,
        reason: "not configured",
      });
      continue;
    }
    if (isSkipped(providerKey)) {
      attempts.push({
        provider: providerKey,
        skipped: true,
        reason: "recently failed",
      });
      continue;
    }

    try {
      const result = await action(getClient(providerKey), PROVIDERS[providerKey]);
      return { result, providerUsed: providerKey, attempts };
    } catch (err) {
      const kind = classifyError(err);
      const rawMsg = err?.error?.message || err?.message || String(err);
      const message = friendlyMessage(kind, providerKey, rawMsg);
      attempts.push({ provider: providerKey, kind, message });
      lastErr = { kind, message, providerKey };
      if (isFailoverableKind(kind)) {
        markSkip(providerKey);
        continue; // try next provider
      }
      // Non-failoverable (rate_limit, model, unknown): don't try other providers
      break;
    }
  }

  const skippedNoKey = attempts.filter(
    (a) => a.skipped && a.reason === "not configured"
  );
  const skippedCooldown = attempts.filter(
    (a) => a.skipped && a.reason === "recently failed"
  );
  const triedAndFailed = attempts.filter((a) => !a.skipped);
  const allUnconfigured =
    attempts.length > 0 && skippedNoKey.length === attempts.length;
  const allInCooldown =
    attempts.length > 0 && skippedCooldown.length === attempts.length;

  const formatAttempt = (a) =>
    a.skipped
      ? `${a.provider}[${a.reason}]`
      : `${a.provider}:${a.kind}`;

  let summary;
  if (allUnconfigured) {
    summary =
      "No AI provider is configured. Open backend/.env (NOT .env.example) and set GROQ_API_KEY (free, no card, works in India): https://console.groq.com/keys — then restart the server.";
  } else if (allInCooldown) {
    summary =
      "All AI providers are in a short cooldown after recent network failures. Wait ~20 seconds and try again. If it still fails, the underlying issue is your network, not the keys — see the tip below.";
  } else if (lastErr?.kind === "network" && skippedNoKey.length > 0) {
    const missing = skippedNoKey.map((a) => a.provider).join(" + ");
    summary = `${lastErr.message} — and the failover provider (${missing}) has no API key set in backend/.env. Get a free Groq key at https://console.groq.com/keys`;
  } else if (triedAndFailed.length > 0 && lastErr?.kind === "network") {
    summary = `${lastErr.message} (tried: ${attempts.map(formatAttempt).join(" → ")}) — TLS handshake is being broken by your antivirus or firewall. Set INSECURE_TLS=true in backend/.env and restart to bypass it.`;
  } else {
    summary = `${lastErr?.message || "All providers failed"} (tried: ${attempts
      .map(formatAttempt)
      .join(" → ")})`;
  }

  const e = new Error(summary);
  e.kind = lastErr?.kind || (allInCooldown ? "cooldown" : "unknown");
  e.attempts = attempts;
  throw e;
};

/** Manually clear all provider cooldowns. Used when user explicitly retries. */
const resetCooldowns = () => {
  for (const k of Object.keys(skippedUntil)) delete skippedUntil[k];
};

const buildSystemPrompt = (person) => {
  const traits = (person.traits || []).join(", ") || "neutral";
  const samples = (person.sampleTexts || []).filter(Boolean);
  const examples =
    samples.length > 0
      ? `\nHere are some example sentences in their style:\n${samples
          .map((s, i) => `${i + 1}. "${s}"`)
          .join("\n")}`
      : "";
  const description = person.description ? `\nAbout them: ${person.description}` : "";

  return `You are speaking like ${person.name}.
Personality traits: ${traits}.${description}
Respond in a natural human tone like this person would speak.
Match their personality, mannerisms, and emotional style.
Keep responses conversational and authentic.${examples}`;
};

const generateChatResponse = async (person, userMessage, history = []) => {
  const systemPrompt = buildSystemPrompt(person);
  const baseMessages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10).map((m) => ({
      role: m.role === "ai" ? "assistant" : "user",
      content: m.text,
    })),
    { role: "user", content: userMessage },
  ];

  const { result, providerUsed, attempts } = await runWithFailover(
    async (client, cfg) => {
      const completion = await client.chat.completions.create({
        model: cfg.chatModel,
        messages: baseMessages,
        temperature: 0.85,
        max_tokens: 500,
      });
      return {
        text: completion.choices[0]?.message?.content?.trim() || "",
        usage: completion.usage || null,
      };
    }
  );

  return { ...result, providerUsed, attempts };
};

const transcribeAudio = async (filePath) => {
  const { result, providerUsed, attempts } = await runWithFailover(
    async (client, cfg) => {
      const transcription = await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: cfg.sttModel,
      });
      return transcription.text;
    }
  );

  return { text: result, providerUsed, attempts };
};

const ping = async () => {
  const results = {};
  for (const providerKey of Object.keys(PROVIDERS)) {
    if (!isProviderConfigured(providerKey)) {
      results[providerKey] = { ok: false, configured: false, reason: "no key" };
      continue;
    }
    try {
      await getClient(providerKey).models.list();
      results[providerKey] = {
        ok: true,
        configured: true,
        baseURL: PROVIDERS[providerKey].baseURL,
      };
    } catch (err) {
      const kind = classifyError(err);
      results[providerKey] = {
        ok: false,
        configured: true,
        kind,
        error: friendlyMessage(
          kind,
          providerKey,
          err?.message || String(err)
        ),
      };
    }
  }
  return results;
};

module.exports = {
  generateChatResponse,
  transcribeAudio,
  ping,
  resetCooldowns,
  PROVIDERS,
  PROVIDER_ORDER,
};
