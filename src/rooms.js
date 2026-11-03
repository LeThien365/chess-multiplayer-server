// rooms.js
// Quan ly: phong rieng tu vao bang MA 6 KY TU (thay cho danh sach cong khai truoc day),
// hang cho ghep cap tu dong (nhu lichess "Play"), va theo doi van dang choi cua tung nguoi.
"use strict";

const { nanoid } = require("nanoid");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bo chu/so de nham (0/O, 1/I/L)
const CODE_LENGTH = 6;

/**
 * Cau truc 1 room:
 * {
 *   id, code (ma 6 ky tu, chi co voi mode 'code'), variant, speed,
 *   timeMode: 'clock' (co dong ho binh thuong) | 'unlimited' (khong gioi han, khong dong ho) |
 *             'correspondence' (choi theo ngay, moi nuoc co han N ngay de di),
 *   baseMinutes, incrementSeconds (dung khi timeMode='clock'),
 *   daysPerMove (dung khi timeMode='correspondence'),
 *   mode: 'code' (tao bang ma, cho ban be nhap ma vao) | 'matchmaking' (tu dong ghep),
 *   hostSocketId, hostPlayerId, hostName, hostElo,
 *   guestSocketId, guestPlayerId, guestName, guestElo,
 *   status: 'waiting' | 'playing' | 'finished',
 *   createdAt
 * }
 */

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> room
    this.roomsByCode = new Map(); // code -> roomId (chi phong dang 'waiting')
    this.matchmakingQueue = new Map(); // key(...) -> [ {socketId, playerId, name, elo, queuedAt} ]
    this.playerActiveRooms = new Map(); // playerId -> Set(roomId)  (de tra ve bang "Van dang choi")
  }

  _generateUniqueCode() {
    let code;
    do {
      code = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
    } while (this.roomsByCode.has(code));
    return code;
  }

  createCodeRoom({ hostSocketId, hostPlayerId, hostName, hostElo, variant, speed, timeMode, baseMinutes, incrementSeconds, daysPerMove }) {
    const id = nanoid(8);
    const code = this._generateUniqueCode();
    const room = {
      id,
      code,
      variant,
      speed,
      timeMode: timeMode || "clock",
      baseMinutes: baseMinutes || 0,
      incrementSeconds: incrementSeconds || 0,
      daysPerMove: daysPerMove || 0,
      mode: "code",
      hostSocketId,
      hostPlayerId,
      hostName,
      hostElo,
      guestSocketId: null,
      guestPlayerId: null,
      guestName: null,
      guestElo: null,
      status: "waiting",
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    this.roomsByCode.set(code, id);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(id);
  }

  getRoomByCode(code) {
    const id = this.roomsByCode.get((code || "").toUpperCase().trim());
    return id ? this.rooms.get(id) : null;
  }

  removeRoom(id) {
    const room = this.rooms.get(id);
    if (room && room.code) this.roomsByCode.delete(room.code);
    this.rooms.delete(id);
    this._untrackActive(id);
  }

  joinByCode(code, { guestSocketId, guestPlayerId, guestName, guestElo }) {
    const room = this.getRoomByCode(code);
    if (!room) return { error: "ROOM_NOT_FOUND" };
    if (room.status !== "waiting") return { error: "ROOM_NOT_AVAILABLE" };
    if (room.hostPlayerId === guestPlayerId) return { error: "CANNOT_JOIN_OWN_ROOM" };

    room.guestSocketId = guestSocketId;
    room.guestPlayerId = guestPlayerId;
    room.guestName = guestName;
    room.guestElo = guestElo;
    room.status = "playing";
    this.roomsByCode.delete(room.code);
    return { room };
  }

  // ---- Matchmaking tu dong (giong nut "Play" cua lichess) ----

  queueKey({ variant, speed, baseMinutes, incrementSeconds }) {
    return `${variant}|${speed}|${baseMinutes}|${incrementSeconds}`;
  }

  enqueue(entry) {
    const key = this.queueKey(entry);
    if (!this.matchmakingQueue.has(key)) this.matchmakingQueue.set(key, []);
    const queue = this.matchmakingQueue.get(key);

    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      if (candidate.playerId === entry.playerId) continue;
      const diff = Math.abs(candidate.elo - entry.elo);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      const opponent = queue[bestIdx];
      queue.splice(bestIdx, 1);
      return { matched: true, opponent };
    }

    queue.push({ ...entry, queuedAt: Date.now() });
    return { matched: false };
  }

  dequeue({ variant, speed, baseMinutes, incrementSeconds, playerId }) {
    const key = this.queueKey({ variant, speed, baseMinutes, incrementSeconds });
    const queue = this.matchmakingQueue.get(key);
    if (!queue) return;
    const idx = queue.findIndex((e) => e.playerId === playerId);
    if (idx !== -1) queue.splice(idx, 1);
  }

  dequeueEverywhere(playerId) {
    for (const queue of this.matchmakingQueue.values()) {
      const idx = queue.findIndex((e) => e.playerId === playerId);
      if (idx !== -1) queue.splice(idx, 1);
    }
  }

  createMatchedRoom({ a, b, variant, speed, baseMinutes, incrementSeconds }) {
    const id = nanoid(8);
    const aIsWhite = Math.random() < 0.5;
    const white = aIsWhite ? a : b;
    const black = aIsWhite ? b : a;

    const room = {
      id,
      code: null,
      variant,
      speed,
      timeMode: "clock",
      baseMinutes,
      incrementSeconds,
      daysPerMove: 0,
      mode: "matchmaking",
      hostSocketId: white.socketId,
      hostPlayerId: white.playerId,
      hostName: white.name,
      hostElo: white.elo,
      guestSocketId: black.socketId,
      guestPlayerId: black.playerId,
      guestName: black.name,
      guestElo: black.elo,
      status: "playing",
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  // ---- Theo doi "Van dang choi" cua tung nguoi (cho bang danh sach trong sanh cho) ----

  trackActive(roomId, playerIdWhite, playerIdBlack) {
    for (const pid of [playerIdWhite, playerIdBlack]) {
      if (!this.playerActiveRooms.has(pid)) this.playerActiveRooms.set(pid, new Set());
      this.playerActiveRooms.get(pid).add(roomId);
    }
  }

  _untrackActive(roomId) {
    for (const set of this.playerActiveRooms.values()) {
      set.delete(roomId);
    }
  }

  untrackActiveRoom(roomId) {
    this._untrackActive(roomId);
  }

  activeRoomsForPlayer(playerId) {
    const set = this.playerActiveRooms.get(playerId);
    if (!set) return [];
    return Array.from(set)
      .map((id) => this.rooms.get(id))
      .filter((r) => r && r.status === "playing");
  }
}

module.exports = { RoomManager, CODE_LENGTH };
