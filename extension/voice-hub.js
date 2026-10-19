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

  var DEFAULTS = {
    dist: 400,
    smooth: true,
    sound: true,
    lang: 'en-US',
    sensitivity: 'balanced',
    speed: 40,
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
    cSlower: 'slower, slow down, speed down, go slower',
    cHelp: 'help, what can i say, show commands'
  };

  var cfg = Object.assign({}, DEFAULTS);
  var matcher = null;
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
  var restartWindowStart = Date.now();
  var autoTimer = null;
  var autoDir = 0;
  var activeLang = '';
  var langFallbackTried = false;
  // Zero-latency interim engine segment tracking (same shape as content.js).
  var executedSegments = {};
  var interimTimers = {}; // per-segment settle timers — rapid commands don't cancel each other
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
      if (chrome && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(DEFAULTS, function (items) {
          if (items) cfg = Object.assign({}, DEFAULTS, items);
          cfg.dist = clampNum(parseInt(cfg.dist, 10) || 400, 50, 1000);
          cfg.speed = clampNum(parseInt(cfg.speed, 10) || 40, 1, 100);
          build();
          if (done) done();
        });
      } else { build(); if (done) done(); }
    } catch (e) { build(); if (done) done(); }
  }

  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
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
    try {
      var p = chrome.runtime.sendMessage({
        cmd: 'VS_HUB_CMD', name: name, raw: raw || '', mult: mult, page: page,
        partial: partial, dir: dir || 0, tick: !!tick
      });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
    lastCmdTime = now;
    lastMatched = name;
  }

  /* ================= precision scroller (PDF target) ================= */
  // The hub keeps its own 45 ms tick loop so PDF tabs (which have no content
  // script) still get continuous auto-scroll. For scriptable tabs the loop is
  // harmless: background ignores duplicate 'auto' ticks once content.js owns
  // its internal timer.
  function startAuto(dir) {
    stopAuto(true);
    autoDir = dir;
    exec('auto', 'keep scrolling', dir, false);
    autoTimer = setInterval(function () {
      exec('auto', 'keep scrolling', autoDir, true);
    }, 45);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      autoDir = 0;
    }
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
      exec(cmd, raw, 0, false); // web tabs show the on-page cheat sheet
      setStatus('Say: down · up · page down · top', 'bottom · stop · sleep/wake · faster/slower · हिन्दी: नीचे · ऊपर · रुको · जागो · मदद');
      return;
    }
    if (cmd === 'faster' || cmd === 'slower') {
      exec(cmd, raw, 0, false);
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
    var labels = { dn: 'Down', up: 'Up', pd: 'Page down', pu: 'Page up', top: 'Top', bot: 'Bottom' };
    setStatus(labels[cmd] || 'Command', 'speed ' + (parseInt(cfg.speed, 10) || 40) + '%');
  }

  // Zero-latency processor (segment dedup + interim settling debounce),
  // trimmed on-page edition of content.js.handleSpeechCandidates.
  function handleSpeechCandidates(cands, isFinal, segmentIdx) {
    var prev = executedSegments[segmentIdx];

    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var hit = matcher && matcher.parseCommand(cands[i].text);
      if (hit) {
        var s = hit.score * 10 - i * 2;
        if (!best || s > best.s) {
          best = { hit: hit, s: s, text: cands[i].text, conf: cands[i].conf };
        }
      }
    }

    if (best) {
      if (prev && prev.done) {
        if (best.hit.cmd === prev.cmd && best.hit.cmd !== 'stop' &&
            best.hit.cmd !== 'sleep' && best.hit.cmd !== 'wake' &&
            best.hit.cmd !== 'faster' && best.hit.cmd !== 'slower') {
          var nm = matcher.parseModifier(best.text, best.hit.cmd);
          var om = prev.mod || { mult: 1, edge: null };
          var upgraded = false;
          if (nm.edge && nm.edge !== om.edge) upgraded = true;
          else if (!nm.edge && !om.edge && (nm.mult || 1) > (om.mult || 1)) upgraded = true;
          if (upgraded) {
            lastHeard = best.text; lastConfidence = best.conf || 0; lastCmdTime = Date.now();
            prev.mod = nm; prev.text = best.text; prev.score = best.hit.score;
            if (nm.edge) exec(nm.edge === 'bot' ? 'bot' : 'top', best.text, 0, false);
            else exec(best.hit.cmd, best.text, 0, false, (nm.mult || 1) - (om.mult || 1), nm.page);
            lastMatched = best.hit.cmd + '|';
            return;
          }
        }
        if (isFinal) prev.final = true;
        return; // genuine duplicate interim/final overlap — suppress double-fire
      }

      var cmd = best.hit.cmd;
      lastHeard = best.text;
      lastConfidence = best.conf || 0;
      lastMatched = cmd + '|';

      // Immediate commands execute with 0 ms delay
      if (cmd === 'stop' || cmd === 'sleep' || (cmd === 'wake' && sleeping)) {
        clearTimeout(interimTimers[segmentIdx]);
        delete interimTimers[segmentIdx];
        executedSegments[segmentIdx] = { t: Date.now(), cmd: cmd, done: true, final: true, mod: matcher.parseModifier(best.text, cmd), text: best.text };
        handleCommand(cmd, best.text);
        return;
      }
      // Final -> execute immediately
      if (isFinal) {
        clearTimeout(interimTimers[segmentIdx]);
        delete interimTimers[segmentIdx];
        executedSegments[segmentIdx] = { t: Date.now(), cmd: cmd, done: true, final: true, mod: matcher.parseModifier(best.text, cmd), text: best.text };
        handleCommand(cmd, best.text);
        return;
      }
      // Interim: brief 210 ms settling window lets multi-word modifiers complete
      clearTimeout(interimTimers[segmentIdx]);
      (function (seg, b) {
        interimTimers[seg] = setTimeout(function () {
          delete interimTimers[seg];
          var p = executedSegments[seg];
          if (p && p.done) return;
          executedSegments[seg] = { t: Date.now(), cmd: b.hit.cmd, done: true, final: false, mod: matcher.parseModifier(b.text, b.hit.cmd), text: b.text };
          handleCommand(b.hit.cmd, b.text);
        }, 210);
      })(segmentIdx, best);
    } else if (isFinal) {
      lastHeard = cands.length ? cands[0].text : '';
      lastConfidence = cands.length ? (cands[0].conf || 0) : 0;
      lastMatched = '';
      if (!sleeping) setStatus('Heard: ' + String(lastHeard).slice(0, 40), 'no command — try "down"');
      else setStatus('Heard: ' + String(lastHeard).slice(0, 40), 'paused — say "wake up"');
    }
  }

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
    restartWindowStart = Date.now();
    executedSegments = {};
    lastError = '';
    if (!activeLang) activeLang = cfg.lang || 'en-US';
    createAndStart(true);
  }

  function createAndStart(firstRun) {
    var SR = speechCtor();
    if (!SR) { active = false; return; }
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
      clearTimeout(startWatchdog);
      active = true;
      restartCount = 0;
      reportState(true);
      if (firstRun) setStatus('Listening', 'say "down" · "up" · "page down"');
    };

    rec.onresult = function (e) {
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
          pruneSegments();
          handleSpeechCandidates(cands, r.isFinal, i);
          if (!r.isFinal) interim = cands[0].text;
        }
        if (interim && active) {
          lastHeard = interim;
          setStatus(sleeping ? 'Paused' : 'Heard: ' + interim, sleeping ? 'say "wake up"' : '…');
        }
      } catch (err) {}
    };

    rec.onerror = function (e) {
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

    rec.onend = function () {
      if (!active || manualStop) return;
      var now = Date.now();
      if (now - restartWindowStart > 10000) { restartWindowStart = now; restartCount = 0; }
      restartCount++;
      var delay = Math.min(250 * restartCount, 2200);
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
      rec.start();
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
    clearInterimTimers();
    clearTimeout(startWatchdog);
    try { if (rec) rec.abort(); } catch (e) {}
    rec = null;
    lastConfidence = 0;
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

  function restartRecognizer(delay) {
    if (!active) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      if (!active) return;
      try { if (rec) rec.abort(); } catch (e) {}
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
