const express = require("express");
const router = express.Router();
const { ping: pingOpenAI } = require("../services/openaiService");
const { ping: pingEleven } = require("../services/elevenLabsService");
const { probeAll } = require("../utils/netProbe");
const { PROVIDER_ORDER } = require("../services/aiProvider");

router.get("/", async (req, res) => {
  const [openai, eleven, network] = await Promise.all([
    pingOpenAI().catch((e) => ({ ok: false, error: e.message })),
    pingEleven().catch((e) => ({ ok: false, error: e.message })),
    probeAll().catch((e) => ({ error: e.message })),
  ]);

  const ok = openai.ok && eleven.ok;
  const advice = [];

  if (!openai.ok) {
    if (openai.providers?.openai && !openai.providers.openai.ok) {
      advice.push(
        `OpenAI failed: ${openai.providers.openai.error || "unknown"}`
      );
    }
    if (openai.providers?.groq?.ok) {
      advice.push("✓ Groq is working — chat will use Groq automatically.");
    } else if (!openai.providers?.groq?.configured) {
      advice.push(
        "Recommended: get a free Groq key at https://console.groq.com/keys (no card required, works in India) and set GROQ_API_KEY in backend/.env."
      );
    }
  }

  if (network && Array.isArray(network)) {
    network.forEach((n) => {
      if (n.tcp && !n.tcp.ok) {
        advice.push(
          `Network can't TCP-connect to ${n.host}:${n.port} (${n.tcp.error}). Your ISP/firewall is likely blocking it.`
        );
      }
    });
  }

  res.json({
    status: ok ? "ok" : "degraded",
    providerOrder: PROVIDER_ORDER,
    services: {
      openai_chain: openai,
      elevenlabs: eleven,
    },
    network,
    advice,
    env: {
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasGroqKey: !!process.env.GROQ_API_KEY,
      hasElevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
      hasMongoUri: !!process.env.MONGO_URI,
      mockMode:
        String(process.env.USE_MOCK_AI || "").toLowerCase() === "true",
      proxy:
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        null,
    },
  });
});

module.exports = router;
