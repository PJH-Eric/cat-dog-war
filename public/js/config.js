/* ===== config.js — 全站唯一的 server URL 設定入口 =====
 *
 * 遊戲的連線位置只能從這裡拿。app.js、online.js、測試都不可以自己寫死網址。
 *
 * 解析優先序：
 *   1. 網址參數 ?server=https://example.com   （臨時覆蓋，方便測 staging 或跨電腦連線）
 *   2. 建置時注入（scripts/inject-server-url.js 會改寫下面 INJECTED 那一行）
 *   3. 頁面本身就是伺服器發出來的（http/https 且不是 file://）→ 用同源
 *   4. 都不是 → null，代表只能玩單機
 *
 * 規則：必須是 http/https 的絕對網址；頁面走 https 時不接受 http（瀏覽器會擋混合內容）。
 * 格式不合會被擋下並記錄在 Config.error，不會靜默回退到 localhost 或任何寫死的網域。
 */
(function (w) {
  'use strict';

  /* GAME_SERVER_URL:BEGIN 這一行由 scripts/inject-server-url.js 改寫，請勿更動格式 */
  var INJECTED = '';
  /* GAME_SERVER_URL:END */

  /**
   * 純函式：給定四個輸入，決定最後要用哪個 server URL。測試直接呼叫這一支。
   * @param {string} injected      建置時注入的值
   * @param {string} queryValue    ?server= 的值
   * @param {string} pageProtocol  'https:' | 'http:' | 'file:'
   * @param {string} pageOrigin    同源回退用的 location.origin
   */
  function resolve(injected, queryValue, pageProtocol, pageOrigin) {
    var raw = String(queryValue || injected || '').trim();
    var source = queryValue ? 'query' : 'injected';

    if (!raw) {
      /* 頁面本來就是伺服器送出來的 → 直接連同一台，這是最常見的情況 */
      if ((pageProtocol === 'http:' || pageProtocol === 'https:') && pageOrigin) {
        return { url: String(pageOrigin).replace(/\/+$/, ''), source: 'same-origin', status: 'ok', error: null };
      }
      return { url: null, source: 'none', status: 'unset', error: null };
    }

    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return { url: null, source: source, status: 'invalid', error: '不是合法的絕對網址：' + raw };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: null, source: source, status: 'invalid', error: '只接受 http 或 https：' + raw };
    }
    if (pageProtocol === 'https:' && parsed.protocol === 'http:') {
      return { url: null, source: source, status: 'invalid', error: 'https 頁面不能連 http 伺服器（混合內容會被瀏覽器擋掉）：' + raw };
    }
    return {
      url: parsed.origin + parsed.pathname.replace(/\/+$/, ''),
      source: source,
      status: 'ok',
      error: null
    };
  }

  function queryParam(search, key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(search || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  var loc = (typeof w.location === 'object' && w.location) ? w.location : { search: '', protocol: '', origin: '' };
  var r = resolve(INJECTED, queryParam(loc.search, 'server'), loc.protocol, loc.origin);

  if (r.status === 'invalid' && typeof console !== 'undefined' && console.warn) {
    console.warn('[config] server URL 設定有問題，線上功能會停用：' + r.error);
  }

  var Config = {
    serverUrl: r.url,
    /* 'unset' 只能單機 ｜ 'ok' 可連線 ｜ 'invalid' 設定錯誤（已停用線上） */
    status: r.status,
    /* 'none' ｜ 'same-origin' ｜ 'injected' ｜ 'query' */
    source: r.source,
    error: r.error,

    isOnlineEnabled: function () { return r.status === 'ok'; },

    /** 組出完整網址；沒有伺服器時回 null，呼叫端就知道要跳過 */
    url: function (p) {
      if (!Config.serverUrl) return null;
      var s = String(p || '');
      if (s && s.charAt(0) !== '/') s = '/' + s;
      return Config.serverUrl + s;
    },

    /** 進場時帶的 ?room= / ?invite=，讓邀請連結可以直接開 */
    entry: function () {
      return {
        room: (queryParam(loc.search, 'room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
        invite: (queryParam(loc.search, 'invite') || '').replace(/[^a-f0-9]/gi, '').slice(0, 64)
      };
    },

    /**
     * 產生要分享出去的邀請連結。
     * 以目前頁面的網址為基底，並保留 ?server=（跨電腦測試時很重要），
     * 不在程式裡寫死任何網域。
     */
    inviteUrl: function (code, token) {
      var base = loc.origin + (loc.pathname || '/');
      var qs = ['room=' + encodeURIComponent(code), 'invite=' + encodeURIComponent(token)];
      var passthrough = queryParam(loc.search, 'server');
      if (passthrough) qs.push('server=' + encodeURIComponent(passthrough));
      return base + '?' + qs.join('&');
    },

    /** 給人看的一行說明，設定彈窗直接用 */
    describe: function () {
      if (Config.status === 'invalid') return '設定有誤（線上已停用）';
      if (!Config.serverUrl) return '未設定（只能玩單機）';
      var host = Config.serverUrl.replace(/^https?:\/\//, '');
      var tag = Config.source === 'query' ? '（網址參數）'
        : (Config.source === 'injected' ? '（建置注入）' : '（同源）');
      return host + tag;
    },

    /**
     * 打 /health 確認伺服器活著。
     * 免費雲端常在睡覺，冷啟動可能要十幾秒，所以逾時放寬到 10 秒。
     * cb(state)：'unset' ｜ 'invalid' ｜ 'checking' ｜ 'ok' ｜ 'fail'
     */
    checkHealth: function (cb) {
      if (!Config.isOnlineEnabled()) return cb(Config.status);
      if (typeof w.fetch !== 'function') return cb('fail');
      cb('checking');
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; cb('fail'); } }, 10000);
      w.fetch(Config.url('/health'), { method: 'GET', cache: 'no-store' })
        .then(function (res) { return res.ok ? 'ok' : 'fail'; })
        .catch(function () { return 'fail'; })
        .then(function (state) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cb(state);
        });
    },

    /* 測試用：不依賴瀏覽器環境也能驗證解析規則 */
    _resolve: resolve
  };

  w.GameConfig = Config;
}(typeof window !== 'undefined' ? window : this));
