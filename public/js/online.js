/* ===== online.js — Socket.IO 連線包裝 =====
 *
 * 所有連線位置都從 GameConfig 取得（?server= 或建置注入或同源），
 * 這個檔案裡沒有任何寫死的網址。
 *
 * 對 app.js 只暴露「連線 / 送出意圖 / 訂閱事件」三件事；
 * 房間規則與遊戲規則都在伺服器上判斷，這裡不做任何權限判斷，
 * 只把伺服器算好的 you.can 原封不動交給 UI。
 */
(function (w) {
  'use strict';

  var Config = w.GameConfig;
  var socket = null;
  var loading = null;
  var listeners = {};
  var status = 'idle';    // idle | loading | connecting | connected | error | offline
  var lastError = '';

  function emitLocal(evt, payload) {
    var list = listeners[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error('[online] handler error', e); }
    }
  }

  function on(evt, fn) {
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return function off() {
      var list = listeners[evt] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function setStatus(next, message) {
    status = next;
    lastError = message || '';
    emitLocal('status', { status: status, message: lastError });
  }

  /** socket.io 用戶端腳本是由伺服器提供的，所以要從 server URL 載入 */
  function loadScript() {
    if (w.io) return Promise.resolve();
    if (loading) return loading;
    var src = Config.url('/socket.io/socket.io.js');
    if (!src) return Promise.reject(new Error('沒有設定遊戲伺服器位址。'));
    setStatus('loading');
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error('連不到遊戲伺服器（' + Config.describe() + '），請確認伺服器有開著。'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  /**
   * 建立連線。可以重複呼叫，已連上就直接回傳。
   * @param {{clientId:string, name:string}} identity
   */
  function connect(identity) {
    if (!Config.isOnlineEnabled()) {
      setStatus('offline', Config.error || '目前沒有可用的遊戲伺服器，只能玩單機。');
      return Promise.reject(new Error(lastError));
    }
    if (socket && socket.connected) return Promise.resolve(socket);

    return loadScript().then(function () {
      if (socket) { socket.connect(); return waitHello(identity); }
      setStatus('connecting');
      socket = w.io(Config.serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 6000,
        timeout: 12000
      });

      socket.on('connect', function () {
        setStatus('connected');
        sayHello(identity);
        emitLocal('reconnected', {});
      });
      socket.on('disconnect', function (reason) {
        setStatus('connecting', '連線中斷（' + reason + '），正在重試…');
      });
      socket.on('connect_error', function (err) {
        setStatus('error', '連不上伺服器：' + (err && err.message ? err.message : '未知錯誤'));
      });

      ['lobby:rooms', 'room:sync', 'room:shot', 'room:chat', 'room:error', 'room:closed', 'room:left']
        .forEach(function (evt) {
          socket.on(evt, function (payload) { emitLocal(evt, payload); });
        });

      return waitHello(identity);
    }).catch(function (err) {
      setStatus('error', err.message || String(err));
      throw err;
    });
  }

  function sayHello(identity) {
    if (!socket) return;
    socket.emit('hello', { clientId: identity.clientId, name: identity.name });
  }

  function waitHello(identity) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('伺服器沒有回應（免費方案冷啟動可能要十幾秒，請再試一次）。'));
      }, 15000);
      var finish = function () {
        if (done) return;
        socket.emit('hello', { clientId: identity.clientId, name: identity.name }, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (res && res.ok) { setStatus('connected'); resolve(socket); }
          else reject(new Error('伺服器拒絕連線。'));
        });
      };
      if (socket.connected) finish();
      else socket.once('connect', finish);
    });
  }

  function send(evt, payload, ack) {
    if (!socket || !socket.connected) {
      emitLocal('room:error', { message: '目前沒有連線，動作沒有送出去。請等重新連線後再試。', code: 'offline' });
      return false;
    }
    if (ack) socket.emit(evt, payload || {}, ack);
    else socket.emit(evt, payload || {});
    return true;
  }

  function disconnect() {
    if (socket) { socket.disconnect(); }
    setStatus('idle');
  }

  w.Online = {
    on: on,
    connect: connect,
    send: send,
    disconnect: disconnect,
    isConnected: function () { return !!socket && socket.connected; },
    status: function () { return { status: status, message: lastError }; }
  };
}(window));
