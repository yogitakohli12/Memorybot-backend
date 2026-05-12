const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const upload = require("../middleware/upload");
const {
  sendMessage,
  getChat,
  clearChat,
} = require("../controllers/chatController");

router.use(auth);

// Accept either text JSON or single audio file (field name "audio")
router.post("/send", upload.single("audio"), sendMessage);
router.get("/:personId", getChat);
router.delete("/:personId", clearChat);

module.exports = router;
