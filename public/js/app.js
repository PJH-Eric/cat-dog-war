/* ===== app.js — 畫面、輸入、單機對局與線上房間的黏合層 =====
 *
 * 這裡不含任何遊戲規則：合法性、傷害、勝負一律問 Rules；
 * 線上模式的「我能不能做這件事」一律看伺服器算好的 you.can。
 * 單機與線上共用同一個 renderBattle(ctx)，所以兩邊畫面永遠一致。
 */
(function (w) {
  'use strict';

  var Rules = w.Rules, AI = w.AI, RNG = w.RNG, UI = w.UI, Board = w.Board;
  var Sound = w.Sound, Store = w.Store, Config = w.GameConfig, Online = w.Online;
  var C = Rules.CONST;
  var TURN_MS = C.TURN_MS || 15 * 1000;
  var ONLINE_TURN_PAUSE_MS = 650;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* 貓咪的放大道具用魚骨頭 SVG；發射出去的飛行物仍由 Board 畫成砲彈。 */
  function itemIcon(side, key) {
    if (side === 'cat' && key === 'bigbone') return UI.fishBone();
    return esc(Rules.ITEMS[key].icon);
  }

  /* ------------------------------------------------------------ 狀態 */

  var app = {
    screen: 's-home',
    mode: null,                 // null | 'solo' | 'online'
    aim: { angle: 45, power: 60 },
    item: null,                 // 這一發要搭配的道具；一回合最多一個，不能疊加
    /* 戰場／發射鈕的暫時蓄力狀態；戰場手勢可同時瞄準與蓄力 */
    charge: {
      on: false, armed: false, t0: 0, raf: 0, armTimer: 0,
      pointerId: null, source: null, basePower: 60, startAngle: 45, startPower: 60,
      suppressClick: false, clickTimer: 0, outside: false
    },
    busy: false,                // 動畫播放中，暫時不能再出手；線上事件另有排隊
    chatOpen: false,
    unread: 0,
    lastTurnAnnounced: '',
    solo: {
      state: null, mySide: 'cat', aiSide: 'dog', level: 'normal',
      seed: '', summary: [], aiTimer: null, thinking: false, turnDeadline: 0
    },
    online: {
      view: null, code: null, pendingInvite: null, netStatus: 'idle', netMessage: '',
      resultMarker: null, shotQueue: [], waitingForShot: false, shotPauseTimer: null
    }
  };

  /* ------------------------------------------------------------ 畫面切換 */

  var SCREENS = ['s-home', 's-solo', 's-help', 's-stats', 's-lobby', 's-battle'];

  function show(id) {
    if (isSettingsOpen()) closeSettings();
    if (isBattleSettingsOpen()) closeBattleSettings();
    SCREENS.forEach(function (s) {
      var el = $(s);
      if (el) el.classList.toggle('active', s === id);
    });
    app.screen = id;
    if (id === 's-battle') {
      $('battle-aside').classList.remove('open');
      $('battle').classList.remove('aside-open');
      $('b-aside-toggle').setAttribute('aria-expanded', 'false');
      Sound.setTrack('battle');
      setTimeout(function () { Board.resize(); }, 30);
    } else {
      Sound.setTrack('menu');
    }
    if (Online.isConnected()) {
      if (id === 's-lobby') Online.send('lobby:subscribe');
      else if (!app.online.code) Online.send('lobby:unsubscribe');
    }
    if (Sound.isUnlocked()) Sound.startBgm();
  }

  /* ------------------------------------------------------------ Toast */

  var toastTimer = null;
  function toast(message, kind) {
    var el = $('toast');
    el.textContent = message;
    el.setAttribute('data-kind', kind || 'info');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, kind === 'error' ? 4200 : 2600);
  }

  function hint(message, kind) {
    var el = $('ctrl-hint');
    el.textContent = message;
    el.setAttribute('data-kind', kind || 'info');
    var stageHint = $('stage-gesture-hint');
    if (stageHint && !stageHint.hidden) {
      stageHint.textContent = message;
      stageHint.setAttribute('data-kind', kind || 'info');
    }
  }

  /* ============================================================ 教學 */

  var TUTORIAL = [
    {
      title: '這是什麼遊戲？',
      html: '<p>一隻貓站在畫面左邊、一隻狗站在右邊，中間隔著一道圍牆。</p>' +
        '<p>兩邊<b>輪流出手</b>：貓咪和狗狗都丟砲彈。砲彈會受重力往下掉、受風往旁邊吹，畫出一條拋物線。</p>' +
        '<p>打中對方就扣血：身體是標準傷害，腿部較輕，頭部會出現 <b>💥 爆擊</b> 並造成更高傷害；先把對方血量打到 <b>0</b> 的一方獲勝。</p>'
    },
    {
      title: '一次出手要決定兩件事',
      html: '<ul>' +
        '<li><b>角度</b>：從水平到接近垂直都能瞄準。按住戰場後往不同方向移動，就能調整發射方向。</li>' +
        '<li><b>力道</b>：10 到 100。力道越大飛越遠，滿力大約可以從畫面這一端打到另一端。</li>' +
        '</ul>' +
        '<p>按住戰場持續蓄力，放開就發射；蓄力中的彈頭會變成箭頭提示方向。</p>'
    },
    {
      title: '多種瞄準方式，挑順手的用',
      html: '<ul>' +
        '<li><b>戰場按住拖曳</b>（平板、手機最順）：手指按在戰場上往你想打的方向移動，會同時調整角度與力道；繼續按住會蓄力，<b>放開就發射</b>。快速點一下只會保留瞄準。</li>' +
        '<li>不想發射時，把手指拖出戰場再放開即可取消這次瞄準。</li>' +
        '<li><b>鍵盤</b>：<span class="key">←</span> <span class="key">→</span> 調角度，<span class="key">↑</span> <span class="key">↓</span> 調力道，<span class="key">空白鍵</span> 發射。</li>' +
        '</ul>' +
        '<p>蓄力時虛線末端會變成箭頭，箭頭越大代表力道越大；平時則顯示圓點。</p>'
    },
    {
      title: '風向會把砲彈吹歪',
      html: '<p>畫面上方的「風向」標籤會顯示箭頭與數字，例如「→ 6.3 強風」。</p>' +
        '<ul>' +
        '<li>箭頭往右＝砲彈會被往右推，箭頭往左就往左推。</li>' +
        '<li>數字越大吹得越用力；「無風」時可以完全不管它。</li>' +
        '<li><b>每一回合的風都會重新決定</b>，上一發準不代表這一發照抄就會中。</li>' +
        '</ul>' +
        '<p>逆風時要抬高角度或加大力道，順風時反而要收一點。</p>'
    },
    {
      title: '傷害、地形與圍牆',
      html: '<ul>' +
        '<li><b>直接打到身上</b>：扣最多血（20 點；部分道具會更高）。</li>' +
        '<li><b>打在附近的地上</b>：離得越近扣越多，太遠就完全不扣。</li>' +
        '<li><b>打到自己腳邊</b>：自己也會受傷，力道太小要小心。</li>' +
        '<li>每次爆炸都會<b>炸出一個坑</b>，中間那道圍牆也會慢慢被打矮，後面幾發會越來越好打。</li>' +
        '</ul>' +
        '<p>右上角 📋 可以打開精簡的<b>操作摘要</b>；雙方剩餘道具會直接顯示在戰場天空左右兩邊。</p>'
    },
    {
      title: '單機、線上與電腦難度',
      html: '<ul>' +
        '<li><b>單機對戰</b>：選一邊、選難度就能開打。簡單／普通／困難用的是同一套規則和同一個物理引擎，電腦不會偷改傷害，差別只在它算得多細、補不補償風向、手抖多大。</li>' +
        '<li><b>線上對戰</b>：開一間房，把邀請連結傳給朋友，兩台不同電腦各選一邊就能打；其他人可以進來<b>觀戰</b>，觀戰者看得到盤面和摘要，但不能出手。</li>' +
        '<li>房間裡有<b>聊天室</b>（戰場左下角的 💬），每次出手限時 <b>15 秒</b>，超過會自動跳過那一回合；對局會一直進行到一方血量歸零，也可以主動投降。</li>' +
        '</ul>' +
        '<p>右上角的 <b>⚙ 系統設定</b> 可調整全域的音樂、音效、震動與顯示偏好；進入對戰後，戰場上方會出現 <b>🎮 對戰設定</b>。</p>'
    }
  ];

  var tutIndex = 0;
  function renderTutorial() {
    var t = TUTORIAL[tutIndex];
    $('tut-progress').textContent = '第 ' + (tutIndex + 1) + ' 段 / 共 ' + TUTORIAL.length + ' 段：' + t.title;
    $('tut-box').innerHTML = '<h3>' + esc(t.title) + '</h3>' + t.html;
    $('b-tut-prev').disabled = tutIndex === 0;
    UI.setLabel($('b-tut-next'), tutIndex === TUTORIAL.length - 1 ? '看完了 ✔' : '下一段 ▶');
  }

  /* ============================================================ 戰績 */

  function renderStats() {
    var s = Store.stats();
    var block = function (title, b) {
      var total = b.win + b.lose + b.draw;
      var rate = total ? Math.round(b.win / total * 100) : 0;
      return '<div class="statcard"><h3>' + esc(title) + '</h3>' +
        '<div class="statrow"><span>總場數</span><b>' + total + '</b></div>' +
        '<div class="statrow"><span>勝</span><b>' + b.win + '</b></div>' +
        '<div class="statrow"><span>敗</span><b>' + b.lose + '</b></div>' +
        '<div class="statrow"><span>平手</span><b>' + b.draw + '</b></div>' +
        '<div class="statrow"><span>勝率</span><b>' + rate + '%</b></div>' +
        '</div>';
    };
    $('statgrid').innerHTML = block('單機對戰', s.solo) + block('線上對戰', s.online);
  }

  /* ============================================================ 對局內容模型
   * 單機與線上都轉成同一個 ctx，renderBattle 只認得 ctx。
   */

  function soloCtx() {
    var s = app.solo;
    var st = s.state;
    var myTurn = st && !st.over && st.turn === s.mySide;
    return {
      mode: 'solo',
      phase: st ? (st.over ? 'finished' : 'playing') : 'waiting',
      game: st,
      mySide: s.mySide,
      role: 'player',
      canFire: !!myTurn && !app.busy && !s.thinking,
      canChat: false,
      summary: s.summary,
      members: null,
      room: null,
      deadline: s.turnDeadline || 0,
      net: '單機（不需要連線）',
      thinking: s.thinking,
      levelLabel: AI.levelOf(s.level).label
    };
  }

  function onlineCtx() {
    var v = app.online.view;
    if (!v) return null;
    var you = v.you || {};
    return {
      mode: 'online',
      phase: v.room.phase,
      game: v.game,
      mySide: you.side || null,
      role: you.role || 'spectator',
      canFire: !!(you.can && you.can.fire) && !app.busy && !app.online.waitingForShot &&
        app.online.shotQueue.length === 0 && !app.online.shotPauseTimer,
      canChat: !!(you.can && you.can.chat),
      summary: v.room.summary || [],
      members: v.room.members || [],
      room: v.room,
      you: you,
      deadline: v.room.turnDeadline || 0,
      net: netLabel(),
      thinking: isAiTurn(v),
      levelLabel: ''
    };
  }

  function isAiTurn(v) {
    if (!v || !v.game || v.game.over || v.room.phase !== 'playing') return false;
    var seat = v.room.seats[v.game.turn];
    return !!(seat && seat.kind === 'ai');
  }

  function netLabel() {
    var s = app.online.netStatus;
    if (s === 'connected') return '已連線';
    if (s === 'connecting') return '重新連線中…';
    if (s === 'loading') return '載入中…';
    if (s === 'offline') return '沒有伺服器';
    if (s === 'error') return '連線失敗';
    return '未連線';
  }

  function currentCtx() {
    if (app.mode === 'solo') return soloCtx();
    if (app.mode === 'online') return onlineCtx();
    return null;
  }

  function resetOnlinePlayback() {
    app.online.shotQueue.length = 0;
    app.online.waitingForShot = false;
    app.item = null;
    clearTimeout(app.online.shotPauseTimer);
    app.online.shotPauseTimer = null;
  }

  /* ============================================================ 戰場畫面 */

  function renderBattle() {
    var ctx = currentCtx();
    if (!ctx) return;

    if (ctx.game) Board.setState(ctx.game);
    renderHp(ctx);
    renderTurnbar(ctx);
    renderControls(ctx);
    syncBattleSettingsUi(ctx);
    renderStageItems(ctx);
    renderSummary(ctx);
    renderOverlay(ctx);
    renderChatDock(ctx);
    updateAimVisibility(ctx);
    syncControlsHeight();
  }

  var lastControlsH = -1;

  /**
   * 控制列目前隱藏，這個同步點保留給舊版 DOM 與 toast 定位相容；
   * 量到高度變化時仍重新計算畫布尺寸，避免不同瀏覽器留下舊尺寸。
   */
  function syncControlsHeight() {
    var controls = $('controls');
    if (!controls) return;
    var h = controls.offsetHeight;
    if (h === lastControlsH) return;
    lastControlsH = h;
    /* 若未來重新顯示控制列，toast 仍能取得正確的下方安全距離。 */
    document.documentElement.style.setProperty('--controls-h', h + 'px');
    Board.resize();
  }

  function renderHp(ctx) {
    ['cat', 'dog'].forEach(function (side) {
      var card = $('hp-' + side);
      var g = ctx.game;
      var f = g ? g.fighters[side] : null;
      var hp = f ? f.hp : C.MAX_HP;
      var max = g ? g.maxHp : C.MAX_HP;
      var pct = Math.max(0, Math.min(100, hp / max * 100));
      var bar = card.querySelector('.hpbar i');
      bar.style.width = pct + '%';
      bar.className = pct <= 25 ? 'crit' : (pct <= 55 ? 'low' : '');
      card.querySelector('.hpnum').textContent = hp;
      card.querySelector('.hpface').innerHTML = UI.avatar(side, f ? f.mood : 'idle', Rules.SIDE_LABEL[side]);
      card.classList.toggle('turn', !!(g && !g.over && g.turn === side));
      card.classList.toggle('down', hp <= 0);
      var name = Rules.SIDE_LABEL[side];
      if (ctx.mode === 'online' && ctx.room) {
        var seat = ctx.room.seats[side];
        if (seat && seat.kind !== 'open') name = Rules.SIDE_LABEL[side] + '：' + seat.name;
      } else if (ctx.mode === 'solo') {
        name = Rules.SIDE_LABEL[side] + (side === ctx.mySide ? '（你）' : '（電腦 ' + ctx.levelLabel + '）');
      }
      card.querySelector('.hpname').textContent = name;
      card.setAttribute('aria-label', name + ' 血量 ' + hp + ' / ' + max);
    });
  }

  function renderTurnbar(ctx) {
    var chip = $('turn-chip');
    var g = ctx.game;
    if (!g) {
      chip.textContent = ctx.phase === 'waiting' ? '等待開始' : '準備中';
      chip.setAttribute('data-wait', 'true');
      chip.removeAttribute('data-side');
    } else if (g.over) {
      chip.textContent = g.winner === 'draw' ? '平手' : (Rules.SIDE_LABEL[g.winner] + ' 獲勝');
      chip.setAttribute('data-wait', 'true');
      chip.removeAttribute('data-side');
    } else {
      var mine = ctx.mySide && g.turn === ctx.mySide;
      chip.textContent = '第 ' + g.turnNo + ' 回合 · ' +
        (mine ? '輪到你（' + Rules.SIDE_LABEL[g.turn] + '）' : '輪到' + Rules.SIDE_LABEL[g.turn]) +
        (ctx.thinking ? ' · 電腦思考中…' : '');
      chip.setAttribute('data-side', g.turn);
      chip.setAttribute('data-wait', mine ? 'false' : 'true');
    }

    var wind = g ? g.wind : 0;
    $('wind-svg').innerHTML = UI.windArrow(wind);
    $('wind-text').textContent = Rules.describeWind(wind);
    $('wind-chip').setAttribute('aria-label', '風向 ' + Rules.describeWind(wind));

    var timer = $('timer-chip');
    if (ctx.phase === 'playing' && ctx.deadline) {
      var left = Math.max(0, Math.ceil((ctx.deadline - Date.now()) / 1000));
      timer.hidden = false;
      timer.textContent = '⏱ ' + left + ' 秒';
      timer.setAttribute('data-urgent', left <= 5 ? 'true' : 'false');
    } else {
      timer.hidden = true;
    }
  }

  function renderControls(ctx) {
    var can = ctx.canFire;
    $('in-angle').disabled = !can;
    $('in-power').disabled = !can;
    $('b-angle-up').disabled = !can;
    $('b-angle-dn').disabled = !can;
    $('b-power-up').disabled = !can;
    $('b-power-dn').disabled = !can;
    $('b-fire').disabled = !can;
    renderItemBar(ctx);

    var stageHint = $('stage-gesture-hint');
    if (stageHint) {
      stageHint.hidden = !(ctx.game && !ctx.game.over && can);
    }

    if (!ctx.game || ctx.phase === 'waiting') {
      hint(ctx.mode === 'online' ? '等房主按下「開始對局」。' : '準備開打。');
    } else if (ctx.game.over) {
      hint('這一局結束了：' + ctx.game.reason);
    } else if (can) {
      hint('輪到你了：按住戰場並移動可同時瞄準、蓄力，放開就發射；快速點一下只保留瞄準。');
    } else if (ctx.role === 'spectator') {
      hint('你正在觀戰，看得到全部盤面與摘要，但不能出手。');
    } else if (ctx.thinking) {
      hint('電腦正在計算彈道，請稍候…');
    } else if (app.busy) {
      hint('砲彈飛行中…');
    } else {
      hint('現在輪到' + Rules.SIDE_LABEL[ctx.game.turn] + '，等對手出手。');
    }
  }

  function syncBattleSettingsUi(ctx) {
    var toggle = $('b-battle-settings');
    if (!toggle) return;
    var visible = app.screen === 's-battle' && !!(ctx && ctx.game);
    toggle.hidden = !visible;
    toggle.setAttribute('aria-expanded', visible && isBattleSettingsOpen() ? 'true' : 'false');
    if (!visible) {
      if (isBattleSettingsOpen()) closeBattleSettings();
      return;
    }

    var playing = (app.mode === 'solo' && app.solo.state) || (app.mode === 'online' && app.online.view);
    var soloCanRestart = app.mode === 'solo' && app.solo.state;
    var soloCanSurrender = app.mode === 'solo' && app.solo.state && !app.solo.state.over && !app.busy;
    var onlineCanSurrender = app.mode === 'online' && app.online.view && app.online.view.you &&
      app.online.view.you.can && app.online.view.you.can.surrender;
    $('battle-settings-restart').disabled = !soloCanRestart;
    $('battle-settings-surrender').disabled = !(soloCanSurrender || onlineCanSurrender);
    $('battle-settings-quit').disabled = !playing;
    $('battle-settings-game-note').textContent = !playing
      ? '目前沒有進行中的對戰。'
      : (app.mode === 'solo'
        ? '單機對戰中：重新開始會換一張新地圖；「投降」會直接判定你落敗。'
        : '線上對戰中：「投降」或離開房間，都會讓對手獲勝。');
  }

  /** 把雙方剩餘道具放到天空左右兩側；自己的按鈕可以直接選用，對手的只供查看。 */
  function renderStageItems(ctx) {
    var hud = $('stage-items');
    if (!hud) return;
    var g = ctx && ctx.game;
    if (!g || !g.items) {
      hud.hidden = true;
      hud.innerHTML = '';
      return;
    }

    hud.hidden = false;
    hud.innerHTML = ['cat', 'dog'].map(function (side) {
      var own = ctx.mySide === side;
      var can = own && !!ctx.canFire;
      var locked = own && !!app.item;
      var bag = g.items[side] || {};
      var controls = [];

      if (own) {
        controls.push('<button class="stage-item-btn' + (!app.item ? ' selected' : '') + (locked ? ' locked' : '') + '"' +
          ' type="button" role="radio" data-stage-side="' + side + '" data-stage-item=""' +
          ' aria-label="' + esc(Rules.SIDE_LABEL[side]) + '這一發不用道具"' +
          ' aria-checked="' + (!app.item ? 'true' : 'false') + '"' + (can && !locked ? '' : ' disabled') + '>' +
          '<span class="ico">🎯</span><span class="num">—</span></button>');
      }

      Rules.ITEM_ORDER.forEach(function (key) {
        var it = Rules.ITEMS[key];
        var n = bag[key] || 0;
        var out = n <= 0;
        var selected = own && app.item === key;
        var enabled = can && !out && !locked;
        controls.push('<button class="stage-item-btn' + (out ? ' used' : '') + (selected ? ' selected' : '') + (locked ? ' locked' : '') + '"' +
          ' type="button" role="radio" data-stage-side="' + side + '" data-stage-item="' + key + '"' +
          ' aria-label="' + esc(Rules.SIDE_LABEL[side] + '的' + it.label + '，剩 ' + n + ' 個。') + '"' +
          ' title="' + esc(it.label + '：' + it.note) + '" aria-checked="' + (selected ? 'true' : 'false') + '"' +
          (enabled ? '' : ' disabled') + '><span class="ico">' + itemIcon(side, key) +
          '</span><span class="num">' + n + '</span></button>');
      });

      return '<section class="stage-item-panel' + (own ? ' mine' : '') + '" data-side="' + side + '"' +
        ' aria-label="' + Rules.SIDE_LABEL[side] + '剩餘道具">' +
        '<div class="stage-item-head"><b>' + Rules.SIDE_LABEL[side] + '</b><span>' + (own ? (locked ? '已鎖定' : '你的道具') : '對手道具') + '</span>' +
        (own ? '<button class="stage-reset-btn" id="b-reset-aim" type="button" data-stage-reset' +
          ' aria-label="重置角度與力道；' + (locked ? '保留已選道具' : '不變更道具') + '"' +
          (can ? '' : ' disabled') + '>↺ 重置</button>' : '') + '</div>' +
        '<div class="stage-item-list" role="radiogroup" aria-label="' + Rules.SIDE_LABEL[side] + '道具">' +
        controls.join('') + '</div></section>';
    }).join('');
  }

  function renderSummary(ctx) {
    var g = ctx.game;
    var turn = $('sum-turn');
    if (turn) {
      turn.textContent = !g ? '尚未開始'
        : (g.over ? '已結束（共 ' + (g.turnNo) + ' 回合）' : '第 ' + g.turnNo + ' 回合 · ' + Rules.SIDE_LABEL[g.turn]);
    }

    var can;
    if (!g || ctx.phase === 'waiting') can = ctx.mode === 'online' ? '選邊、按準備、傳邀請連結' : '按開始';
    else if (g.over) can = ctx.mode === 'online' ? '再來一局 或 離開房間' : '再玩一局 或 回主選單';
    else if (ctx.canFire) can = '按住戰場移動，放開發射；也可用鍵盤方向鍵微調';
    else if (ctx.role === 'spectator') can = '觀戰中：可以看盤面、摘要與聊天，不能出手';
    else can = '等待對手出手';
    var canEl = $('sum-can');
    if (canEl) canEl.textContent = can;

    var windEl = $('sum-wind');
    if (windEl) windEl.textContent = g ? Rules.describeWind(g.wind) : '—';
    var hpEl = $('sum-hp');
    if (hpEl) {
      hpEl.textContent = g
        ? ('貓 ' + g.fighters.cat.hp + ' · 狗 ' + g.fighters.dog.hp)
        : '—';
    }

    var timerText = '—';
    if (ctx.phase === 'playing' && ctx.deadline) {
      timerText = Math.max(0, Math.ceil((ctx.deadline - Date.now()) / 1000)) + ' 秒';
    }
    var timerEl = $('sum-timer');
    if (timerEl) timerEl.textContent = timerText;

    /* 每一發紀錄 */
    var list = $('sum-list');
    var items = (ctx.summary || []).slice(-5).reverse();
    if (!items.length) {
      list.innerHTML = '';
      $('sum-empty').hidden = false;
    } else {
      $('sum-empty').hidden = true;
      list.innerHTML = items.map(function (s) {
        var foe = Rules.other(s.side);
        var hitting = s.damage && s.damage[foe] > 0;
        var head = '第 ' + s.n + ' 回合 · ' + Rules.SIDE_LABEL[s.side] +
          (s.aiLevel ? '（電腦 ' + AI.levelOf(s.aiLevel).label + '）' : '');
        var detail = s.result === 'pass'
          ? '時間到，這回合跳過'
          : (s.result === 'surrender'
            ? '主動投降，對局結束'
            : ((s.critical ? '💥 爆擊！' : '') +
              (s.hitPart ? ((s.critical ? ' ' : '') + (Rules.HIT_PART_LABEL[s.hitPart] || '部位') + '命中') : '') +
              (s.critical || s.hitPart ? ' · ' : '') +
              '方向依箭頭 · 力道 ' + s.power + ' · 風 ' + Rules.describeWind(s.wind)));
        var outcome = s.result === 'pass' ? '' :
          (Rules.RESULT_TEXT[s.result] || '') +
          (hitting ? '，' + Rules.SIDE_LABEL[foe] + ' -' + s.damage[foe] : '') +
          (s.damage && s.damage[s.side] > 0 ? '，自己 -' + s.damage[s.side] : '') +
          (!hitting && s.distance !== null && s.distance !== undefined ? '（差 ' + Math.round(s.distance) + '）' : '');
        return '<li data-side="' + s.side + '" data-hit="' + (hitting ? 'true' : 'false') + '">' +
          '<span class="sl-head"><span>' + esc(head) + '</span>' +
          '<span>' + (s.hpAfter ? '🐱' + s.hpAfter.cat + ' 🐶' + s.hpAfter.dog : '') + '</span></span>' +
          '<span class="sl-body">' + esc(detail) + (outcome ? ' → ' + esc(outcome) : '') + '</span>' +
          '</li>';
      }).join('');
    }
  }

  /* ---------------------------------------------------------- 疊層 */

  function renderOverlay(ctx) {
    var host = $('stage-overlay');
    var card = $('overlay-card');
    var html = null;

    if (ctx.mode === 'solo') {
      if (ctx.game && ctx.game.over) html = soloResultHtml(ctx);
    } else if (ctx.room) {
      if (ctx.phase === 'waiting') html = roomWaitingHtml(ctx);
      else if (ctx.phase === 'finished') html = roomResultHtml(ctx);
    }

    if (html === null) {
      host.hidden = true;
      card.innerHTML = '';
      card._html = null;
      return;
    }
    /* 只有內容真的變了才重畫，避免玩家正在選取邀請連結時被洗掉 */
    if (card._html !== html) {
      card.innerHTML = html;
      card._html = html;
      UI.decorateAll(card);
    }
    host.hidden = false;
  }

  function soloResultHtml(ctx) {
    var g = ctx.game;
    var won = g.winner === ctx.mySide;
    var draw = g.winner === 'draw';
    return '<div class="resulttrophy">' + (draw ? '' : UI.trophy()) + '</div>' +
      '<h3>' + (draw ? '平手！' : (won ? '你贏了！' : '這次輸了…')) + '</h3>' +
      '<div class="resulthead">' +
      '<span class="rface">' + UI.avatar('cat', g.fighters.cat.mood) + '</span>' +
      '<b>' + g.fighters.cat.hp + ' : ' + g.fighters.dog.hp + '</b>' +
      '<span class="rface">' + UI.avatar('dog', g.fighters.dog.mood) + '</span>' +
      '</div>' +
      '<p>' + esc(g.reason) + '</p>' +
      '<div class="overlay-btns">' +
      '<button class="btn3d" data-color="mint" data-act="solo-again">🔁 再玩一局</button>' +
      '<button class="btn3d" data-color="lemon" data-act="solo-setup">⚙ 換難度或換邊</button>' +
      '<button class="btn3d" data-color="cream" data-act="home">🏠 回主選單</button>' +
      '</div>';
  }

  function seatCardHtml(ctx, side) {
    var seat = ctx.room.seats[side];
    var you = ctx.you || {};
    var mine = seat.kind === 'human' && seat.id === you.id;
    var canPick = you.can && you.can.pickSide && seat.kind === 'open';
    var canAi = you.can && you.can.setAi;

    var stateText;
    if (seat.kind === 'open') stateText = '空位';
    else if (seat.kind === 'ai') stateText = '電腦對手';
    else stateText = (seat.ready ? '已準備' : '尚未準備') + (seat.connected ? '' : '（斷線中）');

    var html = '<div class="seatcard' + (mine ? ' mine' : '') + '">' +
      '<span class="sface">' + UI.avatar(side, 'idle') + '</span>' +
      '<span class="sname">' + esc(Rules.SIDE_LABEL[side]) + '：' + esc(seat.name) + '</span>' +
      '<span class="sstate' + (seat.ready && seat.kind === 'human' ? ' ready' : '') + '">' + esc(stateText) + '</span>';

    if (canPick) {
      html += '<button class="btn3d small" data-color="grape" data-act="pick" data-side="' + side + '">選這一邊</button>';
    } else if (mine) {
      html += '<button class="btn3d small" data-color="cream" data-act="leaveseat">離開這一邊</button>';
    }
    if (canAi && seat.kind !== 'human') {
      html += seat.kind === 'ai'
        ? '<button class="btn3d small" data-color="peach" data-act="ai-off" data-side="' + side + '">移除電腦</button>'
        : '<button class="btn3d small" data-color="lemon" data-act="ai-on" data-side="' + side + '">補電腦（' + esc(AI.levelOf(Store.aiLevel()).label) + '）</button>';
    }
    html += '</div>';
    return html;
  }

  function roomWaitingHtml(ctx) {
    var you = ctx.you || {};
    var can = you.can || {};
    var room = ctx.room;

    var html = '<h3>房間準備中</h3>' +
      '<div class="roomcode"><span>房號</span><b>' + esc(room.code) + '</b>' +
      '<button class="btn3d small" data-color="cream" data-act="copy-code">📋 複製房號</button></div>' +
      '<div class="seatrow">' + seatCardHtml(ctx, 'cat') + seatCardHtml(ctx, 'dog') + '</div>';

    if (can.invite) {
      var inv = (room.invites || [])[0];
      html += '<div class="invitebox"><label>邀請連結（傳給另一台電腦的朋友）</label>' +
        '<div class="inviterow">' +
        '<input id="invite-url" readonly value="' + (inv ? esc(Config.inviteUrl(room.code, inv.token)) : '') + '" placeholder="按右邊的按鈕產生一組">' +
        '<button class="btn3d small" data-color="grape" data-act="invite-new">🔗 產生</button>' +
        (inv ? '<button class="btn3d small" data-color="mint" data-act="invite-copy">📋 複製</button>' +
               '<button class="btn3d small" data-color="peach" data-act="invite-revoke" data-token="' + esc(inv.token) + '">撤銷</button>' : '') +
        '</div>' +
        (inv ? '<p class="invitemeta">身分：' + (inv.role === 'player' ? '以玩家加入' : inv.role === 'spectator' ? '以觀戰加入' : '玩家或觀戰（看還有沒有空位）') +
               ' · 有效到 ' + new Date(inv.expiresAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) +
               ' · 已用 ' + inv.uses + '/' + inv.maxUses + ' 次</p>'
             : '<p class="invitemeta">連結會綁定這間房、有使用次數上限和有效期限，隨時可以撤銷。</p>') +
        '</div>';
    }

    var btns = [];
    if (can.ready) {
      btns.push('<button class="btn3d" data-color="' + (you.ready ? 'cream' : 'mint') + '" data-act="ready" data-v="' + (you.ready ? '0' : '1') + '">' +
        (you.ready ? '取消準備' : '✔ 準備好了') + '</button>');
    }
    if (can.becomePlayer) btns.push('<button class="btn3d" data-color="grape" data-act="become-player">🐾 加入對戰</button>');
    if (you.role === 'player' && ctx.phase !== 'playing') {
      btns.push('<button class="btn3d" data-color="sky" data-act="become-spectator">👀 改成觀戰</button>');
    }
    if (you.isHost) {
      btns.push('<button class="btn3d" data-color="peach" data-act="start"' + (can.start ? '' : ' disabled') + '>▶ 開始對局</button>');
    }
    btns.push('<button class="btn3d" data-color="cream" data-act="leave-room">🚪 離開房間</button>');

    html += '<div class="overlay-btns">' + btns.join('') + '</div>';

    var note;
    if (you.role === 'spectator') note = '你目前是觀戰者：可以看盤面、摘要與聊天，開打後不能出手。';
    else if (!you.side) note = '先選一邊（貓咪或狗狗），再按「準備好了」。';
    else if (!can.start && you.isHost) note = can.startBlockedBy || '';
    else if (!you.isHost) note = '等房主按下「開始對局」。';
    else note = '兩邊都準備好了，可以開打。';
    if (note) html += '<p class="memberline">' + esc(note) + '</p>';
    html += '<p class="memberline">目前 ' + (room.members || []).length + ' 人在房間裡（觀戰 ' + (room.spectators || []).length + ' 人）。</p>';
    return html;
  }

  function roomResultHtml(ctx) {
    var g = ctx.game;
    var you = ctx.you || {};
    var can = you.can || {};
    var mine = you.side;
    var draw = g && g.winner === 'draw';
    var won = g && mine && g.winner === mine;

    var title;
    if (!g) title = '對局結束';
    else if (draw) title = '平手！';
    else if (!mine) title = Rules.SIDE_LABEL[g.winner] + ' 獲勝';
    else title = won ? '你贏了！' : '這次輸了…';

    var html = '<div class="resulttrophy">' + (draw || !g ? '' : UI.trophy()) + '</div>' +
      '<h3>' + esc(title) + '</h3>';
    if (g) {
      html += '<div class="resulthead">' +
        '<span class="rface">' + UI.avatar('cat', g.fighters.cat.mood) + '</span>' +
        '<b>' + g.fighters.cat.hp + ' : ' + g.fighters.dog.hp + '</b>' +
        '<span class="rface">' + UI.avatar('dog', g.fighters.dog.mood) + '</span>' +
        '</div><p>' + esc(g.reason) + '</p>';
    }

    var btns = [];
    if (can.rematch) {
      btns.push('<button class="btn3d" data-color="mint" data-act="rematch">🔁 再來一局</button>');
    }
    if (can.becomePlayer) btns.push('<button class="btn3d" data-color="grape" data-act="become-player">🐾 加入對戰</button>');
    btns.push('<button class="btn3d" data-color="cream" data-act="leave-room">🚪 離開房間</button>');
    html += '<div class="overlay-btns">' + btns.join('') + '</div>';
    if (ctx.room && ctx.room.rematchVotes > 0) {
      html += '<p class="memberline">已經有 ' + ctx.room.rematchVotes + ' 人同意再來一局。</p>';
    }
    if (!can.rematch && you.role === 'spectator') {
      html += '<p class="memberline">觀戰者不能投票再來一局，等場上的玩家決定。</p>';
    }
    return html;
  }

  /* ---------------------------------------------------------- 聊天室 */

  function renderChatDock(ctx) {
    var dock = $('chatdock');
    if (ctx.mode !== 'online' || !ctx.room) { dock.hidden = true; return; }
    dock.hidden = false;
    $('chat-scope').textContent = '房號 ' + ctx.room.code + '｜' + (ctx.room.name || '');
    $('chat-input').disabled = !ctx.canChat;
    $('b-chat-send').disabled = !ctx.canChat;
    $('chat-state').textContent = ctx.canChat
      ? (Online.isConnected() ? '' : '目前離線，訊息送不出去。')
      : '你被暫時禁言，無法發言。';
    $('chat-state').setAttribute('data-kind', ctx.canChat && Online.isConnected() ? 'info' : 'error');
    renderChatList(ctx.room.chat || [], ctx.you ? ctx.you.id : null);
  }

  function renderChatList(list, myId) {
    var el = $('chat-list');
    if (!list.length) {
      el.innerHTML = '<p class="chat-empty">還沒有訊息。打個招呼吧！</p>';
      return;
    }
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = list.map(function (m) {
      if (m.kind === 'system') {
        return '<div class="chat-msg" data-role="system">' + esc(m.text) + '</div>';
      }
      return '<div class="chat-msg" data-role="' + esc(m.role) + '" data-side="' + esc(m.side || '') +
        '" data-mine="' + (m.fromId === myId ? 'true' : 'false') + '">' +
        '<span class="who">' + esc(m.from) + (m.role === 'spectator' ? '（觀戰）' : '') + '</span>' +
        esc(m.text) + '</div>';
    }).join('');
    if (atBottom || app.chatOpen) el.scrollTop = el.scrollHeight;
  }

  function setChatOpen(open) {
    app.chatOpen = !!open;
    $('chat-panel').hidden = !app.chatOpen;
    $('b-chat-toggle').setAttribute('aria-expanded', app.chatOpen ? 'true' : 'false');
    if (app.chatOpen) {
      app.unread = 0;
      updateUnread();
      var el = $('chat-list');
      el.scrollTop = el.scrollHeight;
      setTimeout(function () { $('chat-input').focus(); }, 40);
    }
  }

  function updateUnread() {
    var badge = $('chat-unread');
    badge.hidden = app.unread <= 0;
    badge.textContent = app.unread > 99 ? '99+' : String(app.unread);
  }

  /* ---------------------------------------------------------- 道具 */

  /** 我這一邊的背包；還沒開局或身分是觀戰者時回傳空的 */
  function myBag(ctx) {
    if (!ctx || !ctx.game || !ctx.mySide || !ctx.game.items) return null;
    return ctx.game.items[ctx.mySide] || null;
  }

  /**
   * 畫出道具列。發射型道具是四選一的 radiogroup，補血是獨立按鈕
   * （按下去直接生效並換手，所以不放進同一組選項裡）。
   */
  function renderItemBar(ctx) {
    var bar = $('itembar');
    var box = $('item-choices');
    var healBtn = $('b-heal');
    var lockNote = $('item-lock-note');
    var bag = myBag(ctx);

    /* 觀戰者與還沒開局時整條收起來，不佔走戰場空間 */
    if (!bag) {
      bar.hidden = true;
      box.innerHTML = '';
      return;
    }
    bar.hidden = false;

    var can = !!ctx.canFire;
    var locked = !!app.item;
    bar.setAttribute('data-locked', locked ? 'true' : 'false');
    lockNote.textContent = locked
      ? '已選定：' + Rules.ITEMS[app.item].label + '（本回合不能更換）'
      : '選定後鎖定';
    /* 窄版與橫向只留得下圖示，文字用 .txt 包起來由 CSS 收掉；
     * aria-label 一律寫完整名稱，螢幕閱讀器不會只聽到一個表情符號。 */
    var html = '<button class="itemchip" type="button" role="radio" data-item=""' +
      ' aria-label="不用道具" aria-checked="' + (app.item ? 'false' : 'true') + '"' +
      (can && !locked ? '' : ' disabled') +
      '><span class="ico">🎯</span><span class="txt">不用道具</span></button>';

    Rules.ITEM_ORDER.forEach(function (key) {
      var it = Rules.ITEMS[key];
      if (it.kind !== 'shot') return;
      var n = bag[key] || 0;
      var out = n <= 0;
      html += '<button class="itemchip' + (out ? ' used' : '') + (locked ? ' locked' : '') + '" type="button" role="radio"' +
        ' data-item="' + key + '" aria-checked="' + (app.item === key ? 'true' : 'false') + '"' +
        ' aria-label="' + esc(it.label) + '，剩 ' + n + ' 個。' + esc(it.note) + '"' +
        ' title="' + esc(it.label + '：' + it.note) + '"' + (can && !out && !locked ? '' : ' disabled') + '>' +
        '<span class="ico">' + itemIcon(ctx.mySide, key) + '</span><span class="txt">' + esc(it.label) + '</span>' +
        '<span class="num">×' + n + '</span></button>';
    });
    box.innerHTML = html;

    var healN = bag.heal || 0;
    var heal = Rules.ITEMS.heal;
    healBtn.disabled = !can || healN <= 0;
    UI.setLabel(healBtn, '<span class="ico">' + heal.icon + '</span>' +
      '<span class="txt">補血</span><span class="num">×' + healN + '</span>');
    healBtn.setAttribute('aria-label', '使用補血，剩 ' + healN + ' 個。' + heal.note);
    healBtn.title = heal.label + '：' + heal.note;
  }

  /** 選一個道具；選定後鎖定到本回合結束，不能改成另一個道具。 */
  function selectItem(key) {
    var next = key || null;
    if (!next) return;
    if (app.item) {
      hint('本回合已選定' + Rules.ITEMS[app.item].label + '，不能更換道具。', 'error');
      Sound.play('blocked');
      return;
    }
    var previous = app.item;
    app.item = next;
    Sound.play('tick');
    var ctx = currentCtx();
    if (ctx) {
      renderItemBar(ctx);
      renderStageItems(ctx);
    }
    if (app.item) {
      var it = Rules.ITEMS[app.item];
      var iconLabel = ctx && ctx.mySide === 'cat' && app.item === 'bigbone' ? '魚骨頭' : it.icon;
      hint(iconLabel + ' ' + it.label + ' 已鎖定：' + it.note + ' 可按「↺ 重置」重設角度與力道。');
      if (ctx && ctx.mode === 'online') {
        if (!Online.send('room:selectItem', { item: app.item }, function (res) {
          if (res && res.ok) return;
          app.item = null;
          renderBattle();
          toast((res && (res.error || res.message)) || '道具選擇失敗。', 'error');
        })) {
          app.item = previous;
          renderBattle();
        }
      }
    }
  }

  /** 重置本次瞄準；已選定的道具仍然保留並維持鎖定。 */
  function resetAim() {
    var ctx = currentCtx();
    if (!ctx || !ctx.canFire || app.busy) return;
    if (app.charge.on) endCharge(false, true);
    setAim(45, 60, true);
    Sound.play('click');
    hint(app.item
      ? '已重置角度與力道；' + Rules.ITEMS[app.item].label + '仍已鎖定。'
      : '已重置角度與力道。');
  }

  /** 使用補血：不發射，回血之後直接換手 */
  function useHeal() {
    var ctx = currentCtx();
    if (!ctx || !ctx.canFire) {
      hint('現在還不能用道具，等輪到你。', 'error');
      Sound.play('blocked');
      return;
    }
    if (ctx.mode === 'solo') {
      var s = app.solo;
      var res = Rules.applyHeal(s.state, s.mySide);
      if (!res.ok) { hint(res.reason, 'error'); Sound.play('blocked'); return; }
      s.state = res.state;
      s.summary.push(summaryEntry(res.shot));
      app.item = null;
      Sound.play('heal');
      toast(Rules.describeShot(res.shot));
      renderBattle();
      afterSoloShot();
    } else {
      Online.send('room:heal', {});
    }
  }

  /* ---------------------------------------------------------- 瞄準 */

  function updateAimVisibility(ctx) {
    Board.setAim({
      side: ctx.canFire ? ctx.mySide : (ctx.game && !ctx.game.over ? ctx.game.turn : null),
      angle: app.aim.angle,
      power: app.aim.power,
      visible: !!(ctx.canFire && ctx.game && !ctx.game.over)
    });
  }

  function setAim(angle, power, fromDrag) {
    app.aim.angle = Math.round(Rules.clamp(angle, C.MIN_ANGLE, C.MAX_ANGLE));
    app.aim.power = Math.round(Rules.clamp(power, C.MIN_POWER, C.MAX_POWER));
    $('in-angle').value = app.aim.angle;
    $('in-power').value = app.aim.power;
    $('out-angle').textContent = app.aim.angle + '°';
    $('out-power').textContent = app.aim.power;
    var ctx = currentCtx();
    if (ctx) updateAimVisibility(ctx);
    if (!fromDrag) Sound.play('aim');
  }

  /* ------------------------------------------------------ 蓄力與拖曳瞄準 */

  /* 長按後從最小力道拉到最大力道要按住多久 */
  var CHARGE_ARM_MS = 180;
  var CHARGE_MS = 1200;

  function setFireButtonCharging(on) {
    var button = $('b-fire');
    UI.setLabel(button, '<span class="ico">🎯</span>' + (on ? '放開發射！' : '發射！'));
    button.setAttribute('aria-label', on ? '放開以發射目前蓄力' : '按一下發射；按住蓄力後放開');
  }

  function suppressFireClick() {
    var c = app.charge;
    c.suppressClick = true;
    clearTimeout(c.clickTimer);
    c.clickTimer = w.setTimeout(function () { c.suppressClick = false; }, 500);
  }

  function setChargeCursor(on) {
    document.body.classList.toggle('charge-active', !!on);
  }

  function runCharge() {
    var c = app.charge;
    if (!c.on) return;
    c.armed = true;
    c.t0 = Date.now();
    setAim(app.aim.angle, C.MIN_POWER, true);
    Sound.play('tick');

    var tick = function () {
      if (!c.on || !c.armed) return;
      var t = Math.min(1, (Date.now() - c.t0) / CHARGE_MS);
      setAim(app.aim.angle, C.MIN_POWER + (C.MAX_POWER - C.MIN_POWER) * t, true);
      showCharge(t);
      c.raf = w.requestAnimationFrame(tick);
    };
    c.raf = w.requestAnimationFrame(tick);
  }

  /** 開始合併手勢；戰場可邊移動瞄準邊蓄力，發射鈕則只蓄力。 */
  function startCharge(e, source, ctx) {
    if (app.charge.on) return;
    if (e.isPrimary === false) return;
    if (e.button !== undefined && e.button !== 0) return;
    var c = app.charge;
    c.on = true;
    c.armed = false;
    c.t0 = 0;
    c.pointerId = e.pointerId;
    c.source = source;
    c.basePower = app.aim.power;
    c.startAngle = app.aim.angle;
    c.startPower = app.aim.power;
    c.outside = false;
    if (e.pointerType === 'touch') Sound.vibrate(8);
    if (source === 'board' && ctx && ctx.mySide) {
      var a = Board.pointToAim(e.clientX, e.clientY, ctx.mySide);
      c.basePower = a.power;
      c.startAngle = a.angle;
      c.startPower = a.power;
      setAim(a.angle, a.power, true);
    } else if (source === 'button') {
      suppressFireClick();
    }
    $('chargebar').setAttribute('data-on', '1');
    if (source === 'button') setFireButtonCharging(true);
    setChargeCursor(true);
    showCharge(0);
    hint(source === 'board'
      ? '瞄準中…移動調整角度；繼續按住蓄力，放開就發射。'
      : '按住發射鈕蓄力…放開發射；也可以在戰場手勢中同時瞄準。');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    c.armTimer = w.setTimeout(function () {
      if (c.on) runCharge();
    }, CHARGE_ARM_MS);
  }

  /** 蓄力中的即時讀數：力道條與力道數字；方向只用箭頭呈現 */
  function showCharge(t) {
    var c = app.charge;
    $('chargefill').style.width = Math.round(t * 100) + '%';
    hint((c.armed ? '蓄力' : '瞄準') + ' 力道 ' + app.aim.power);
    Board.setCharge({ on: true, angle: app.aim.angle, power: app.aim.power });
  }

  /** 結束手勢；戰場短按只保留瞄準，發射鈕短按則發射目前力道。 */
  function endCharge(shoot, cancelled) {
    var c = app.charge;
    if (!c.on) return;
    var armed = c.armed;
    var source = c.source;
    var basePower = c.basePower;
    var startAngle = c.startAngle;
    var startPower = c.startPower;
    c.on = false;
    c.armed = false;
    c.source = null;
    clearTimeout(c.armTimer);
    c.armTimer = 0;
    if (c.raf) w.cancelAnimationFrame(c.raf);
    c.raf = 0;
    c.pointerId = null;
    $('chargebar').removeAttribute('data-on');
    $('chargefill').style.width = '0%';
    Board.setCharge({ on: false });
    setChargeCursor(false);
    if (source === 'button') setFireButtonCharging(false);
    if (cancelled) {
      setAim(startAngle, startPower, true);
      hint('已取消瞄準／蓄力。');
      return;
    }
    if (source === 'button' && !armed) setAim(app.aim.angle, basePower, true);
    if (source === 'board' && !armed) {
      Sound.play('tick');
      hint('已更新發射方向，力道 ' + app.aim.power + '。繼續按住並放開即可發射。');
    } else if (shoot) {
      fire();
    }
  }

  /* ============================================================ 單機對局 */

  function startSolo(opts) {
    var o = opts || {};
    var s = app.solo;
    s.mySide = o.side || Store.mySide() || 'cat';
    s.aiSide = Rules.other(s.mySide);
    s.level = o.level || Store.aiLevel() || 'normal';
    s.seed = RNG.normalizeSeed(o.seed || '');
    s.summary = [];
    s.thinking = false;
    clearTimeout(s.aiTimer);
    s.state = Rules.createState({ seed: s.seed || undefined });
    s.turnDeadline = Date.now() + TURN_MS;
    app.mode = 'solo';
    app.busy = false;
    app.item = null;
    Board.clearTrail();
    setAim(45, 60, true);
    show('s-battle');
    renderBattle();
    Sound.play('start');
    toast('開打！地圖種子 ' + s.state.seed + '，先手是' + Rules.SIDE_LABEL[s.state.turn] + '。');
    maybeSoloAi();
  }

  function soloFire() {
    var s = app.solo;
    var check = Rules.legalShot(s.state, s.mySide, app.aim.angle, app.aim.power, app.item);
    if (!check.ok) {
      hint(check.reason, 'error');
      Sound.play('blocked');
      Sound.vibrate(30);
      return;
    }
    var res = Rules.applyShot(s.state, s.mySide, {
      angle: app.aim.angle, power: app.aim.power, item: app.item
    });
    if (!res.ok) { hint(res.reason, 'error'); Sound.play('blocked'); return; }
    app.item = null;                     // 道具用掉了，下一回合重新選
    playShotThen(res, function () {
      s.state = res.state;
      s.turnDeadline = s.state.over ? 0 : Date.now() + TURN_MS;
      s.summary.push(summaryEntry(res.shot));
      renderBattle();
      afterSoloShot();
    });
  }

  function maybeSoloAi() {
    var s = app.solo;
    if (!s.state || s.state.over) return;
    if (s.state.turn !== s.aiSide) return;
    s.thinking = true;
    renderBattle();
    var level = AI.levelOf(s.level);
    clearTimeout(s.aiTimer);
    s.aiTimer = setTimeout(function () {
      if (!s.state || s.state.over || s.state.turn !== s.aiSide) { s.thinking = false; renderBattle(); return; }
      var action = AI.chooseAction(s.state, s.aiSide, s.level, Math.random);
      var res = action.type === 'heal'
        ? Rules.applyHeal(s.state, s.aiSide)
        : Rules.applyShot(s.state, s.aiSide, action);
      s.thinking = false;
      if (!res.ok) { renderBattle(); return; }

      /* 補血沒有砲彈可以播，直接套用狀態並換手 */
      if (action.type === 'heal') {
        s.state = res.state;
        s.turnDeadline = s.state.over ? 0 : Date.now() + TURN_MS;
        s.summary.push(summaryEntry(res.shot, s.level));
        Sound.play('heal');
        toast(Rules.describeShot(res.shot));
        renderBattle();
        afterSoloShot();
        return;
      }
      playShotThen(res, function () {
        s.state = res.state;
        s.turnDeadline = s.state.over ? 0 : Date.now() + TURN_MS;
        s.summary.push(summaryEntry(res.shot, s.level));
        renderBattle();
        afterSoloShot();
      });
    }, level.thinkMs);
  }

  /** 單機也採用同一個 15 秒出手時限，逾時就交給電腦。 */
  function soloTimeout() {
    var s = app.solo;
    if (!s.state || s.state.over || app.busy || s.thinking || s.state.turn !== s.mySide) return;
    if (!s.turnDeadline || Date.now() < s.turnDeadline) return;

    var res = Rules.applyPass(s.state, s.mySide, '15 秒出手時間已到，這一回合跳過。');
    if (!res.ok) return;
    s.state = res.state;
    s.turnDeadline = Date.now() + TURN_MS;
    app.item = null;
    s.summary.push(summaryEntry(res.shot));
    Sound.play('warn');
    toast('15 秒出手時間到，這一回合自動跳過。', 'info');
    renderBattle();
    afterSoloShot();
  }

  function afterSoloShot() {
    var s = app.solo;
    if (s.state.over) {
      s.turnDeadline = 0;
      var outcome = s.state.winner === 'draw' ? 'draw' : (s.state.winner === s.mySide ? 'win' : 'lose');
      Store.recordResult('solo', outcome);
      Sound.play(outcome === 'win' ? 'win' : (outcome === 'lose' ? 'lose' : 'turn'));
      Sound.vibrate(outcome === 'win' ? [40, 60, 40] : 60);
      renderBattle();
      return;
    }
    Sound.play('turn');
    maybeSoloAi();
  }

  function soloSurrender() {
    var s = app.solo;
    if (!s.state || s.state.over) return;
    if (app.busy) {
      hint('砲彈飛行中，等這一發結束後才能投降。', 'error');
      return;
    }
    clearTimeout(s.aiTimer);
    s.aiTimer = null;
    s.thinking = false;
    var res = Rules.applySurrender(s.state, s.mySide);
    if (!res.ok) { hint(res.reason, 'error'); return; }
    s.state = res.state;
    s.turnDeadline = 0;
    s.summary.push(summaryEntry(res.shot));
    app.item = null;
    Store.recordResult('solo', 'lose');
    Sound.play('lose');
    Sound.vibrate(60);
    renderBattle();
  }

  function summaryEntry(shot, aiLevel) {
    return {
      n: shot.n, side: shot.side, angle: shot.angle, power: shot.power, wind: shot.wind,
      item: shot.item || null,
      result: shot.result, damage: shot.damage, hpAfter: shot.hpAfter, distance: shot.distance,
      hitParts: shot.hitParts || { cat: null, dog: null }, hitPart: shot.hitPart || null,
      critical: !!shot.critical,
      aiLevel: aiLevel || null, text: Rules.describeShot(shot)
    };
  }

  /** 播放飛行動畫 → 爆炸音效 → 套用新狀態 */
  function playShotThen(res, done) {
    app.busy = true;
    renderControls(currentCtx() || {});
    Sound.play('fire');
    Sound.play('whoosh', 0.12);
    Board.playShot(res.shot, function (shot) {
      impactFeedback(shot);
      app.busy = false;
      done();
    });
  }

  function impactFeedback(shot) {
    var foe = Rules.other(shot.side);
    if (shot.result === 'direct') { Sound.play('hit'); Sound.vibrate([25, 40, 25]); }
    else if (shot.result === 'splash' || shot.result === 'both') { Sound.play('splash'); Sound.vibrate(25); }
    else if (shot.result === 'self') { Sound.play('self'); Sound.vibrate(35); }
    else if (shot.result === 'out') Sound.play('out');
    else if (shot.result === 'pass') Sound.play('warn');
    else Sound.play('miss');

    var text = Rules.RESULT_TEXT[shot.result] || '';
    var dmg = shot.damage ? shot.damage[foe] : 0;
    var hitPart = shot.hitPart || (shot.hitParts && shot.hitParts[foe]);
    if (shot.critical) text = '💥 爆擊！' + (hitPart ? ' ' + (Rules.HIT_PART_LABEL[hitPart] || '部位') + '命中' : '') + '　' + text;
    else if (hitPart) text = (Rules.HIT_PART_LABEL[hitPart] || '部位') + '命中　' + text;
    if (dmg > 0) text += '　' + Rules.SIDE_LABEL[foe] + ' -' + dmg;
    else if (shot.distance !== null && shot.distance !== undefined) text += '　距離對手約 ' + Math.round(shot.distance);
    toast(Rules.SIDE_LABEL[shot.side] + '：' + text, dmg > 0 ? 'ok' : 'info');

    if (shot.result === 'direct') Sound.play(foe === 'cat' ? 'meow' : 'woof', 0.35);
  }

  /* ============================================================ 線上模式 */

  function identity() {
    return { clientId: Store.clientId(), name: Store.nick() || '玩家' };
  }

  function ensureOnline() {
    return Online.connect(identity());
  }

  function enterLobby() {
    show('s-lobby');
    $('lobby-nick').value = Store.nick();
    $('lobby-state').textContent = '正在連線…';
    $('lobby-off').hidden = true;
    $('lobby-live').hidden = false;
    ensureOnline().then(function () {
      Online.send('lobby:subscribe');
      $('lobby-state').textContent = '已連線，正在讀取房間列表…';
    }).catch(function (err) {
      $('lobby-live').hidden = true;
      $('lobby-off').hidden = false;
      $('lobby-off-note').textContent = err.message || '連不到遊戲伺服器。';
    });
  }

  function renderRoomList(payload) {
    var rooms = (payload && payload.rooms) || [];
    var host = $('roomlist');
    if (!rooms.length) {
      host.innerHTML = '';
      $('lobby-state').textContent = '目前沒有公開的房間。按「開一間房」自己開一間，再把邀請連結傳給朋友。';
      return;
    }
    $('lobby-state').textContent = '共 ' + rooms.length + ' 間公開房間。';
    host.innerHTML = rooms.map(function (r) {
      var phaseText = r.phase === 'waiting' ? '等待中' : (r.phase === 'playing' ? '對戰中' : '已結束');
      var seatText = ['cat', 'dog'].map(function (s) {
        var seat = r.seats[s];
        return Rules.SIDE_LABEL[s] + '：' + (seat.kind === 'open' ? '空位' : seat.name);
      }).join('　');
      var canJoin = r.phase !== 'playing' && r.players < 2;
      return '<div class="roomcard">' +
        '<span class="rc-code">' + esc(r.code) + '</span>' +
        '<span class="rc-main">' +
        '<b class="rc-name">' + esc(r.name) + '</b>' +
        '<span class="rc-sub"><span class="rc-badge" data-p="' + r.phase + '">' + phaseText + '</span>' +
        esc(seatText) + '　觀戰 ' + r.spectators + ' 人' + (r.turnNo ? '　第 ' + r.turnNo + ' 回合' : '') + '</span>' +
        '</span>' +
        '<span class="rc-btns">' +
        (canJoin ? '<button class="btn3d small" data-color="grape" data-lobby="join" data-code="' + esc(r.code) + '">加入對戰</button>' : '') +
        '<button class="btn3d small" data-color="sky" data-lobby="watch" data-code="' + esc(r.code) + '">👀 觀戰</button>' +
        '</span></div>';
    }).join('');
    UI.decorateAll(host);
  }

  function joinRoom(code, role, token) {
    Store.nick($('lobby-nick').value || Store.nick());
    ensureOnline().then(function () {
      Online.send('room:join', { code: code, role: role, name: Store.nick(), token: token || null }, function (res) {
        if (!res || !res.ok) {
          toast((res && res.error) || '加入失敗。', 'error');
          return;
        }
        resetOnlinePlayback();
        app.mode = 'online';
        app.online.code = res.code;
        app.online.resultMarker = null;
        if (res.downgraded) toast('兩邊都有人了，你以觀戰身分進入房間。');
        else if (res.reconnected) toast('已回到原本的座位。');
        Sound.play('join');
        show('s-battle');
      });
    }).catch(function (err) { toast(err.message || '連不到伺服器。', 'error'); });
  }

  function createRoom() {
    Store.nick($('lobby-nick').value || Store.nick());
    ensureOnline().then(function () {
      Online.send('room:create', { name: Store.nick(), roomName: (Store.nick() || '玩家') + ' 的擂台' }, function (res) {
        if (!res || !res.ok) { toast((res && res.error) || '開房失敗。', 'error'); return; }
        resetOnlinePlayback();
        app.mode = 'online';
        app.online.code = res.code;
        app.online.resultMarker = null;
        Sound.play('join');
        show('s-battle');
        toast('房間開好了，房號 ' + res.code + '。按「產生」拿到邀請連結傳給朋友。');
      });
    }).catch(function (err) { toast(err.message || '連不到伺服器。', 'error'); });
  }

  function leaveRoom() {
    if (app.mode !== 'online') return;
    var view = app.online.view;
    var surrendering = !!(view && view.room && view.room.phase === 'playing' && view.game &&
      !view.game.over && view.you && view.you.side);
    Online.send('room:leave');
    resetOnlinePlayback();
    if (surrendering) {
      Store.recordResult('online', 'lose');
      toast('你已離開房間，這場對局視為投降。', 'info');
    }
    app.online.view = null;
    app.online.code = null;
    app.mode = null;
    Sound.play('leave');
    enterLobby();
  }

  function recordOnlineOutcome(view) {
    if (!view || !view.game || !view.game.over || !view.you || !view.you.side) return;
    var marker = view.room.code + ':' + view.game.version;
    if (app.online.resultMarker === marker) return;
    app.online.resultMarker = marker;
    var outcome = view.game.winner === 'draw' ? 'draw' :
      (view.game.winner === view.you.side ? 'win' : 'lose');
    Store.recordResult('online', outcome);
    Sound.play(outcome === 'win' ? 'win' : (outcome === 'lose' ? 'lose' : 'turn'));
  }

  /* ---- 伺服器事件 ---- */

  Online.on('status', function (s) {
    app.online.netStatus = s.status;
    app.online.netMessage = s.message;
    if (app.screen === 's-battle' && app.mode === 'online') renderBattle();
    if (s.status === 'error' && app.screen === 's-lobby') {
      $('lobby-state').textContent = s.message || '連線失敗。';
    }
  });

  Online.on('lobby:rooms', function (payload) {
    if (app.screen === 's-lobby') renderRoomList(payload);
  });

  Online.on('room:sync', function (view) {
    app.online.view = view;
    app.online.code = view.room.code;
    app.item = view.you && view.you.selectedItem ? view.you.selectedItem : null;
    if (app.mode !== 'online') app.mode = 'online';
    if (app.screen !== 's-battle') show('s-battle');
    announceTurn(view);
    recordOnlineOutcome(view);
    renderBattle();
  });

  function drainOnlineShots() {
    if (app.mode !== 'online' || app.busy || app.online.shotPauseTimer || !app.online.shotQueue.length) return;
    var payload = app.online.shotQueue.shift();
    var shot = payload.shot;
    var prevView = app.online.view;
    /* 先用「出手前」的狀態播動畫，播完再套用伺服器算好的新狀態 */
    if (prevView && prevView.game) Board.setState(prevView.game);
    app.busy = true;
    renderControls(currentCtx() || {});
    if (shot.result !== 'pass') { Sound.play('fire'); Sound.play('whoosh', 0.12); }
    Board.playShot(shot, function (s) {
      impactFeedback(s);
      app.busy = false;
      app.online.view = payload.view;
      app.item = null;
      if (payload.view.game && payload.view.game.over) recordOnlineOutcome(payload.view);
      else Sound.play('turn');
      if (app.online.shotQueue.length) {
        app.online.shotPauseTimer = setTimeout(function () {
          app.online.shotPauseTimer = null;
          drainOnlineShots();
        }, ONLINE_TURN_PAUSE_MS);
      }
      renderBattle();
    });
  }

  Online.on('room:shot', function (payload) {
    if (app.mode !== 'online' || !payload || !payload.shot) return;
    app.online.waitingForShot = false;
    app.online.shotQueue.push(payload);
    drainOnlineShots();
  });

  Online.on('room:chat', function (payload) {
    var v = app.online.view;
    if (!v) return;
    v.room.chat = (v.room.chat || []).concat([payload.message]);
    if (v.room.chat.length > 80) v.room.chat = v.room.chat.slice(-80);
    renderChatList(v.room.chat, v.you ? v.you.id : null);
    if (!app.chatOpen && payload.message.kind === 'chat') {
      app.unread += 1;
      updateUnread();
      Sound.playChat();
    }
  });

  Online.on('room:error', function (payload) {
    if (app.online.waitingForShot) {
      app.online.waitingForShot = false;
      if (app.screen === 's-battle' && app.mode === 'online') renderBattle();
    }
    toast(payload.message || '操作失敗。', 'error');
    Sound.play('blocked');
    Sound.vibrate(30);
    if (payload.code === 'ratelimit' || payload.code === 'muted') {
      $('chat-state').textContent = payload.message;
      $('chat-state').setAttribute('data-kind', 'error');
    }
  });

  Online.on('room:closed', function (payload) {
    toast(payload.reason || '房間已經關閉。', 'error');
    resetOnlinePlayback();
    app.online.view = null;
    app.online.code = null;
    app.mode = null;
    enterLobby();
  });

  Online.on('reconnected', function () {
    if (app.online.code) {
      Online.send('room:join', { code: app.online.code, name: Store.nick() });
    }
  });

  function announceTurn(view) {
    if (!view.game || view.game.over || view.room.phase !== 'playing') return;
    var key = view.room.code + ':' + view.game.turnNo;
    if (app.lastTurnAnnounced === key) return;
    app.lastTurnAnnounced = key;
    var you = view.you || {};
    if (you.side && view.game.turn === you.side) {
      Sound.play('turn');
      Sound.vibrate(15);
    }
  }

  /* ---- 邀請連結 ---- */

  function handleEntryLink() {
    var e = Config.entry();
    if (!e.room) return false;
    if (!Config.isOnlineEnabled()) {
      toast('這是一個線上房間的邀請連結，但目前連不到伺服器。', 'error');
      return false;
    }
    show('s-lobby');
    $('lobby-state').textContent = '正在確認邀請連結…';
    ensureOnline().then(function () {
      Online.send('invite:check', { code: e.room, token: e.invite }, function (res) {
        if (!res || !res.ok) {
          toast((res && res.error) || '邀請連結無效。', 'error');
          $('lobby-state').textContent = (res && res.error) || '邀請連結無效，可以改用房號加入。';
          Online.send('lobby:subscribe');
          return;
        }
        if (res.note) toast(res.note);
        joinRoom(e.room, res.role === 'spectator' ? 'spectator' : 'player', e.invite);
      });
    }).catch(function (err) {
      toast(err.message || '連不到伺服器。', 'error');
      $('lobby-live').hidden = true;
      $('lobby-off').hidden = false;
      $('lobby-off-note').textContent = err.message || '連不到遊戲伺服器。';
    });
    return true;
  }

  function copyText(text, okMessage) {
    if (!text) { toast('目前沒有可複製的內容。', 'error'); return; }
    var done = function () { toast(okMessage || '已複製。', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { toast('這個瀏覽器不支援自動複製，請手動選取連結。', 'error'); }
    document.body.removeChild(ta);
  }

  /* ============================================================ 設定彈窗 */

  var settingsOpener = null;
  var battleSettingsOpener = null;

  function openSettings() {
    if (isBattleSettingsOpen()) closeBattleSettings();
    settingsOpener = document.activeElement;
    var modal = $('settings-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    $('b-settings').setAttribute('aria-expanded', 'true');
    syncSettingsUi();
    setTimeout(function () { $('settings-panel').focus(); }, 20);
    document.addEventListener('keydown', trapFocus, true);
  }

  function closeSettings() {
    var modal = $('settings-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    $('b-settings').setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', trapFocus, true);
    /* 焦點回到打開設定的那顆按鈕；若當初沒有可聚焦的來源（例如程式化開啟），
     * 就退回右上角的設定鈕，不要讓焦點掉到 body 上。 */
    var back = (settingsOpener && settingsOpener.focus && settingsOpener !== document.body)
      ? settingsOpener : $('b-settings');
    if (back && back.focus) back.focus();
    settingsOpener = null;
  }

  function isSettingsOpen() { return $('settings-modal').classList.contains('open'); }

  function openBattleSettings() {
    var ctx = currentCtx();
    if (app.screen !== 's-battle' || !ctx || !ctx.game) return;
    battleSettingsOpener = document.activeElement;
    var modal = $('battle-settings-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    $('b-battle-settings').setAttribute('aria-expanded', 'true');
    syncBattleSettingsUi(ctx);
    setTimeout(function () { $('battle-settings-panel').focus(); }, 20);
    document.addEventListener('keydown', trapFocus, true);
  }

  function closeBattleSettings() {
    var modal = $('battle-settings-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    $('b-battle-settings').setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', trapFocus, true);
    var back = (battleSettingsOpener && battleSettingsOpener.focus && battleSettingsOpener !== document.body)
      ? battleSettingsOpener : $('b-battle-settings');
    if (!back || back.hidden) back = $('b-settings');
    if (back && back.focus) back.focus();
    battleSettingsOpener = null;
  }

  function isBattleSettingsOpen() { return $('battle-settings-modal').classList.contains('open'); }

  function trapFocus(e) {
    var panel = null;
    if (isSettingsOpen()) {
      panel = $('settings-panel');
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); return; }
    } else if (isBattleSettingsOpen()) {
      panel = $('battle-settings-panel');
      if (e.key === 'Escape') { e.preventDefault(); closeBattleSettings(); return; }
    } else return;
    if (e.key !== 'Tab') return;
    var focusables = panel.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < focusables.length; i++) {
      if (!focusables[i].disabled && focusables[i].offsetParent !== null) list.push(focusables[i]);
    }
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function syncSettingsUi() {
    $('settings-music').checked = Sound.isMusicOn();
    $('settings-music-status').textContent = Sound.isMusicOn() ? '開啟' : '關閉';
    $('settings-sfx').checked = Sound.isSfxOn();
    $('settings-sfx-status').textContent = Sound.isSfxOn() ? '開啟' : '關閉';
    $('settings-music-volume').value = Math.round(Sound.getMusicVolume() * 100);
    $('settings-music-volume-value').textContent = Math.round(Sound.getMusicVolume() * 100) + '%';
    $('settings-sfx-volume').value = Math.round(Sound.getSfxVolume() * 100);
    $('settings-sfx-volume-value').textContent = Math.round(Sound.getSfxVolume() * 100) + '%';
    $('settings-chatcue').checked = Sound.isChatCueOn();
    $('settings-haptic').checked = Sound.isHapticOn();
    $('settings-motion').checked = Store.reduceMotion();
    $('settings-trail').checked = Store.showTrail();
    $('settings-nick').value = Store.nick();
    $('settings-server-url').textContent = Config.describe();
  }

  function applyMotion() {
    var reduced = Store.reduceMotion();
    document.body.classList.toggle('reduced-motion', reduced);
    Board.setMotion(reduced, Store.showTrail());
  }

  /* ============================================================ 事件綁定 */

  function bind() {
    /* 音訊解鎖：第一次手勢 */
    var unlockOnce = function () {
      Sound.unlock();
      Sound.startBgm();
      document.removeEventListener('pointerdown', unlockOnce);
      document.removeEventListener('keydown', unlockOnce);
    };
    document.addEventListener('pointerdown', unlockOnce);
    document.addEventListener('keydown', unlockOnce);

    /* 返回鍵 */
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () { Sound.play('click'); show(b.getAttribute('data-back')); });
    });

    /* 主選單 */
    $('b-solo').addEventListener('click', function () { Sound.play('click'); show('s-solo'); });
    $('b-online').addEventListener('click', function () { Sound.play('click'); enterLobby(); });
    $('b-help').addEventListener('click', function () { Sound.play('click'); tutIndex = 0; renderTutorial(); show('s-help'); });
    $('b-stats').addEventListener('click', function () { Sound.play('click'); renderStats(); show('s-stats'); });

    /* 教學 */
    $('b-tut-prev').addEventListener('click', function () {
      if (tutIndex > 0) { tutIndex--; renderTutorial(); $('tut-box').focus(); Sound.play('click'); }
    });
    $('b-tut-next').addEventListener('click', function () {
      if (tutIndex < TUTORIAL.length - 1) { tutIndex++; renderTutorial(); $('tut-box').focus(); Sound.play('click'); }
      else { Store.tutorialDone(true); show('s-home'); Sound.play('click'); }
    });
    $('b-tut-skip').addEventListener('click', function () { Store.tutorialDone(true); Sound.play('click'); show('s-home'); });
    $('b-tut-practice').addEventListener('click', function () {
      Store.tutorialDone(true);
      Store.aiLevel('easy');
      startSolo({ side: Store.mySide(), level: 'easy' });
    });

    /* 單機設定 */
    $('opt-side').addEventListener('click', function (e) {
      var card = e.target.closest('.sidecard');
      if (!card) return;
      Store.mySide(card.getAttribute('data-v'));
      syncSoloSetup();
      Sound.play('click');
    });
    $('opt-diff').addEventListener('click', function (e) {
      var card = e.target.closest('.optcard');
      if (!card) return;
      Store.aiLevel(card.getAttribute('data-v'));
      syncSoloSetup();
      Sound.play('click');
    });
    $('b-seed-random').addEventListener('click', function () {
      $('seed-input').value = RNG.randomSeed(null, 6);
      Sound.play('click');
    });
    $('b-solo-start').addEventListener('click', function () {
      startSolo({ side: Store.mySide(), level: Store.aiLevel(), seed: $('seed-input').value });
    });

    /* 大廳 */
    $('b-lobby-host').addEventListener('click', function () { Sound.play('click'); createRoom(); });
    $('b-lobby-join').addEventListener('click', function () {
      var code = ($('lobby-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) { toast('房號要 4 個英數字。', 'error'); return; }
      joinRoom(code, 'player');
    });
    $('b-lobby-refresh').addEventListener('click', function () {
      Sound.play('click');
      if (Online.isConnected()) Online.send('lobby:subscribe');
      else enterLobby();
    });
    $('b-lobby-retry').addEventListener('click', function () { Sound.play('click'); enterLobby(); });
    $('roomlist').addEventListener('click', function (e) {
      var b = e.target.closest('[data-lobby]');
      if (!b) return;
      Sound.play('click');
      joinRoom(b.getAttribute('data-code'), b.getAttribute('data-lobby') === 'watch' ? 'spectator' : 'player');
    });
    $('lobby-nick').addEventListener('change', function () { Store.nick($('lobby-nick').value); });

    /* 戰場：返回 */
    $('b-battle-back').addEventListener('click', function () {
      Sound.play('click');
      if (app.mode === 'online') leaveRoom();
      else { clearTimeout(app.solo.aiTimer); app.mode = null; show('s-home'); }
    });

    /* 摘要面板開關（窄版） */
    $('b-aside-toggle').addEventListener('click', function () {
      var open = !$('battle-aside').classList.contains('open');
      $('battle-aside').classList.toggle('open', open);
      $('battle').classList.toggle('aside-open', open);
      if (open) {
        if (app.chatOpen) setChatOpen(false);
        $('b-aside-close').focus();
      }
      $('b-aside-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
      Sound.play('click');
    });
    $('b-aside-close').addEventListener('click', function () {
      $('battle-aside').classList.remove('open');
      $('battle').classList.remove('aside-open');
      $('b-aside-toggle').setAttribute('aria-expanded', 'false');
      $('b-aside-toggle').focus();
      Sound.play('click');
    });
    /* 控制列 */
    var stepAngle = function (d) { setAim(app.aim.angle + d, app.aim.power); };
    var stepPower = function (d) { setAim(app.aim.angle, app.aim.power + d); };
    $('b-angle-up').addEventListener('click', function () { stepAngle(1); });
    $('b-angle-dn').addEventListener('click', function () { stepAngle(-1); });
    $('b-power-up').addEventListener('click', function () { stepPower(1); });
    $('b-power-dn').addEventListener('click', function () { stepPower(-1); });
    $('in-angle').addEventListener('input', function () { setAim(Number(this.value), app.aim.power, true); });
    $('in-power').addEventListener('input', function () { setAim(app.aim.angle, Number(this.value), true); });
    $('in-angle').addEventListener('change', function () { Sound.play('tick'); });
    $('in-power').addEventListener('change', function () { Sound.play('tick'); });
    $('b-fire').addEventListener('click', function () {
      if (app.charge.suppressClick) {
        app.charge.suppressClick = false;
        return;
      }
      fire();
    });
    $('b-heal').addEventListener('click', function () { Sound.play('click'); useHeal(); });
    $('item-choices').addEventListener('click', function (e) {
      var b = e.target.closest('[data-item]');
      if (!b || b.disabled) return;
      selectItem(b.getAttribute('data-item'));
    });
    $('stage-items').addEventListener('click', function (e) {
      var reset = e.target.closest('[data-stage-reset]');
      if (reset) {
        if (!reset.disabled) resetAim();
        return;
      }
      var b = e.target.closest('[data-stage-item]');
      if (!b || b.disabled) return;
      var ctx = currentCtx();
      if (!ctx || ctx.mySide !== b.getAttribute('data-stage-side') || !ctx.canFire) return;
      var item = b.getAttribute('data-stage-item');
      if (item === 'heal') {
        Sound.play('click');
        useHeal();
      } else {
        selectItem(item);
      }
    });

    /* 戰場按住即可同時瞄準與蓄力；快速點一下只更新瞄準，避免誤射 */
    var canvas = $('board');
    canvas.addEventListener('pointerdown', function (e) {
      var ctx = currentCtx();
      if (!ctx || !ctx.canFire || app.busy || app.charge.on) return;
      startCharge(e, 'board', ctx);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      var c = app.charge;
      if (!c.on || c.source !== 'board' || c.pointerId !== e.pointerId) return;
      var r = canvas.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) {
        c.outside = true;
        hint('已移出戰場，再放開會取消這次瞄準。');
        e.preventDefault();
        return;
      }
      if (c.outside) {
        hint('這次瞄準已取消，請重新按住戰場開始。');
        e.preventDefault();
        return;
      }
      var ctx = currentCtx();
      if (!ctx || !ctx.mySide) return;
      var a = Board.pointToAim(e.clientX, e.clientY, ctx.mySide);
      setAim(a.angle, c.armed ? app.aim.power : a.power, true);
      showCharge(c.armed ? Math.min(1, (Date.now() - c.t0) / CHARGE_MS) : 0);
      e.preventDefault();
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!app.charge.on || app.charge.source !== 'board' || app.charge.pointerId !== e.pointerId) return;
      var r = canvas.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      endCharge(inside && !app.charge.outside, !inside || app.charge.outside);
      /* 先結束狀態再釋放 capture，避免 lostpointercapture 把正常操作誤判成取消。 */
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    /* 手勢被系統打斷（來電、切分頁）時取消，不要莫名其妙射出去 */
    canvas.addEventListener('pointercancel', function (e) {
      if (!app.charge.on || app.charge.source !== 'board' || app.charge.pointerId !== e.pointerId) return;
      endCharge(false, true);
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    canvas.addEventListener('lostpointercapture', function () {
      /* endCharge 會先把 on 清掉再釋放 capture，這裡只處理瀏覽器主動收回的情況。 */
      if (app.charge.on && app.charge.source === 'board') endCharge(false, true);
    });

    var fireButton = $('b-fire');
    fireButton.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      var ctx = currentCtx();
      if (!ctx || !ctx.canFire || app.busy || app.charge.on) return;
      startCharge(e, 'button', ctx);
      e.preventDefault();
    });
    fireButton.addEventListener('pointerup', function (e) {
      if (!app.charge.on || app.charge.source !== 'button' || app.charge.pointerId !== e.pointerId) return;
      endCharge(true, false);
      /* 先結束狀態再釋放 capture，避免 lostpointercapture 把正常發射誤判成取消。 */
      try { fireButton.releasePointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    fireButton.addEventListener('pointercancel', function (e) {
      if (!app.charge.on || app.charge.source !== 'button' || app.charge.pointerId !== e.pointerId) return;
      endCharge(false, true);
      try { fireButton.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    fireButton.addEventListener('lostpointercapture', function () {
      if (app.charge.on && app.charge.source === 'button') endCharge(false, true);
    });

    w.addEventListener('blur', function () {
      endCharge(false, true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        endCharge(false, true);
      }
    });

    /* 疊層上的按鈕（房間、結算） */
    $('overlay-card').addEventListener('click', onOverlayClick);

    /* 聊天室 */
    $('b-chat-toggle').addEventListener('click', function () { Sound.play('click'); setChatOpen(!app.chatOpen); });
    $('b-chat-close').addEventListener('click', function () { setChatOpen(false); $('b-chat-toggle').focus(); });
    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chat-input');
      var text = input.value.trim();
      if (!text) return;
      if (!Online.isConnected()) {
        $('chat-state').textContent = '目前離線，訊息沒有送出去。';
        $('chat-state').setAttribute('data-kind', 'error');
        return;
      }
      Online.send('room:chat', { text: text });
      input.value = '';
      $('chat-state').textContent = '';
    });

    /* 設定彈窗 */
    $('b-settings').addEventListener('click', function () { Sound.play('click'); openSettings(); });
    $('settings-close').addEventListener('click', function () { Sound.play('click'); closeSettings(); });
    $('settings-done').addEventListener('click', function () { Sound.play('click'); closeSettings(); });
    document.querySelectorAll('[data-settings-close]').forEach(function (el) {
      el.addEventListener('click', closeSettings);
    });
    $('settings-music').addEventListener('change', function () {
      Sound.setMusic(this.checked); $('settings-music-status').textContent = this.checked ? '開啟' : '關閉';
    });
    $('settings-sfx').addEventListener('change', function () {
      Sound.setSfx(this.checked); $('settings-sfx-status').textContent = this.checked ? '開啟' : '關閉';
    });
    $('settings-music-volume').addEventListener('input', function () {
      Sound.setMusicVolume(this.value / 100); $('settings-music-volume-value').textContent = this.value + '%';
    });
    $('settings-sfx-volume').addEventListener('input', function () {
      Sound.setSfxVolume(this.value / 100); $('settings-sfx-volume-value').textContent = this.value + '%';
    });
    $('settings-chatcue').addEventListener('change', function () { Sound.setChatCue(this.checked); });
    $('settings-haptic').addEventListener('change', function () { Sound.setHaptic(this.checked); Sound.vibrate(20); });
    $('settings-motion').addEventListener('change', function () { Store.reduceMotion(this.checked); applyMotion(); });
    $('settings-trail').addEventListener('change', function () { Store.showTrail(this.checked); applyMotion(); });
    $('settings-nick').addEventListener('change', function () {
      Store.nick(this.value);
      $('lobby-nick').value = Store.nick();
      if (Online.isConnected() && app.online.code) {
        Online.send('room:join', { code: app.online.code, name: Store.nick() });
      }
    });
    $('b-battle-settings').addEventListener('click', function () { Sound.play('click'); openBattleSettings(); });
    $('battle-settings-close').addEventListener('click', function () { Sound.play('click'); closeBattleSettings(); });
    $('battle-settings-done').addEventListener('click', function () { Sound.play('click'); closeBattleSettings(); });
    document.querySelectorAll('[data-battle-settings-close]').forEach(function (el) {
      el.addEventListener('click', closeBattleSettings);
    });
    $('battle-settings-restart').addEventListener('click', function () {
      closeBattleSettings();
      startSolo({ side: app.solo.mySide, level: Store.aiLevel() });
    });
    $('battle-settings-surrender').addEventListener('click', function () {
      if (!w.confirm('確定要投降嗎？投降後對手會直接獲勝。')) return;
      closeBattleSettings();
      Sound.play('click');
      if (app.mode === 'online') Online.send('room:surrender');
      else soloSurrender();
    });
    $('battle-settings-quit').addEventListener('click', function () {
      closeBattleSettings();
      if (app.mode === 'online') leaveRoom();
      else { clearTimeout(app.solo.aiTimer); app.mode = null; show('s-home'); }
    });
    $('settings-reset').addEventListener('click', function () {
      Sound.resetDefaults();
      Store.resetDefaults();
      applyMotion();
      syncSettingsUi();
      toast('已恢復預設設定。', 'ok');
    });
    $('settings-server-check').addEventListener('click', function () {
      Config.checkHealth(function (state) {
        var pill = $('settings-server-pill');
        pill.setAttribute('data-state', state);
        pill.textContent = state === 'ok' ? '正常' : state === 'checking' ? '檢查中…'
          : state === 'fail' ? '連不到' : state === 'invalid' ? '設定有誤' : '未設定';
      });
    });

    /* 鍵盤操作 */
    document.addEventListener('keydown', function (e) {
      if (isSettingsOpen() || isBattleSettingsOpen()) return;
      if (app.screen !== 's-battle') return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
      if (e.key === 'Escape' && app.charge.on) {
        e.preventDefault();
        endCharge(false, true);
        return;
      }
      var ctx = currentCtx();
      if (!ctx || !ctx.canFire) return;
      var big = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepAngle(-big); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepAngle(big); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepPower(big); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepPower(-big); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(); }
    });

    /* 每秒更新倒數與摘要時間 */
    setInterval(function () {
      if (app.screen !== 's-battle') return;
      var ctx = currentCtx();
      if (!ctx) return;
      renderTurnbar(ctx);
      if (ctx.phase === 'playing' && ctx.deadline) {
        $('sum-timer').textContent = Math.max(0, Math.ceil((ctx.deadline - Date.now()) / 1000)) + ' 秒';
      }
      if (ctx.mode === 'solo') soloTimeout();
    }, 500);

    w.addEventListener('resize', function () { UI.repaintAll(); });
  }

  function fire() {
    var ctx = currentCtx();
    if (!ctx) return;
    if (!ctx.canFire) {
      hint(ctx.role === 'spectator' ? '觀戰者不能發射。' : '現在還不能發射，等輪到你。', 'error');
      Sound.play('blocked');
      return;
    }
    if (ctx.mode === 'solo') soloFire();
    else {
      app.online.waitingForShot = true;
      renderControls(currentCtx() || {});
      Online.send('room:fire', { angle: app.aim.angle, power: app.aim.power, item: app.item });
      app.item = null;               // 送出後就清掉，伺服器回同步時會重畫道具列
    }
  }

  function onOverlayClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    Sound.play('click');
    switch (act) {
      case 'solo-again': startSolo({ side: app.solo.mySide, level: app.solo.level }); break;
      case 'solo-setup': app.mode = null; show('s-solo'); break;
      case 'home': app.mode = null; clearTimeout(app.solo.aiTimer); show('s-home'); break;
      case 'pick': Online.send('room:pickSide', { side: b.getAttribute('data-side') }); break;
      case 'leaveseat': Online.send('room:leaveSeat'); break;
      case 'ready': Online.send('room:ready', { ready: b.getAttribute('data-v') === '1' }); break;
      case 'start': Online.send('room:start'); break;
      case 'rematch': Online.send('room:rematch'); break;
      case 'become-player': Online.send('room:becomePlayer'); break;
      case 'become-spectator': Online.send('room:becomeSpectator'); break;
      case 'ai-on': Online.send('room:setAi', { side: b.getAttribute('data-side'), level: Store.aiLevel() }); break;
      case 'ai-off': Online.send('room:setAi', { side: b.getAttribute('data-side'), level: 'off' }); break;
      case 'leave-room': leaveRoom(); break;
      case 'copy-code': copyText(app.online.code, '房號已複製。'); break;
      case 'invite-copy': copyText($('invite-url') ? $('invite-url').value : '', '邀請連結已複製，貼給朋友就能進來。'); break;
      case 'invite-revoke': Online.send('room:revokeInvite', { token: b.getAttribute('data-token') }); break;
      case 'invite-new':
        Online.send('room:invite', { role: 'any', ttlMinutes: 60, maxUses: 20 }, function (res) {
          if (!res || !res.ok) { toast((res && res.error) || '產生失敗。', 'error'); return; }
          toast('邀請連結已產生，1 小時內有效。', 'ok');
        });
        break;
      default: break;
    }
  }

  function syncSoloSetup() {
    var side = Store.mySide();
    document.querySelectorAll('#opt-side .sidecard').forEach(function (c) {
      c.setAttribute('aria-checked', c.getAttribute('data-v') === side ? 'true' : 'false');
    });
    var level = Store.aiLevel();
    document.querySelectorAll('#opt-diff .optcard').forEach(function (c) {
      c.setAttribute('aria-checked', c.getAttribute('data-v') === level ? 'true' : 'false');
    });
  }

  /* ============================================================ 啟動 */

  function boot() {
    UI.bgDeco($('bgdeco'));
    $('logo').innerHTML = UI.logo();
    document.querySelectorAll('#opt-side .sideface').forEach(function (el) {
      el.innerHTML = UI.avatar(el.getAttribute('data-face'), 'idle');
    });
    UI.decorateAll();
    Board.attach($('board'), $('stage'));
    applyMotion();
    syncSoloSetup();
    setAim(45, 60, true);
    $('lobby-nick').value = Store.nick();
    $('settings-server-url').textContent = Config.describe();
    bind();

    /* 第一次玩的人直接看教學，看過的人回到主選單 */
    if (!Store.tutorialDone()) {
      tutIndex = 0;
      renderTutorial();
      show('s-help');
    } else {
      show('s-home');
    }

    /* 邀請連結：?room=XXXX&invite=... 直接進房 */
    handleEntryLink();

    if (!Config.isOnlineEnabled()) {
      $('b-online').disabled = true;
      UI.setLabel($('b-online'), '<span class="ico">🌐</span>線上對戰（需要伺服器）');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 測試與除錯用的掛載點；正式遊玩不會用到 */
  w.CatDogApp = app;
}(window));
