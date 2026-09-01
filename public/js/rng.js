/* ===== rng.js — 可注入的種子亂數 =====
 * 同一個種子一定產生同一串亂數，讓地形、風向、AI 誤差與重播都可重現。
 * 沒有任何 DOM 相依：瀏覽器、伺服器與 Node 測試共用同一份。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RNG = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 房號／種子字元集：拿掉容易看錯的 0 O 1 I，方便玩家用嘴巴唸給隊友聽 */
  var SEED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var SEED_MAX = 12;

  /* FNV-1a：把任意字串壓成 32 位元整數 */
  function hashSeed(seed) {
    var str = (seed === undefined || seed === null) ? '' : String(seed);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* mulberry32：小而均勻的 PRNG，回傳 [0, 1) */
  function mulberry32(state) {
    var t = state >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createRng(seed) {
    return mulberry32(typeof seed === 'number' ? (seed >>> 0) : hashSeed(seed));
  }

  /* 把玩家輸入的種子正規化：只留合法字元、轉大寫、限制長度 */
  function normalizeSeed(input) {
    var str = (input === undefined || input === null) ? '' : String(input);
    var out = '';
    for (var i = 0; i < str.length && out.length < SEED_MAX; i++) {
      var ch = str.charAt(i).toUpperCase();
      if (SEED_CHARS.indexOf(ch) >= 0) out += ch;
    }
    return out;
  }

  /* 產生一組新的隨機種子字串；可注入 rng 讓結果可重現 */
  function randomSeed(rng, length) {
    var next = rng || Math.random;
    var n = length || 6;
    var out = '';
    for (var i = 0; i < n; i++) {
      out += SEED_CHARS.charAt(Math.floor(next() * SEED_CHARS.length) % SEED_CHARS.length);
    }
    return out;
  }

  /* [-1, 1) 的對稱亂數，AI 瞄準誤差用得到 */
  function symmetric(rng) {
    return (rng || Math.random)() * 2 - 1;
  }

  return {
    SEED_CHARS: SEED_CHARS,
    SEED_MAX: SEED_MAX,
    hashSeed: hashSeed,
    createRng: createRng,
    normalizeSeed: normalizeSeed,
    randomSeed: randomSeed,
    symmetric: symmetric
  };
}));
