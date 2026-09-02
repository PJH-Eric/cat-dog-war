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
 *   4. 地形固定不變、貓狗站的位置也固定：爆炸只扣血，不會改變地圖，
 *      所以同一組角度與力道在整局裡永遠打到同一個點。
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
    MIN_GROUND: 24    // 地形產生時的最低高度（地形固定不變，不會被炸壞）
  };

  var CONST = {
    GRAVITY: 320,        // 重力加速度（單位/秒²）
    WIND_ACCEL: 4.5,     // 風力係數：水平加速度 = wind × 這個值
    WIND_MAX: 10,        // 風力絕對值上限
    POWER_SCALE: 8.0,    // 力道 → 初速：speed = power × 這個值 × 體力係數；滿力可跨過整張戰場
    /* 體力係數：滿血是 1.0，血量歸零時只剩這個比例。
     * 受傷越重，同一個力道飛得越近，必須把力道調更大才打得到 —— 
     * 這是完全由血量決定的公開資訊，兩邊與 AI 都算得出同一個值。 */
    WEAK_MIN: 0.72,
    DT: 1 / 120,         // 模擬步長
    MAX_STEPS: 2400,     // 最長飛行 20 秒，超過就算失效
    SAMPLE_EVERY: 3,     // 每幾步取一個彈道點傳給前端做動畫

    MIN_ANGLE: 0,
    MAX_ANGLE: 89,
    MIN_POWER: 10,
    MAX_POWER: 100,

    /* 站台高度：貓咪站在開蓋的垃圾桶上、狗狗站在房子前的木平台上。
     * 兩邊墊一樣高，所以誰都沒有居高臨下的優勢；畫面上畫的高度就是這裡，
     * 物理與視覺不會對不起來。 */
    STAND_H: 46,

    MUZZLE_FWD: 26,      // 砲口相對角色中心的前伸距離
    MUZZLE_UP: 48,       // 砲口相對角色腳底的高度（配合放大的角色）
    SELF_SAFE_STEPS: 14, // 前幾步不判定打到自己，免得一出膛就自爆

    HIT_R: 34,           // 角色碰撞基準尺寸；hits() 會依頭／身體／腿部輪廓拆分判定
    BODY_H: 36,          // 角色身體中心離腳底的高度（傷害距離用）
    HEAD_Y_MIN: 48,      // 角色局部高度達到這裡算頭部命中
    LEG_Y_MAX: 23,       // 角色局部高度低於這裡算腿部命中
    HEAD_DAMAGE_MULTIPLIER: 1.65, // 頭部爆擊，比身體命中更痛
    LEG_DAMAGE_MULTIPLIER: 0.75,  // 腿部命中，傷害較低

    BLAST_R: 84,         // 爆炸傷害範圍
    CORE_R: 30,          // 核心範圍內吃滿傷害
    /* 身體正中基礎 20；頭部爆擊最高約 33，讓命中位置真的有戰術差異。 */
    MAX_DAMAGE: 20,      // 身體單發最高傷害

    MAX_HP: 100,
    HEAL_AMOUNT: 30      // 補血道具一次回多少（約等於一發半的直接命中）
  };

  var SIDES = ['cat', 'dog'];
  var SIDE_LABEL = { cat: '貓咪', dog: '狗狗' };
  var AMMO_LABEL = { cat: '毛線球', dog: '骨頭' };
  var HIT_PART_LABEL = { head: '頭部', body: '身體', legs: '腿部' };

  /* -------------------------------------------------------------- 道具 */

  /**
   * 四種道具。開局雙方各拿一個，用完不再補充；一回合最多只能用一個，不能疊加。
   *
   *   kind = 'shot'：改變這一發的物理與傷害，還是要調角度力道發射。
   *   kind = 'heal'：不發射，按下去直接回血，然後把回合交給對手。
   *
   * 這裡放的是「相對於基礎值的倍率」，實際數字一律由 modOf() 算出來。
   * 前端顯示、AI 評估與伺服器結算都讀這一份，不會有人自己寫死一組。
   */
  var ITEMS = {
    double: {
      key: 'double', label: '雙擊', icon: '✌️', kind: 'shot',
      note: '用同一組角度與力道連丟兩發，落點一樣，傷害等於加倍。',
      shots: 2
    },
    bigbone: {
      key: 'bigbone', label: '大骨頭', icon: '🦴', kind: 'shot',
      note: '砲彈變大一圈，比較容易擦到對手，傷害也更高。',
      hitR: 1.4, damage: 1.5
    },
    stink: {
      key: 'stink', label: '臭彈', icon: '💣', kind: 'shot',
      note: '換成一顆臭氣炸彈，爆炸範圍大很多，沒正中也很痛。',
      blast: 1.55, core: 1.6, damage: 1.6
    },
    heal: {
      key: 'heal', label: '補血', icon: '💖', kind: 'heal',
      note: '立刻回復 ' + CONST.HEAL_AMOUNT + ' 點血，這一回合就換對手出手。',
      heal: CONST.HEAL_AMOUNT
    }
  };

  /* UI 與摘要的固定顯示順序，不依賴物件鍵的列舉順序 */
  var ITEM_ORDER = ['double', 'bigbone', 'stink', 'heal'];

  /** 開局背包：雙方完全對稱，每種各一個 */
  function startingItems() {
    return { double: 1, bigbone: 1, stink: 1, heal: 1 };
  }

  function cloneItems(bag) {
    var out = {};
    for (var i = 0; i < ITEM_ORDER.length; i++) {
      var k = ITEM_ORDER[i];
      out[k] = Math.max(0, Math.round(Number(bag && bag[k]) || 0));
    }
    return out;
  }

  /** 這一邊還剩幾個道具（含補血） */
  function itemCount(state, side) {
    var bag = state && state.items && state.items[side];
    var n = 0;
    for (var i = 0; i < ITEM_ORDER.length; i++) n += (bag && bag[ITEM_ORDER[i]]) || 0;
    return n;
  }

  function hasItem(state, side, key) {
    return !!(key && state && state.items && state.items[side] && state.items[side][key] > 0);
  }

  /**
   * 把道具換算成這一發實際要用的物理參數。
   * 傳 null / '' / 未知鍵值都會拿到「沒有道具」的基礎值，所以呼叫端不用先判斷。
   */
  function modOf(key) {
    var it = ITEMS[key];
    var m = {
      key: (it && it.kind === 'shot') ? it.key : null,
      shots: 1,
      hitR: CONST.HIT_R,
      blastR: CONST.BLAST_R,
      coreR: CONST.CORE_R,
      maxDamage: CONST.MAX_DAMAGE,
      scale: 1              // 畫面上砲彈的視覺放大倍率
    };
    if (!it || it.kind !== 'shot') return m;
    if (it.shots) m.shots = it.shots;
    if (it.hitR) { m.hitR = Math.round(CONST.HIT_R * it.hitR); m.scale = it.hitR; }
    if (it.blast) { m.blastR = Math.round(CONST.BLAST_R * it.blast); m.scale = Math.max(m.scale, 1.25); }
    if (it.core) m.coreR = Math.round(CONST.CORE_R * it.core);
    if (it.damage) m.maxDamage = Math.round(CONST.MAX_DAMAGE * it.damage);
    return m;
  }

  function itemLabel(key) { return ITEMS[key] ? ITEMS[key].label : ''; }

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

    /* 兩側落腳平台：讓貓狗站在平坦處，第一發不會被自家腳邊的小丘擋掉。
     * 兩邊一律壓成「同一個高度」，誰都不會因為地形抽到高地而佔便宜 ——
     * 地形固定不變，這個公平性整局都成立。 */
    var catCol = Math.round(colAt(WORLD.W * 0.10));
    var dogCol = Math.round(colAt(WORLD.W * 0.90));
    var level = (ground[clamp(catCol, 0, WORLD.COLS - 1)] + ground[clamp(dogCol, 0, WORLD.COLS - 1)]) / 2;
    flatten(ground, catCol, 6, level);
    flatten(ground, dogCol, 6, level);

    /* 中央柵欄：貓狗大戰的招牌。高度要相對於「貓狗實際站的高度」來算，
     * 才能保證每一張圖的柵欄都真的擋得住平射；太低就沒有拋物線的樂趣，
     * 太高又變成怎麼打都過不去。 */
    var standY = level + CONST.STAND_H;
    var wallH = standY + 64 + rng() * 46;
    var wallCol = Math.round(WORLD.COLS / 2);
    var wallHalf = 3;                       // ±3 欄 ≈ 52 單位寬
    for (var w = wallCol - wallHalf; w <= wallCol + wallHalf; w++) {
      if (w >= 0 && w < WORLD.COLS) ground[w] = Math.max(ground[w], wallH);
    }
    return ground;
  }

  /** 把 centerCol 前後 half 欄壓平；不指定高度就用中心那一欄的高度 */
  function flatten(ground, centerCol, half, height) {
    var c = clamp(centerCol, 0, ground.length - 1);
    var h = (height === undefined) ? ground[c] : height;
    for (var i = c - half; i <= c + half; i++) {
      if (i >= 0 && i < ground.length) ground[i] = h;
    }
  }

  /* ------------------------------------------------------------ 體力係數 */

  /**
   * 這一邊現在的出力比例：滿血 1.0，血量歸零 WEAK_MIN，中間線性。
   * 純粹由血量算出來，沒有亂數，所以可重現、可被 AI 正確預測。
   */
  function powerFactor(state, side) {
    var f = state && state.fighters && state.fighters[side];
    if (!f) return 1;
    var maxHp = state.maxHp || CONST.MAX_HP;
    var ratio = clamp((f.hp || 0) / maxHp, 0, 1);
    return CONST.WEAK_MIN + (1 - CONST.WEAK_MIN) * ratio;
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
   * @param {object} [opts.items]     開局背包；不給就雙方各拿每種道具一個
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
        cat: { side: 'cat', x: catX, y: groundAt(ground, catX) + CONST.STAND_H, hp: hp, dir: 1, mood: 'idle' },
        dog: { side: 'dog', x: dogX, y: groundAt(ground, dogX) + CONST.STAND_H, hp: hp, dir: -1, mood: 'idle' }
      },
      /* 道具背包：開局雙方對稱，用完不補 */
      items: {
        cat: cloneItems(o.items && o.items.cat ? o.items.cat : startingItems()),
        dog: cloneItems(o.items && o.items.dog ? o.items.dog : startingItems())
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
      items: { cat: cloneItems(state.items && state.items.cat), dog: cloneItems(state.items && state.items.dog) },
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
  function legalShot(state, side, angle, power, item) {
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
    if (item) {
      var it = ITEMS[item];
      if (!it) return { ok: false, reason: '沒有這種道具。' };
      if (it.kind !== 'shot') return { ok: false, reason: it.label + '不是用發射的，直接按下去就會生效。' };
      if (!hasItem(state, side, item)) return { ok: false, reason: it.label + '已經用完了。' };
    }
    return { ok: true, reason: '' };
  }

  /** 列出目前可以做的事，給 UI 的「合法操作」提示與 AI 的行動空間用 */
  function legalActions(state, side) {
    if (!state || state.over || state.turn !== side) return [];
    var bag = (state.items && state.items[side]) || {};
    var acts = [{
      type: 'fire',
      angle: { min: CONST.MIN_ANGLE, max: CONST.MAX_ANGLE, step: 1 },
      power: { min: CONST.MIN_POWER, max: CONST.MAX_POWER, step: 1 },
      /* 這一發最多搭配一個道具，不能疊加；null 代表不用道具 */
      items: ITEM_ORDER.filter(function (k) { return ITEMS[k].kind === 'shot' && bag[k] > 0; })
    }];
    if (bag.heal > 0) acts.push({ type: 'heal', item: 'heal', amount: CONST.HEAL_AMOUNT });
    acts.push({ type: 'pass' });   // 回合逾時時伺服器會替玩家放棄該回合
    return acts;
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
   * @param {string}  [opts.item]     搭配的道具鍵值（大骨頭會放大命中判定）
   * @param {object}  [opts.mod]      已經算好的 modOf() 結果；給就直接用，省一次計算
   * @returns {{ points:Array, impact:object, flightTime:number, apex:number }}
   */
  function simulate(state, side, angle, power, opts) {
    var o = opts || {};
    var me = state.fighters[side];
    var foe = state.fighters[other(side)];
    var dir = me.dir;
    var rad = clamp(angle, CONST.MIN_ANGLE, CONST.MAX_ANGLE) * Math.PI / 180;
    var speed = clamp(power, CONST.MIN_POWER, CONST.MAX_POWER) * CONST.POWER_SCALE * powerFactor(state, side);
    var wind = (o.wind === undefined || o.wind === null) ? state.wind : Number(o.wind);
    var trace = o.trace !== false;
    var mod = o.mod || modOf(o.item);

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
      if (hits(x, y, foe, mod.hitR)) { impact = { x: x, y: y, type: 'fighter', target: foe.side }; break; }
      /* 打到自己（自爆）；剛出膛的幾步不判定 */
      if (i > CONST.SELF_SAFE_STEPS && hits(x, y, me, mod.hitR)) {
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

  function hits(x, y, fighter, hitR) {
    var r = hitR || CONST.HIT_R;
    var dir = fighter.dir || 1;
    var body = ellipseContains(x, y, fighter.x - dir * 4, fighter.y + CONST.BODY_H, r, r * 0.72);
    var head = circleContains(x, y, fighter.x + dir * 32, fighter.y + 60, r * 0.72);
    var legs = ellipseContains(x, y, fighter.x - dir, fighter.y + 13, r * 0.78, r * 0.48);
    return body || head || legs;
  }

  function circleContains(x, y, cx, cy, r) {
    var dx = x - cx;
    var dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }

  function ellipseContains(x, y, cx, cy, rx, ry) {
    var dx = (x - cx) / rx;
    var dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function hitPartAt(impactY, fighter) {
    var localY = impactY - fighter.y;
    if (localY >= CONST.HEAD_Y_MIN) return 'head';
    if (localY <= CONST.LEG_Y_MAX) return 'legs';
    return 'body';
  }

  function partMultiplier(part) {
    if (part === 'head') return CONST.HEAD_DAMAGE_MULTIPLIER;
    if (part === 'legs') return CONST.LEG_DAMAGE_MULTIPLIER;
    return 1;
  }

  /**
   * 爆炸傷害：核心範圍吃滿，之後線性遞減到 0。
   * 不給 mod 就是沒帶道具的基礎值，所以舊的兩參數呼叫方式仍然成立。
   */
  function damageAt(impactX, impactY, fighter, mod) {
    var m = mod || modOf(null);
    var dx = impactX - fighter.x;
    var dy = impactY - (fighter.y + CONST.BODY_H);
    var d = Math.sqrt(dx * dx + dy * dy);
    var part = hitPartAt(impactY, fighter);
    var critical = part === 'head';
    var partMax = Math.round(m.maxDamage * partMultiplier(part));
    if (d >= m.blastR) return { damage: 0, distance: round2(d), part: part, critical: false };
    if (d <= m.coreR) return { damage: partMax, distance: round2(d), part: part, critical: critical };
    var f = 1 - (d - m.coreR) / (m.blastR - m.coreR);
    return {
      damage: Math.max(1, Math.round(partMax * f)),
      distance: round2(d),
      part: part,
      critical: critical
    };
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
    /* 認不得的道具鍵值一律當作沒帶道具，不讓它變成擋住出手的錯誤 */
    var item = (action && action.item && ITEMS[action.item]) ? action.item : null;
    var legal = legalShot(state, side, angle, power, item);
    if (!legal.ok) return { ok: false, reason: legal.reason };

    angle = Math.round(angle * 10) / 10;
    power = Math.round(power * 10) / 10;

    var mod = modOf(item);
    var foeSide = other(side);
    var next = cloneState(state);
    if (item) next.items[side][item] = Math.max(0, next.items[side][item] - 1);

    var total = { cat: 0, dog: 0 };
    var volley = [];
    var nearest = null;
    var anyDirect = false;
    var hitParts = { cat: null, dog: null };
    var critical = false;

    /* 雙擊會跑兩趟。地形不會被炸壞、貓狗也不會移動，所以第二發是完全相同的
     * 彈道與落點 —— 效果就是這一回合的傷害直接加倍。 */
    for (var k = 0; k < mod.shots; k++) {
      /* 第一發就把人打趴的話，第二發不用再丟了 */
      if (next.fighters.cat.hp <= 0 || next.fighters.dog.hp <= 0) break;

      var sim = simulate(next, side, angle, power, { trace: true, mod: mod });
      var dmg = { cat: 0, dog: 0 };
      var volleyParts = { cat: null, dog: null };
      var volleyCritical = false;
      var dist = null;

      if (sim.impact.type === 'fighter') {
        /* 直接命中：依頭／身體／腿部決定傷害，旁邊的另一位照爆炸範圍算 */
        var direct = sim.impact.target;
        var directHit = damageAt(sim.impact.x, sim.impact.y, next.fighters[direct], mod);
        dmg[direct] = directHit.damage;
        if (directHit.damage > 0) {
          volleyParts[direct] = directHit.part;
          volleyCritical = volleyCritical || directHit.critical;
        }
        var bystander = other(direct);
        var bystanderHit = damageAt(sim.impact.x, sim.impact.y, next.fighters[bystander], mod);
        dmg[bystander] = bystanderHit.damage;
        if (bystanderHit.damage > 0) {
          volleyParts[bystander] = bystanderHit.part;
          volleyCritical = volleyCritical || bystanderHit.critical;
        }
        dist = 0;
        if (direct === foeSide) anyDirect = true;
      } else if (sim.impact.type === 'ground') {
        var dc = damageAt(sim.impact.x, sim.impact.y, next.fighters.cat, mod);
        var dd = damageAt(sim.impact.x, sim.impact.y, next.fighters.dog, mod);
        dmg.cat = dc.damage;
        dmg.dog = dd.damage;
        if (dc.damage > 0) {
          volleyParts.cat = dc.part;
          volleyCritical = volleyCritical || dc.critical;
        }
        if (dd.damage > 0) {
          volleyParts.dog = dd.part;
          volleyCritical = volleyCritical || dd.critical;
        }
        dist = (side === 'cat') ? dd.distance : dc.distance;
      }
      /* 飛出界或逾時：什麼都沒發生 */

      next.fighters.cat.hp = Math.max(0, next.fighters.cat.hp - dmg.cat);
      next.fighters.dog.hp = Math.max(0, next.fighters.dog.hp - dmg.dog);

      total.cat += dmg.cat;
      total.dog += dmg.dog;
      if (volleyParts.cat) hitParts.cat = hitParts.cat || volleyParts.cat;
      if (volleyParts.dog) hitParts.dog = hitParts.dog || volleyParts.dog;
      critical = critical || volleyCritical;
      if (dist !== null && (nearest === null || dist < nearest)) nearest = dist;

      volley.push({
        points: sim.points,
        impact: sim.impact,
        damage: dmg,
        hitParts: volleyParts,
        critical: volleyCritical,
        distance: dist,
        flightTime: sim.flightTime,
        apex: sim.apex
      });
    }

    var last = volley[volley.length - 1] || { impact: null, points: [], flightTime: 0, apex: 0 };
    var foeDamage = total[foeSide];
    var selfDamage = total[side];
    var result;
    if (anyDirect) result = 'direct';
    else if (foeDamage > 0 && selfDamage > 0) result = 'both';
    else if (foeDamage > 0) result = 'splash';
    else if (selfDamage > 0) result = 'self';
    else if (last.impact && last.impact.type === 'out') result = 'out';
    else if (last.impact && last.impact.type === 'timeout') result = 'timeout';
    else result = 'miss';

    next.fighters[foeSide].mood = foeDamage > 0 ? 'hurt' : 'idle';
    next.fighters[side].mood = selfDamage > 0 ? 'hurt' : (foeDamage > 0 ? 'happy' : 'idle');

    var shot = {
      n: state.turnNo,
      side: side,
      angle: angle,
      power: power,
      wind: state.wind,
      item: item,
      result: result,
      damage: { cat: total.cat, dog: total.dog },
      hitParts: hitParts,
      hitPart: hitParts[foeSide],
      critical: critical,
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: nearest,
      /* volley 是這一回合實際飛出去的每一發：一般 1 發，雙擊 2 發。
       * impact / points 指向最後一發，讓只認得單發的舊呼叫端仍然能用。 */
      volley: volley,
      impact: last.impact,
      points: last.points,
      flightTime: last.flightTime,
      apex: last.apex,
      itemsAfter: cloneItems(next.items[side])
    };

    next.lastShot = {
      n: shot.n, side: shot.side, angle: shot.angle, power: shot.power, item: item,
      result: shot.result, damage: shot.damage, hitParts: shot.hitParts, hitPart: shot.hitPart,
      critical: shot.critical, distance: shot.distance, impact: shot.impact
    };
    next.version = state.version + 1;

    /* 勝負判定：只要血量歸零就結束，沒有總回合上限。 */
    var catDown = next.fighters.cat.hp <= 0;
    var dogDown = next.fighters.dog.hp <= 0;
    if (catDown && dogDown) {
      next.over = true; next.winner = 'draw'; next.reason = '兩邊同時被打趴，平手！';
    } else if (catDown) {
      next.over = true; next.winner = 'dog'; next.reason = '貓咪血量歸零，狗狗獲勝！';
    } else if (dogDown) {
      next.over = true; next.winner = 'cat'; next.reason = '狗狗血量歸零，貓咪獲勝！';
    } else {
      advanceTurn(next, state);
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
      item: null, result: 'pass', damage: { cat: 0, dog: 0 },
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: null, impact: null, points: [], volley: [], flightTime: 0, apex: 0,
      note: reason || '時間到，這一回合跳過。'
    };
    next.lastShot = { n: shot.n, side: side, angle: null, power: null, item: null, result: 'pass', damage: shot.damage, distance: null, impact: null };
    next.version = state.version + 1;
    advanceTurn(next, state);
    return { ok: true, state: next, shot: shot };
  }

  /** 主動投降：不論目前輪到誰，參賽者都可以結束這一局。 */
  function applySurrender(state, side, reason) {
    if (!state) return { ok: false, reason: '目前沒有進行中的對局。' };
    if (state.over) return { ok: false, reason: '這一局已經結束了。' };
    if (side !== 'cat' && side !== 'dog') return { ok: false, reason: '不是這場對局的參賽者，無法投降。' };

    var winner = other(side);
    var next = cloneState(state);
    var note = reason || (SIDE_LABEL[side] + '主動投降。');
    var shot = {
      n: state.turnNo, side: side, angle: null, power: null, wind: state.wind,
      item: null, result: 'surrender', damage: { cat: 0, dog: 0 },
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: null, impact: null, points: [], volley: [], flightTime: 0, apex: 0,
      note: note
    };
    next.lastShot = {
      n: shot.n, side: side, angle: null, power: null, item: null,
      result: 'surrender', damage: shot.damage, distance: null, impact: null
    };
    next.over = true;
    next.winner = winner;
    next.reason = note + ' ' + SIDE_LABEL[winner] + '獲勝！';
    next.version = state.version + 1;
    next.fighters.cat.mood = winner === 'cat' ? 'win' : 'lose';
    next.fighters.dog.mood = winner === 'dog' ? 'win' : 'lose';
    return { ok: true, state: next, shot: shot };
  }

  /**
   * 使用補血道具。不發射砲彈：回血之後這一回合就直接交給對手。
   * 回傳形狀跟 applyShot 一樣，摘要、版本號與動畫層才不用另外開一條分支。
   */
  function applyHeal(state, side) {
    if (!state) return { ok: false, reason: '目前沒有進行中的對局。' };
    if (state.over) return { ok: false, reason: '這一局已經結束了，請按「再來一局」。' };
    if (side !== 'cat' && side !== 'dog') return { ok: false, reason: '不是這場對局的參賽者，無法使用道具。' };
    if (state.turn !== side) {
      return { ok: false, reason: '現在輪到' + SIDE_LABEL[state.turn] + '，等對手出手後才能用補血。' };
    }
    if (!hasItem(state, side, 'heal')) return { ok: false, reason: '補血已經用完了。' };

    var next = cloneState(state);
    next.items[side].heal -= 1;

    var before = next.fighters[side].hp;
    var healed = Math.min(state.maxHp, before + CONST.HEAL_AMOUNT);
    var gain = healed - before;
    next.fighters[side].hp = healed;
    next.fighters[side].mood = gain > 0 ? 'happy' : 'idle';
    next.fighters[other(side)].mood = 'idle';

    var shot = {
      n: state.turnNo, side: side, angle: null, power: null, wind: state.wind,
      item: 'heal', result: 'heal',
      damage: { cat: 0, dog: 0 },
      heal: gain,
      hpAfter: { cat: next.fighters.cat.hp, dog: next.fighters.dog.hp },
      distance: null, impact: null, points: [], volley: [], flightTime: 0, apex: 0,
      itemsAfter: cloneItems(next.items[side]),
      note: gain > 0 ? ('回復了 ' + gain + ' 點血。') : '血量本來就是滿的，只用掉了道具。'
    };
    next.lastShot = {
      n: shot.n, side: side, angle: null, power: null, item: 'heal',
      result: 'heal', damage: shot.damage, distance: null, impact: null
    };
    next.version = state.version + 1;
    advanceTurn(next, state);
    return { ok: true, state: next, shot: shot };
  }

  /** 換手：回合數 +1、換邊、重抽風；對局只在血量歸零或投降時結束。 */
  function advanceTurn(next, state) {
    next.turnNo = state.turnNo + 1;
    next.turn = other(state.turn);
    next.wind = windFor(state.seed, next.turnNo);
    return next;
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
      items: { cat: cloneItems(state.items && state.items.cat), dog: cloneItems(state.items && state.items.dog) },
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
      items: { cat: cloneItems(pub.items && pub.items.cat), dog: cloneItems(pub.items && pub.items.dog) },
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
    miss: '沒打中',
    out: '飛出畫面外了',
    timeout: '砲彈不知道飛去哪了',
    pass: '這回合跳過',
    heal: '補了一口血',
    surrender: '主動投降，對手獲勝'
  };

  /** 把一發的結果轉成一行中文摘要，前端與伺服器共用同一種說法 */
  function describeShot(shot) {
    if (!shot) return '';
    var who = SIDE_LABEL[shot.side];
    if (shot.result === 'pass') return '第 ' + shot.n + ' 回合 ' + who + '：' + (shot.note || RESULT_TEXT.pass);
    if (shot.result === 'surrender') return '第 ' + shot.n + ' 回合 ' + who + '：' + (shot.note || RESULT_TEXT.surrender);
    if (shot.result === 'heal') {
      return '第 ' + shot.n + ' 回合 ' + who + '：用了 ' + ITEMS.heal.icon + ' 補血 → ' +
        (shot.note || RESULT_TEXT.heal) + '（血量 ' + shot.hpAfter[shot.side] + '）';
    }
    var foe = other(shot.side);
    var used = ITEMS[shot.item] ? ('、道具 ' + ITEMS[shot.item].icon + ' ' + ITEMS[shot.item].label) : '';
    var hitPart = shot.hitPart || (shot.hitParts && shot.hitParts[foe]);
    var hitNote = hitPart ? ((HIT_PART_LABEL[hitPart] || '部位') + '命中') : '';
    if (shot.critical) hitNote = '💥 爆擊！' + (hitNote ? ' ' + hitNote : '');
    var head = '第 ' + shot.n + ' 回合 ' + who + '：' +
      (hitNote ? hitNote + '、' : '') + '力道 ' + shot.power +
      '、風 ' + describeWind(shot.wind) + used;
    var tail = RESULT_TEXT[shot.result] || '';
    if (shot.item === 'double' && shot.volley && shot.volley.length > 1) tail = '連丟兩發，' + tail;
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
    HIT_PART_LABEL: HIT_PART_LABEL,
    RESULT_TEXT: RESULT_TEXT,
    ITEMS: ITEMS,
    ITEM_ORDER: ITEM_ORDER,

    other: other,
    clamp: clamp,
    colAt: colAt,
    groundAt: groundAt,
    makeTerrain: makeTerrain,
    windFor: windFor,
    powerFactor: powerFactor,

    createState: createState,
    cloneState: cloneState,
    legalShot: legalShot,
    legalActions: legalActions,
    simulate: simulate,
    damageAt: damageAt,
    hitPartAt: hitPartAt,
    applyShot: applyShot,
    applyPass: applyPass,
    applySurrender: applySurrender,
    applyHeal: applyHeal,

    startingItems: startingItems,
    cloneItems: cloneItems,
    itemCount: itemCount,
    hasItem: hasItem,
    modOf: modOf,
    itemLabel: itemLabel,

    toPublic: toPublic,
    fromPublic: fromPublic,
    describeShot: describeShot,
    describeWind: describeWind
  };
}));
