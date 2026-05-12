const mongoose = require("mongoose");

/**
 * Tracks per-user message usage for the current calendar day (UTC).
 * Used to show the user a daily quota indicator and enforce a soft cap.
 */
const usageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    day: { type: String, required: true, index: true }, // YYYY-MM-DD (UTC)
    messageCount: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

usageSchema.index({ userId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("Usage", usageSchema);
