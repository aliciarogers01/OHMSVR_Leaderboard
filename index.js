const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Temporary in-memory data.
// This keeps Railway from crashing now.
// We will replace this with a real database next.
const leaderboard = {
  status: "online",
  project: "OHMS VR Leaderboard",
  message: "OHMS VR leaderboard backend is running.",
  playerMonthly: [],
  playerAllTime: [],
  topAlbums: [],
  topCarts: []
};

app.get("/", (req, res) => {
  res.json(leaderboard);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "OHMS VR Leaderboard",
    time: new Date().toISOString()
  });
});

app.get("/api/leaderboard", (req, res) => {
  res.json(leaderboard);
});

// Test endpoint for later Unity/VRChat play events.
// This does NOT permanently save yet.
app.post("/api/play", (req, res) => {
  const event = {
    playerName: req.body.playerName || "Unknown Player",
    mediaType: req.body.mediaType || "unknown",
    mediaId: req.body.mediaId || "unknown",
    artist: req.body.artist || "",
    title: req.body.title || "",
    qualifiedSeconds: req.body.qualifiedSeconds || 120,
    createdAt: new Date().toISOString()
  };

  res.json({
    ok: true,
    message: "Play event received. Database saving not connected yet.",
    event
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OHMS VR Leaderboard backend running on port ${PORT}`);
});
