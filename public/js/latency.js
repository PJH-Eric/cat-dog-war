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
    timer = 0;
    if (!active) {
      value = null;
      render();
      return;
    }
    render();
    runProbe();
    timer = setInterval(runProbe, 2500);
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

  root.NetworkLatency = { setActive, setProbe, report, bindSocketIo };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureMeter, { once: true });
  else ensureMeter();
})(window);
