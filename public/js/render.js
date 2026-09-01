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

  var canvas = null, ctx = null, stage = null;
  var scale = 1, cssW = 0, cssH = 0, dpr = 1;

  var state = null;
  var aim = { side: null, angle: 45, power: 60, visible: false, dragging: false };
  var anim = null;              // 飛行中的動畫
  var animDone = null;          // 爆炸當下要回呼的 callback
  var animGuard = 0;            // 動畫沒跑完時的保險絲計時器
  var effects = [];             // 爆炸、傷害數字
  var shake = 0;
  var rafId = 0;
  var reduceMotion = false;
  var showTrail = true;
  var lastTrail = null;         // 上一發的完整彈道（虛線留在畫面上當參考）

  /* 角色圖檔快取：把 SVG 轉成 Image 一次，之後直接 drawImage */
  var faceCache = {};
  function faceImage(side, mood) {
    var key = side + ':' + mood;
    if (faceCache[key]) return faceCache[key];
    var inner = side === 'dog' ? UI.dogFace(mood) : UI.catFace(mood);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + inner + '</svg>';
    var img = new Image();
    img.decoding = 'async';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    faceCache[key] = img;
    return img;
  }
  var ammoCache = {};
  function ammoImage(side) {
    if (ammoCache[side]) return ammoCache[side];
    var inner = side === 'dog' ? UI.bone() : UI.yarn();
    var svg = inner.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    var img = new Image();
    img.decoding = 'async';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    ammoCache[side] = img;
    return img;
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

  function drawFighter(f, isTurn) {
    var img = faceImage(f.side, f.mood || 'idle');
    var SIZE_W = 74;                     // 角色在世界座標裡的高度
    var size = SIZE_W * scale;
    var x = sx(f.x) - size / 2;
    var y = sy(f.y + SIZE_W);            // 腳底剛好站在地面上

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
      var ax = sx(f.x), ay = sy(f.y + 78);
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

    if (img.complete && img.naturalWidth) ctx.drawImage(img, x, y, size, size);
    else {
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
    if (!aim.visible || !aim.side || !state || state.over) return;
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

    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(sx(x1), sy(y1), Math.max(4, (5 + aim.power / 14) * scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4A3B55';
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.stroke();
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
    var pts = anim.shot.points;
    var idx = Math.min(pts.length - 1, Math.floor(anim.i));
    var p = pts[idx];
    if (!p) return;
    if (showTrail) drawTrail(pts.slice(0, idx + 1), 0.85);

    var img = ammoImage(anim.shot.side);
    var size = 30 * scale;
    var spin = reduceMotion ? 0 : anim.i * 0.22;
    ctx.save();
    ctx.translate(sx(p.x), sy(p.y));
    ctx.rotate(spin);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, -size / 2, -size / 2, size, size);
    else {
      ctx.fillStyle = anim.shot.side === 'cat' ? '#FFB8CF' : '#FFF7E8';
      ctx.strokeStyle = '#4A3B55'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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
        var r = (e.r * (0.35 + k * 0.9)) * scale;
        ctx.save();
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#FFE3A0';
        ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#E88CAA';
        ctx.lineWidth = Math.max(2, 5 * scale * (1 - k));
        ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r * 1.25, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
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
    drawTerrain();
    if (showTrail && lastTrail && !anim) drawTrail(lastTrail, 0.28);
    drawFighter(state.fighters.cat, !state.over && state.turn === 'cat');
    drawFighter(state.fighters.dog, !state.over && state.turn === 'dog');
    drawAim();
    drawProjectile();
    drawEffects();
    ctx.restore();
  }

  /* ------------------------------------------------------- 動畫迴圈 */

  function tick() {
    rafId = 0;
    var busy = false;

    if (anim) {
      var pts = anim.shot.points;
      anim.i += anim.speed;
      if (anim.i >= pts.length - 1) {
        var shot = anim.shot;
        anim = null;
        onImpact(shot);
      }
      busy = true;
    }
    if (effects.length || shake > 0.4) busy = true;

    draw();
    if (busy || (!reduceMotion && state && !state.over)) schedule();
  }

  function schedule() {
    if (rafId) return;
    rafId = w.requestAnimationFrame(tick);
  }

  function onImpact(shot) {
    clearTimeout(animGuard);
    animGuard = 0;
    lastTrail = shot.points;
    if (shot.impact) {
      effects.push({ type: 'boom', x: shot.impact.x, y: shot.impact.y, r: C.CRATER_R, at: Date.now(), life: 480 });
      shake = shot.result === 'direct' ? 16 : (shot.result === 'miss' ? 6 : 11);
    }
    /* 傷害數字浮在被打到的那一隻頭上，而不是只在角落偷偷改數字 */
    if (state) {
      if (shot.damage.cat > 0) {
        effects.push({ type: 'text', text: '-' + shot.damage.cat, x: state.fighters.cat.x, y: state.fighters.cat.y + 70, at: Date.now(), life: 1100, color: '#D2444F' });
      }
      if (shot.damage.dog > 0) {
        effects.push({ type: 'text', text: '-' + shot.damage.dog, x: state.fighters.dog.x, y: state.fighters.dog.y + 70, at: Date.now(), life: 1100, color: '#D2444F' });
      }
    }
    if (typeof animDone === 'function') {
      var cb = animDone;
      animDone = null;
      cb(shot);
    }
    schedule();
  }

  /**
   * 播放一發砲彈的飛行動畫。
   * onDone 會在爆炸的當下呼叫，讓 app.js 接著套用新狀態與音效。
   * 減少動態時直接跳到結果，不讓動畫拖慢下一步操作。
   */
  function playShot(shot, onDone) {
    lastTrail = null;
    clearTimeout(animGuard);

    /* 分頁在背景時瀏覽器會把 requestAnimationFrame 節流到幾乎不跑，
     * 所以背景分頁與減少動態一律直接跳到結果，不讓對局卡在動畫上。 */
    var hidden = !!(w.document && w.document.hidden);
    if (reduceMotion || hidden || !shot.points || shot.points.length < 2) {
      anim = null;
      animDone = onDone || null;
      onImpact(shot);
      return;
    }
    /* 飛行動畫大約 0.5 ~ 2 秒，跟實際飛行時間有關但不會讓玩家等太久 */
    var frames = Math.max(28, Math.min(120, shot.points.length));
    anim = { shot: shot, i: 0, speed: shot.points.length / frames };
    animDone = onDone || null;
    schedule();

    /* 保險絲：不管什麼原因（切到背景、瀏覽器省電、分頁被蓋住）動畫沒跑完，
     * 4.5 秒後強制結算這一發，玩家不會永遠等不到下一步。 */
    animGuard = setTimeout(function () {
      if (anim && anim.shot === shot) {
        anim = null;
        onImpact(shot);
      }
    }, 4500);
  }

  function isBusy() { return !!anim; }

  /* ------------------------------------------------------------ 對外 */

  function attach(canvasEl, stageEl) {
    canvas = canvasEl;
    stage = stageEl;
    ctx = canvas.getContext('2d');
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
    setMotion: setMotion,
    clearTrail: clearTrail,
    playShot: playShot,
    isBusy: isBusy,
    pointToAim: pointToAim,
    draw: draw
  };
}(window));
