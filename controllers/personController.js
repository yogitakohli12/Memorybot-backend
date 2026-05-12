const fs = require("fs");
const Person = require("../models/Person");
const ttsProvider = require("../services/ttsProvider");

/**
 * Default voice picker — used when the user creates a person without
 * choosing a voice. Picks whichever provider is actually configured so
 * AI replies always come back with audio.
 */
const pickDefaultVoice = () => {
  // Default to browser TTS — completely free, no quota, no auth issues.
  // Server-side providers (ElevenLabs free, OpenAI quota) are unreliable.
  return {
    voiceId: "",
    voiceProvider: "browser",
    voiceLabel: "Browser voice (free, runs locally)",
  };
};

exports.createPerson = async (req, res, next) => {
  try {
    const {
      name,
      traits,
      sampleTexts,
      description,
      voiceId,
      voiceProvider,
      voiceLabel,
      avatarUrl,
    } = req.body;

    if (!name) return res.status(400).json({ message: "Name is required" });

    // Auto-assign a free preset if the client didn't pick one
    const fallback = !voiceId && !voiceProvider ? pickDefaultVoice() : {};

    const person = await Person.create({
      userId: req.user._id,
      name,
      traits: Array.isArray(traits) ? traits : traits ? [traits] : [],
      sampleTexts: Array.isArray(sampleTexts)
        ? sampleTexts
        : sampleTexts
        ? [sampleTexts]
        : [],
      description: description || "",
      voiceId: voiceId || fallback.voiceId || "",
      voiceProvider: voiceProvider || fallback.voiceProvider || "",
      voiceLabel: voiceLabel || fallback.voiceLabel || "",
      avatarUrl: avatarUrl || "",
    });

    res.status(201).json({ success: true, person });
  } catch (err) {
    next(err);
  }
};

exports.listPersons = async (req, res, next) => {
  try {
    const persons = await Person.find({ userId: req.user._id }).sort(
      "-createdAt"
    );
    res.json({ success: true, persons });
  } catch (err) {
    next(err);
  }
};

exports.getPerson = async (req, res, next) => {
  try {
    const person = await Person.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!person) return res.status(404).json({ message: "Person not found" });
    res.json({ success: true, person });
  } catch (err) {
    next(err);
  }
};

exports.updatePerson = async (req, res, next) => {
  try {
    const updates = (({
      name,
      traits,
      sampleTexts,
      description,
      voiceId,
      voiceProvider,
      voiceLabel,
      avatarUrl,
    }) => ({
      name,
      traits,
      sampleTexts,
      description,
      voiceId,
      voiceProvider,
      voiceLabel,
      avatarUrl,
    }))(req.body);

    Object.keys(updates).forEach(
      (k) => updates[k] === undefined && delete updates[k]
    );

    const person = await Person.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      updates,
      { new: true }
    );
    if (!person) return res.status(404).json({ message: "Person not found" });
    res.json({ success: true, person });
  } catch (err) {
    next(err);
  }
};

exports.deletePerson = async (req, res, next) => {
  try {
    const person = await Person.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!person) return res.status(404).json({ message: "Person not found" });
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    next(err);
  }
};

/**
 * Upload audio sample(s) and try to clone a voice on ElevenLabs.
 * If cloning isn't allowed on the user's plan (paid feature), we DO NOT fail —
 * we save a fallback preset voice and return success with `cloned: false` plus
 * a `fallbackVoice` field so the UI can show a clear notice.
 */
exports.uploadVoice = async (req, res, next) => {
  const filesToCleanup = [];
  try {
    const files = req.files || [];
    if (!files.length) {
      return res
        .status(400)
        .json({ message: "At least one audio file is required" });
    }
    files.forEach((f) => filesToCleanup.push(f.path));

    const { personId, name, fallbackVoiceId } = req.body;

    let person = null;
    if (personId) {
      person = await Person.findOne({
        _id: personId,
        userId: req.user._id,
      });
      if (!person) return res.status(404).json({ message: "Person not found" });
    }

    const voiceName = name || person?.name || `voice_${Date.now()}`;
    const result = await ttsProvider.cloneOrFallback(
      voiceName,
      files.map((f) => f.path),
      `Voice clone for ${voiceName}`,
      fallbackVoiceId
    );

    if (person) {
      person.voiceId = result.voiceId;
      person.voiceProvider = result.voiceProvider;
      if (!result.cloned) {
        person.voiceLabel = "Preset (cloning unavailable on your plan)";
      } else {
        person.voiceLabel = "Cloned voice";
      }
      await person.save();
    }

    // Cleanup local files
    filesToCleanup.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    });

    res.json({
      success: true,
      cloned: result.cloned,
      fallbackReason: result.reason || null,
      fallbackMessage: result.message || null,
      voiceId: result.voiceId,
      voiceProvider: result.voiceProvider,
      person: person || null,
    });
  } catch (err) {
    filesToCleanup.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    });
    next(err);
  }
};

/**
 * Return all voices the user can select from across configured providers.
 */
exports.listVoices = async (req, res, next) => {
  try {
    const data = ttsProvider.listAvailableVoices();
    res.json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
};
