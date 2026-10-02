(function (root) {
  'use strict';

  const script = document.currentScript;
  const skin = script && script.dataset.skin || 'cat-dog-war';
  const icons = {
    'cat-dog-war': '<path d="M5 19 8 8l5 6 3-4 4 9H5Z"/><path d="M20 6v4m-2-2h4"/>',
    'caterpillar-race': '<circle cx="7" cy="19" r="4"/><circle cx="14" cy="17" r="4"/><circle cx="21" cy="14" r="4"/><path d="m7 8 2-3m5 4 2-3m5 3 2-3"/>',
    'chinese-checkers': '<path d="m16 3 3.5 7.2L27 11l-5.5 5.4 1.3 7.6L16 20.4 9.2 24l1.3-7.6L5 11l7.5-.8L16 3Z"/>',
    'draw-guess': '<path d="m6 20 2-5L19 4l5 5-11 11-7 1Z"/><path d="m17 6 5 5M8 15l5 5"/>',
    'flip-match': '<rect x="5" y="5" width="14" height="19" rx="3"/><path d="M10 5V3h11a3 3 0 0 1 3 3v14h-5M10 12h4m-2-2v4"/>',
    'fruit-link': '<circle cx="9" cy="16" r="6"/><circle cx="22" cy="16" r="6"/><path d="M14 16h3M9 10V7l3-2m10 5V7l-3-2"/>',
    'heart-attack': '<path d="M16 25S4 18 4 10a5 5 0 0 1 9-3l3 3 3-3a5 5 0 0 1 9 3c0 8-12 15-12 15Z"/><path d="M3 16h6l3-5 4 10 3-5h10"/>',
    'richman': '<circle cx="16" cy="16" r="11"/><path d="M19 11c-1-2-7-2-7 1 0 4 8 1 8 5s-7 4-9 1m5-10v16"/>',
    'stair-kids': '<path d="M4 23h7v-6h6v-6h6V5"/><path d="m18 8 5-3-1 6"/>',
    'sudoku': '<rect x="4" y="4" width="24" height="24" rx="3"/><path d="M12 4v24M20 4v24M4 12h24M4 20h24M8 8h.1M16 16h.1M24 24h.1"/>',
    'whack-a-mole': '<path d="M5 24c0-6 4-10 11-10s11 4 11 10H5Z"/><path d="m10 15-2-6 6 3m8 3 2-6-6 3"/><circle cx="13" cy="19" r="1"/><circle cx="19" cy="19" r="1"/>'
  };

  let meter = null;
  let active = false;
  let value = null;
  let probe = null;
  let timer = 0;
  let probeSequence = 0;
  let boundSocket = null;
  let dockTimer = 0;
  let lastLayout = '';
  // 各遊戲右上角的設定鈕：徽章以它為基準擺放，但絕不疊在它上面
  const anchorSelector = '#b-settings, #btn-gear, #btn-settings, #btn-settings-game, #btn-settings-global, .settings-fab, .gear-btn, .settings-trigger';
  // 頂端本來就有狀態列的遊戲：直接當成狀態列裡的一顆小標籤，不另外浮在畫面上
  const inlineHosts = {
    'chinese-checkers': { host: '#view-game .topbar-left' },
    'draw-guess': { host: '#s-game .statusbar' },
    'stair-kids': { host: '#screen-game #side', before: '#side-world' }
  };
  const GAP = 6;

  function ensureMeter() {
    if (meter) return meter;
    meter = document.createElement('div');
    meter.id = 'network-latency';
    meter.className = 'latency-meter is-unknown';
    meter.dataset.skin = skin;
    meter.hidden = true;
    meter.setAttribute('role', 'status');
    meter.setAttribute('aria-live', 'off');
    meter.innerHTML = '<svg class="latency-meter__icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
      (icons[skin] || icons['cat-dog-war']) +
      '</svg><span class="latency-meter__light" aria-hidden="true"></span><span class="latency-meter__value">--</span><span class="latency-meter__unit">ms</span>';
    document.body.appendChild(meter);
    return meter;
  }

  function isShown(el) {
    if (!el || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function findAnchor() {
    let best = null;
    let bestRect = null;
    document.querySelectorAll(anchorSelector).forEach(function (btn) {
      if (!isShown(btn)) return;
      const r = btn.getBoundingClientRect();
      if (r.bottom <= 0 || r.top > 160) return;
      // 有多顆時取最靠右上的那顆
      if (!bestRect || r.right > bestRect.right + 4 || (Math.abs(r.right - bestRect.right) <= 4 && r.top < bestRect.top)) {
        best = btn;
        bestRect = r;
      }
    });
    return best ? { el: best, rect: bestRect } : null;
  }

  // 沿用設定鈕所在的最外層堆疊層級：徽章與設定鈕同層，開彈窗時一樣會被蓋住
  function stackLevel(el) {
    let level = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const z = parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(z)) level = z;
    }
    return level;
  }

  const replaced = /^(IMG|SVG|CANVAS|VIDEO|BUTTON|INPUT|SELECT|TEXTAREA|PROGRESS|METER)$/i;
  const clearColor = /rgba\(.*,\s*0\)|transparent/;
  function hasVisibleBorder(style) {
    return ['Top', 'Right', 'Bottom', 'Left'].some(function (side) {
      return parseFloat(style['border' + side + 'Width']) > 0 && style['border' + side + 'Style'] !== 'none' &&
        !clearColor.test(style['border' + side + 'Color']);
    });
  }
  function paints(el, style) {
    if (replaced.test(el.tagName)) return true;
    if (!clearColor.test(style.backgroundColor)) return true;
    if (style.backgroundImage !== 'none' || style.boxShadow !== 'none' || hasVisibleBorder(style)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  // 候選位置是否空著：有任何看得見的按鈕、文字、卡片、盤面邊框就算佔用；
  // 鋪滿大片、沒有框線的背景層（畫面底色、整張背景畫布）與淡淡的裝飾不算
  function isClear(box) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (box.left < 2 || box.top < 2 || box.right > vw - 2 || box.bottom > vh - 2) return false;
    const big = vw * vh * 0.12;
    const all = document.body.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el === meter || meter.contains(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      if (el instanceof SVGElement && el.ownerSVGElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right < box.left - 3 || r.left > box.right + 3 || r.bottom < box.top - 3 || r.top > box.bottom + 3) continue;
      const style = getComputedStyle(el);
      // 半透明的裝飾（背景泡泡、光暈）視為背景
      if (style.visibility === 'hidden' || Number(style.opacity) < 0.5) continue;
      if (r.width * r.height > big) {
        // 大片元素只有「邊框剛好落在徽章範圍內」才算撞到（例如盤面外框）
        if (!hasVisibleBorder(style)) continue;
        if (r.left < box.left - 3 && r.right > box.right + 3 && r.top < box.top - 3 && r.bottom > box.bottom + 3) continue;
        return false;
      }
      if (paints(el, style)) return false;
    }
    return true;
  }

  function placeAt(x, y) {
    meter.style.left = Math.round(x) + 'px';
    meter.style.top = Math.round(y) + 'px';
  }

  function setInline(host, before) {
    meter.classList.add('is-inline');
    meter.classList.remove('is-docked', 'is-compact');
    meter.style.left = meter.style.top = meter.style.zIndex = '';
    const ref = before && host.querySelector(before);
    if (ref ? meter.nextElementSibling !== ref : meter.parentElement !== host) host.insertBefore(meter, ref || null);
  }

  function dock(force) {
    if (!meter || !active) return;
    const inline = inlineHosts[skin];
    const host = inline && document.querySelector(inline.host);
    if (host && isShown(host)) { lastLayout = 'inline'; setInline(host, inline.before); return; }

    const anchor = findAnchor();
    // 設定鈕位置與視窗大小沒變時：已經在最好的位置（左邊）就不動，提示泡泡之類一閃而過的東西不會讓徽章跳走；
    // 若當初因為被擋住而退到次要位置，則持續檢查，空出來就搬回左邊
    const r = anchor && anchor.rect;
    const layout = r ? [r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight].map(Math.round).join(',') : 'none';
    if (force !== true && layout === lastLayout && (!anchor || meter.dataset.spot === 'left')) return;
    lastLayout = layout;

    meter.classList.remove('is-inline');
    if (meter.parentElement !== document.body) document.body.appendChild(meter);
    if (!anchor) {
      meter.classList.remove('is-docked', 'is-compact');
      meter.style.left = meter.style.top = meter.style.zIndex = '';
      return;
    }
    const level = stackLevel(anchor.el);
    meter.classList.add('is-docked');
    meter.style.zIndex = level === null ? '' : String(level);

    // 依序嘗試：設定鈕左邊同一列 → 設定鈕正下方（留空隙）；都不行就改用不含單位的精簡版再試一次
    const spots = [
      function (w, h) { return { left: r.left - GAP - w, top: r.top + (r.height - h) / 2 - 1 }; },
      function (w, h) { return { left: r.right - w, top: r.bottom + GAP }; }
    ];
    for (let pass = 0; pass < 2; pass++) {
      meter.classList.toggle('is-compact', pass === 1);
      const w = meter.offsetWidth;
      const h = meter.offsetHeight;
      for (let i = 0; i < spots.length; i++) {
        const p = spots[i](w, h);
        if (isClear({ left: p.left, top: p.top, right: p.left + w, bottom: p.top + h })) {
          meter.dataset.spot = (pass ? 'compact-' : '') + (i ? 'below' : 'left');
          placeAt(p.left, p.top);
          return;
        }
      }
    }
    // 真的都滿了：精簡版放在設定鈕正下方，至少不壓住設定鈕
    meter.dataset.spot = 'fallback';
    placeAt(r.right - meter.offsetWidth, r.bottom + GAP);
  }

  function render() {
    const el = ensureMeter();
    el.hidden = !active;
    el.classList.remove('is-good', 'is-warn', 'is-bad', 'is-unknown');
    const ms = value === null ? null : Math.round(value);
    const quality = ms === null ? 'unknown' : ms <= 30 ? 'good' : ms < 100 ? 'warn' : 'bad';
    el.classList.add('is-' + quality);
    el.querySelector('.latency-meter__value').textContent = ms === null ? '--' : String(ms);
    el.setAttribute('aria-label', ms === null ? '連線延遲，等待回應' : '連線延遲 ' + ms + ' 毫秒');
    el.title = ms === null ? '連線延遲：等待回應' : '連線延遲：' + ms + ' ms';
    dock();
  }

  function report(ms) {
    value = Number.isFinite(ms) && ms >= 0 ? ms : null;
    render();
  }

  function runProbe() {
    if (!active || !probe) return;
    try { probe(); } catch (e) { report(null); }
  }

  function setProbe(fn) {
    probe = typeof fn === 'function' ? fn : null;
    if (active) runProbe();
  }

  function setActive(on) {
    const next = !!on;
    if (active === next) return;
    active = next;
    clearInterval(timer);
    clearInterval(dockTimer);
    timer = 0;
    dockTimer = 0;
    lastLayout = '';
    if (!active) {
      value = null;
      render();
      return;
    }
    render();
    runProbe();
    timer = setInterval(runProbe, 2500);
    // 設定鈕會隨畫面切換、橫直向改變位置，定時跟上
    dock(true);
    dockTimer = setInterval(dock, 1000);
  }

  function bindSocketIo(socket) {
    boundSocket = socket;
    setProbe(function () {
      if (boundSocket !== socket || !socket.connected) { report(null); return; }
      const started = performance.now();
      const seq = ++probeSequence;
      const timeout = setTimeout(function () { if (seq === probeSequence) report(null); }, 4500);
      socket.emit('latency:ping', started, function () {
        clearTimeout(timeout);
        if (boundSocket === socket && seq === probeSequence) report(performance.now() - started);
      });
    });
    socket.on('disconnect', function () {
      if (boundSocket === socket) report(null);
    });
  }

  root.addEventListener('resize', function () { dock(true); });

  root.NetworkLatency = { setActive, setProbe, report, bindSocketIo };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureMeter, { once: true });
  else ensureMeter();
})(window);
