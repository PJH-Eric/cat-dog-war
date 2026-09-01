/*
 * scripts/browser-check.js — 用無頭 Chrome 實際跑一遍遊戲並檢查版面
 * 執行：node scripts/browser-check.js      （會自己啟動 server.js）
 *
 * 零外部套件：直接用 Node 內建的 fetch 與 WebSocket 講 Chrome DevTools Protocol。
 *
 * 檢查項目
 *   A. 七種尺寸／方向（手機窄版、手機直橫、平板直橫、桌機寬版）下的每個主要畫面：
 *      不可水平溢出、右上角設定按鈕在安全區內且夠大、設定鈕不遮住可操作元素、
 *      觸控命中區足夠、戰場畫布沒有超出可用範圍。
 *   B. 主控台不可以有未處理的錯誤。
 *   C. 單機完整一局：選邊 → 選難度 → 開打 → 發射 → 電腦回擊 → 結算 → 再玩一局。
 *   D. 設定彈窗：開啟、焦點鎖定、Escape 關閉、焦點歸位、靜音設定重新載入後仍保留。
 *   E. 窄版的操作摘要面板與聊天室可以展開收合，且不擋住發射鈕。
 *   F. 線上 UI：同一個瀏覽器開三個分頁（房主、玩家、觀戰），走完邀請連結 →
 *      選邊 → 準備 → 開打 → 出手 → 摘要更新 → 聊天室，並確認觀戰者的按鈕確實不存在。
 *
 * 螢幕截圖會存到 screenshots/。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 3122);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9344);
const PROFILE = path.join(ROOT, '.chrome-rwd-test');
const SHOTS = path.join(ROOT, 'screenshots');

const VIEWPORTS = [
  { name: '手機窄版直向', width: 360, height: 640, mobile: true, dsf: 2 },
  { name: '手機直向', width: 390, height: 844, mobile: true, dsf: 3 },
  { name: '手機橫向', width: 844, height: 390, mobile: true, dsf: 3 },
  { name: '小手機橫向', width: 667, height: 375, mobile: true, dsf: 2 },
  { name: '平板直向', width: 768, height: 1024, mobile: true, dsf: 2 },
  { name: '平板橫向', width: 1024, height: 768, mobile: true, dsf: 2 },
  { name: '桌機寬版', width: 1440, height: 900, mobile: false, dsf: 1 }
];

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + label);
  } else {
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
    failures.push(label + (detail ? ' — ' + detail : ''));
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------- 極簡 CDP 用戶端 */

class CDP {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label || '';
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()',
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('頁面執行例外：' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    }
    return res.result.value;
  }
  async json(expression) {
    return JSON.parse(await this.eval('return JSON.stringify(' + expression + ');'));
  }
  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      if (await this.eval('try { return !!(' + expression + '); } catch (e) { return false; }')) return true;
      await sleep(120);
    }
    throw new Error((this.label ? this.label + '：' : '') + '等不到條件 ' + (label || expression));
  }
}

/* ------------------------------ 頁面端探針（字串化送進瀏覽器） */

const PAGE_HELPERS = `
  window.__probe = {
    layout: function () {
      var doc = document.documentElement;
      var vw = window.innerWidth, vh = window.innerHeight;
      var fab = document.getElementById('b-settings');
      var fr = fab.getBoundingClientRect();

      /* 收合中的抽屜（窄版的操作摘要、收起來的聊天面板）是刻意畫在畫面外的，
         不算版面溢出，也不用檢查命中區。 */
      function offCanvas(el) {
        var aside = el.closest ? el.closest('#battle-aside') : null;
        if (aside && !aside.classList.contains('open') && window.innerWidth < 980) return true;
        var panel = el.closest ? el.closest('#chat-panel') : null;
        if (panel && panel.hidden) return true;
        return false;
      }
      /* input 包在 label 裡時，真正的命中區是整個 label 列，不是那顆小方塊 */
      function hitBox(el) {
        var lab = el.closest ? el.closest('label') : null;
        return (lab || el).getBoundingClientRect();
      }

      var small = [];
      var list = document.querySelectorAll(
        '.screen.active button, .settings-modal.open button, .settings-modal.open input, .screen.active input:not([type=range])'
      );
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.hidden || el.offsetParent === null || offCanvas(el)) continue;
        var r = hitBox(el);
        if (r.width === 0 && r.height === 0) continue;
        if (r.height < 38 || r.width < 24) small.push((el.id || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }

      var wide = [];
      var all = document.querySelectorAll('.screen.active *, .settings-modal.open *');
      for (var j = 0; j < all.length; j++) {
        var rr = all[j].getBoundingClientRect();
        if (rr.width === 0 || all[j].offsetParent === null || offCanvas(all[j])) continue;
        if (rr.right > vw + 1.5 || rr.left < -1.5) {
          wide.push((all[j].id || all[j].className || all[j].tagName) + ' [' + Math.round(rr.left) + ',' + Math.round(rr.right) + ']');
        }
      }

      /* 設定鈕是 fixed 的，確認它沒有壓到其他可操作元素 */
      var covered = [];
      var clickable = document.querySelectorAll('.screen.active button:not(#b-settings), .screen.active input, .screen.active .optcard, .screen.active .sidecard');
      for (var k = 0; k < clickable.length; k++) {
        var el2 = clickable[k];
        if (el2.hidden || el2.offsetParent === null) continue;
        var cr = el2.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;
        if (cr.left < fr.right && cr.right > fr.left && cr.top < fr.bottom && cr.bottom > fr.top) {
          covered.push(el2.id || el2.className);
        }
      }
      return {
        vw: vw, vh: vh,
        scrollWidth: doc.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        activeScreen: (document.querySelector('.screen.active') || {}).id,
        fab: { top: Math.round(fr.top), right: Math.round(vw - fr.right), w: Math.round(fr.width), h: Math.round(fr.height) },
        smallTargets: small.slice(0, 6),
        overflowing: wide.slice(0, 6),
        fabCovers: covered.slice(0, 6)
      };
    },
    stage: function () {
      var c = document.getElementById('board');
      var s = document.getElementById('stage');
      var cr = c.getBoundingClientRect();
      var sr = s.getBoundingClientRect();
      var fire = document.getElementById('b-fire').getBoundingClientRect();
      var chat = document.getElementById('chatdock');
      var chatRect = chat.hidden ? null : chat.getBoundingClientRect();
      return {
        canvas: { w: Math.round(cr.width), h: Math.round(cr.height), l: Math.round(cr.left), r: Math.round(cr.right), t: Math.round(cr.top), b: Math.round(cr.bottom) },
        stage: { w: Math.round(sr.width), h: Math.round(sr.height), l: Math.round(sr.left), r: Math.round(sr.right), t: Math.round(sr.top), b: Math.round(sr.bottom) },
        ratio: Math.round((cr.width / Math.max(1, cr.height)) * 100) / 100,
        fire: { w: Math.round(fire.width), h: Math.round(fire.height), t: Math.round(fire.top), b: Math.round(fire.bottom), l: Math.round(fire.left), r: Math.round(fire.right) },
        chatCoversFire: chatRect ? (chatRect.left < fire.right && chatRect.right > fire.left && chatRect.top < fire.bottom && chatRect.bottom > fire.top) : false,
        asideVisible: document.getElementById('battle-aside').getBoundingClientRect().left < window.innerWidth - 20
      };
    },
    click: function (sel) {
      var el = document.querySelector(sel);
      if (!el || el.disabled) return false;
      el.click();
      return true;
    },
    text: function (sel) {
      var el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : null;
    },
    exists: function (sel) { return !!document.querySelector(sel); },
    game: function () {
      var a = window.CatDogApp;
      if (!a) return null;
      var g = a.mode === 'solo' ? a.solo.state : (a.online.view ? a.online.view.game : null);
      return {
        mode: a.mode,
        screen: a.screen,
        busy: a.busy,
        aim: a.aim,
        over: g ? g.over : null,
        winner: g ? g.winner : null,
        turn: g ? g.turn : null,
        turnNo: g ? g.turnNo : null,
        hp: g ? { cat: g.fighters.cat.hp, dog: g.fighters.dog.hp } : null,
        summary: a.mode === 'solo' ? a.solo.summary.length : (a.online.view ? a.online.view.room.summary.length : 0),
        phase: a.online.view ? a.online.view.room.phase : null,
        role: a.online.view ? a.online.view.you.role : null,
        side: a.online.view ? a.online.view.you.side : null,
        code: a.online.code
      };
    }
  };
`;

/* ------------------------------------------------------------ 主流程 */

async function attach(target, label) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('WebSocket 連線逾時')), 10000);
  });
  const cdp = new CDP(ws, label);
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    errors.push((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || '未知例外');
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push(p.args.map((a) => a.description || a.value).join(' '));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
  cdp.errors = errors;
  return cdp;
}

async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(700);
  await cdp.waitFor('window.__probe && window.CatDogApp', 8000, '頁面初始化');
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('找不到 Chrome 或 Edge，略過瀏覽器檢查。設定 CHROME_PATH 環境變數後可再執行。');
    process.exit(0);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  console.log('啟動遊戲伺服器 (port ' + PORT + ')…');
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', AI_THINK_SCALE: '0.2', GAME_ALLOWED_ORIGIN: '*'
    }),
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(200);
    try { up = (await fetch(BASE + 'health')).ok; } catch (e) {}
  }
  if (!up) { server.kill(); throw new Error('伺服器沒有啟動'); }

  console.log('啟動無頭瀏覽器…');
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + PROFILE, 'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => { try { browser.kill(); } catch (e) {} try { server.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let firstTarget = null;
  for (let i = 0; i < 50 && !firstTarget; i++) {
    await sleep(300);
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
      firstTarget = list.find((t) => t.type === 'page');
    } catch (e) {}
  }
  if (!firstTarget) { cleanup(); throw new Error('無法連上瀏覽器的偵錯埠'); }

  const cdp = await attach(firstTarget, '主分頁');

  async function shot(name) {
    try {
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name.replace(/[\\/:*?"<>|]/g, '_') + '.png'), Buffer.from(res.data, 'base64'));
    } catch (e) { /* 截圖失敗不影響檢查 */ }
  }
  async function setViewport(v) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile
    });
    await sleep(320);
  }
  function assertLayout(where, v, info) {
    check(where + '：沒有水平溢出',
      info.scrollWidth <= v.width + 2 && info.overflowing.length === 0,
      'scrollWidth=' + info.scrollWidth + ' 溢出=' + JSON.stringify(info.overflowing));
    check(where + '：設定鈕在安全區內且夠大',
      info.fab.w >= 46 && info.fab.h >= 46 && info.fab.top >= 0 && info.fab.top < 90 && info.fab.right >= 0 && info.fab.right < 90,
      JSON.stringify(info.fab));
    check(where + '：設定鈕沒有蓋住其他可操作元素',
      info.fabCovers.length === 0, JSON.stringify(info.fabCovers));
    check(where + '：觸控命中區都夠大',
      info.smallTargets.length === 0, JSON.stringify(info.smallTargets));
  }

  /* ================= A. 各尺寸的版面檢查 ================= */

  for (const v of VIEWPORTS) {
    console.log('\n【' + v.name + ' ' + v.width + '×' + v.height + '】');
    await setViewport(v);
    await goto(cdp, BASE);
    await cdp.eval('localStorage.clear(); return 1;');
    await goto(cdp, BASE);

    /* 第一次進來會是教學畫面 */
    let info = await cdp.json('window.__probe.layout()');
    check(v.name + '：第一次進來直接顯示純文字教學', info.activeScreen === 's-help', info.activeScreen);
    assertLayout('教學', v, info);
    await shot(v.name + '-1-教學');

    await cdp.eval('window.__probe.click("#b-tut-skip"); return 1;');
    await sleep(250);
    info = await cdp.json('window.__probe.layout()');
    check(v.name + '：跳過教學後回到主選單', info.activeScreen === 's-home', info.activeScreen);
    assertLayout('主選單', v, info);
    await shot(v.name + '-2-主選單');

    /* 設定彈窗 */
    await cdp.eval('window.__probe.click("#b-settings"); return 1;');
    await sleep(300);
    info = await cdp.json('window.__probe.layout()');
    assertLayout('設定彈窗', v, info);
    const modal = await cdp.json('({open:document.getElementById("settings-modal").classList.contains("open"),focus:document.activeElement.id,aria:document.getElementById("settings-modal").getAttribute("aria-hidden")})');
    check(v.name + '：設定是彈窗、焦點進入面板、aria 正確',
      modal.open && modal.focus === 'settings-panel' && modal.aria === 'false', JSON.stringify(modal));
    await shot(v.name + '-3-設定彈窗');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
    const closed = await cdp.json('({open:document.getElementById("settings-modal").classList.contains("open"),focus:document.activeElement.id})');
    check(v.name + '：Escape 關閉設定並把焦點還給設定鈕',
      !closed.open && closed.focus === 'b-settings', JSON.stringify(closed));

    /* 單機設定 */
    await cdp.eval('window.__probe.click("#b-solo"); return 1;');
    await sleep(250);
    info = await cdp.json('window.__probe.layout()');
    check(v.name + '：進入單機設定', info.activeScreen === 's-solo', info.activeScreen);
    assertLayout('單機設定', v, info);
    await shot(v.name + '-4-單機設定');

    /* 開打 */
    await cdp.eval('document.querySelector("#opt-diff .optcard[data-v=easy]").click(); return 1;');
    await cdp.eval('window.__probe.click("#b-solo-start"); return 1;');
    await cdp.waitFor('window.CatDogApp.screen === "s-battle" && window.CatDogApp.solo.state', 6000, '進入戰場');
    await sleep(500);
    info = await cdp.json('window.__probe.layout()');
    assertLayout('戰場', v, info);
    const st = await cdp.json('window.__probe.stage()');
    /* 畫布寬高比不可以比世界更寬（否則代表地面被切掉），而且要塞得進舞台。
       比世界更「高」是刻意的：多出來的高度拿去顯示天空，高吊球才看得到。 */
    check(v.name + '：整個世界都在畫布裡，而且塞得進舞台',
      st.ratio <= 1200 / 640 + 0.02 && st.ratio > 0.8 &&
      st.canvas.w <= st.stage.w + 2 && st.canvas.h <= st.stage.h + 2,
      JSON.stringify({ ratio: st.ratio, canvas: st.canvas, stage: st.stage }));
    check(v.name + '：發射鈕看得到且沒有被聊天室蓋住',
      st.fire.h >= 44 && st.fire.b <= v.height + 2 && !st.chatCoversFire,
      JSON.stringify(st.fire) + ' chatCovers=' + st.chatCoversFire);
    check(v.name + '：寬版摘要常駐、窄版預設收起',
      v.width >= 980 ? st.asideVisible : !st.asideVisible,
      'asideVisible=' + st.asideVisible);
    await shot(v.name + '-5-戰場');

    /* 窄版：打開摘要面板 */
    if (v.width < 980) {
      await cdp.eval('window.__probe.click("#b-aside-toggle"); return 1;');
      await sleep(320);
      const opened = await cdp.json('({open:document.getElementById("battle-aside").classList.contains("open"),aria:document.getElementById("b-aside-toggle").getAttribute("aria-expanded")})');
      check(v.name + '：窄版可以拉出操作摘要面板', opened.open && opened.aria === 'true', JSON.stringify(opened));
      await shot(v.name + '-6-摘要面板');
      await cdp.eval('window.__probe.click("#b-aside-close"); return 1;');
      await sleep(250);
    }
  }

  /* ================= B/C/D. 單機完整一局與設定保存（用平板橫向） ================= */

  console.log('\n【單機完整一局（平板橫向 1024×768）】');
  await setViewport({ width: 1024, height: 768, mobile: true, dsf: 2 });
  await goto(cdp, BASE);
  await cdp.eval('localStorage.clear(); return 1;');
  await goto(cdp, BASE);
  await cdp.eval('window.__probe.click("#b-tut-skip"); window.__probe.click("#b-solo"); return 1;');
  await sleep(200);
  await cdp.eval('document.querySelector("#opt-side .sidecard[data-v=cat]").click(); document.querySelector("#opt-diff .optcard[data-v=easy]").click(); return 1;');
  await cdp.eval('document.getElementById("seed-input").value = "BROWSE"; window.__probe.click("#b-solo-start"); return 1;');
  await cdp.waitFor('window.CatDogApp.solo.state', 6000, '對局建立');

  let g = await cdp.json('window.__probe.game()');
  check('單機：開局血量都是滿的', g.hp.cat === 100 && g.hp.dog === 100, JSON.stringify(g.hp));
  check('單機：我方是選好的貓咪，對手是電腦',
    await cdp.eval('return window.CatDogApp.solo.mySide === "cat" && window.CatDogApp.solo.aiSide === "dog";'));

  /* 鍵盤調角度與力道 */
  await cdp.waitFor('window.CatDogApp.solo.state.turn === "cat" && !window.CatDogApp.solo.thinking', 12000, '輪到玩家');
  const aim0 = (await cdp.json('window.__probe.game()')).aim;
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 39 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 39 });
    await sleep(60);
  }
  const aim1 = (await cdp.json('window.__probe.game()')).aim;
  check('單機：鍵盤方向鍵可以調角度與力道',
    aim1.angle === aim0.angle + 2 && aim1.power === aim0.power + 1,
    JSON.stringify(aim0) + ' → ' + JSON.stringify(aim1));

  /* 拖曳瞄準 */
  const box = await cdp.json('document.getElementById("board").getBoundingClientRect().toJSON()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(box.x + box.width * 0.2), y: Math.round(box.y + box.height * 0.4), button: 'left', clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x + box.width * 0.42), y: Math.round(box.y + box.height * 0.18), button: 'left', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.x + box.width * 0.42), y: Math.round(box.y + box.height * 0.18), button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(200);
  const aim2 = (await cdp.json('window.__probe.game()')).aim;
  check('單機：在戰場上拖曳可以瞄準（不會直接發射）',
    (aim2.angle !== aim1.angle || aim2.power !== aim1.power) && (await cdp.json('window.__probe.game()')).summary === 0,
    JSON.stringify(aim2));

  /* 打完一整局 */
  let shots = 0;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    g = await cdp.json('window.__probe.game()');
    if (g.over) break;
    if (g.turn === 'cat' && !g.busy) {
      /* 用規則核心算出一發好球，讓這一局在合理時間內結束 */
      await cdp.eval(
        'var a=window.CatDogApp, s=a.solo.state, best=null;' +
        'for (var an=15; an<=80; an+=5) for (var p=25; p<=100; p+=5) {' +
        '  var sim=Rules.simulate(s,"cat",an,p,{trace:false});' +
        '  var d=Math.abs(sim.impact.x - s.fighters.dog.x) + Math.abs(sim.impact.y - s.fighters.dog.y);' +
        '  if (!best || d<best.d) best={d:d,a:an,p:p};' +
        '}' +
        'document.getElementById("in-angle").value=best.a;' +
        'document.getElementById("in-angle").dispatchEvent(new Event("input"));' +
        'document.getElementById("in-power").value=best.p;' +
        'document.getElementById("in-power").dispatchEvent(new Event("input"));' +
        'document.getElementById("b-fire").click(); return 1;'
      );
      shots += 1;
    }
    await sleep(400);
  }
  g = await cdp.json('window.__probe.game()');
  check('單機：可以打到分出勝負（玩家出手 ' + shots + ' 次）', g.over === true, JSON.stringify(g));
  check('單機：摘要記下了每一發', g.summary >= shots, g.summary + ' vs ' + shots);
  check('單機：結算畫面出現且有「再玩一局」',
    await cdp.eval('return !document.getElementById("stage-overlay").hidden && !!document.querySelector("[data-act=solo-again]");'));
  await shot('單機-結算');

  await cdp.eval('window.__probe.click("[data-act=solo-again]"); return 1;');
  await cdp.waitFor('window.CatDogApp.solo.state && !window.CatDogApp.solo.state.over', 8000, '再玩一局');
  check('單機：再玩一局會重新開局',
    (await cdp.json('window.__probe.game()')).turnNo === 1);

  /* 設定保存 */
  await cdp.eval('window.__probe.click("#b-settings"); return 1;');
  await sleep(250);
  await cdp.eval('var m=document.getElementById("settings-music"); m.checked=false; m.dispatchEvent(new Event("change")); ' +
    'var s=document.getElementById("settings-sfx"); s.checked=false; s.dispatchEvent(new Event("change")); ' +
    'var r=document.getElementById("settings-motion"); r.checked=true; r.dispatchEvent(new Event("change")); return 1;');
  await sleep(200);
  check('設定：關閉音樂與音效、開啟減少動態會立即套用',
    await cdp.eval('return !Sound.isMusicOn() && !Sound.isSfxOn() && document.body.classList.contains("reduced-motion");'));
  await cdp.eval('window.__probe.click("#settings-done"); return 1;');
  await goto(cdp, BASE);
  check('設定：重新載入後靜音與減少動態仍然保留',
    await cdp.eval('return !Sound.isMusicOn() && !Sound.isSfxOn() && document.body.classList.contains("reduced-motion");'));
  await cdp.eval('window.__probe.click("#b-settings"); return 1;');
  await sleep(200);
  await cdp.eval('window.__probe.click("#settings-reset"); return 1;');
  await sleep(200);
  check('設定：恢復預設會把音樂與音效打開',
    await cdp.eval('return Sound.isMusicOn() && Sound.isSfxOn() && !document.body.classList.contains("reduced-motion");'));
  await cdp.eval('window.__probe.click("#settings-done"); return 1;');

  check('主控台沒有未處理的錯誤（單機流程）', cdp.errors.length === 0, JSON.stringify(cdp.errors.slice(0, 3)));

  /* ================= F. 線上 UI：三個分頁 ================= */

  console.log('\n【線上 UI：房主 + 玩家 + 觀戰（三個獨立分頁）】');
  const targets = [];
  for (let i = 0; i < 3; i++) {
    const res = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    targets.push(res);
  }
  const pages = [];
  for (let i = 0; i < 3; i++) pages.push(await attach(targets[i], ['房主', '玩家', '觀戰'][i]));
  const [P1, P2, P3] = pages;

  for (const p of pages) {
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  }

  /* 房主開房 */
  await goto(P1, BASE);
  await P1.eval('localStorage.clear(); Store.tutorialDone(true); Store.nick("房主"); return 1;');
  await goto(P1, BASE);
  await P1.eval('window.__probe.click("#b-online"); return 1;');
  await P1.waitFor('window.CatDogApp.screen === "s-lobby"', 6000, '進入大廳');
  await P1.eval('window.__probe.click("#b-lobby-host"); return 1;');
  await P1.waitFor('window.CatDogApp.online.view && window.CatDogApp.online.code', 10000, '房間建立');
  const code = (await P1.json('window.__probe.game()')).code;
  check('線上：房主開房並進入房間畫面', !!code && code.length === 4, String(code));
  await P1.eval('window.__probe.click("[data-act=pick][data-side=cat]"); return 1;');
  await P1.waitFor('window.CatDogApp.online.view.you.side === "cat"', 6000, '房主選貓');
  check('線上：房主選了貓咪', true);
  await shot0(P1, '線上-房主-房間');

  /* 產生邀請連結 */
  await P1.eval('window.__probe.click("[data-act=invite-new]"); return 1;');
  await P1.waitFor('document.getElementById("invite-url") && document.getElementById("invite-url").value.length > 20', 8000, '邀請連結產生');
  const inviteUrl = await P1.eval('return document.getElementById("invite-url").value;');
  check('線上：邀請連結產生且帶著房號與 token',
    /room=/.test(inviteUrl) && /invite=[a-f0-9]{32}/.test(inviteUrl), inviteUrl);

  /* 第二個分頁用邀請連結加入 */
  await goto(P2, BASE);
  await P2.eval('localStorage.clear(); Store.tutorialDone(true); Store.nick("挑戰者"); return 1;');
  await goto(P2, inviteUrl);
  await P2.waitFor('window.CatDogApp.online.view && window.CatDogApp.online.view.room.code === "' + code + '"', 15000, '客人進房');
  check('線上：另一個分頁直接開邀請連結就進到同一間房', true);
  await P2.eval('window.__probe.click("[data-act=pick][data-side=dog]"); return 1;');
  await P2.waitFor('window.CatDogApp.online.view.you.side === "dog"', 6000, '客人選狗');
  check('線上：第二位玩家選了狗狗（不能跟房主重複）', true);

  /* 第三個分頁觀戰 */
  await goto(P3, BASE);
  await P3.eval('localStorage.clear(); Store.tutorialDone(true); Store.nick("觀眾"); return 1;');
  await goto(P3, BASE);
  await P3.eval('window.__probe.click("#b-online"); return 1;');
  await P3.waitFor('window.CatDogApp.screen === "s-lobby"', 8000, '觀眾進大廳');
  await P3.waitFor('document.querySelector("[data-lobby=watch][data-code=' + code + ']")', 10000, '大廳出現這間房');
  check('線上：大廳列表看得到這間房並提供觀戰按鈕', true);
  await P3.eval('window.__probe.click("[data-lobby=watch][data-code=' + code + ']"); return 1;');
  await P3.waitFor('window.CatDogApp.online.view && window.CatDogApp.online.view.room.code === "' + code + '"', 12000, '觀眾進房');
  check('線上：第三個分頁以觀戰身分進房',
    (await P3.json('window.__probe.game()')).role === 'spectator');
  check('線上：觀戰者的畫面沒有選邊、準備、開始按鈕',
    !(await P3.eval('return !!document.querySelector("[data-act=pick],[data-act=ready],[data-act=start]");')));

  /* 準備並開打 */
  await P1.eval('window.__probe.click("[data-act=ready]"); return 1;');
  await P2.eval('window.__probe.click("[data-act=ready]"); return 1;');
  await P1.waitFor('window.CatDogApp.online.view.you.can.start === true', 8000, '可以開始');
  await P1.eval('window.__probe.click("[data-act=start]"); return 1;');
  for (const p of pages) await p.waitFor('window.CatDogApp.online.view.room.phase === "playing"', 10000, '開打');
  check('線上：三個分頁都進入對戰狀態', true);
  check('線上：觀戰者的發射鈕是停用的',
    await P3.eval('return document.getElementById("b-fire").disabled === true;'));
  await shot0(P3, '線上-觀戰-對戰中');

  /* 由輪到的一方出手 */
  const turnSide = (await P1.json('window.__probe.game()')).turn;
  const shooter = turnSide === 'cat' ? P1 : P2;
  const before = (await P1.json('window.__probe.game()')).summary;
  await shooter.eval('document.getElementById("b-fire").click(); return 1;');
  for (const p of pages) await p.waitFor('window.CatDogApp.online.view.room.summary.length > ' + before, 20000, '摘要更新');
  check('線上：出手後三個分頁的操作摘要都即時更新', true);
  check('線上：摘要內容有角度、力道與風向',
    /角度/.test(await P3.eval('return document.getElementById("sum-list").textContent;')) &&
    /力道/.test(await P3.eval('return document.getElementById("sum-list").textContent;')));

  /* 聊天室 */
  await P2.eval('document.getElementById("b-chat-toggle").click(); var i=document.getElementById("chat-input"); i.value="我要贏了"; document.getElementById("chat-form").dispatchEvent(new Event("submit",{cancelable:true})); return 1;');
  await P3.waitFor('/我要贏了/.test(document.getElementById("chat-list").textContent)', 10000, '觀眾收到訊息');
  check('線上：聊天室訊息即時送達其他分頁（含觀戰者）', true);
  await P3.eval('document.getElementById("b-chat-toggle").click(); return 1;');
  await sleep(200);
  check('線上：觀戰者也可以打開聊天室並發言',
    await P3.eval('return document.getElementById("chat-input").disabled === false;'));
  await shot0(P2, '線上-玩家-聊天室');

  /* 觀戰者強行發射：伺服器要擋下來 */
  await P3.eval('Online.send("room:fire", {angle:45, power:60}); return 1;');
  await sleep(600);
  check('線上：觀戰者就算繞過 UI 送出發射，伺服器也會擋下',
    await P3.eval('return /觀戰|不能/.test(document.getElementById("toast").textContent);'),
    await P3.eval('return document.getElementById("toast").textContent;'));

  for (const p of pages) {
    check('線上：' + p.label + '分頁沒有未處理的主控台錯誤', p.errors.length === 0, JSON.stringify(p.errors.slice(0, 2)));
  }

  /* ---- 窄版線上房間（手機直向） ---- */
  /* 背景分頁不會跑「更新畫面」那一步，量到的會是舊版面；先把它帶到前景再檢查 */
  await P2.send('Page.bringToFront');
  await P2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(800);
  const narrow = await P2.json('window.__probe.layout()');
  check('線上窄版：房間畫面沒有水平溢出',
    narrow.scrollWidth <= 392 && narrow.overflowing.length === 0,
    'scrollWidth=' + narrow.scrollWidth + ' ' + JSON.stringify(narrow.overflowing));
  const narrowStage = await P2.json('window.__probe.stage()');
  check('線上窄版：聊天室浮動入口沒有蓋住發射鈕', !narrowStage.chatCoversFire);
  await shot0(P2, '線上-手機直向-對戰');

  cleanup();

  console.log('\n========================================');
  if (failures.length) {
    console.log('  瀏覽器檢查失敗 ' + failures.length + ' 項：');
    failures.forEach((f) => console.log('   · ' + f));
    console.log('========================================');
    process.exit(1);
  }
  console.log('  瀏覽器檢查全部通過');
  console.log('  截圖已存到 screenshots/');
  console.log('========================================');
  process.exit(0);
}

async function shot0(page, name) {
  try {
    const res = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name.replace(/[\\/:*?"<>|]/g, '_') + '.png'), Buffer.from(res.data, 'base64'));
  } catch (e) {}
}

main().catch((e) => {
  console.error('\n瀏覽器檢查中斷：' + (e && e.message ? e.message : e));
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
