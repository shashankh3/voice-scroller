// VoiceScroll Ultimate v25.2 — popup script.
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
  cSlower: 'slower, slow down, speed down, go slower'
};

var KEYS = ['cDn', 'cUp', 'cPd', 'cPu', 'cTop', 'cBot', 'cStop', 'cSleep', 'cWake', 'cFaster', 'cSlower'];

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
inputs.forEach(function (input, i) { if (input) input.dataset.key = KEYS[i]; });

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

function setStatus(mode, state, heard, conf) {
  els.card.className = 'status' + (mode ? ' ' + mode : '');
  els.state.textContent = state;
  els.heard.textContent = heard || '—';
  els.conf.style.width = conf > 0 ? Math.round(conf * 100) + '%' : '0%';
  els.orb.textContent = (mode === 'err' || mode === 'blocked') ? '⛔' : mode === 'sleep' ? '💤' : (mode === 'live' ? '🎙️' : '🎤');
}

function updateUI(on) {
  if (on) {
    els.btn.classList.add('on');
    els.bt.textContent = 'Stop Listening';
    els.pill.innerHTML = '● <b>Active</b> — say “down”';
    if (els.state.textContent === 'Inactive' || els.state.textContent === 'Checking…') {
      setStatus('live', 'Listening', 'say “down” · “up”', 0);
    }
  } else {
    els.btn.classList.remove('on');
    els.bt.textContent = 'Enable Microphone';
    els.pill.textContent = '● Inactive';
    setStatus('', 'Inactive', 'press Enable and speak', 0);
  }
}

async function currentTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// 1. Load settings
chrome.storage.sync.get(DEFAULTS, function (cfg) {
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
    chrome.storage.sync.set(data);
  }, 120);
}

els.dist.addEventListener('input', function () { els.dVal.textContent = els.dist.value + 'px'; save(); });
els.speed.addEventListener('input', function () { els.sVal.textContent = els.speed.value + '%'; save(); });
els.sens.addEventListener('change', save);
els.smooth.addEventListener('change', save);
if (els.sound) els.sound.addEventListener('change', save);
els.hud.addEventListener('change', save);
if (els.lang) els.lang.addEventListener('change', save);
inputs.forEach(function (el) { if (el) el.addEventListener('input', save); });

els.reset.addEventListener('click', function () {
  chrome.storage.sync.set(DEFAULTS, function () {
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
  });
});

// Quick testing chips & per-command test buttons
document.querySelectorAll('[data-test]').forEach(function (b) {
  b.addEventListener('click', async function () {
    var what = b.getAttribute('data-test');
    showWarn('');
    try {
      var tab = await currentTab();
      if (!tab || !tab.id || tabMode(tab.url) === 'restricted') {
        showWarn('Open a normal webpage or PDF to test.');
        return;
      }
      if (tabMode(tab.url) === 'pdf') {
        // Drive the scroll through the background (works on native PDF tabs).
        try {
          await chrome.runtime.sendMessage({ cmd: 'VS_HUB_CMD', name: what, raw: '', mult: 1, dir: 0, tick: false });
          return;
        } catch (e) {
          showWarn('Enable Microphone first (PDF mode uses the voice hub).');
          return;
        }
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['vs-core.js'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) {}
      try {
        var st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_TEST', what: what });
        if (!st) showWarn('Refresh the page, then test again.');
      } catch (e) {
        showWarn('Refresh the page, then test again.');
      }
    } catch (e) {
      showWarn('Refresh the page, then test again.');
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
  showWarn('');
  var tab = await currentTab();
  if (!tab || !tab.id) { showWarn('No active tab found.'); return; }

  var mode = tabMode(tab.url);
  if (mode === 'restricted') {
    setStatus('blocked', 'Blocked here', 'store / chrome:// pages deny extensions', 0);
    showWarn('Extensions are blocked on this page. Open any normal website or PDF and try again.');
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
        showWarn('Allow the microphone in the popup prompt to use PDF mode.');
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
      showWarn('Could not reach the service worker. Reload the extension and retry.');
    } else if (mode === 'pdf') {
      if (r.on) {
        updateUI(true);
        setStatus('live', 'Listening (PDF mode)', 'scrolling runs on the PDF tab · say “down”', 0);
        els.pill.innerHTML = '● <b>PDF mode</b> — commands from the voice hub';
        if (r.reason === 'no-hub' || r.pdfOk === false) {
          showWarn('PDF hub started, but this browser may not expose the native viewer to extensions. Test with the chips below.');
        }
      } else {
        setStatus('err', 'Cannot start PDF mode', '', 0);
        showWarn('PDF mode could not start. Try reloading the extension, then the PDF tab.');
      }
    } else {
      if (r.on) {
        updateUI(true);
        setStatus('live', 'Listening', 'say “down” · “up”', 0);
      } else {
        setStatus('err', 'Cannot start', 'refresh the page and retry', 0);
        if (/^file:/i.test(tab.url || '')) {
          showWarn('Could not start. Refresh the page and retry. (file:// URLs need “Allow access to file URLs” at chrome://extensions.)');
        } else if (r.reason === 'restricted') {
          setStatus('blocked', 'Blocked here', 'this page denies extensions', 0);
          showWarn('This page blocks extensions. Open any standard webpage or PDF.');
        } else {
          showWarn('Could not start here. Refresh the page and try again.');
        }
      }
    }
  } catch (e) {
    setStatus('err', 'Error', String((e && e.message) || e).slice(0, 60), 0);
    showWarn('Could not reach the page. Refresh it, click Enable, and allow the mic.');
  } finally {
    els.btn.disabled = false;
  }
});

// 4. Status refresh (web engine on tab + hub state)
async function refreshStatus(quiet) {
  try {
    var tab = await currentTab();
    var mode = tab && tabMode(tab.url);

    // Hub state (PDF mode) — authoritative when running.
    var hub = null;
    try {
      hub = await chrome.runtime.sendMessage({ cmd: 'VS_BG_HUB_STATUS' });
    } catch (e) { hub = null; }

    if (!tab || !tab.id) { if (!quiet) updateUI(false); return; }

    if (mode === 'restricted') {
      updateUI(false);
      setStatus('blocked', 'Blocked here', 'store / chrome:// pages deny extensions', 0);
      if (!quiet) showWarn('Extensions are blocked on this page. Open any normal website or PDF.');
      return;
    }

    if (/^file:/i.test(tab.url || '') && mode === 'web') {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(function (isAllowed) {
          if (!isAllowed) {
            showWarn('file:// page: enable “Allow access to file URLs” for VoiceScroll at chrome://extensions. (Native PDF tabs do not need this.)');
          }
        });
      }
    }

    if (hub && (hub.on || hub.wanted)) {
      updateUI(true);
      var info = { heard: '', matched: '', conf: 0 };
      try { if (chrome.storage && chrome.storage.session) { var it = await chrome.storage.session.get({ vsHubInfo: {}}); info = it.vsHubInfo || info; } } catch (e) {}
      var heard = info.heard ? '“' + String(info.heard).slice(0, 40) + '”' : 'say “down” · “up” (PDF hub)';
      setStatus('live', 'Listening (PDF mode)', heard, info.conf || 0);
      els.pill.innerHTML = '● <b>PDF mode</b> — hub listening · say “stop” to end';
      return;
    }

    var st = null;
    try { st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_STATUS' }); } catch (e) { st = null; }

    if (!st) {
      if (!quiet) updateUI(false);
      else return;
    } else {
      updateUI(!!st.on);
      if (st.on) {
        var label = st.sleeping ? 'Paused' : 'Listening';
        var heardTxt = st.heard ? '“' + String(st.heard).slice(0, 40) + '”' : 'say “down” · “up”';
        setStatus(st.sleeping ? 'sleep' : 'live', label, heardTxt, st.conf || 0);
        if (st.sleeping) els.pill.innerHTML = '● <b>Paused</b> — say “wake up”';
      }
    }
  } catch (e) {
    if (!quiet) updateUI(false);
  }
}

refreshStatus(false);
setInterval(function () { refreshStatus(true); }, 2000);
