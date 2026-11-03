// game.js
// Trang thai mot van dau dang dien ra: dong ho moi ben, lich su nuoc di, chat,
// xu ly dau hang / cau hoa / huy van (truoc nuoc di dau tien).
"use strict";

class GameSession {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.variant  'chess' | 'xiangqi'
   * @param {string} opts.timeMode 'clock' (dong ho phut+giay binh thuong) |
   *                                'unlimited' (khong gioi han, khong het gio) |
   *                                'correspondence' (choi theo ngay, moi nuoc co han N ngay)
   * @param {number} opts.baseMinutes     dung khi timeMode='clock'
   * @param {number} opts.incrementSeconds dung khi timeMode='clock'
   * @param {number} opts.daysPerMove      dung khi timeMode='correspondence'
   * @param {{playerId:string,socketId:string,name:string,elo:number}} opts.white
   * @param {{playerId:string,socketId:string,name:string,elo:number}} opts.black
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.variant = opts.variant;
    this.speed = opts.speed;
    this.timeMode = opts.timeMode || "clock";
    this.baseMinutes = opts.baseMinutes || 0;
    this.incrementSeconds = opts.incrementSeconds || 0;
    this.daysPerMove = opts.daysPerMove || 0;

    this.white = opts.white;
    this.black = opts.black;

    // Thoi gian con lai, tinh bang mili giay. Voi 'unlimited' va 'correspondence' thi
    // clock.white/black KHONG dung de dem gio thua-vi-het-gio kieu blitz, ma:
    //  - 'unlimited': khong dung den, luon null (khong hien dong ho, khong bao gio het gio)
    //  - 'correspondence': clock la "thoi han con lai cho nuoc hien tai", reset ve
    //    daysPerMove*24*60*60*1000 sau MOI nuoc di (khong tich luy/cong don nhu increment)
    if (this.timeMode === "clock") {
      this.clock = {
        white: this.baseMinutes * 60 * 1000,
        black: this.baseMinutes * 60 * 1000,
      };
    } else if (this.timeMode === "correspondence") {
      const perMoveMs = this.daysPerMove * 24 * 60 * 60 * 1000;
      this.clock = { white: perMoveMs, black: perMoveMs };
    } else {
      this.clock = { white: null, black: null };
    }

    this.turn = "white"; // ben di tiep theo
    this.moves = []; // { san: string (SAN hoac dang ky hieu rieng), from, to, fenAfter, byColor, timestamp }
    this.fenHistory = []; // luu fen sau moi nuoc de phan tich lai sau nay

    this.status = "playing"; // 'playing' | 'finished' | 'aborted'
    this.result = null; // 'white' | 'black' | 'draw' | null
    this.reason = null; // 'checkmate' | 'resign' | 'timeout' | 'agreement' | 'abort' | 'stalemate' | ...

    this.lastMoveAt = Date.now();
    this.startedAt = Date.now();

    // Nut "Huy" chi hop le khi NGUOI MOI TAO/NGUOI DI DAU chua di nuoc nao
    // Theo yeu cau: nut huy hien khi ben do CHUA di, sau khi ho da di 1 nuoc thi
    // nut tu dong chuyen thanh "dau hang" (tuc la khong the huy nua, chi co the xin thua)
    this.hasWhiteMoved = false;
    this.hasBlackMoved = false;

    // Yeu cau hoa dang cho tra loi, vd: { byColor: 'white', at: timestamp }
    this.pendingDrawOffer = null;

    // Yeu cau tai dau sau khi ket thuc: { byColor, at }
    this.pendingRematchOffer = null;

    this.chat = []; // { byColor, text, at }
  }

  oppositeColor(color) {
    return color === "white" ? "black" : "white";
  }

  // Goi khi 1 ben thuc hien nuoc di hop le (validation thuc hien o engine phia client/server tuy kien truc,
  // o day chi luu trang thai va cap nhat dong ho)
  applyMove({ color, san, from, to, fen, promotion, drop }) {
    if (this.status !== "playing") return { error: "GAME_NOT_ACTIVE" };
    if (this.turn !== color) return { error: "NOT_YOUR_TURN" };

    const now = Date.now();
    const elapsed = now - this.lastMoveAt;

    if (this.timeMode === "clock") {
      // Tru thoi gian da dung, cong increment sau khi di xong
      this.clock[color] = Math.max(0, this.clock[color] - elapsed);
      this.clock[color] += this.incrementSeconds * 1000;
    } else if (this.timeMode === "correspondence") {
      // Moi nuoc di XONG se RESET han cho ben VUA DI ve full thoi han (ho da dung han cho
      // luot nay), con ben SAP DI (vua duoc chuyen luot) cung duoc cap lai full thoi han moi
      // cho nuoc tiep theo cua ho - dung quy uoc pho bien cua co tan thu (correspondence chess)
      const perMoveMs = this.daysPerMove * 24 * 60 * 60 * 1000;
      this.clock[color] = perMoveMs;
      this.clock[this.oppositeColor(color)] = perMoveMs;
    }
    // 'unlimited': khong lam gi voi clock (luon null, khong bao gio het gio)

    this.moves.push({
      san,
      from,
      to,
      promotion: promotion || null,
      drop: drop || null,
      fenAfter: fen,
      byColor: color,
      timestamp: now,
      clockWhiteMs: this.clock.white,
      clockBlackMs: this.clock.black,
    });
    this.fenHistory.push(fen);

    if (color === "white") this.hasWhiteMoved = true;
    else this.hasBlackMoved = true;

    // Bat ky nuoc di nao cung huy yeu cau hoa dang cho (giong lichess/chess.com)
    this.pendingDrawOffer = null;

    this.turn = this.oppositeColor(color);
    this.lastMoveAt = now;

    return { ok: true };
  }

  // Tinh thoi gian con lai THUC TE tai thoi diem goi (tru luon thoi gian da troi qua tu luc lastMoveAt neu dang la luot cua ho)
  liveClock() {
    if (this.timeMode === "unlimited") {
      return { white: null, black: null };
    }
    const now = Date.now();
    const elapsedSinceLastMove = this.status === "playing" ? now - this.lastMoveAt : 0;
    const white = this.turn === "white" ? Math.max(0, this.clock.white - elapsedSinceLastMove) : this.clock.white;
    const black = this.turn === "black" ? Math.max(0, this.clock.black - elapsedSinceLastMove) : this.clock.black;
    return { white, black };
  }

  checkTimeout() {
    if (this.timeMode === "unlimited") return null; // khong bao gio het gio
    const live = this.liveClock();
    if (live.white <= 0) return "black"; // trang het gio -> den thang
    if (live.black <= 0) return "white";
    return null;
  }

  canAbort(color) {
    // Chi huy duoc khi CHUA ai di nuoc nao ca (dung quy tac an toan nhat, tranh loi dung
    // khi doi phuong da di it nhat 1 nuoc)
    return !this.hasWhiteMoved && !this.hasBlackMoved;
  }

  finish({ result, reason }) {
    this.status = "finished";
    this.result = result; // 'white' | 'black' | 'draw'
    this.reason = reason;
    this.endedAt = Date.now();
  }

  abort() {
    this.status = "aborted";
    this.result = "aborted";
    this.reason = "abort";
    this.endedAt = Date.now();
  }

  resign(color) {
    const winner = this.oppositeColor(color);
    this.finish({ result: winner, reason: "resign" });
    return winner;
  }

  offerDraw(color) {
    this.pendingDrawOffer = { byColor: color, at: Date.now() };
  }

  clearDrawOffer() {
    this.pendingDrawOffer = null;
  }

  acceptDraw() {
    this.finish({ result: "draw", reason: "agreement" });
  }

  addChat(color, text) {
    const entry = { byColor: color, text: String(text).slice(0, 500), at: Date.now() };
    this.chat.push(entry);
    return entry;
  }

  // Xuat PGN/ky hieu don gian de luu lai va dung cho phan tich Stockfish sau nay
  toMoveList() {
    return this.moves.map((m) => m.san);
  }

  toPublicState() {
    return {
      roomId: this.roomId,
      variant: this.variant,
      speed: this.speed,
      timeMode: this.timeMode,
      baseMinutes: this.baseMinutes,
      incrementSeconds: this.incrementSeconds,
      daysPerMove: this.daysPerMove,
      white: { playerId: this.white.playerId, name: this.white.name, elo: this.white.elo },
      black: { playerId: this.black.playerId, name: this.black.name, elo: this.black.elo },
      turn: this.turn,
      moves: this.moves,
      status: this.status,
      result: this.result,
      reason: this.reason,
      clock: this.liveClock(),
      hasWhiteMoved: this.hasWhiteMoved,
      hasBlackMoved: this.hasBlackMoved,
      pendingDrawOffer: this.pendingDrawOffer,
      pendingRematchOffer: this.pendingRematchOffer,
    };
  }
}

module.exports = { GameSession };
