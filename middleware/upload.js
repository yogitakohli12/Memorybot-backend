const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || ".webm";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  // ElevenLabs voice cloning accepts: mp3, mp4, m4a, wav, flac, ogg, opus, webm.
  // mp4 is video but the audio track is extracted server-side by ElevenLabs.
  const allowedExtensions = [
    ".mp3",
    ".mp4",
    ".m4a",
    ".wav",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".webm",
    ".aac",
    ".mov",
  ];
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk =
    file.mimetype.startsWith("audio/") ||
    file.mimetype === "video/mp4" ||
    file.mimetype === "video/webm" ||
    file.mimetype === "video/quicktime" ||
    file.mimetype === "application/octet-stream"; // some browsers send this for m4a
  if (allowedExtensions.includes(ext) || mimeOk) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type "${file.mimetype}" / "${ext}". Allowed: mp3, mp4, m4a, wav, flac, ogg, webm.`
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  // ElevenLabs allows up to ~10MB per file for instant cloning.
  // We accept up to 25MB so you can upload a longer clip and have us trim.
  limits: { fileSize: 25 * 1024 * 1024 },
});

module.exports = upload;
