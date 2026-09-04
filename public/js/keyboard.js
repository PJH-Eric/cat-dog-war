/*
 * keyboard.js — 手機／平板軟體鍵盤修正（聊天室輸入框不再被鍵盤蓋住）
 *
 * 【問題】
 * 遊戲版面是滿版固定高度（body 設 overflow:hidden、#app 高度 100dvh），
 * 但手機瀏覽器彈出軟體鍵盤時不一定會縮小版面：
 *   - iOS Safari：完全不縮版面，只是把鍵盤疊在畫面下半部
 *   - Android Chrome：預設只縮 visual viewport，版面高度不變
 * 於是位在底部的聊天室輸入框會被鍵盤整條蓋住，而畫面又沒有可捲動空間，
 * 使用者點了輸入框卻看不到自己打的字，感覺就像「手機上沒辦法打字」。
 *
 * 【做法】
 * 用 visualViewport 量出真正看得到的高度與鍵盤遮住的高度，寫成 CSS 變數：
 *   --app-h  目前真正可見的高度（樣式拿它當滿版高度；沒有鍵盤時不設定）
 *   --kb     鍵盤遮住的高度（沒有鍵盤時為 0px）
 * 同時在 <body> 掛上 kb-open，讓固定定位（position:fixed）的聊天面板可以
 * 往上讓開。輸入框聚焦後再分次把它捲進可見範圍，舊版瀏覽器沒有
 * visualViewport 時這層也還能保底。
 *
 * 【使用】
 * 要在其他遊戲程式之前載入，不依賴任何函式庫，不需要初始化。
 */
(function (w, d) {
  'use strict';

  var root = d.documentElement;
  var vv = w.visualViewport || null;

  var KB_MIN = 90;      /* 遮住不到這個高度就不算鍵盤（例如網址列伸縮） */
  var ZOOM_MAX = 1.05;  /* 使用者放大頁面時 visualViewport 也會變小，要排除 */
  var NUDGE_MS = 120;   /* 鍵盤是動畫升起的，量測要分幾次補做 */
  var NUDGE_MAX = 6;

  var pending = 0;
  var nudge = 0;

  /* 判斷是不是真的可以打字的欄位（按鈕、核取方塊之類的不算） */
  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    var t = String(el.type || 'text').toLowerCase();
    return t !== 'button' && t !== 'submit' && t !== 'reset' &&
      t !== 'checkbox' && t !== 'radio' && t !== 'range' &&
      t !== 'file' && t !== 'color' && t !== 'image' && t !== 'hidden';
  }

  function zoomed() {
    return !!(vv && vv.scale && vv.scale > ZOOM_MAX);
  }

  /* 目前真正看得到的高度 */
  function visibleHeight() {
    if (vv && !zoomed()) return Math.round(vv.height);
    return w.innerHeight || root.clientHeight || 0;
  }

  /* 鍵盤遮住的高度；量不出來就當成 0 */
  function keyboardHeight() {
    if (!vv || zoomed()) return 0;
    var full = w.innerHeight || root.clientHeight || 0;
    var gap = Math.round(full - vv.height - vv.offsetTop);
    return gap >= KB_MIN ? gap : 0;
  }

  function apply() {
    pending = 0;
    /* 只有在打字時才縮版面，避免單純捲動或縮放時版面亂跳 */
    var kb = isTextField(d.activeElement) ? keyboardHeight() : 0;
    root.style.setProperty('--kb', kb + 'px');
    if (kb) root.style.setProperty('--app-h', visibleHeight() + 'px');
    else root.style.removeProperty('--app-h');
    if (d.body) {
      if (kb) d.body.classList.add('kb-open');
      else d.body.classList.remove('kb-open');
    }
    return kb;
  }

  function schedule() {
    if (pending) return;
    pending = w.requestAnimationFrame ? w.requestAnimationFrame(apply) : w.setTimeout(apply, 16);
  }

  /* 往上捲 delta 像素：先用內層的捲動容器，剩下的交給整頁 */
  function scrollUp(el, delta) {
    var n = el.parentElement;
    while (n && delta > 0) {
      var oy = w.getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
        var before = n.scrollTop;
        n.scrollTop = before + delta;
        delta -= (n.scrollTop - before);
      }
      n = n.parentElement;
    }
    if (delta > 0) {
      if (w.scrollBy) w.scrollBy(0, delta);
      else w.scrollTo(0, (w.pageYOffset || 0) + delta);
    }
  }

  /* 輸入框若被鍵盤蓋住，就把它捲回可見範圍 */
  function keepVisible(el) {
    if (!el || !el.getBoundingClientRect) return;
    var limit = visibleHeight() - 10;
    var box = el.getBoundingClientRect();
    if (box.top >= 4 && box.bottom <= limit) return;
    /* 先讓瀏覽器把它捲進版面裡（這一步會處理內層的捲動容器） */
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    catch (e) { el.scrollIntoView(false); }
    /* scrollIntoView 只認得版面高度、不知道鍵盤蓋住多少，差額要自己補 */
    box = el.getBoundingClientRect();
    var delta = Math.round(box.bottom - limit);
    if (delta > 0) scrollUp(el, delta);
  }

  function onFocusIn(ev) {
    var el = ev.target;
    if (!isTextField(el)) return;
    apply();
    w.clearInterval(nudge);
    var tries = 0;
    nudge = w.setInterval(function () {
      tries++;
      /* 沒有 visualViewport 的舊瀏覽器量不到鍵盤，那就一律補捲當保險 */
      if (apply() || !vv) keepVisible(el);
      if (tries >= NUDGE_MAX || d.activeElement !== el) w.clearInterval(nudge);
    }, NUDGE_MS);
  }

  function onFocusOut() {
    w.clearInterval(nudge);
    /* 收鍵盤時 iOS 會晚一點才把 visualViewport 還原，補量兩次 */
    w.setTimeout(schedule, 60);
    w.setTimeout(schedule, 320);
  }

  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
  w.addEventListener('resize', schedule);
  w.addEventListener('orientationchange', function () { w.setTimeout(schedule, 250); });
  d.addEventListener('focusin', onFocusIn, true);
  d.addEventListener('focusout', onFocusOut, true);

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', apply);
  else apply();

  /* 給其他程式與自動測試查詢用 */
  w.KeyboardFix = {
    refresh: apply,
    keepVisible: keepVisible,
    visibleHeight: visibleHeight,
    keyboardHeight: keyboardHeight
  };
})(window, document);
