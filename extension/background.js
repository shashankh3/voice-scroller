// VoiceScroll Ultimate v26.0 — background service worker.
// Architecture:
//  - "web" tabs: in-page content.js engine (zero-latency on-page recognition)
//  - "pdf" tabs (native viewer pages no content script can enter): recognition
//    runs in the voice hub (offscreen document, tab fallback) and scrolling is
//    driven from here with TRUSTED chrome.debugger wheel/key events. This is
//    required because embedded/top-level PDFs render inside hidden browser
//    frames that untrusted synthetic events cannot reach.
importScripts('vs-core.js');

// Settings defaults live in vs-core so every context shares one source.
var DEFAULTS = VSCore.DEFAULTS;

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
    var ps = [];
    if (on) {
      ps.push(chrome.action.setBadgeText({ tabId: tabId, text: 'ON' }));
      ps.push(chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#16a34a' }));
      if (typeof chrome.action.setTitle === 'function') {
        ps.push(chrome.action.setTitle({ tabId: tabId, title: 'VoiceScroll is listening — click to stop' }));
      }
    } else {
      ps.push(chrome.action.setBadgeText({ tabId: tabId, text: '' }));
      if (typeof chrome.action.setTitle === 'function') {
        ps.push(chrome.action.setTitle({ tabId: tabId, title: 'VoiceScroll Ultimate — click to enable voice scrolling' }));
      }
    }
    // A closed tab makes these calls reject — swallow it instead of leaving
    // an unhandled promise rejection in the service worker.
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && typeof ps[i].catch === 'function') ps[i].catch(function () {});
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install' || details.reason === 'update') {
    VSCore.storageGet(DEFAULTS, function (existing) {
      var fill = {};
      var need = false;
      for (var k in DEFAULTS) {
        if (existing[k] === undefined) { fill[k] = DEFAULTS[k]; need = true; }
      }
      if (need) VSCore.storageSet(fill);
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

/* ================= single-listener registry =================
 * Only one recognizer may hold the microphone at a time. The tab that owns
 * the page engine is remembered in session storage so starting a new engine
 * can stop the old one (two live engines would fight over the mic and both
 * would fail with "audio-capture").
 */
async function getActiveTab() {
  try {
    var it = await chrome.storage.session.get({ vsActiveTab: -1 });
    return (it && it.vsActiveTab != null) ? it.vsActiveTab : -1;
  } catch (e) { return -1; }
}

async function setActiveTab(tabId) {
  try { await chrome.storage.session.set({ vsActiveTab: tabId }); } catch (e) {}
}

async function clearActiveTab(tabId) {
  try {
    var cur = await getActiveTab();
    if (tabId == null || cur === tabId) await chrome.storage.session.set({ vsActiveTab: -1 });
  } catch (e) {}
}

// Stop every other listener (page engines in other tabs and the PDF hub).
async function stopOtherEngines(exceptTabId) {
  var other = await getActiveTab();
  if (other !== -1 && other !== exceptTabId) {
    try { await chrome.tabs.sendMessage(other, { cmd: 'VS_STOP' }); } catch (e) {}
    updateBadge(other, false);
  }
  // The hub holds the same microphone — it has to go as well.
  if (hubDesired) await stopHub();
}

// Full "stop listening" across the browser.
async function stopEverything(alsoTabId) {
  var ids = [];
  var known = await getActiveTab();
  if (known !== -1) ids.push(known);
  if (alsoTabId != null && ids.indexOf(alsoTabId) < 0) ids.push(alsoTabId);
  for (var i = 0; i < ids.length; i++) {
    try { await chrome.tabs.sendMessage(ids[i], { cmd: 'VS_STOP' }); } catch (e) {}
    updateBadge(ids[i], false);
  }
  try { await chrome.storage.session.set({ vsActiveTab: -1 }); } catch (e) {}
  await stopHub();
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
var dbgTabs = {};      // tabId -> true while attached
var dbgViewport = {};  // tabId -> { w, h } (cached, avoids a round trip per wheel)
var dbgErrors = {};    // tabId -> why the attach failed (shown in the popup)

chrome.debugger.onDetach.addListener(function (src) {
  if (src && src.tabId != null) {
    delete dbgTabs[src.tabId];
    delete dbgViewport[src.tabId];
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (dbgTabs[tabId]) delete dbgTabs[tabId];
  delete dbgViewport[tabId];
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
  if (changeInfo && changeInfo.url) {
    // Navigation invalidates the cached viewport of that tab.
    delete dbgViewport[tabId];
  }
  if (changeInfo && changeInfo.status === 'loading') {
    // A navigation tears the page engine down. The ON badge must not survive
    // it — otherwise the toolbar keeps claiming the extension is listening.
    // PDF tabs are excluded: there the voice hub keeps the session alive.
    try {
      chrome.storage.session.get({ vsHubPdfTabs: [] }, function (it) {
        var list = (it && it.vsHubPdfTabs) || [];
        if (list.indexOf(tabId) < 0) {
          updateBadge(tabId, false);
          clearActiveTab(tabId);
        }
      });
    } catch (e) {}
  }
  if (!changeInfo || !changeInfo.url || tabMode(changeInfo.url) === 'pdf') return;
  if (pdfAuto[tabId]) delete pdfAuto[tabId];
  untrackPdfTab(tabId, true);
});

async function dbgAttach(tabId) {
  if (dbgTabs[tabId]) return true;
  try {
    await chrome.debugger.attach({ tabId: tabId }, '1.3');
    dbgTabs[tabId] = true;
    delete dbgErrors[tabId];
    return true;
  } catch (e) {
    dbgTabs[tabId] = false;
    // Keep the reason: "Another debugger is already attached" (DevTools is
    // open) needs a very different hint than a missing API.
    dbgErrors[tabId] = String((e && e.message) || e);
    return false;
  }
}

async function dbgDetach(tabId) {
  try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  delete dbgTabs[tabId];
  delete dbgViewport[tabId];
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
  if (!attached) return { ok: false, reason: dbgErrors[tabId] || 'debugger-unavailable' };
  var vp = await pdfViewport(tabId);
  var r = await dbgSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.max(2, Math.round(vp.w / 2)),
    y: Math.max(2, Math.round(vp.h / 2)),
    deltaX: 0,
    deltaY: deltaY,
    modifiers: 0
  });
  return { ok: !!r.ok, reason: r.ok ? '' : (r.error || 'wheel-failed') };
}

// Viewport size of the attached tab. Cached per tab because the auto-scroll
// loop asks for it on every tick — a debugger round trip per wheel event is
// expensive and visibly lags the glide.
async function pdfViewport(tabId) {
  var cached = dbgViewport[tabId];
  if (cached && cached.w > 0 && cached.h > 0) return cached;
  var w = 300, h = 200;
  try {
    var viewport = await dbgSend(tabId, 'Runtime.evaluate', {
      expression: '(function(){return {w:(window.innerWidth||300),h:(window.innerHeight||200)}})()',
      returnByValue: true
    });
    if (viewport && viewport.ok && viewport.value && viewport.value.result) {
      w = Number(viewport.value.result.value.w) || 300;
      h = Number(viewport.value.result.value.h) || 200;
    }
  } catch (e) {}
  dbgViewport[tabId] = { w: w, h: h };
  return dbgViewport[tabId];
}

// Trusted Home/End keys for "top"/"bottom" jumps into the PDF plugin.
async function pdfKey(tabId, key) {
  var attached = await dbgAttach(tabId);
  if (!attached) return { ok: false, reason: dbgErrors[tabId] || 'debugger-unavailable' };
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
  if (!attached) return { ok: false, reason: dbgErrors[tabId] || 'debugger-unavailable' };
  var r = await dbgSend(tabId, 'Runtime.evaluate', {
    expression: '(function(){try{var p=(document.querySelector("embed#plugin")||document.querySelector("embed[type*=pdf]"));return !!(p||document.contentType.indexOf("pdf")>=0||/\\.pdf([?#]|$)/i.test(document.location.search))}catch(e){return false}})()',
    returnByValue: true
  });
  var v = r && r.ok && r.value && r.value.result && (r.value.result.value === true);
  return { ok: !!v, reason: v ? '' : 'not-pdf' };
}

/* ================= shared toggle ================= */
var pdfAuto = {};    // tabId -> dir while auto-scrolling a PDF via debugger
var lastDelta = {};  // tabId -> last wheel amount (for the "undo" command)
var cachedSpeed = 40;
try {
  VSCore.storageGet({ speed: 40 }, function (it) { cachedSpeed = clampSpeed(it && it.speed); });
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
    // The hub surfaces the cheat sheet itself; nothing to drive on the PDF tab.
    if (name === 'help') return;
    var keep = VSCore.isKeep(raw);
    if ((name === 'dn' || name === 'up') && keep) {
      pdfAuto[tab.id] = name === 'dn' ? 1 : -1;
      return;
    }
    if (name === 'faster') {
      try { VSCore.storageSet({ speed: clampSpeed(cachedSpeed + 12) }); } catch (e) {}
      return;
    }
    if (name === 'slower') {
      try { VSCore.storageSet({ speed: clampSpeed(cachedSpeed - 12) }); } catch (e) {}
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

    // "undo" takes back the last step (the PDF path has no page engine, so
    // the amount is tracked here).
    if (name === 'undo') {
      var back = lastDelta[tab.id] || 0;
      if (!back) return;
      await pdfWheel(tab.id, -back);
      lastDelta[tab.id] = -back;
      return;
    }

    var dist = 400;
    try { var cfgs = await new Promise(function (r) { VSCore.storageGet({ dist: 400 }, r); }); dist = clampNumBg(cfgs && cfgs.dist, 400); } catch (e) {}

    var d = 0;
    if (name === 'pd' || name === 'pu' || page) {
      var vp = await pdfViewport(tab.id);
      var pageH = vp.h || 600;
      d = (upward ? -1 : 1) * Math.round(0.9 * pageH * (mult || 1));
    } else if (name === 'dn' || name === 'up') {
      d = (name === 'dn' ? 1 : -1) * Math.round(dist * (mult || 1));
    }
    if (d) {
      await pdfWheel(tab.id, d);
      lastDelta[tab.id] = d;
    }
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
// Returns { on, mode } describing what happened. The toggle is global: one
// recognizer at a time, anywhere in the browser.
async function toggleActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab || tab.id == null) return { on: false, mode: 'unknown', reason: 'no-tab' };

  var mode = tabMode(tab.url);

  // Is anything listening right now (this tab, another tab, or the hub)?
  var pageOn = false;
  try {
    var st = await chrome.tabs.sendMessage(tab.id, { cmd: 'VS_STATUS' });
    pageOn = !!(st && st.on);
  } catch (e) {}
  var hubIsRunning = await hubRunning();
  var registered = await getActiveTab();
  var listeningElsewhere = (registered !== -1 && registered !== tab.id);

  if (pageOn || hubIsRunning || listeningElsewhere) {
    // Toggle off: stop every listener (page engines + hub) and clean badges.
    var wants = await chrome.storage.session.get({ vsHubPdfTabs: [] });
    (wants.vsHubPdfTabs || []).forEach(function (id) { updateBadge(id, false); });
    await chrome.storage.session.set({ vsHubPdfTabs: [] });
    await stopEverything(tab.id);
    return { on: false, mode: mode === 'pdf' ? 'hub' : 'web', stopped: true };
  }

  if (mode === 'restricted') {
    return { on: false, mode: 'restricted', reason: 'restricted' };
  }

  if (mode === 'web') {
    // Retire any other listener FIRST — two live recognizers would fight
    // over the microphone.
    await stopOtherEngines(tab.id);
    var on = await toggleInTab(tab.id);
    if (on) await setActiveTab(tab.id);
    return { on: !!on, mode: 'web' };
  }

  // PDF / internal viewer tab -> hub + trusted debugger input.
  // A page engine in another tab must release the microphone first.
  await stopOtherEngines(null);
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
    reason: started === 'none' ? 'no-hub' : (probe.ok ? '' : (probe.reason || '')),
    dbgError: dbgErrors[tab.id] || ''
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
        // "stopped" tells the popup that the click really turned listening
        // off — without it a successful stop looks like a failure.
        sendResponse({
          ok: true, on: !!r.on, mode: r.mode, stopped: !!r.stopped,
          reason: r.reason || '', dbgError: r.dbgError || ''
        });
      } catch (e) {
        sendResponse({ ok: false, reason: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.cmd === 'VS_STATE_CHANGED' && sender && sender.tab && sender.tab.id) {
    updateBadge(sender.tab.id, !!msg.on);
    // Keep the single-listener registry in sync with the page engines.
    if (msg.on) setActiveTab(sender.tab.id);
    else clearActiveTab(sender.tab.id);
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
        await chrome.storage.session.set({
          vsHubOn: !!msg.on,
          vsHubInfo: { heard: msg.heard || '', matched: msg.matched || '', conf: msg.conf || 0, err: msg.err || '' }
        });
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
        var it = await chrome.storage.session.get({ vsHubOn: false, vsHubInfo: {}, vsHubPdfTabs: [], vsHubWanted: '' });
        // "wanted" survives a service worker restart, "hubDesired" does not.
        sendResponse({
          on: !!it.vsHubOn,
          wanted: !!(hubDesired || it.vsHubWanted === '1'),
          info: it.vsHubInfo,
          pdfTabs: it.vsHubPdfTabs
        });
      } catch (e) {
        sendResponse({ on: false, wanted: false, info: {}, pdfTabs: [] });
      }
    })();
    return true;
  }

  return false;
});
