/*
 * tests/verify.js — 貓狗大戰的規則、AI、房間狀態機與設定解析測試
 *
 * 只用 Node 內建的 assert，不需要測試框架。
 *   node tests/verify.js
 *
 * 涵蓋範圍
 *   1. 種子亂數與地形：可重現、圍牆存在、落腳平台是平的
 *   2. 物理：確定性、力道與射程單調、風把砲彈吹歪、45° 附近射程最遠
 *   3. 合法性：角度／力道邊界、不是自己的回合、結束後不能再打
 *   4. 傷害與勝負：直接命中、爆炸衰減、自爆、血量歸零、主動投降
 *   5. 地形破壞：坑洞會讓地面變低，角色會落到新地面上
 *   6. AI：只送合法行動、三段難度的落點誤差有明顯差異、耗時可接受
 *   7. 房間狀態機：完整生命週期、席位衝突、觀戰權限、邀請 token、斷線回收
 *   8. config.js 的 server URL 解析規則
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const RNG = require('../public/js/rng.js');
const { RoomStore, sanitizeText } = require('../lib/rooms.js');

const C = Rules.CONST;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log('  ✗ ' + name);
    console.log('      ' + (e && e.message ? e.message : e));
  }
}

function group(title) {
  console.log('\n' + title);
}

/* ============================================================ 1. 種子與地形 */

group('1. 種子亂數與地形生成');

test('同一個種子產生完全相同的亂數序列', () => {
  const a = RNG.createRng('ABCDEF');
  const b = RNG.createRng('ABCDEF');
  for (let i = 0; i < 50; i++) assert.strictEqual(a(), b(), '第 ' + i + ' 個值不同');
});

test('不同種子產生不同序列', () => {
  const a = RNG.createRng('AAAAAA');
  const b = RNG.createRng('BBBBBB');
  let same = 0;
  for (let i = 0; i < 30; i++) if (a() === b()) same += 1;
  assert.ok(same < 3, '兩個種子的序列太像了');
});

test('種子正規化只留合法字元並轉大寫', () => {
  assert.strictEqual(RNG.normalizeSeed('ab-c d1I0O'), 'ABCD');
  assert.strictEqual(RNG.normalizeSeed(''), '');
  assert.ok(RNG.normalizeSeed('ABCDEFGHIJKLMNOPQRSTUVWXYZ').length <= RNG.SEED_MAX);
});

test('同一個種子產生同一張地形', () => {
  const a = Rules.makeTerrain('SEEDAA');
  const b = Rules.makeTerrain('SEEDAA');
  assert.deepStrictEqual(a, b);
});

test('地形中央有一道明顯高於兩側的圍牆', () => {
  for (const seed of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
    const g = Rules.makeTerrain(seed);
    const mid = g[Math.round(Rules.WORLD.COLS / 2)];
    const left = g[Math.round(Rules.WORLD.COLS * 0.25)];
    const right = g[Math.round(Rules.WORLD.COLS * 0.75)];
    assert.ok(mid > left + 40, seed + '：圍牆沒有明顯高於左側（' + mid + ' vs ' + left + '）');
    assert.ok(mid > right + 40, seed + '：圍牆沒有明顯高於右側');
  }
});

test('貓狗腳下的平台是平的', () => {
  const st = Rules.createState({ seed: 'FLATTT' });
  for (const side of ['cat', 'dog']) {
    const f = st.fighters[side];
    const col = Math.round(Rules.colAt(f.x));
    for (let i = col - 4; i <= col + 4; i++) {
      assert.strictEqual(st.ground[i], st.ground[col], side + ' 平台第 ' + i + ' 欄不平');
    }
  }
});

test('風向由種子與回合數決定，可重現且在範圍內', () => {
  for (let turn = 1; turn <= 20; turn++) {
    const a = Rules.windFor('WINDAA', turn);
    const b = Rules.windFor('WINDAA', turn);
    assert.strictEqual(a, b);
    assert.ok(Math.abs(a) <= C.WIND_MAX, '風力超出範圍：' + a);
  }
  const series = [];
  for (let t = 1; t <= 10; t++) series.push(Rules.windFor('WINDAA', t));
  assert.ok(new Set(series).size >= 8, '不同回合的風應該會變化');
});

/* ============================================================ 2. 物理 */

group('2. 拋物線物理');

test('同一個狀態與同一組角度力道，模擬結果完全相同', () => {
  const st = Rules.createState({ seed: 'PHYSAA', first: 'cat' });
  const a = Rules.simulate(st, 'cat', 45, 70, { trace: true });
  const b = Rules.simulate(st, 'cat', 45, 70, { trace: true });
  assert.deepStrictEqual(a.impact, b.impact);
  assert.strictEqual(a.points.length, b.points.length);
  assert.strictEqual(a.flightTime, b.flightTime);
});

test('無風時力道越大飛越遠（同角度）', () => {
  const st = Rules.cloneState(Rules.createState({ seed: 'RANGEA', first: 'cat' }));
  st.wind = 0;
  let prev = -1;
  for (const p of [30, 40, 50, 60, 70]) {
    const sim = Rules.simulate(st, 'cat', 45, p, { trace: false });
    const dist = sim.impact.x - st.fighters.cat.x;
    assert.ok(dist > prev, '力道 ' + p + ' 沒有比前一個飛得遠（' + dist + ' <= ' + prev + '）');
    prev = dist;
  }
});

test('45 度附近射程最遠（無風、平地）', () => {
  const st = Rules.cloneState(Rules.createState({ seed: 'ANGLEA', first: 'cat' }));
  st.wind = 0;
  /* 把地形壓平，排除圍牆與丘陵干擾 */
  for (let i = 0; i < st.ground.length; i++) st.ground[i] = 100;
  st.fighters.cat.y = 100;
  st.fighters.dog.y = 100;
  st.fighters.dog.x = 1190;      // 移開，避免被打到提早結束
  let best = { angle: 0, dist: -1 };
  for (let a = 10; a <= 80; a += 5) {
    const sim = Rules.simulate(st, 'cat', a, 55, { trace: false });
    const dist = sim.impact.x - st.fighters.cat.x;
    if (dist > best.dist) best = { angle: a, dist };
  }
  assert.ok(Math.abs(best.angle - 45) <= 5, '最遠射程的角度應該接近 45°，實際是 ' + best.angle + '°');
});

test('順風打得比無風遠，逆風比較近', () => {
  const base = Rules.cloneState(Rules.createState({ seed: 'WINDBB', first: 'cat' }));
  for (let i = 0; i < base.ground.length; i++) base.ground[i] = 100;
  base.fighters.cat.y = 100;
  base.fighters.dog.x = 1190;
  base.fighters.dog.y = 100;

  const calm = Rules.simulate(base, 'cat', 45, 55, { wind: 0, trace: false }).impact.x;
  const tail = Rules.simulate(base, 'cat', 45, 55, { wind: 8, trace: false }).impact.x;
  const head = Rules.simulate(base, 'cat', 45, 55, { wind: -8, trace: false }).impact.x;
  assert.ok(tail > calm + 20, '順風應該明顯飛更遠（' + tail + ' vs ' + calm + '）');
  assert.ok(head < calm - 20, '逆風應該明顯飛更近（' + head + ' vs ' + calm + '）');
});

test('力道太小會打在自己腳邊（不會飛出去）', () => {
  const st = Rules.createState({ seed: 'WEAKAA', first: 'cat' });
  const sim = Rules.simulate(st, 'cat', 45, C.MIN_POWER, { wind: 0, trace: false });
  assert.ok(sim.impact.x - st.fighters.cat.x < 200, '最小力道不應該飛太遠');
});

test('滿力可以打到對面（射程涵蓋整張地圖）', () => {
  const st = Rules.cloneState(Rules.createState({ seed: 'FARAAA', first: 'cat' }));
  st.wind = 0;
  const sim = Rules.simulate(st, 'cat', 45, C.MAX_POWER, { trace: false });
  assert.ok(sim.impact.x >= st.fighters.dog.x - 40 || sim.impact.type === 'out',
    '滿力 45° 應該要能打到對面附近，實際落在 ' + sim.impact.x);
});

test('狗狗往左打、貓咪往右打（方向正確）', () => {
  const st = Rules.createState({ seed: 'DIRAAA', first: 'cat' });
  const catShot = Rules.simulate(st, 'cat', 45, 50, { wind: 0, trace: false });
  const dogShot = Rules.simulate(st, 'dog', 45, 50, { wind: 0, trace: false });
  assert.ok(catShot.impact.x > st.fighters.cat.x, '貓的砲彈應該往右飛');
  assert.ok(dogShot.impact.x < st.fighters.dog.x, '狗的砲彈應該往左飛');
});

/* ============================================================ 3. 合法性 */

group('3. 行動合法性');

test('角度與力道超出範圍會被擋下並回傳可讀原因', () => {
  const st = Rules.createState({ seed: 'LEGALA', first: 'cat' });
  const bad = [
    [-1, 50], [90, 50], [NaN, 50], [45, C.MIN_POWER - 1], [45, C.MAX_POWER + 1], [45, NaN]
  ];
  for (const [a, p] of bad) {
    const r = Rules.legalShot(st, 'cat', a, p);
    assert.strictEqual(r.ok, false, '角度 ' + a + ' 力道 ' + p + ' 應該非法');
    assert.ok(r.reason.length > 4, '非法原因要有可讀說明');
  }
  assert.strictEqual(Rules.legalShot(st, 'cat', 0, C.MIN_POWER).ok, true);
  assert.strictEqual(Rules.legalShot(st, 'cat', C.MAX_ANGLE, C.MAX_POWER).ok, true);
});

test('不是自己的回合不能出手，狀態不會改變', () => {
  const st = Rules.createState({ seed: 'TURNAA', first: 'cat' });
  const r = Rules.applyShot(st, 'dog', { angle: 45, power: 60 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('貓咪'));
  assert.strictEqual(st.turn, 'cat', '非法操作不可以改動狀態');
  assert.strictEqual(st.version, 0);
});

test('applyShot 不會改動傳進來的 state（純函式）', () => {
  const st = Rules.createState({ seed: 'PUREAA', first: 'cat' });
  const before = JSON.stringify(st);
  Rules.applyShot(st, 'cat', { angle: 45, power: 60 });
  assert.strictEqual(JSON.stringify(st), before, 'applyShot 不應該改動原本的 state');
});

test('對局結束後不能再出手', () => {
  const st = Rules.createState({ seed: 'OVERAA', first: 'cat' });
  st.over = true;
  st.winner = 'cat';
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 60 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('結束'));
});

test('legalActions 只在自己的回合列出可執行行動', () => {
  const st = Rules.createState({ seed: 'ACTSAA', first: 'cat' });
  assert.ok(Rules.legalActions(st, 'cat').length > 0);
  assert.strictEqual(Rules.legalActions(st, 'dog').length, 0);
});

/* ============================================================ 4. 傷害與勝負 */

group('4. 傷害判定與勝負');

test('一般直接命中判定較舊版寬鬆，大骨頭仍然更容易命中', () => {
  assert.strictEqual(C.HIT_R, 34);
  assert.ok(C.HIT_R > 22, '一般命中半徑應該比舊版 22 大');
  assert.strictEqual(Rules.modOf('bigbone').hitR, 48);
  assert.ok(Rules.modOf('bigbone').hitR > C.HIT_R);
});

test('直接命中造成最大傷害', () => {
  const st = Rules.createState({ seed: 'DMGAAA', first: 'cat' });
  const dog = st.fighters.dog;
  const d = Rules.damageAt(dog.x, dog.y + C.BODY_H, dog);
  assert.strictEqual(d.part, 'body');
  assert.strictEqual(d.critical, false);
  assert.strictEqual(d.damage, C.MAX_DAMAGE);
});

test('爆炸傷害隨距離遞減，超過範圍為 0', () => {
  const st = Rules.createState({ seed: 'DMGBBB', first: 'cat' });
  const dog = st.fighters.dog;
  const core = Rules.damageAt(dog.x + C.CORE_R - 2, dog.y + C.BODY_H, dog).damage;
  const mid = Rules.damageAt(dog.x + (C.CORE_R + C.BLAST_R) / 2, dog.y + C.BODY_H, dog).damage;
  const far = Rules.damageAt(dog.x + C.BLAST_R + 5, dog.y + C.BODY_H, dog).damage;
  assert.strictEqual(core, C.MAX_DAMAGE);
  assert.ok(mid > 0 && mid < C.MAX_DAMAGE, '中距離應該是部分傷害，實際 ' + mid);
  assert.strictEqual(far, 0, '超出範圍不應該有傷害');
});

test('命中部位會改變傷害，頭部較痛、腿部較輕', () => {
  const st = Rules.createState({ seed: 'PARTAA', first: 'cat' });
  const dog = st.fighters.dog;
  const body = Rules.damageAt(dog.x, dog.y + C.BODY_H, dog);
  const head = Rules.damageAt(dog.x, dog.y + C.HEAD_Y_MIN, dog);
  const legs = Rules.damageAt(dog.x, dog.y + C.LEG_Y_MAX, dog);
  assert.strictEqual(body.part, 'body');
  assert.strictEqual(body.damage, C.MAX_DAMAGE);
  assert.strictEqual(head.part, 'head');
  assert.strictEqual(head.damage, Math.round(C.MAX_DAMAGE * C.HEAD_DAMAGE_MULTIPLIER));
  assert.strictEqual(head.critical, true);
  assert.strictEqual(legs.part, 'legs');
  assert.strictEqual(legs.damage, Math.round(C.MAX_DAMAGE * C.LEG_DAMAGE_MULTIPLIER));
  assert.strictEqual(legs.critical, false);
});

test('直接命中頭部會記錄爆擊', () => {
  const st = Rules.createState({ seed: 'HEADAA', first: 'cat' });
  st.wind = 0;
  for (let i = 0; i < st.ground.length; i++) st.ground[i] = 100;
  st.fighters.cat.y = 100;
  st.fighters.dog.x = 400;
  st.fighters.dog.y = 100;

  let headShot = null;
  for (let a = 0; a <= 89 && !headShot; a += 1) {
    for (let p = 10; p <= 100; p += 1) {
      const sim = Rules.simulate(st, 'cat', a, p, { trace: false });
      if (sim.impact.type !== 'fighter' || sim.impact.target !== 'dog') continue;
      if (sim.impact.y - st.fighters.dog.y >= C.HEAD_Y_MIN) {
        headShot = { a, p };
        break;
      }
    }
  }
  assert.ok(headShot, '應該存在能命中頭部的角度與力道');
  const r = Rules.applyShot(st, 'cat', { angle: headShot.a, power: headShot.p });
  assert.strictEqual(r.shot.hitPart, 'head');
  assert.strictEqual(r.shot.critical, true);
  assert.ok(Rules.describeShot(r.shot).includes('爆擊'));
});

test('直接命中會扣血並記錄在 shot 裡', () => {
  /* 用一個一定會命中的情境：把狗搬到貓的正前方 */
  const st = Rules.createState({ seed: 'HITAAA', first: 'cat' });
  st.wind = 0;
  for (let i = 0; i < st.ground.length; i++) st.ground[i] = 100;
  st.fighters.cat.y = 100;
  st.fighters.dog.x = 400;
  st.fighters.dog.y = 100;

  let hit = null;
  for (let a = 10; a <= 80 && !hit; a += 1) {
    for (let p = 20; p <= 100; p += 1) {
      const sim = Rules.simulate(st, 'cat', a, p, { trace: false });
      if (sim.impact.type === 'fighter' && sim.impact.target === 'dog') { hit = { a, p }; break; }
    }
  }
  assert.ok(hit, '應該存在一組能直接命中的角度與力道');
  const r = Rules.applyShot(st, 'cat', { angle: hit.a, power: hit.p });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shot.result, 'direct');
  assert.ok(r.shot.damage.dog > 0);
  assert.ok(['head', 'body', 'legs'].includes(r.shot.hitPart));
  assert.strictEqual(r.shot.damage.dog, Rules.damageAt(r.shot.impact.x, r.shot.impact.y, st.fighters.dog).damage);
  assert.strictEqual(r.state.fighters.dog.mood, 'hurt');
  assert.strictEqual(r.state.fighters.dog.hp, C.MAX_HP - r.shot.damage.dog);
  assert.strictEqual(r.state.turn, 'dog', '出手後應該換對手');
  assert.strictEqual(r.state.turnNo, 2);
  assert.strictEqual(r.state.version, 1);
});

test('視覺上穿過頭部的彈道也要判定為命中', () => {
  const st = Rules.createState({ seed: 'HITTEST', first: 'cat' });
  const result = Rules.applyShot(st, 'cat', { angle: 73, power: 99 });

  assert.strictEqual(result.shot.impact.type, 'fighter');
  assert.strictEqual(result.shot.impact.target, 'dog');
  assert.ok(result.shot.damage.dog > 0);
});

test('血量歸零就結束，勝負與原因正確', () => {
  let st = Rules.createState({ seed: 'KILLAA', first: 'cat' });
  st.wind = 0;
  for (let i = 0; i < st.ground.length; i++) st.ground[i] = 100;
  st.fighters.cat.y = 100;
  st.fighters.dog.x = 400;
  st.fighters.dog.y = 100;
  st.fighters.dog.hp = C.MAX_DAMAGE;      // 一發就倒

  let hit = null;
  for (let a = 10; a <= 80 && !hit; a += 1) {
    for (let p = 20; p <= 100; p += 1) {
      const sim = Rules.simulate(st, 'cat', a, p, { trace: false });
      if (sim.impact.type === 'fighter' && sim.impact.target === 'dog') { hit = { a, p, sim }; break; }
    }
  }
  assert.ok(hit, '應該存在一組能直接命中的角度與力道');
  const preview = Rules.damageAt(hit.sim.impact.x, hit.sim.impact.y, st.fighters.dog);
  assert.ok(preview.damage > 0, '命中預覽應該造成傷害');
  st.fighters.dog.hp = preview.damage;
  const r = Rules.applyShot(st, 'cat', { angle: hit.a, power: hit.p });
  assert.strictEqual(r.state.fighters.dog.hp, 0);
  assert.strictEqual(r.state.over, true);
  assert.strictEqual(r.state.winner, 'cat');
  assert.ok(r.state.reason.includes('貓咪'));
  assert.strictEqual(r.state.fighters.cat.mood, 'win');
  assert.strictEqual(r.state.fighters.dog.mood, 'lose');
});

test('血量不會低於 0', () => {
  const st = Rules.createState({ seed: 'FLOORA', first: 'cat' });
  st.wind = 0;
  for (let i = 0; i < st.ground.length; i++) st.ground[i] = 100;
  st.fighters.cat.y = 100;
  st.fighters.dog.x = 400;
  st.fighters.dog.y = 100;
  st.fighters.dog.hp = 3;
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 34 });
  assert.ok(r.state.fighters.dog.hp >= 0);
});

test('打到自己會自傷', () => {
  const st = Rules.createState({ seed: 'SELFAA', first: 'cat' });
  st.wind = 0;
  const r = Rules.applyShot(st, 'cat', { angle: 85, power: C.MIN_POWER });
  assert.strictEqual(r.ok, true);
  assert.ok(r.shot.damage.cat > 0, '幾乎垂直的小力道應該砸到自己，實際結果：' + r.shot.result);
  assert.ok(['self', 'both'].includes(r.shot.result), '結果應該是自爆，實際 ' + r.shot.result);
});

test('對局超過原本的回合數後仍會繼續，直到血量歸零', () => {
  let st = Rules.createState({ seed: 'LONGAA', first: 'cat' });
  st.turnNo = 999;
  st.fighters.cat.hp = 70;
  st.fighters.dog.hp = 40;
  /* 用 pass 模擬超長對局，確認不會再因總回合數自動結束 */
  const r = Rules.applyPass(st, 'cat', '測試');
  assert.strictEqual(r.state.over, false);
  assert.strictEqual(r.state.winner, null);
  assert.strictEqual(r.state.turnNo, 1000);
});

test('長局血量相同也不會自動判平手', () => {
  let st = Rules.createState({ seed: 'LONGBB', first: 'cat' });
  st.turnNo = 999;
  st.fighters.cat.hp = 55;
  st.fighters.dog.hp = 55;
  const r = Rules.applyPass(st, 'cat', '測試');
  assert.strictEqual(r.state.over, false);
  assert.strictEqual(r.state.winner, null);
});

test('主動投降會立即結束對局並判對手獲勝', () => {
  const st = Rules.createState({ seed: 'SURRENDA', first: 'cat' });
  const r = Rules.applySurrender(st, 'cat');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shot.result, 'surrender');
  assert.strictEqual(r.state.over, true);
  assert.strictEqual(r.state.winner, 'dog');
  assert.ok(r.state.reason.includes('投降'));
  assert.ok(Rules.describeShot(r.shot).includes('主動投降'));
});

test('跳過回合會換手、換風、版本加一，但不扣血', () => {
  const st = Rules.createState({ seed: 'PASSAA', first: 'cat' });
  const r = Rules.applyPass(st, 'cat', '時間到');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.turn, 'dog');
  assert.strictEqual(r.state.turnNo, 2);
  assert.strictEqual(r.state.version, 1);
  assert.strictEqual(r.state.fighters.cat.hp, C.MAX_HP);
  assert.strictEqual(r.state.fighters.dog.hp, C.MAX_HP);
  assert.strictEqual(r.state.wind, Rules.windFor(st.seed, 2));
  assert.strictEqual(r.shot.result, 'pass');
});

test('describeShot 產生可讀的中文摘要', () => {
  const st = Rules.createState({ seed: 'TEXTAA', first: 'cat' });
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 60 });
  const text = Rules.describeShot(r.shot);
  assert.ok(text.includes('第 1 回合'));
  assert.ok(text.includes('貓咪'));
  assert.ok(text.includes('力道'));
  assert.ok(!/角度\s*\d+°/.test(text), '摘要不應顯示可直接複製的角度數字：' + text);
});

/* ================================================ 5. 固定地形與固定站位 */

group('5. 固定地形與固定站位');

test('開打之後地形完全不會改變', () => {
  let st = Rules.createState({ seed: 'FIXED1', first: 'cat' });
  const before = st.ground.slice();
  for (let i = 0; i < 8 && !st.over; i++) {
    const side = st.turn;
    const r = Rules.applyShot(st, side, { angle: 40 + i * 3, power: 55 + i * 4 });
    assert.strictEqual(r.ok, true);
    st = r.state;
  }
  assert.deepStrictEqual(st.ground, before, '打了好幾發之後地形不該有任何一欄改變');
});

test('貓狗的座標整局固定不動', () => {
  let st = Rules.createState({ seed: 'FIXED2', first: 'dog' });
  const pos = {
    cat: { x: st.fighters.cat.x, y: st.fighters.cat.y },
    dog: { x: st.fighters.dog.x, y: st.fighters.dog.y }
  };
  for (let i = 0; i < 8 && !st.over; i++) {
    const r = Rules.applyShot(st, st.turn, { angle: 50, power: 70 });
    assert.strictEqual(r.ok, true);
    st = r.state;
    for (const s of ['cat', 'dog']) {
      assert.strictEqual(st.fighters[s].x, pos[s].x, s + ' 的 x 不該改變');
      assert.strictEqual(st.fighters[s].y, pos[s].y, s + ' 的 y 不該改變');
    }
  }
});

test('兩邊的站台一樣高，沒有人佔到地形便宜', () => {
  for (let i = 0; i < 60; i++) {
    const st = Rules.createState({ seed: 'LEVEL' + i });
    assert.ok(Math.abs(st.fighters.cat.y - st.fighters.dog.y) < 1e-9,
      '種子 ' + i + ' 的兩邊高度不同');
  }
});

test('站台高度就是地面加上 STAND_H', () => {
  const st = Rules.createState({ seed: 'STAND1' });
  for (const s of ['cat', 'dog']) {
    const g = Rules.groundAt(st.ground, st.fighters[s].x);
    assert.ok(Math.abs(st.fighters[s].y - (g + C.STAND_H)) < 1e-9,
      s + ' 沒有站在站台上');
  }
});

test('中央柵欄比兩側站立面高，擋得住平射', () => {
  for (let i = 0; i < 30; i++) {
    const st = Rules.createState({ seed: 'WALL' + i });
    const wallTop = Rules.groundAt(st.ground, Rules.WORLD.W / 2);
    assert.ok(wallTop > st.fighters.cat.y,
      '種子 ' + i + ' 的柵欄頂端沒有高過站立面');
  }
});

/* ==================================================== 5b. 體力影響出力 */

group('5b. 血量越低、同樣力道飛得越近');

test('出力係數滿血是 1，血量歸零是 WEAK_MIN', () => {
  const st = Rules.createState({ seed: 'FORCE1' });
  assert.ok(Math.abs(Rules.powerFactor(st, 'cat') - 1) < 1e-9, '滿血應該是 1');
  const hurt = Rules.cloneState(st);
  hurt.fighters.cat.hp = 0;
  assert.ok(Math.abs(Rules.powerFactor(hurt, 'cat') - C.WEAK_MIN) < 1e-9);
});

test('血量越低，同一組角度力道的落點越近', () => {
  const base = Rules.createState({ seed: 'FORCE2', first: 'cat' });
  base.wind = 0;
  let prev = Infinity;
  for (const hp of [100, 80, 60, 40, 20]) {
    const st = Rules.cloneState(base);
    st.fighters.cat.hp = hp;
    const sim = Rules.simulate(st, 'cat', 45, 70, { wind: 0, trace: false });
    const dist = sim.impact.x - st.fighters.cat.x;
    assert.ok(dist < prev, '血量 ' + hp + ' 的落點應該比上一級更近');
    prev = dist;
  }
});

test('出力係數只看血量，沒有任何亂數', () => {
  const st = Rules.createState({ seed: 'FORCE3' });
  st.fighters.dog.hp = 37;
  const a = Rules.powerFactor(st, 'dog');
  const b = Rules.powerFactor(Rules.cloneState(st), 'dog');
  assert.strictEqual(a, b);
});

test('受傷且逆風時，滿力仍能抵達對面陣地', () => {
  const st = Rules.createState({ seed: 'FORCE4', first: 'cat' });
  st.fighters.cat.hp = 1;
  st.wind = -C.WIND_MAX;
  const sim = Rules.simulate(st, 'cat', 45, C.MAX_POWER, { wind: -C.WIND_MAX, trace: false });
  assert.ok(sim.impact.x >= st.fighters.dog.x - C.BLAST_R,
    '滿力彈道不應在對面陣地前失效：' + JSON.stringify(sim.impact));
});

/* ============================================================ 5c. 道具 */

group('5c. 四種道具');

test('開局雙方各拿到每種道具一個', () => {
  const st = Rules.createState({ seed: 'ITEM1' });
  for (const side of ['cat', 'dog']) {
    for (const k of Rules.ITEM_ORDER) {
      assert.strictEqual(st.items[side][k], 1, side + ' 的 ' + k + ' 不是 1 個');
    }
  }
});

test('用掉的道具會從背包扣掉，而且不會補回來', () => {
  const st = Rules.createState({ seed: 'ITEM2', first: 'cat' });
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: 'stink' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.items.cat.stink, 0, '臭彈應該被扣掉');
  assert.strictEqual(r.state.items.cat.bigbone, 1, '沒用到的道具不該被動到');
  assert.strictEqual(r.state.items.dog.stink, 1, '不該扣到對手的');
});

test('用完的道具不能再用', () => {
  let st = Rules.createState({ seed: 'ITEM3', first: 'cat' });
  st.items.cat.double = 0;
  const chk = Rules.legalShot(st, 'cat', 45, 60, 'double');
  assert.strictEqual(chk.ok, false);
  assert.ok(chk.reason.includes('用完'), '要說明是用完了：' + chk.reason);
  assert.strictEqual(Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: 'double' }).ok, false);
});

test('補血不能拿來當發射道具', () => {
  const st = Rules.createState({ seed: 'ITEM4', first: 'cat' });
  const chk = Rules.legalShot(st, 'cat', 45, 60, 'heal');
  assert.strictEqual(chk.ok, false);
});

test('雙擊會丟兩發，傷害等於單發的兩倍', () => {
  /* 挑一組一定會直接命中的角度力道：直接用模擬找出來 */
  const st = Rules.createState({ seed: 'ITEM5', first: 'cat' });
  st.wind = 0;
  let hit = null;
  for (let a = 20; a <= 80 && !hit; a += 1) {
    for (let p = 30; p <= 100; p += 1) {
      const sim = Rules.simulate(st, 'cat', a, p, { wind: 0, trace: false });
      if (sim.impact.type === 'fighter' && sim.impact.target === 'dog') { hit = { a, p }; break; }
    }
  }
  assert.ok(hit, '這張圖找不到能直接命中的組合，測試前提不成立');

  const one = Rules.applyShot(st, 'cat', { angle: hit.a, power: hit.p });
  const two = Rules.applyShot(st, 'cat', { angle: hit.a, power: hit.p, item: 'double' });
  assert.strictEqual(one.shot.volley.length, 1, '沒帶道具應該只有一發');
  assert.strictEqual(two.shot.volley.length, 2, '雙擊應該有兩發');
  assert.strictEqual(two.shot.damage.dog, one.shot.damage.dog * 2, '雙擊傷害應該剛好兩倍');
});

test('大骨頭的命中判定與傷害都比較大', () => {
  const plain = Rules.modOf(null);
  const big = Rules.modOf('bigbone');
  assert.ok(big.hitR > plain.hitR, '判定半徑要更大');
  assert.ok(big.maxDamage > plain.maxDamage, '傷害要更高');
  assert.strictEqual(big.blastR, plain.blastR, '大骨頭不該改爆炸範圍');
});

test('砲彈的爆炸範圍與傷害都比較大，但判定半徑不變', () => {
  const plain = Rules.modOf(null);
  const stink = Rules.modOf('stink');
  assert.ok(stink.blastR > plain.blastR, '爆炸範圍要更大');
  assert.ok(stink.maxDamage > plain.maxDamage, '傷害要更高');
  assert.strictEqual(stink.hitR, plain.hitR, '臭彈不該改直接命中的判定半徑');
});

test('認不得的道具鍵值當作沒帶道具，不會擋住出手', () => {
  const st = Rules.createState({ seed: 'ITEM8', first: 'cat' });
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: '不存在的道具' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shot.item, null);
});

test('補血會回血、扣掉道具，並把回合交給對手', () => {
  const st = Rules.createState({ seed: 'HEAL1', first: 'cat' });
  st.fighters.cat.hp = 40;
  const r = Rules.applyHeal(st, 'cat');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.fighters.cat.hp, 40 + C.HEAL_AMOUNT);
  assert.strictEqual(r.state.items.cat.heal, 0);
  assert.strictEqual(r.state.turn, 'dog', '補完血要換對手');
  assert.strictEqual(r.state.turnNo, st.turnNo + 1);
  assert.strictEqual(r.shot.result, 'heal');
});

test('補血不會超過血量上限', () => {
  const st = Rules.createState({ seed: 'HEAL2', first: 'cat' });
  st.fighters.cat.hp = st.maxHp - 5;
  const r = Rules.applyHeal(st, 'cat');
  assert.strictEqual(r.state.fighters.cat.hp, st.maxHp);
  assert.strictEqual(r.shot.heal, 5);
});

test('沒有補血道具就不能補血，也不能在對手回合補', () => {
  const st = Rules.createState({ seed: 'HEAL3', first: 'cat' });
  assert.strictEqual(Rules.applyHeal(st, 'dog').ok, false, '不是自己的回合不能補');
  const empty = Rules.cloneState(st);
  empty.items.cat.heal = 0;
  assert.strictEqual(Rules.applyHeal(empty, 'cat').ok, false, '用完了不能補');
});

test('道具會出現在操作摘要的文字裡', () => {
  const st = Rules.createState({ seed: 'ITEM9', first: 'cat' });
  const r = Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: 'stink' });
  const text = Rules.describeShot(r.shot);
  assert.ok(text.includes('砲彈'), '摘要要寫出用了哪個道具：' + text);
  const h = Rules.applyHeal(st, 'cat');
  assert.ok(Rules.describeShot(h.shot).includes('補血'));
});

test('toPublic / fromPublic 會保留背包內容', () => {
  const st = Rules.createState({ seed: 'ITEM10', first: 'cat' });
  const after = Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: 'bigbone' }).state;
  const round = Rules.fromPublic(Rules.toPublic(after));
  assert.deepStrictEqual(round.items, after.items);
});

test('applyShot 不會改動傳進來的狀態', () => {
  const st = Rules.createState({ seed: 'ITEM11', first: 'cat' });
  const snapshot = JSON.stringify(st);
  Rules.applyShot(st, 'cat', { angle: 45, power: 60, item: 'double' });
  assert.strictEqual(JSON.stringify(st), snapshot, 'applyShot 必須是純函式');
});

/* ============================================================ 6. AI */

group('6. 電腦對手');

test('三段難度都只送出合法行動', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    for (let i = 0; i < 40; i++) {
      const st = Rules.createState({ seed: 'AI' + i, first: 'cat' });
      const rng = RNG.createRng('legal:' + level + ':' + i);
      const shot = AI.chooseShot(st, 'cat', level, rng);
      const legal = Rules.legalShot(st, 'cat', shot.angle, shot.power);
      assert.strictEqual(legal.ok, true, level + ' 第 ' + i + ' 次送出非法行動：' + JSON.stringify(shot));
      assert.ok(!shot.fallback, level + ' 不應該需要回退到保險值');
    }
  }
});

test('同一個種子的 AI 決策可重現', () => {
  const st = Rules.createState({ seed: 'REPEAT', first: 'cat' });
  for (const level of ['easy', 'normal', 'hard']) {
    const a = AI.chooseShot(st, 'cat', level, RNG.createRng('same'));
    const b = AI.chooseShot(st, 'cat', level, RNG.createRng('same'));
    assert.strictEqual(a.angle, b.angle, level + ' 角度不可重現');
    assert.strictEqual(a.power, b.power, level + ' 力道不可重現');
  }
});

test('難度差異可觀察：困難比普通準、普通比簡單準', () => {
  const N = 80;
  const stats = {};
  for (const level of ['easy', 'normal', 'hard']) {
    let sum = 0, damaging = 0;
    for (let i = 0; i < N; i++) {
      const st = Rules.createState({ seed: 'DIFF' + i, first: 'cat' });
      const rng = RNG.createRng('diff:' + level + ':' + i);
      const shot = AI.chooseShot(st, 'cat', level, rng);
      const d = AI.missDistance(st, 'cat', shot);
      sum += d;
      if (d < C.BLAST_R) damaging += 1;
    }
    stats[level] = { avg: sum / N, hitRate: damaging / N };
  }
  console.log('      平均落點誤差：簡單 ' + stats.easy.avg.toFixed(0) +
    '、普通 ' + stats.normal.avg.toFixed(0) + '、困難 ' + stats.hard.avg.toFixed(0));
  console.log('      造成傷害的比例：簡單 ' + (stats.easy.hitRate * 100).toFixed(0) +
    '%、普通 ' + (stats.normal.hitRate * 100).toFixed(0) +
    '%、困難 ' + (stats.hard.hitRate * 100).toFixed(0) + '%');

  assert.ok(stats.hard.avg < stats.normal.avg, '困難的誤差應該小於普通');
  assert.ok(stats.normal.avg < stats.easy.avg, '普通的誤差應該小於簡單');
  assert.ok(stats.hard.avg * 1.6 < stats.normal.avg, '困難與普通的差距要明顯，不能只是名稱不同');
  /* 提高基礎初速後，遠距離落點的絕對誤差會縮小；仍保留明顯差距門檻。 */
  assert.ok(stats.normal.avg * 1.4 < stats.easy.avg, '普通與簡單的差距要明顯');
  assert.ok(stats.hard.hitRate > stats.normal.hitRate, '困難的命中率應該比較高');
  assert.ok(stats.normal.hitRate > stats.easy.hitRate, '普通的命中率應該比較高');
});

test('AI 的思考時間在可接受範圍內（平板也不會卡）', () => {
  const budget = { easy: 5, normal: 30, hard: 120 };   // 毫秒／每一發
  for (const level of ['easy', 'normal', 'hard']) {
    const t0 = Date.now();
    const N = 20;
    for (let i = 0; i < N; i++) {
      const st = Rules.createState({ seed: 'PERF' + i, first: 'cat' });
      AI.chooseShot(st, 'cat', level, RNG.createRng('perf:' + i));
    }
    const per = (Date.now() - t0) / N;
    console.log('      ' + level + ' 每發平均 ' + per.toFixed(1) + ' ms');
    assert.ok(per < budget[level], level + ' 太慢了：' + per.toFixed(1) + ' ms');
  }
});

test('簡單 AI 完全不補償風向，困難 AI 完整補償', () => {
  assert.strictEqual(AI.LEVELS.easy.windBelief, 0);
  assert.ok(AI.LEVELS.normal.windBelief > 0 && AI.LEVELS.normal.windBelief < 1);
  assert.strictEqual(AI.LEVELS.hard.windBelief, 1);
  assert.ok(AI.LEVELS.easy.angleJitter > AI.LEVELS.normal.angleJitter);
  assert.ok(AI.LEVELS.normal.angleJitter > AI.LEVELS.hard.angleJitter);
});

test('AI 可以打完一整局而且不會卡住', () => {
  let st = Rules.createState({ seed: 'FULLAA', first: 'cat' });
  let guard = 0;
  while (!st.over && guard < 120) {
    const level = st.turn === 'cat' ? 'hard' : 'normal';
    const shot = AI.chooseShot(st, st.turn, level, RNG.createRng('full:' + guard));
    const r = Rules.applyShot(st, st.turn, shot);
    assert.strictEqual(r.ok, true, '第 ' + guard + ' 手失敗：' + r.reason);
    st = r.state;
    guard += 1;
  }
  assert.strictEqual(st.over, true, '應該要分出勝負，實際跑了 ' + guard + ' 手');
  assert.ok(['cat', 'dog', 'draw'].includes(st.winner));
  console.log('      困難(貓) vs 普通(狗)：' + guard + ' 手分出勝負，贏家 ' + st.winner);
});

/* ============================================================ 7. 房間狀態機 */

group('7. 房間狀態機');

const T0 = 1700000000000;

function freshStore(opts) {
  return new RoomStore(Object.assign({ turnMs: 15000, graceMs: 1000, emptyMs: 2000 }, opts || {}));
}

test('建立房間後房主入座、房號可查', () => {
  const store = freshStore();
  const res = store.create('host1', { name: '小明', roomName: '測試房', now: T0 });
  assert.strictEqual(res.ok, true);
  const room = res.room;
  assert.strictEqual(room.hostId, 'host1');
  assert.strictEqual(room.members.size, 1);
  assert.strictEqual(store.get(room.code), room);
  assert.strictEqual(store.get(room.code.toLowerCase()), room, '房號應該不分大小寫');
});

test('兩個人不能選同一邊', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  assert.strictEqual(room.pickSide('a', 'cat').ok, true);
  const r = room.pickSide('b', 'cat');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'taken');
  assert.ok(r.error.includes('A'));
  assert.strictEqual(room.pickSide('b', 'dog').ok, true);
  assert.strictEqual(room.sideOf('a'), 'cat');
  assert.strictEqual(room.sideOf('b'), 'dog');
});

test('一個人換邊時會先釋放原本的位子', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.pickSide('a', 'cat');
  room.pickSide('a', 'dog');
  assert.strictEqual(room.seats.cat, null);
  assert.strictEqual(room.seats.dog, 'a');
});

test('沒有兩邊都有人或沒準備好就不能開始', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.pickSide('a', 'cat');
  let r = room.start('a', T0);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('空位'));

  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('b', 'dog');
  r = room.start('a', T0);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('準備'), '應該提示誰還沒準備：' + r.error);

  room.setReady('a', true);
  room.setReady('b', true);
  r = room.start('a', T0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.state);
});

test('只有房主可以開始對局', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  const r = room.start('b', T0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'forbidden');
});

test('觀戰者不能選邊、不能準備、不能發射', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('spec', { name: '路人', role: 'spectator', now: T0 });
  assert.strictEqual(room.pickSide('spec', 'dog').code, 'forbidden');
  assert.strictEqual(room.setReady('spec', true).code, 'forbidden');

  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);
  const r = room.fire('spec', { angle: 45, power: 60 }, T0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'forbidden');
  assert.ok(r.error.includes('觀戰'));
  const surrender = room.surrender('spec', T0);
  assert.strictEqual(surrender.ok, false);
  assert.strictEqual(surrender.code, 'forbidden');
});

test('席位滿了之後想當玩家的人會明確變成觀戰者', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  const r = room.join('c', { name: 'C', role: 'player', now: T0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.downgraded, true);
  assert.strictEqual(r.member.role, 'spectator');
  assert.strictEqual(room.becomePlayer('c').code, 'full');
});

test('對局中不能換邊、不能中途加入', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);
  room.join('c', { name: 'C', role: 'spectator', now: T0 });
  assert.strictEqual(room.pickSide('a', 'dog').ok, false);
  assert.strictEqual(room.becomePlayer('c').code, 'playing');
});

test('輪到誰才能發射，出手後換人', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);

  const first = room.state.turn;
  const firstId = first === 'cat' ? 'a' : 'b';
  const otherId = first === 'cat' ? 'b' : 'a';

  const wrong = room.fire(otherId, { angle: 45, power: 60 }, T0);
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(room.summary.length, 0, '非法出手不可以留下紀錄');

  const good = room.fire(firstId, { angle: 45, power: 60 }, T0 + 1000);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(room.summary.length, 1);
  assert.ok(room.summary[0].text.includes('力道'));
  assert.ok(!/角度\s*\d+°/.test(room.summary[0].text));
  assert.notStrictEqual(room.state.turn, first);
  assert.strictEqual(room.turnDeadline, T0 + 1000 + 15000);
});

test('道具第一次選定後會鎖定，出手完成後才解除', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);

  const side = room.state.turn;
  const playerId = side === 'cat' ? 'a' : 'b';
  const selected = room.selectItem(playerId, 'stink', T0 + 100);
  assert.strictEqual(selected.ok, true);
  assert.strictEqual(room.selectedItems[side], 'stink');
  assert.strictEqual(room.viewFor(playerId, T0 + 100).you.selectedItem, 'stink');

  const changed = room.selectItem(playerId, 'double', T0 + 200);
  assert.strictEqual(changed.ok, false);
  assert.strictEqual(changed.code, 'item_locked');
  const wrongFire = room.fire(playerId, { angle: 45, power: 60, item: 'double' }, T0 + 300);
  assert.strictEqual(wrongFire.ok, false);
  assert.strictEqual(wrongFire.code, 'item_locked');

  const fired = room.fire(playerId, { angle: 45, power: 60, item: 'stink' }, T0 + 400);
  assert.strictEqual(fired.ok, true);
  assert.strictEqual(room.selectedItems[side], null);
});

test('AI 席位由伺服器出手，用戶端無法代打', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.pickSide('a', 'cat');
  assert.strictEqual(room.setAi('a', 'dog', 'hard').ok, true);
  assert.strictEqual(room.seatKind('dog'), 'ai');
  room.setReady('a', true);
  assert.strictEqual(room.start('a', T0).ok, true);

  /* 讓輪次落到 AI 身上 */
  if (room.state.turn === 'cat') room.fire('a', { angle: 45, power: 60 }, T0);
  assert.strictEqual(room.state.turn, 'dog');
  const r = room.fireAi('dog', T0 + 100, RNG.createRng('aiseat'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(room.summary[room.summary.length - 1].aiLevel, 'hard');
  /* 非 AI 的一邊不能用 fireAi 觸發 */
  assert.strictEqual(room.fireAi('cat', T0 + 200, Math.random).ok, false);
});

test('房主不能把電腦補到已經有真人的位子上', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  assert.strictEqual(room.setAi('a', 'dog', 'easy').code, 'taken');
  assert.strictEqual(room.setAi('b', 'dog', 'easy').code, 'forbidden', '不是房主不能設定');
});

test('回合逾時由伺服器代為跳過並寫進摘要', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);

  assert.strictEqual(store.dueTurns(T0 + 1000).length, 0);
  const due = store.dueTurns(T0 + 16000);
  assert.strictEqual(due.length, 1);
  const before = room.state.turn;
  const r = room.timeoutTurn(T0 + 16000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shot.result, 'pass');
  assert.notStrictEqual(room.state.turn, before);
  assert.strictEqual(room.summary[0].result, 'pass');
});

test('對局中離開等於棄權，對手獲勝', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);
  const r = room.leave('a', T0 + 500);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.forfeited, 'dog');
  assert.strictEqual(room.state.over, true);
  assert.strictEqual(room.state.winner, 'dog');
  assert.strictEqual(room.phase, 'finished');
  assert.strictEqual(room.summary[room.summary.length - 1].result, 'surrender');
  assert.strictEqual(room.hostId, 'b', '房主離開後應該換人');
});

test('場上玩家可以主動投降，房間保留結算狀態', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);

  const r = room.surrender('a', T0 + 500);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shot.result, 'surrender');
  assert.strictEqual(room.phase, 'finished');
  assert.strictEqual(room.state.winner, 'dog');
  assert.strictEqual(room.summary[room.summary.length - 1].surrender, true);
  assert.ok(room.summary[room.summary.length - 1].text.includes('主動投降'));
  assert.strictEqual(room.viewFor('b', T0 + 500).you.can.surrender, false);
});

test('斷線會保留座位，超過緩衝時間才釋放', () => {
  const store = freshStore({ graceMs: 1000 });
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');

  room.disconnect('b', T0);
  assert.strictEqual(room.seats.dog, 'b', '剛斷線時座位要留著');
  store.sweep(T0 + 500);
  assert.strictEqual(room.seats.dog, 'b', '緩衝時間內不該踢人');

  /* 緩衝時間內重新連上，座位還在 */
  const back = room.join('b', { name: 'B', role: 'player', now: T0 + 600 });
  assert.strictEqual(back.reconnected, true);
  assert.strictEqual(room.seats.dog, 'b');

  room.disconnect('b', T0 + 600);
  store.sweep(T0 + 3000);
  assert.strictEqual(room.seats.dog, null, '超過緩衝時間應該釋出座位');
});

test('完全沒人的房間會被回收', () => {
  const store = freshStore({ graceMs: 100, emptyMs: 500 });
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const code = room.code;
  room.disconnect('a', T0);
  store.sweep(T0 + 200);       // 踢掉斷線的人
  assert.strictEqual(room.members.size, 0);
  const swept = store.sweep(T0 + 5000);
  assert.ok(swept.closed.some((r) => r.code === code), '空房應該被關掉');
  assert.strictEqual(store.get(code), null);
});

test('空房回收時間從最後一人離線開始計算', () => {
  const store = freshStore({ graceMs: 100, emptyMs: 500 });
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const code = room.code;

  room.disconnect('a', T0);
  store.sweep(T0 + 100); // 寬限期結束，移除斷線成員
  assert.strictEqual(room.members.size, 0);

  const swept = store.sweep(T0 + 500);
  assert.ok(swept.closed.some((r) => r.code === code), '空房應在最後一人離線 500ms 後關閉');
  assert.strictEqual(store.get(code), null);
});

test('再來一局需要所有真人玩家同意', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);
  room.state.over = true;
  room.state.winner = 'cat';
  room.phase = 'finished';

  let r = room.voteRematch('a', T0);
  assert.strictEqual(r.started, false);
  assert.strictEqual(r.need, 2);
  r = room.voteRematch('b', T0);
  assert.strictEqual(r.started, true);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.summary.length, 0, '新的一局摘要要清空');
});

test('觀戰者不能投票再來一局', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('s', { name: 'S', role: 'spectator', now: T0 });
  room.phase = 'finished';
  assert.strictEqual(room.voteRematch('s', T0).code, 'forbidden');
});

/* ---- 邀請連結 ---- */

group('7b. 邀請連結');

test('邀請 token 夠長、綁定房間、可以指定角色', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const r = room.createInvite('a', { role: 'spectator', ttlMs: 60000, maxUses: 2, now: T0 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.invite.token.length >= 32, 'token 太短，容易被猜到');
  assert.strictEqual(r.invite.role, 'spectator');
  assert.strictEqual(room.checkInvite(r.invite.token, T0).ok, true);
  assert.strictEqual(room.checkInvite('不存在的token', T0).code, 'invite_invalid');
});

test('邀請連結會過期', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const inv = room.createInvite('a', { ttlMs: 60000, now: T0 }).invite;
  assert.strictEqual(room.checkInvite(inv.token, T0 + 59000).ok, true);
  const r = room.checkInvite(inv.token, T0 + 61000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'invite_expired');
});

test('邀請連結可以撤銷，撤銷後立刻失效', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const inv = room.createInvite('a', { now: T0 }).invite;
  assert.strictEqual(room.revokeInvite('a', inv.token).ok, true);
  assert.strictEqual(room.checkInvite(inv.token, T0).code, 'invite_revoked');
  assert.strictEqual(room.revokeInvite('a', '亂打的').code, 'gone');
});

test('邀請連結有使用次數上限', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const inv = room.createInvite('a', { maxUses: 1, now: T0 }).invite;
  const joined = room.join('b', { name: 'B', role: 'player', token: inv.token, now: T0 });
  assert.strictEqual(joined.ok, true);
  const again = room.join('c', { name: 'C', role: 'player', token: inv.token, now: T0 });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'invite_used');
});

test('觀戰用的邀請連結進來就是觀戰者，即使還有空位', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  const inv = room.createInvite('a', { role: 'spectator', now: T0 }).invite;
  const r = room.join('b', { name: 'B', role: 'player', token: inv.token, now: T0 });
  assert.strictEqual(r.member.role, 'spectator', 'token 的角色要蓋過用戶端要求的角色');
});

test('不公開的房間沒有邀請連結就進不去', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', private: true, now: T0 }).room;
  assert.strictEqual(room.join('b', { name: 'B', role: 'player', now: T0 }).code, 'private');
  const inv = room.createInvite('a', { now: T0 }).invite;
  assert.strictEqual(room.join('b', { name: 'B', role: 'player', token: inv.token, now: T0 }).ok, true);
  assert.ok(!store.list().some((x) => x.code === room.code), '不公開的房間不應該出現在大廳列表');
});

test('只有玩家或房主可以產生邀請連結', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('s', { name: 'S', role: 'spectator', now: T0 });
  assert.strictEqual(room.createInvite('s', { now: T0 }).code, 'forbidden');
});

/* ---- 聊天室 ---- */

group('7c. 聊天室');

test('訊息會被消毒並限制長度', () => {
  assert.strictEqual(sanitizeText('  哈  囉  ', 20), '哈 囉');
  assert.strictEqual(sanitizeText('12345678901234567890', 5), '12345');
  assert.ok(!sanitizeText('a b​c', 20).includes(' '));
});

test('發言有頻率限制', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  assert.strictEqual(room.say('a', '哈囉', T0).ok, true);
  const fast = room.say('a', '再一句', T0 + 100);
  assert.strictEqual(fast.ok, false);
  assert.strictEqual(fast.code, 'ratelimit');
  assert.strictEqual(room.say('a', '慢慢說', T0 + 1000).ok, true);
});

test('空訊息會被擋下', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  assert.strictEqual(room.say('a', '   ', T0).ok, false);
});

test('房主可以禁言，被禁言的人不能發話', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  assert.strictEqual(room.mute('b', 'a', 60, T0).code, 'forbidden');
  assert.strictEqual(room.mute('a', 'b', 60, T0).ok, true);
  const r = room.say('b', '嗨', T0 + 5000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'muted');
});

test('聊天訊息只保留最近的一批', () => {
  const store = freshStore({ chatKeep: 5, chatCooldownMs: 0 });
  const room = store.create('a', { name: 'A', now: T0 }).room;
  for (let i = 0; i < 12; i++) room.say('a', '訊息' + i, T0 + i * 10);
  assert.ok(room.chat.length <= 5);
  assert.ok(room.chat[room.chat.length - 1].text.includes('11'));
});

/* ---- 投影與權限 ---- */

group('7d. 角色投影與權限');

test('玩家與觀戰者拿到同樣的盤面，但權限不同', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.join('b', { name: 'B', role: 'player', now: T0 });
  room.join('s', { name: 'S', role: 'spectator', now: T0 });
  room.pickSide('a', 'cat'); room.pickSide('b', 'dog');
  room.setReady('a', true); room.setReady('b', true);
  room.start('a', T0);

  const playerView = room.viewFor(room.state.turn === 'cat' ? 'a' : 'b', T0);
  const specView = room.viewFor('s', T0);

  assert.deepStrictEqual(playerView.game.ground, specView.game.ground, '觀戰者應該看得到一樣的地形');
  assert.strictEqual(playerView.game.turn, specView.game.turn);
  assert.strictEqual(playerView.you.can.fire, true);
  assert.strictEqual(specView.you.can.fire, false);
  assert.strictEqual(specView.you.can.pickSide, false);
  assert.strictEqual(specView.you.can.start, false);
  assert.strictEqual(specView.you.can.invite, false);
  assert.strictEqual(specView.room.invites.length, 0, '觀戰者不應該看到邀請 token');
});

test('房主看得到邀請 token，一般玩家看得到自己房間的', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', now: T0 }).room;
  room.createInvite('a', { now: T0 });
  assert.strictEqual(room.viewFor('a', T0).room.invites.length, 1);
});

test('大廳列表顯示席位、人數與狀態', () => {
  const store = freshStore();
  const room = store.create('a', { name: 'A', roomName: '大廳測試', now: T0 }).room;
  room.pickSide('a', 'cat');
  room.setAi('a', 'dog', 'normal');
  const list = store.list();
  const item = list.find((x) => x.code === room.code);
  assert.ok(item);
  assert.strictEqual(item.name, '大廳測試');
  assert.strictEqual(item.phase, 'waiting');
  assert.strictEqual(item.players, 2);
  assert.strictEqual(item.humans, 1);
  assert.strictEqual(item.seats.cat.kind, 'human');
  assert.strictEqual(item.seats.dog.kind, 'ai');
  assert.ok(item.seats.dog.name.includes('普通'));
});

test('完整生命週期：開房 → 邀請 → 對戰 → 觀戰 → 結束 → 再來一局', () => {
  const store = freshStore();
  const room = store.create('host', { name: '房主', roomName: '生命週期', now: T0 }).room;
  room.pickSide('host', 'cat');

  const inv = room.createInvite('host', { role: 'player', now: T0 }).invite;
  assert.strictEqual(room.join('guest', { name: '客人', token: inv.token, now: T0 }).ok, true);
  assert.strictEqual(room.pickSide('guest', 'dog').ok, true);

  const specInv = room.createInvite('host', { role: 'spectator', now: T0 }).invite;
  assert.strictEqual(room.join('watcher', { name: '觀眾', token: specInv.token, now: T0 }).member.role, 'spectator');

  room.setReady('host', true);
  room.setReady('guest', true);
  assert.strictEqual(room.start('host', T0).ok, true);

  let now = T0;
  let guard = 0;
  while (!room.state.over && guard < 120) {
    const side = room.state.turn;
    const id = side === 'cat' ? 'host' : 'guest';
    const shot = AI.chooseShot(room.state, side, 'hard', RNG.createRng('life:' + guard));
    now += 1000;
    const r = room.fire(id, shot, now);
    assert.strictEqual(r.ok, true, '第 ' + guard + ' 手應該合法：' + r.error);
    guard += 1;
  }
  assert.strictEqual(room.phase, 'finished');
  const shotsRecorded = room.summary.length;
  assert.ok(shotsRecorded >= 3, '摘要應該記下每一發，實際 ' + shotsRecorded + ' 筆');
  assert.strictEqual(shotsRecorded, guard, '摘要筆數要跟實際出手數一致');
  assert.strictEqual(room.viewFor('watcher', now).you.can.rematch, false);
  console.log('      整局共 ' + guard + ' 手，摘要 ' + shotsRecorded + ' 筆');

  assert.strictEqual(room.voteRematch('host', now).started, false);
  assert.strictEqual(room.voteRematch('guest', now).started, true);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.summary.length, 0, '新的一局摘要要清空');
});

/* ============================================================ 8. server URL */

group('8. server URL 參數化');

function loadConfig() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'config.js'), 'utf8');
  const fakeWindow = { location: { search: '', protocol: 'http:', origin: 'http://localhost:3020' } };
  new Function('window', src)(fakeWindow);
  return fakeWindow.GameConfig;
}

test('config.js 沒有硬編碼任何伺服器網域', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'config.js'), 'utf8');
  const injected = /var INJECTED = '([^']*)'/.exec(src);
  assert.ok(injected, '找不到 INJECTED 那一行');
  assert.strictEqual(injected[1], '', '版控裡的 INJECTED 必須留空');
  assert.ok(!/onrender\.com|herokuapp|vercel\.app|github\.io/.test(src), 'config.js 不應該寫死免費平台網域');
});

test('前端程式碼裡沒有散落的硬編碼 server URL', () => {
  const dir = path.join(__dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'config.js') continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.(onrender|herokuapp|vercel|netlify)\.)/i.test(src),
      f + ' 裡面有硬編碼的伺服器網址');
  }
});

test('server URL 解析：網址參數優先於注入值', () => {
  const Config = loadConfig();
  const r = Config._resolve('https://injected.example', 'https://query.example', 'https:', 'https://page.example');
  assert.strictEqual(r.url, 'https://query.example');
  assert.strictEqual(r.source, 'query');
  assert.strictEqual(r.status, 'ok');
});

test('server URL 解析：都沒設定時回退到同源', () => {
  const Config = loadConfig();
  const r = Config._resolve('', '', 'http:', 'http://localhost:3020');
  assert.strictEqual(r.url, 'http://localhost:3020');
  assert.strictEqual(r.source, 'same-origin');
});

test('server URL 解析：file:// 開啟時沒有伺服器', () => {
  const Config = loadConfig();
  const r = Config._resolve('', '', 'file:', 'null');
  assert.strictEqual(r.url, null);
  assert.strictEqual(r.status, 'unset');
});

test('server URL 解析：格式錯誤會被擋下，不會靜默回退 localhost', () => {
  const Config = loadConfig();
  for (const bad of ['不是網址', 'ftp://x.example', '/relative/path']) {
    const r = Config._resolve('', bad, 'https:', 'https://page.example');
    assert.strictEqual(r.status, 'invalid', bad + ' 應該被判定為非法');
    assert.strictEqual(r.url, null);
    assert.ok(r.error && r.error.length > 4);
  }
});

test('server URL 解析：https 頁面不接受 http 伺服器', () => {
  const Config = loadConfig();
  const r = Config._resolve('', 'http://insecure.example', 'https:', 'https://page.example');
  assert.strictEqual(r.status, 'invalid');
  assert.ok(r.error.includes('混合內容'));
});

test('server URL 解析：結尾斜線會被正規化掉', () => {
  const Config = loadConfig();
  const r = Config._resolve('https://a.example/', '', 'https:', 'https://page.example');
  assert.strictEqual(r.url, 'https://a.example');
});

/* ============================================================ 收尾 */

console.log('\n========================================');
console.log('  通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
console.log('========================================');
if (failed) {
  console.log('\n失敗細節：');
  for (const f of failures) {
    console.log('  · ' + f.name);
    console.log('    ' + (f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 3).join('\n    ') : f.error));
  }
  process.exit(1);
}
