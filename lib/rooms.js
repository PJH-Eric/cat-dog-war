/* ===== lib/rooms.js — 房間狀態機（伺服器權威） =====
 *
 * 這一層只管「房間規則」：誰可以加入、誰佔哪一邊、什麼時候能開打、
 * 邀請連結有沒有過期、觀戰者能不能發言。真正的遊戲規則一律轉交 Rules。
 *
 * 刻意不依賴 socket.io：所有方法都是「輸入 → { ok, ... }」，
 * 這樣測試可以直接跑完整生命週期，不用開網路。
 *
 * 免費雲端前提：房間只活在記憶體裡，服務重啟就會消失。
 * 因此房間被設計成「可拋棄的暫時狀態」，沒有任何長期資料要保存。
 */
'use strict';

const crypto = require('crypto');
const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const RNG = require('../public/js/rng.js');

const CODE_ALPHABET = RNG.SEED_CHARS;          // 不含 0 O 1 I，方便口頭唸房號

const DEFAULTS = {
  maxRooms: 300,
  codeLength: 4,
  graceMs: 60 * 1000,          // 斷線後保留座位的時間
  emptyMs: 5 * 60 * 1000,      // 房間完全沒人之後多久回收
  turnMs: 90 * 1000,           // 每回合思考時間
  chatMax: 120,                // 單則訊息長度上限
  chatKeep: 80,                // 房間保留的訊息數
  chatCooldownMs: 700,         // 同一人兩則訊息的最短間隔
  summaryKeep: 120,
  inviteTtlMs: 60 * 60 * 1000, // 邀請連結預設有效期
  inviteMaxUses: 20,
  nameMax: 12,
  roomNameMax: 16
};

const err = (message, code) => ({ ok: false, error: message, code: code || 'invalid' });
const ok = (extra) => Object.assign({ ok: true }, extra || {});

/** 清掉控制字元、壓掉連續空白、限制長度。所有使用者輸入都要過這一關。 */
function sanitizeText(input, max) {
  let s = String(input === undefined || input === null ? '' : input);
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function sanitizeName(input, fallback) {
  const s = sanitizeText(input, DEFAULTS.nameMax);
  return s || fallback;
}

class Room {
  constructor(store, opts) {
    this.store = store;
    this.code = opts.code;
    this.name = opts.name;
    this.private = !!opts.private;
    this.createdAt = opts.now;

    /** id -> { id, name, role, side, ready, connected, lastSeen, joinedAt, mutedUntil, lastChatAt } */
    this.members = new Map();
    this.hostId = null;

    /** 'waiting' | 'playing' | 'finished' */
    this.phase = 'waiting';
    this.state = null;
    this.seed = opts.seed || RNG.randomSeed(null, 6);
    this.summary = [];
    this.chat = [];
    this.invites = new Map();       // token -> { role, expiresAt, maxUses, uses, revoked, createdBy, createdAt }

    /** cat / dog 兩個席位；值可以是成員 id 或 { ai: level } */
    this.seats = { cat: null, dog: null };
    this.ai = { cat: null, dog: null };   // 'easy' | 'normal' | 'hard'

    this.version = 0;
    this.turnDeadline = 0;
    this.emptySince = opts.now;
    this.lastShot = null;
    this.rematchVotes = new Set();
  }

  /* ------------------------------------------------------------ 查詢 */

  member(id) { return this.members.get(id) || null; }

  isHost(id) { return this.hostId === id; }

  sideOf(id) {
    if (this.seats.cat === id) return 'cat';
    if (this.seats.dog === id) return 'dog';
    return null;
  }

  seatKind(side) {
    if (this.ai[side]) return 'ai';
    if (this.seats[side]) return 'human';
    return 'open';
  }

  openSides() {
    return Rules.SIDES.filter((s) => this.seatKind(s) === 'open');
  }

  playerCount() {
    return Rules.SIDES.filter((s) => this.seatKind(s) !== 'open').length;
  }

  humanCount() {
    return Rules.SIDES.filter((s) => this.seatKind(s) === 'human').length;
  }

  spectators() {
    return [...this.members.values()].filter((m) => m.role === 'spectator');
  }

  connectedHumans() {
    return [...this.members.values()].filter((m) => m.connected).length;
  }

  /** 兩邊都有人（真人或 AI）而且真人都準備好了才能開打 */
  canStart() {
    if (this.phase === 'playing') return err('這一局已經開打了。');
    if (this.playerCount() < 2) return err('還有空位沒人選，等兩邊都有人（或補一個電腦對手）再開始。');
    const notReady = Rules.SIDES
      .filter((s) => this.seatKind(s) === 'human')
      .map((s) => this.members.get(this.seats[s]))
      .filter((m) => m && !m.ready);
    if (notReady.length) {
      return err('還有人沒按「準備好了」：' + notReady.map((m) => m.name).join('、'));
    }
    return ok();
  }

  /* ------------------------------------------------------------ 加入 */

  join(id, opts) {
    const { name, role, token, now } = opts || {};
    const existing = this.members.get(id);
    if (existing) {
      /* 重新連線：把原本的座位、角色與名字接回來 */
      existing.connected = true;
      existing.lastSeen = now;
      if (name) existing.name = sanitizeName(name, existing.name);
      this.emptySince = 0;
      this.touch();
      return ok({ member: existing, reconnected: true });
    }

    let wantRole = role === 'player' ? 'player' : (role === 'spectator' ? 'spectator' : 'player');

    /* 帶邀請 token 進來的，角色由 token 決定並要通過驗證 */
    if (token) {
      const check = this.checkInvite(token, now);
      if (!check.ok) return check;
      if (check.invite.role !== 'any') wantRole = check.invite.role;
    } else if (this.private && !opts.creator) {
      /* 開房的人本來就在房裡，不需要自己發一張邀請函給自己 */
      return err('這是不公開的房間，需要邀請連結才能進來。', 'private');
    }

    /* 想當玩家但沒位子了 → 明白地轉為觀戰，不默默佔位也不冒充玩家 */
    let downgraded = false;
    if (wantRole === 'player' && this.openSides().length === 0) {
      wantRole = 'spectator';
      downgraded = true;
    }

    const member = {
      id,
      name: sanitizeName(name, wantRole === 'spectator' ? '觀眾' : '玩家'),
      role: wantRole,
      ready: false,
      connected: true,
      joinedAt: now,
      lastSeen: now,
      lastChatAt: 0,
      mutedUntil: 0
    };
    this.members.set(id, member);
    if (!this.hostId) this.hostId = id;
    if (token) this.consumeInvite(token);
    this.emptySince = 0;
    this.touch();
    return ok({ member, downgraded });
  }

  /* -------------------------------------------------------- 選邊／準備 */

  pickSide(id, side) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (this.phase === 'playing') return err('對局進行中不能換邊。');
    if (m.role !== 'player') return err('觀戰者不能佔用玩家席位；要下場請按「加入對戰」。', 'forbidden');
    if (side !== 'cat' && side !== 'dog') return err('只能選貓咪或狗狗。');

    const kind = this.seatKind(side);
    if (kind === 'human' && this.seats[side] !== id) {
      const taken = this.members.get(this.seats[side]);
      return err((taken ? taken.name : '別人') + '已經選了' + Rules.SIDE_LABEL[side] + '，換另一邊吧。', 'taken');
    }
    if (kind === 'ai') return err(Rules.SIDE_LABEL[side] + '目前是電腦對手，請先把它移掉。', 'taken');

    /* 先離開原本的位子再入座，避免一個人佔兩邊 */
    const prev = this.sideOf(id);
    if (prev) this.seats[prev] = null;
    this.seats[side] = id;
    m.ready = false;
    this.touch();
    return ok({ side });
  }

  leaveSeat(id) {
    const side = this.sideOf(id);
    if (!side) return err('你現在沒有佔任何一邊。');
    if (this.phase === 'playing') return err('對局進行中不能離開席位，可以按「離開房間」認輸。');
    this.seats[side] = null;
    const m = this.member(id);
    if (m) m.ready = false;
    this.touch();
    return ok({ side });
  }

  /** 觀戰者要下場；沒位子就明確拒絕，不會偷偷把人塞進去 */
  becomePlayer(id) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (m.role === 'player') return ok({ already: true });
    if (this.phase === 'playing') return err('對局進行中無法加入，等這一局結束吧。', 'playing');
    if (this.openSides().length === 0) return err('兩邊都有人了，暫時只能觀戰。', 'full');
    m.role = 'player';
    m.ready = false;
    this.touch();
    return ok();
  }

  becomeSpectator(id) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (this.phase === 'playing' && this.sideOf(id)) {
      return err('對局進行中不能改成觀戰，可以按「離開房間」。');
    }
    const side = this.sideOf(id);
    if (side) this.seats[side] = null;
    m.role = 'spectator';
    m.ready = false;
    this.touch();
    return ok();
  }

  setReady(id, ready) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (m.role !== 'player') return err('觀戰者不需要準備。', 'forbidden');
    if (!this.sideOf(id)) return err('先選一邊（貓咪或狗狗）才能準備。');
    m.ready = !!ready;
    this.touch();
    return ok({ ready: m.ready });
  }

  setAi(id, side, level) {
    if (!this.isHost(id)) return err('只有房主可以安排電腦對手。', 'forbidden');
    if (this.phase === 'playing') return err('對局進行中不能更動席位。');
    if (side !== 'cat' && side !== 'dog') return err('只能設定貓咪或狗狗那一邊。');
    if (level === null || level === 'off') {
      this.ai[side] = null;
      this.touch();
      return ok({ side, level: null });
    }
    if (!AI.LEVELS[level]) return err('沒有這個難度。');
    if (this.seatKind(side) === 'human') return err('那一邊已經有真人玩家了。', 'taken');
    this.ai[side] = level;
    this.touch();
    return ok({ side, level });
  }

  /* ------------------------------------------------------------ 開打 */

  start(id, now) {
    if (!this.isHost(id)) return err('只有房主可以開始對局。', 'forbidden');
    const can = this.canStart();
    if (!can.ok) return can;

    this.seed = RNG.randomSeed(null, 6);
    this.state = Rules.createState({ seed: this.seed });
    this.phase = 'playing';
    this.summary = [];
    this.lastShot = null;
    this.rematchVotes.clear();
    this.turnDeadline = now + this.store.opts.turnMs;
    this.touch();
    return ok({ state: this.state });
  }

  /** 送出一發。只有「輪到的那一邊的真人玩家」可以呼叫。 */
  fire(id, action, now) {
    if (this.phase !== 'playing' || !this.state) return err('現在沒有進行中的對局。');
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    const side = this.sideOf(id);
    if (!side) return err('觀戰者不能發射，只有場上的貓咪和狗狗可以出手。', 'forbidden');
    if (this.ai[side]) return err('這一邊由電腦控制。', 'forbidden');

    const result = Rules.applyShot(this.state, side, action);
    if (!result.ok) return err(result.reason);
    this.commitShot(result, now);
    return ok({ shot: result.shot, state: this.state });
  }

  /** 使用補血道具。跟 fire 一樣只有「輪到的那一邊的真人玩家」可以呼叫。 */
  heal(id, now) {
    if (this.phase !== 'playing' || !this.state) return err('現在沒有進行中的對局。');
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    const side = this.sideOf(id);
    if (!side) return err('觀戰者不能使用道具，只有場上的貓咪和狗狗可以。', 'forbidden');
    if (this.ai[side]) return err('這一邊由電腦控制。', 'forbidden');

    const result = Rules.applyHeal(this.state, side);
    if (!result.ok) return err(result.reason);
    this.commitShot(result, now);
    return ok({ shot: result.shot, state: this.state });
  }

  /** AI 出手：由伺服器持有並執行，任何用戶端都不能代替 AI 決定 */
  fireAi(side, now, rng) {
    if (this.phase !== 'playing' || !this.state) return err('現在沒有進行中的對局。');
    if (!this.ai[side]) return err('那一邊不是電腦對手。');
    if (this.state.turn !== side) return err('還沒輪到電腦。');
    const action = AI.chooseAction(this.state, side, this.ai[side], rng);
    const result = action.type === 'heal'
      ? Rules.applyHeal(this.state, side)
      : Rules.applyShot(this.state, side, action);
    if (!result.ok) return err(result.reason);
    this.commitShot(result, now, { aiLevel: this.ai[side], sims: action.sims });
    return ok({ shot: result.shot, state: this.state });
  }

  /** 回合逾時：伺服器代為跳過，記在摘要裡讓兩邊都看得到 */
  timeoutTurn(now) {
    if (this.phase !== 'playing' || !this.state) return err('現在沒有進行中的對局。');
    const side = this.state.turn;
    const result = Rules.applyPass(this.state, side, '思考時間到，這一回合跳過。');
    if (!result.ok) return err(result.reason);
    this.commitShot(result, now, { timeout: true });
    return ok({ shot: result.shot, state: this.state });
  }

  /** 主動投降：只有場上的真人可以投降，對局結束後保留房間供雙方看結果或再來一局。 */
  surrender(id, now) {
    if (this.phase !== 'playing' || !this.state) return err('現在沒有進行中的對局。');
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    const side = this.sideOf(id);
    if (!side) return err('觀戰者不能投降，只有場上的玩家可以。', 'forbidden');
    if (this.ai[side]) return err('這一邊由電腦控制。', 'forbidden');

    const result = Rules.applySurrender(this.state, side, m.name + '主動投降。');
    if (!result.ok) return err(result.reason);
    this.commitShot(result, now, { surrender: true });
    return ok({ shot: result.shot, state: this.state });
  }

  commitShot(result, now, extra) {
    this.state = result.state;
    this.lastShot = result.shot;
    const entry = Object.assign({
      n: result.shot.n,
      side: result.shot.side,
      angle: result.shot.angle,
      power: result.shot.power,
      wind: result.shot.wind,
      item: result.shot.item || null,
      result: result.shot.result,
      damage: result.shot.damage,
      hpAfter: result.shot.hpAfter,
      distance: result.shot.distance,
      text: Rules.describeShot(result.shot),
      at: now
    }, extra || {});
    this.summary.push(entry);
    if (this.summary.length > this.store.opts.summaryKeep) {
      this.summary.splice(0, this.summary.length - this.store.opts.summaryKeep);
    }
    if (this.state.over) {
      this.phase = 'finished';
      this.turnDeadline = 0;
      for (const m of this.members.values()) m.ready = false;
    } else {
      this.turnDeadline = now + this.store.opts.turnMs;
    }
    this.touch();
  }

  /** 再來一局：兩邊玩家都要同意（只有一邊是真人時，那一位同意就好） */
  voteRematch(id, now) {
    if (this.phase !== 'finished') return err('這一局還沒結束。');
    const side = this.sideOf(id);
    if (!side) return err('觀戰者不能投票再來一局。', 'forbidden');
    this.rematchVotes.add(id);
    const humans = Rules.SIDES.filter((s) => this.seatKind(s) === 'human').map((s) => this.seats[s]);
    const all = humans.every((hid) => this.rematchVotes.has(hid));
    if (!all) {
      this.touch();
      return ok({ started: false, votes: this.rematchVotes.size, need: humans.length });
    }
    this.seed = RNG.randomSeed(null, 6);
    this.state = Rules.createState({ seed: this.seed });
    this.phase = 'playing';
    this.summary = [];
    this.lastShot = null;
    this.rematchVotes.clear();
    this.turnDeadline = now + this.store.opts.turnMs;
    this.touch();
    return ok({ started: true });
  }

  /* ------------------------------------------------------------ 聊天 */

  say(id, text, now) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (m.mutedUntil > now) {
      return err('你被暫時禁言，' + Math.ceil((m.mutedUntil - now) / 1000) + ' 秒後可以再發言。', 'muted');
    }
    if (now - m.lastChatAt < this.store.opts.chatCooldownMs) {
      return err('訊息送太快了，休息一下再發。', 'ratelimit');
    }
    const clean = sanitizeText(text, this.store.opts.chatMax);
    if (!clean) return err('訊息是空的。');

    m.lastChatAt = now;
    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      from: m.name,
      fromId: m.id,
      role: m.role,
      side: this.sideOf(id),
      text: clean,
      at: now,
      kind: 'chat'
    };
    this.pushChat(msg);
    return ok({ message: msg });
  }

  /** 系統訊息（有人加入、開打、結算…），跟玩家訊息用同一條時間軸 */
  system(text, now) {
    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      from: '系統',
      fromId: null,
      role: 'system',
      side: null,
      text: sanitizeText(text, 160),
      at: now,
      kind: 'system'
    };
    this.pushChat(msg);
    return msg;
  }

  pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > this.store.opts.chatKeep) {
      this.chat.splice(0, this.chat.length - this.store.opts.chatKeep);
    }
  }

  mute(hostId, targetId, seconds, now) {
    if (!this.isHost(hostId)) return err('只有房主可以禁言。', 'forbidden');
    const t = this.member(targetId);
    if (!t) return err('找不到這個人。');
    if (t.id === hostId) return err('不能禁言自己。');
    t.mutedUntil = now + Math.max(10, Math.min(600, Number(seconds) || 60)) * 1000;
    this.touch();
    return ok({ until: t.mutedUntil, name: t.name });
  }

  /* ------------------------------------------------------- 邀請連結 */

  createInvite(id, { role, ttlMs, maxUses, now }) {
    const m = this.member(id);
    if (!m) return err('你不在這個房間裡。');
    if (m.role !== 'player' && !this.isHost(id)) {
      return err('只有場上的玩家或房主可以產生邀請連結。', 'forbidden');
    }
    const wanted = (role === 'player' || role === 'spectator' || role === 'any') ? role : 'any';
    const ttl = Math.max(60 * 1000, Math.min(24 * 60 * 60 * 1000, Number(ttlMs) || this.store.opts.inviteTtlMs));
    const uses = Math.max(1, Math.min(100, Number(maxUses) || this.store.opts.inviteMaxUses));
    const token = crypto.randomBytes(16).toString('hex');   // 16 bytes = 猜不到
    this.invites.set(token, {
      token,
      role: wanted,
      createdBy: id,
      createdAt: now,
      expiresAt: now + ttl,
      maxUses: uses,
      uses: 0,
      revoked: false
    });
    /* 一間房最多留 8 組有效邀請，超過就把最舊的丟掉 */
    if (this.invites.size > 8) {
      const oldest = [...this.invites.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.invites.delete(oldest.token);
    }
    this.touch();
    return ok({ invite: this.invites.get(token) });
  }

  revokeInvite(id, token) {
    const inv = this.invites.get(token);
    if (!inv) return err('找不到這組邀請連結。', 'gone');
    if (inv.createdBy !== id && !this.isHost(id)) return err('只有產生者或房主可以撤銷。', 'forbidden');
    inv.revoked = true;
    this.touch();
    return ok({ token });
  }

  /** 每次加入與重新連線都會重新驗證，不只在產生的當下檢查一次 */
  checkInvite(token, now) {
    const inv = this.invites.get(String(token || ''));
    if (!inv) return err('這個邀請連結無效，可能已經被撤銷或房間換過。', 'invite_invalid');
    if (inv.revoked) return err('這個邀請連結已經被撤銷了。', 'invite_revoked');
    if (inv.expiresAt <= now) return err('這個邀請連結已經過期，請對方重新產生一組。', 'invite_expired');
    if (inv.uses >= inv.maxUses) return err('這個邀請連結的使用次數已經用完。', 'invite_used');
    if (this.phase === 'finished' && this.openSides().length === 0) {
      return ok({ invite: inv, note: '這一局已經結束，你會以觀戰身分進入房間。' });
    }
    return ok({ invite: inv });
  }

  consumeInvite(token) {
    const inv = this.invites.get(String(token || ''));
    if (inv) inv.uses += 1;
  }

  /* ------------------------------------------------------- 離開／回收 */

  disconnect(id, now) {
    const m = this.member(id);
    if (!m) return err('沒有這個人。');
    m.connected = false;
    m.lastSeen = now;
    if (this.connectedHumans() === 0) this.emptySince = now;
    this.touch();
    return ok();
  }

  leave(id, now) {
    const m = this.member(id);
    if (!m) return err('沒有這個人。');
    const side = this.sideOf(id);
    let forfeited = null;
    if (side) {
      if (this.phase === 'playing' && this.state && !this.state.over) {
        /* 離開房間沿用規則核心的投降狀態，摘要也會留下這筆紀錄。 */
        const result = Rules.applySurrender(this.state, side, m.name + '離開了房間。');
        if (result.ok) {
          this.commitShot(result, now, { forfeited: true });
          forfeited = result.state.winner;
        }
      }
      this.seats[side] = null;
    }
    this.members.delete(id);
    this.rematchVotes.delete(id);
    if (this.hostId === id) {
      const next = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostId = next ? next.id : null;
    }
    if (this.members.size === 0) this.emptySince = now;
    this.touch();
    return ok({ side, forfeited, hostChanged: this.hostId });
  }

  /** 斷線超過緩衝時間的人清掉，讓座位釋放給別人 */
  sweepMembers(now) {
    const dropped = [];
    for (const m of [...this.members.values()]) {
      if (m.connected) continue;
      if (now - m.lastSeen < this.store.opts.graceMs) continue;
      this.leave(m.id, now);
      dropped.push(m);
    }
    return dropped;
  }

  touch() { this.version += 1; }

  /* --------------------------------------------------------- 對外投影 */

  /** 大廳列表用的精簡資料 */
  brief() {
    return {
      code: this.code,
      name: this.name,
      private: this.private,
      phase: this.phase,
      players: this.playerCount(),
      maxPlayers: 2,
      humans: this.humanCount(),
      ai: Rules.SIDES.filter((s) => this.ai[s]).map((s) => ({ side: s, level: this.ai[s] })),
      spectators: this.spectators().length,
      host: this.hostId && this.members.get(this.hostId) ? this.members.get(this.hostId).name : '',
      seats: {
        cat: this.seatLabel('cat'),
        dog: this.seatLabel('dog')
      },
      turnNo: this.state ? this.state.turnNo : 0,
      createdAt: this.createdAt
    };
  }

  seatLabel(side) {
    const kind = this.seatKind(side);
    if (kind === 'ai') return { kind: 'ai', name: '電腦（' + AI.levelOf(this.ai[side]).label + '）', level: this.ai[side], ready: true, connected: true };
    if (kind === 'human') {
      const m = this.members.get(this.seats[side]);
      return { kind: 'human', name: m ? m.name : '玩家', id: m ? m.id : null, ready: m ? m.ready : false, connected: m ? m.connected : false };
    }
    return { kind: 'open', name: '空位', ready: false, connected: false };
  }

  /**
   * 傳給某一個成員的完整房間投影。
   * 這個遊戲沒有隱藏資訊，所以玩家與觀戰者看到的盤面一樣；
   * 差別在 you.can 明確標示這個人「被允許做什麼」，前端據此開關按鈕，
   * 伺服器端則在每個入口再檢查一次，不靠前端把關。
   */
  viewFor(id, now) {
    const m = this.member(id);
    const side = this.sideOf(id);
    const isHost = this.isHost(id);
    const canStart = this.canStart();
    return {
      room: {
        code: this.code,
        name: this.name,
        private: this.private,
        phase: this.phase,
        hostId: this.hostId,
        seats: { cat: this.seatLabel('cat'), dog: this.seatLabel('dog') },
        spectators: this.spectators().map((s) => ({ id: s.id, name: s.name, connected: s.connected })),
        members: [...this.members.values()].map((x) => ({
          id: x.id, name: x.name, role: x.role, side: this.sideOf(x.id),
          ready: x.ready, connected: x.connected, muted: x.mutedUntil > now
        })),
        summary: this.summary,
        chat: this.chat,
        invites: (isHost || (m && m.role === 'player'))
          ? [...this.invites.values()]
            .filter((i) => !i.revoked && i.expiresAt > now && i.uses < i.maxUses)
            .map((i) => ({ token: i.token, role: i.role, expiresAt: i.expiresAt, uses: i.uses, maxUses: i.maxUses }))
          : [],
        turnDeadline: this.turnDeadline,
        turnMs: this.store.opts.turnMs,
        rematchVotes: this.rematchVotes.size,
        version: this.version
      },
      game: this.state ? Rules.toPublic(this.state) : null,
      you: m ? {
        id: m.id,
        name: m.name,
        role: m.role,
        side,
        ready: m.ready,
        isHost,
        muted: m.mutedUntil > now,
        can: {
          pickSide: m.role === 'player' && this.phase !== 'playing',
          ready: m.role === 'player' && !!side && this.phase !== 'playing',
          start: isHost && canStart.ok,
          startBlockedBy: canStart.ok ? null : canStart.error,
          fire: this.phase === 'playing' && !!side && !!this.state && this.state.turn === side && !this.state.over,
          heal: this.phase === 'playing' && !!side && !!this.state && this.state.turn === side &&
            !this.state.over && Rules.hasItem(this.state, side, 'heal'),
          surrender: this.phase === 'playing' && !!side && !!this.state && !this.state.over && !this.ai[side],
          chat: m.mutedUntil <= now,
          invite: m.role === 'player' || isHost,
          setAi: isHost && this.phase !== 'playing',
          rematch: this.phase === 'finished' && !!side,
          becomePlayer: m.role === 'spectator' && this.phase !== 'playing' && this.openSides().length > 0
        }
      } : null
    };
  }
}

class RoomStore {
  constructor(opts) {
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.rooms = new Map();
  }

  newCode() {
    let code;
    let guard = 0;
    do {
      code = Array.from({ length: this.opts.codeLength }, () =>
        CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
      guard += 1;
    } while (this.rooms.has(code) && guard < 200);
    return code;
  }

  create(id, { name, roomName, private: isPrivate, now }) {
    if (this.rooms.size >= this.opts.maxRooms) {
      return err('伺服器上的房間已經滿了，請稍後再試。', 'busy');
    }
    const room = new Room(this, {
      code: this.newCode(),
      name: sanitizeText(roomName, this.opts.roomNameMax) || '貓狗擂台',
      private: !!isPrivate,
      now
    });
    this.rooms.set(room.code, room);
    room.join(id, { name, role: 'player', now, creator: true });
    room.hostId = id;
    return ok({ room });
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim()) || null;
  }

  list() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (r.private) continue;
      if (r.members.size === 0) continue;
      out.push(r.brief());
    }
    /* 等待中的排前面，同組再依建立時間由新到舊 */
    out.sort((a, b) => {
      const rank = (x) => (x.phase === 'waiting' ? 0 : (x.phase === 'playing' ? 1 : 2));
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
    return out.slice(0, 50);
  }

  /** 定期回收：踢掉斷線太久的人、關掉沒人的空房、回傳需要通知的房間 */
  sweep(now) {
    const changed = [];
    const closed = [];
    for (const room of [...this.rooms.values()]) {
      const dropped = room.sweepMembers(now);
      if (dropped.length) changed.push(room);
      if (room.members.size === 0) {
        if (!room.emptySince) room.emptySince = now;
        if (now - room.emptySince >= this.opts.emptyMs) {
          this.rooms.delete(room.code);
          closed.push(room);
        }
      }
    }
    return { changed, closed };
  }

  /** 回合逾時的房間 */
  dueTurns(now) {
    const due = [];
    for (const room of this.rooms.values()) {
      if (room.phase === 'playing' && room.turnDeadline && now >= room.turnDeadline) due.push(room);
    }
    return due;
  }

  size() { return this.rooms.size; }
}

module.exports = { RoomStore, Room, DEFAULTS, sanitizeText, sanitizeName };
