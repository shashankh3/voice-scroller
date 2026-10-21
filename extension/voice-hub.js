/* VoiceScroll Ultimate — voice hub engine.
 * Hosts SpeechRecognition + command decoding when the visible page cannot
 * (native PDF viewer tabs are browser-internal pages no content script can
 * enter). Runs either inside an MV3 offscreen document or, as a fallback,
 * in a small extension tab that shares this page.
 * Commands are forwarded to background.js, which drives the focused tab:
 * - scriptable tabs  -> relayed to the in-page content.js engine
 * - native PDFs      -> trusted chrome.debugger wheel / key events
 */
(function () {
  'use strict';
  if (window.__vsHub) return;

  // Settings defaults live in vs-core so every context shares one source.
  var DEFAULTS = VSCore.DEFAULTS;

  var cfg = Object.assign({}, DEFAULTS);
  var matcher = null;
  var engine = null; // shared interim/final speech engine (see vs-core)
  var rec = null;
  var active = false;
  var manualStop = false;
  var sleeping = false;
  var lastCmdTime = 0;
  var lastHeard = '';
  var lastConfidence = 0;
  var lastMatched = '';
  var restartTimer = null;
  var restartCount = 0;
  var restartBurst = 0;          // fast failures inside the current window
  var recStartTs = 0;            // when the running recognizer started
  var restartWindowStart = Date.now();
  var autoTimer = null;
  var autoDir = 0;
  var activeLang = '';
  var langFallbackTried = false;
  var startWatchdog = null;
  var lastError = '';
  var bloqGrantTries = 0;
  var engineWanted = false; // user intent; manualStop alone cannot distinguish stop vs. error

  function ui() {
    return {
      orb: document.getElementById('orb'),
      state: document.getElementById('state'),
      sub: document.getElementById('sub')
    };
  }

  function setStatus(state, sub, isErr) {
    var u = ui();
    if (!u.state) return;
    u.state.textContent = state;
    u.sub.textContent = sub || '';
    if (u.orb) u.orb.textContent = isErr ? '⚠️' : (sleeping ? '💤' : (active ? '🎙️' : '🎤'));
  }

  function clampNum(n, lo, hi) {
    if (isNaN(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function loadCfg(done) {
    try {
      if (chrome && chrome.storage) {
        VSCore.storageGet(DEFAULTS, function (items) {
          try {
            if (items) cfg = Object.assign({}, DEFAULTS, items);
            cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
            cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
            build();
            if (done) done();
          } catch (e) { if (done) done(); }
        });
      } else { build(); if (done) done(); }
    } catch (e) { build(); if (done) done(); }
  }

  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        // "sync" is the normal store; "local" is used when sync storage is
        // unavailable in a managed browser.
        if (area !== 'sync' && area !== 'local') return;
        var langChanged = false;
        for (var key in changes) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
            cfg[key] = changes[key].newValue;
            if (key === 'lang') langChanged = true;
          }
        }
        cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
        build();
        if (langChanged && active) {
          activeLang = cfg.lang || 'en-US';
          langFallbackTried = false;
          restartRecognizer(300);
        }
      });
    }
  } catch (e) {}

  function build() {
    try { matcher = VSCore.createMatcher(cfg); } catch (e) { matcher = null; }
  }

  function reportState(on) {
    try {
      var p = chrome.runtime.sendMessage({ cmd: 'VS_HUB_STATE', on: on, heard: lastHeard, matched: lastMatched, conf: lastConfidence, err: lastError });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  function exec(name, raw, dir, tick, overrideMult, overridePage) {
    var now = Date.now();
    var mult = 1, page = false;
    try {
      if (matcher && (name === 'dn' || name === 'up' || name === 'pd' || name === 'pu')) {
        var md = matcher.parseModifier(raw, name) || { mult: 1 };
        mult = (typeof md.mult === 'number') ? md.mult : 1; // keep 0 ("all the way down/up")
        page = !!md.page;
      }
    } catch (e) {}
    var partial = (typeof overrideMult === 'number' && isFinite(overrideMult));
    if (partial) { mult = overrideMult; page = !!overridePage; }
    var p = null;
    try {
      p = chrome.runtime.sendMessage({
        cmd: 'VS_HUB_CMD', name: name, raw: raw || '', mult: mult, page: page,
        partial: partial, dir: dir || 0, tick: !!tick
      });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
    lastCmdTime = now;
    lastMatched = name;
    return p;
  }

  /* ================= precision scroller (PDF target) ================= */
  // The hub keeps its own tick loop so PDF tabs (which have no content
  // script) still get continuous auto-scroll. The next tick is scheduled
  // only after the previous one was answered, so a slow background can never
  // pile up a backlog of wheel events.
  function startAuto(dir) {
    stopAuto(true);
    autoDir = dir;
    exec('auto', 'keep scrolling', dir, false);
    var tick = function () {
      if (!autoTimer) return;
      var p;
      try { p = exec('auto', 'keep scrolling', autoDir, true); }
      catch (e) { p = null; }
      var again = function () {
        if (!autoTimer) return;
        try { autoTimer = setTimeout(tick, 45); } catch (e) { autoTimer = null; }
      };
      if (p && typeof p.then === 'function') p.then(again, again);
      else again();
    };
    autoTimer = setTimeout(tick, 45);
  }

  function stopAuto() {
    if (autoTimer) {
      try { clearTimeout(autoTimer); } catch (e) {}
      autoTimer = null;
    }
    autoDir = 0;
  }

  /* ================= command handling (mirrors content.js) ================= */
  // Decoded commands are ALWAYS forwarded to background — the background knows
  // whether the focused tab is scriptable (content engine owns speed/auto/HUD)
  // or a native PDF (background owns scrolling and speed itself). The hub only
  // maintains its own tick loop and sleep state locally.
  function handleCommand(cmd, raw) {
    var now = Date.now();
    lastHeard = raw;
    lastMatched = cmd + '|';
    lastCmdTime = now;

    if (sleeping) {
      if (cmd === 'wake') {
        sleeping = false;
        exec(cmd, raw, 0, false); // wake the content engine too on web tabs
        setStatus('Listening', 'resumed — say "down" · "up"');
      } else setStatus('Paused', 'paused — say "wake up"');
      return; // never forward commands while paused (PDF must not scroll either)
    }

    if (cmd === 'sleep') {
      sleeping = true;
      stopAuto();
      exec(cmd, raw, 0, false);
      setStatus('Paused', 'say "wake up" to resume');
      return;
    }
    if (cmd === 'stop') {
      stopAuto();
      exec(cmd, raw, 0, false);
      setStatus('Stopped', 'say "down" to scroll again');
      return;
    }
    if ((cmd === 'dn' || cmd === 'up') && VSCore.isKeep(raw)) {
      exec(cmd, raw, 0, false); // content engine starts its own auto-scroll on web tabs
      startAuto(cmd === 'dn' ? 1 : -1);
      setStatus('Auto-scroll ' + (cmd === 'dn' ? 'down' : 'up'), 'say "stop" · "faster" · "slower"');
      return;
    }
    if (cmd === 'help') {
      exec(cmd, raw, 0, false); // web tabs show the on-page command grid
      setStatus('Say: down · up · page down · top', 'bottom · undo · stop · sleep/wake · faster/slower · हिन्दी: नीचे · ऊपर · रुको · जागो · मदद');
      return;
    }
    if (cmd === 'faster' || cmd === 'slower') {
      exec(cmd, raw, 0, false);
      // Same rule as the page engine: a tempo command also starts the glide,
      // so "faster" alone is enough to begin scrolling.
      if (!autoTimer) startAuto(1);
      var disp = Math.max(1, Math.min(100, (parseInt(cfg.speed, 10) || 40) + (cmd === 'faster' ? 12 : -12)));
      setStatus(autoTimer ? ('Auto-scroll ' + (autoDir > 0 ? 'down' : 'up')) : (cmd === 'faster' ? 'Faster' : 'Slower'),
        'speed ' + disp + '%');
      return;
    }
    if (cmd === 'wake') {
      exec(cmd, raw, 0, false);
      setStatus('Already listening', 'say "down" · "up"');
      return;
    }

    // Manual scroll family: mirrors the on-page engine — any step command
    // cancels auto-scroll first (PDF ticks keep firing until stopped).
    stopAuto();
    exec(cmd, raw, 0, false);
    var labels = { dn: 'Down', up: 'Up', pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom', undo: 'Undone' };
    setStatus(labels[cmd] || 'Command', 'speed ' + (parseInt(cfg.speed, 10) || 40) + '%');
  }

  // Zero-latency processor (segment dedup + interim settling debounce),
  // shared with content.js through vs-core so a command behaves identically
  // on web pages and on native PDFs.
  function buildEngine() {
    try {
      engine = VSCore.createEngine({
        match: function (text) {
          return matcher ? matcher.parseCommand(text) : null;
        },
        mod: function (text, cmd) {
          return matcher ? matcher.parseModifier(text, cmd) : { mult: 1, edge: null, page: false };
        },
        settleMs: 60,
        maxWaitMs: 120,
        onExec: execAction,
        onMiss: function (text, conf) {
          lastHeard = text || '';
          lastConfidence = conf || 0;
          lastMatched = '';
          if (!sleeping) setStatus('Heard: ' + String(lastHeard).slice(0, 40), 'no command — try "down"');
          else setStatus('Heard: ' + String(lastHeard).slice(0, 40), 'paused — say "wake up"');
        }
      });
    } catch (e) { engine = null; }
  }

  function execAction(a) {
    if (!a) return;
    lastHeard = a.text || lastHeard;
    lastConfidence = a.conf || 0;
    if (a.type === 'upgrade') {
      // "down" -> "down three": only the remaining steps are executed.
      if (a.edge) exec(a.edge === 'bot' ? 'bot' : 'top', a.text, 0, false);
      else exec(a.cmd, a.text, 0, false, a.delta, a.page);
      return;
    }
    handleCommand(a.cmd, a.text);
  }

  function handleSpeechCandidates(cands, isFinal, segmentIdx) {
    if (!engine) buildEngine();
    if (!engine) return;
    engine.handle(cands || [], !!isFinal, segmentIdx);
  }

  /* ================= speech engine ================= */
  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function start() {
    if (active) return;
    if (!speechCtor()) {
      lastError = 'speech-api-missing';
      setStatus('Speech API unavailable', 'update this browser or use Chrome', true);
      reportState(false);
      return;
    }
    engineWanted = true;
    bloqGrantTries = 0;
    manualStop = false;
    sleeping = false;
    restartCount = 0;
    restartBurst = 0;
    restartWindowStart = Date.now();
    if (!engine) buildEngine();
    if (engine) engine.reset();
    lastError = '';
    if (!activeLang) activeLang = cfg.lang || 'en-US';
    createAndStart(true);
  }

  function createAndStart(firstRun) {
    var SR = speechCtor();
    if (!SR) { active = false; lastError = 'speech-api-missing'; return; }
    // Invalidate the previous instance BEFORE aborting it: aborting a live
    // recognizer makes the browser fire one more "end" event, and handling
    // that event would schedule another restart — an endless restart loop in
    // which the hub listens but never understands a command.
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
      clearTimeout(startWatchdog);
      active = true;
      restartCount = 0;
      recStartTs = Date.now();
      lastError = '';
      reportState(true);
      if (firstRun) setStatus('Listening', 'say "down" · "up" · "page down"');
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
            if (r[a] && r[a].transcript) cands.push({ text: r[a].transcript, conf: r[a].confidence || 0 });
          }
          if (!cands.length) continue;
          handleSpeechCandidates(cands, r.isFinal, i);
          if (!r.isFinal) interim = cands[0].text;
        }
        if (interim && active) {
          lastHeard = interim;
          setStatus(sleeping ? 'Paused' : 'Heard: ' + interim, sleeping ? 'say "wake up"' : '…');
        }
      } catch (err) {}
    };

    myRec.onerror = function (e) {
      if (rec !== myRec) return; // stale instance
      var err = (e && e.error) || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        active = false;
        manualStop = true;
        lastError = err;
        reportState(false);
        try { if (rec) rec.abort(); } catch (ee) {}
        // Hidden contexts cannot get a fresh permission grant — ask the
        // background to surface a visible hub page where mic can be granted.
        try {
          chrome.runtime.sendMessage({ cmd: 'VS_HUB_BLOQ', err: err });
        } catch (ex) {}
        // On a visible hub tab, explicitly requesting the mic here makes the
        // browser show the extension-origin permission prompt; on success,
        // restart recognition with that grant.
        try {
          if (bloqGrantTries < 2 && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            bloqGrantTries++;
            setStatus('Microphone blocked', 'allow the mic prompt, or click Enable in the popup', true);
            navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
              stream.getTracks().forEach(function (t) { t.stop(); });
              if (!engineWanted) return;
              manualStop = false;
              restartCount = 0;
              setStatus('Microphone granted', 'starting recognition…');
              createAndStart(true);
            }).catch(function () {});
          } else {
            setStatus('Microphone blocked', 'click Enable in the popup, then Allow', true);
          }
        } catch (eg) {}
      } else if (err === 'audio-capture') {
        active = false;
        manualStop = true;
        lastError = err;
        reportState(false);
        setStatus('No microphone', 'plug in a mic and retry', true);
        try { if (rec) rec.abort(); } catch (ee) {}
      } else if (err === 'language-not-supported') {
        if (!langFallbackTried && String(activeLang || cfg.lang) !== 'en-US') {
          langFallbackTried = true;
          activeLang = 'en-US';
          restartRecognizer(220);
          return;
        }
        active = false;
        manualStop = true;
        lastError = err;
        reportState(false);
        setStatus('Language not available', 'this browser refuses recognition language — try Chrome', true);
        try { if (rec) rec.abort(); } catch (ee) {}
      }
    };

    myRec.onend = function () {
      if (rec !== myRec) return; // stale instance — must not restart anything
      if (!active || manualStop) return;
      var now = Date.now();
      // A session that lived a normal amount of time simply ended (silence
      // timeout); only a session that died immediately counts as a failure.
      var lived = recStartTs ? (now - recStartTs) : 99999;
      if (lived < 1500) restartBurst++; else restartBurst = 0;
      if (restartBurst > 6) {
        // The speech service keeps dropping the session: stop cleanly instead
        // of restarting forever.
        active = false;
        manualStop = true;
        lastError = 'unstable';
        reportState(false);
        setStatus('Speech service unstable', 'the browser keeps dropping recognition — retry', true);
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
        if (active && !manualStop) createAndStart(false);
      }, delay);
    };

    // Watchdog: if the recognizer never starts in a hidden context, ask for a
    // visible hub surface (Edge/chrome sometimes refuse mic in offscreen docs).
    clearTimeout(startWatchdog);
    if (firstRun) {
      startWatchdog = setTimeout(function () {
        if (!active) reportState(false); // nudge the badge; error surfaced by onerror if any
      }, 5000);
    }

    try {
      myRec.start();
    } catch (e) {
      active = false;
      lastError = 'start-failed';
      reportState(false);
      setStatus('Could not start', 'retry from the extension popup', true);
    }
  }

  function stopAll() {
    engineWanted = false;
    bloqGrantTries = 0;
    manualStop = true;
    active = false;
    sleeping = false;
    stopAuto();
    clearTimeout(restartTimer);
    if (engine) engine.reset();
    clearTimeout(startWatchdog);
    var oldRec = rec;
    rec = null;               // invalidate before aborting: no restart may follow
    if (oldRec) { try { oldRec.abort(); } catch (e) {} }
    lastConfidence = 0;
    lastError = ''; // a deliberate stop is not an error
    reportState(false);
    setStatus('VoiceScroll hub stopped', 'press Enable in the toolbar popup');
  }

  /* ================= external API ================= */
  window.__vsHub = {
    toggle: function (on) {
      if (on === false) { stopAll(); return false; }
      loadCfg(function () { start(); });
      return true;
    },
    status: function () {
      return { on: active, sleeping: sleeping, heard: lastHeard, matched: lastMatched, conf: lastConfidence, err: lastError, speed: cfg.speed };
    }
  };

  try {
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        try {
          if (!msg || typeof msg !== 'object') return false;
          if (msg.cmd === 'VS_HUB_TOGGLE') {
            window.__vsHub.toggle(msg.on);
            sendResponse({ ok: true });
            return true;
          }
          if (msg.cmd === 'VS_HUB_STOP') {
            window.__vsHub.toggle(false);
            sendResponse({ ok: true });
            return true;
          }
          if (msg.cmd === 'VS_HUB_STATUS') {
            sendResponse(window.__vsHub.status());
            return true;
          }
          if (msg.cmd === 'VS_HUB_LANG') {
            activeLang = String(msg.lang || 'en-US');
            langFallbackTried = false;
            if (active) restartRecognizer(250);
            sendResponse({ ok: true });
            return true;
          }
        } catch (e) {}
        return false;
      });
    }
  } catch (e) {}

  // Restart the recognizer (language change, service fallback). The old
  // instance is invalidated inside createAndStart, so its "end" event can
  // never schedule another restart.
  function restartRecognizer(delay) {
    if (!active) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      if (!active) return;
      createAndStart(false);
    }, delay || 300);
  }

  // Announce presence so the background can track the hub context.
  try {
    chrome.runtime.sendMessage({ cmd: 'VS_HUB_HOST', cs: (typeof chrome.offscreen !== 'undefined') });
  } catch (e) {}

  loadCfg(function () {
    setStatus('VoiceScroll hub', 'waiting for start signal');
  });
})();
