/* ===== ai.js — 三段電腦對手 =====
 *
 * 三個難度用的是「完全一樣的規則與物理」：都呼叫 Rules.simulate 試算，
 * 都只能送出 Rules.legalShot 認可的角度與力道。沒有任何一段程式會偷看
 * 隱藏資訊、修改傷害或無視風向 —— 這個遊戲本來就沒有隱藏資訊。
 *
 * 難度差異來自三件可以被觀察到的事：
 *
 *   1. 搜尋預算：簡單完全不試算（只用真空拋物線公式），普通粗略掃一遍，
 *      困難掃得細並做兩輪局部收斂。
 *   2. 風向認知：簡單當作沒有風，普通只補償約六成，困難完整補償。
 *      這是「模型比較差」，不是作弊 —— 風力是雙方都看得到的公開資訊。
 *   3. 瞄準誤差：出手前再加一個隨機抖動，簡單抖很大、困難幾乎不抖。
 *
 * 所有隨機都吃外部注入的 rng，所以固定種子的情境可以重現、可以測試。
 */
(function (root, factory) {
  'use strict';
  var isNode = (typeof module === 'object' && module.exports);
  var Rules = isNode ? require('./rules.js') : root.Rules;
  var RNG = isNode ? require('./rng.js') : root.RNG;
  var api = factory(Rules, RNG);
  if (isNode) module.exports = api;
  root.AI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Rules, RNG) {
  'use strict';

  var C = Rules.CONST;

  var LEVELS = {
    easy: {
      key: 'easy',
      label: '簡單',
      /* 給玩家看的說明：必須跟實際行為一致 */
      note: '不會試算彈道，直接用課本公式抓力道，而且完全不看風向，誤差很大。',
      windBelief: 0,        // 相信「沒有風」
      search: 'formula',
      angleJitter: 9,       // 出手前的角度抖動（度，± 範圍）
      powerJitter: 12,      // 力道抖動
      thinkMs: 700
    },
    normal: {
      key: 'normal',
      label: '普通',
      note: '會粗略試算幾十種角度與力道，也會補償一部分風力，偶爾會失手。',
      windBelief: 0.55,     // 只補償 55% 的風
      search: 'coarse',
      angleJitter: 4,
      powerJitter: 5,
      thinkMs: 1000
    },
    hard: {
      key: 'hard',
      label: '困難',
      note: '用跟你完全相同的物理引擎試算數百種組合，完整補償風向，幾乎每發都很接近。',
      windBelief: 1,        // 完整補償
      search: 'fine',
      angleJitter: 1.5,
      powerJitter: 2,
      thinkMs: 1300
    }
  };

  function levelOf(name) { return LEVELS[name] || LEVELS.normal; }

  function clampAngle(a) { return Rules.clamp(a, C.MIN_ANGLE, C.MAX_ANGLE); }
  function clampPower(p) { return Rules.clamp(p, C.MIN_POWER, C.MAX_POWER); }

  /**
   * 一個候選射擊有多好：越小越好。
   * 分數 = 落點離對手的距離 － 命中獎勵 ＋ 自爆懲罰。
   */
  function scoreShot(state, side, angle, power, believedWind) {
    var foe = Rules.other(side);
    var sim = Rules.simulate(state, side, angle, power, { wind: believedWind, trace: false });
    var imp = sim.impact;

    if (imp.type === 'out' || imp.type === 'timeout') return { score: 4000, sim: sim };

    var target = state.fighters[foe];
    var dx = imp.x - target.x;
    var dy = imp.y - (target.y + C.BODY_H);
    var dist = Math.sqrt(dx * dx + dy * dy);

    var score = dist;
    if (imp.type === 'fighter' && imp.target === foe) score -= 400;      // 直接命中大加分
    if (imp.type === 'fighter' && imp.target === side) score += 2000;    // 自爆重罰

    var me = state.fighters[side];
    var sdx = imp.x - me.x, sdy = imp.y - (me.y + C.BODY_H);
    var selfDist = Math.sqrt(sdx * sdx + sdy * sdy);
    if (selfDist < C.BLAST_R) score += (C.BLAST_R - selfDist) * 3;       // 落在自己腳邊也不好

    return { score: score, sim: sim, distance: dist };
  }

  /** 真空拋物線公式：忽略風、忽略高低差，算出打到指定水平距離所需的力道 */
  function powerForRange(range, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    var s = Math.sin(2 * rad);
    if (s <= 0.02) return C.MAX_POWER;
    var v = Math.sqrt(Math.abs(range) * C.GRAVITY / s);
    return clampPower(v / C.POWER_SCALE);
  }

  /* --------------------------------------------------------- 搜尋策略 */

  /** 簡單：完全不試算，用公式抓一組就送出 */
  function planFormula(state, side, rng) {
    var me = state.fighters[side];
    var foe = state.fighters[Rules.other(side)];
    var range = Math.abs(foe.x - me.x);
    var angle = 38 + rng() * 18;                 // 38° ~ 56° 之間隨便挑
    return { angle: clampAngle(angle), power: powerForRange(range, angle), sims: 0 };
  }

  /** 普通：角度、力道各掃一遍粗網格，再做一輪小幅收斂 */
  function planCoarse(state, side, wind) {
    var best = null, sims = 0;
    for (var a = 20; a <= 80; a += 10) {
      for (var p = 30; p <= C.MAX_POWER; p += 10) {
        var r = scoreShot(state, side, a, p, wind); sims++;
        if (!best || r.score < best.score) best = { score: r.score, angle: a, power: p };
      }
    }
    var refined = refine(state, side, wind, best, 5, 5, 2.5, 2.5);
    return { angle: refined.angle, power: refined.power, sims: sims + refined.sims };
  }

  /** 困難：細網格 + 兩輪局部收斂 */
  function planFine(state, side, wind) {
    var best = null, sims = 0;
    for (var a = 15; a <= 85; a += 5) {
      for (var p = 25; p <= C.MAX_POWER; p += 5) {
        var r = scoreShot(state, side, a, p, wind); sims++;
        if (!best || r.score < best.score) best = { score: r.score, angle: a, power: p };
      }
    }
    var pass1 = refine(state, side, wind, best, 5, 5, 1, 1);
    var pass2 = refine(state, side, wind, pass1, 1.2, 1.2, 0.3, 0.3);
    return { angle: pass2.angle, power: pass2.power, sims: sims + pass1.sims + pass2.sims };
  }

  /** 在 best 附近再掃一圈更細的網格 */
  function refine(state, side, wind, best, aSpan, pSpan, aStep, pStep) {
    var out = { score: best.score, angle: best.angle, power: best.power, sims: 0 };
    for (var a = best.angle - aSpan; a <= best.angle + aSpan + 1e-9; a += aStep) {
      var ca = clampAngle(a);
      for (var p = best.power - pSpan; p <= best.power + pSpan + 1e-9; p += pStep) {
        var cp = clampPower(p);
        var r = scoreShot(state, side, ca, cp, wind); out.sims++;
        if (r.score < out.score) { out.score = r.score; out.angle = ca; out.power = cp; }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- 對外 */

  /**
   * 選一發要打的角度與力道。
   *
   * @param {object} state  Rules 的對局狀態
   * @param {'cat'|'dog'} side  AI 控制哪一邊
   * @param {string} levelName  'easy' | 'normal' | 'hard'
   * @param {function} [rng]    可注入亂數；不給就用 Math.random
   * @returns {{ angle:number, power:number, level:string, sims:number, thinkMs:number, elapsedMs:number }}
   */
  function chooseShot(state, side, levelName, rng) {
    var lv = levelOf(levelName);
    var next = rng || Math.random;
    var t0 = (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();

    /* AI 心裡「以為」的風：這是它的模型限制，不是偷看到的額外資訊 */
    var believedWind = Rules.clamp(state.wind * lv.windBelief, -C.WIND_MAX, C.WIND_MAX);

    var plan;
    if (lv.search === 'formula') plan = planFormula(state, side, next);
    else if (lv.search === 'coarse') plan = planCoarse(state, side, believedWind);
    else plan = planFine(state, side, believedWind);

    /* 瞄準誤差：手抖，不是作弊 */
    var angle = clampAngle(plan.angle + RNG.symmetric(next) * lv.angleJitter);
    var power = clampPower(plan.power + RNG.symmetric(next) * lv.powerJitter);

    angle = Math.round(angle * 10) / 10;
    power = Math.round(power * 10) / 10;

    var t1 = (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
    var out = {
      angle: angle,
      power: power,
      level: lv.key,
      sims: plan.sims,
      thinkMs: lv.thinkMs,
      elapsedMs: Math.round(t1 - t0)
    };

    /* 保險：萬一有數值意外，退回一組一定合法的值，AI 絕不送非法行動 */
    var legal = Rules.legalShot(state, side, out.angle, out.power);
    if (!legal.ok) {
      out.angle = 45;
      out.power = 60;
      out.fallback = legal.reason;
    }
    return out;
  }

  /** AI 這一發最後落在哪裡（測試與難度比較用；不參與實際出手） */
  function previewShot(state, side, shot) {
    return Rules.simulate(state, side, shot.angle, shot.power, { trace: false });
  }

  /** 這一發離對手多遠（測試量化難度差異用） */
  function missDistance(state, side, shot) {
    var sim = previewShot(state, side, shot);
    var foe = state.fighters[Rules.other(side)];
    if (sim.impact.type === 'out' || sim.impact.type === 'timeout') return 1200;
    var dx = sim.impact.x - foe.x;
    var dy = sim.impact.y - (foe.y + C.BODY_H);
    return Math.sqrt(dx * dx + dy * dy);
  }

  return {
    LEVELS: LEVELS,
    levelOf: levelOf,
    chooseShot: chooseShot,
    previewShot: previewShot,
    missDistance: missDistance,
    powerForRange: powerForRange
  };
}));
