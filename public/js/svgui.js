/* ===== svgui.js — 立體 SVG 按鈕、標題 LOGO、貓狗頭像、背景裝飾 =====
 *
 * 按鈕外觀是依元素實際尺寸即時畫出來的 SVG，所以縮放時不會被拉扁，
 * 也保證有「上層面 + 較深底座 + 高光」的區塊立體感。
 * 文字仍然是 HTML，不會烘焙進圖裡，方便本地化與螢幕閱讀器。
 */
(function (w) {
  'use strict';
  var INK = '#4A3B55';

  var PALETTE = {
    grape: ['#C9B6F5', '#A48FDB'],
    peach: ['#FFC2B4', '#E89C8B'],
    mint:  ['#A9E7D2', '#79C6AC'],
    sky:   ['#AED9F5', '#7FB4DA'],
    lemon: ['#FFE3A0', '#E7C263'],
    cream: ['#FFF0DE', '#E6D2B4'],
    rose:  ['#FFB8CF', '#E88CAA'],
    gray:  ['#E9E3EE', '#C8BFD1']
  };

  /* 貓＝橘奶油色，狗＝奶茶棕色；戰場、頭像、血條、聊天室都用同一組 */
  var SIDE_COLOR = {
    cat: { body: '#FFE0C2', dark: '#F0BC8E', accent: '#FFB8CF', ink: INK },
    dog: { body: '#E3CBAE', dark: '#C2A17C', accent: '#AED9F5', ink: INK }
  };

  /* ---- 立體按鈕 ---- */
  function paint(el) {
    var wpx = el.offsetWidth, hpx = el.offsetHeight;
    if (!wpx || !hpx) return;
    var cs = getComputedStyle(el);
    var d = parseFloat(cs.getPropertyValue('--d')) || 8;
    var key = el.getAttribute('data-color') || 'cream';
    var c = PALETTE[key] || PALETTE.cream;
    var faceH = hpx - d - 4;
    if (faceH < 10) return;
    var r = Math.min(20, faceH / 2.2);
    var svg = el.querySelector('.b3-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'b3-svg');
      svg.setAttribute('aria-hidden', 'true');
      el.insertBefore(svg, el.firstChild);
    }
    svg.setAttribute('viewBox', '0 0 ' + wpx + ' ' + hpx);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<rect x="2" y="' + (2 + d) + '" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[1] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<g class="b3-face">' +
      '<rect x="2" y="2" width="' + (wpx - 4) + '" height="' + faceH + '" rx="' + r + '" fill="' + c[0] + '" stroke="' + INK + '" stroke-width="3"/>' +
      '<rect x="' + (r * 0.55 + 4) + '" y="7" width="' + Math.max(4, wpx - 8 - r * 1.1) + '" height="' + Math.max(4, faceH * 0.36) + '" rx="' + (r * 0.5) + '" fill="#FFFFFF" opacity="0.45"/>' +
      '</g>';
  }

  var ro = w.ResizeObserver ? new ResizeObserver(function (list) {
    for (var i = 0; i < list.length; i++) paint(list[i].target);
  }) : null;

  function decorate(el) {
    if (el.dataset.b3) return;
    el.dataset.b3 = '1';
    var lbl = document.createElement('span');
    lbl.className = 'b3-lbl';
    lbl.innerHTML = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(lbl);
    paint(el);
    if (ro) ro.observe(el); else w.addEventListener('resize', function () { paint(el); });

    var press = function () { if (!el.disabled) el.classList.add('press'); };
    var release = function () { el.classList.remove('press'); };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
  }

  function decorateAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }
  function repaintAll(root) {
    var list = (root || document).querySelectorAll('.btn3d');
    for (var i = 0; i < list.length; i++) paint(list[i]);
  }

  function setLabel(el, html) {
    var lbl = el.querySelector('.b3-lbl');
    if (lbl) lbl.innerHTML = html; else el.innerHTML = html;
  }
  function setColor(el, key) {
    el.setAttribute('data-color', key);
    paint(el);
  }

  /* ---- 貓咪頭像 ----
   * mood: idle | happy | hurt | win | lose | aim
   * 受傷時換成哭哭眼、眼淚和嘴巴，輪廓不動，讓玩家一眼認得出是同一隻。 */
  function catFace(mood) {
    var c = SIDE_COLOR.cat;
    return '<g>' +
      '<path d="M18 30 L12 6 L40 20 Z" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<path d="M82 30 L88 6 L60 20 Z" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<rect x="10" y="20" width="80" height="72" rx="32" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +
      eyes(mood, 36, 52, 64, 52) +
      tears(mood, 36, 52, 64, 52) +
      '<path d="M46 64 L50 68 L54 64" fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
      mouth(mood, 50, 72) +
      '<ellipse cx="24" cy="66" rx="8" ry="5" fill="' + c.accent + '" opacity="0.8"/>' +
      '<ellipse cx="76" cy="66" rx="8" ry="5" fill="' + c.accent + '" opacity="0.8"/>' +
      '<path d="M4 60 H22 M4 68 H22 M78 60 H96 M78 68 H96" stroke="' + INK + '" stroke-width="3" stroke-linecap="round" opacity="0.55"/>' +
      '</g>';
  }

  /* ---- 狗狗頭像 ---- */
  function dogFace(mood) {
    var c = SIDE_COLOR.dog;
    return '<g>' +
      '<ellipse cx="16" cy="46" rx="13" ry="24" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="5"/>' +
      '<ellipse cx="84" cy="46" rx="13" ry="24" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="5"/>' +
      '<rect x="12" y="20" width="76" height="70" rx="30" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +
      eyes(mood, 37, 50, 63, 50) +
      tears(mood, 37, 50, 63, 50) +
      '<ellipse cx="50" cy="68" rx="22" ry="15" fill="#FFF3E4" stroke="' + INK + '" stroke-width="4"/>' +
      '<ellipse cx="50" cy="62" rx="8" ry="6" fill="' + INK + '"/>' +
      mouth(mood, 50, 74) +
      '</g>';
  }

  function eyes(mood, x1, y1, x2, y2) {
    if (mood === 'hurt') {
      return '<path d="M' + (x1 - 7) + ' ' + (y1 - 6) + ' l14 12 M' + (x1 + 7) + ' ' + (y1 - 6) + ' l-14 12" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>' +
        '<path d="M' + (x2 - 7) + ' ' + (y2 - 6) + ' l14 12 M' + (x2 + 7) + ' ' + (y2 - 6) + ' l-14 12" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>';
    }
    if (mood === 'win' || mood === 'happy') {
      return '<path d="M' + (x1 - 8) + ' ' + (y1 + 3) + ' q8 -11 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>' +
        '<path d="M' + (x2 - 8) + ' ' + (y2 + 3) + ' q8 -11 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>';
    }
    if (mood === 'lose') {
      return '<path d="M' + (x1 - 8) + ' ' + (y1 - 2) + ' q8 10 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>' +
        '<path d="M' + (x2 - 8) + ' ' + (y2 - 2) + ' q8 10 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>';
    }
    if (mood === 'aim') {
      return '<circle cx="' + x1 + '" cy="' + y1 + '" r="6" fill="' + INK + '"/>' +
        '<path d="M' + (x2 - 9) + ' ' + y2 + ' h18" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>';
    }
    return '<circle cx="' + x1 + '" cy="' + y1 + '" r="6.5" fill="' + INK + '"/>' +
      '<circle cx="' + x2 + '" cy="' + y2 + '" r="6.5" fill="' + INK + '"/>' +
      '<circle cx="' + (x1 + 2.5) + '" cy="' + (y1 - 2.5) + '" r="2" fill="#FFFFFF"/>' +
      '<circle cx="' + (x2 + 2.5) + '" cy="' + (y2 - 2.5) + '" r="2" fill="#FFFFFF"/>';
  }

  function tears(mood, x1, y1, x2, y2) {
    if (mood !== 'hurt' && mood !== 'lose') return '';
    return tear(mood, x1, y1) + (x1 === x2 && y1 === y2 ? '' : tear(mood, x2, y2));
  }

  function tear(mood, x, y) {
    if (mood !== 'hurt' && mood !== 'lose') return '';
    return '<path d="M' + x + ' ' + (y + 6) +
      ' C' + (x - 5) + ' ' + (y + 13) + ' ' + (x - 4) + ' ' + (y + 19) + ' ' + x + ' ' + (y + 21) +
      ' C' + (x + 4) + ' ' + (y + 19) + ' ' + (x + 5) + ' ' + (y + 13) + ' ' + x + ' ' + (y + 6) +
      ' Z" fill="#73C9ED" stroke="#4A8DB4" stroke-width="2"/>' +
      '<ellipse cx="' + (x - 1.5) + '" cy="' + (y + 14) + '" rx="1.5" ry="3" fill="#E9FBFF" opacity="0.9"/>';
  }

  function mouth(mood, cx, cy) {
    if (mood === 'hurt' || mood === 'lose') {
      return '<path d="M' + (cx - 10) + ' ' + (cy + 8) + ' q10 -10 20 0" fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round"/>';
    }
    if (mood === 'win' || mood === 'happy') {
      return '<path d="M' + (cx - 12) + ' ' + cy + ' q12 14 24 0" fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round"/>';
    }
    return '<path d="M' + (cx - 9) + ' ' + cy + ' q9 8 18 0" fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round"/>';
  }

  /** 給 UI 用的方形頭像（房間席位、血條、聊天室） */
  function avatar(side, mood, label) {
    var face = side === 'dog' ? dogFace(mood || 'idle') : catFace(mood || 'idle');
    return '<svg viewBox="0 0 100 100" role="img" aria-label="' + (label || (side === 'dog' ? '狗狗' : '貓咪')) + '">' + face + '</svg>';
  }

  /* ---- 彈藥圖示：毛線球與骨頭 ---- */
  function yarn() {
    return '<svg viewBox="0 0 100 100" role="img" aria-label="毛線球">' +
      '<circle cx="50" cy="52" r="34" fill="#FFB8CF" stroke="' + INK + '" stroke-width="6"/>' +
      '<path d="M24 38 q26 14 52 -2 M20 56 q30 16 60 -6 M32 76 q22 6 44 -14" fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round" opacity="0.7"/>' +
      '<path d="M78 30 q14 -12 16 -22" fill="none" stroke="#E88CAA" stroke-width="6" stroke-linecap="round"/>' +
      '</svg>';
  }
  function bone() {
    return '<svg viewBox="0 0 100 100" role="img" aria-label="骨頭">' +
      '<g transform="rotate(-25 50 50)">' +
      '<rect x="26" y="42" width="48" height="16" rx="8" fill="#FFF7E8" stroke="' + INK + '" stroke-width="6"/>' +
      '<circle cx="26" cy="42" r="12" fill="#FFF7E8" stroke="' + INK + '" stroke-width="6"/>' +
      '<circle cx="26" cy="58" r="12" fill="#FFF7E8" stroke="' + INK + '" stroke-width="6"/>' +
      '<circle cx="74" cy="42" r="12" fill="#FFF7E8" stroke="' + INK + '" stroke-width="6"/>' +
      '<circle cx="74" cy="58" r="12" fill="#FFF7E8" stroke="' + INK + '" stroke-width="6"/>' +
      '</g></svg>';
  }

  /* ---- 標題 LOGO：貓和狗隔著圍牆對望 ---- */
  function logo() {
    return '<svg viewBox="0 0 600 220" role="img" aria-label="貓狗大戰">' +
      '<g transform="translate(16 26) scale(0.9)">' + catFace('aim') + '</g>' +
      '<g transform="translate(490 26) scale(0.9)">' + dogFace('aim') + '</g>' +
      /* 中央圍牆 */
      '<g transform="translate(276 26)">' +
        '<rect x="0" y="0" width="48" height="96" rx="8" fill="#E6D2B4" stroke="' + INK + '" stroke-width="5"/>' +
        '<path d="M0 26 H48 M0 52 H48 M0 78 H48 M24 0 V26 M12 26 V52 M36 26 V52 M24 52 V78 M12 78 V96 M36 78 V96" stroke="' + INK + '" stroke-width="3" opacity="0.55"/>' +
      '</g>' +
      /* 飛越圍牆的毛線球與骨頭 */
      '<path d="M120 96 Q300 -6 476 96" fill="none" stroke="#C9B6F5" stroke-width="5" stroke-linecap="round" stroke-dasharray="10 12" opacity="0.75"/>' +
      '<g transform="translate(180 34) scale(0.34)">' + yarn() + '</g>' +
      '<g transform="translate(388 34) scale(0.34)">' + bone() + '</g>' +
      /* 標題文字：先描邊再填色，保持文字可讀且可本地化 */
      '<text x="300" y="176" text-anchor="middle" font-size="60" font-weight="900" letter-spacing="8" ' +
        'style="paint-order:stroke;stroke:' + INK + ';stroke-width:14px;stroke-linejoin:round" fill="#C9B6F5" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">貓狗大戰</text>' +
      '<text x="300" y="176" text-anchor="middle" font-size="60" font-weight="900" letter-spacing="8" fill="#FBF4FF" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">貓狗大戰</text>' +
      '<text x="300" y="209" text-anchor="middle" font-size="19" font-weight="800" letter-spacing="6" fill="#7A6A88" ' +
        'font-family="Yuanti TC, PingFang TC, Microsoft JhengHei, Noto Sans TC, sans-serif">調角度 · 抓力道 · 看風向</text>' +
      '</svg>';
  }

  /* ---- 勝利獎盃 ---- */
  function trophy() {
    return '<svg viewBox="0 0 120 120" role="img" aria-label="勝利獎盃">' +
      '<path d="M30 20 h60 v22 a30 30 0 0 1 -60 0 Z" fill="#FFE3A0" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<path d="M30 26 h-14 a14 14 0 0 0 14 22" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M90 26 h14 a14 14 0 0 1 -14 22" fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>' +
      '<rect x="52" y="70" width="16" height="16" fill="#E7C263" stroke="' + INK + '" stroke-width="5"/>' +
      '<rect x="34" y="86" width="52" height="16" rx="6" fill="#FFC2B4" stroke="' + INK + '" stroke-width="5"/>' +
      '<circle cx="60" cy="38" r="9" fill="#FFF6DC" stroke="' + INK + '" stroke-width="4"/>' +
      '</svg>';
  }

  /* ---- 風向箭頭 ---- */
  function windArrow(wind) {
    var w0 = Number(wind) || 0;
    var mag = Math.min(1, Math.abs(w0) / 10);
    var dir = w0 >= 0 ? 1 : -1;
    var len = 14 + mag * 26;
    var color = mag < 0.15 ? '#C8BFD1' : (mag < 0.45 ? '#79C6AC' : (mag < 0.75 ? '#E7C263' : '#E88CAA'));
    var x0 = 50 - dir * len / 2, x1 = 50 + dir * len / 2;
    return '<svg viewBox="0 0 100 40" role="img" aria-label="風向">' +
      '<path d="M' + x0 + ' 20 H' + x1 + '" stroke="' + color + '" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M' + x1 + ' 20 l' + (-dir * 12) + ' -9 M' + x1 + ' 20 l' + (-dir * 12) + ' 9" stroke="' + color + '" stroke-width="8" stroke-linecap="round" fill="none"/>' +
      '</svg>';
  }

  /* ---- 背景漂浮裝飾（純視覺，pointer-events:none） ---- */
  function bgDeco(host) {
    var cols = ['#DCCFFA', '#C6EEE0', '#CFE6F8', '#FFEFC4', '#FFD5DF'];
    var html = '';
    for (var i = 0; i < 12; i++) {
      var s = 30 + Math.random() * 80;
      html += '<span style="width:' + s.toFixed(0) + 'px;height:' + s.toFixed(0) + 'px;left:' +
        (Math.random() * 100).toFixed(1) + '%;top:' + (Math.random() * 100).toFixed(1) + '%;background:' +
        cols[i % cols.length] + ';animation-duration:' + (8 + Math.random() * 8).toFixed(1) +
        's;animation-delay:-' + (Math.random() * 8).toFixed(1) + 's;opacity:' + (0.16 + Math.random() * 0.18).toFixed(2) + '"></span>';
    }
    host.innerHTML = html;
  }

  /* ================= 全身貓狗（側面，含四隻腳與尾巴） =================
   *
   * 一律畫成「面朝右」，viewBox 120 × 100，腳底剛好落在 y = 98。
   * 狗狗在戰場上是面朝左的，由 render.js 水平鏡射，這裡不另外畫一份。
   */

  /** 側面站姿的貓：四隻腳、翹起來的長尾巴、三角耳 */
  function catBody(mood) {
    var c = SIDE_COLOR.cat;
    var m = mood || 'idle';
    /* 尾巴受傷時垂下來、開心時翹更高，是看得出情緒的第二個線索 */
    var tail = (m === 'hurt' || m === 'lose')
      ? 'M30 68 q-16 6 -20 20'
      : 'M30 62 q-20 -4 -18 -24 q1 -10 9 -12';
    return '<g>' +
      '<path d="' + tail + '" fill="none" stroke="' + INK + '" stroke-width="13" stroke-linecap="round"/>' +
      '<path d="' + tail + '" fill="none" stroke="' + c.dark + '" stroke-width="7" stroke-linecap="round"/>' +

      /* 遠側的兩隻腳先畫，顏色深一點，才有前後層次 */
      '<rect x="38" y="70" width="11" height="28" rx="5.5" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="72" y="70" width="11" height="28" rx="5.5" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="4"/>' +

      /* 身體 */
      '<ellipse cx="56" cy="60" rx="33" ry="21" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +

      /* 近側的兩隻腳壓在身體上 */
      '<rect x="30" y="70" width="12" height="28" rx="6" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="64" y="70" width="12" height="28" rx="6" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4"/>' +
      /* 腳掌肉球 */
      '<ellipse cx="36" cy="96" rx="7" ry="3.5" fill="' + c.accent + '"/>' +
      '<ellipse cx="70" cy="96" rx="7" ry="3.5" fill="' + c.accent + '"/>' +

      /* 虎斑紋 */
      '<path d="M44 44 q6 6 0 12 M56 42 q6 7 0 14 M68 44 q6 6 0 12" fill="none" stroke="' + c.dark + '" stroke-width="4" stroke-linecap="round" opacity="0.75"/>' +

      /* 耳朵 */
      '<path d="M78 28 L74 8 L92 20 Z" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4.5" stroke-linejoin="round"/>' +
      '<path d="M100 26 L106 8 L110 26 Z" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4.5" stroke-linejoin="round"/>' +

      /* 頭 */
      '<circle cx="93" cy="35" r="19" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +
      /* 側面只看得到一隻眼睛，所以兩個座標給同一點 */
      eyes(m, 97, 32, 97, 32) +
      tear(m, 97, 32) +
      '<ellipse cx="88" cy="44" rx="8" ry="5" fill="' + c.accent + '" opacity="0.85"/>' +
      '<path d="M106 38 L110 42 L106 46" fill="none" stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      mouth(m, 103, 46) +
      '<path d="M104 34 h14 M104 40 h14" stroke="' + INK + '" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/>' +
      '</g>';
  }

  /** 側面站姿的狗：四隻腳、垂耳、項圈，尾巴會依情緒改變角度 */
  function dogBody(mood) {
    var c = SIDE_COLOR.dog;
    var m = mood || 'idle';
    var tail = (m === 'hurt' || m === 'lose')
      ? 'M28 70 q-14 8 -16 18'
      : 'M28 60 q-16 -10 -10 -26';
    return '<g>' +
      '<path d="' + tail + '" fill="none" stroke="' + INK + '" stroke-width="14" stroke-linecap="round"/>' +
      '<path d="' + tail + '" fill="none" stroke="' + c.dark + '" stroke-width="8" stroke-linecap="round"/>' +

      '<rect x="38" y="70" width="12" height="28" rx="6" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="72" y="70" width="12" height="28" rx="6" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="4"/>' +

      '<ellipse cx="56" cy="60" rx="34" ry="22" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +

      '<rect x="29" y="70" width="13" height="28" rx="6.5" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4"/>' +
      '<rect x="63" y="70" width="13" height="28" rx="6.5" fill="' + c.body + '" stroke="' + INK + '" stroke-width="4"/>' +
      '<ellipse cx="35" cy="96" rx="7.5" ry="3.5" fill="' + c.dark + '"/>' +
      '<ellipse cx="69" cy="96" rx="7.5" ry="3.5" fill="' + c.dark + '"/>' +

      /* 肚子的淺色斑塊 */
      '<ellipse cx="60" cy="68" rx="20" ry="9" fill="#FFF3E4" opacity="0.75"/>' +

      /* 頭 */
      '<circle cx="92" cy="36" r="19" fill="' + c.body + '" stroke="' + INK + '" stroke-width="5"/>' +
      /* 垂下來的耳朵蓋住頭側 */
      '<ellipse cx="84" cy="34" rx="10" ry="20" fill="' + c.dark + '" stroke="' + INK + '" stroke-width="4.5"/>' +
      eyes(m, 96, 32, 96, 32) +
      tear(m, 96, 32) +
      /* 往前突出的鼻吻 */
      '<ellipse cx="109" cy="44" rx="12" ry="9" fill="#FFF3E4" stroke="' + INK + '" stroke-width="4"/>' +
      '<ellipse cx="116" cy="41" rx="5" ry="4" fill="' + INK + '"/>' +
      mouth(m, 109, 49) +
      /* 項圈 */
      '<path d="M76 50 q10 10 20 8" fill="none" stroke="' + c.accent + '" stroke-width="7" stroke-linecap="round"/>' +
      '<circle cx="88" cy="59" r="4.5" fill="#E7C263" stroke="' + INK + '" stroke-width="3"/>' +
      '</g>';
  }

  /* ===================== 彈藥與道具投射物 ===================== */

  /** 魚骨頭：貓咪的彈藥 */
  function fishBone() {
    return '<svg viewBox="0 0 100 100" data-asset="fishbone" role="img" aria-label="魚骨頭">' +
      '<g transform="rotate(-18 50 50)">' +
      /* 魚頭 */
      '<path d="M18 50 q10 -16 24 0 q-14 16 -24 0 Z" fill="#DCEEF7" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<circle cx="26" cy="47" r="3.5" fill="' + INK + '"/>' +
      /* 脊椎 */
      '<path d="M40 50 H80" stroke="' + INK + '" stroke-width="7" stroke-linecap="round"/>' +
      /* 肋骨 */
      '<path d="M48 50 l-6 -13 M48 50 l-6 13 M58 50 l-6 -14 M58 50 l-6 14 M68 50 l-6 -13 M68 50 l-6 13" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>' +
      /* 尾鰭 */
      '<path d="M80 50 l14 -13 v26 Z" fill="#DCEEF7" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '</g></svg>';
  }

  /** 圓潤的砲彈：實際飛行時使用，不再用骨頭或 emoji 代替 */
  function cannonBall() {
    return '<svg viewBox="0 0 100 100" data-asset="cannonball" role="img" aria-label="砲彈">' +
      '<g transform="rotate(-18 50 50)">' +
      /* 彈體：圓潤的砲彈輪廓，右側用弧面表現金屬厚度 */
      '<path d="M16 50 Q21 29 41 22 Q57 17 71 23 Q87 29 95 50 Q87 71 71 77 Q57 83 41 78 Q21 71 16 50 Z" fill="#40364F" stroke="' + INK + '" stroke-width="6" stroke-linejoin="round"/>' +
      '<path d="M68 23 Q86 30 95 50 Q86 70 68 77 Q76 50 68 23 Z" fill="#75677D" opacity="0.86"/>' +
      /* 彈頭金屬環與鉚釘 */
      '<path d="M64 24 Q72 50 64 76" fill="none" stroke="#A79AAF" stroke-width="6" opacity="0.72"/>' +
      '<circle cx="43" cy="34" r="4" fill="#CFC5D4" stroke="#4A3B55" stroke-width="2"/>' +
      '<circle cx="43" cy="66" r="4" fill="#CFC5D4" stroke="#4A3B55" stroke-width="2"/>' +
      '<path d="M29 38 Q43 25 57 29" fill="none" stroke="#E8E0EA" stroke-width="6" stroke-linecap="round" opacity="0.72"/>' +
      '<path d="M29 62 Q43 75 57 71" fill="none" stroke="#251E32" stroke-width="5" stroke-linecap="round" opacity="0.55"/>' +
      '</g>' +
      '</svg>';
  }

  /** 臭彈：只顯示臭氣炸彈本體，不共用砲彈外觀。 */
  function stinkBomb() {
    return '<svg viewBox="0 0 100 100" data-asset="stink-bomb" role="img" aria-label="臭彈">' +
      '<path d="M58 22 Q68 10 80 15" fill="none" stroke="#695B73" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M77 15 l8 -5" fill="none" stroke="#E7C263" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="49" cy="56" r="31" fill="#9AD16F" stroke="' + INK + '" stroke-width="6"/>' +
      '<path d="M29 52 q10 -12 20 0 q10 12 20 0" fill="none" stroke="#E8F6C9" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M35 72 q14 9 28 0" fill="none" stroke="#6E9C4A" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="40" cy="43" r="4" fill="#E8F6C9"/>' +
      '</svg>';
  }

  /* ======================= 場景：垃圾桶、狗屋、狗糧 ======================= */

  /** 開著蓋子的垃圾桶，貓咪站在上面 */
  function trashCan() {
    return '<svg viewBox="0 0 100 100" role="img" aria-label="垃圾桶">' +
      /* 掀開的蓋子靠在後面 */
      '<g transform="rotate(-24 20 34)">' +
      '<rect x="2" y="24" width="42" height="12" rx="6" fill="#B9C6CF" stroke="' + INK + '" stroke-width="5"/>' +
      '<rect x="17" y="16" width="12" height="10" rx="4" fill="#B9C6CF" stroke="' + INK + '" stroke-width="4"/>' +
      '</g>' +
      /* 桶身：上寬下窄 */
      '<path d="M26 40 H86 L80 96 H32 Z" fill="#CBD8E0" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<rect x="22" y="34" width="68" height="12" rx="6" fill="#B9C6CF" stroke="' + INK + '" stroke-width="5"/>' +
      /* 直紋 */
      '<path d="M42 48 V92 M56 48 V92 M70 48 V92" stroke="' + INK + '" stroke-width="3" stroke-linecap="round" opacity="0.35"/>' +
      /* 冒出來的垃圾 */
      '<circle cx="40" cy="34" r="7" fill="#E7C263" stroke="' + INK + '" stroke-width="4"/>' +
      '<path d="M62 34 l8 -10 l6 10 Z" fill="#A9E7D2" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '</svg>';
  }

  /** 狗屋 */
  function dogHouse() {
    return '<svg viewBox="0 0 120 100" role="img" aria-label="狗屋">' +
      '<path d="M60 6 L112 44 H8 Z" fill="#E89C8B" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<rect x="18" y="42" width="84" height="54" rx="6" fill="#FFC2B4" stroke="' + INK + '" stroke-width="5"/>' +
      /* 拱形門口 */
      '<path d="M42 96 V68 q18 -20 36 0 v28 Z" fill="#6B4E63" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      /* 木紋 */
      '<path d="M26 54 H36 M26 68 H36 M26 82 H36 M84 54 H94 M84 68 H94 M84 82 H94" stroke="' + INK + '" stroke-width="3" stroke-linecap="round" opacity="0.3"/>' +
      /* 門口上方的名牌 */
      '<rect x="46" y="46" width="28" height="12" rx="5" fill="#FFE3A0" stroke="' + INK + '" stroke-width="4"/>' +
      '</svg>';
  }

  /** 狗糧碗：碗裡和地上都有幾顆飼料 */
  function dogBowl() {
    return '<svg viewBox="0 0 100 60" role="img" aria-label="狗糧">' +
      /* 掉在地上的幾顆 */
      '<circle cx="10" cy="52" r="5" fill="#C2884F" stroke="' + INK + '" stroke-width="3"/>' +
      '<circle cx="22" cy="55" r="4" fill="#A9713F" stroke="' + INK + '" stroke-width="3"/>' +
      '<circle cx="90" cy="54" r="4.5" fill="#C2884F" stroke="' + INK + '" stroke-width="3"/>' +
      /* 碗 */
      '<path d="M30 26 H82 L76 54 H36 Z" fill="#AED9F5" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<ellipse cx="56" cy="26" rx="26" ry="8" fill="#7FB4DA" stroke="' + INK + '" stroke-width="5"/>' +
      /* 碗裡的飼料 */
      '<circle cx="46" cy="24" r="5.5" fill="#C2884F" stroke="' + INK + '" stroke-width="3"/>' +
      '<circle cx="58" cy="21" r="5.5" fill="#A9713F" stroke="' + INK + '" stroke-width="3"/>' +
      '<circle cx="68" cy="25" r="5" fill="#C2884F" stroke="' + INK + '" stroke-width="3"/>' +
      '</svg>';
  }

  /** 狗狗那一側背景的房子 */
  function house() {
    return '<svg viewBox="0 0 160 130" role="img" aria-label="房子">' +
      '<path d="M80 6 L154 58 H6 Z" fill="#E88CAA" stroke="' + INK + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<rect x="20" y="56" width="120" height="72" rx="6" fill="#FFF0DE" stroke="' + INK + '" stroke-width="5"/>' +
      /* 門 */
      '<rect x="66" y="86" width="30" height="42" rx="5" fill="#C2A17C" stroke="' + INK + '" stroke-width="5"/>' +
      '<circle cx="89" cy="108" r="3.5" fill="' + INK + '"/>' +
      /* 兩扇窗 */
      '<rect x="32" y="70" width="26" height="26" rx="5" fill="#AED9F5" stroke="' + INK + '" stroke-width="5"/>' +
      '<rect x="104" y="70" width="26" height="26" rx="5" fill="#AED9F5" stroke="' + INK + '" stroke-width="5"/>' +
      '<path d="M45 70 V96 M32 83 H58 M117 70 V96 M104 83 H130" stroke="' + INK + '" stroke-width="3"/>' +
      /* 煙囪 */
      '<rect x="110" y="18" width="18" height="26" rx="4" fill="#C2A17C" stroke="' + INK + '" stroke-width="5"/>' +
      '</svg>';
  }

  w.UI = {
    INK: INK,
    PALETTE: PALETTE,
    SIDE_COLOR: SIDE_COLOR,
    decorate: decorate, decorateAll: decorateAll, paint: paint, repaintAll: repaintAll,
    setLabel: setLabel, setColor: setColor,
    catFace: catFace, dogFace: dogFace, avatar: avatar,
    catBody: catBody, dogBody: dogBody,
    yarn: yarn, bone: bone, fishBone: fishBone, cannonBall: cannonBall, stinkBomb: stinkBomb,
    trashCan: trashCan, dogHouse: dogHouse, dogBowl: dogBowl, house: house,
    logo: logo, trophy: trophy, windArrow: windArrow, bgDeco: bgDeco
  };
}(window));
