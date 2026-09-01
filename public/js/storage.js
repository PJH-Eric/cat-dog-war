/* ===== storage.js — 本機偏好與戰績 =====
 * localStorage 在無痕視窗、封鎖第三方資料的瀏覽器裡可能會丟例外，
 * 所以每一次存取都包 try/catch，失敗就當作「沒有存過」繼續玩。
 */
(function (w) {
  'use strict';

  var KEY = {
    nick: 'cdw_nick',
    clientId: 'cdw_client',
    tutorialDone: 'cdw_tutorial',
    aiLevel: 'cdw_ai_level',
    mySide: 'cdw_my_side',
    stats: 'cdw_stats',
    reduceMotion: 'cdw_reduce_motion',
    showTrail: 'cdw_show_trail'
  };

  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  function getJson(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getFlag(k, d) { var v = get(k, null); return v === null ? d : v === '1'; }
  function setFlag(k, v) { set(k, v ? '1' : '0'); }

  /** 這台裝置的身分：重新整理後要靠它回到原本的座位 */
  function clientId() {
    var id = get(KEY.clientId, '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = 'c' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      set(KEY.clientId, id);
    }
    return id;
  }

  var EMPTY_STATS = { solo: { win: 0, lose: 0, draw: 0 }, online: { win: 0, lose: 0, draw: 0 } };

  function stats() {
    var s = getJson(KEY.stats, null);
    if (!s || !s.solo || !s.online) return JSON.parse(JSON.stringify(EMPTY_STATS));
    return s;
  }

  function recordResult(mode, outcome) {
    var s = stats();
    var bucket = s[mode === 'online' ? 'online' : 'solo'];
    if (outcome === 'win' || outcome === 'lose' || outcome === 'draw') bucket[outcome] += 1;
    setJson(KEY.stats, s);
    return s;
  }

  w.Store = {
    KEY: KEY,
    clientId: clientId,
    nick: function (v) { if (v === undefined) return get(KEY.nick, ''); set(KEY.nick, v); return v; },
    aiLevel: function (v) { if (v === undefined) return get(KEY.aiLevel, 'normal'); set(KEY.aiLevel, v); return v; },
    mySide: function (v) { if (v === undefined) return get(KEY.mySide, 'cat'); set(KEY.mySide, v); return v; },
    tutorialDone: function (v) { if (v === undefined) return getFlag(KEY.tutorialDone, false); setFlag(KEY.tutorialDone, v); return v; },
    reduceMotion: function (v) { if (v === undefined) return getFlag(KEY.reduceMotion, false); setFlag(KEY.reduceMotion, v); return v; },
    showTrail: function (v) { if (v === undefined) return getFlag(KEY.showTrail, true); setFlag(KEY.showTrail, v); return v; },
    stats: stats,
    recordResult: recordResult,
    resetDefaults: function () {
      setFlag(KEY.reduceMotion, false);
      setFlag(KEY.showTrail, true);
    }
  };
}(window));
