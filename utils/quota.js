const Usage = require("../models/Usage");

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

const DEFAULT_DAILY_LIMIT = parseInt(
  process.env.DAILY_MESSAGE_LIMIT || "50",
  10
);

const getUsage = async (userId) => {
  const day = todayKey();
  let doc = await Usage.findOne({ userId, day });
  if (!doc) {
    doc = await Usage.create({ userId, day, messageCount: 0 });
  }
  return doc;
};

const recordUsage = async (userId, { promptTokens = 0, completionTokens = 0 } = {}) => {
  const day = todayKey();
  return Usage.findOneAndUpdate(
    { userId, day },
    {
      $inc: {
        messageCount: 1,
        promptTokens,
        completionTokens,
      },
      $setOnInsert: { userId, day },
    },
    { upsert: true, new: true }
  );
};

/**
 * Returns { used, limit, remaining, resetsAt }
 * resetsAt = next UTC midnight ISO string
 */
const getUsageSummary = async (userId) => {
  const doc = await getUsage(userId);
  const now = new Date();
  const resetsAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0
    )
  ).toISOString();
  return {
    used: doc.messageCount,
    limit: DEFAULT_DAILY_LIMIT,
    remaining: Math.max(0, DEFAULT_DAILY_LIMIT - doc.messageCount),
    promptTokens: doc.promptTokens,
    completionTokens: doc.completionTokens,
    resetsAt,
  };
};

const isOverQuota = async (userId) => {
  const summary = await getUsageSummary(userId);
  return summary.used >= summary.limit;
};

module.exports = {
  DEFAULT_DAILY_LIMIT,
  todayKey,
  getUsage,
  recordUsage,
  getUsageSummary,
  isOverQuota,
};
