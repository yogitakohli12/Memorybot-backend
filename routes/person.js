const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const upload = require("../middleware/upload");
const {
  createPerson,
  listPersons,
  getPerson,
  updatePerson,
  deletePerson,
  uploadVoice,
  listVoices,
} = require("../controllers/personController");

router.use(auth);

// Voice catalog (must be before /:id)
router.get("/voices", listVoices);

router.post("/", createPerson);
router.get("/", listPersons);
router.get("/:id", getPerson);
router.put("/:id", updatePerson);
router.delete("/:id", deletePerson);

// Voice upload (multiple audio files)
router.post("/voice-upload", upload.array("files", 5), uploadVoice);

module.exports = router;
