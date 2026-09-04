/* ===== render.js — 戰場畫布 =====
 *
 * 只負責「把 Rules 的狀態畫出來」與「把觸控座標換算成角度／力道」。
 * 這裡沒有任何規則判斷：命中、傷害、勝負都由 Rules 決定。
 *
 * 世界座標是 1200 × 640、y 向上；畫布依可用空間等比例縮放，
 * 所以手機和桌機看到的彈道完全一樣，只是大小不同。
 */
(function (w) {
  'use strict';

  var Rules = w.Rules;
  var UI = w.UI;
  var WORLD = Rules.WORLD;
  var C = Rules.CONST;

  var canvas = null, ctx = null, stage = null, canvasWrap = null;
  var scale = 1, cssW = 0, cssH = 0, dpr = 1;

  var state = null;
  var aim = { side: null, angle: 45, power: 60, visible: false, dragging: false };
  /* 按住蓄力中的即時讀數；app.js 每一幀更新，畫在砲口旁邊 */
  var charge = { on: false, angle: 45, power: 10 };
  var anim = null;              // 飛行中的動畫
  var animDone = null;          // 爆炸當下要回呼的 callback
  var animGuard = 0;            // 動畫沒跑完時的保險絲計時器
  var effects = [];             // 爆炸、傷害數字
  var shake = 0;
  var rafId = 0;
  var reduceMotion = false;
  var showTrail = true;
  var lastTrail = null;         // 上一發的完整彈道（虛線留在畫面上當參考）

  /* 圖檔快取：把 SVG 轉成 Image 一次，之後直接 drawImage */
  var imgCache = {};
  function svgImage(key, svgText) {
    if (imgCache[key]) return imgCache[key];
    var svg = svgText.indexOf('xmlns') >= 0
      ? svgText
      : svgText.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    var img = new Image();
    img.decoding = 'async';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    /* 圖片是非同步解碼的，載好之後要再畫一次，否則第一幀會是空的 */
    img.onload = function () { schedule(); };
    imgCache[key] = img;
    return img;
  }

  /* 全身貓狗（含四隻腳與尾巴）。原圖一律面朝右，狗狗畫的時候再水平鏡射。 */
  var BODY_VB_W = 120, BODY_VB_H = 100;
  function bodyImage(side, mood) {
    var inner = side === 'dog' ? UI.dogBody(mood) : UI.catBody(mood);
    return svgImage('body:' + side + ':' + mood,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + BODY_VB_W + ' ' + BODY_VB_H + '">' +
      inner + '</svg>');
  }

  /* 彈藥：實際飛行物一律是砲彈；魚骨頭只保留在貓方道具圖示 */
  function ammoImage() {
    return svgImage('ammo:cannonball', UI.cannonBall());
  }

  /* 場景道具：貓站在開蓋垃圾桶上，狗那一側有房子、狗屋和狗糧 */
  function propImage(name) {
    if (name === 'trash') return svgImage('prop:trash', UI.trashCan());
    if (name === 'doghouse') return svgImage('prop:doghouse', UI.dogHouse());
    if (name === 'bowl') return svgImage('prop:bowl', UI.dogBowl());
    return svgImage('prop:house', UI.house());
  }

  /* --------------------------------------------------------- 座標換算 */

  function sx(x) { return x * scale; }
  function sy(y) { return cssH - y * scale; }

  /** 螢幕座標（clientX/clientY）→ 世界座標 */
  function toWorld(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / (r.width / WORLD.W),
      y: (r.bottom - clientY) / (r.height / WORLD.H)
    };
  }

  /**
   * 把「從角色拉到某一點」換算成角度與力道。
   * 角度＝拉桿與水平線的夾角，力道＝拉桿長度（有上下限）。
   * 這是平板上最直覺的瞄準方式，同時保留下方滑桿給精修。
   */
  function pointToAim(clientX, clientY, side) {
    if (!state) return { angle: aim.angle, power: aim.power };
    var f = state.fighters[side];
    var p = toWorld(clientX, clientY);
    var dx = (p.x - f.x) * f.dir;          // 一律換算成「朝對手方向為正」
    var dy = p.y - (f.y + C.MUZZLE_UP);
    var angle = Math.atan2(dy, Math.max(1, dx)) * 180 / Math.PI;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var power = C.MIN_POWER + (dist / 320) * (C.MAX_POWER - C.MIN_POWER);
    return {
      angle: Math.round(Rules.clamp(angle, C.MIN_ANGLE, C.MAX_ANGLE)),
      power: Math.round(Rules.clamp(power, C.MIN_POWER, C.MAX_POWER))
    };
  }

  /* ------------------------------------------------------------ 尺寸 */

  /* 直向手機的可用高度常常遠大於「世界高度 × 寬度縮放」，
   * 與其上下留一大片空白，不如把多出來的高度拿來顯示更多天空，
   * 高吊球才看得到。上限 940 是為了不讓畫面看起來全是空氣。 */
  var VIEW_H_MAX = 940;

  function resize() {
    if (!canvas || !stage) return;
    var box = stage.getBoundingClientRect();
    var availW = Math.max(160, box.width);
    var availH = Math.max(110, box.height);
    /* 縮放取兩者較小值，保證整個世界（含地面）一定塞得進去 */
    var s = Math.min(availW / WORLD.W, availH / WORLD.H);
    scale = s;
    cssW = Math.round(WORLD.W * s);
    cssH = Math.round(Math.min(availH, VIEW_H_MAX * s));
    dpr = Math.min(2.5, w.devicePixelRatio || 1);
    if (canvasWrap) {
      canvasWrap.style.width = cssW + 'px';
      canvasWrap.style.height = cssH + 'px';
    }
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /* ------------------------------------------------------------ 畫面 */

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, '#CBE9FF');
    g.addColorStop(0.55, '#EAF6FF');
    g.addColorStop(1, '#FFF6E6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);

    /* 幾朵不會動的雲，靠種子決定位置，重畫時不會亂跳 */
    if (!state) return;
    var rng = w.RNG.createRng('cloud:' + state.seed);
    var skyTop = cssH / scale;                 // 目前實際看得到的世界高度
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = '#FFFFFF';
    for (var i = 0; i < 7; i++) {
      var cx = rng() * WORLD.W;
      var cy = 300 + rng() * Math.max(120, skyTop - 340);
      var r = 18 + rng() * 22;
      cloud(sx(cx), sy(cy), r * scale);
    }
    ctx.restore();
  }

  function cloud(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r * 0.9, y + r * 0.15, r * 0.75, 0, Math.PI * 2);
    ctx.arc(x - r * 0.95, y + r * 0.2, r * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 地表輪廓：沿著高度圖畫一條折線，填土、蓋草皮、再描邊 */
  function terrainPath(closeToBottom) {
    var g = state.ground;
    var colW = WORLD.W / WORLD.COLS;
    ctx.beginPath();
    if (closeToBottom) { ctx.moveTo(0, cssH); ctx.lineTo(0, sy(g[0])); }
    else ctx.moveTo(0, sy(g[0]));
    for (var i = 0; i < g.length; i++) ctx.lineTo(sx((i + 0.5) * colW), sy(g[i]));
    ctx.lineTo(cssW, sy(g[g.length - 1]));
    if (closeToBottom) { ctx.lineTo(cssW, cssH); ctx.closePath(); }
  }

  function drawTerrain() {
    /* 泥土 */
    terrainPath(true);
    var dirt = ctx.createLinearGradient(0, sy(280), 0, cssH);
    dirt.addColorStop(0, '#D2AC80');
    dirt.addColorStop(0.35, '#B98F62');
    dirt.addColorStop(1, '#8E6B49');
    ctx.fillStyle = dirt;
    ctx.fill();

    /* 草皮：沿著地表描一條粗綠線，坑洞和被削平的圍牆也會跟著長草 */
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    terrainPath(false);
    ctx.lineWidth = Math.max(4, 13 * scale);
    ctx.strokeStyle = '#8FD08A';
    ctx.stroke();
    terrainPath(false);
    ctx.lineWidth = Math.max(2, 6 * scale);
    ctx.strokeStyle = '#B7E3A8';
    ctx.stroke();
    ctx.restore();

    /* 外框 */
    terrainPath(true);
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.strokeStyle = '#4A3B55';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /**
   * 中央的柵欄。
   *
   * 這道柵欄畫在地形本來就凸起來的那一段上，佔的位置與高度就是 Rules 用來
   * 判定碰撞的地形本身 —— 看得到的柵欄和打得到的障礙物是同一個東西，
   * 不會出現「球穿過畫出來的柵欄」這種騙人的畫面。
   */
  function drawFence() {
    if (!state) return;
    var g = state.ground;
    var midX = WORLD.W / 2;
    var halfW = 26;                       // 與 makeTerrain 的圍牆寬度一致
    var topY = 0;
    for (var x = midX - halfW; x <= midX + halfW; x += 4) {
      topY = Math.max(topY, Rules.groundAt(g, x));
    }
    /* 柵欄底部取牆兩側的地面，讓木板看起來是插在土裡的 */
    var baseY = Math.min(Rules.groundAt(g, midX - halfW - 20), Rules.groundAt(g, midX + halfW + 20));
    if (topY - baseY < 12) return;        // 這張圖沒有明顯的牆就不畫

    var planks = 5;
    var gap = (halfW * 2) / planks;
    var pw = gap * 0.72;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#4A3B55';
    ctx.lineWidth = Math.max(1.5, 3 * scale);

    /* 直立木板，頂端削成尖角 */
    for (var i = 0; i < planks; i++) {
      var cx = midX - halfW + gap * (i + 0.5);
      var l = sx(cx - pw / 2), r = sx(cx + pw / 2);
      var tip = sy(topY), sh = sy(topY - 10), bot = sy(baseY - 6);
      ctx.beginPath();
      ctx.moveTo(l, bot);
      ctx.lineTo(l, sh);
      ctx.lineTo((l + r) / 2, tip);
      ctx.lineTo(r, sh);
      ctx.lineTo(r, bot);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? '#D9B383' : '#E6C79C';
      ctx.fill();
      ctx.stroke();
    }

    /* 兩根橫樑 */
    [0.34, 0.68].forEach(function (k) {
      var yy = baseY + (topY - baseY) * k;
      ctx.beginPath();
      ctx.rect(sx(midX - halfW - 3), sy(yy) - 5 * scale, (halfW * 2 + 6) * scale, Math.max(4, 10 * scale));
      ctx.fillStyle = '#C79A6B';
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  /**
   * 兩側的場景擺設：貓的垃圾桶、狗的房子＋狗屋＋狗糧。
   *
   * 貓咪腳下的垃圾桶和狗狗腳下的木平台都是「真的站台」：Rules 讓兩邊的腳底
   * 都比地面高 CONST.STAND_H，畫出來的高度就是物理用的高度，兩邊也一樣高，
   * 不會有一邊站得比較高的優勢。
   */
  function drawProps() {
    if (!state) return;
    var g = state.ground;
    var cat = state.fighters.cat;
    var dog = state.fighters.dog;
    var edge = WORLD.W - 2;

    /* 狗那一側最遠處的房子，先畫當背景 */
    drawProp(propImage('house'), Math.min(edge, dog.x + 120), dog.y, 168, 160 / 130);
    /* 狗狗腳下的木平台，把牠墊到跟貓一樣高 */
    drawDeck(dog.x, Rules.groundAt(g, dog.x), dog.y);
    /* 狗屋在狗狗後面一點，站在同一個平台上 */
    drawProp(propImage('doghouse'), Math.min(edge, dog.x + 66), dog.y, 96, 120 / 100);
    /* 狗糧碗放在狗狗前面的平台上 */
    drawProp(propImage('bowl'), dog.x - 52, dog.y, 30, 100 / 60);
    /* 貓咪站的垃圾桶：桶底在地面、桶口剛好是貓的腳底，
     * 所以高度就是 STAND_H —— 畫出來的桶子就是貓真正站的那個高度。 */
    /* 寬高比 1.6：桶身要比貓的四隻腳張開的寬度更寬，才站得住 */
    drawProp(propImage('trash'), cat.x, Rules.groundAt(g, cat.x), C.STAND_H, 1.6);
  }

  /** 狗狗那一側的木平台：從地面墊到腳底高度 */
  function drawDeck(wx, groundY, topWorldY) {
    var h = (topWorldY - groundY);
    if (h <= 1) return;
    var wWorld = 150;
    ctx.save();
    ctx.strokeStyle = '#4A3B55';
    ctx.lineWidth = Math.max(1.5, 3 * scale);
    ctx.fillStyle = '#D9B383';
    ctx.beginPath();
    ctx.rect(sx(wx - wWorld / 2), sy(topWorldY), wWorld * scale, h * scale);
    ctx.fill();
    ctx.stroke();
    /* 檯面 */
    ctx.fillStyle = '#E6C79C';
    ctx.beginPath();
    ctx.rect(sx(wx - wWorld / 2 - 4), sy(topWorldY) - 4 * scale, (wWorld + 8) * scale, Math.max(4, 9 * scale));
    ctx.fill();
    ctx.stroke();
    /* 木板接縫 */
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    for (var i = 1; i < 5; i++) {
      var px = sx(wx - wWorld / 2 + (wWorld / 5) * i);
      ctx.moveTo(px, sy(topWorldY));
      ctx.lineTo(px, sy(groundY));
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawProp(img, wx, standY, hWorld, ratio) {
    if (!img.complete || !img.naturalWidth) return;
    var h = hWorld * scale;
    var wpx = h * ratio;
    ctx.drawImage(img, sx(wx) - wpx / 2, sy(standY) - h, wpx, h);
  }

  function drawFighter(f, isTurn) {
    var img = bodyImage(f.side, f.mood || 'idle');
    var SIZE_W = 112;                    // 放大角色本體，讓貓狗在平板與桌機上更醒目
    var size = SIZE_W * scale;
    var wpx = size * (BODY_VB_W / BODY_VB_H);
    var x = sx(f.x) - wpx / 2;
    var y = sy(f.y + SIZE_W * 0.98);     // 圖裡的腳底在 98%，對齊站立面

    /* 影子 */
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#4A3B55';
    ctx.beginPath();
    ctx.ellipse(sx(f.x), sy(f.y) + 2, size * 0.4, size * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* 輪到誰：腳下的光環 + 上方小箭頭，不只靠顏色表達 */
    if (isTurn) {
      ctx.save();
      ctx.strokeStyle = '#A48FDB';
      ctx.lineWidth = Math.max(2, 4 * scale);
      ctx.beginPath();
      ctx.ellipse(sx(f.x), sy(f.y) + 2, size * 0.46, size * 0.15, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      var ax = sx(f.x), ay = sy(f.y + SIZE_W + 10);
      var bob = reduceMotion ? 0 : Math.sin(Date.now() / 260) * 4 * scale;
      ctx.save();
      ctx.fillStyle = '#A48FDB';
      ctx.strokeStyle = '#4A3B55';
      ctx.lineWidth = Math.max(1.5, 2.5 * scale);
      ctx.beginPath();
      ctx.moveTo(ax, ay + bob + 10 * scale);
      ctx.lineTo(ax - 9 * scale, ay + bob - 4 * scale);
      ctx.lineTo(ax + 9 * scale, ay + bob - 4 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (img.complete && img.naturalWidth) {
      /* 原圖一律面朝右。狗狗的 dir 是 -1，所以以自己的中心水平鏡射過去，
       * 兩隻才會互相對望而不是同時看向同一邊。 */
      if (f.dir < 0) {
        ctx.save();
        ctx.translate(sx(f.x), 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, -wpx / 2, y, wpx, size);
        ctx.restore();
      } else {
        ctx.drawImage(img, x, y, wpx, size);
      }
    } else {
      ctx.fillStyle = f.side === 'cat' ? '#FFE0C2' : '#E3CBAE';
      ctx.strokeStyle = '#4A3B55';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx(f.x), sy(f.y + 30), size * 0.36, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  /** 瞄準線：從砲口沿著發射方向畫一段虛線，末端箭頭大小代表力道 */
  function drawAim() {
    if (!aim.visible || !aim.side || !state || state.over || anim) return;
    var f = state.fighters[aim.side];
    var rad = aim.angle * Math.PI / 180;
    var len = (40 + (aim.power / C.MAX_POWER) * 190);
    var x0 = f.x + f.dir * C.MUZZLE_FWD;
    var y0 = f.y + C.MUZZLE_UP;
    var x1 = x0 + f.dir * Math.cos(rad) * len;
    var y1 = y0 + Math.sin(rad) * len;

    ctx.save();
    ctx.setLineDash([8 * scale, 7 * scale]);
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeStyle = aim.side === 'cat' ? '#E88CAA' : '#7FB4DA';
    ctx.beginPath();
    ctx.moveTo(sx(x0), sy(y0));
    ctx.lineTo(sx(x1), sy(y1));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#4A3B55';
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.fillStyle = ctx.strokeStyle;
    if (charge.on) {
      /* 蓄力時用箭頭指向預計落點，比圓點更容易看出發射方向。 */
      var tipX = sx(x1), tipY = sy(y1);
      var ux = f.dir * Math.cos(rad), uy = -Math.sin(rad);
      var px = -uy, py = ux;
      var tip = Math.max(9, (12 + aim.power / 12) * scale);
      var back = tip * 1.65, half = tip * 0.72;
      var baseX = tipX - ux * back, baseY = tipY - uy * back;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX + px * half, baseY + py * half);
      ctx.lineTo(baseX - px * half, baseY - py * half);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(sx(x1), sy(y1), Math.max(4, (5 + aim.power / 14) * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrail(points, alpha) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setLineDash([5 * scale, 6 * scale]);
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.strokeStyle = '#6E4FBF';
    ctx.beginPath();
    ctx.moveTo(sx(points[0].x), sy(points[0].y));
    for (var i = 1; i < points.length; i++) ctx.lineTo(sx(points[i].x), sy(points[i].y));
    ctx.stroke();
    ctx.restore();
  }

  function drawProjectile() {
    if (!anim) return;
    var pts = anim.sub.points;
    var idx = Math.min(pts.length - 1, Math.floor(anim.i));
    var p = pts[idx];
    if (!p) return;
    if (showTrail) drawTrail(pts.slice(0, idx + 1), 0.85);

    var mod = Rules.modOf(anim.shot.item);
    /* 大骨頭的判定半徑真的比較大，畫面上就要真的比較大顆 */
    var size = 48 * mod.scale * scale;
    var spin = reduceMotion ? 0 : anim.i * 0.22;
    ctx.save();
    ctx.translate(sx(p.x), sy(p.y));
    ctx.rotate(spin);

    /* 臭彈：在彈藥外面再加一圈綠色臭氣，跟一般的一眼分得出來 */
    if (anim.shot.item === 'stink') {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#9AD16F';
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    var img = ammoImage();
    /* 未解碼完成時先不畫，避免普通圓形 fallback 被誤認成砲彈。 */
    if (img.complete && img.naturalWidth) ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  /** 蓄力中的方向與力道，直接標在砲口旁邊；不顯示角度數字避免照抄 */
  function drawChargeReadout() {
    if (!charge.on || !state || !aim.side) return;
    var f = state.fighters[aim.side];
    /* 小提示放在角色身後，讓前方的蓄力箭頭保持乾淨。 */
    var bx = sx(f.x) - f.dir * 36 * scale;
    var by = sy(f.y + C.MUZZLE_UP + 18);
    var text = '力 ' + charge.power;
    var fs = Math.max(9, 14 * scale);

    ctx.save();
    ctx.font = '900 ' + fs + 'px "Yuanti TC","Microsoft JhengHei",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var pad = Math.max(2, fs * 0.25);
    var tw = ctx.measureText(text).width;

    /* 白底圓角牌子，天空或土地上都看得清楚 */
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = '#4A3B55';
    ctx.lineWidth = Math.max(2, 3 * scale);
    var bw = tw + pad * 2, bh = fs + pad;
    var r = bh / 2;
    ctx.beginPath();
    ctx.moveTo(bx - bw / 2 + r, by - bh / 2);
    ctx.arcTo(bx + bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2, r);
    ctx.arcTo(bx + bw / 2, by + bh / 2, bx - bw / 2, by + bh / 2, r);
    ctx.arcTo(bx - bw / 2, by + bh / 2, bx - bw / 2, by - bh / 2, r);
    ctx.arcTo(bx - bw / 2, by - bh / 2, bx + bw / 2, by - bh / 2, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#4A3B55';
    ctx.fillText(text, bx, by);

    /* 力道長條：滿了就是最大力道 */
    var gw = bw * 0.78, gh = Math.max(3, 5 * scale);
    var gx = bx - gw / 2, gy = by + bh / 2 + gh;
    ctx.fillStyle = '#E9E3EE';
    ctx.beginPath(); ctx.rect(gx, gy, gw, gh); ctx.fill(); ctx.stroke();
    var k = (charge.power - C.MIN_POWER) / (C.MAX_POWER - C.MIN_POWER);
    ctx.fillStyle = k > 0.85 ? '#E89C8B' : (k > 0.5 ? '#E7C263' : '#79C6AC');
    ctx.beginPath(); ctx.rect(gx, gy, Math.max(1, gw * k), gh); ctx.fill();
    ctx.restore();
  }

  function drawExplosion(e, k) {
    var progress = Math.max(0, Math.min(1, k));
    var fade = 1 - progress;
    var radius = e.r * (0.28 + progress * 0.92) * scale;
    var cx = sx(e.x), cy = sy(e.y);
    var gas = !!e.tint;
    var outer = e.tint || '#F26B4B';
    var warm = gas ? '#E6F5B8' : '#FFE3A0';
    var core = gas ? '#F8FFE4' : '#FFF7D5';

    ctx.save();
    ctx.globalAlpha = fade;

    /* 外圈衝擊波：先擴張再淡出，讓命中位置一眼可見 */
    ctx.strokeStyle = gas ? '#A6CE78' : '#F08A5B';
    ctx.lineWidth = Math.max(3, 7 * scale * fade);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.28, 0, Math.PI * 2);
    ctx.stroke();

    /* 放射火花／臭氣尖角 */
    ctx.strokeStyle = warm;
    ctx.lineCap = 'round';
    for (var i = 0; i < 10; i++) {
      var angle = -Math.PI / 2 + i * Math.PI / 5;
      var inner = radius * (0.68 + (i % 3) * 0.05);
      var outerLen = radius * (1.06 + (i % 2) * 0.18);
      ctx.lineWidth = Math.max(2, (5 - (i % 3)) * scale * fade);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outerLen, cy + Math.sin(angle) * outerLen);
      ctx.stroke();
    }

    /* 外層火團與中心白熱核心 */
    ctx.fillStyle = outer;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.78, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = warm;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (0.5 - progress * 0.08), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx - radius * 0.1, cy - radius * 0.1, radius * (0.27 - progress * 0.04), 0, Math.PI * 2);
    ctx.fill();

    /* 幾顆不規則煙霧泡泡，避免效果看起來只是單純圓形 */
    ctx.fillStyle = gas ? '#C8E6A0' : '#8E8195';
    ctx.globalAlpha = fade * 0.62;
    for (var j = 0; j < 7; j++) {
      var puffAngle = -Math.PI / 2 + j * (Math.PI * 2 / 7);
      var puffDistance = radius * (0.62 + (j % 2) * 0.2);
      var puffSize = radius * (0.16 + (j % 3) * 0.035);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(puffAngle) * puffDistance,
        cy + Math.sin(puffAngle) * puffDistance, puffSize, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEffects() {
    var t = Date.now();
    for (var i = effects.length - 1; i >= 0; i--) {
      var e = effects[i];
      var k = (t - e.at) / e.life;
      if (k >= 1) { effects.splice(i, 1); continue; }
      if (e.type === 'boom') {
        drawExplosion(e, k);
      } else if (e.type === 'text') {
        ctx.save();
        ctx.globalAlpha = 1 - Math.max(0, (k - 0.6) / 0.4);
        var fs = Math.max(14, 30 * scale);
        ctx.font = '900 ' + fs + 'px "Yuanti TC","Microsoft JhengHei",system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = Math.max(3, 6 * scale);
        ctx.strokeStyle = '#FFFFFF';
        ctx.strokeText(e.text, sx(e.x), sy(e.y) - k * 46 * scale);
        ctx.fillStyle = e.color || '#D2444F';
        ctx.fillText(e.text, sx(e.x), sy(e.y) - k * 46 * scale);
        ctx.restore();
      }
    }
  }

  function draw() {
    if (!ctx || !state) return;
    ctx.save();
    if (shake > 0.4 && !reduceMotion) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.86;
    } else shake = 0;

    drawSky();
    drawProps();
    drawTerrain();
    drawFence();
    if (showTrail && lastTrail && !anim) drawTrail(lastTrail, 0.28);
    drawFighter(state.fighters.cat, !state.over && state.turn === 'cat');
    drawFighter(state.fighters.dog, !state.over && state.turn === 'dog');
    drawAim();
    drawProjectile();
    drawEffects();
    drawChargeReadout();
    ctx.restore();
  }

  /* ------------------------------------------------------- 動畫迴圈 */

  function tick() {
    rafId = 0;
    var busy = false;

    if (anim) {
      var pts = anim.sub.points;
      anim.i += anim.speed;
      if (anim.i >= pts.length - 1) {
        var cur = anim;
        anim = null;
        onImpact(cur.shot, cur.sub);
      }
      busy = true;
    }
    if (charge.on) busy = true;
    if (effects.length || shake > 0.4) busy = true;

    draw();
    if (busy || (!reduceMotion && state && !state.over)) schedule();
  }

  function schedule() {
    if (rafId) return;
    rafId = w.requestAnimationFrame(tick);
  }

  /** 一發（雙擊的話是其中一發）落地：爆炸圈、震動、傷害數字 */
  function onImpact(shot, sub) {
    clearTimeout(animGuard);
    animGuard = 0;
    lastTrail = sub.points && sub.points.length ? sub.points : lastTrail;

    if (sub.impact) {
      /* 爆炸圈畫的就是這一發真正的傷害半徑：臭彈看起來大一圈，
       * 因為它本來就打得比較廣，不是特效唬人。 */
      var mod = Rules.modOf(shot.item);
      effects.push({
        type: 'boom', x: sub.impact.x, y: sub.impact.y, r: mod.blastR * 0.62,
        at: Date.now(), life: reduceMotion ? 220 : 620, tint: shot.item === 'stink' ? '#C8E6A0' : null
      });
      shake = shot.result === 'direct' ? 16 : (shot.result === 'miss' ? 6 : 11);
    }

    /* 傷害數字浮在被打到的那一隻頭上，而不是只在角落偷偷改數字 */
    var dmg = sub.damage || shot.damage;
    if (state && dmg) {
      ['cat', 'dog'].forEach(function (s) {
        if (!(dmg[s] > 0)) return;
        effects.push({
          type: 'text', text: '-' + dmg[s],
          x: state.fighters[s].x, y: state.fighters[s].y + 70,
          at: Date.now(), life: 1100, color: '#D2444F'
        });
      });
    }

    if (typeof animDone === 'function') {
      var cb = animDone;
      animDone = null;
      cb(shot);
    }
    schedule();
  }

  /**
   * 播放這一回合的飛行動畫。
   *
   * 一般是一發；用了雙擊就是 shot.volley 裡的兩發，會依序播放，
   * 兩發之間留一點間隔，玩家看得出來真的丟了兩次。
   * onDone 在最後一發爆炸時呼叫，讓 app.js 接著套用新狀態與音效。
   */
  function playShot(shot, onDone) {
    lastTrail = null;
    clearTimeout(animGuard);

    var vol = (shot.volley && shot.volley.length)
      ? shot.volley
      : [{ points: shot.points, impact: shot.impact, damage: shot.damage }];

    /* 分頁在背景時瀏覽器會把 requestAnimationFrame 節流到幾乎不跑，
     * 所以背景分頁與減少動態一律直接跳到結果，不讓對局卡在動畫上。 */
    var hidden = !!(w.document && w.document.hidden);
    var playable = !reduceMotion && !hidden;

    var i = 0;
    var step = function () {
      var sub = vol[i];
      var last = (i === vol.length - 1);
      var done = function () {
        i++;
        if (!last) setTimeout(step, 240);          // 雙擊的第二發稍微等一下再飛
        else if (onDone) onDone(shot);
      };

      if (!playable || !sub || !sub.points || sub.points.length < 2) {
        anim = null;
        animDone = done;
        onImpact(shot, sub || { impact: shot.impact, damage: shot.damage, points: [] });
        return;
      }
      /* 飛行動畫大約 0.5 ~ 2 秒，跟實際飛行時間有關但不會讓玩家等太久 */
      var frames = Math.max(28, Math.min(120, sub.points.length));
      anim = { shot: shot, sub: sub, i: 0, speed: sub.points.length / frames };
      animDone = done;
      schedule();
      armGuard(shot, sub);
    };
    step();
  }

  /**
   * 保險絲：不管什麼原因（切到背景、瀏覽器省電、分頁被蓋住）動畫沒跑完，
   * 4.5 秒後強制結算這一發，玩家不會永遠等不到下一步。
   */
  function armGuard(shot, sub) {
    animGuard = setTimeout(function () {
      if (anim && anim.shot === shot && anim.sub === sub) {
        anim = null;
        onImpact(shot, sub);
      }
    }, 4500);
  }

  function isBusy() { return !!anim; }

  /* ------------------------------------------------------------ 對外 */

  function attach(canvasEl, stageEl) {
    canvas = canvasEl;
    stage = stageEl;
    canvasWrap = canvas.parentElement;
    ctx = canvas.getContext('2d');
    /* 提前解碼砲彈 SVG，讓第一次出手也能直接顯示完整圖案。 */
    ammoImage();
    if (w.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(stage);
    /* ResizeObserver 的通知綁在「更新畫面」那一步，分頁在背景時不會送達，
     * 所以另外補上 resize / orientationchange / 回到前景 三個入口，
     * 讓玩家切回分頁或轉螢幕之後畫布一定會重新量一次。 */
    w.addEventListener('resize', resize);
    w.addEventListener('orientationchange', function () { setTimeout(resize, 220); });
    if (w.document && w.document.addEventListener) {
      w.document.addEventListener('visibilitychange', function () {
        if (!w.document.hidden) setTimeout(resize, 60);
      });
    }
    resize();
  }

  function setState(next) {
    state = next;
    schedule();
  }

  /** 更新蓄力讀數；on 為 false 就收起來 */
  function setCharge(next) {
    charge.on = !!(next && next.on);
    if (next && next.angle !== undefined) charge.angle = next.angle;
    if (next && next.power !== undefined) charge.power = next.power;
    schedule();
  }

  function setAim(next) {
    if (next.side !== undefined) aim.side = next.side;
    if (next.angle !== undefined) aim.angle = next.angle;
    if (next.power !== undefined) aim.power = next.power;
    if (next.visible !== undefined) aim.visible = next.visible;
    schedule();
  }

  function setMotion(reduced, trail) {
    reduceMotion = !!reduced;
    if (trail !== undefined) showTrail = !!trail;
    schedule();
  }

  function clearTrail() { lastTrail = null; effects.length = 0; schedule(); }

  w.Board = {
    attach: attach,
    resize: resize,
    setState: setState,
    setAim: setAim,
    setCharge: setCharge,
    setMotion: setMotion,
    clearTrail: clearTrail,
    playShot: playShot,
    isBusy: isBusy,
    pointToAim: pointToAim,
    draw: draw
  };
}(window));
