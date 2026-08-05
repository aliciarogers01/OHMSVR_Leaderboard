const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not set. Database endpoints will fail.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      player_name TEXT UNIQUE NOT NULL,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_items (
      id SERIAL PRIMARY KEY,
      media_id TEXT UNIQUE NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('album', 'cart')),
      artist TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS play_events (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id),
      media_item_id INTEGER NOT NULL REFERENCES media_items(id),
      media_type TEXT NOT NULL CHECK (media_type IN ('album', 'cart')),
      qualified_seconds INTEGER NOT NULL DEFAULT 120,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_media_counts (
      player_id INTEGER NOT NULL REFERENCES players(id),
      media_item_id INTEGER NOT NULL REFERENCES media_items(id),
      play_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (player_id, media_item_id)
    );
  `);

  console.log("Database tables ready.");
}

async function getOrCreatePlayer(playerName) {
  const name = String(playerName || "Unknown Player").trim().slice(0, 80);

  const result = await pool.query(
    `
    INSERT INTO players (player_name, last_seen)
    VALUES ($1, NOW())
    ON CONFLICT (player_name)
    DO UPDATE SET last_seen = NOW()
    RETURNING id, player_name;
    `,
    [name]
  );

  return result.rows[0];
}

async function getOrCreateMedia({ mediaId, mediaType, artist, title }) {
  const cleanMediaId = String(mediaId || "").trim().slice(0, 80);
  const cleanType = String(mediaType || "").trim().toLowerCase();

  if (!cleanMediaId) {
    throw new Error("mediaId is required");
  }

  if (cleanType !== "album" && cleanType !== "cart") {
    throw new Error("mediaType must be album or cart");
  }

  const result = await pool.query(
    `
    INSERT INTO media_items (media_id, media_type, artist, title, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (media_id)
    DO UPDATE SET
      media_type = EXCLUDED.media_type,
      artist = EXCLUDED.artist,
      title = EXCLUDED.title,
      updated_at = NOW()
    RETURNING id, media_id, media_type, artist, title;
    `,
    [
      cleanMediaId,
      cleanType,
      String(artist || "").trim().slice(0, 120),
      String(title || "").trim().slice(0, 180)
    ]
  );

  return result.rows[0];
}

async function getPlayerFavorite(playerId, mediaType) {
  const result = await pool.query(
    `
    SELECT
      mi.artist,
      mi.title,
      mi.media_id,
      pmc.play_count
    FROM player_media_counts pmc
    JOIN media_items mi ON mi.id = pmc.media_item_id
    WHERE pmc.player_id = $1
      AND mi.media_type = $2
    ORDER BY pmc.play_count DESC, pmc.updated_at ASC
    LIMIT 1;
    `,
    [playerId, mediaType]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

async function getPlayerBoard({ monthly }) {
  const timeFilter = monthly
    ? "AND pe.created_at >= date_trunc('month', NOW())"
    : "";

  const result = await pool.query(`
    SELECT
      p.id AS player_id,
      p.player_name,
      COUNT(*) FILTER (WHERE pe.media_type = 'album')::int AS album_plays,
      COUNT(*) FILTER (WHERE pe.media_type = 'cart')::int AS cart_plays,
      COUNT(*)::int AS total_plays,
      MIN(pe.created_at) AS first_counted_play
    FROM players p
    JOIN play_events pe ON pe.player_id = p.id
    WHERE 1 = 1
      ${timeFilter}
    GROUP BY p.id, p.player_name
    ORDER BY total_plays DESC, first_counted_play ASC
    LIMIT 20;
  `);

  const rows = [];

  for (const row of result.rows) {
    rows.push({
      rank: rows.length + 1,
      playerName: row.player_name,
      albumPlays: row.album_plays,
      cartPlays: row.cart_plays,
      totalPlays: row.total_plays,
      mostPlayedAlbum: await getPlayerFavorite(row.player_id, "album"),
      mostPlayedCart: await getPlayerFavorite(row.player_id, "cart")
    });
  }

  return rows;
}

async function getMediaChart(mediaType) {
  const result = await pool.query(
    `
    SELECT
      mi.media_id,
      mi.artist,
      mi.title,
      COUNT(pe.id)::int AS total_plays,
      MIN(pe.created_at) AS first_counted_play
    FROM media_items mi
    JOIN play_events pe ON pe.media_item_id = mi.id
    WHERE mi.media_type = $1
    GROUP BY mi.id, mi.media_id, mi.artist, mi.title
    ORDER BY total_plays DESC, first_counted_play ASC
    LIMIT 20;
    `,
    [mediaType]
  );

  return result.rows.map((row, index) => ({
    rank: index + 1,
    mediaId: row.media_id,
    artist: row.artist,
    title: row.title,
    totalPlays: row.total_plays
  }));
}

function favoriteLine(label, favorite) {
  if (!favorite) {
    return `${label}: none yet`;
  }

  return `${label}: ${favorite.artist} - ${favorite.title} (${favorite.play_count})`;
}

function formatPlayerBoard(title, rows) {
  const lines = [];

  lines.push(title);
  lines.push("====================");

  if (!rows || rows.length === 0) {
    lines.push("No qualified plays yet.");
    return lines.join("\n");
  }

  for (const row of rows) {
    lines.push(`${row.rank}. ${row.playerName}`);
    lines.push(`   Total: ${row.totalPlays}   Albums: ${row.albumPlays}   Carts: ${row.cartPlays}`);
    lines.push(`   ${favoriteLine("Album", row.mostPlayedAlbum)}`);
    lines.push(`   ${favoriteLine("Cart", row.mostPlayedCart)}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatMediaChart(title, rows) {
  const lines = [];

  lines.push(title);
  lines.push("====================");

  if (!rows || rows.length === 0) {
    lines.push("No qualified plays yet.");
    return lines.join("\n");
  }

  for (const row of rows) {
    lines.push(`${row.rank}. ${row.artist} - ${row.title}`);
    lines.push(`   Plays: ${row.totalPlays}`);
  }

  return lines.join("\n");
}

function sendText(res, body) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(body);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "OHMS VR Leaderboard",
    status: "online",
    database: process.env.DATABASE_URL ? "configured" : "missing DATABASE_URL"
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({
      ok: true,
      service: "OHMS VR Leaderboard",
      database: "connected",
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: "OHMS VR Leaderboard",
      database: "error",
      error: error.message
    });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const [playerMonthly, playerAllTime, topAlbums, topCarts] = await Promise.all([
      getPlayerBoard({ monthly: true }),
      getPlayerBoard({ monthly: false }),
      getMediaChart("album"),
      getMediaChart("cart")
    ]);

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      playerMonthly,
      playerAllTime,
      topAlbums,
      topCarts
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/boards/monthly.txt", async (req, res) => {
  try {
    const rows = await getPlayerBoard({ monthly: true });
    sendText(res, formatPlayerBoard("OHMS MONTHLY LISTENER LEADERS", rows));
  } catch (error) {
    res.status(500);
    sendText(res, `OHMS MONTHLY LISTENER LEADERS\nERROR: ${error.message}`);
  }
});

app.get("/api/boards/alltime.txt", async (req, res) => {
  try {
    const rows = await getPlayerBoard({ monthly: false });
    sendText(res, formatPlayerBoard("OHMS ALL-TIME LISTENER LEADERS", rows));
  } catch (error) {
    res.status(500);
    sendText(res, `OHMS ALL-TIME LISTENER LEADERS\nERROR: ${error.message}`);
  }
});

app.get("/api/boards/charts.txt", async (req, res) => {
  try {
    const [topAlbums, topCarts] = await Promise.all([
      getMediaChart("album"),
      getMediaChart("cart")
    ]);

    const body = [
      formatMediaChart("OHMS TOP 20 ALBUMS", topAlbums),
      "",
      "",
      formatMediaChart("OHMS TOP 20 CARTS", topCarts)
    ].join("\n");

    sendText(res, body);
  } catch (error) {
    res.status(500);
    sendText(res, `OHMS TOP ALBUMS & CARTS\nERROR: ${error.message}`);
  }
});

app.post("/api/play", async (req, res) => {
  try {
    const qualifiedSeconds = Number(req.body.qualifiedSeconds || 0);

    if (qualifiedSeconds < 120) {
      return res.status(400).json({
        ok: false,
        error: "Play does not qualify. Vinyl records and carts require 120 seconds."
      });
    }

    const player = await getOrCreatePlayer(req.body.playerName);

    const media = await getOrCreateMedia({
      mediaId: req.body.mediaId,
      mediaType: req.body.mediaType,
      artist: req.body.artist,
      title: req.body.title
    });

    const eventResult = await pool.query(
      `
      INSERT INTO play_events
        (player_id, media_item_id, media_type, qualified_seconds)
      VALUES
        ($1, $2, $3, $4)
      RETURNING id, created_at;
      `,
      [player.id, media.id, media.media_type, qualifiedSeconds]
    );

    await pool.query(
      `
      INSERT INTO player_media_counts
        (player_id, media_item_id, play_count, updated_at)
      VALUES
        ($1, $2, 1, NOW())
      ON CONFLICT (player_id, media_item_id)
      DO UPDATE SET
        play_count = player_media_counts.play_count + 1,
        updated_at = NOW();
      `,
      [player.id, media.id]
    );

    res.json({
      ok: true,
      message: "Qualified play saved.",
      eventId: eventResult.rows[0].id,
      createdAt: eventResult.rows[0].created_at,
      player: {
        id: player.id,
        name: player.player_name
      },
      media: {
        id: media.media_id,
        type: media.media_type,
        artist: media.artist,
        title: media.title
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`OHMS VR Leaderboard backend running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
