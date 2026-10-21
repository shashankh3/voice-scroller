/* VoiceScroll Ultimate v28.1 — content script (ISOLATED world).
 * Pin-accurate voice scrolling: zero-latency interim engine, fuzzy phonetic
 * matching (English + हिन्दी via vs-core), multi-alternative scoring,
 * quantifiers, rAF precision scroller (CSS smooth-override), rAF frame-locked
 * auto-scroll, native PDF wheel/shadow piercing, Web Audio earcons, HUD with
 * clickable mic orb, "help" voice command with an on-page cheat sheet,
 * cross-frame scroll bridge and a chrome.debugger relay for embedded PDFs
 * pages cannot script normally.
 * Command matching lives in vs-core.js (shared with the PDF voice hub).
 */
(function () {
  'use strict';
  if (window.__vs) return;

  // Only the top frame should run speech recognition and show the floating HUD.
  var isTop = (window.top === window.self);
  // Subframe + page-level scroll bridge is active everywhere so the hub-driven
  // engine (used for native PDFs) can still route commands into nested frames.
  // Settings defaults live in vs-core so every context shares one source.
  var DEFAULTS = VSCore.DEFAULTS;

  var cfg = Object.assign({}, DEFAULTS);
  var matcher = null; // VSCore matcher instance rebuilt from cfg
  var engine = null;  // VSCore speech engine (dedup + settling + upgrades)
  var rec = null;
  var active = false;
  var manualStop = false;
  var sleeping = false;
  var lastError = '';
  var lastCmdTime = 0;
  var lastTranscript = '';
  var lastHeard = '';
  var lastConfidence = 0;
  var lastMatched = '';
  var restartTimer = null;
  var restartCount = 0;
  var restartBurst = 0;          // fast failures inside the current window
  var recStartTs = 0;            // when the running recognizer started
  var startRetries = 0;          // consecutive failed start() calls
  var restartWindowStart = Date.now();
  var autoTimer = null;
  var autoDir = 0;
  var autoStall = 0;
  var autoStallClock = 0; // ms since last stall check (rAF loop)
  var autoNoMove = 0;     // ms without any movement (edge detection)
  var autoLastTs = 0;
  var activeLang = '';        // actual recognition language (falls back on Edge)
  var langFallbackTried = false;
  var animId = 0; // rAF scroll animation handle
  var innerScanCache = { el: null, at: 0 }; // cached expensive inner-container scan
  var hudEl = null, hudOrb = null, hudText = null, hudSub = null,
      hudConfWrap = null, hudConfBar = null, hudTimer = null;
  var lastHudPaint = 0;         // throttles interim HUD repaints
  var missStreak = 0;           // consecutive unmatched utterances
  var helpEl = null, helpTimer = null;

  // Zero-latency interim engine segment tracking lives in vs-core's shared
  // engine (one implementation for the page and the voice hub).
  var audioCtx = null;

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
      if (chrome && chrome.storage) {
        VSCore.storageGet(DEFAULTS, function (items) {
          try {
            if (items) cfg = Object.assign({}, DEFAULTS, items);
            cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
            cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
            buildMatchers();
            if (done) done();
          } catch (e) { if (done) done(); }
        });
      } else { buildMatchers(); if (done) done(); }
    } catch (e) { buildMatchers(); if (done) done(); }
  }

  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        // "sync" is the normal store; "local" is used when sync storage is
        // unavailable in a managed browser.
        if (area !== 'sync' && area !== 'local') return;
        var langChanged = false, rebuild = false, phrasesChanged = false;
        for (var key in changes) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
            cfg[key] = changes[key].newValue;
            if (key === 'lang') { langChanged = true; rebuild = true; }
            else if (key !== 'dist' && key !== 'smooth' && key !== 'speed' && key !== 'showHud' && key !== 'sound') {
              rebuild = true;
              phrasesChanged = true;
            }
          }
        }
        cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
        cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
        // The speech language selects the locale pack (English / हिन्दी), so
        // the matcher MUST be rebuilt when it changes — otherwise the Hindi
        // phrases stay inactive until the page is reloaded.
        if (rebuild) buildMatchers();
        if (langChanged) {
          activeLang = cfg.lang || 'en-US';
          langFallbackTried = false;
          if (active) restartRecognizer(300);
        }
        else if (phrasesChanged && active && cfg.showHud !== false && isTop) {
          // Only the command phrases are worth a notice — a speed change
          // would otherwise overwrite the "Faster" message of the very
          // command that caused it.
          showHud('Commands updated', 'std', '');
        }
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
      return matcher ? matcher.parseModifier(raw, cmd) : { mult: 1, edge: null, page: false };
    } catch (e) { return { mult: 1, edge: null, page: false }; }
  }

  /* ================= precision scroller ================= */
  // PDF probes hit the DOM on every auto-scroll frame; cache the scan result
  // briefly (invalidated when the element leaves the document).
  var pdfScanCache = { r: null, at: 0 };
  function pdfElement() {
    var now = Date.now();
    if (now - pdfScanCache.at < 400) {
      var c = pdfScanCache.r;
      if (!c || (c.el && c.el.isConnected)) return c;
      pdfScanCache.r = null;
    }
    var r = pdfElementScan();
    pdfScanCache.r = r;
    pdfScanCache.at = now;
    return r;
  }

  function pdfElementScan() {
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
      // path every frame on container-scroll pages, so reuse a fresh result.
      var cached = innerScanCache.el;
      var age = Date.now() - innerScanCache.at;
      if (cached) {
        if (cached.isConnected && age < 2000 && isScrollable(cached)) return cached;
      } else if (age < 800) {
        // A recent miss is cached too: pages without an inner container would
        // otherwise be re-scanned on every single tick.
        return null;
      }
      var all = document.querySelectorAll('main, section, article, div[role="main"], div[role="feed"], div');
      var best = null, bestH = 0;
      // The scan reads layout for every candidate, so it is capped: on very
      // heavy pages the point-probe above is the one that usually wins.
      var limit = Math.min(all.length, 2000);
      for (var j = 0; j < limit; j++) {
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
    if (pdf) return { pdf: pdf, isPdf: true, isWin: false, el: pdf.el, winScrollable: false, hasFrames: hasChildFrames() };

    var docEl = document.documentElement;
    var body = document.body;
    var winScrollable = !!(docEl && docEl.scrollHeight > window.innerHeight + 8) ||
                        !!(body && body.scrollHeight > window.innerHeight + 8);
    var frames = hasChildFrames();

    if (winScrollable) {
      return { el: null, isWin: true, isPdf: false, winScrollable: true, hasFrames: frames };
    }

    var inner = innerScrollTarget();
    if (inner) {
      return { el: inner, isWin: false, isPdf: false, winScrollable: false, hasFrames: frames };
    }

    return { el: null, isWin: true, isPdf: false, winScrollable: false, hasFrames: frames };
  }

  function hasChildFrames() {
    try { return !!(window.frames && window.frames.length); } catch (e) { return false; }
  }

  function cancelAnim() {
    animId++;
    // A hard cancel: the glide stops where it is (it is not snapped to the
    // end — that is what finishAnim is for).
    activeAnim = null;
  }

  // Scroll the window by an exact amount. `window.scrollBy()` obeys a CSS
  // `scroll-behavior: smooth` rule, which would make the page lag behind
  // (or fight the browser's own animation) — the explicit "instant" behavior
  // overrides it.
  function scrollWindowBy(dy) {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    try {
      window.scrollTo({ top: y + dy, left: window.scrollX || 0, behavior: 'instant' });
    } catch (e) {
      try { window.scrollTo(0, y + dy); } catch (e2) {}
    }
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  // Same for a scrollable container — `scrollTop =` also animates on
  // elements with `scroll-behavior: smooth`.
  function scrollElementBy(el, dy) {
    if (!el) return 0;
    var y = el.scrollTop || 0;
    try {
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: y + dy, behavior: 'instant' });
      else el.scrollTop = y + dy;
    } catch (e) {
      try { el.scrollTop = y + dy; } catch (e2) {}
    }
    return el.scrollTop || 0;
  }

  // Cancellable precision scroller with CSS smooth-behavior override.
  // The running animation is remembered so that a new command can finish it
  // instantly: without that, two quick commands ("down down") would cut the
  // first movement short and the page would move less than asked.
  var activeAnim = null;

  function applyScrollTo(el, isWin, y) {
    if (el && !isWin) {
      try {
        if (typeof el.scrollTo === 'function') el.scrollTo({ top: y, behavior: 'instant' });
        else el.scrollTop = y;
      } catch (e) { try { el.scrollTop = y; } catch (e2) {} }
    } else {
      try {
        // Explicit 'instant' behavior prevents CSS `scroll-behavior: smooth` interference!
        window.scrollTo({ top: y, left: window.scrollX || 0, behavior: 'instant' });
      } catch (e) {
        try { window.scrollTo(0, y); } catch (e2) {}
      }
    }
  }

  // Snap a running animation to its end position (no movement is lost).
  function finishAnim() {
    if (!activeAnim) return;
    var a = activeAnim;
    activeAnim = null;
    try { applyScrollTo(a.el, a.isWin, a.endY); } catch (e) {}
  }

  function animateOn(el, isWin, delta, done) {
    // A command that arrives while another one is still gliding gets the
    // finished movement first, then starts from there.
    finishAnim();
    var my = ++animId;
    // Short and punchy: the movement must feel like a direct answer to the
    // command. The cubic ease-out front-loads the travel, so most of the
    // distance is covered in the first frames.
    var dur = clampNum(90 + Math.abs(delta) * 0.16, 90, 240);
    var getY = function () {
      if (el && !isWin) return el.scrollTop;
      return window.scrollY || document.documentElement.scrollTop || 0;
    };
    var startY = getY(), t0 = 0;

    // Silky cubic ease-out for immediate initial acceleration and natural deceleration
    function ease(k) { return 1 - Math.pow(1 - k, 3); }

    function applyScroll(y) {
      applyScrollTo(el, isWin, y);
    }

    if (!cfg.smooth || Math.abs(delta) < 2) {
      applyScroll(startY + delta);
      if (done) done();
      return;
    }

    activeAnim = { el: el, isWin: isWin, endY: startY + delta };

    function frame(ts) {
      if (my !== animId) return; // cancelled by newer command
      try {
        if (!t0) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur);
        var y = startY + delta * ease(k);
        applyScroll(y);
        if (k >= 1) {
          if (activeAnim && activeAnim.endY === startY + delta) activeAnim = null;
          if (done) done();
          return;
        }
      } catch (e) {
        // Never let an exception break the animation chain — a dead rAF loop
        // would freeze the scroller for the rest of the session.
        try { if (done) done(); } catch (e2) {}
        return;
      }
      requestAnimationFrame(frame);
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
    // Safety net: a request that is never answered must not block every
    // later debugger scroll.
    var guard = setTimeout(function () { finish(false); }, 600);
    try {
      var p = chrome.runtime.sendMessage({ cmd: 'VS_PDFFB', kind: payload.kind || 'wheel', delta: payload.delta || 0, key: payload.key || '' });
      if (p && typeof p.then === 'function') {
        p.then(function (r) { clearTimeout(guard); finish(!!(r && r.ok)); })
         .catch(function () { clearTimeout(guard); finish(false); });
      } else {
        clearTimeout(guard);
        setTimeout(function () { finish(false); }, 400);
      }
    } catch (e) { clearTimeout(guard); finish(false); }
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

  /* ================= scroll target chain ================= */
  // A scroll command must never silently do nothing. Every candidate target
  // is tried in turn and the next one is only used when the previous one
  // really did not move the page:
  //   win   → the document itself
  //   inner → a scrollable container inside the page
  //   frame → a child frame (Google Docs, Figma, embedded viewers)
  //   rel   → trusted input through the browser (the last resort)
  function scrollChain(cmd, delta, mult, order, index) {
    index = index || 0;
    if (index >= order.length) {
      // Nothing moved anywhere: tell the user instead of doing nothing.
      requestDebuggerScroll({ kind: 'wheel', delta: delta });
      if (isTop) showHud('Nothing to scroll here', 'idle', 'this page has no scrollable area');
      return;
    }
    var kind = order[index];

    if (kind === 'win') {
      var y0 = window.scrollY || document.documentElement.scrollTop || 0;
      animateOn(null, true, delta, function () {
        var y1 = window.scrollY || document.documentElement.scrollTop || 0;
        if (Math.abs(y1 - y0) >= 2) return; // it moved
        scrollChain(cmd, delta, mult, order, index + 1);
      });
      return;
    }

    if (kind === 'inner') {
      var inner = innerScrollTarget();
      if (inner) {
        var i0 = inner.scrollTop || 0;
        var amt = (cmd === 'pd' || cmd === 'pu')
          ? Math.round(inner.clientHeight * 0.9 * (mult && mult !== 1 ? mult : 1))
          : delta;
        animateOn(inner, false, amt, function () {
          if (Math.abs((inner.scrollTop || 0) - i0) >= 2) return; // it moved
          scrollChain(cmd, delta, mult, order, index + 1);
        });
        return;
      }
      scrollChain(cmd, delta, mult, order, index + 1);
      return;
    }

    if (kind === 'frame') {
      // The content may live in a child frame (cross-origin docs, embedded
      // viewers) — offer the scroll to every child frame.
      crossFrameScroll(cmd, delta, mult);
      return;
    }

    // 'rel' — trusted input through the browser's own input pipeline.
    requestDebuggerScroll({ kind: 'wheel', delta: delta });
  }

  function doScroll(cmd, mult, edge, usePage) {
    stopAuto(true);
    // Finish a running glide instead of cutting it: two quick commands must
    // move the full amount, not the remainder of an interrupted animation.
    finishAnim();
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
    pushUndo({ kind: 'step', delta: delta, cmd: cmd });

    if (t.isPdf) {
      scrollPdf(t.pdf, delta);
      return;
    }

    if (t.el && !t.isWin) {
      // An inner scrollable container — but it may be stuck, so keep the
      // window and the frames in the chain.
      scrollChain(cmd, delta, mult, ['inner', 'win', 'frame', 'rel']);
      return;
    }

    // The document itself. If the document cannot scroll at all (the whole
    // app lives in a frame) the frame is tried first — that saves a full
    // animation round trip on every single command.
    var order = (!t.winScrollable && t.hasFrames) ? ['frame', 'win', 'inner', 'rel']
                                                  : ['win', 'inner', 'frame', 'rel'];
    scrollChain(cmd, delta, mult, order);
  }

  /* ================= cross-frame scroll bridge ================= */
  // The bridge is a postMessage channel between our own frames. A random web
  // page could post a forged message, so every payload carries a random
  // token that only the extension knows (it is handed down to the child
  // frames through the same channel).
  var bridgeSeq = 0;
  var bridgeAcked = false;
  var bridgeToken = randomToken();

  function randomToken() {
    try {
      var a = new Uint32Array(4);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (n) {
        return ('0000000' + n.toString(16)).slice(-8);
      }).join('');
    } catch (e) {
      return String(Date.now()) + '-' + String(Math.random()).slice(2);
    }
  }

  function bridgePayload(delta, seq) {
    return { __vsBridge: 'scroll', delta: delta, seq: seq, token: bridgeToken };
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
    // Make sure every child knows the current token before the scroll.
    sendBridgeHello();
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


  /* ================= undo ================= */
  // A correction gesture the OS voice controls do not have: say "undo" and
  // the last scroll (or the last jump to an edge) is taken back.
  var undoStack = [];

  function pushUndo(entry) {
    try {
      undoStack.push(entry);
      if (undoStack.length > 12) undoStack.shift();
    } catch (e) {}
  }

  function doUndo() {
    var u = null;
    try { u = undoStack.pop(); } catch (e) { u = null; }
    if (!u) {
      if (isTop) showHud('Nothing to undo', 'idle', '');
      return false;
    }
    stopAuto(true);
    cancelAnim();
    try {
      if (u.kind === 'jump') {
        var el = u.el && u.el.isConnected ? u.el : null;
        var cur = el ? (el.scrollTop || 0) : (window.scrollY || 0);
        animateOn(el, !el, u.from - cur, null);
      } else {
        var t = resolveTarget();
        if (t.isPdf) {
          scrollPdf(t.pdf, -u.delta);
        } else if (t.el && !t.isWin) {
          animateOn(t.el, false, -u.delta, null);
        } else {
          animateOn(null, true, -u.delta, null);
        }
      }
    } catch (e) {}
    playEarcon('cmd');
    if (isTop) showHud('Undone', 'success', u.kind === 'jump' ? 'back to the previous place' : 'back one step');
    return true;
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
      pushUndo({ kind: 'jump', el: targetEl, from: targetEl.scrollTop || 0 });
      animateOn(targetEl, false, targetY - targetEl.scrollTop, null);
      return;
    }

    if (!cfg.smooth) {
      var y = which === 'top' ? 0 : (document.documentElement.scrollHeight || document.body.scrollHeight);
      pushUndo({ kind: 'jump', el: null, from: window.scrollY || 0 });
      try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
      return;
    }

    var totalH = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    var target = which === 'top' ? 0 : Math.max(0, totalH - window.innerHeight);
    var start = window.scrollY || 0;
    pushUndo({ kind: 'jump', el: null, from: start });
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
  // Frame-locked auto-scroll: time-based velocity on requestAnimationFrame
  // instead of fixed 45 ms interval jumps, so the glide is silky at any
  // refresh rate (60/120/144 Hz). Speed 40 ≈ 800 px/s.
  function autoStepFor(dtMs) {
    // Never smaller than a pixel per frame — a step that rounds to zero
    // would make the page look frozen.
    return Math.max(1, cfg.speed * 20 * (dtMs || 45) / 1000);
  }

  // Is the given target really at the end of its content? Used before the
  // auto-scroll gives up, so a too-small step is not mistaken for the end.
  function atScrollEdge(dir, el) {
    try {
      if (el) {
        var max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
        var pos = el.scrollTop || 0;
        return dir > 0 ? (pos >= max - 2) : (pos <= 2);
      }
      var docH = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      var maxW = Math.max(0, docH - window.innerHeight);
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      return dir > 0 ? (y >= maxW - 2) : (y <= 2);
    } catch (e) { return false; }
  }

  function startAuto(dir) {
    stopAuto(true);
    autoDir = dir;
    cancelAnim();
    autoStall = 0;
    autoStallClock = 0;
    autoNoMove = 0;
    autoLastTs = 0;
    playEarcon('cmd');
    autoTimer = requestAnimationFrame(autoFrame);
    if (isTop) showHud(autoDir > 0 ? 'Auto-scroll down' : 'Auto-scroll up', 'success', 'say "stop" · "faster" · "slower"');
  }

  function autoFrame(ts) {
    if (!autoDir) { autoTimer = null; return; }
    try {
      if (autoLastTs) autoTick(Math.min(120, ts - autoLastTs));
    } catch (e) {
      // The auto-scroll loop must survive any error inside the tick.
    }
    autoLastTs = ts;
    // Always reschedule — otherwise one exception would end the glide for
    // good and the page would look frozen.
    try { autoTimer = requestAnimationFrame(autoFrame); }
    catch (e) { autoTimer = null; }
  }

  function autoTick(dtMs) {
    var step = autoStepFor(dtMs);
    var t = resolveTarget();
    if (t.isPdf) {
      scrollPdf(t.pdf, autoDir * Math.max(1, Math.round(step)));
      return;
    }
    if (t.el && !t.isWin) {
      var e0 = t.el.scrollTop || 0;
      var e1 = scrollElementBy(t.el, autoDir * step);
      if (Math.abs(e1 - e0) < 1) autoNoMove += (dtMs || 45);
      else autoNoMove = 0;
      if (autoNoMove > 1500 && atScrollEdge(autoDir, t.el)) autoEndReached();
      return;
    }
    var y0 = window.scrollY || document.documentElement.scrollTop || 0;
    var y1 = scrollWindowBy(autoDir * step);
    if (Math.abs(y1 - y0) < 1) {
      // Nothing moved: the window is not the scroller, or we reached the edge.
      autoNoMove += (dtMs || 45);
      // Try the inner container, then child frames, then the debugger relay so
      // auto-scroll also works on embedded viewers.
      // Stall checks are throttled to ~8x/s so fallbacks don't thrash per frame.
      autoStallClock += dtMs || 45;
      if (autoStallClock < 120) return;
      autoStallClock = 0;
      autoStall++;
      if (autoStall % 3 === 1) {
        var inner = innerScrollTarget();
        if (inner) {
          var i0 = inner.scrollTop || 0;
          var i1 = scrollElementBy(inner, autoDir * step);
          // Only bail out when the inner container really moved — a stuck
          // inner container must not block the frame / debugger fallbacks.
          if (Math.abs(i1 - i0) >= 1) { autoNoMove = 0; return; }
        }
      }
      var kids = 0;
      try { kids = window.frames ? window.frames.length : 0; } catch (e) { kids = 0; }
      if (kids && isTop) {
        // Primary: offer each child frame the scroll via the postMessage bridge.
        var delta = autoDir * Math.max(1, Math.round(step));
        var seq = ++bridgeSeq;
        bridgeAcked = false;
        sendBridgeHello();
        try {
          var payload = bridgePayload(delta, seq);
          for (var i = 0; i < kids; i++) window.frames[i].postMessage(payload, '*');
        } catch (e) {}
        if (autoStall >= 6) {
          // Secondary: if the bridge stays silent, escalate to trusted input.
          autoStall = 3;
          setTimeout(function () {
            if (seq === bridgeSeq && !bridgeAcked) {
              requestDebuggerScroll({ kind: 'wheel', delta: delta });
            }
          }, 160);
        }
      } else if (isTop && autoStall >= 3) {
        autoStall = 0;
        requestDebuggerScroll({ kind: 'wheel', delta: autoDir * Math.max(1, Math.round(step)) });
      }
      // Nothing responded for a while: only give up when the target really is
      // at the end of its content.
      if (autoNoMove > 1500 && atScrollEdge(autoDir, null)) autoEndReached();
    } else {
      autoStall = 0;
      autoStallClock = 0;
      autoNoMove = 0;
    }
  }

  // Auto-scroll ran into the edge of the document: stop instead of grinding
  // against it forever.
  function autoEndReached() {
    var dir = autoDir;
    stopAuto(true);
    playEarcon('stop');
    if (isTop) {
      showHud(dir > 0 ? 'End of page' : 'Top of page', 'idle',
        dir > 0 ? 'say "up" to go back' : 'say "down" to continue');
    }
  }

  function stopAuto(silent) {
    if (autoTimer) {
      cancelAnimationFrame(autoTimer);
      autoTimer = null;
    }
    autoDir = 0;
    autoStall = 0;
    autoStallClock = 0;
    if (!silent) cancelAnim();
  }

  function setSpeed(next) {
    cfg.speed = clampNum(next, 1, 100);
    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        VSCore.storageSet({ speed: cfg.speed });
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
    if (active) return false;
    if (!speechCtor()) {
      lastError = 'speech-api-missing';
      if (isTop) showHud('Speech API unavailable', 'err', 'use a current Chrome or Edge');
      return false;
    }
    manualStop = false;
    sleeping = false;
    lastError = '';
    restartCount = 0;
    restartBurst = 0;
    startRetries = 0;
    restartWindowStart = Date.now();
    if (!engine) buildEngine();
    if (engine) engine.reset();
    if (!activeLang) activeLang = cfg.lang || 'en-US';
    createAndStart();
    return true;
  }

  function createAndStart() {
    var SR = speechCtor();
    if (!SR) {
      active = false;
      lastError = 'speech-api-missing';
      if (isTop) showHud('Speech API unavailable', 'err', 'use a current Chrome or Edge');
      return;
    }
    // Invalidate the previous instance BEFORE aborting it. Aborting a live
    // recognizer makes the browser fire one more "end" event; if that event
    // were still handled it would schedule yet another restart — an endless
    // restart loop in which the extension keeps listening but never hears a
    // complete command ("works for a second, then gets stuck").
    var old = rec;
    rec = null;
    if (old) { try { old.abort(); } catch (e) {} }
    // A fresh recognizer restarts result indices at 0; stale dedup entries from
    // the previous instance would suppress new commands, so drop them.
    if (!engine) buildEngine();
    if (engine) engine.reset();

    var myRec = new SR();
    rec = myRec;
    myRec.continuous = true;
    myRec.interimResults = true;
    myRec.lang = activeLang || cfg.lang || 'en-US';
    try { myRec.maxAlternatives = 3; } catch (e) { try { myRec.maxAlternatives = 1; } catch (e2) {} }

    myRec.onstart = function () {
      if (rec !== myRec) return; // stale instance — a newer one took over
      try {
        active = true;
        recAlive = true;
        restartCount = 0;
        startRetries = 0;
        recStartTs = Date.now();
        lastError = '';
        notifyState(true);
        playEarcon('start');
        if (isTop) showHud('Listening', 'live', 'say "down" · "up" · "page down"');
      } catch (e) {}
    };

    myRec.onresult = function (e) {
      if (rec !== myRec) return; // stale instance
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

        // The speech service fires interim results many times per second;
        // repainting the HUD for each one wastes layout work on busy pages.
        if (interim && isTop && Date.now() - lastHudPaint > 120) {
          lastHudPaint = Date.now();
          lastHeard = interim;
          showHud(interim, sleeping ? 'sleep' : 'live', sleeping ? 'paused — say "wake up"' : '…');
        }
      } catch (err) {}
    };

    myRec.onerror = function (e) {
      if (rec !== myRec) return; // stale instance
      try { handleRecognizerError(e); } catch (err) {}
    };

    function handleRecognizerError(e) {
      var err = (e && e.error) || '';
      // "aborted" (our own restart/stop) and "no-speech" (just silence) are
      // not failures — only real problems are reported to the popup.
      if (err && err !== 'aborted' && err !== 'no-speech') lastError = err;
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
      } else if (err === 'network') {
        // Transient network trouble: keep the badge honest but let the
        // recognizer's own "end" event schedule a retry with backoff.
        lastError = 'network';
        if (isTop) showHud('Network hiccup', 'idle', 'retrying…');
      }
    }

    myRec.onend = function () {
      if (rec !== myRec) return; // stale instance — must not restart anything
      try { handleRecognizerEnd(); } catch (e) {}
    };

    function handleRecognizerEnd() {
      recAlive = false;
      if (!active || manualStop) {
        notifyState(false);
        return;
      }
      var now = Date.now();
      // A session that lived a normal amount of time simply ended (silence
      // timeout); only a session that died immediately counts as a failure.
      var lived = recStartTs ? (now - recStartTs) : 99999;
      if (lived < 1500) restartBurst++; else restartBurst = 0;
      if (restartBurst > 6) {
        // The speech service keeps dropping the session: stop cleanly with a
        // clear message instead of restarting forever.
        active = false; manualStop = true;
        lastError = 'unstable';
        notifyState(false);
        if (isTop) showHud('Speech service unstable', 'err', 'the browser keeps dropping recognition — press Enable to retry');
        try { if (rec) rec.abort(); } catch (ee) {}
        return;
      }
      if (now - restartWindowStart > 10000) { restartWindowStart = now; restartCount = 0; }
      restartCount++;
      // Restart quickly: every millisecond of silence is a millisecond in
      // which a spoken command cannot be heard.
      var delay = Math.min(150 * restartCount, 2200);
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function () {
        restartTimer = null;
        if (active && !manualStop) {
          // Always instantiate a fresh recognizer instance to prevent InvalidStateError on ended instances
          createAndStart();
        }
      }, delay);
    }

    try {
      myRec.start();
    } catch (e) {
      // The speech service is sometimes still winding down (a session that
      // just ended, a busy device). Retry a few times before giving up —
      // dying here is what makes an extension feel unreliable.
      // NOTE: `active` is still false at this point (onstart never ran), so
      // the retry is bound to the user's intent, not to `active`.
      if (startRetries < 3 && !manualStop) {
        startRetries++;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function () {
          restartTimer = null;
          if (!manualStop) createAndStart();
        }, 180 * startRetries);
        return;
      }
      active = false;
      lastError = 'start-failed';
      notifyState(false);
      if (isTop) showHud('Could not start mic', 'err', 'grant permission and retry');
    }
  }

  // Restart the recognizer (language change, service fallback). The old
  // instance is invalidated inside createAndStart, so its "end" event can
  // never schedule another restart.
  function restartRecognizer(delay) {
    if (!active) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      if (!active) return;
      createAndStart();
    }, delay || 300);
  }

  /* ================= shared speech engine (vs-core) ================= */
  // The engine owns segment deduplication, the interim settling window and
  // incremental upgrades. It is shared with the voice hub so a command behaves
  // identically on web pages and on native PDFs.
  function buildEngine() {
    try {
      engine = VSCore.createEngine({
        match: parseCommand,
        mod: parseModifier,
        settleMs: 60,
        maxWaitMs: 120,
        onExec: execAction,
        onMiss: function (text, conf) {
          lastHeard = text || '';
          lastConfidence = conf || 0;
          lastMatched = '';
          if (!isTop) return;
          // A bare number runs the matching tile of the open command grid.
          if (gridNumber(text)) { missStreak = 0; return; }
          // Otherwise offer the closest command ("did you mean …") instead of
          // leaving the user in silence. The hint is only shown for the first
          // miss of a row — a chatty room should not spam the indicator.
          var hint = '';
          try {
            if (matcher && matcher.suggest) {
              var s = matcher.suggest(text);
              if (s && s.phrase) hint = 'did you mean “' + s.phrase + '”?';
            }
          } catch (e) {}
          if (sleeping) { showHud(text || '', 'sleep', 'paused — say "wake up"'); missStreak = 0; return; }
          missStreak++;
          if (missStreak > 1) return;
          showHud(text || '', 'idle', hint || 'no command — try "down"');
        }
      });
    } catch (e) { engine = null; }
  }

  // Runs the action the engine decided on.
  function execAction(a) {
    if (!a) return;
    lastHeard = a.text || lastHeard;
    lastConfidence = a.conf || 0;
    if (a.type === 'upgrade') {
      // The utterance grew ("down" -> "down three"): scroll only the rest.
      lastCmdTime = Date.now();
      lastTranscript = a.cmd + '|' + normalize(a.text);
      lastMatched = a.cmd;
      playEarcon('cmd');
      gridHighlight(a.cmd);
      if (a.edge) {
        doScroll(a.cmd, 0, a.edge, false);
      } else {
        var usePage = !!a.page && a.cmd !== 'pd' && a.cmd !== 'pu';
        doScroll(a.cmd, a.delta, null, usePage);
      }
      if (isTop) {
        var ul = { dn: 'Down ×' + a.mod.mult, up: 'Up ×' + a.mod.mult,
                   pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' };
        showHud(ul[a.cmd] || a.cmd, 'success', fmtConf(lastConfidence));
      }
      return;
    }
    handleCommand(a.cmd, a.text, a.conf);
    missStreak = 0;
    gridHighlight(a.cmd);
  }

  // Zero-latency speech processor: interim settling debounce, segment
  // deduplication and final-transcript authority (a final command is never
  // swallowed by an earlier interim guess).
  function handleSpeechCandidates(cands, isFinal, segmentIdx) {
    if (!engine) buildEngine();
    if (!engine) return;
    engine.handle(cands || [], !!isFinal, segmentIdx);
  }

  function handleCommand(cmd, raw, conf) {
    var now = Date.now();
    var dupKey = cmd + '|' + normalize(raw);

    // Echo guard: only a 50 ms window, which is below the shortest possible
    // gap between two spoken words. The per-segment deduplication in the
    // shared engine already removes interim/final double fires, so a longer
    // window would only swallow legitimate quick commands ("down down").
    if (dupKey === lastTranscript && (now - lastCmdTime < 50) && cmd !== 'stop') return;

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

    if (cmd === 'help') {
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      showCommandGrid();
      return;
    }

    if (cmd === 'undo') {
      lastCmdTime = now;
      lastTranscript = dupKey;
      lastMatched = cmd;
      doUndo();
      return;
    }

    var keep = VSCore.isKeep(raw);
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
    'font-size:13px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);transition:background .2s,border-color .2s;',
    'pointer-events:auto;cursor:pointer;}',
    '.vs-hud .vs-orb:hover{background:rgba(255,255,255,.16);}',
    '.vs-orb span{display:flex;align-items:center;justify-content:center;}',
    '.vs-hud.vs-live .vs-orb{background:rgba(227,25,55,.15);border-color:rgba(227,25,55,.42);}',
    '.vs-hud.vs-err .vs-orb{background:rgba(255,82,82,.13);border-color:rgba(255,82,82,.38);}',
    '.vs-hud.vs-sleep .vs-orb{background:rgba(232,201,138,.12);border-color:rgba(232,201,138,.38);}',
    '.vs-main{display:flex;flex-direction:column;line-height:1.3;min-width:0;}',
    '.vs-text{font-size:13px;font-weight:600;letter-spacing:.01em;color:#f4f4f2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54vw;}',
    '.vs-sub{font-size:11px;font-weight:400;color:rgba(244,244,242,.52);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54vw;margin-top:1px;}',
    '.vs-conf{width:56px;height:2px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;flex-shrink:0;}',
    '.vs-conf i{display:block;height:100%;width:0;border-radius:99px;background:#e31937;box-shadow:0 0 8px rgba(227,25,55,.7);transition:width .25s;}',
    '.vs-help{position:fixed;bottom:96px;left:50%;transform:translateX(-50%) translateY(8px);',
    'background:rgba(8,9,11,.92);border:1px solid rgba(255,255,255,.12);border-radius:14px;',
    'padding:14px 20px 12px;z-index:2147483647;color:#f4f4f2;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Roboto,sans-serif;',
    'backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);',
    'box-shadow:0 18px 50px -12px rgba(0,0,0,.6);pointer-events:auto;cursor:default;',
    'opacity:0;transition:opacity .18s,transform .18s;min-width:290px;max-width:min(88vw,460px);box-sizing:border-box;}',
    '.vs-help.vs-show{opacity:1;transform:translateX(-50%) translateY(0);}',
    '.vs-help h4{margin:0 0 8px;font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:rgba(244,244,242,.5);}',
    '.vs-help .r{display:flex;gap:12px;font-size:12px;line-height:1.9;align-items:baseline;}',
    '.vs-help .r b{color:#ff8fa0;font-weight:600;min-width:170px;white-space:nowrap;}',
    '.vs-help .r span{color:rgba(244,244,242,.85);}',
    // ---- command grid (Apple/Google Voice-Control style) ----
    '.vs-grid{position:fixed;inset:0;z-index:2147483640;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Roboto,sans-serif;',
    'pointer-events:none;opacity:0;transition:opacity .18s;}',
    '.vs-grid.vs-show{opacity:1;}',
    '.vs-grid-h{color:#f4f4f2;font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;',
    'background:rgba(8,9,11,.9);border:1px solid rgba(255,255,255,.12);padding:10px 20px;border-radius:12px;',
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);pointer-events:auto;}',
    '.vs-grid-b{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;',
    'width:min(94vw,720px);pointer-events:auto;}',
    '.vs-tile{position:relative;display:flex;flex-direction:column;gap:3px;text-align:left;',
    'background:rgba(14,16,19,.92);border:1px solid rgba(255,255,255,.12);border-radius:14px;',
    'padding:12px 13px 11px 40px;color:#f4f4f2;font-family:inherit;cursor:pointer;',
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
    'transition:border-color .15s,background .15s,transform .15s;}',
    '.vs-tile:hover{border-color:rgba(227,25,55,.5);transform:translateY(-1px);}',
    '.vs-tile:focus-visible{outline:2px solid #e31937;outline-offset:2px;}',
    '.vs-tile-n{position:absolute;left:12px;top:12px;width:20px;height:20px;border-radius:6px;',
    'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:rgba(244,244,242,.7);',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;',
    'display:flex;align-items:center;justify-content:center;}',
    '.vs-tile-l{font-size:13px;font-weight:600;line-height:1.25;}',
    '.vs-tile-p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#ff8fa0;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.vs-tile-a{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;',
    'color:rgba(244,244,242,.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.vs-tile.vs-on{border-color:#e31937;background:rgba(227,25,55,.16);',
    'box-shadow:0 0 0 1px rgba(227,25,55,.3),0 10px 30px -10px rgba(227,25,55,.5);transform:scale(1.03);}',
    '.vs-grid-hint{color:rgba(244,244,242,.55);font-size:10.5px;letter-spacing:.04em;',
    'background:rgba(8,9,11,.8);border:1px solid rgba(255,255,255,.1);padding:7px 14px;border-radius:99px;',
    'pointer-events:auto;}'
  ].join('');

  /* ================= command grid ================= */
  // Inspired by the OS voice controls (Apple Voice Control, Google Voice
  // Access, Windows Voice Access): a visible grid of everything you can
  // say. It teaches the vocabulary, highlights what was understood and lets
  // you run a command by saying its number.
  var gridEl = null, gridTimer = null, gridItems = [];

  var GRID_ACTIONS = {
    dn: { raw: 'down' }, up: { raw: 'up' }, pd: { raw: 'page down' },
    pu: { raw: 'page up' }, top: { raw: 'top' }, bot: { raw: 'bottom' },
    faster: { raw: 'faster' }, slower: { raw: 'slower' }, undo: { raw: 'undo' },
    stop: { raw: 'stop' }, sleep: { raw: 'sleep' }, wake: { raw: 'wake up' },
    help: { raw: 'help' }
  };

  function gridPhrase(cmd) {
    var key = VSCore.CMD_KEYS[cmd];
    var list = String((key && cfg[key]) || '').split(',');
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i]).trim();
      if (t) return t;
    }
    return cmd;
  }

  function showCommandGrid() {
    if (!isTop) return;
    if (gridEl) { closeCommandGrid(); return; } // say/click help again to dismiss
    try {
      var host = document.body || document.documentElement;
      if (!host) return;
      var items = VSCore.commandList(cfg);
      gridItems = [];
      gridEl = document.createElement('div');
      gridEl.className = 'vs-grid';
      gridEl.setAttribute('data-voicescroll', '1');
      gridEl.setAttribute('role', 'dialog');
      gridEl.setAttribute('aria-label', 'VoiceScroll command grid');

      var head = document.createElement('div');
      head.className = 'vs-grid-h';
      head.textContent = 'VoiceScroll — say a command';
      gridEl.appendChild(head);

      var wrap = document.createElement('div');
      wrap.className = 'vs-grid-b';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'vs-tile';
        tile.setAttribute('data-cmd', it.cmd);
        tile.title = 'Say "' + it.phrase + '"';

        var num = document.createElement('span');
        num.className = 'vs-tile-n';
        num.textContent = i < 9 ? String(i + 1) : '·';
        var lab = document.createElement('span');
        lab.className = 'vs-tile-l';
        lab.textContent = it.label;
        var ph = document.createElement('span');
        ph.className = 'vs-tile-p';
        ph.textContent = '“' + it.phrase + '”';
        tile.appendChild(num);
        tile.appendChild(lab);
        tile.appendChild(ph);
        if (it.alt) {
          var alt = document.createElement('span');
          alt.className = 'vs-tile-a';
          alt.textContent = it.alt;
          tile.appendChild(alt);
        }
        (function (cmd, phrase) {
          tile.addEventListener('click', function (e) {
            try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
            runGridCommand(cmd, phrase);
          });
        })(it.cmd, it.phrase);
        wrap.appendChild(tile);
        gridItems.push({ cmd: it.cmd, phrase: it.phrase, tile: tile });
      }
      gridEl.appendChild(wrap);

      var hint = document.createElement('div');
      hint.className = 'vs-grid-hint';
      hint.textContent = 'say 1–9 to run · click a tile · Esc or click outside to close';
      gridEl.appendChild(hint);

      gridEl.addEventListener('click', function (e) {
        if (e.target === gridEl) closeCommandGrid();
      });
      host.appendChild(gridEl);
      requestAnimationFrame(function () { if (gridEl) gridEl.className = 'vs-grid vs-show'; });
      gridTimer = setTimeout(closeCommandGrid, 15000);
      try { document.addEventListener('keydown', gridKeyHandler, true); } catch (e) {}
      // The panel itself is pointer-transparent, so a click on the page has
      // to be caught on the document to close the grid.
      try { document.addEventListener('click', gridOutsideClick, false); } catch (e) {}
      playEarcon('cmd');
    } catch (e) {}
  }

  function gridOutsideClick(e) {
    if (!gridEl) return;
    try {
      if (gridEl.contains && gridEl.contains(e.target)) return;
    } catch (err) {}
    closeCommandGrid();
  }

  function closeCommandGrid() {
    try { clearTimeout(gridTimer); } catch (e) {}
    gridTimer = null;
    try { document.removeEventListener('keydown', gridKeyHandler, true); } catch (e) {}
    try { document.removeEventListener('click', gridOutsideClick, false); } catch (e) {}
    try { if (gridEl && gridEl.parentNode) gridEl.parentNode.removeChild(gridEl); } catch (e) {}
    gridEl = null;
    gridItems = [];
  }

  function gridKeyHandler(e) {
    if (!gridEl) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCommandGrid(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      var active = document.activeElement;
      if (active && active.className && active.className.indexOf('vs-tile') >= 0) {
        e.preventDefault();
        try { active.click(); } catch (err) {}
      }
    }
  }

  // Run a command from the grid (by click or by speaking its number).
  function runGridCommand(cmd, phrase) {
    var action = GRID_ACTIONS[cmd];
    var raw = action ? action.raw : phrase;
    if (cmd === 'dn' && /keep scrolling/i.test(raw)) raw = 'keep scrolling down';
    try {
      handleCommand(cmd, raw, 0);
    } catch (e) {}
    gridHighlight(cmd);
  }

  // Flash the tile of the command that was understood.
  function gridHighlight(cmd) {
    if (!gridEl) return;
    try {
      for (var i = 0; i < gridItems.length; i++) {
        if (gridItems[i].cmd !== cmd) continue;
        var tile = gridItems[i].tile;
        tile.className = 'vs-tile vs-on';
        setTimeout(function (t) {
          try { t.className = 'vs-tile'; } catch (e) {}
        }, 420, tile);
      }
    } catch (e) {}
  }

  // While the grid is open a bare number runs the matching tile.
  function gridNumber(text) {
    if (!gridEl || !gridItems.length) return false;
    var t = normalize(text);
    if (!t) return false;
    var n = 0;
    if (/^\d+$/.test(t)) n = parseInt(t, 10);
    else if (VSCore.NUM_WORDS[t]) n = VSCore.NUM_WORDS[t];
    if (!n || n < 1 || n > gridItems.length) return false;
    var item = gridItems[n - 1];
    runGridCommand(item.cmd, item.phrase);
    return true;
  }

  function closeHelp() {
    try { clearTimeout(helpTimer); } catch (e) {}
    helpTimer = null;
    try { if (helpEl && helpEl.parentNode) helpEl.parentNode.removeChild(helpEl); } catch (e) {}
    helpEl = null;
  }

  function showHelpPanel() {
    if (!isTop) return;
    try {
      if (helpEl) { closeHelp(); return; } // say/click again to dismiss
      var host = document.body || document.documentElement;
      if (!host) return;
      var hi = /^hi/i.test(cfg.lang || '');
      helpEl = document.createElement('div');
      helpEl.className = 'vs-help';
      helpEl.setAttribute('data-voicescroll', '1');
      var h = document.createElement('h4');
      h.textContent = hi ? 'बोलें — voice commands' : 'Say — voice commands';
      helpEl.appendChild(h);
      // Rows are built from the phrases the user actually configured, so the
      // cheat sheet always matches the live command set.
      var rows = VSCore.helpRows(cfg);
      for (var i = 0; i < rows.length; i++) {
        var r = document.createElement('div');
        r.className = 'r';
        var b = document.createElement('b');
        b.textContent = '“' + rows[i][0] + '”';
        var s = document.createElement('span');
        s.textContent = rows[i][1];
        r.appendChild(b);
        r.appendChild(s);
        helpEl.appendChild(r);
      }
      var extra = document.createElement('div');
      extra.className = 'r';
      var eb = document.createElement('b');
      eb.textContent = hi ? '“तीन” · “थोड़ा” · “बहुत”' : '“down three” · “a little” · “a lot”';
      var es = document.createElement('span');
      es.textContent = hi ? 'मात्रा बताएं' : 'Quantifiers';
      extra.appendChild(eb);
      extra.appendChild(es);
      helpEl.appendChild(extra);
      helpEl.addEventListener('click', closeHelp);
      host.appendChild(helpEl);
      requestAnimationFrame(function () { if (helpEl) helpEl.className = 'vs-help vs-show'; });
      helpTimer = setTimeout(closeHelp, 8000);
      playEarcon('cmd');
    } catch (e) {}
  }

  function ensureHud() {
    if (!isTop) return null;
    if (hudEl && document.contains(hudEl)) return hudEl;
    try {
      // A page could pre-create an element with our style id to suppress the
      // indicator — the marker attribute makes sure the styles are ours.
      var styleEl = document.getElementById('vs-hud-style');
      if (!styleEl || styleEl.getAttribute('data-voicescroll') !== '1') {
        var st = document.createElement('style');
        st.id = 'vs-hud-style';
        st.setAttribute('data-voicescroll', '1');
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
      hudOrb.title = 'VoiceScroll — click to toggle · Alt+Shift+V';
      hudOrb.addEventListener('click', function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (er) {}
        try {
          var p = chrome.runtime.sendMessage({ cmd: 'VS_BG_TOGGLE' });
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (er) {}
      });
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
      // NOTE: never cancel the scroll animation here — hiding the indicator
      // must not interrupt a scroll that is already in flight.
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
    closeHelp();
    closeCommandGrid();
    notifyState(false);
    clearTimeout(restartTimer);
    if (engine) engine.reset();
    var oldRec = rec;
    rec = null;               // invalidate before aborting: no restart may follow
    if (oldRec) { try { oldRec.abort(); } catch (e) {} }
    lastError = ''; // a deliberate stop is not an error
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

      if (d.__vsBridge === 'hello') {
        // The top frame hands the bridge token down to its children.
        if (window !== window.top && typeof d.token === 'string' && d.token.length >= 8) {
          bridgeToken = d.token;
        }
        return;
      }
      // Only payloads that carry our token are accepted — a page script must
      // not be able to drive the scroller of an embedded frame.
      if (d.token !== bridgeToken) return;

      if (d.__vsBridge === 'scroll') {
        // Child frames: try to honor the scroll locally and report back.
        var delta = Math.round(d.delta || 0);
        if (!delta) return;
        var done = crossFrameApplyScroll(delta);
        try {
          e.source.postMessage({ __vsBridge: 'ack', seq: d.seq, moved: done, token: bridgeToken }, '*');
        } catch (err) {}
        return;
      }
      if (d.__vsBridge === 'ack' && isTop) {
        bridgeAcked = true;
        if (d.moved && autoTimer) autoStall = 3; // let the bridge carry auto-scroll
        return;
      }
    } catch (err) {}
  });

  // Hand the bridge token down to the child frames so they accept (and only
  // accept) our messages. Sent after injection and before every scroll, so a
  // child that loaded later still joins the bridge.
  function sendBridgeHello() {
    if (!isTop) return;
    var kids = 0;
    try { kids = window.frames ? window.frames.length : 0; } catch (e) { kids = 0; }
    if (!kids) return;
    try {
      var payload = { __vsBridge: 'hello', token: bridgeToken };
      for (var i = 0; i < kids; i++) window.frames[i].postMessage(payload, '*');
    } catch (e) {}
  }
  (function shareBridgeToken() {
    if (!isTop) return;
    setTimeout(sendBridgeHello, 300);
    setTimeout(sendBridgeHello, 1500);
    window.addEventListener('load', sendBridgeHello);
  })();

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
      var y1 = scrollWindowBy(delta);
      if (Math.abs(y1 - y0) >= 1) moved = true;
      var inner = innerScrollTarget();
      if (inner) {
        var s0 = inner.scrollTop || 0;
        var s1 = scrollElementBy(inner, delta);
        if (Math.abs(s1 - s0) >= 1) moved = true;
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
        loadCfg(function () { resolve(start()); });
      });
    },
    start: function () {
      return new Promise(function (resolve) {
        loadCfg(function () { resolve(start()); });
      });
    },
    stop: function () { stopAll('api'); return Promise.resolve(false); },
    status: function () { return active; },
    test: function (cmd) {
      loadCfg(function () {
        try {
          if (cmd === 'faster') { setSpeed(cfg.speed + 12); if (!autoTimer) startAuto(1); return; }
          if (cmd === 'slower') { setSpeed(cfg.speed - 12); return; }
          playEarcon('cmd');
          doScroll(cmd, 1, null, false);
          if (isTop) {
            showHud({ dn: 'Down', up: 'Up', pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' }[cmd] || cmd, 'success', 'test scroll');
          }
        } catch (e) {}
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
            var p = window.__vs.toggle();
            if (p && typeof p.then === 'function') {
              p.then(function (on) { sendResponse({ on: on }); },
                     function () { sendResponse({ on: false }); });
            } else {
              sendResponse({ on: false });
            }
            return true;
          }
          if (msg.cmd === 'VS_STATUS') {
            sendResponse({
              on: active,
              sleeping: sleeping,
              heard: lastHeard,
              conf: lastConfidence,
              matched: lastMatched,
              speed: cfg.speed,
              err: lastError
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
              var usePage = !!msg.page && msg.name !== 'pd' && msg.name !== 'pu';
              doScroll(msg.name, msg.mult, null, usePage);
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

  /* ================= lifecycle ================= */
  // Watchdog: the engine may claim to be listening while the recognizer is
  // actually gone (a browser bug, a lost session). If that happens the
  // extension would look alive but never react — so bring it back instead of
  // staying stuck.
  var recAlive = false;
  try {
    setInterval(function () {
      try {
        if (!active || manualStop) return;
        if (recAlive) return;
        if (restartTimer) return;      // a restart is already on its way
        if (!rec) return;
        createAndStart();
      } catch (e) {}
    }, 4000);
  } catch (e) {}

  // A hidden tab must not keep gliding in the background: stop the auto-scroll
  // when the page is hidden and resume it when the user comes back.
  try {
    document.addEventListener('visibilitychange', function () {
      try {
        if (document.hidden) {
          if (autoTimer) {
            stopAuto(true);
            if (isTop) showHud('Paused (tab hidden)', 'idle', 'auto-scroll stopped');
          }
        }
      } catch (e) {}
    });
  } catch (e) {}

  // Free everything when the page goes away.
  try {
    window.addEventListener('pagehide', function () {
      try {
        stopAuto(true);
        cancelAnim();
        closeHelp();
        closeCommandGrid();
        if (engine) engine.stop();
        clearTimeout(restartTimer);
        clearTimeout(hudTimer);
        clearTimeout(helpTimer);
      } catch (e) {}
    });
  } catch (e) {}

  loadCfg(function () { buildMatchers(); });
})();
