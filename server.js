require("dotenv").config();
// IMPORTANT: load httpAgent FIRST so the global undici dispatcher + TLS env
// var are set before any HTTPS-touching module (axios, openai SDK, etc) loads.
require("./utils/httpAgent");
const { printBanner } = require("./utils/startupBanner");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");

const connectDB = require("./config/db");
const errorHandler = require("./middleware/error");

const authRoutes = require("./routes/auth");
const personRoutes = require("./routes/person");
const chatRoutes = require("./routes/chat");
const healthRoutes = require("./routes/health");
const usageRoutes = require("./routes/usage");

const app = express();
// Connect to MongoDB
connectDB();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const audioDir = path.join(__dirname, "uploads", "audio");
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      process.env.CLIENT_URL,
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// Static files for audio
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Memory Voice Avatar API" });
});

// API Routes
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/person", personRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/usage", usageRoutes);

// Error handling middleware (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await printBanner();
  } catch (e) {
    console.warn("Startup banner failed:", e.message);
  }
});
