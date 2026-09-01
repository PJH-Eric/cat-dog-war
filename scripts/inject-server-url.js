/*
 * scripts/inject-server-url.js — 把 server URL 寫進 public/js/config.js
 *
 * 什麼時候需要用？
 *   只有「前端和伺服器分開部署」的時候（例如前端放 GitHub Pages、
 *   伺服器放 Render）。如果前端就是由 server.js 送出來的，config.js
 *   會自動用同源，不需要注入任何東西。
 *
 * 用法：
 *   GAME_SERVER_URL=https://cat-dog-war.example node scripts/inject-server-url.js
 *   node scripts/inject-server-url.js https://cat-dog-war.example
 *   node scripts/inject-server-url.js --allow-local http://localhost:3020   （本機測試）
 *   node scripts/inject-server-url.js --clear                               （還原成同源）
 *
 * 沒有給值時：清空注入值並正常結束（回到同源／單機）。
 * 給了但格式不對：直接失敗，不會靜默回退成 localhost 或寫死的網域。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'public', 'js', 'config.js');
const BEGIN = '/* GAME_SERVER_URL:BEGIN';
const LINE = /(\/\* GAME_SERVER_URL:BEGIN[\s\S]*?\*\/\s*\n\s*var INJECTED = )'[^']*'(;)/;

const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');
const clear = args.includes('--clear');
const positional = args.filter((a) => !a.startsWith('--'));
const raw = clear ? '' : String(positional[0] || process.env.GAME_SERVER_URL || '').trim();

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function validate(value) {
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    fail('GAME_SERVER_URL 不是合法的絕對網址：' + value);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    fail('GAME_SERVER_URL 只接受 http 或 https：' + value);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname);
  if (local && !allowLocal) {
    fail('正式部署不可以用本機網址（' + u.hostname + '）。本機測試請加 --allow-local。');
  }
  if (!local && u.protocol === 'http:') {
    fail('正式部署請用 https，否則 https 的前端頁面會因為混合內容被瀏覽器擋掉：' + value);
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const source = fs.readFileSync(CONFIG, 'utf8');
if (!source.includes(BEGIN) || !LINE.test(source)) {
  fail('config.js 找不到可注入的標記，請確認 GAME_SERVER_URL:BEGIN 區塊沒有被改壞。');
}

if (!raw) {
  fs.writeFileSync(CONFIG, source.replace(LINE, "$1''$2"), 'utf8');
  console.log('· 沒有提供 GAME_SERVER_URL，config.js 的注入值已清空（前端會用同源）。');
  process.exit(0);
}

const url = validate(raw);
if ([39, 92].some((c) => url.indexOf(String.fromCharCode(c)) >= 0)) fail('網址含有不允許的字元：' + url);

fs.writeFileSync(CONFIG, source.replace(LINE, "$1'" + url + "'$2"), 'utf8');
console.log('✓ 已把 server URL 注入 public/js/config.js：' + url);
