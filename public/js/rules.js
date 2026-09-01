/* ===== rules.js — 貓狗大戰的確定性規則核心 =====
 *
 * 這是全遊戲唯一的規則來源：本機玩家、三段 AI、以及線上的權威伺服器
 * 都只能透過這裡的 legalShot / applyShot 改變狀態，不允許各自另寫一份。
 *
 * 設計原則
 *   1. 純函式：同樣的 state + 同樣的 {angle, power} 一定得到同樣的結果。
 *      所有亂數都來自 state.seed（地形）與 seed + turnNo（風向），不呼叫 Math.random。
 *   2. 沒有 DOM、沒有 canvas、沒有 socket；渲染層只負責把 state 畫出來。
 *   3. 座標系是「數學座標」：x 向右、y 向上，y = 0 是世界底部。
 *      畫面渲染時再自己上下翻轉，規則核心不管畫面。
 *
 * 世界尺寸固定 1200 × 640，跟裝置大小無關；RWD 只是換不同的縮放比例，
 * 所以手機和桌機打出來的彈道完全一樣。
 */
(function (root, factory) {
  'use strict';
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.RNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Rules = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (RNG) {
  'use strict';

  /* ---------------------------------------------------------------- 常數 */

  var WORLD = {
    W: 1200,          // 世界寬（單位）
    H: 640,           // 世界高（單位）；砲彈可以飛出上緣，只是畫面看不到
    COLS: 160,        // 地形取樣欄數 → 每欄 7.5 單位寬
    MIN_GROUND: 24    // 地面最低不能被炸穿到低於這個高度
  };

  var CONST = {
    GRAVITY: 320,        // 重力加速度（單位/秒²）
    WIND_ACCEL: 4.5,     // 風力係數：水平加速度 = wind × 這個值
    WIND_MAX: 10,        // 風力絕對值上限
    POWER_SCALE: 5.8,    // 力道 → 初速：speed = power × 這個值
    DT: 1 / 120,         // 模擬步長
    MAX_STEPS: 2400,     // 最長飛行 20 秒，超過就算失效
    SAMPLE_EVERY: 3,     // 每幾步取一個彈道點傳給前端做動畫

    MIN_ANGLE: 0,
    MAX_ANGLE: 89,
    MIN_POWER: 10,
    MAX_POWER: 100,

    MUZZLE_FWD: 26,      // 砲口相對角色中心的前伸距離
    MUZZLE_UP: 34,       // 砲口相對角色腳底的高度
    SELF_SAFE_STEPS: 14, // 前幾步不判定打到自己，免得一出膛就自爆

    HIT_R: 22,           // 直接命中角色的判定半徑
    BODY_H: 30,          // 角色身體中心離腳底的高度（傷害距離用）

    BLAST_R: 84,         // 爆炸傷害範圍
    CORE_R: 30,          // 核心範圍內吃滿傷害
    /* 滿血 100、滿傷 20 → 至少要五發正中才會分出勝負，
     * 打歪幾次還救得回來，一局大約十幾發，節奏不會太快也不會拖。 */
    MAX_DAMAGE: 20,      // 單發最高傷害
    CRATER_R: 56,        // 炸出來的坑半徑

    MAX_HP: 100,
    MAX_TURNS: 40        // 40 回合（雙方各 20 發）還沒分出勝負就比血量
  };

  var SIDES = ['cat', 'dog'];
  var SIDE_LABEL = { cat: '貓咪', dog: '狗狗' };
  var AMMO_LABEL = { cat: '毛線球', dog: '骨頭' };

  function other(side) { return side === 'cat' ? 'dog' : 'cat'; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ------------------------------------------------------------ 地形工具 */

  var COL_W = WORLD.W / WORLD.COLS;

  /** 世界 x 座標 → 欄索引（含小數） */
  function colAt(x) { return x / COL_W - 0.5; }

  /** 線性內插取得任意 x 的地面高度 */
  function groundAt(ground, x) {
    var t = colAt(x);
    if (t <= 0) return ground[0];
    var last = ground.length - 1;
    if (t >= last) return ground[last];
    var i = Math.floor(t);
    var f = t - i;
    return ground[i] * (1 - f) + ground[i + 1] * f;
  }

  /**
   * 產生地形：三段正弦丘陵 + 中央那道貓狗都得越過的圍牆 + 兩側落腳平台。
   * 同一個種子永遠生出同一張地圖。
   */
  function makeTerrain(seed) {
    var rng = RNG.createRng('terrain:' + seed);
    var base = 118 + rng() * 46;
    var a1 = 24 + rng() * 26, p1 = rng() * Math.PI * 2;
    var a2 = 12 + rng() * 18, p2 = rng() * Math.PI * 2;
    var a3 = 6 + rng() * 10, p3 = rng() * Math.PI * 2;

    var ground = new Array(WORLD.COLS);
    for (var i = 0; i < WORLD.COLS; i++) {
      var t = i / WORLD.COLS;
      var h = base +
        a1 * Math.sin(t * Math.PI * 2 * 1.0 + p1) +
        a2 * Math.sin(t * Math.PI * 2 * 2.3 + p2) +
        a3 * Math.sin(t * Math.PI * 2 * 4.7 + p3);
      ground[i] = clamp(h, WORLD.MIN_GROUND + 20, 250);
    }

    /* 中央圍牆：貓狗大戰的招牌。太低就沒有拋物線的樂趣，太高又打不過去。 */
    var wallH = 216 + rng() * 58;
    var wallCol = Math.round(WORLD.COLS / 2);
    var wallHalf = 3;                       // ±3 欄 ≈ 52 單位寬
    for (var w = wallCol - wallHalf; w <= wallCol + wallHalf; w++) {
      if (w >= 0 && w < WORLD.COLS) ground[w] = Math.max(ground[w], wallH);
    }

    /* 兩側落腳平台：讓貓狗站在平坦處，第一發不會被自家腳邊的小丘擋掉 */
    flatten(ground, Math.round(colAt(WORLD.W * 0.10)), 6);
    flatten(ground, Math.round(colAt(WORLD.W * 0.90)), 6);
    return ground;
  }

  function flatten(ground, centerCol, half) {
    var c = clamp(centerCol, 0, ground.length - 1);
    var h = ground[c];
    for (var i = c - half; i <= c + half; i++) {
      if (i >= 0 && i < ground.length) ground[i] = h;
    }
  }

  /** 在 (x, y) 炸一個半圓坑；只從上方削掉地形，不會挖出懸空的洞穴 */
  function carve(ground, x, y, radius) {
    for (var i = 0; i < ground.length; i++) {
      var cx = (i + 0.5) * COL_W;
      var dx = cx - x;
      if (dx <= -radius || dx >= radius) continue;
      var half = Math.sqrt(radius * radius - dx * dx);
      var bottom = y - half;                 // 坑底
      if (ground[i] <= bottom) continue;     // 本來就比坑底低，不用動
      ground[i] = Math.max(WORLD.MIN_GROUND, bottom);
    }
  }

  /* -------------------------------------------------------------- 風向 */

  /**
   * 每回合的風：由 seed + 回合數決定，所以伺服器、AI 與兩邊前端算出來一模一樣。
   * 風是公開資訊，雙方都看得到，AI 用它不算作弊。
   */
  function windFor(seed, turnNo) {
    var rng = RNG.createRng('wind:' + seed + ':' + turnNo);
    rng();                                    // 丟掉第一個值，避免相鄰種子相關性
    var v = (rng() * 2 - 1) * CONST.WIND_MAX;
    return round2(v);
  }

  /* ------------------------------------------------------------ 建立狀態 */

  /**
   * @param {object} [opts]
   * @param {string} [opts.seed]      地圖種子；同種子＝同地形同風序
   * @param {string} [opts.first]     先手 'cat' | 'dog'（預設由種子決定）
   * @param {number} [opts.hp]        初始血量
   */
  function createState(opts) {
    var o = opts || {};
    var seed = RNG.normalizeSeed(o.seed) || RNG.randomSeed(null, 6);
    var ground = makeTerrain(seed);
    var hp = clamp(Number(o.hp) || CONST.MAX_HP, 1, 999);

    var catX = WORLD.W * 0.10;
    var dogX = WORLD.W * 0.90;
    var first = (o.first === 'cat' || o.first === 'dog')
      ? o.first
      : (RNG.createRng('first:' + seed)() < 0.5 ? 'cat' : 'dog');

    return {
      seed: seed,
      ground: ground,
      fighters: {
        cat: { side: 'cat', x: catX, y: groundAt(ground, catX), hp: hp, dir: 1, mood: 'idle' },
        dog: { side: 'dog', x: dogX, y: groundAt(ground, dogX), hp: hp, dir: -1, mood: 'idle' }
      },
      maxHp: hp,
      turn: first,
      turnNo: 1,
      wind: windFor(seed, 1),
      over: false,
      winner: null,       // 'cat' | 'dog' | 'draw'
      reason: '',
      lastShot: null,
      version: 0
    };
  }

  /** 深拷貝，讓 applyShot 保持「不改動輸入」的純函式性質 */
  function cloneState(state) {
    return {
      seed: state.seed,
      ground: state.ground.slice(),
      fighters: {
        cat: Object.assign({}, state.fighters.cat),
        dog: Object.assign({}, state.fighters.dog)
      },
      maxHp: state.maxHp,
      turn: state.turn,
      turnNo: state.turnNo,
      wind: state.wind,
      over: state.over,
      winner: state.winner,
      reason: state.reason,
      lastShot: state.lastShot,
      version: state.version
    };
  }

  /* -------------------------------------------------------- 合法性檢查 */

  /**
   * 檢查一次射擊是否合法。回傳 { ok, reason }。
   * reason 是可以直接顯示給玩家看的中文說明，不是錯誤代碼。
   */
  function legalShot(state, side, angle, power) {
    if (!state) return { ok: false, reason: '目前沒有進行中的對局。' };
    if (state.over) return { ok: false, reason: '這一局已經結束了，請按「再來一局」。' };
    if (side !== 'cat' && side !== 'dog') return { ok: false, reason: '不是這場對局的參賽者，無法出手。' };
    if (state.turn !== side) {
      return { ok: false, reason: '現在輪到' + SIDE_LABEL[state.turn] + '，等對手出手後才能發射。' };
    }
    var a = Number(angle), p = Number(power);
    if (!isFinite(a) || a < CONST.MIN_ANGLE || a > CONST.MAX_ANGLE) {
      return { ok: false, reason: '角度要在 ' + CONST.MIN_ANGLE + '° 到 ' + CONST.MAX_ANGLE + '° 之間。' };
    }
    if (!isFinite(p) || p < CONST.MIN_POWER || p > CONST.MAX_POWER) {
      return { ok: false, reason: '力道要在 ' + CONST.MIN_POWER + ' 到 ' + CONST.MAX_POWER + ' 之間。' };
    }
    return { ok: true, reason: '' };
  }

  /** 列出目前可以做的事，給 UI 的「合法操作」提示與 AI 的行動空間用 */
  function legalActions(state, side) {
    if (!state || state.over || state.turn !== side) return [];
    return [{
      type: 'fire',
      angle: { min: CONST.MIN_ANGLE, max: CONST.MAX_ANGLE, step: 1 },
      power: { min: CONST.MIN_POWER, max: CONST.MAX_POWER, step: 1 }
    }, {
      type: 'pass'   // 回合逾時時伺服器會替玩家放棄該回合
    }];
  }

  /* ------------------------------------------------------------ 彈道模擬 */

  /**
   * 模擬一發砲彈。這支同時被「真正出手」、AI 試算、以及測試使用，
   * 所以 AI 絕對不可能算到跟實際不同的物理結果。
   *
   * @param {object} state
   * @param {'cat'|'dog'} side
   * @param {number} angle 仰角（度），永遠朝向對手那一側
   * @param {number} power 力道
   * @param {object} [opts]
   * @param {number} [opts.wind]      改用指定風力試算（AI 的「風向認知」用；不會影響真實出手）
   * @param {boolean} [opts.trace]    是否收集彈道點（動畫用；AI 試算時關掉比較快）
   * @returns {{ points:Array, impact:object, flightTime:number, apex:number }}
   */
  function simulate(state, side, angle, power, opts) {
    var o = opts || {};
    var me = state.fighters[side];
    var foe = state.fighters[other(side)];
    var dir = me.dir;
    var rad = clamp(angle, CONST.MIN_ANGLE, CONST.MAX_ANGLE) * Math.PI / 180;
    var speed = clamp(power, CONST.MIN_POWER, CONST.MAX_POWER) * CONST.POWER_SCALE;
    var wind = (o.wind === undefined || o.wind === null) ? state.wind : Number(o.wind);
    var trace = o.trace !== false;

    var x = me.x + dir * CONST.MUZZLE_FWD;
    var y = me.y + CONST.MUZZLE_UP;
    var vx = dir * speed * Math.cos(rad);
    var vy = speed * Math.sin(rad);

    var points = trace ? [{ x: round2(x), y: round2(y) }] : null;
    var ax = wind * CONST.WIND_ACCEL;
    var apex = y;
    var impact = null;
    var steps = 0;

    for (var i = 0; i < CONST.MAX_STEPS; i++) {
      steps = i + 1;
      vx += ax * CONST.DT;
      vy -= CONST.GRAVITY * CONST.DT;
      x += vx * CONST.DT;
      y += vy * CONST.DT;
      if (y > apex) apex = y;

      /* 直接打到對手身上 */
      if (hits(x, y, foe)) { impact = { x: x, y: y, type: 'fighter', target: foe.side }; break; }
      /* 打到自己（自爆）；剛出膛的幾步不判定 */
      if (i > CONST.SELF_SAFE_STEPS && hits(x, y, me)) {
        impact = { x: x, y: y, type: 'fighter', target: me.side }; break;
      }
      /* 飛出左右邊界 → 這發打飛了，不炸地形 */
      if (x < 0 || x > WORLD.W) { impact = { x: clamp(x, 0, WORLD.W), y: y, type: 'out', target: null }; break; }
      /* 落地 */
      if (y <= groundAt(state.ground, x)) {
        impact = { x: x, y: groundAt(state.ground, x), type: 'ground', target: null }; break;
      }
      if (trace && i % CONST.SAMPLE_EVERY === 0) points.push({ x: round2(x), y: round2(y) });
    }

    if (!impact) impact = { x: clamp(x, 0, WORLD.W), y: Math.max(0, y), type: 'timeout', target: null };
    if (trace) points.push({ x: round2(impact.x), y: round2(impact.y) });

    impact.x = round2(impact.x);
    impact.y = round2(impact.y);
    return {
      points: points || [],
      impact: impact,
      flightTime: round2(steps * CONST.DT),
      apex: round2(apex)
    };
  }

  function hits(x, y, fighter) {
    var dx = x - fighter.x;
    var dy = y - (fighter.y + CONST.BODY_H);
    return dx * dx + dy * dy <= CONST.HIT_R * CONST.HIT_R;
  }

  /** 爆炸傷害：核心範圍吃滿，之後線性遞減到 0 */
  function damageAt(impactX, impactY, fighter) {
    var dx = impactX - fighter.x;
    var dy = impactY - (fighter.y + CONST.BODY_H);
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d >= CONST.BLAST_R) return { damage: 0, distance: round2(d) };
    if (d <= CONST.CORE_R) return { damage: CONST.MAX_DAMAGE, distance: round2(d) };
    var f = 1 - (d - CONST.CORE_R) / (CONST.BLAST_R - CONST.CORE_R);
    return { damage: Math.max(1, Math.round(CONST.MAX_DAMAGE * f)), distance: round2(d) };
  }

  /* -------------------------------------------------------------- 出手 */

  /**
   * 真正出一發。回傳新的 state 與這一發的完整紀錄（給動畫與操作摘要用）。
   * 不會改動傳進來的 state。
   *
   * @returns {{ ok:boolean, reason?:string, state?:object, shot?:object }}
   */
  function applyShot(state, side, action) {
    var angle = Number(action && action.angle);
    var power = Number(action && action.power);
    var legal = legalShot(state, side, angle, power);
    if (!legal.ok) return { ok: false, reason: legal.reason };

    angle = Math.round(angle * 10) / 10;
    power = Math.round(power * 10) / 10;

    var next = cloneState(state);
    var sim = simulate(state, side, angle, power, { trace: true });
    var foeSide = other(side);
    var before = { cat: state.fighters.cat.hp, dog: state.fighters.dog.hp };

    var dmg = { cat: 0, dog: 0 };
    var nearest = null;

    if (sim.impact.type === 'fighter') {
      /* 直接命中：本人吃滿傷害，旁邊的另一位照爆炸範圍算 */
      var direct = sim.impact.target;
      dmg[direct] = CONST.MAX_DAMAGE;
      var otherSide = other(direct);
      var od = damageAt(sim.impact.x, sim.impact.y, state.fighters[otherSide]);
      dmg[otherSide] = od.damage;
      nearest = 0;
      carve(next.ground, sim.impact.x, sim.impact.y, CONST.CRATER_R);
    } else if (sim.impact.type === 'ground') {
      var dc = damageAt(sim.impact.x, sim.impact.y, state.fighters.cat);
      var dd = damageAt(sim.impact.x, sim.impact.y, state.fighters.dog);
      dmg.cat = dc.damage;
      dmg.dog = dd.damage;
      nearest = (side === 'cat') ? dd.distance : dc.distance;
      carve(next.ground, sim.impact.x, sim.impact.y, CONST.CRATER_R);
    } else {
      /* 飛出界或逾時：什麼都沒發生 */
      nearest = null;
    }

    next.fighters.cat.hp = Math.max(0, before.cat - dmg.cat);
    next.fighters.dog.hp = Math.max(0, before.dog - dmg.dog);

    /* 地形被炸掉之後，兩隻都要重新落到新的地面上 */
    next.fighters.cat.y = groundAt(next.ground, next.fighters.cat.x);
    next.fighters.dog.y = groundAt(next.ground, next.fighters.dog.x);

    var foeDamage = dmg[foeSide];
    var selfDamage = dmg[side];
    var result;
    if (sim.impact.type === 'fighter' && sim.impact.target === foeSide) result = 'direct';
    else if (foeDamage > 0 && selfDamage > 0) result = 'both';
    else if (foeDamage > 0) result = 'splash';
    else if (selfDamage > 0) result = 'self';
    else if (sim.impact.type === 'out') result = 'out';
    else if (sim.impact.type === 'timeout') result = 'timeout';
    else result = 'miss';

    next.fighters[foeSide].mood = foeDamage > 0 ? 'hurt' : 'idle';
    next.fighters[side].mood = selfDamage > 0 ? 'hurt' : (foeDamage > 0 ? 'happy' : 'idle');

    var shot = {
      n: state.turnNo,
      side: side,
      angle: angle,
      power: power,
      wind: state.wind,
      result: result,
      damage: { cat: dmg.cat, dog: dmg.dog },
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: nearest,
      impact: sim.impact,
      points: sim.points,
      flightTime: sim.flightTime,
      apex: sim.apex
    };

    next.lastShot = {
      n: shot.n, side: shot.side, angle: shot.angle, power: shot.power,
      result: shot.result, damage: shot.damage, distance: shot.distance, impact: shot.impact
    };
    next.version = state.version + 1;

    /* 勝負判定：先判血量，再判回合上限 */
    var catDown = next.fighters.cat.hp <= 0;
    var dogDown = next.fighters.dog.hp <= 0;
    if (catDown && dogDown) {
      next.over = true; next.winner = 'draw'; next.reason = '兩邊同時被打趴，平手！';
    } else if (catDown) {
      next.over = true; next.winner = 'dog'; next.reason = '貓咪血量歸零，狗狗獲勝！';
    } else if (dogDown) {
      next.over = true; next.winner = 'cat'; next.reason = '狗狗血量歸零，貓咪獲勝！';
    } else {
      next.turnNo = state.turnNo + 1;
      next.turn = foeSide;
      next.wind = windFor(state.seed, next.turnNo);
      if (next.turnNo > CONST.MAX_TURNS) {
        next.over = true;
        if (next.fighters.cat.hp === next.fighters.dog.hp) {
          next.winner = 'draw';
          next.reason = '打滿 ' + CONST.MAX_TURNS + ' 回合，血量相同，平手！';
        } else {
          next.winner = next.fighters.cat.hp > next.fighters.dog.hp ? 'cat' : 'dog';
          next.reason = '打滿 ' + CONST.MAX_TURNS + ' 回合，' + SIDE_LABEL[next.winner] + '血量比較多，獲勝！';
        }
      }
    }

    if (next.over) {
      next.fighters.cat.mood = next.winner === 'cat' ? 'win' : (next.winner === 'dog' ? 'lose' : 'idle');
      next.fighters.dog.mood = next.winner === 'dog' ? 'win' : (next.winner === 'cat' ? 'lose' : 'idle');
    }

    return { ok: true, state: next, shot: shot };
  }

  /**
   * 放棄這一回合（回合計時器到了、或玩家主動跳過）。
   * 一樣走規則核心，讓摘要與版本號的處理跟正常出手一致。
   */
  function applyPass(state, side, reason) {
    if (!state) return { ok: false, reason: '目前沒有進行中的對局。' };
    if (state.over) return { ok: false, reason: '這一局已經結束了。' };
    if (state.turn !== side) return { ok: false, reason: '現在不是' + SIDE_LABEL[side] + '的回合。' };

    var next = cloneState(state);
    var shot = {
      n: state.turnNo, side: side, angle: null, power: null, wind: state.wind,
      result: 'pass', damage: { cat: 0, dog: 0 },
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: null, impact: null, points: [], flightTime: 0, apex: 0,
      note: reason || '時間到，這一回合跳過。'
    };
    next.lastShot = { n: shot.n, side: side, angle: null, power: null, result: 'pass', damage: shot.damage, distance: null, impact: null };
    next.version = state.version + 1;
    next.turnNo = state.turnNo + 1;
    next.turn = other(side);
    next.wind = windFor(state.seed, next.turnNo);

    if (next.turnNo > CONST.MAX_TURNS) {
      next.over = true;
      if (next.fighters.cat.hp === next.fighters.dog.hp) {
        next.winner = 'draw';
        next.reason = '打滿 ' + CONST.MAX_TURNS + ' 回合，血量相同，平手！';
      } else {
        next.winner = next.fighters.cat.hp > next.fighters.dog.hp ? 'cat' : 'dog';
        next.reason = '打滿 ' + CONST.MAX_TURNS + ' 回合，' + SIDE_LABEL[next.winner] + '血量比較多，獲勝！';
      }
    }
    return { ok: true, state: next, shot: shot };
  }

  /* ------------------------------------------------------- 序列化與投影 */

  /**
   * 傳給前端／觀戰者的狀態投影。
   * 這個遊戲沒有隱藏資訊（地形、血量、風向雙方都看得到），
   * 所以玩家與觀戰者拿到的是同一份；差別在於「能不能送出行動」由伺服器把關。
   */
  function toPublic(state) {
    if (!state) return null;
    return {
      seed: state.seed,
      ground: state.ground.map(function (v) { return round2(v); }),
      fighters: {
        cat: publicFighter(state.fighters.cat),
        dog: publicFighter(state.fighters.dog)
      },
      maxHp: state.maxHp,
      turn: state.turn,
      turnNo: state.turnNo,
      wind: state.wind,
      over: state.over,
      winner: state.winner,
      reason: state.reason,
      lastShot: state.lastShot,
      version: state.version
    };
  }

  function publicFighter(f) {
    return { side: f.side, x: round2(f.x), y: round2(f.y), hp: f.hp, dir: f.dir, mood: f.mood };
  }

  /** 把 toPublic 的結果還原成可以繼續運算的 state（前端本機模擬預覽用） */
  function fromPublic(pub) {
    if (!pub) return null;
    return {
      seed: pub.seed,
      ground: pub.ground.slice(),
      fighters: {
        cat: Object.assign({}, pub.fighters.cat),
        dog: Object.assign({}, pub.fighters.dog)
      },
      maxHp: pub.maxHp,
      turn: pub.turn,
      turnNo: pub.turnNo,
      wind: pub.wind,
      over: pub.over,
      winner: pub.winner,
      reason: pub.reason,
      lastShot: pub.lastShot,
      version: pub.version
    };
  }

  /* ------------------------------------------------------------ 文字說明 */

  var RESULT_TEXT = {
    direct: '直接命中！',
    splash: '爆炸波及對手',
    self: '打到自己了…',
    both: '兩邊都被炸到',
    miss: '沒打中，只炸出一個坑',
    out: '飛出畫面外了',
    timeout: '砲彈不知道飛去哪了',
    pass: '這回合跳過'
  };

  /** 把一發的結果轉成一行中文摘要，前端與伺服器共用同一種說法 */
  function describeShot(shot) {
    if (!shot) return '';
    var who = SIDE_LABEL[shot.side];
    if (shot.result === 'pass') return '第 ' + shot.n + ' 回合 ' + who + '：' + (shot.note || RESULT_TEXT.pass);
    var foe = other(shot.side);
    var head = '第 ' + shot.n + ' 回合 ' + who + '：角度 ' + shot.angle + '°、力道 ' + shot.power +
      '、風 ' + describeWind(shot.wind);
    var tail = RESULT_TEXT[shot.result] || '';
    var dmg = shot.damage[foe];
    if (dmg > 0) tail += '，對' + SIDE_LABEL[foe] + '造成 ' + dmg + ' 點傷害';
    if (shot.damage[shot.side] > 0) tail += '，自己也受了 ' + shot.damage[shot.side] + ' 點傷';
    if (dmg === 0 && shot.distance !== null && shot.distance !== undefined) {
      tail += '（距離對手 ' + Math.round(shot.distance) + ' 單位）';
    }
    return head + ' → ' + tail;
  }

  function describeWind(wind) {
    var w = Number(wind) || 0;
    var mag = Math.abs(w);
    var arrow = w > 0.05 ? '→' : (w < -0.05 ? '←' : '·');
    var level = mag < 1 ? '無風' : (mag < 3.5 ? '微風' : (mag < 7 ? '強風' : '暴風'));
    return arrow + ' ' + mag.toFixed(1) + ' ' + level;
  }

  return {
    WORLD: WORLD,
    CONST: CONST,
    SIDES: SIDES,
    SIDE_LABEL: SIDE_LABEL,
    AMMO_LABEL: AMMO_LABEL,
    RESULT_TEXT: RESULT_TEXT,

    other: other,
    clamp: clamp,
    colAt: colAt,
    groundAt: groundAt,
    makeTerrain: makeTerrain,
    carve: carve,
    windFor: windFor,

    createState: createState,
    cloneState: cloneState,
    legalShot: legalShot,
    legalActions: legalActions,
    simulate: simulate,
    damageAt: damageAt,
    applyShot: applyShot,
    applyPass: applyPass,

    toPublic: toPublic,
    fromPublic: fromPublic,
    describeShot: describeShot,
    describeWind: describeWind
  };
}));
