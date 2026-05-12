const mongoose = require("mongoose");

const personSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    traits: {
      type: [String],
      default: [],
    },
    voiceId: {
      type: String,
      default: "",
    },
    voiceProvider: {
      type: String,
      enum: ["elevenlabs", "openai", "browser", ""],
      default: "",
    },
    voiceLabel: {
      type: String,
      default: "",
    },
    sampleTexts: {
      type: [String],
      default: [],
    },
    description: {
      type: String,
      default: "",
    },
    avatarUrl: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Person", personSchema);
