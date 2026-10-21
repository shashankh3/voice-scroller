// VoiceScroll Ultimate v28.1 — popup script.
// Settings defaults come from vs-core (loaded before this file) so every
// context shares one source of truth.
var DEFAULTS = (typeof VSCore !== 'undefined' && VSCore.DEFAULTS) ? VSCore.DEFAULTS : {
  dist: 400, smooth: true, sound: true, lang: 'en-US', sensitivity: 'balanced',
  speed: 40, showHud: true,
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

var KEYS = ['cDn', 'cUp', 'cPd', 'cPu', 'cTop', 'cBot', 'cStop', 'cUndo', 'cSleep', 'cWake', 'cFaster', 'cSlower', 'cHelp'];

var els = {
  btn: document.getElementById('btn'),
  bt: document.getElementById('bt'),
  pill: document.getElementById('pill'),
  warn: document.getElementById('warn'),
  card: document.getElementById('statusCard'),
  orb: document.getElementById('orb'),
  state: document.getElementById('stateTxt'),
  heard: document.getElementById('heardTxt'),
  conf: document.getElementById('confFill'),
  dist: document.getElementById('cDist'),
  dVal: document.getElementById('dVal'),
  speed: document.getElementById('cSpeed'),
  sVal: document.getElementById('sVal'),
  sens: document.getElementById('cSens'),
  smooth: document.getElementById('cSmooth'),
  sound: document.getElementById('cSound'),
  hud: document.getElementById('cHud'),
  lang: document.getElementById('cLang'),
  reset: document.getElementById('reset')
};

var inputs = KEYS.map(function (k) { return document.getElementById(k); });
inputs.forEach(function (input, i) {
  if (!input) return;
  input.dataset.key = KEYS[i];
  // Every field gets an accessible name (the visible labels are plain spans).
  var label = input.closest ? input.closest('.grp') : null;
  var lbl = label ? label.querySelector('.lbl') : null;
  input.setAttribute('aria-label', (lbl ? lbl.textContent.replace(/\s*—.*$/, '').trim() : KEYS[i]) + ' phrases, comma separated');
});

// Classify the active tab: 'web' (scriptable page), 'pdf' (native viewer,
// hub mode) or 'restricted' (chrome://, store pages, etc).
function tabMode(url) {
  if (!url) return 'restricted';
  if (/\.pdf([?#]|$)/i.test(url)) return 'pdf';
  if (/^chrome-extension:\/\/[a-z0-9]{30,44}\/index\.html\?/i.test(url)) return 'pdf';
  if (/^(chrome:|edge:|about:|chrome-extension:|moz-extension:|edge-extension:|extension:|view-source:|data:|devtools:)/i.test(url)) return 'restricted';
  if (/^https?:\/\/chrome\.google\.com\/webstore/i.test(url) || /^https?:\/\/chromewebstore\.google\.com/i.test(url)) return 'restricted';
  return 'web';
}

function showWarn(msg) {
  if (!msg) {
    els.warn.style.display = 'none';
    els.warn.textContent = '';
    return;
  }
  els.warn.textContent = msg;
  els.warn.style.display = 'block';
}

// Named warnings: several parts of the popup can want to show a message at
// the same time. Each one owns a slot and the most important slot wins, so a
// status refresh never silently drops an error.
var WARN_ORDER = ['blocked', 'error', 'phrase', 'info'];
var warnSlots = {};
function setWarn(id, msg) {
  if (msg) warnSlots[id] = msg; else delete warnSlots[id];
  var best = null;
  for (var i = 0; i < WARN_ORDER.length; i++) {
    if (warnSlots[WARN_ORDER[i]]) { best = warnSlots[WARN_ORDER[i]]; break; }
  }
  showWarn(best);
}

function setStatus(mode, state, heard, conf) {
  els.card.className = 'status' + (mode ? ' ' + mode : '');
  els.state.textContent = state;
  els.heard.textContent = heard || '—';
  els.conf.style.width = conf > 0 ? Math.round(conf * 100) + '%' : '0%';
  els.orb.textContent = (mode === 'err' || mode === 'blocked') ? '⛔' : mode === 'sleep' ? '💤' : (mode === 'live' ? '🎙️' : '🎤');
}

function setPill(parts) {
  // parts: array of [text, isAccent] — built with DOM nodes, never innerHTML.
  els.pill.textContent = '';
  for (var i = 0; i < parts.length; i++) {
    var span = document.createElement('span');
    span.textContent = parts[i][0];
    if (parts[i][1]) {
      span.style.fontWeight = '600';
      span.style.color = 'var(--red)';
    }
    els.pill.appendChild(span);
  }
}

function updateUI(on) {
  if (on) {
    els.btn.classList.add('on');
    els.bt.textContent = 'Stop Listening';
    setPill([['● ', false], ['Active', true], [' — say “down”', false]]);
    if (els.state.textContent === 'Inactive' || els.state.textContent === 'Checking…') {
      setStatus('live', 'Listening', 'say “down” · “up”', 0);
    }
  } else {
    els.btn.classList.remove('on');
    els.bt.textContent = 'Enable Microphone';
    setPill([['● Inactive', false]]);
    setStatus('', 'Inactive', 'press Enable and speak', 0);
  }
}

async function currentTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// 1. Load settings
VSCore.storageGet(DEFAULTS, function (cfg) {
  try {
    if (!cfg) cfg = DEFAULTS;
    els.dist.value = cfg.dist;
    els.dVal.textContent = cfg.dist + 'px';
    els.speed.value = cfg.speed;
    els.sVal.textContent = cfg.speed + '%';
    els.sens.value = cfg.sensitivity || 'balanced';
    els.smooth.checked = cfg.smooth !== false;
    if (els.sound) els.sound.checked = cfg.sound !== false;
    els.hud.checked = cfg.showHud !== false;

    if (els.lang) {
      var has = Array.prototype.some.call(els.lang.options, function (o) { return o.value === cfg.lang; });
      if (!has) {
        var opt = document.createElement('option');
        opt.value = cfg.lang;
        opt.textContent = cfg.lang;
        els.lang.appendChild(opt);
      }
      els.lang.value = cfg.lang;
    }
    inputs.forEach(function (input) {
      if (input) input.value = cfg[input.dataset.key] || '';
    });
    validatePhrases();
  } catch (e) {}
});

// Live update listener
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync') return;
  if (changes.speed && els.speed) {
    els.speed.value = changes.speed.newValue;
    els.sVal.textContent = changes.speed.newValue + '%';
  }
  if (changes.dist && els.dist) {
    els.dist.value = changes.dist.newValue;
    els.dVal.textContent = changes.dist.newValue + 'px';
  }
  refreshStatus(true);
});

// 2. Save settings
var saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    var data = {
      dist: parseInt(els.dist.value, 10) || 400,
      speed: parseInt(els.speed.value, 10) || 40,
      sensitivity: els.sens.value,
      smooth: els.smooth.checked,
      sound: els.sound ? els.sound.checked : true,
      showHud: els.hud.checked,
      lang: els.lang ? els.lang.value : 'en-US'
    };
    inputs.forEach(function (input) {
      if (input) data[input.dataset.key] = input.value;
    });
    VSCore.storageSet(data, function (err) {
      if (!err) return;
      // Chrome's sync storage has a per-item quota; a huge custom phrase
      // list can exceed it. Say so instead of failing silently.
      setWarn('error', 'Could not save the settings: ' + String((err && err.message) || err));
    });
  }, 120);
}

// Warn about command groups that would not work with an empty phrase list.
function validatePhrases() {
  var empty = [];
  var labels = {
    cDn: 'down', cUp: 'up', cPd: 'page down', cPu: 'page up',
    cTop: 'top', cBot: 'bottom', cStop: 'stop', cUndo: 'undo',
    cSleep: 'sleep', cWake: 'wake up', cFaster: 'faster', cSlower: 'slower', cHelp: 'help'
  };
  inputs.forEach(function (input) {
    if (!input) return;
    var key = input.dataset.key;
    var has = String(input.value || '').split(',').some(function (p) { return p.trim().length > 0; });
    input.style.borderColor = has ? '' : 'rgba(255,82,82,.6)';
    if (!has && labels[key]) empty.push(labels[key]);
  });
  if (empty.length) {
    setWarn('phrase', 'No phrase left for: ' + empty.join(', ') + ' — that command will not work.');
  } else {
    setWarn('phrase', '');
  }
}

// Remove every warning at once (used when the user starts a new action).
function clearWarns() {
  warnSlots = {};
  showWarn('');
}

els.dist.addEventListener('input', function () { els.dVal.textContent = els.dist.value + 'px'; save(); });
els.speed.addEventListener('input', function () { els.sVal.textContent = els.speed.value + '%'; save(); });
els.sens.addEventListener('change', save);
els.smooth.addEventListener('change', save);
if (els.sound) els.sound.addEventListener('change', save);
els.hud.addEventListener('change', save);
if (els.lang) els.lang.addEventListener('change', save);
inputs.forEach(function (el) {
  if (!el) return;
  el.addEventListener('input', function () { validatePhrases(); save(); });
  el.addEventListener('blur', validatePhrases);
});

els.reset.addEventListener('click', function () {
  VSCore.storageSet(DEFAULTS, function () {
    els.dist.value = DEFAULTS.dist;
    els.dVal.textContent = DEFAULTS.dist + 'px';
    els.speed.value = DEFAULTS.speed;
    els.sVal.textContent = DEFAULTS.speed + '%';
    els.sens.value = DEFAULTS.sensitivity;
    els.smooth.checked = DEFAULTS.smooth;
    if (els.sound) els.sound.checked = DEFAULTS.sound;
    els.hud.checked = DEFAULTS.showHud;
    if (els.lang) els.lang.value = DEFAULTS.lang;
    inputs.forEach(function (input) { if (input) input.value = DEFAULTS[input.dataset.key]; });
    validatePhrases();
  });
});

// Quick testing chips & per-command test buttons
document.querySelectorAll('[data-test]').forEach(function (b) {
  b.addEventListener('click', async function () {
    var what = b.getAttribute('data-test');
    clearWarns();
    try {
      var tab = await currentTab();
      if (!tab || !tab.id || tabMode(tab.url) === 'restricted') {
        setWarn('info', 'Open a normal webpage or PDF to test.');
        return;
      }
      if (tabMode(tab.url) === 'pdf') {
        // Drive the scroll through the background (works on native PDF tabs).
        try {
          await chrome.runtime.sendMessage({ cmd: 'VS_HUB_CMD', name: what, raw: '', mult: 1, dir: 0, tick: false });
          return;
        } catch (e) {
          setWarn('info', 'Enable Microphone first (PDF mode uses the voice hub).');
          return;
        }
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['vs-core.js'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) {}
      try {
        var st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_TEST', what: what });
        if (!st) setWarn('info', 'Refresh the page, then test again.');
      } catch (e) {
        setWarn('info', 'Refresh the page, then test again.');
      }
    } catch (e) {
      setWarn('info', 'Refresh the page, then test again.');
    }
  });
});

// Grant the microphone once to the extension's own origin (popup window).
// Needed before hub mode: offscreen/tab hub documents cannot prompt for it.
async function grantMicToExtension() {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(function (t) { t.stop(); });
    return true;
  } catch (e) {
    return false;
  }
}

// 3. Toggle button — routed through the background master toggle so web tabs,
//    native PDF tabs (hub) and restricted pages all behave the same.
els.btn.addEventListener('click', async function () {
  clearWarns();
  var tab = await currentTab();
  if (!tab || !tab.id) { setWarn('info', 'No active tab found.'); return; }

  var mode = tabMode(tab.url);
  if (mode === 'restricted') {
    setStatus('blocked', 'Blocked here', 'store / chrome:// pages deny extensions', 0);
    setWarn('blocked', 'Extensions are blocked on this page. Open any normal website or PDF and try again.');
    return;
  }

  els.btn.disabled = true;
  try {
    if (mode === 'pdf') {
      // Hub recognition lives on the extension origin: grant the mic first
      // (one-time prompt from this visible popup).
      var granted = await grantMicToExtension();
      if (!granted) {
        setStatus('err', 'Microphone denied', 'need mic to listen', 0);
        setWarn('error', 'Allow the microphone in the popup prompt to use PDF mode.');
        els.btn.disabled = false;
        return;
      }
    }

    var r = null;
    try {
      r = await chrome.runtime.sendMessage({ cmd: 'VS_BG_TOGGLE' });
    } catch (e) { r = null; }

    if (!r) {
      setStatus('err', 'Background unreachable', 'reload the extension', 0);
      setWarn('error', 'Could not reach the service worker. Reload the extension and retry.');
    } else if (mode === 'pdf') {
      if (r.on) {
        updateUI(true);
        setStatus('live', 'Listening (PDF mode)', 'scrolling runs on the PDF tab · say “down”', 0);
        setPill([['● ', false], ['PDF mode', true], [' — commands from the voice hub', false]]);
        if (r.reason === 'no-hub' || r.pdfOk === false) {
          setWarn('info', 'PDF hub started, but this browser may not expose the native viewer to extensions. Test with the chips below.');
        }
        if (r.dbgError) setWarn('error', debuggerHint(r.dbgError));
      } else if (r.stopped) {
        // Toggle was a successful "stop everything" (hub was running).
        updateUI(false);
        setPill([['● Inactive', false]]);
      } else {
        setStatus('err', 'Cannot start PDF mode', '', 0);
        setWarn('error', 'PDF mode could not start. Try reloading the extension, then the PDF tab.');
      }
    } else {
      if (r.on) {
        updateUI(true);
        setStatus('live', 'Listening', 'say “down” · “up”', 0);
      } else if (r.stopped) {
        // Toggle was a successful "stop listening" — not an error.
        updateUI(false);
        setPill([['● Inactive', false]]);
      } else {
        setStatus('err', 'Cannot start', 'refresh the page and retry', 0);
        if (/^file:/i.test(tab.url || '')) {
          setWarn('error', 'Could not start. Refresh the page and retry. (file:// URLs need “Allow access to file URLs” at chrome://extensions.)');
        } else if (r.reason === 'restricted') {
          setStatus('blocked', 'Blocked here', 'this page denies extensions', 0);
          setWarn('blocked', 'This page blocks extensions. Open any standard webpage or PDF.');
        } else {
          setWarn('error', 'Could not start here. Refresh the page and try again.');
        }
      }
    }
  } catch (e) {
    setStatus('err', 'Error', String((e && e.message) || e).slice(0, 60), 0);
    setWarn('error', 'Could not reach the page. Refresh it, click Enable, and allow the mic.');
  } finally {
    els.btn.disabled = false;
  }
});

// 4. Status refresh (web engine on tab + hub state)
var refreshInFlight = false;
async function refreshStatus(quiet) {
  // Never let two refreshes overlap — a slow background would otherwise
  // pile up requests.
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    await doRefreshStatus(quiet);
  } catch (e) {
    if (!quiet) updateUI(false);
  } finally {
    refreshInFlight = false;
  }
}

async function doRefreshStatus(quiet) {
  try {
    var tab = await currentTab();
    var mode = tab && tabMode(tab.url);

    // Hub info is read first: it carries the last error even after the hub
    // has shut itself down (mic blocked, no speech service, ...).
    var hub = null;
    try {
      hub = await chrome.runtime.sendMessage({ cmd: 'VS_BG_HUB_STATUS' });
    } catch (e) { hub = null; }
    var info = { heard: '', matched: '', conf: 0, err: '' };
    try { if (chrome.storage && chrome.storage.session) { var it = await chrome.storage.session.get({ vsHubInfo: {}}); info = it.vsHubInfo || info; } } catch (e) {}

    if (!tab || !tab.id) { if (!quiet) updateUI(false); return; }

    if (mode === 'restricted') {
      updateUI(false);
      setStatus('blocked', 'Blocked here', 'store / chrome:// pages deny extensions', 0);
      setWarn('blocked', 'Extensions are blocked on this page. Open any normal website or PDF.');
      return;
    }

    if (/^file:/i.test(tab.url || '') && mode === 'web') {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(function (isAllowed) {
          if (!isAllowed) {
            setWarn('info', 'file:// page: enable “Allow access to file URLs” for VoiceScroll at chrome://extensions. (Native PDF tabs do not need this.)');
          }
        });
      }
    }

    if (hub && (hub.on || hub.wanted)) {
      if (info.err) {
        // The hub could not start (mic blocked / no speech service) — be
        // honest about it instead of showing a green "listening" pill.
        updateUI(false);
        setStatus('err', 'Hub error', errText(info.err), 0);
        setWarn('error', hubErrHint(info.err));
        return;
      }
      updateUI(true);
      var heard = info.heard ? '“' + String(info.heard).slice(0, 40) + '”' : 'say “down” · “up” (PDF hub)';
      setStatus('live', 'Listening (PDF mode)', heard, info.conf || 0);
      setPill([['● ', false], ['PDF mode', true], [' — hub listening · say “stop” to end', false]]);
      return;
    }

    var st = null;
    try { st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_STATUS' }); } catch (e) { st = null; }

    if (!st) {
      // No engine on this tab — it cannot be listening, so reflect that even
      // in quiet mode (e.g. listening was toggled off via hotkey/orb).
      updateUI(false);
      if (info.err) {
        setStatus('err', 'Hub error', errText(info.err), 0);
        setWarn('error', hubErrHint(info.err));
      }
    } else {
      updateUI(!!st.on);
      if (st.err && !st.on) {
        setStatus('err', 'Engine error', errText(st.err), 0);
        setWarn('error', hubErrHint(st.err));
      } else if (st.on) {
        var label = st.sleeping ? 'Paused' : 'Listening';
        var heardTxt = st.heard ? '“' + String(st.heard).slice(0, 40) + '”' : 'say “down” · “up”';
        setStatus(st.sleeping ? 'sleep' : 'live', label, heardTxt, st.conf || 0);
        if (st.sleeping) setPill([['● ', false], ['Paused', true], [' — say “wake up”', false]]);
      }
    }
  } catch (e) {
    if (!quiet) updateUI(false);
  }
}

// Human readable text for the recognizer error codes.
function errText(code) {
  var c = String(code || '');
  if (c === 'not-allowed' || c === 'service-not-allowed') return 'microphone blocked';
  if (c === 'audio-capture') return 'no microphone found';
  if (c === 'language-not-supported') return 'language not supported';
  if (c === 'speech-api-missing') return 'no speech service';
  if (c === 'start-failed') return 'could not start';
  if (c === 'unstable') return 'speech service unstable';
  if (c === 'network') return 'network problem';
  return c.replace(/-/g, ' ');
}

// The trusted-input engine needs the debugger API; the most common failure is
// DevTools (or another debugger) already being attached to the tab.
function debuggerHint(msg) {
  var m = String(msg || '').toLowerCase();
  if (m.indexOf('already attached') >= 0 || m.indexOf('another debugger') >= 0) {
    return 'DevTools is already debugging this tab. Close DevTools (F12) and press Enable again.';
  }
  if (m.indexOf('not allowed') >= 0 || m.indexOf('permission') >= 0) {
    return 'This browser does not allow extensions to drive trusted input here.';
  }
  return 'Trusted input is unavailable in this tab: ' + String(msg || '').slice(0, 80);
}

function hubErrHint(code) {
  var c = String(code || '');
  if (c === 'not-allowed' || c === 'service-not-allowed' || c === 'audio-capture') {
    return 'The microphone is blocked. Click the 🔒/🎤 icon in the address bar, allow the microphone, then press Enable again.';
  }
  if (c === 'language-not-supported') {
    return 'This browser refuses the selected speech language. Pick English (US) below, or use Chrome desktop.';
  }
  if (c === 'speech-api-missing') {
    return 'This browser has no Web Speech API. Use Chrome or Edge on the desktop.';
  }
  return 'VoiceScroll could not start. Reload the extension at chrome://extensions and try again.';
}

refreshStatus(false);
setInterval(function () { refreshStatus(true); }, 1200);
