// VoiceScroll Ultimate v25.2 — background service worker.
// Architecture:
//  - "web" tabs: in-page content.js engine (zero-latency on-page recognition)
//  - "pdf" tabs (native viewer pages no content script can enter): recognition
//    runs in the voice hub (offscreen document, tab fallback) and scrolling is
//    driven from here with TRUSTED chrome.debugger wheel/key events. This is
//    required because embedded/top-level PDFs render inside hidden browser
//    frames that untrusted synthetic events cannot reach.
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

function isScriptable(url) {
  if (!url) return false;
  // Allow file:// (works when user enables "Allow access to file URLs" in chrome://extensions)
  return !/^(chrome:|edge:|about:|chrome-extension:|moz-extension:|edge-extension:|extension:|view-source:|data:|devtools:)/i.test(url) &&
    !/^https?:\/\/chrome\.google\.com\/webstore/i.test(url) &&
    !/^https?:\/\/chromewebstore\.google\.com/i.test(url);
}

// Native PDF viewer pages (Chrome & Edge) are served from an internal mime
// handler extension: chrome-extension://<internal-id>/index.html?... The tab
// URL keeps referencing the original document for file/downloads. PDF-like
// tabs get hub mode instead of the in-page engine.
function tabMode(url) {
  if (!url) return 'restricted';
  if (/\.pdf([?#]|$)/i.test(url)) return 'pdf';
  if (/^chrome-extension:\/\/[a-z0-9]{30,44}\/index\.html\?/i.test(url)) return 'pdf';
  if (isScriptable(url)) return 'web';
  return 'restricted';
}

function updateBadge(tabId, on) {
  try {
    if (!chrome.action) return;
    if (on) {
      chrome.action.setBadgeText({ tabId: tabId, text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#16a34a' });
    } else {
      chrome.action.setBadgeText({ tabId: tabId, text: '' });
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.storage.sync.get(DEFAULTS, function (existing) {
      var fill = {};
      var need = false;
      for (var k in DEFAULTS) {
        if (existing[k] === undefined) { fill[k] = DEFAULTS[k]; need = true; }
      }
      if (need) chrome.storage.sync.set(fill);
    });
  }
});

/* ================= per-tab (web) engine helpers ================= */
async function engineReady(tabId) {
  try {
    var r = await chrome.tabs.sendMessage(tabId, { cmd: 'VS_PING' });
    return !!(r && r.pong);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ['vs-core.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ['content.js'] });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function toggleInTab(tabId) {
  var on = null;
  try {
    var resp = await chrome.tabs.sendMessage(tabId, { cmd: 'VS_TOGGLE' });
    if (resp && typeof resp.on === 'boolean') on = resp.on;
  } catch (e) {
    // If content script was not already loaded, inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ['vs-core.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ['content.js'] });
      var resp2 = await chrome.tabs.sendMessage(tabId, { cmd: 'VS_TOGGLE' });
      if (resp2 && typeof resp2.on === 'boolean') on = resp2.on;
    } catch (e2) {
      on = null;
    }
  }
  if (on !== null) updateBadge(tabId, on);
  return on;
}

/* ================= voice hub (PDF & non-scriptable mode) ================= */
var hubDesired = false;
var hubPromoted = false; // offscreen -> visible tab swap only once per session

async function createHubDocument() {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.createDocument === 'function') {
      try {
        await chrome.offscreen.createDocument({
          url: 'voice-hub.html',
          reasons: ['USER_MEDIA'],
          justification: 'Runs SpeechRecognition for hands-free scrolling while native PDFs are open'
        });
        await new Promise(function (res) { setTimeout(res, 350); }); // let hub scripts wire up
        return 'offscreen';
      } catch (e) {
        // Already exists — fine.
        return 'offscreen';
      }
    }
  } catch (e) {}
  // Fallback surface: a real tab (some browsers only grant mic to visible docs).
  try {
    var tabs = await chrome.tabs.query({});
    var existing = null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].url && tabs[i].url.indexOf(chrome.runtime.getURL('voice-hub.html')) === 0) { existing = tabs[i]; break; }
    }
    if (existing && existing.id != null) { await chrome.tabs.reload(existing.id); return 'tab'; }
    await chrome.tabs.create({ url: chrome.runtime.getURL('voice-hub.html'), active: false });
    return 'tab';
  } catch (e2) {
    return 'none';
  }
}

async function startHub(reason) {
  hubDesired = true;
  try { await chrome.storage.session.set({ vsHubWanted: '1' }); } catch (e) {}
  var mode = await createHubDocument();
  try {
    await chrome.runtime.sendMessage({ cmd: 'VS_HUB_TOGGLE', on: true, reason: reason || '' });
  } catch (e) {}
  return mode;
}

// Hidden contexts cannot prompt for mic permission. When the offscreen hub
// reports "not allowed", swap in a visible hub tab where the browser will show
// the extension-origin mic prompt. Happens at most once per session.
async function promoteHubToTab() {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {}
  try {
    var tabs = await chrome.tabs.query({});
    var existing = null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].url && tabs[i].url.indexOf(chrome.runtime.getURL('voice-hub.html')) === 0) { existing = tabs[i]; break; }
    }
    if (existing && existing.id != null) {
      // Reannounce intent before reload so the fresh page resumes listening.
      hubDesired = true;
      try { await chrome.storage.session.set({ vsHubWanted: '1' }); } catch (e) {}
      await chrome.tabs.reload(existing.id);
    } else {
      hubDesired = true;
      try { await chrome.storage.session.set({ vsHubWanted: '1' }); } catch (e) {}
      await chrome.tabs.create({ url: chrome.runtime.getURL('voice-hub.html'), active: false });
    }
  } catch (e) {}
}

async function stopHub() {
  hubDesired = false;
  hubPromoted = false; // fresh session may attempt the visible-tab swap again
  try { await chrome.storage.session.set({ vsHubWanted: '' }); } catch (e) {}
  try { await chrome.runtime.sendMessage({ cmd: 'VS_HUB_TOGGLE', on: false }); } catch (e) {}
  try {
    if (chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') await chrome.offscreen.closeDocument();
  } catch (e) {}
  await detachAllDebuggers();
  pdfAuto = {};
  try { await chrome.storage.session.set({ vsHubOn: false, vsHubPdfTabs: [] }); } catch (e) {}
  return true;
}

async function hubRunning() {
  // Prefer the hub's own live report; fall back to persisted intent.
  try {
    var r = await sendHubStatus();
    if (r && typeof r.on === 'boolean') return r.on;
  } catch (e) {}
  try {
    var it = await chrome.storage.session.get({ vsHubOn: false, vsHubWanted: '' });
    if (it.vsHubOn || it.vsHubWanted === '1') return true;
  } catch (e) {}
  return hubDesired;
}

function sendHubStatus() {
  try {
    var p = chrome.runtime.sendMessage({ cmd: 'VS_HUB_STATUS' });
    if (p && typeof p.catch === 'function') return p.catch(function () { return null; });
    return Promise.resolve(p || null);
  } catch (e) { return Promise.resolve(null); }
}

/* ================= trusted input engine (debugger) ================= */
var dbgTabs = {}; // tabId -> true while attached

chrome.debugger.onDetach.addListener(function (src) {
  if (src && src.tabId != null) delete dbgTabs[src.tabId];
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (dbgTabs[tabId]) delete dbgTabs[tabId];
  if (pdfAuto[tabId]) delete pdfAuto[tabId];
  untrackPdfTab(tabId, false);
});

// Drop a tab from PDF-mode tracking (session list + ON badge) when it closes
// or navigates away from a PDF, so the badge never sticks to a stale tab.
async function untrackPdfTab(tabId, clearBadge) {
  try {
    var it = await chrome.storage.session.get({ vsHubPdfTabs: [] });
    var list = it.vsHubPdfTabs || [];
    var i = list.indexOf(tabId);
    if (i >= 0) {
      list.splice(i, 1);
      await chrome.storage.session.set({ vsHubPdfTabs: list });
      if (clearBadge) updateBadge(tabId, false);
    }
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (!changeInfo || !changeInfo.url || tabMode(changeInfo.url) === 'pdf') return;
  if (pdfAuto[tabId]) delete pdfAuto[tabId];
  untrackPdfTab(tabId, true);
});

async function dbgAttach(tabId) {
  if (dbgTabs[tabId]) return true;
  try {
    await chrome.debugger.attach({ tabId: tabId }, '1.3');
    dbgTabs[tabId] = true;
    return true;
  } catch (e) {
    dbgTabs[tabId] = false;
    return false;
  }
}

async function dbgDetach(tabId) {
  try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  delete dbgTabs[tabId];
}

async function detachAllDebuggers() {
  var ids = Object.keys(dbgTabs);
  for (var i = 0; i < ids.length; i++) {
    var id = parseInt(ids[i], 10);
    if (dbgTabs[id]) await dbgDetach(id);
    delete dbgTabs[id];
  }
}

function dbgSend(tabId, method, params) {
  return new Promise(function (resolve) {
    try {
      chrome.debugger.sendCommand({ tabId: tabId }, method, params || {}, function (r) {
        var err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : { ok: true, value: r });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

// A trusted wheel event routed through the browser input pipeline. This is the
// ONLY mechanic that reliably scrolls embedded/top-level PDFs (their content
// lives behind a shadow-root embed / internal extension frame).
async function pdfWheel(tabId, deltaY) {
  var attached = await dbgAttach(tabId);
  if (!attached) return { ok: false, reason: 'debugger-unavailable' };
  var viewport = await dbgSend(tabId, 'Runtime.evaluate', {
    expression: '(function(){return {w:(window.innerWidth||300),h:(window.innerHeight||200)}})()',
    returnByValue: true
  });
  var w = 300, h = 200;
  if (viewport && viewport.ok && viewport.value && viewport.value.result) {
    try {
      w = Number(viewport.value.result.value.w) || 300;
      h = Number(viewport.value.result.value.h) || 200;
    } catch (e) {}
  }
  var r = await dbgSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.max(2, Math.round(w / 2)),
    y: Math.max(2, Math.round(h / 2)),
    deltaX: 0,
    deltaY: deltaY,
    modifiers: 0
  });
  return { ok: !!r.ok, reason: r.ok ? '' : (r.error || 'wheel-failed') };
}

// Trusted Home/End keys for "top"/"bottom" jumps into the PDF plugin.
async function pdfKey(tabId, key) {
  var attached = await dbgAttach(tabId);
  if (!attached) return { ok: false, reason: 'debugger-unavailable' };
  var isHome = key === 'Home';
  var code = isHome ? 36 : 35;
  var down = await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: key, code: key,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
  });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: key, code: key,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
  });
  return { ok: !!down.ok, reason: down.ok ? '' : (down.error || 'key-failed') };
}

// Does the attached tab actually show the internal PDF viewer? Cheap probe via
// the debugger; guards against edge cases (other internal extension pages).
async function pdfVerify(tabId) {
  var attached = await dbgAttach(tabId);
  if (!attached) return { ok: false, reason: 'debugger-unavailable' };
  var r = await dbgSend(tabId, 'Runtime.evaluate', {
    expression: '(function(){try{var p=(document.querySelector("embed#plugin")||document.querySelector("embed[type*=pdf]"));return !!(p||document.contentType.indexOf("pdf")>=0||/\\.pdf([?#]|$)/i.test(document.location.search))}catch(e){return false}})()',
    returnByValue: true
  });
  var v = r && r.ok && r.value && r.value.result && (r.value.result.value === true);
  return { ok: !!v, reason: v ? '' : 'not-pdf' };
}

/* ================= shared toggle ================= */
var pdfAuto = {}; // tabId -> dir while auto-scrolling a PDF via debugger
var cachedSpeed = 40;
try {
  chrome.storage.sync.get({ speed: 40 }, function (it) { cachedSpeed = clampSpeed(it && it.speed); });
  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.speed) cachedSpeed = clampSpeed(changes.speed.newValue);
  });
} catch (e) {}
function clampSpeed(n) {
  n = parseInt(n, 10);
  if (isNaN(n)) return 40;
  return Math.max(1, Math.min(100, n));
}
function pdfStep() {
  return Math.max(8, Math.round(cachedSpeed * 0.9));
}

async function routeHubCommand(msg) {
  var name = msg.name;
  var raw = msg.raw || '';
  var dir = msg.dir || 0;
  // Preserve mult 0: it encodes "all the way down/up" (edge jump).
  var mult = (typeof msg.mult === 'number' && isFinite(msg.mult) && msg.mult >= 0) ? msg.mult : 1;
  var page = !!msg.page;
  var partial = !!msg.partial;
  var tick = !!msg.tick;

  var tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  var tab = tabs && tabs[0];
  if (!tab || tab.id == null) return;

  var mode = tabMode(tab.url);

  if (name === 'auto') {
    if (mode !== 'pdf') return; // content engine owns auto-scroll on web tabs
    if (tick) {
      await pdfWheel(tab.id, dir * pdfStep());
      return;
    }
    pdfAuto[tab.id] = dir;
    return;
  }

  if (name === 'stop') {
    if (pdfAuto[tab.id]) { delete pdfAuto[tab.id]; }
    if (mode !== 'pdf') {
      try { await engineReady(tab.id); await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_CMD', name: 'stop', raw: raw }); } catch (e) {}
    }
    return;
  }

  if (mode === 'pdf') {
    var keep = /\b(keep|continue|keep going|keep scrolling|start scrolling)\b/i.test(' ' + raw + ' ');
    if ((name === 'dn' || name === 'up') && keep) {
      pdfAuto[tab.id] = name === 'dn' ? 1 : -1;
      return;
    }
    if (name === 'faster') {
      try { chrome.storage.sync.set({ speed: clampSpeed(cachedSpeed + 12) }); } catch (e) {}
      return;
    }
    if (name === 'slower') {
      try { chrome.storage.sync.set({ speed: clampSpeed(cachedSpeed - 12) }); } catch (e) {}
      return;
    }
    if (name === 'sleep' || name === 'wake') return;
    if (pdfAuto[tab.id]) {
      // Any scroll family command replaces auto-scroll, mirroring web behavior.
      delete pdfAuto[tab.id];
    }

    // "all the way down/up" arrives with mult 0 -> trusted Home/End keys.
    var upward = (name === 'up' || name === 'pu');
    if (name === 'top' || (mult === 0 && upward)) { await pdfKey(tab.id, 'Home'); return; }
    if (name === 'bot' || (mult === 0 && !upward && (name === 'dn' || name === 'pd'))) { await pdfKey(tab.id, 'End'); return; }

    var dist = 400;
    try { var cfgs = await chrome.storage.sync.get({ dist: 400 }); dist = clampNumBg(cfgs.dist, 400); } catch (e) {}

    var d = 0;
    if (name === 'pd' || name === 'pu' || page) {
      var vh = await dbgSend(tab.id, 'Runtime.evaluate', { expression: 'String(window.innerHeight||0)', returnByValue: true });
      var pageH = (vh && vh.ok && vh.value && vh.value.result ? parseInt(vh.value.result.value, 10) : 0) || 600;
      d = (upward ? -1 : 1) * Math.round(0.9 * pageH * (mult || 1));
    } else if (name === 'dn' || name === 'up') {
      d = (name === 'dn' ? 1 : -1) * Math.round(dist * (mult || 1));
    }
    if (d) await pdfWheel(tab.id, d);
    return;
  }

  if (mode === 'web') {
    try {
      var ready = await engineReady(tab.id);
      if (ready) {
        await chrome.tabs.sendMessage(tab.id, {
          cmd: 'VS_CMD', name: name, raw: raw, dir: dir,
          mult: mult, page: page, partial: partial
        });
      }
    } catch (e) {}
  }
}

function clampNumBg(n, lo) {
  n = parseInt(n, 10);
  if (isNaN(n)) return lo;
  return Math.max(50, Math.min(1000, n));
}

/* ================= master toggle (popup button / hotkey) ================= */
// Returns { on, mode } describing what happened.
async function toggleActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab || tab.id == null) return { on: false, mode: 'unknown', reason: 'no-tab' };

  var mode = tabMode(tab.url);

  // In-page engine already running? Toggle it off (web tabs only).
  try {
    var st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_STATUS' });
    if (st && st.on && mode === 'web') {
      await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_TOGGLE' });
      updateBadge(tab.id, false);
      return { on: false, mode: 'web' };
    }
  } catch (e) {}

  if (mode === 'restricted') {
    return { on: false, mode: 'restricted', reason: 'restricted' };
  }

  var hubIsRunning = await hubRunning();

  if (hubIsRunning) {
    // Hub already listening -> toggle everything off (badge cleanup for pdf tabs).
    var wants = await chrome.storage.session.get({ vsHubPdfTabs: [] });
    (wants.vsHubPdfTabs || []).forEach(function (id) { updateBadge(id, false); });
    await chrome.storage.session.set({ vsHubPdfTabs: [] });
    await stopHub();
    return { on: false, mode: 'hub' };
  }

  if (mode === 'web') {
    var on = await toggleInTab(tab.id);
    return { on: !!on, mode: 'web' };
  }

  // PDF / internal viewer tab -> hub + trusted debugger input.
  var started = await startHub('');
  var probe = await pdfVerify(tab.id);
  var pdfTabs = await chrome.storage.session.get({ vsHubPdfTabs: [] });
  var list = pdfTabs.vsHubPdfTabs || [];
  if (list.indexOf(tab.id) < 0) list.push(tab.id);
  await chrome.storage.session.set({ vsHubPdfTabs: list });
  updateBadge(tab.id, true);
  return {
    on: (started !== 'none'),
    mode: 'hub',
    pdfOk: probe.ok,
    reason: started === 'none' ? 'no-hub' : (probe.ok ? '' : probe.reason)
  };
}

chrome.commands.onCommand.addListener(function (cmd) {
  if (cmd !== 'toggle-voice-scroll') return;
  toggleActiveTab().catch(function () {});
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;

  if (msg.cmd === 'VS_BG_TOGGLE') {
    (async function () {
      try {
        var r = await toggleActiveTab();
        sendResponse({ ok: true, on: !!r.on, mode: r.mode, reason: r.reason || '' });
      } catch (e) {
        sendResponse({ ok: false, reason: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.cmd === 'VS_STATE_CHANGED' && sender && sender.tab && sender.tab.id) {
    updateBadge(sender.tab.id, !!msg.on);
    return false;
  }

  if (msg.cmd === 'VS_PING') {
    sendResponse({ pong: true });
    return false;
  }

  // Hub -> background signals
  if (msg.cmd === 'VS_HUB_HOST') {
    // Hub page came up; re-apply desired state so reloads keep listening.
    chrome.storage.session.get({ vsHubWanted: '' }).then(function (it) {
      if (it.vsHubWanted === '1') {
        hubDesired = true;
        try {
          chrome.runtime.sendMessage({ cmd: 'VS_HUB_TOGGLE', on: true });
        } catch (e) {}
      }
    }).catch(function () {});
    return false;
  }

  if (msg.cmd === 'VS_HUB_STATE') {
    hubDesired = !!msg.on;
    (async function () {
      try {
        await chrome.storage.session.set({ vsHubOn: !!msg.on, vsHubInfo: { heard: msg.heard || '', matched: msg.matched || '', conf: msg.conf || 0, err: msg.err || '' } });
      } catch (e) {}
      if (!msg.on) {
        // Hub side stopped recognition (e.g. mic error): detach & clear badges.
        var pdfTabs = await chrome.storage.session.get({ vsHubPdfTabs: [] });
        (pdfTabs.vsHubPdfTabs || []).forEach(function (id) { updateBadge(id, false); });
        await chrome.storage.session.set({ vsHubPdfTabs: [] });
        await detachAllDebuggers();
      }
    })();
    return false;
  }

  if (msg.cmd === 'VS_HUB_CMD') {
    routeHubCommand(msg).catch(function () {});
    return false;
  }

  // Hub hit a mic permission wall: promote the offscreen doc to a visible
  // extension tab (which can prompt) once; visible-hub reports are ignored.
  if (msg.cmd === 'VS_HUB_BLOQ') {
    (async function () {
      var fromVisibleTab = !!(sender && sender.tab && sender.tab.id != null);
      try {
        await chrome.storage.session.set({
          vsHubOn: false,
          vsHubInfo: { heard: '', matched: '', conf: 0, err: msg.err || 'mic-blocked' }
        });
      } catch (e) {}
      if (!fromVisibleTab && !hubPromoted) {
        hubPromoted = true;
        await promoteHubToTab();
      }
    })();
    return false;
  }

  if (msg.cmd === 'VS_HUB_STOP_ALL') {
    (async function () {
      await stopHub();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Content script fallback for embedded PDFs on normal pages.
  if (msg.cmd === 'VS_PDFFB' && sender && sender.tab && sender.tab.id != null) {
    (async function () {
      var tabId = sender.tab.id;
      var r;
      if (msg.kind === 'key') {
        r = await pdfKey(tabId, String(msg.key || 'Home'));
      } else {
        r = await pdfWheel(tabId, Math.round(msg.delta || 0));
      }
      sendResponse({ ok: !!r.ok, reason: r.reason || '' });
    })();
    return true;
  }

  if (msg.cmd === 'VS_BG_HUB_STATUS') {
    (async function () {
      try {
        var it = await chrome.storage.session.get({ vsHubOn: false, vsHubInfo: {}, vsHubPdfTabs: [] });
        sendResponse({ on: !!it.vsHubOn, info: it.vsHubInfo, pdfTabs: it.vsHubPdfTabs, wanted: hubDesired });
      } catch (e) {
        sendResponse({ on: false, info: {}, pdfTabs: [] });
      }
    })();
    return true;
  }

  return false;
});
