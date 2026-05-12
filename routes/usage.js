const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { getUsageSummary } = require("../utils/quota");
const { QUOTA_LIMITS } = require("../services/openaiService");
const { PROVIDERS, PROVIDER_ORDER } = require("../services/aiProvider");

router.use(auth);

router.get("/", async (req, res, next) => {
  try {
    const summary = await getUsageSummary(req.user._id);

    const planName = (process.env.PROVIDER_PLAN || "free").toLowerCase();
    const plan = QUOTA_LIMITS[planName] || QUOTA_LIMITS.free;

    // Which providers are actually configured + in the failover order
    const configured = PROVIDER_ORDER.filter((p) => {
      const env = PROVIDERS[p]?.keyEnv;
      const k = env ? process.env[env] : null;
      return k && k.trim() && !k.includes("your_") && !k.includes("_here");
    });

    res.json({
      success: true,
      ...summary,
      plan: {
        current: plan,
      },
      providers: {
        order: PROVIDER_ORDER,
        configured,
        details: Object.fromEntries(
          Object.entries(PROVIDERS).map(([k, v]) => [
            k,
            {
              name: v.name,
              chatModel: v.chatModel,
              sttModel: v.sttModel,
              rpm: v.rpm,
              rpd: v.rpd,
              freeNote: v.freeNote,
              signupUrl: v.signupUrl,
              configured: configured.includes(k),
            },
          ])
        ),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
