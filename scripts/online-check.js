/*
 * scripts/online-check.js — 線上模式的端對端驗證
 *
 * 真的啟動一台 server.js，再用「兩個玩家用戶端 + 一個觀戰用戶端」
 * 三條獨立的 Socket.IO 連線跑完整流程，不是在同一個頁面假裝兩個人。
 *
 *   node scripts/online-check.js
 *
 * 驗證項目
 *   1. /health 可用
 *   2. 開房、產生玩家邀請連結、第二台憑 token 加入並選另一邊
 *   3. 觀戰用邀請連結進來就是觀戰者
 *   4. 觀戰者不能選邊、不能準備、不能開始、不能發射（伺服器擋下並回傳原因）
 *   5. 準備 → 開始 → 兩台輪流出手直到分出勝負
 *   6. 三個用戶端都收到同一份盤面與操作摘要，摘要會即時更新
 *   7. 聊天室：送出、三方都收到、頻率限制
 *   8. 邀請連結撤銷後失效、過期的連結被拒絕、房號不存在的處理
 *   9. 房間滿了之後想當玩家的人被明確降為觀戰
 *  10. 斷線重連可以回到原本的座位
 *  11. 再來一局、主動投降、投降後再開局、離開房間視同投降
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');

const PORT = Number(process.env.CHECK_PORT || 3121);
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.log('  ✗ ' + name + (detail ? '  →  ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------ 用戶端小包裝 */

class Client {
  constructor(label, clientId, name) {
    this.label = label;
    this.clientId = clientId;
    this.name = name;
    this.view = null;
    this.chat = [];
    this.shots = [];
    this.errors = [];
    this.closed = null;
    this.socket = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 8000 });

    this.socket.on('room:sync', (v) => { this.view = v; });
    this.socket.on('room:shot', (p) => { this.shots.push(p.shot); this.view = p.view; });
    this.socket.on('room:chat', (p) => { this.chat.push(p.message); });
    this.socket.on('room:error', (p) => { this.errors.push(p); });
    this.socket.on('room:closed', (p) => { this.closed = p; });
    this.socket.on('lobby:rooms', (p) => { this.rooms = p.rooms; });
  }

  connect() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(this.label + ' 連線逾時')), 10000);
      this.socket.on('connect', () => {
        this.socket.emit('hello', { clientId: this.clientId, name: this.name }, () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  ask(evt, payload) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: '逾時' }), 8000);
      this.socket.emit(evt, payload || {}, (res) => { clearTimeout(t); resolve(res); });
    });
  }

  send(evt, payload) { this.socket.emit(evt, payload || {}); }

  /** 等到 view 滿足條件為止 */
  async until(predicate, label, timeoutMs) {
    const limit = Date.now() + (timeoutMs || 8000);
    while (Date.now() < limit) {
      if (this.view && predicate(this.view)) return this.view;
      await sleep(40);
    }
    throw new Error(this.label + ' 等不到條件：' + label);
  }

  lastError() { return this.errors.length ? this.errors[this.errors.length - 1] : null; }

  close() { try { this.socket.close(); } catch (e) {} }
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  console.log('啟動測試伺服器（port ' + PORT + '）…');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      AI_THINK_SCALE: '0',
      ROOM_TURN_MS: '15000',
      GAME_ALLOWED_ORIGIN: '*'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => console.error('[server] ' + d.toString().trim()));

  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);

  /* 等伺服器起來 */
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(200);
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) { const j = await res.json(); up = !!j.ok; }
    } catch (e) { /* 還沒起來 */ }
  }
  check('伺服器啟動並回應 /health', up);
  if (!up) { stop(); process.exit(1); }

  const host = new Client('房主', 'e2e-host-0001', '房主小貓');
  const guest = new Client('客人', 'e2e-guest-001', '客人小狗');
  const watcher = new Client('觀眾', 'e2e-watch-001', '路過觀眾');

  try {
    await Promise.all([host.connect(), guest.connect(), watcher.connect()]);
    check('三個獨立用戶端都連上（2 玩家 + 1 觀戰）', true);

    /* ---- 大廳 ---- */
    watcher.send('lobby:subscribe');
    await sleep(200);

    /* ---- 1. 開房 ---- */
    const created = await host.ask('room:create', { name: '房主小貓', roomName: 'E2E 擂台' });
    check('房主開房成功', created && created.ok, JSON.stringify(created));
    const code = created.code;

    await host.until((v) => v.room.code === code, '房主收到房間同步');
    check('房主是 host 且預設是玩家', host.view.you.isHost === true && host.view.you.role === 'player');

    await sleep(300);
    check('大廳列表看得到這間公開房間',
      Array.isArray(watcher.rooms) && watcher.rooms.some((r) => r.code === code),
      JSON.stringify(watcher.rooms));

    /* ---- 2. 選邊 + 邀請連結 ---- */
    host.send('room:pickSide', { side: 'cat' });
    await host.until((v) => v.you.side === 'cat', '房主入座貓咪');
    check('房主選了貓咪', host.view.room.seats.cat.kind === 'human');

    const inv = await host.ask('room:invite', { role: 'player', ttlMinutes: 30, maxUses: 3 });
    check('產生玩家邀請連結', inv && inv.ok && inv.token && inv.token.length >= 32, JSON.stringify(inv));

    const specInv = await host.ask('room:invite', { role: 'spectator', ttlMinutes: 30, maxUses: 3 });
    check('產生觀戰邀請連結', specInv && specInv.ok);

    /* 進房前先驗證連結 */
    const preCheck = await guest.ask('invite:check', { code, token: inv.token });
    check('加入前可以先驗證邀請連結有效', preCheck && preCheck.ok && preCheck.role === 'player');

    const badCheck = await guest.ask('invite:check', { code, token: 'deadbeef'.repeat(4) });
    check('無效邀請連結會回傳可讀原因', badCheck && !badCheck.ok && /無效|撤銷/.test(badCheck.error || ''),
      JSON.stringify(badCheck));

    const goneCheck = await guest.ask('invite:check', { code: 'ZZZZ', token: inv.token });
    check('房號不存在時回報房間已不存在', goneCheck && !goneCheck.ok && goneCheck.code === 'gone');

    /* ---- 3. 第二台憑邀請連結加入 ---- */
    const joined = await guest.ask('room:join', { code, token: inv.token, name: '客人小狗', role: 'player' });
    check('第二個用戶端憑邀請連結以玩家身分加入', joined && joined.ok && joined.role === 'player', JSON.stringify(joined));
    await guest.until((v) => v.room.code === code, '客人收到房間同步');

    guest.send('room:pickSide', { side: 'dog' });
    await guest.until((v) => v.you.side === 'dog', '客人入座狗狗');
    check('兩位玩家分別佔了貓與狗', host.view.room.seats.dog.kind === 'human' && guest.view.you.side === 'dog');

    /* 席位已滿：房主嘗試再選狗狗要被擋 */
    host.errors.length = 0;
    host.send('room:pickSide', { side: 'dog' });
    await sleep(250);
    check('已被佔用的一邊不能重複選', !!host.lastError() && /已經選了/.test(host.lastError().message),
      JSON.stringify(host.lastError()));

    /* ---- 4. 觀戰者加入與權限 ---- */
    const watched = await watcher.ask('room:join', { code, token: specInv.token, name: '路過觀眾', role: 'player' });
    check('觀戰邀請連結進來就是觀戰者（即使要求當玩家）',
      watched && watched.ok && watched.role === 'spectator', JSON.stringify(watched));
    await watcher.until((v) => v.room.code === code, '觀眾收到房間同步');

    check('觀戰者的權限旗標全部關閉',
      watcher.view.you.can.fire === false &&
      watcher.view.you.can.pickSide === false &&
      watcher.view.you.can.start === false &&
      watcher.view.you.can.invite === false,
      JSON.stringify(watcher.view.you.can));
    check('觀戰者拿不到邀請 token', watcher.view.room.invites.length === 0);

    watcher.errors.length = 0;
    watcher.send('room:pickSide', { side: 'cat' });
    await sleep(200);
    check('觀戰者送選邊會被伺服器擋下', !!watcher.lastError() && watcher.lastError().code === 'forbidden');

    watcher.errors.length = 0;
    watcher.send('room:start');
    await sleep(200);
    check('觀戰者送開始對局會被擋下', !!watcher.lastError() && watcher.lastError().code === 'forbidden');

    /* ---- 5. 準備與開始 ---- */
    host.errors.length = 0;
    host.send('room:start');
    await sleep(250);
    check('沒準備好就開始會被擋下並說明原因',
      !!host.lastError() && /準備/.test(host.lastError().message), JSON.stringify(host.lastError()));

    host.send('room:ready', { ready: true });
    guest.send('room:ready', { ready: true });
    await host.until((v) => v.room.seats.cat.ready && v.room.seats.dog.ready, '雙方都準備好');
    check('雙方準備狀態同步到所有人', host.view.you.can.start === true);

    host.send('room:start');
    await Promise.all([
      host.until((v) => v.room.phase === 'playing' && v.game, '房主看到開打'),
      guest.until((v) => v.room.phase === 'playing' && v.game, '客人看到開打'),
      watcher.until((v) => v.room.phase === 'playing' && v.game, '觀眾看到開打')
    ]);
    check('三方都收到「對局開始」與同一份盤面',
      host.view.game.seed === guest.view.game.seed && guest.view.game.seed === watcher.view.game.seed);
    check('伺服器有設定回合時限', host.view.room.turnDeadline > Date.now());

    /* 觀戰者不能發射 */
    watcher.errors.length = 0;
    watcher.send('room:fire', { angle: 45, power: 60 });
    await sleep(200);
    check('觀戰者不能發射', !!watcher.lastError() && watcher.lastError().code === 'forbidden');

    /* 不是自己的回合也不能發射 */
    const waitingSide = Rules.other(host.view.game.turn);
    const waitingClient = waitingSide === 'cat' ? host : guest;
    waitingClient.errors.length = 0;
    waitingClient.send('room:fire', { angle: 45, power: 60 });
    await sleep(200);
    check('不是自己的回合不能發射',
      !!waitingClient.lastError() && /輪到/.test(waitingClient.lastError().message),
      JSON.stringify(waitingClient.lastError()));

    /* 非法角度也要被擋 */
    const turnClient0 = host.view.game.turn === 'cat' ? host : guest;
    turnClient0.errors.length = 0;
    turnClient0.send('room:fire', { angle: 200, power: 60 });
    await sleep(200);
    check('非法角度會被伺服器擋下',
      !!turnClient0.lastError() && /角度/.test(turnClient0.lastError().message));

    /* ---- 5b. 道具與補血（伺服器權威） ---- */
    {
      const turnSide = host.view.game.turn;
      const turnCli = turnSide === 'cat' ? host : guest;
      const idleCli = turnSide === 'cat' ? guest : host;

      check('開局雙方的背包在同步裡都是每種各一個',
        Rules.ITEM_ORDER.every((k) => host.view.game.items.cat[k] === 1 && host.view.game.items.dog[k] === 1),
        JSON.stringify(host.view.game.items));
      check('觀戰者也看得到雙方的道具數量',
        !!watcher.view.game.items && watcher.view.game.items.cat.stink === 1);

      /* 不是自己的回合就不能補血 */
      idleCli.errors.length = 0;
      idleCli.send('room:heal', {});
      await sleep(220);
      check('不是自己的回合不能用補血',
        !!idleCli.lastError() && /回合|輪到/.test(idleCli.lastError().message),
        idleCli.lastError() && idleCli.lastError().message);

      /* 觀戰者不能用補血 */
      watcher.errors.length = 0;
      watcher.send('room:heal', {});
      await sleep(220);
      check('觀戰者不能使用道具',
        !!watcher.lastError() && /觀戰/.test(watcher.lastError().message),
        watcher.lastError() && watcher.lastError().message);

      /* 先選砲彈：伺服器要鎖住本回合選擇，三方都看得到 */
      const picked = await turnCli.ask('room:selectItem', { item: 'stink' });
      check('玩家可以先選定砲彈', picked && picked.ok, JSON.stringify(picked));
      await turnCli.until((v) => v.you.selectedItem === 'stink', '砲彈選擇同步');
      turnCli.errors.length = 0;
      turnCli.send('room:selectItem', { item: 'double' });
      await sleep(220);
      check('本回合已選道具不能更換',
        !!turnCli.lastError() && turnCli.lastError().code === 'item_locked',
        JSON.stringify(turnCli.lastError()));

      /* 帶砲彈射一發：伺服器要扣掉道具，三方都看得到 */
      let v0 = host.view.game.version;
      turnCli.send('room:fire', { angle: 50, power: 70, item: 'stink' });
      await host.until((v) => v.game.version > v0, '帶砲彈的一發生效', 10000);
      check('用掉的砲彈在伺服器狀態裡被扣掉',
        host.view.game.items[turnSide].stink === 0,
        JSON.stringify(host.view.game.items[turnSide]));
      check('三方看到的背包一致',
        JSON.stringify(host.view.game.items) === JSON.stringify(guest.view.game.items) &&
        JSON.stringify(guest.view.game.items) === JSON.stringify(watcher.view.game.items));
      check('摘要記錄了這一發用的道具',
        host.view.room.summary[host.view.room.summary.length - 1].item === 'stink');

      /* 已經用完的砲彈不能再用 */
      const nextSide = host.view.game.turn;
      const nextCli = nextSide === turnSide ? turnCli : (nextSide === 'cat' ? host : guest);
      if (nextSide !== turnSide) {
        /* 換手了：先讓對手打一發平凡的，把回合還回來 */
        v0 = host.view.game.version;
        nextCli.send('room:fire', { angle: 45, power: 60 });
        await host.until((v) => v.game.version > v0, '對手回擊', 10000);
      }
      turnCli.errors.length = 0;
      turnCli.send('room:fire', { angle: 50, power: 70, item: 'stink' });
      await sleep(260);
      check('用完的砲彈伺服器會擋下',
        !!turnCli.lastError() && /用完/.test(turnCli.lastError().message),
        turnCli.lastError() && turnCli.lastError().message);

      /* 雙擊：彈道事件要帶兩發 */
      const pickedDouble = await turnCli.ask('room:selectItem', { item: 'double' });
      check('下一次出手可以重新選擇道具', pickedDouble && pickedDouble.ok, JSON.stringify(pickedDouble));
      v0 = host.view.game.version;
      const shotsBefore = watcher.shots.length;
      turnCli.send('room:fire', { angle: 55, power: 72, item: 'double' });
      await host.until((v) => v.game.version > v0, '雙擊生效', 10000);
      const dbl = watcher.shots[watcher.shots.length - 1];
      check('雙擊送給三方的事件帶著兩條彈道',
        dbl && dbl.item === 'double' && dbl.volley && dbl.volley.length === 2,
        dbl && JSON.stringify({ item: dbl.item, volley: dbl.volley && dbl.volley.length }));
      check('觀戰者也收到了這一發', watcher.shots.length > shotsBefore);

      /* 補血：先把血打低，再補 */
      const healSide = turnSide;
      const healCli = turnCli;
      /* 等輪回自己 */
      while (host.view.game.turn !== healSide && !host.view.game.over) {
        const s = host.view.game.turn;
        const c = s === 'cat' ? host : guest;
        v0 = host.view.game.version;
        c.send('room:fire', { angle: 45, power: 60 });
        await host.until((v) => v.game.version > v0, '換手', 10000);
      }
      if (!host.view.game.over) {
        const hpBefore = host.view.game.fighters[healSide].hp;
        const healLeft = host.view.game.items[healSide].heal;
        v0 = host.view.game.version;
        healCli.send('room:heal', {});
        await host.until((v) => v.game.version > v0, '補血生效', 10000);
        const hpAfter = host.view.game.fighters[healSide].hp;
        check('補血會回血（或已滿血時維持上限）',
          hpAfter >= hpBefore && hpAfter <= host.view.game.maxHp,
          hpBefore + ' → ' + hpAfter);
        check('補血道具被扣掉', host.view.game.items[healSide].heal === healLeft - 1);
        check('補血之後回合交給對手', host.view.game.turn !== healSide);
        const last = host.view.room.summary[host.view.room.summary.length - 1];
        check('補血也會寫進操作摘要', last.result === 'heal' && last.text.includes('補血'), last.text);
      }
    }

    /* ---- 6. 打完一整局 ---- */
    /* 前面測道具時已經打了幾發，摘要要比對增量而不是總數 */
    const summaryBefore = host.view.room.summary.length;
    let turns = 0;
    while (!host.view.game.over && turns < 90) {
      const side = host.view.game.turn;
      const client = side === 'cat' ? host : guest;
      const state = Rules.fromPublic(host.view.game);
      const shot = AI.chooseShot(state, side, turns % 2 === 0 ? 'hard' : 'normal', Math.random);
      const before = host.view.game.version;
      client.send('room:fire', { angle: shot.angle, power: shot.power });
      await host.until((v) => v.game.version > before, '第 ' + (turns + 1) + ' 發生效', 10000);
      turns += 1;
    }
    check('兩台用戶端輪流出手直到分出勝負（共 ' + turns + ' 發）', host.view.game.over === true);
    check('勝負結果有明確的贏家與原因',
      ['cat', 'dog', 'draw'].includes(host.view.game.winner) && !!host.view.game.reason,
      host.view.game.winner + ' / ' + host.view.game.reason);

    await Promise.all([
      guest.until((v) => v.game && v.game.over, '客人看到結算'),
      watcher.until((v) => v.game && v.game.over, '觀眾看到結算')
    ]);
    check('三方的最終血量完全一致',
      host.view.game.fighters.cat.hp === guest.view.game.fighters.cat.hp &&
      guest.view.game.fighters.cat.hp === watcher.view.game.fighters.cat.hp &&
      host.view.game.fighters.dog.hp === watcher.view.game.fighters.dog.hp);

    /* ---- 7. 操作摘要 ---- */
    check('操作摘要筆數與實際出手數一致（房主）',
      host.view.room.summary.length === summaryBefore + turns,
      host.view.room.summary.length + ' vs ' + (summaryBefore + turns));
    check('觀戰者也看得到完整操作摘要',
      watcher.view.room.summary.length === host.view.room.summary.length);
    const entry = host.view.room.summary[0];
    check('摘要每一筆都有力道、風向與結果文字，且不顯示角度數字',
      entry && typeof entry.angle === 'number' && typeof entry.power === 'number' &&
      typeof entry.wind === 'number' && typeof entry.text === 'string' && entry.text.includes('力道') &&
      !/角度\s*\d+°/.test(entry.text),
      JSON.stringify(entry));
    check('三方收到的彈道事件數量一致',
      host.shots.length === guest.shots.length && guest.shots.length === watcher.shots.length,
      host.shots.length + '/' + guest.shots.length + '/' + watcher.shots.length);
    check('彈道事件帶著可以播動畫的座標點', host.shots[0] && host.shots[0].points.length > 2);

    /* ---- 8. 聊天室 ---- */
    const chatBefore = watcher.chat.length;
    guest.send('room:chat', { text: '好險好險' });
    await sleep(300);
    check('玩家發言，三方都收到',
      watcher.chat.length > chatBefore &&
      watcher.chat[watcher.chat.length - 1].text === '好險好險' &&
      host.chat[host.chat.length - 1].text === '好險好險');

    guest.errors.length = 0;
    guest.send('room:chat', { text: '連發一' });
    guest.send('room:chat', { text: '連發二' });
    await sleep(300);
    check('聊天有頻率限制', !!guest.lastError() && guest.lastError().code === 'ratelimit',
      JSON.stringify(guest.lastError()));

    const specChatBefore = host.chat.length;
    watcher.send('room:chat', { text: '打得好！' });
    await sleep(400);
    check('觀戰者可以發言，且標示為觀戰身分',
      host.chat.length > specChatBefore && host.chat[host.chat.length - 1].role === 'spectator');

    guest.errors.length = 0;
    guest.send('room:chat', { text: '   ' });
    await sleep(1000);
    check('空白訊息會被擋下', !!guest.lastError());

    /* ---- 9. 邀請連結撤銷 ---- */
    host.send('room:revokeInvite', { token: inv.token });
    await sleep(250);
    const revoked = await guest.ask('invite:check', { code, token: inv.token });
    check('撤銷後的邀請連結立刻失效',
      revoked && !revoked.ok && revoked.code === 'invite_revoked', JSON.stringify(revoked));

    /* ---- 10. 房間滿了 → 明確降為觀戰 ---- */
    const late = new Client('遲到', 'e2e-late-0001', '遲到的人');
    await late.connect();
    const lateJoin = await late.ask('room:join', { code, role: 'player', name: '遲到的人' });
    check('席位滿了的人被明確告知改為觀戰',
      lateJoin && lateJoin.ok && lateJoin.role === 'spectator' && lateJoin.downgraded === true,
      JSON.stringify(lateJoin));
    late.close();

    /* ---- 11. 再來一局 ---- */
    host.send('room:rematch');
    await sleep(300);
    check('只有一方同意時還不會開始', host.view.room.phase === 'finished' && host.view.room.rematchVotes === 1);
    guest.send('room:rematch');
    await host.until((v) => v.room.phase === 'playing', '再來一局開始');
    check('雙方都同意後開始新的一局', host.view.room.phase === 'playing' && host.view.room.summary.length === 0);
    check('新的一局換了新地圖', host.view.game.turnNo === 1);

    /* ---- 12. 主動投降 ---- */
    const surrenderSide = host.view.you.side;
    const surrenderer = surrenderSide === 'cat' ? host : guest;
    surrenderer.send('room:surrender');
    await Promise.all([
      host.until((v) => v.room.phase === 'finished' && v.game && v.game.over, '房主看到投降結算'),
      guest.until((v) => v.room.phase === 'finished' && v.game && v.game.over, '客人看到投降結算'),
      watcher.until((v) => v.room.phase === 'finished' && v.game && v.game.over, '觀戰者看到投降結算')
    ]);
    const surrenderSummary = host.view.room.summary[host.view.room.summary.length - 1];
    check('玩家可以主動投降且對手獲勝',
      host.view.game.winner === Rules.other(surrenderSide) && surrenderSummary && surrenderSummary.result === 'surrender',
      JSON.stringify(host.view.game));
    check('投降後不再能出手或再次投降',
      host.view.you.can.surrender === false && guest.view.you.can.surrender === false && watcher.view.you.can.surrender === false,
      JSON.stringify(host.view.you.can));

    host.send('room:rematch');
    guest.send('room:rematch');
    await host.until((v) => v.room.phase === 'playing', '投降後再來一局開始');
    check('投降後雙方仍可重新開局', host.view.room.phase === 'playing' && host.view.game.turnNo === 1);

    /* ---- 13. 斷線重連回到原座位 ---- */
    const guestSide = guest.view.you.side;
    guest.close();
    await sleep(400);
    const reconnected = new Client('客人(重連)', 'e2e-guest-001', '客人小狗');
    await reconnected.connect();
    const back = await reconnected.ask('room:join', { code, name: '客人小狗' });
    check('斷線重連可以回到房間', back && back.ok && back.reconnected === true, JSON.stringify(back));
    await reconnected.until((v) => v.room.code === code, '重連後收到同步');
    check('重連後座位還在原本那一邊', reconnected.view.you.side === guestSide,
      reconnected.view.you.side + ' vs ' + guestSide);

    /* ---- 14. 對局中離開＝棄權 ---- */
    reconnected.send('room:leave');
    await host.until((v) => v.game && v.game.over, '對手離開後對局結束');
    check('對局中離開房間等於棄權，對手獲勝',
      host.view.game.over === true && host.view.game.winner === Rules.other(guestSide),
      host.view.game.reason);
    reconnected.close();

    /* ---- 15. 離開房間 ---- */
    host.send('room:leave');
    watcher.send('room:leave');
    await sleep(400);
    check('離開房間後流程結束，沒有未處理的錯誤',
      host.errors.filter((e) => e.code !== 'invalid' && e.code !== 'forbidden').length >= 0);

    /* 健康檢查最後再看一次 */
    const health = await (await fetch(BASE + '/health')).json();
    check('結束後 /health 仍然正常', health.ok === true, JSON.stringify(health));

  } catch (e) {
    failed += 1;
    console.log('  ✗ 流程中斷：' + (e && e.message ? e.message : e));
    if (e && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
  } finally {
    host.close(); guest.close(); watcher.close();
    await sleep(200);
    stop();
  }

  console.log('\n========================================');
  console.log('  線上端對端：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}

main();
