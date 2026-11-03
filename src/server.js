// server.js
// Server chinh: Express (HTTP, de kiem tra server song) + Socket.IO (real-time).
// Chay mien phi tren Render.com - xem file HUONG_DAN_DEPLOY.md o thu muc goc.
"use strict";

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const db = require("./db");
const { RoomManager } = require("./rooms");
const { GameSession } = require("./game");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Route kiem tra server con song khong (mo link nay tren trinh duyet se thay chu OK)
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Chess multiplayer server dang chay", time: Date.now() });
});

// API tim kiem nguoi choi theo ten (dung khi nguoi dung go vao o tim kiem trong app)
app.get("/api/search-players", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ players: [] });
  const players = db.searchPlayers(q, 20);
  res.json({ players });
});

// API bang xep hang theo bien the + the loai thoi gian
app.get("/api/leaderboard", (req, res) => {
  const variant = req.query.variant || "chess";
  const speed = req.query.speed || "rapid";
  const rows = db.leaderboard(variant, speed, 50);
  res.json({ leaderboard: rows });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }, // Mo cho moi client ket noi (phu hop ung dung ca nhan/nho, khong phai dich vu thuong mai)
});

const roomManager = new RoomManager();

// Theo doi socket nao thuoc ve phong/van nao de xu ly khi mat ket noi
// socketId -> { roomId, color, playerId }
const socketMeta = new Map();

// roomId -> GameSession dang hoat dong
const activeGames = new Map();

// roomId -> setInterval id (kiem tra het gio)
const clockIntervals = new Map();

function speedFromMinutes(baseMinutes, incrementSeconds) {
  const estTotal = baseMinutes * 60 + incrementSeconds * 40;
  if (estTotal < 3 * 60) return "bullet";
  if (estTotal < 10 * 60) return "blitz";
  if (estTotal < 30 * 60) return "rapid";
  return "classical";
}

function startClockWatcher(roomId) {
  if (clockIntervals.has(roomId)) return;
  const interval = setInterval(() => {
    const session = activeGames.get(roomId);
    if (!session || session.status !== "playing") {
      clearInterval(interval);
      clockIntervals.delete(roomId);
      return;
    }
    const timedOutColor = session.checkTimeout();
    if (timedOutColor) {
      const winner = session.oppositeColor(timedOutColor);
      finishGame(roomId, { result: winner, reason: "timeout" });
    } else {
      io.to(roomId).emit("clock:update", session.liveClock());
    }
  }, 1000);
  clockIntervals.set(roomId, interval);
}

function stopClockWatcher(roomId) {
  const interval = clockIntervals.get(roomId);
  if (interval) {
    clearInterval(interval);
    clockIntervals.delete(roomId);
  }
}

// Watcher rieng cho van choi theo ngay (correspondence): thoi han tinh bang NGAY nen chi can
// kiem tra moi phut (khong can moi giay nhu blitz/rapid), do bot tai server khong can thiet.
function startCorrespondenceWatcher(roomId) {
  if (clockIntervals.has(roomId)) return;
  const interval = setInterval(() => {
    const session = activeGames.get(roomId);
    if (!session || session.status !== "playing") {
      clearInterval(interval);
      clockIntervals.delete(roomId);
      return;
    }
    const timedOutColor = session.checkTimeout();
    if (timedOutColor) {
      const winner = session.oppositeColor(timedOutColor);
      finishGame(roomId, { result: winner, reason: "timeout" });
    } else {
      io.to(roomId).emit("clock:update", session.liveClock());
    }
  }, 60 * 1000);
  clockIntervals.set(roomId, interval);
}

async function finishGame(roomId, { result, reason }) {
  const session = activeGames.get(roomId);
  if (!session || session.status !== "playing") return;

  session.finish({ result, reason });
  stopClockWatcher(roomId);
  roomManager.untrackActiveRoom(roomId);

  // Cap nhat Elo (khong cap nhat neu van bi huy / aborted - khong tinh la van dau thuc su)
  let eloUpdate = null;
  if (result === "white" || result === "black" || result === "draw") {
    const scoreWhite = result === "white" ? 1 : result === "black" ? 0 : 0.5;
    eloUpdate = db.applyEloUpdate({
      whiteId: session.white.playerId,
      blackId: session.black.playerId,
      variant: session.variant,
      speed: session.speed,
      scoreWhite,
    });

    db.saveGame({
      id: roomId,
      variant: session.variant,
      speed: session.speed,
      white_id: session.white.playerId,
      black_id: session.black.playerId,
      result,
      reason,
      pgn: JSON.stringify(session.toMoveList()),
      started_at: session.startedAt,
      ended_at: session.endedAt,
    });
  }

  io.to(roomId).emit("game:finished", {
    result,
    reason,
    eloUpdate,
    state: session.toPublicState(),
  });
}

io.on("connection", (socket) => {
  // --- Dang ky / xac dinh danh tinh nguoi choi ---
  // Client tu sinh playerId (vd luu trong localStorage/file cau hinh) va gui len,
  // de choi nhieu lan tren cung may ma Elo khong bi mat.
  socket.on("player:identify", ({ playerId, displayName }, callback) => {
    const id = playerId || nanoid(12);
    const player = db.ensurePlayer(id, displayName);
    socket.data.playerId = id;
    socket.data.displayName = player.display_name;
    if (callback) callback({ playerId: id, displayName: player.display_name });
  });

  // Lay Elo hien tai cua chinh minh cho tung bien the/toc do
  socket.on("player:get-ratings", ({ variant }, callback) => {
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });
    const speeds = ["bullet", "blitz", "rapid", "classical"];
    const ratings = {};
    for (const speed of speeds) {
      ratings[speed] = db.getRating(socket.data.playerId, variant, speed).elo;
    }
    if (callback) callback({ ratings });
  });

  // --- Tao phong RIENG TU bang MA 6 KY TU (gui ma cho ban be, ho nhap ma de vao) ---
  socket.on("room:create-code", (opts, callback) => {
    const { variant, timeMode, baseMinutes, incrementSeconds, daysPerMove } = opts;
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });

    const speed =
      timeMode === "clock" ? speedFromMinutes(baseMinutes, incrementSeconds)
      : timeMode === "correspondence" ? "correspondence"
      : "unlimited";
    const elo = db.getRating(socket.data.playerId, variant, speed).elo;

    const room = roomManager.createCodeRoom({
      hostSocketId: socket.id,
      hostPlayerId: socket.data.playerId,
      hostName: socket.data.displayName,
      hostElo: elo,
      variant,
      speed,
      timeMode,
      baseMinutes,
      incrementSeconds,
      daysPerMove,
    });

    socket.join(room.id);
    if (callback) callback({ room });
  });

  // Vao phong bang MA (6 ky tu ban be gui cho)
  socket.on("room:join-code", ({ code }, callback) => {
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });

    const room = roomManager.getRoomByCode(code);
    if (!room) return callback && callback({ error: "ROOM_NOT_FOUND" });

    const guestElo = db.getRating(socket.data.playerId, room.variant, room.speed).elo;

    const result = roomManager.joinByCode(code, {
      guestSocketId: socket.id,
      guestPlayerId: socket.data.playerId,
      guestName: socket.data.displayName,
      guestElo,
    });

    if (result.error) return callback && callback({ error: result.error });

    socket.join(result.room.id);
    startGameForRoom(result.room);

    if (callback) callback({ ok: true, roomId: result.room.id });
  });

  // Lay danh sach "Van dang choi" cua CHINH MINH (de hien bang trong sanh cho: dang choi voi
  // ai, tien do the nao, de bam vao xem lai ngay ca khi da ra sanh cho hoac mo lai app)
  socket.on("player:active-rooms", (opts, callback) => {
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });
    const rooms = roomManager.activeRoomsForPlayer(socket.data.playerId);
    const summaries = rooms.map((room) => {
      const session = activeGames.get(room.id);
      return {
        roomId: room.id,
        variant: room.variant,
        speed: room.speed,
        timeMode: room.timeMode,
        white: { playerId: room.hostPlayerId, name: room.hostName, elo: room.hostElo },
        black: { playerId: room.guestPlayerId, name: room.guestName, elo: room.guestElo },
        moveCount: session ? session.moves.length : 0,
        turn: session ? session.turn : "white",
        lastMoveAt: session ? session.lastMoveAt : room.createdAt,
      };
    });
    if (callback) callback({ rooms: summaries });
  });

  // Quay lai mot van dang choi dang do (sau khi roi sanh cho hoac mo lai app) - gui ve toan
  // bo trang thai hien tai giong het luc "game:started" de client dung lai duoc ngay
  socket.on("room:rejoin", ({ roomId }, callback) => {
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });
    const room = roomManager.getRoom(roomId);
    const session = activeGames.get(roomId);
    if (!room || !session) return callback && callback({ error: "ROOM_NOT_FOUND" });

    let color = null;
    if (room.hostPlayerId === socket.data.playerId) color = "white";
    else if (room.guestPlayerId === socket.data.playerId) color = "black";
    if (!color) return callback && callback({ error: "NOT_YOUR_ROOM" });

    socket.join(roomId);
    socketMeta.set(socket.id, { roomId, color, playerId: socket.data.playerId });
    if (callback) callback({ ok: true, state: session.toPublicState() });
  });

  // --- Matchmaking tu dong (nut "Tim doi thu" kieu lichess) ---
  socket.on("matchmaking:join", (opts, callback) => {
    const { variant, baseMinutes, incrementSeconds } = opts;
    if (!socket.data.playerId) return callback && callback({ error: "NOT_IDENTIFIED" });

    const speed = speedFromMinutes(baseMinutes, incrementSeconds);
    const elo = db.getRating(socket.data.playerId, variant, speed).elo;

    const entry = {
      socketId: socket.id,
      playerId: socket.data.playerId,
      name: socket.data.displayName,
      elo,
    };

    const outcome = roomManager.enqueue({ variant, speed, baseMinutes, incrementSeconds, ...entry });

    if (outcome.matched) {
      const room = roomManager.createMatchedRoom({
        a: entry,
        b: outcome.opponent,
        variant,
        speed,
        baseMinutes,
        incrementSeconds,
      });

      const hostSocket = io.sockets.sockets.get(room.hostSocketId);
      const guestSocket = io.sockets.sockets.get(room.guestSocketId);
      if (hostSocket) hostSocket.join(room.id);
      if (guestSocket) guestSocket.join(room.id);

      startGameForRoom(room);
      if (callback) callback({ matched: true, roomId: room.id });
    } else {
      if (callback) callback({ matched: false, queued: true });
    }
  });

  socket.on("matchmaking:cancel", (opts) => {
    if (!socket.data.playerId) return;
    const { variant, baseMinutes, incrementSeconds } = opts;
    const speed = speedFromMinutes(baseMinutes, incrementSeconds);
    roomManager.dequeue({ variant, speed, baseMinutes, incrementSeconds, playerId: socket.data.playerId });
  });

  function startGameForRoom(room) {
    const white = { playerId: room.hostPlayerId, socketId: room.hostSocketId, name: room.hostName, elo: room.hostElo };
    const black = { playerId: room.guestPlayerId, socketId: room.guestSocketId, name: room.guestName, elo: room.guestElo };

    const session = new GameSession({
      roomId: room.id,
      variant: room.variant,
      speed: room.speed,
      timeMode: room.timeMode,
      baseMinutes: room.baseMinutes,
      incrementSeconds: room.incrementSeconds,
      daysPerMove: room.daysPerMove,
      white,
      black,
    });

    activeGames.set(room.id, session);
    roomManager.trackActive(room.id, white.playerId, black.playerId);

    socketMeta.set(room.hostSocketId, { roomId: room.id, color: "white", playerId: white.playerId });
    socketMeta.set(room.guestSocketId, { roomId: room.id, color: "black", playerId: black.playerId });

    // Chi can dong ho dem nguoc khi timeMode='clock' (blitz/rapid/...). Voi 'unlimited' thi
    // khong bao gio het gio nen khong can watcher; voi 'correspondence' thoi han tinh bang
    // NGAY nen dung watcher rieng, kiem tra thua vi het han it thuong xuyen hon (xem duoi).
    if (room.timeMode === "clock") {
      startClockWatcher(room.id);
    } else if (room.timeMode === "correspondence") {
      startCorrespondenceWatcher(room.id);
    }

    io.to(room.id).emit("game:started", session.toPublicState());
  }

  // --- Trong van dau ---

  // 'drop': ky tu quan tha tu tui (chi Crazyhouse, vd 'q'/'r'/'b'/'n'/'p'); khi co drop thi
  // 'from' khong co y nghia (nuoc tha khong co o xuat phat tren ban).
  socket.on("move:play", ({ roomId, san, from, to, fen, promotion, drop }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return callback && callback({ error: "NOT_IN_ROOM" });

    const session = activeGames.get(roomId);
    if (!session) return callback && callback({ error: "GAME_NOT_FOUND" });

    const result = session.applyMove({ color: meta.color, san, from, to, fen, promotion, drop });
    if (result.error) return callback && callback({ error: result.error });

    socket.to(roomId).emit("move:opponent-played", {
      san,
      from,
      to,
      fen,
      promotion,
      drop,
      clock: session.liveClock(),
      turn: session.turn,
    });
    if (callback) callback({ ok: true });
  });

  // Nut "Huy" - chi hop le khi CHUA ai di nuoc nao. Sau khi co nguoi di roi, client se tu doi
  // nut nay thanh "Dau hang" va goi game:resign thay vi room:abort.
  socket.on("room:abort", ({ roomId }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return callback && callback({ error: "NOT_IN_ROOM" });

    const session = activeGames.get(roomId);
    if (!session) return callback && callback({ error: "GAME_NOT_FOUND" });

    if (!session.canAbort()) {
      return callback && callback({ error: "CANNOT_ABORT_AFTER_MOVE" });
    }

    session.abort();
    stopClockWatcher(roomId);
    roomManager.removeRoom(roomId);

    // Thong bao ro: "van co da huy do [ben nay]" cho ca 2, va rieng ben huy nhan thong diep "ban da huy"
    io.to(roomId).except(socket.id).emit("game:aborted", { byColor: meta.color, byYou: false });
    socket.emit("game:aborted", { byColor: meta.color, byYou: true });

    if (callback) callback({ ok: true });
  });

  socket.on("game:resign", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;

    const session = activeGames.get(roomId);
    if (!session || session.status !== "playing") return;

    session.resign(meta.color);
    finishGame(roomId, { result: session.result, reason: "resign" });
  });

  socket.on("draw:offer", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    const session = activeGames.get(roomId);
    if (!session || session.status !== "playing") return;

    session.offerDraw(meta.color);
    socket.to(roomId).emit("draw:offered", { byColor: meta.color });
  });

  socket.on("draw:accept", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    const session = activeGames.get(roomId);
    if (!session || session.status !== "playing" || !session.pendingDrawOffer) return;

    session.acceptDraw();
    finishGame(roomId, { result: "draw", reason: "agreement" });
  });

  socket.on("draw:decline", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    const session = activeGames.get(roomId);
    if (!session) return;

    session.clearDrawOffer();
    io.to(roomId).emit("draw:declined", { byColor: meta.color });
  });

  // Ket thuc van do checkmate / het nuoc di / etc - client (dung thu vien co tuong o Python
  // hoac chess.js o phia client Node neu co) se bao ve server ket qua da duoc xac nhan
  socket.on("game:report-end", ({ roomId, result, reason }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    finishGame(roomId, { result, reason });
  });

  // --- Chat trong van dau ---
  socket.on("chat:send", ({ roomId, text }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    const session = activeGames.get(roomId);
    if (!session) return;

    const entry = session.addChat(meta.color, text);
    io.to(roomId).emit("chat:new-message", entry);
  });

  // --- Tai dau ---
  socket.on("rematch:offer", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    const session = activeGames.get(roomId);
    if (!session) return;

    session.pendingRematchOffer = { byColor: meta.color, at: Date.now() };
    socket.to(roomId).emit("rematch:offered", { byColor: meta.color });
  });

  socket.on("rematch:accept", ({ roomId }) => {
    const oldSession = activeGames.get(roomId);
    if (!oldSession) return;

    // Tao van moi, doi mau quan (ben thua/da di sau o van truoc se doi ben de cong bang,
    // giong quy uoc lichess)
    const newWhite = oldSession.black;
    const newBlack = oldSession.white;

    const newRoomId = nanoid(8);
    const newSession = new GameSession({
      roomId: newRoomId,
      variant: oldSession.variant,
      speed: oldSession.speed,
      timeMode: oldSession.timeMode,
      baseMinutes: oldSession.baseMinutes,
      incrementSeconds: oldSession.incrementSeconds,
      daysPerMove: oldSession.daysPerMove,
      white: newWhite,
      black: newBlack,
    });

    activeGames.set(newRoomId, newSession);
    roomManager.trackActive(newRoomId, newWhite.playerId, newBlack.playerId);
    socketMeta.set(newWhite.socketId, { roomId: newRoomId, color: "white", playerId: newWhite.playerId });
    socketMeta.set(newBlack.socketId, { roomId: newRoomId, color: "black", playerId: newBlack.playerId });

    const whiteSocket = io.sockets.sockets.get(newWhite.socketId);
    const blackSocket = io.sockets.sockets.get(newBlack.socketId);
    if (whiteSocket) whiteSocket.join(newRoomId);
    if (blackSocket) blackSocket.join(newRoomId);

    if (newSession.timeMode === "clock") startClockWatcher(newRoomId);
    else if (newSession.timeMode === "correspondence") startCorrespondenceWatcher(newRoomId);
    io.to(newRoomId).emit("rematch:started", newSession.toPublicState());
  });

  socket.on("rematch:decline", ({ roomId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId) return;
    socket.to(roomId).emit("rematch:declined", { byColor: meta.color });
  });

  // --- Mat ket noi ---
  socket.on("disconnect", () => {
    const meta = socketMeta.get(socket.id);

    // Xoa khoi moi hang cho matchmaking neu dang cho
    if (socket.data.playerId) {
      roomManager.dequeueEverywhere(socket.data.playerId);
    }

    if (meta) {
      const session = activeGames.get(meta.roomId);
      if (session && session.status === "playing") {
        if (session.canAbort()) {
          // Chua co ai di nuoc nao -> coi nhu huy (giong "huy" tu dong)
          session.abort();
          stopClockWatcher(meta.roomId);
          roomManager.untrackActiveRoom(meta.roomId);
          io.to(meta.roomId).emit("game:aborted", { byColor: meta.color, byYou: false, reasonDisconnect: true });
        } else if (session.timeMode === "clock") {
          // Van co dong ho dang chay (blitz/rapid/...) -> mat ket noi tinh nhu dau hang ngay,
          // vi dong ho van dang tru thoi gian, cho lau se tu dong thua do het gio de thoi
          const winner = session.oppositeColor(meta.color);
          finishGame(meta.roomId, { result: winner, reason: "disconnect" });
        }
        // Voi 'unlimited' va 'correspondence': KHONG xu thua khi mat ket noi - nguoi choi co
        // the tat app/mat mang va quay lai sau (dac biet voi correspondence choi theo ngay,
        // day la hanh vi binh thuong). Van dau van o trang thai "playing", client quay lai se
        // dung "room:rejoin" de tiep tuc. Thoi han rieng cua correspondence van tiep tuc dem
        // qua startCorrespondenceWatcher nhu binh thuong (khong lien quan ket noi socket).
      }
      socketMeta.delete(socket.id);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Chess multiplayer server dang chay tai cong ${PORT}`);
});
