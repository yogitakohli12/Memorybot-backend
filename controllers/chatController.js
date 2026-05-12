const fs = require("fs");
const path = require("path");
const Chat = require("../models/Chat");
const Person = require("../models/Person");
const {
  generateChatResponse,
  transcribeAudio,
} = require("../services/openaiService");
const ttsProvider = require("../services/ttsProvider");
const {
  getUsageSummary,
  isOverQuota,
  recordUsage,
  DEFAULT_DAILY_LIMIT,
} = require("../utils/quota");

const AUDIO_DIR = path.join(__dirname, "..", "uploads", "audio");

/**
 * Send a message (text OR audio).
 *
 * Flow:
 *  1. Enforce per-user daily soft quota (DAILY_MESSAGE_LIMIT in .env)
 *  2. Transcribe audio if uploaded (Whisper)
 *  3. Save the user message no matter what
 *  4. Try AI response — on failure return a friendly fallback bubble
 *  5. Try TTS — non-fatal
 *  6. Persist + return both messages plus updated usage summary
 */
exports.sendMessage = async (req, res, next) => {
  let uploadedFilePath = null;
  try {
    const { personId } = req.body;
    let { text } = req.body;

    if (!personId) {
      return res.status(400).json({ message: "personId is required" });
    }

    // 1. Daily quota check
    const overQuota = await isOverQuota(req.user._id);
    if (overQuota) {
      const usage = await getUsageSummary(req.user._id);
      return res.status(429).json({
        kind: "app_quota",
        message: `Daily message limit reached (${usage.used}/${usage.limit}). Resets at ${new Date(usage.resetsAt).toLocaleString()}.`,
        usage,
      });
    }

    const person = await Person.findOne({
      _id: personId,
      userId: req.user._id,
    });
    if (!person) return res.status(404).json({ message: "Person not found" });

    // 2. Whisper transcription
    if (req.file) {
      uploadedFilePath = req.file.path;
      try {
        text = await transcribeAudio(uploadedFilePath);
      } catch (err) {
        const usage = await getUsageSummary(req.user._id);
        return res.status(502).json({
          message: `Voice transcription failed. ${err.message}`,
          kind: err.kind || "whisper",
          stage: "whisper",
          rateLimit: err.rateLimit || null,
          usage,
        });
      }
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Message text is required" });
    }

    // 3. Get or create chat doc
    let chat = await Chat.findOne({
      userId: req.user._id,
      personId: person._id,
    });
    if (!chat) {
      chat = await Chat.create({
        userId: req.user._id,
        personId: person._id,
        messages: [],
      });
    }

    const userMsg = {
      role: "user",
      text,
      audioUrl: "",
      createdAt: new Date(),
    };

    // 4. AI response (graceful fallback on failure)
    let aiText;
    let aiError = null;
    let aiKind = null;
    let usageInfo = null;
    try {
      const result = await generateChatResponse(person, text, chat.messages);
      aiText = result.text;
      usageInfo = result.usage;
    } catch (err) {
      aiError = err.message;
      aiKind = err.kind || "unknown";
      // Tailor the in-bubble fallback to the failure type
      aiText =
        aiKind === "quota"
          ? `⚠️ Out of OpenAI credits. Add billing at platform.openai.com to continue.`
          : aiKind === "rate_limit"
          ? `⚠️ Hit OpenAI's rate limit. Wait ~20 seconds and try again.`
          : aiKind === "network"
          ? `⚠️ Can't reach OpenAI from this network. Check internet, try a VPN, or set HTTPS_PROXY in backend/.env.`
          : aiKind === "auth"
          ? `⚠️ OpenAI API key is invalid. Check backend/.env.`
          : `⚠️ I couldn't reach the AI right now.\n\n${err.message}`;
    }

    // 5. TTS (non-fatal). Three paths:
    //    - browser provider: skip server TTS, frontend speaks via Web Speech
    //    - elevenlabs/openai: try ttsProvider chain
    //    - none configured: server TTS off, frontend can still use browser TTS
    let audioUrl = "";
    let ttsError = null;
    let ttsProviderUsed = null;
    const useBrowserTts = person.voiceProvider === "browser";

    if (!aiError && !useBrowserTts && (person.voiceId || person.voiceProvider)) {
      try {
        const { filename, providerUsed } = await ttsProvider.synthesize(
          person,
          aiText,
          AUDIO_DIR
        );
        if (filename) {
          audioUrl = `/uploads/audio/${filename}`;
          ttsProviderUsed = providerUsed;
        }
      } catch (e) {
        ttsError = e.message;
        console.error("TTS failed but continuing:", e.message);
      }
    }
    if (useBrowserTts) ttsProviderUsed = "browser";

    const aiMsg = {
      role: "ai",
      text: aiText,
      audioUrl,
      createdAt: new Date(),
    };

    // 6. Persist + record usage
    chat.messages.push(userMsg);
    chat.messages.push(aiMsg);
    await chat.save();

    // Only count successful AI messages toward the daily quota
    if (!aiError) {
      await recordUsage(req.user._id, {
        promptTokens: usageInfo?.prompt_tokens || 0,
        completionTokens: usageInfo?.completion_tokens || 0,
      });
    }

    if (uploadedFilePath) {
      try {
        fs.unlinkSync(uploadedFilePath);
      } catch (_) {}
    }

    const usage = await getUsageSummary(req.user._id);

    // Tell the frontend whether to play audio inline or speak via Web Speech
    const speakInBrowser =
      useBrowserTts ||
      (!audioUrl && !aiError); // any time we have no audio for an AI reply

    res.status(aiError ? 207 : 200).json({
      success: !aiError,
      userMessage: userMsg,
      aiMessage: aiMsg,
      aiError,
      aiKind,
      ttsError,
      ttsProviderUsed,
      speakInBrowser,
      browserVoiceId: useBrowserTts ? person.voiceId || "" : null,
      usage,
    });
  } catch (err) {
    if (uploadedFilePath) {
      try {
        fs.unlinkSync(uploadedFilePath);
      } catch (_) {}
    }
    next(err);
  }
};

exports.getChat = async (req, res, next) => {
  try {
    const { personId } = req.params;
    const chat = await Chat.findOne({
      userId: req.user._id,
      personId,
    });

    res.json({
      success: true,
      messages: chat ? chat.messages : [],
    });
  } catch (err) {
    next(err);
  }
};

exports.clearChat = async (req, res, next) => {
  try {
    const { personId } = req.params;
    await Chat.findOneAndUpdate(
      { userId: req.user._id, personId },
      { messages: [] }
    );
    res.json({ success: true, message: "Chat cleared" });
  } catch (err) {
    next(err);
  }
};
