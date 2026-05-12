const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "ai"],
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
    audioUrl: {
      type: String,
      default: "",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const chatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    personId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Person",
      required: true,
      index: true,
    },
    messages: [messageSchema],
  },
  { timestamps: true }
);

chatSchema.index({ userId: 1, personId: 1 }, { unique: true });

module.exports = mongoose.model("Chat", chatSchema);
