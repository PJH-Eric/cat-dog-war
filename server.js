/*
 * server.js — 貓狗大戰的權威伺服器
 *
 * Express 負責靜態前端與 /health，Socket.IO 負責大廳、房間與對局。
 * 「誰可以做什麼」由 lib/rooms.js 判斷，「這一發打出去會怎樣」由 public/js/rules.js
 * 判斷 —— 兩者都是伺服器說了算，用戶端送過來的只是「意圖」。
 *
 * 環境變數
 *   PORT                 監聽埠（Render 之類的平台會自動注入），預設 3020
 *   HOST                 監聽介面，預設 0.0.0.0
 *   GAME_ALLOWED_ORIGIN  允許連進來的前端來源，逗號分隔；* 代表不限制
 *   AI_THINK_SCALE       AI 思考延遲倍率（自動化測試會設成 0 讓它立刻出手）
 *   ROOM_TURN_MS         每回合思考時間（毫秒）
 */
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const Rules = require('./public/js/rules.js');
const AI = require('./public/js/ai.js');
const RNG = require('./public/js/rng.js');
const { RoomStore, sanitizeName, sanitizeText } = require('./lib/rooms.js');

const PORT = Number(process.env.PORT || 3020);
const HOST = process.env.HOST || '0.0.0.0';
const AI_THINK_SCALE = process.env.AI_THINK_SCALE === undefined ? 1 : Number(process.env.AI_THINK_SCALE);
const TURN_MS = Number(process.env.ROOM_TURN_MS || 90000);
const STARTED_AT = Date.now();

/* 允許的前端來源：正式環境請明確設定，不要放著 * 不管 */
const ALLOWED = String(process.env.GAME_ALLOWED_ORIGIN || '*')
  .split(',').map((s) => s.trim()).filter(Boolean);
const allowAll = ALLOWED.includes('*');

function originAllowed(origin) {
  if (allowAll) return true;
  if (!origin) return true;              // 同源請求不帶 Origin
  return ALLOWED.includes(origin);
}

/* ------------------------------------------------------------ HTTP */

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); }
}));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'cat-dog-war',
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    rooms: store.size(),
    sockets: io ? io.engine.clientsCount : 0
  });
});

/* 給大廳在還沒開 socket 前先看一眼房間列表用 */
app.get('/api/rooms', (_req, res) => res.json({ rooms: store.list(), total: store.size() }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, cb) { cb(null, originAllowed(origin)); },
    methods: ['GET', 'POST']
  },
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5
});

/* ------------------------------------------------------------ 狀態 */

const store = new RoomStore({ turnMs: TURN_MS });

/** roomCode -> Set<socket> */
const roomSockets = new Map();
/** 停在大廳、要收房間列表推播的 socket */
const lobbySockets = new Set();
/** roomCode -> Timeout（AI 思考中的計時器） */
const aiTimers = new Map();

const now = () => Date.now();

function socketsOf(code) {
  let set = roomSockets.get(code);
  if (!set) { set = new Set(); roomSockets.set(code, set); }
  return set;
}

function attach(socket, code) {
  detach(socket);
  socket.data.roomCode = code;
  socketsOf(code).add(socket);
  lobbySockets.delete(socket);
}

function detach(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const set = roomSockets.get(code);
  if (set) {
    set.delete(socket);
    if (!set.size) roomSockets.delete(code);
  }
  socket.data.roomCode = null;
}

/** 每個人拿到的是「自己這個角色看到的投影」，權限旗標由伺服器算好 */
function syncRoom(room) {
  const t = now();
  for (const s of socketsOf(room.code)) {
    s.emit('room:sync', room.viewFor(s.data.clientId, t));
  }
}

function syncLobby() {
  if (!lobbySockets.size) return;
  const payload = { rooms: store.list(), total: store.size() };
  for (const s of lobbySockets) s.emit('lobby:rooms', payload);
}

function broadcastChat(room, message) {
  for (const s of socketsOf(room.code)) s.emit('room:chat', { message });
}

function broadcastShot(room, shot) {
  const t = now();
  for (const s of socketsOf(room.code)) {
    s.emit('room:shot', { shot, view: room.viewFor(s.data.clientId, t) });
  }
}

function fail(socket, message, code) {
  socket.emit('room:error', { message: String(message || '操作失敗'), code: code || 'invalid' });
}

/* ------------------------------------------------------------ AI 回合 */

function clearAiTimer(code) {
  const t = aiTimers.get(code);
  if (t) { clearTimeout(t); aiTimers.delete(code); }
}

/** 若輪到 AI，排一個「思考中」的延遲後由伺服器代打。任何用戶端都不能代替 AI 出手。 */
function scheduleAi(room) {
  clearAiTimer(room.code);
  if (room.phase !== 'playing' || !room.state || room.state.over) return;
  const side = room.state.turn;
  const level = room.ai[side];
  if (!level) return;

  const delay = Math.max(0, Math.round(AI.levelOf(level).thinkMs * (isFinite(AI_THINK_SCALE) ? AI_THINK_SCALE : 1)));
  const timer = setTimeout(() => {
    aiTimers.delete(room.code);
    if (!store.get(room.code)) return;
    const rng = RNG.createRng('ai:' + room.code + ':' + room.state.turnNo + ':' + Math.random());
    const res = room.fireAi(side, now(), rng);
    if (!res.ok) return;
    room.system('電腦（' + AI.levelOf(level).label + '）' + Rules.describeShot(res.shot), now());
    broadcastShot(room, res.shot);
    syncLobby();
    scheduleAi(room);
  }, delay);
  aiTimers.set(room.code, timer);
}

/* ------------------------------------------------------------ Socket */

io.on('connection', (socket) => {
  socket.data.clientId = null;
  socket.data.name = '玩家';
  socket.data.roomCode = null;

  socket.on('hello', (payload, ack) => {
    const p = payload || {};
    let id = String(p.clientId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) id = crypto.randomBytes(12).toString('hex');
    socket.data.clientId = id;
    socket.data.name = sanitizeName(p.name, '玩家');
    if (typeof ack === 'function') ack({ ok: true, clientId: id, name: socket.data.name, serverTime: now() });
  });

  socket.on('lobby:subscribe', () => {
    detach(socket);
    lobbySockets.add(socket);
    socket.emit('lobby:rooms', { rooms: store.list(), total: store.size() });
  });

  socket.on('lobby:unsubscribe', () => { lobbySockets.delete(socket); });

  socket.on('room:create', (payload, ack) => {
    if (!socket.data.clientId) return fail(socket, '連線還沒準備好，請重新整理頁面。', 'nosession');
    const p = payload || {};
    socket.data.name = sanitizeName(p.name, socket.data.name);
    const res = store.create(socket.data.clientId, {
      name: socket.data.name,
      roomName: p.roomName,
      private: !!p.private,
      now: now()
    });
    if (!res.ok) { fail(socket, res.error, res.code); if (typeof ack === 'function') ack(res); return; }
    const room = res.room;
    attach(socket, room.code);
    room.system(socket.data.name + ' 開了這間房。先選一邊，再按「準備好了」。', now());
    syncRoom(room);
    syncLobby();
    if (typeof ack === 'function') ack({ ok: true, code: room.code });
  });

  socket.on('room:join', (payload, ack) => {
    if (!socket.data.clientId) return fail(socket, '連線還沒準備好，請重新整理頁面。', 'nosession');
    const p = payload || {};
    const room = store.get(p.code);
    if (!room) {
      const e = { ok: false, error: '找不到這個房間，可能已經關閉或房號打錯了。', code: 'gone' };
      fail(socket, e.error, e.code);
      if (typeof ack === 'function') ack(e);
      return;
    }
    socket.data.name = sanitizeName(p.name, socket.data.name);
    const res = room.join(socket.data.clientId, {
      name: socket.data.name,
      role: p.role,
      token: p.token ? String(p.token) : null,
      now: now()
    });
    if (!res.ok) { fail(socket, res.error, res.code); if (typeof ack === 'function') ack(res); return; }
    attach(socket, room.code);
    if (!res.reconnected) {
      room.system(res.member.name + ' 加入了（' + (res.member.role === 'player' ? '玩家' : '觀戰') + '）。', now());
    } else {
      room.system(res.member.name + ' 重新連上線了。', now());
    }
    syncRoom(room);
    syncLobby();
    if (typeof ack === 'function') {
      ack({ ok: true, code: room.code, role: res.member.role, downgraded: !!res.downgraded, reconnected: !!res.reconnected });
    }
  });

  /* 進房前先問一下這個邀請連結還有沒有效，讓前端能顯示明確原因 */
  socket.on('invite:check', (payload, ack) => {
    const p = payload || {};
    const room = store.get(p.code);
    if (!room) return typeof ack === 'function' && ack({ ok: false, error: '這個邀請連結指向的房間已經不存在了。', code: 'gone' });
    const res = room.checkInvite(String(p.token || ''), now());
    if (typeof ack === 'function') {
      ack(res.ok
        ? { ok: true, role: res.invite.role, note: res.note || null, room: room.brief() }
        : res);
    }
  });

  /* --------------------------------------------------------- 房內操作 */

  function withRoom(handler) {
    return (payload, ack) => {
      const room = store.get(socket.data.roomCode);
      if (!room) return fail(socket, '你已經不在任何房間裡了。', 'gone');
      handler(room, payload || {}, ack);
    };
  }

  socket.on('room:pickSide', withRoom((room, p) => {
    const res = room.pickSide(socket.data.clientId, p.side);
    if (!res.ok) return fail(socket, res.error, res.code);
    const m = room.member(socket.data.clientId);
    room.system(m.name + ' 選了' + Rules.SIDE_LABEL[res.side] + '。', now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:leaveSeat', withRoom((room) => {
    const res = room.leaveSeat(socket.data.clientId);
    if (!res.ok) return fail(socket, res.error, res.code);
    syncRoom(room); syncLobby();
  }));

  socket.on('room:becomePlayer', withRoom((room) => {
    const res = room.becomePlayer(socket.data.clientId);
    if (!res.ok) return fail(socket, res.error, res.code);
    const m = room.member(socket.data.clientId);
    room.system(m.name + ' 從觀戰改成下場對戰。', now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:becomeSpectator', withRoom((room) => {
    const res = room.becomeSpectator(socket.data.clientId);
    if (!res.ok) return fail(socket, res.error, res.code);
    syncRoom(room); syncLobby();
  }));

  socket.on('room:ready', withRoom((room, p) => {
    const res = room.setReady(socket.data.clientId, !!p.ready);
    if (!res.ok) return fail(socket, res.error, res.code);
    syncRoom(room); syncLobby();
  }));

  socket.on('room:setAi', withRoom((room, p) => {
    const res = room.setAi(socket.data.clientId, p.side, p.level === null || p.level === 'off' ? null : String(p.level || ''));
    if (!res.ok) return fail(socket, res.error, res.code);
    room.system(res.level
      ? Rules.SIDE_LABEL[res.side] + '換成電腦對手（' + AI.levelOf(res.level).label + '）。'
      : Rules.SIDE_LABEL[res.side] + '的電腦對手已移除。', now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:start', withRoom((room) => {
    const res = room.start(socket.data.clientId, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    room.system('開打！地圖種子 ' + room.seed + '，先手是' + Rules.SIDE_LABEL[room.state.turn] + '。', now());
    syncRoom(room); syncLobby();
    scheduleAi(room);
  }));

  socket.on('room:fire', withRoom((room, p) => {
    const res = room.fire(socket.data.clientId, { angle: p.angle, power: p.power, item: p.item }, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    broadcastShot(room, res.shot);
    syncLobby();
    scheduleAi(room);
  }));

  /* 補血是獨立事件：不發射砲彈，用完直接換手 */
  socket.on('room:heal', withRoom((room) => {
    const res = room.heal(socket.data.clientId, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    broadcastShot(room, res.shot);
    syncLobby();
    scheduleAi(room);
  }));

  socket.on('room:rematch', withRoom((room) => {
    const res = room.voteRematch(socket.data.clientId, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    const m = room.member(socket.data.clientId);
    room.system(res.started
      ? '雙方都同意，新的一局開始了！'
      : m.name + ' 想再來一局（' + res.votes + '/' + res.need + '）。', now());
    syncRoom(room); syncLobby();
    if (res.started) scheduleAi(room);
  }));

  socket.on('room:chat', withRoom((room, p) => {
    const res = room.say(socket.data.clientId, p.text, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    broadcastChat(room, res.message);
  }));

  socket.on('room:mute', withRoom((room, p) => {
    const res = room.mute(socket.data.clientId, String(p.targetId || ''), p.seconds, now());
    if (!res.ok) return fail(socket, res.error, res.code);
    room.system(res.name + ' 被房主暫時禁言。', now());
    syncRoom(room);
  }));

  socket.on('room:invite', withRoom((room, p, ack) => {
    const res = room.createInvite(socket.data.clientId, {
      role: p.role, ttlMs: Number(p.ttlMinutes) * 60000, maxUses: p.maxUses, now: now()
    });
    if (!res.ok) { fail(socket, res.error, res.code); return typeof ack === 'function' && ack(res); }
    syncRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, token: res.invite.token, role: res.invite.role, expiresAt: res.invite.expiresAt, maxUses: res.invite.maxUses });
    }
  }));

  socket.on('room:revokeInvite', withRoom((room, p) => {
    const res = room.revokeInvite(socket.data.clientId, String(p.token || ''));
    if (!res.ok) return fail(socket, res.error, res.code);
    syncRoom(room);
  }));

  socket.on('room:leave', withRoom((room) => {
    const res = room.leave(socket.data.clientId, now());
    detach(socket);
    if (res.ok && res.forfeited) {
      room.system(Rules.SIDE_LABEL[res.forfeited] + '不戰而勝：對手離開了房間。', now());
      clearAiTimer(room.code);
    }
    socket.emit('room:left', { ok: true });
    syncRoom(room);
    syncLobby();
    if (room.members.size === 0) clearAiTimer(room.code);
  }));

  socket.on('disconnect', () => {
    lobbySockets.delete(socket);
    const room = store.get(socket.data.roomCode);
    detach(socket);
    if (!room) return;
    const member = room.member(socket.data.clientId);
    if (!member) return;
    /* 先標記為斷線並保留座位，讓重新整理的人可以憑 clientId 回到原位 */
    room.disconnect(socket.data.clientId, now());
    room.system(member.name + ' 斷線了，座位會先保留一分鐘。', now());
    syncRoom(room);
    syncLobby();
  });
});

/* ------------------------------------------------------------ 定時工作 */

setInterval(() => {
  const t = now();

  /* 回合逾時：伺服器代為跳過，兩邊摘要都看得到 */
  for (const room of store.dueTurns(t)) {
    const res = room.timeoutTurn(t);
    if (!res.ok) continue;
    room.system(Rules.SIDE_LABEL[res.shot.side] + '思考時間到，這一回合自動跳過。', t);
    broadcastShot(room, res.shot);
    scheduleAi(room);
  }

  /* 回收：斷線太久的人、完全沒人的空房 */
  const swept = store.sweep(t);
  for (const room of swept.changed) syncRoom(room);
  for (const room of swept.closed) {
    clearAiTimer(room.code);
    for (const s of socketsOf(room.code)) s.emit('room:closed', { reason: '房間沒有人了，已經自動關閉。' });
    roomSockets.delete(room.code);
  }
  if (swept.changed.length || swept.closed.length) syncLobby();
}, 1000);

/* ------------------------------------------------------------ 啟動 */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function shutdown(signal) {
  console.log('\n收到 ' + signal + '，正在關閉伺服器…');
  for (const [, t] of aiTimers) clearTimeout(t);
  aiTimers.clear();
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('========================================');
    console.log('  貓狗大戰 伺服器已啟動');
    console.log('========================================');
    console.log('  本機：      http://localhost:' + PORT);
    for (const ip of lanAddresses()) {
      console.log('  同網段：    http://' + ip + ':' + PORT + '   ← 另一台電腦用這個');
    }
    console.log('  健康檢查：  http://localhost:' + PORT + '/health');
    console.log('  允許來源：  ' + (allowAll ? '不限制（* — 正式環境請設定 GAME_ALLOWED_ORIGIN）' : ALLOWED.join(', ')));
    console.log('  回合時限：  ' + Math.round(TURN_MS / 1000) + ' 秒');
    console.log('----------------------------------------');
  });
}

module.exports = { app, server, io, store };
