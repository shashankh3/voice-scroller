/* VoiceScroll Ultimate v25.2 — content script (ISOLATED world).
 * Pin-accurate voice scrolling: zero-latency interim engine, fuzzy phonetic matching,
 * multi-alternative scoring, quantifiers, rAF precision scroller (CSS smooth-override),
 * native PDF wheel/shadow piercing, Web Audio earcons, HUD, cross-frame scroll bridge
 * and a chrome.debugger relay for embedded PDFs pages cannot script normally.
 * Command matching lives in vs-core.js (shared with the PDF voice hub).
 */
(function () {
  'use strict';
  if (window.__vs) return;

  // Only the top frame should run speech recognition and show the floating HUD.
  var isTop = (window.top === window.self);
  // Subframe + page-level scroll bridge is active everywhere so the hub-driven
  // engine (used for native PDFs) can still route commands into nested frames.
  var DEFAULTS = {
    dist: 400,
    smooth: true,
    sound: true,
    lang: 'en-US',
    sensitivity: 'balanced',   // strict | balanced | lenient
    speed: 40,                 // auto-scroll speed 1..100
    showHud: true,
    cDn: 'down, scroll down, go down, move down',
    cUp: 'up, scroll up, go up, move up',
    cPd: 'page down, next page, page forward',
    cPu: 'page up, previous page, page back',
    cTop: 'top, go to top, scroll to top',
    cBot: 'bottom, go to bottom, scroll to bottom',
    cStop: 'stop, halt, freeze, stop scrolling',
    cSleep: 'sleep, pause, pause listening',
    cWake: 'wake up, wake, resume, start listening',
    cFaster: 'faster, speed up, quicker, go faster',
    cSlower: 'slower, slow down, speed down, go slower'
  };

  var cfg = Object.assign({}, DEFAULTS);
  var matcher = null; // VSCore matcher instance rebuilt from cfg
  var rec = null;
  var active = false;
  var manualStop = false;
  var sleeping = false;
  var lastCmdTime = 0;
  var lastTranscript = '';
  var lastHeard = '';
  var lastConfidence = 0;
  var lastMatched = '';
  var restartTimer = null;
  var restartCount = 0;
  var restartWindowStart = Date.now();
  var autoTimer = null;
  var autoDir = 0;
  var autoStall = 0;
  var activeLang = '';        // actual recognition language (falls back on Edge)
  var langFallbackTried = false;
  var animId = 0; // rAF scroll animation handle
  var innerScanCache = { el: null, at: 0 }; // cached expensive inner-container scan
  var hudEl = null, hudOrb = null, hudText = null, hudSub = null,
      hudConfWrap = null, hudConfBar = null, hudTimer = null;

  // Zero-latency interim engine segment tracking.
  // Entry shape: { t, cmd, mod, score, text, final }. Pruned regularly so long
  // sessions never grow unbounded.
  var executedSegments = {};
  var interimTimers = {}; // per-segment settle timers — rapid commands don't cancel each other
  var audioCtx = null;

  function pruneSegments() {
    try {
      var keys = Object.keys(executedSegments);
      if (keys.length <= 60) return;
      var now = Date.now();
      for (var i = 0; i < keys.length; i++) {
        var en = executedSegments[keys[i]];
        if (en && (now - en.t) > 120000) delete executedSegments[keys[i]];
      }
      var rest = Object.keys(executedSegments);
      if (rest.length > 60) {
        rest.sort(function (a, b) { return executedSegments[a].t - executedSegments[b].t; });
        for (var j = 0; j < rest.length - 60; j++) delete executedSegments[rest[j]];
      }
    } catch (e) {}
  }

  function clearInterimTimers() {
    try {
      for (var k in interimTimers) clearTimeout(interimTimers[k]);
    } catch (e) {}
    interimTimers = {};
  }

  /* ================= audio earcons (Web Audio API) ================= */
  function playEarcon(type) {
    if (cfg.sound === false) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'start') {
        // Crisp two-tone chime (520Hz -> 780Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(780, now + 0.09);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.17);
      } else if (type === 'cmd') {
        // Subtle soft blip confirmation (840Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(840, now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.09);
      } else if (type === 'stop') {
        // Soft descending tone (660Hz -> 440Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.11);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.07, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.16);
      } else if (type === 'pause') {
        // Gentle low tone (400Hz)
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400, now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.13);
      }
    } catch (e) {}
  }

  /* ================= settings ================= */
  function loadCfg(done) {
    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(DEFAULTS, function (items) {
          if (items) cfg = Object.assign({}, DEFAULTS, items);
          cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
          cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
          buildMatchers();
          if (done) done();
        });
      } else { buildMatchers(); if (done) done(); }
    } catch (e) { buildMatchers(); if (done) done(); }
  }

  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        var langChanged = false, rebuild = false;
        for (var key in changes) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
            cfg[key] = changes[key].newValue;
            if (key === 'lang') langChanged = true;
            else if (key !== 'dist' && key !== 'smooth' && key !== 'speed' && key !== 'showHud' && key !== 'sound') rebuild = true;
          }
        }
        cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
        cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
        if (rebuild) buildMatchers();
        if (langChanged) {
          activeLang = cfg.lang || 'en-US';
          langFallbackTried = false;
          if (active) restartRecognizer(300);
        }
        else if (active && cfg.showHud !== false && isTop) showHud('Settings updated', 'std', '');
        if (cfg.showHud === false) hideHud(true);
      });
    }
  } catch (e) {}

  function clampNum(n, lo, hi) {
    if (isNaN(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ================= pin-accurate matching (shared via vs-core) ================= */
  function normalize(s) {
    return VSCore.normalize(s);
  }

  function buildMatchers() {
    try {
      matcher = VSCore.createMatcher(cfg);
    } catch (e) { matcher = null; }
  }

  function parseCommand(raw) {
    if (!matcher) buildMatchers();
    try { return matcher ? matcher.parseCommand(raw) : null; }
    catch (e) { return null; }
  }

  function parseModifier(raw, cmd) {
    if (!matcher) buildMatchers();
    try {
      return matcher ? matcher.parseModifier(raw, cmd) : { mult: 1, edge: null };
    } catch (e) { return { mult: 1, edge: null }; }
  }

  /* ================= precision scroller ================= */
  function pdfElement() {
    try {
      // 1. Direct PDF viewer custom element (e.g. Chrome open viewer, PDF.js)
      var viewer = document.querySelector('pdf-viewer');
      if (viewer && viewer.shadowRoot) {
        var sr = viewer.shadowRoot;
        var candidates = ['#viewerContainer', '#viewer-container', '#container', '#content', '#scroller'];
        for (var i = 0; i < candidates.length; i++) {
          var el = sr.querySelector(candidates[i]);
          if (el && el.scrollHeight > el.clientHeight + 10) return { el: el, type: 'shadow' };
        }
        var all = sr.querySelectorAll('*');
        var best = null, bestScore = 0;
        for (var j = 0; j < all.length; j++) {
          var o = all[j].scrollHeight - all[j].clientHeight;
          if (o > 50 && o > bestScore) { bestScore = o; best = all[j]; }
        }
        if (best) return { el: best, type: 'shadow' };
      }
      // 2. Native Chrome PDF plugin embed — strictly PDF only. A bare
      // `querySelector('embed')` would match videos/widgets on normal pages
      // and misroute scrolling, so every candidate must carry a PDF signal.
      var embed = document.querySelector('embed[type*="pdf"]');
      if (!embed) {
        var cand = document.querySelector('embed#plugin, embed[src*=".pdf"], embed[src*="mimehandler"]');
        if (cand) {
          var sig = (((cand.type || '') + ' ' + (cand.src || '')).toLowerCase());
          var hrefPdf = /\.pdf(\?|#|$)/i.test(window.location.href || '');
          var isPdfDoc = false;
          try { isPdfDoc = document.contentType === 'application/pdf'; } catch (e) {}
          if (sig.indexOf('pdf') !== -1 || (cand.id === 'plugin' && (isPdfDoc || hrefPdf))) {
            embed = cand;
          }
        }
      }
      if (embed) return { el: embed, type: 'embed' };
      // 3. PDF declared via <object> (same trusted-input rules as embeds)
      var obj = document.querySelector('object[type*="pdf"], object[data*=".pdf"]');
      if (obj && /pdf/i.test(String((obj.type || '') + ' ' + (obj.data || '') + ' ' + (obj.data || '').toLowerCase()))) {
        return { el: obj, type: 'object' };
      }
      // 4. PDF loaded directly in an <iframe src="...pdf"> — the viewer inside the
      // frame is a browser-internal page no script can reach, so scrolling goes
      // through the background's trusted debugger wheel.
      var fr = document.querySelector('iframe[src*=".pdf"], frame[src*=".pdf"]');
      if (fr && /\.pdf([?#]|$)/i.test(fr.getAttribute('src') || '')) {
        return { el: fr, type: 'iframe' };
      }
    } catch (e) {}
    return null;
  }

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    try {
      var st = window.getComputedStyle(el);
      var oy = st.overflowY;
      // Scrollable containers use auto/scroll/overlay (hidden is also
      // programmatically scrollable and common in app shells).
      var hasScrollStyle = (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || oy === 'hidden');
      if (!hasScrollStyle) return false;
      if (el.scrollHeight <= el.clientHeight + 4) return false;
      var r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    } catch (e) { return false; }
  }

  function innerScrollTarget() {
    try {
      // Points in center and quadrants
      var pts = [
        [window.innerWidth / 2, window.innerHeight / 2],
        [window.innerWidth / 2, window.innerHeight * 0.35],
        [window.innerWidth / 2, window.innerHeight * 0.65]
      ];
      for (var p = 0; p < pts.length; p++) {
        var stack = document.elementsFromPoint ? document.elementsFromPoint(pts[p][0], pts[p][1]) : [];
        for (var i = 0; i < stack.length; i++) {
          var el = stack[i], d = 0, n = el;
          while (n && d < 6) {
            if (isScrollable(n)) return n;
            n = n.parentElement;
            d++;
          }
        }
      }
      // The full-document scan below is expensive; auto-scroll ticks hit this
      // path every 45 ms on container-scroll pages, so reuse a fresh result.
      var cached = innerScanCache.el;
      if (cached && cached.isConnected && (Date.now() - innerScanCache.at) < 2000 && isScrollable(cached)) {
        return cached;
      }
      var all = document.querySelectorAll('main, section, article, div[role="main"], div[role="feed"], div');
      var best = null, bestH = 0;
      for (var j = 0; j < all.length; j++) {
        if (!isScrollable(all[j])) continue;
        var h = all[j].scrollHeight - all[j].clientHeight;
        if (h > bestH) { bestH = h; best = all[j]; }
      }
      innerScanCache.el = best;
      innerScanCache.at = Date.now();
      return best;
    } catch (e) { return null; }
  }

  function resolveTarget() {
    var pdf = pdfElement();
    if (pdf) return { pdf: pdf, isPdf: true, isWin: false, el: pdf.el };

    var docEl = document.documentElement;
    var body = document.body;
    var winScrollable = (docEl && docEl.scrollHeight > window.innerHeight + 8) ||
                        (body && body.scrollHeight > window.innerHeight + 8);

    if (winScrollable) {
      return { el: null, isWin: true, isPdf: false };
    }

    var inner = innerScrollTarget();
    if (inner) {
      return { el: inner, isWin: false, isPdf: false };
    }

    return { el: null, isWin: true, isPdf: false };
  }

  function cancelAnim() {
    animId++;
  }

  // Cancellable precision scroller with CSS smooth-behavior override.
  function animateOn(el, isWin, delta, done) {
    var my = ++animId;
    var dur = clampNum(160 + Math.abs(delta) * 0.32, 160, 520);
    var getY = function () {
      if (el && !isWin) return el.scrollTop;
      return window.scrollY || document.documentElement.scrollTop || 0;
    };
    var startY = getY(), t0 = 0;

    // Silky cubic ease-out for immediate initial acceleration and natural deceleration
    function ease(k) { return 1 - Math.pow(1 - k, 3); }

    function applyScroll(y) {
      if (el && !isWin) {
        try {
          if (typeof el.scrollTo === 'function') {
            el.scrollTo({ top: y, behavior: 'instant' });
          } else {
            el.scrollTop = y;
          }
        } catch (e) { el.scrollTop = y; }
      } else {
        try {
          // Explicit 'instant' behavior prevents CSS `scroll-behavior: smooth` interference!
          window.scrollTo({ top: y, left: window.scrollX || 0, behavior: 'instant' });
        } catch (e) {
          window.scrollTo(0, y);
        }
      }
    }

    if (!cfg.smooth || Math.abs(delta) < 2) {
      applyScroll(startY + delta);
      if (done) done();
      return;
    }

    function frame(ts) {
      if (my !== animId) return; // cancelled by newer command
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      var y = startY + delta * ease(k);
      applyScroll(y);
      if (k < 1) requestAnimationFrame(frame);
      else if (done) done();
    }
    requestAnimationFrame(frame);
  }

  /* ==== trusted debugger relay for embedded PDFs (fallback chain) ==== */
  // Embedded PDFs (embed/object/iframe) render in a browser-internal OOPIF hidden
  // behind a shadow root. Untrusted synthetic wheel events reach it only in some
  // plugin modes — trusted debugger wheel events always do (Chrome & Edge).
  // Primary channel = debugger wheel; on explicit unavailability we degrade to
  // the legacy synthetic WheelEvent dispatch so nothing double-scrolls.
  var pdffbPending = false;
  function requestDebuggerScroll(payload, onFail) {
    if (pdffbPending) return;
    pdffbPending = true;
    var settled = false;
    var finish = function (ok) {
      pdffbPending = false;
      if (settled) return;
      settled = true;
      if (!ok && onFail) onFail();
    };
    try {
      var p = chrome.runtime.sendMessage({ cmd: 'VS_PDFFB', kind: payload.kind || 'wheel', delta: payload.delta || 0, key: payload.key || '' });
      if (p && typeof p.then === 'function') {
        p.then(function (r) { finish(!!(r && r.ok)); }).catch(function () { finish(false); });
      } else setTimeout(function () { finish(false); }, 400);
    } catch (e) { finish(false); }
  }

  function syntheticPdfWheel(pdf, delta) {
    try {
      var target = pdf.el || document.body || window;
      var ev = new WheelEvent('wheel', {
        deltaY: delta,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2
      });
      target.dispatchEvent(ev);
    } catch (e) {}
  }

  // Legacy synthetic key fallback for PDF jumps (plugin / embedding cases)
  function sendPdfPluginKey(which) {
    try {
      var k = which === 'top' ? 'Home' : 'End';
      var kc = which === 'top' ? 36 : 35;
      (t_pdf_key_el() || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: kc, which: kc, bubbles: true }));
    } catch (e) {}
  }
  function t_pdf_key_el() {
    try { return pdfElement() && pdfElement().el; } catch (e) { return null; }
  }

  // Native Chrome PDF scrolling handler (shadow DOM + debugger wheel + synthetic fallback)
  function scrollPdf(pdf, delta) {
    cancelAnim();
    if (pdf.type === 'shadow' && pdf.el) {
      animateOn(pdf.el, false, Math.round(delta * 1.1), null);
      return;
    }
    if (pdf.type === 'embed' || pdf.type === 'object' || pdf.type === 'iframe') {
      requestDebuggerScroll({ kind: 'wheel', delta: delta }, function () {
        syntheticPdfWheel(pdf, delta);
      });
      return;
    }
    syntheticPdfWheel(pdf, delta);
  }

  function doScroll(cmd, mult, edge, usePage) {
    stopAuto(true);
    cancelAnim();
    var dist = cfg.dist;
    var pageH = Math.max(200, window.innerHeight * 0.9);
    var t = resolveTarget();

    if (edge === 'top' || cmd === 'top') return jumpTo('top', t);
    if (edge === 'bot' || cmd === 'bot') return jumpTo('bot', t);

    var base;
    if (cmd === 'pd' || cmd === 'pu') base = pageH;
    else if (usePage) base = pageH * (mult || 1);
    else base = dist * (mult || 1);
    if (cmd === 'pd' || cmd === 'pu') base = base * (mult && mult !== 1 ? mult : 1);

    var delta = (cmd === 'dn' || cmd === 'pd') ? Math.round(base) : -Math.round(base);

    if (t.isPdf) {
      scrollPdf(t.pdf, delta);
      return;
    }

    if (t.el && !t.isWin) {
      // Inner scrollable element target directly
      animateOn(t.el, false, delta, null);
      return;
    }

    var before = window.scrollY || document.documentElement.scrollTop || 0;
    animateOn(null, true, delta, function () {
      var after = window.scrollY || document.documentElement.scrollTop || 0;
      if (Math.abs(after - before) < 2) {
        var inner = innerScrollTarget();
        if (inner) {
          var amt = (cmd === 'pd' || cmd === 'pu')
            ? Math.round(inner.clientHeight * 0.9 * (mult && mult !== 1 ? mult : 1))
            : delta;
          animateOn(inner, false, amt, null);
        } else {
          // Page did not move and no inner scroll target was found. The content
          // may live in a child frame (cross-origin docs, embedded viewers) or
          // inside an embedded PDF: first offer the scroll to child frames via
          // the postMessage bridge, then fall back to trusted debugger input.
          crossFrameScroll(cmd, delta, mult);
        }
      }
    });
  }

  /* ================= cross-frame scroll bridge ================= */
  var bridgeSeq = 0;
  var bridgeAcked = false;
  function bridgePayload(delta, seq) {
    return { __vsBridge: 'scroll', delta: delta, seq: seq };
  }

  // Ask every child frame if it can scroll. Child content scripts answer with
  // an ack; if none moved within the settle window we escalate to debugger input.
  function crossFrameScroll(cmd, delta, mult) {
    var kids = 0;
    try { kids = window.frames ? window.frames.length : 0; } catch (e) { kids = 0; }
    if (!kids || !isTop) {
      requestDebuggerScroll({ kind: 'wheel', delta: delta });
      return;
    }
    bridgeAcked = false;
    var seq = ++bridgeSeq;
    var payload = bridgePayload(delta, seq);
    try {
      for (var i = 0; i < kids; i++) window.frames[i].postMessage(payload, '*');
    } catch (e) {}
    setTimeout(function () {
      if (seq === bridgeSeq && !bridgeAcked) {
        requestDebuggerScroll({ kind: 'wheel', delta: delta });
      }
    }, 160);
  }


  function jumpTo(which, t) {
    cancelAnim();
    if (t.isPdf) {
      if (t.pdf.type === 'shadow' && t.pdf.el) {
        try {
          var topPos = which === 'top' ? 0 : t.pdf.el.scrollHeight;
          t.pdf.el.scrollTo({ top: topPos, behavior: cfg.smooth ? 'smooth' : 'instant' });
        } catch (e) {
          t.pdf.el.scrollTop = which === 'top' ? 0 : t.pdf.el.scrollHeight;
        }
        return;
      }
      if (t.pdf.type === 'embed' || t.pdf.type === 'object' || t.pdf.type === 'iframe') {
        // Trusted Home / End keys into the PDF plugin via the debugger relay.
        requestDebuggerScroll({ kind: 'key', key: which === 'top' ? 'Home' : 'End' }, function () {
          sendPdfPluginKey(which);
        });
        return;
      }
      sendPdfPluginKey(which);
      if (t.pdf.el) {
        try {
          var yPos = which === 'top' ? 0 : t.pdf.el.scrollHeight;
          t.pdf.el.scrollTo({ top: yPos, behavior: cfg.smooth ? 'smooth' : 'instant' });
        } catch (e) {}
      }
      return;
    }

    var targetEl = (t.el && !t.isWin) ? t.el : null;
    if (targetEl) {
      var targetY = which === 'top' ? 0 : targetEl.scrollHeight - targetEl.clientHeight;
      animateOn(targetEl, false, targetY - targetEl.scrollTop, null);
      return;
    }

    if (!cfg.smooth) {
      var y = which === 'top' ? 0 : (document.documentElement.scrollHeight || document.body.scrollHeight);
      try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
      return;
    }

    var totalH = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    var target = which === 'top' ? 0 : Math.max(0, totalH - window.innerHeight);
    var start = window.scrollY || 0;
    animateOn(null, true, target - start, function () {
      var after = window.scrollY || 0;
      if (Math.abs(after - target) > window.innerHeight * 0.5) {
        var inner = innerScrollTarget();
        if (inner) {
          try {
            inner.scrollTo({ top: which === 'top' ? 0 : inner.scrollHeight, behavior: 'smooth' });
          } catch (e) {}
        }
      }
    });
  }

  /* ================= auto-scroll ================= */
  function autoStep() {
    return Math.max(8, Math.round(cfg.speed * 0.9));
  }

  function startAuto(dir) {
    stopAuto(true);
    autoDir = dir;
    cancelAnim();
    autoStall = 0;
    playEarcon('cmd');
    autoTimer = setInterval(function () {
      autoTick();
    }, 45);
    if (isTop) showHud(autoDir > 0 ? 'Auto-scroll down' : 'Auto-scroll up', 'success', 'say "stop" · "faster" · "slower"');
  }

  function autoTick() {
    var t = resolveTarget();
    if (t.isPdf) {
      scrollPdf(t.pdf, autoDir * autoStep());
      return;
    }
    if (t.el && !t.isWin) {
      try { t.el.scrollTop += autoDir * autoStep(); } catch (e) {}
      return;
    }
    var y0 = window.scrollY || document.documentElement.scrollTop || 0;
    try { window.scrollBy(0, autoDir * autoStep()); } catch (e) {}
    var y1 = window.scrollY || document.documentElement.scrollTop || 0;
    if (Math.abs(y1 - y0) < 2) {
      // Window is not the scroller — try the inner container, then child frames,
      // then the debugger relay so auto-scroll also works on embedded viewers.
      autoStall++;
      if (autoStall % 3 === 1) {
        var inner = innerScrollTarget();
        if (inner) { try { inner.scrollTop += autoDir * autoStep(); } catch (e) {} return; }
      }
      var kids = 0;
      try { kids = window.frames ? window.frames.length : 0; } catch (e) {}
      if (kids && isTop) {
        // Primary: offer each child frame the scroll via the postMessage bridge.
        var seq = ++bridgeSeq;
        bridgeAcked = false;
        try {
          var payload = bridgePayload(autoDir * autoStep(), seq);
          for (var i = 0; i < kids; i++) window.frames[i].postMessage(payload, '*');
        } catch (e) {}
        if (autoStall >= 6) {
          // Secondary: if the bridge stays silent, escalate to trusted input.
          autoStall = 3;
          setTimeout(function () {
            if (seq === bridgeSeq && !bridgeAcked) {
              requestDebuggerScroll({ kind: 'wheel', delta: autoDir * autoStep() });
            }
          }, 160);
        }
      } else if (isTop && autoStall >= 3) {
        autoStall = 0;
        requestDebuggerScroll({ kind: 'wheel', delta: autoDir * autoStep() });
      }
    } else {
      autoStall = 0;
    }
  }

  function stopAuto(silent) {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      autoDir = 0;
    }
    if (!silent) cancelAnim();
  }

  function setSpeed(next) {
    cfg.speed = clampNum(next, 1, 100);
    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ speed: cfg.speed });
      }
    } catch (e) {}
  }

  /* ================= speech engine ================= */
  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function notifyState(on) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        var p = chrome.runtime.sendMessage({ cmd: 'VS_STATE_CHANGED', on: on });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {}
  }

  function start() {
    if (active) return;
    if (!speechCtor()) {
      if (isTop) showHud('Speech API unavailable', 'err', 'use a current Chrome or Edge');
      return;
    }
    manualStop = false;
    sleeping = false;
    restartCount = 0;
    restartWindowStart = Date.now();
    executedSegments = {};
    if (!activeLang) activeLang = cfg.lang || 'en-US';
    createAndStart();
  }

  function createAndStart() {
    var SR = speechCtor();
    if (!SR) {
      active = false;
      if (isTop) showHud('Speech API unavailable', 'err', 'use a current Chrome or Edge');
      return;
    }
    try { if (rec) { try { rec.abort(); } catch (e) {} rec = null; } } catch (e) {}
    // A fresh recognizer restarts result indices at 0; stale dedup entries from
    // the previous instance would suppress new commands, so drop them.
    clearInterimTimers();
    executedSegments = {};

    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = activeLang || cfg.lang || 'en-US';
    try { rec.maxAlternatives = 3; } catch (e) { try { rec.maxAlternatives = 1; } catch (e2) {} }

    rec.onstart = function () {
      active = true;
      restartCount = 0;
      notifyState(true);
      playEarcon('start');
      if (isTop) showHud('Listening', 'live', 'say "down" · "up" · "page down"');
    };

    rec.onresult = function (e) {
      try {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var r = e.results[i];
          if (!r) continue;
          var cands = [];
          for (var a = 0; a < r.length; a++) {
            if (r[a] && r[a].transcript) {
              cands.push({ text: r[a].transcript, conf: r[a].confidence || 0 });
            }
          }
          if (!cands.length) continue;

          handleSpeechCandidates(cands, r.isFinal, i);
          if (!r.isFinal) interim = cands[0].text;
        }

        if (interim && isTop) {
          lastHeard = interim;
          showHud(interim, sleeping ? 'sleep' : 'live', sleeping ? 'paused — say "wake up"' : '…');
        }
      } catch (err) {}
    };

    rec.onerror = function (e) {
      var err = (e && e.error) || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        active = false; manualStop = true;
        notifyState(false);
        if (isTop) showHud('Mic blocked', 'err', 'click lock icon › allow mic › retry');
        try { if (rec) rec.abort(); } catch (ee) {}
      } else if (err === 'audio-capture') {
        active = false; manualStop = true;
        notifyState(false);
        if (isTop) showHud('No microphone', 'err', 'plug in a mic and retry');
        try { if (rec) rec.abort(); } catch (ee) {}
      } else if (err === 'language-not-supported') {
        // Chromium-family engines (especially Edge) reject a requested language
        // outright. Retry once with the service default (en-US) instead of
        // spinning in a restart loop; if even that fails, stop cleanly.
        if (!langFallbackTried && String(activeLang || cfg.lang) !== 'en-US') {
          langFallbackTried = true;
          activeLang = 'en-US';
          if (isTop) showHud('Language fallback', 'err', String(cfg.lang || '') + ' not available — retrying en-US');
          restartRecognizer(220);
          return;
        }
        active = false; manualStop = true;
        notifyState(false);
        if (isTop) {
          showHud('Language not available', 'err', 'this browser refuses "' + String(activeLang || cfg.lang) + '" — try Chrome desktop or change the language');
        }
        try { if (rec) rec.abort(); } catch (ee) {}
      }
    };

    rec.onend = function () {
      if (!active || manualStop) {
        notifyState(false);
        return;
      }
      var now = Date.now();
      if (now - restartWindowStart > 10000) { restartWindowStart = now; restartCount = 0; }
      restartCount++;
      var delay = Math.min(250 * restartCount, 2200);
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function () {
        if (active && !manualStop) {
          // Always instantiate a fresh recognizer instance to prevent InvalidStateError on ended instances
          createAndStart();
        }
      }, delay);
    };

    try {
      rec.start();
    } catch (e) {
      active = false;
      notifyState(false);
      if (isTop) showHud('Could not start mic', 'err', 'grant permission and retry');
    }
  }

  function restartRecognizer(delay) {
    if (!active) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      if (!active) return;
      try { if (rec) rec.abort(); } catch (e) {}
      createAndStart();
    }, delay || 300);
  }

  // Zero-latency speech processor with interim settling debounce and segment deduplication.
  // Upgrade rule: if interim already scrolled "down" but the final transcript turns
  // out to be "down three", only the *remaining* 2 steps scroll (no overshoot, no loss).
  function handleSpeechCandidates(cands, isFinal, segmentIdx) {
    pruneSegments();
    var prev = executedSegments[segmentIdx];

    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var hit = parseCommand(cands[i].text);
      if (hit) {
        var s = hit.score * 10 - i * 2;
        if (!best || s > best.s) {
          best = { hit: hit, s: s, text: cands[i].text, conf: cands[i].conf };
        }
      }
    }

    if (best) {
      // Same segment spoke further: upgrade incrementally instead of ignoring or doubling.
      if (prev && prev.done) {
        if (best.hit.cmd === prev.cmd && best.hit.cmd !== 'stop' &&
            best.hit.cmd !== 'sleep' && best.hit.cmd !== 'wake' &&
            best.hit.cmd !== 'faster' && best.hit.cmd !== 'slower') {
          var nm = parseModifier(best.text, best.hit.cmd);
          var om = prev.mod || { mult: 1, edge: null };
          var upgraded = false;
          if (nm.edge && nm.edge !== om.edge) {
            doScroll(best.hit.cmd, 0, nm.edge, false);
            upgraded = true;
          } else if (!nm.edge && !om.edge && (nm.mult || 1) > (om.mult || 1)) {
            var diff = (nm.mult || 1) - (om.mult || 1);
            if (diff > 0) {
              if (nm.page && best.hit.cmd !== 'pd' && best.hit.cmd !== 'pu') {
                doScroll(best.hit.cmd, diff, null, true);
              } else {
                doScroll(best.hit.cmd, diff, null, false);
              }
              upgraded = true;
            }
          }
          if (upgraded) {
            lastHeard = best.text;
            lastConfidence = best.conf || 0;
            prev.mod = nm; prev.text = best.text; prev.score = best.hit.score;
            if (isFinal) prev.final = true;
            lastCmdTime = Date.now();
            lastTranscript = best.hit.cmd + '|' + normalize(best.text);
            lastMatched = best.hit.cmd;
            playEarcon('cmd');
            if (isTop) {
              var ul = { dn: 'Down ×' + nm.mult, up: 'Up ×' + nm.mult,
                        pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' };
              showHud(ul[best.hit.cmd] || best.hit.cmd, 'success', fmtConf(lastConfidence));
            }
            return;
          }
        }
        if (isFinal) prev.final = true;
        return; // genuine duplicate interim/final overlap — suppress double-scroll
      }

      var cmd = best.hit.cmd;
      lastHeard = best.text;
      lastConfidence = best.conf || 0;

      // 1. Immediate commands ("stop", "sleep", "wake") execute instantly with 0ms delay
      if (cmd === 'stop' || cmd === 'sleep' || (cmd === 'wake' && sleeping)) {
        clearTimeout(interimTimers[segmentIdx]);
        delete interimTimers[segmentIdx];
        executedSegments[segmentIdx] = { t: Date.now(), cmd: cmd, done: true, final: true,
          mod: parseModifier(best.text, cmd), score: best.hit.score, text: best.text };
        handleCommand(cmd, best.text, lastConfidence);
        return;
      }

      // 2. If it is already final, execute immediately
      if (isFinal) {
        clearTimeout(interimTimers[segmentIdx]);
        delete interimTimers[segmentIdx];
        executedSegments[segmentIdx] = { t: Date.now(), cmd: cmd, done: true, final: true,
          mod: parseModifier(best.text, cmd), score: best.hit.score, text: best.text };
        handleCommand(cmd, best.text, lastConfidence);
        return;
      }

      // 3. For scroll commands in interim mode: brief 210ms settling window allows multi-word modifiers ("down three")
      clearTimeout(interimTimers[segmentIdx]);
      (function (seg, b) {
        interimTimers[seg] = setTimeout(function () {
          delete interimTimers[seg];
          var p = executedSegments[seg];
          if (p && p.done) return;
          executedSegments[seg] = { t: Date.now(), cmd: b.hit.cmd, done: true, final: false,
            mod: parseModifier(b.text, b.hit.cmd), score: b.hit.score, text: b.text };
          handleCommand(b.hit.cmd, b.text, b.conf || 0);
        }, 210);
      })(segmentIdx, best);
    } else if (isFinal) {
      var topText = cands[0].text;
      lastHeard = topText;
      lastConfidence = cands[0].conf || 0;
      lastMatched = '';
      if (isTop) {
        if (!sleeping) showHud(topText, 'idle', 'no command — try "down"');
        else showHud(topText, 'sleep', 'paused — say "wake up"');
      }
    }
  }

  function handleCommand(cmd, raw, conf) {
    var now = Date.now();
    var dupKey = cmd + '|' + normalize(raw);

    // Fast echo guard: only suppress if exactly identical command arrived within 380ms
    if (dupKey === lastTranscript && (now - lastCmdTime < 380) && cmd !== 'stop') return;

    if (sleeping) {
      if (cmd === 'wake') {
        sleeping = false;
        lastCmdTime = now;
        lastTranscript = dupKey;
        lastMatched = cmd;
        playEarcon('start');
        if (isTop) showHud('Awake', 'success', fmtConf(conf));
      } else if (isTop) {
        showHud(raw, 'sleep', 'paused — say "wake up"');
      }
      return;
    }

    if (cmd === 'sleep') {
      sleeping = true;
      stopAuto();
      cancelAnim();
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      playEarcon('pause');
      if (isTop) showHud('Paused', 'sleep', 'say "wake up" to resume');
      return;
    }

    if (cmd === 'wake') {
      lastCmdTime = now;
      lastTranscript = dupKey;
      if (isTop) showHud('Already listening', 'live', fmtConf(conf));
      return;
    }

    var keep = /\b(keep|continue|keep going|keep scrolling|start scrolling)\b/.test(' ' + normalize(raw) + ' ');
    if (keep && (cmd === 'dn' || cmd === 'up')) {
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      startAuto(cmd === 'dn' ? 1 : -1);
      return;
    }

    if (cmd === 'stop') {
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      var wasAuto = !!autoTimer;
      stopAuto();
      cancelAnim();
      playEarcon('stop');
      if (isTop) showHud(wasAuto ? 'Auto-scroll stopped' : 'Stopped', wasAuto ? 'success' : 'idle', fmtConf(conf));
      return;
    }

    if (cmd === 'faster' || cmd === 'slower') {
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      setSpeed(cfg.speed + (cmd === 'faster' ? 12 : -12));
      playEarcon('cmd');
      if (!autoTimer) startAuto(1);
      if (isTop) showHud(cmd === 'faster' ? 'Faster' : 'Slower', 'success', 'speed ' + cfg.speed + '% · ' + fmtConf(conf));
      return;
    }

    lastCmdTime = now;
    lastTranscript = dupKey;
    lastMatched = cmd;
    var mod = parseModifier(raw, cmd);
    playEarcon('cmd');
    doScroll(cmd, mod.mult, mod.edge, mod.page);

    var labels = {
      dn: mod.mult > 1 ? 'Down ×' + mod.mult : (mod.mult < 1 ? 'Down · nudge' : 'Down'),
      up: mod.mult > 1 ? 'Up ×' + mod.mult : (mod.mult < 1 ? 'Up · nudge' : 'Up'),
      pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom'
    };
    if (isTop) showHud(labels[cmd] || cmd, 'success', fmtConf(conf));
  }

  function fmtConf(c) {
    if (!c || c <= 0) return 'heard "' + String(lastHeard).slice(0, 42) + '"';
    return 'heard "' + String(lastHeard).slice(0, 42) + '" · ' + Math.round(c * 100) + '%';
  }

  /* ================= minimal on-page indicator (Tesla dark theme) ================= */
  var CSS = [
    '.vs-hud{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(6px);',
    'display:flex;align-items:center;gap:10px;padding:10px 18px 10px 12px;border-radius:15px;',
    'background:rgba(8,9,11,.78);border:1px solid rgba(255,255,255,.1);',
    'backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);',
    'box-shadow:0 14px 44px -10px rgba(0,0,0,.55);',
    'color:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Roboto,sans-serif;z-index:2147483647;',
    'pointer-events:none;opacity:0;transition:opacity .2s,transform .2s;',
    'max-width:min(88vw,560px);box-sizing:border-box;line-height:normal;}',
    '.vs-hud.vs-show{opacity:1;transform:translateX(-50%) translateY(0);}',
    '.vs-hud.vs-live{border-color:rgba(227,25,55,.38);box-shadow:0 14px 44px -10px rgba(0,0,0,.55),0 0 22px -4px rgba(227,25,55,.28);}',
    '.vs-orb{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;',
    'font-size:13px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);transition:background .2s,border-color .2s;}',
    '.vs-orb span{display:flex;align-items:center;justify-content:center;}',
    '.vs-hud.vs-live .vs-orb{background:rgba(227,25,55,.15);border-color:rgba(227,25,55,.42);}',
    '.vs-hud.vs-err .vs-orb{background:rgba(255,82,82,.13);border-color:rgba(255,82,82,.38);}',
    '.vs-hud.vs-sleep .vs-orb{background:rgba(232,201,138,.12);border-color:rgba(232,201,138,.38);}',
    '.vs-main{display:flex;flex-direction:column;line-height:1.3;min-width:0;}',
    '.vs-text{font-size:13px;font-weight:600;letter-spacing:.01em;color:#f4f4f2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54vw;}',
    '.vs-sub{font-size:11px;font-weight:400;color:rgba(244,244,242,.52);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54vw;margin-top:1px;}',
    '.vs-conf{width:56px;height:2px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;flex-shrink:0;}',
    '.vs-conf i{display:block;height:100%;width:0;border-radius:99px;background:#e31937;box-shadow:0 0 8px rgba(227,25,55,.7);transition:width .25s;}'
  ].join('');

  function ensureHud() {
    if (!isTop) return null;
    if (hudEl && document.contains(hudEl)) return hudEl;
    try {
      if (!document.getElementById('vs-hud-style')) {
        var st = document.createElement('style');
        st.id = 'vs-hud-style';
        st.textContent = CSS;
        (document.head || document.documentElement).appendChild(st);
      }
      var host = document.body || document.documentElement;
      if (!host) return null;
      hudEl = document.createElement('div');
      hudEl.className = 'vs-hud';
      hudEl.setAttribute('data-voicescroll', '1');
      hudOrb = document.createElement('div');
      hudOrb.className = 'vs-orb';
      hudOrb.innerHTML = '<span>🎤</span>';
      var main = document.createElement('div');
      main.className = 'vs-main';
      hudText = document.createElement('div');
      hudText.className = 'vs-text';
      hudSub = document.createElement('div');
      hudSub.className = 'vs-sub';
      main.appendChild(hudText);
      main.appendChild(hudSub);
      hudConfWrap = document.createElement('div');
      hudConfWrap.className = 'vs-conf';
      hudConfBar = document.createElement('i');
      hudConfWrap.appendChild(hudConfBar);
      hudEl.appendChild(hudOrb);
      hudEl.appendChild(main);
      hudEl.appendChild(hudConfWrap);
      host.appendChild(hudEl);
      return hudEl;
    } catch (e) { return null; }
  }

  function showHud(text, type, sub) {
    if (!isTop) return;
    try {
      if (cfg.showHud === false) return;
      var h = ensureHud();
      if (!h) return;
      hudEl.className = 'vs-hud vs-show' +
        (type === 'err' ? ' vs-err' : type === 'sleep' ? ' vs-sleep' : type === 'live' ? ' vs-live' : '');
      hudOrb.innerHTML = type === 'err' ? '<span>⚠️</span>' : type === 'sleep' ? '<span>💤</span>' :
        type === 'success' ? '<span>✓</span>' : '<span>🎤</span>';
      hudText.textContent = String(text).slice(0, 90);
      hudSub.textContent = String(sub || '').slice(0, 90);
      hudSub.style.display = sub ? '' : 'none';
      if (hudConfBar) {
        var c = lastConfidence || 0;
        hudConfBar.style.width = c > 0 ? Math.round(c * 100) + '%' : '0%';
        hudConfWrap.style.display = (type === 'success' && c > 0) ? '' : 'none';
      }
      clearTimeout(hudTimer);
      hudTimer = setTimeout(function () {
        if (!hudEl) return;
        if (active) {
          hudEl.className = 'vs-hud vs-show' + (sleeping ? ' vs-sleep' : ' vs-live');
          hudOrb.innerHTML = sleeping ? '<span>💤</span>' : '<span>🎤</span>';
          hudText.textContent = sleeping ? 'Paused' : 'Listening';
          hudSub.textContent = sleeping ? 'say "wake up"' : 'say "down" · "up"';
          hudSub.style.display = '';
          if (hudConfWrap) hudConfWrap.style.display = 'none';
        } else {
          hudEl.className = 'vs-hud';
        }
      }, type === 'err' ? 3200 : 1700);
    } catch (e) {}
  }

  function hideHud(hard) {
    try {
      cancelAnim();
      clearTimeout(hudTimer);
      if (hudEl) hudEl.className = 'vs-hud';
      if (hard && hudEl && hudEl.parentNode) hudEl.parentNode.removeChild(hudEl);
      if (hard) hudEl = null;
    } catch (e) {}
  }

  function stopAll(reason) {
    manualStop = true;
    active = false;
    sleeping = false;
    stopAuto();
    cancelAnim();
    notifyState(false);
    clearTimeout(restartTimer);
    clearInterimTimers();
    try { if (rec) rec.abort(); } catch (e) {}
    rec = null;
    try {
      if (reason === 'toggle' && cfg.showHud !== false && isTop) {
        showHud('VoiceScroll off', 'idle', '');
        setTimeout(function () { if (hudEl) hudEl.className = 'vs-hud'; }, 700);
      } else hideHud(false);
    } catch (e) {}
  }

  /* ================= cross-frame scroll bridge (every frame) ================= */
  window.addEventListener('message', function (e) {
    try {
      var d = e.data;
      if (!d || typeof d !== 'object' || !d.__vsBridge) return;
      if (window !== window.top && e.source !== window.parent) return;
      if (window === window.top && e.source === window) return;

      if (d.__vsBridge === 'scroll') {
        // Child frames: try to honor the scroll locally and report back.
        var delta = Math.round(d.delta || 0);
        if (!delta) return;
        var done = crossFrameApplyScroll(delta);
        try { e.source.postMessage({ __vsBridge: 'ack', seq: d.seq, moved: done }, '*'); } catch (err) {}
        return;
      }
      if (d.__vsBridge === 'ack' && isTop) {
        bridgeAcked = true;
        if (d.moved && autoTimer) autoStall = 3; // let the bridge carry auto-scroll
        return;
      }
    } catch (err) {}
  });

  // Best-effort local scroll inside a child frame (own window + inner container).
  function crossFrameApplyScroll(delta) {
    var moved = false;
    try {
      var pdf = isTop ? null : pdfElement();
      if (pdf) {
        scrollPdf(pdf, delta);
        return true;
      }
      var y0 = window.scrollY || document.documentElement.scrollTop || 0;
      try { window.scrollBy(0, delta); } catch (err) {}
      var y1 = window.scrollY || document.documentElement.scrollTop || 0;
      if (Math.abs(y1 - y0) >= 1) moved = true;
      var inner = innerScrollTarget();
      if (inner) {
        var s0 = inner.scrollTop;
        try { inner.scrollTop += delta; } catch (err) {}
        if (Math.abs(inner.scrollTop - s0) >= 1) moved = true;
      }
    } catch (err) {}
    return moved;
  }

  /* ================= external API ================= */
  window.__vs = {
    toggle: function () {
      if (active) {
        stopAll('toggle');
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        loadCfg(function () { start(); resolve(true); });
      });
    },
    start: function () {
      return new Promise(function (resolve) {
        loadCfg(function () { start(); resolve(true); });
      });
    },
    stop: function () { stopAll('api'); return Promise.resolve(false); },
    status: function () { return active; },
    test: function (cmd) {
      loadCfg(function () {
        if (cmd === 'faster') { setSpeed(cfg.speed + 12); if (!autoTimer) startAuto(1); return; }
        if (cmd === 'slower') { setSpeed(cfg.speed - 12); return; }
        playEarcon('cmd');
        doScroll(cmd, 1, null, false);
        if (isTop) {
          showHud({ dn: 'Down', up: 'Up', pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' }[cmd] || cmd, 'success', 'test scroll');
        }
      });
      return true;
    }
  };

  try {
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        try {
          if (!msg || typeof msg !== 'object') return false;
          if (msg.cmd === 'VS_PING') {
            sendResponse({ pong: true });
            return true;
          }
          // In subframes, only respond if message is explicitly addressed to subframe or top doesn't respond
          if (!isTop && (msg.cmd === 'VS_TOGGLE' || msg.cmd === 'VS_STATUS')) {
            return false;
          }
          if (msg.cmd === 'VS_TOGGLE') {
            window.__vs.toggle().then(function (on) { sendResponse({ on: on }); });
            return true;
          }
          if (msg.cmd === 'VS_STATUS') {
            sendResponse({
              on: active,
              sleeping: sleeping,
              heard: lastHeard,
              conf: lastConfidence,
              matched: lastMatched,
              speed: cfg.speed
            });
            return true;
          }
          if (msg.cmd === 'VS_STOP') {
            stopAll('msg');
            sendResponse({ on: false });
            return true;
          }
          if (msg.cmd === 'VS_TEST') {
            window.__vs.test(msg.what || 'dn');
            sendResponse({ ok: true });
            return true;
          }
          // Relay from the PDF voice hub via background: execute a decoded command
          // on this tab's engine (top frame only, mirrors speech-driven path).
          if (msg.cmd === 'VS_CMD' && isTop) {
            if (msg.name === 'auto') {
              if (msg.dir) startAuto(msg.dir);
            } else if (msg.name === 'stop') {
              lastCmdTime = Date.now();
              lastTranscript = 'stop|';
              lastMatched = 'stop';
              var wasAuto = !!autoTimer;
              stopAuto();
              cancelAnim();
              playEarcon('stop');
              if (isTop) showHud(wasAuto ? 'Auto-scroll stopped' : 'Stopped', wasAuto ? 'success' : 'idle', '');
            } else if (msg.partial && typeof msg.mult === 'number' && isFinite(msg.mult) && msg.mult > 0) {
              // Incremental remainder from the voice hub (interim "down" already
              // executed, later "down three" arrived): apply only the difference.
              lastCmdTime = Date.now();
              lastMatched = msg.name;
              playEarcon('cmd');
              doScroll(msg.name, msg.mult, null, !!msg.page);
              var pl = { dn: 'Down ×' + msg.mult, up: 'Up ×' + msg.mult,
                         pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' };
              if (isTop) showHud(pl[msg.name] || msg.name, 'success', '');
            } else {
              var raw = String(msg.raw || '');
              handleCommand(msg.name, raw, 0);
            }
            sendResponse({ ok: true });
            return true;
          }
        } catch (e) {}
        return false;
      });
    }
  } catch (e) {}

  loadCfg(function () { buildMatchers(); });
})();
