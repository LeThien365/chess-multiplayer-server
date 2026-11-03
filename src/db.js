// db.js
// Quan ly du lieu nguoi choi va Elo bang SQLite (file, khong can database ngoai -> mien phi hoan toan)
"use strict";

const path = require("path");
const Database = require("better-sqlite3");

// File database se nam o thu muc goc server, ten "data.sqlite"
const DB_PATH = path.join(__dirname, "..", "data.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

// Bang nguoi choi: moi "player" dinh danh bang mot id ngau nhien luu o client (khong can dang nhap/mat khau)
// Elo duoc tach rieng cho tung bien the (chess, xiangqi) va tung the loai thoi gian (bullet/blitz/rapid/classical)
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  player_id TEXT NOT NULL,
  variant TEXT NOT NULL,      -- 'chess' | 'xiangqi'
  speed TEXT NOT NULL,        -- 'bullet' | 'blitz' | 'rapid' | 'classical'
  elo INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, variant, speed),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  variant TEXT NOT NULL,
  speed TEXT NOT NULL,
  white_id TEXT NOT NULL,
  black_id TEXT NOT NULL,
  result TEXT,                -- 'white' | 'black' | 'draw' | 'aborted'
  reason TEXT,                -- 'checkmate' | 'resign' | 'timeout' | 'agreement' | 'abort' | ...
  pgn TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
`);

function ensurePlayer(id, displayName) {
  const existing = db.prepare("SELECT * FROM players WHERE id = ?").get(id);
  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      db.prepare("UPDATE players SET display_name = ? WHERE id = ?").run(displayName, id);
    }
    return existing;
  }
  db.prepare("INSERT INTO players (id, display_name, created_at) VALUES (?, ?, ?)").run(
    id,
    displayName || "Người chơi ẩn danh",
    Date.now()
  );
  return db.prepare("SELECT * FROM players WHERE id = ?").get(id);
}

function getRating(playerId, variant, speed) {
  let row = db
    .prepare("SELECT * FROM ratings WHERE player_id = ? AND variant = ? AND speed = ?")
    .get(playerId, variant, speed);
  if (!row) {
    db.prepare(
      "INSERT INTO ratings (player_id, variant, speed, elo, games, wins, losses, draws) VALUES (?, ?, ?, 1200, 0, 0, 0, 0)"
    ).run(playerId, variant, speed);
    row = db.prepare("SELECT * FROM ratings WHERE player_id = ? AND variant = ? AND speed = ?").get(
      playerId,
      variant,
      speed
    );
  }
  return row;
}

// Cong thuc Elo chuan (giong lichess/chess.com dung K-factor the he FIDE don gian hoa)
// K = 40 cho nguoi moi (< 30 van), 20 cho nguoi thuong, 10 cho nguoi tren 2400
function kFactorFor(rating, games) {
  if (games < 30) return 40;
  if (rating >= 2400) return 10;
  return 20;
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

// scoreWhite: 1 = trang thang, 0 = trang thua, 0.5 = hoa
function applyEloUpdate({ whiteId, blackId, variant, speed, scoreWhite }) {
  const rw = getRating(whiteId, variant, speed);
  const rb = getRating(blackId, variant, speed);

  const expW = expectedScore(rw.elo, rb.elo);
  const expB = 1 - expW;
  const scoreBlack = 1 - scoreWhite;

  const kW = kFactorFor(rw.elo, rw.games);
  const kB = kFactorFor(rb.elo, rb.games);

  const newEloW = Math.round(rw.elo + kW * (scoreWhite - expW));
  const newEloB = Math.round(rb.elo + kB * (scoreBlack - expB));

  const winsW = rw.wins + (scoreWhite === 1 ? 1 : 0);
  const lossW = rw.losses + (scoreWhite === 0 ? 1 : 0);
  const drawW = rw.draws + (scoreWhite === 0.5 ? 1 : 0);

  const winsB = rb.wins + (scoreBlack === 1 ? 1 : 0);
  const lossB = rb.losses + (scoreBlack === 0 ? 1 : 0);
  const drawB = rb.draws + (scoreBlack === 0.5 ? 1 : 0);

  db.prepare(
    `UPDATE ratings SET elo = ?, games = games + 1, wins = ?, losses = ?, draws = ?
     WHERE player_id = ? AND variant = ? AND speed = ?`
  ).run(newEloW, winsW, lossW, drawW, whiteId, variant, speed);

  db.prepare(
    `UPDATE ratings SET elo = ?, games = games + 1, wins = ?, losses = ?, draws = ?
     WHERE player_id = ? AND variant = ? AND speed = ?`
  ).run(newEloB, winsB, lossB, drawB, blackId, variant, speed);

  return {
    white: { before: rw.elo, after: newEloW, diff: newEloW - rw.elo },
    black: { before: rb.elo, after: newEloB, diff: newEloB - rb.elo },
  };
}

function saveGame(game) {
  db.prepare(
    `INSERT INTO games (id, variant, speed, white_id, black_id, result, reason, pgn, started_at, ended_at)
     VALUES (@id, @variant, @speed, @white_id, @black_id, @result, @reason, @pgn, @started_at, @ended_at)`
  ).run(game);
}

function searchPlayers(query, limit = 20) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT p.id, p.display_name,
              COALESCE(r.elo, 1200) AS elo
       FROM players p
       LEFT JOIN ratings r ON r.player_id = p.id AND r.variant = 'chess' AND r.speed = 'rapid'
       WHERE p.display_name LIKE ?
       ORDER BY elo DESC
       LIMIT ?`
    )
    .all(like, limit);
}

function leaderboard(variant, speed, limit = 50) {
  return db
    .prepare(
      `SELECT p.display_name, r.elo, r.games, r.wins, r.losses, r.draws
       FROM ratings r JOIN players p ON p.id = r.player_id
       WHERE r.variant = ? AND r.speed = ?
       ORDER BY r.elo DESC
       LIMIT ?`
    )
    .all(variant, speed, limit);
}

module.exports = {
  db,
  ensurePlayer,
  getRating,
  applyEloUpdate,
  saveGame,
  searchPlayers,
  leaderboard,
};
