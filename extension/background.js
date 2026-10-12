// VoiceScroll Ultimate v24 — background service worker.
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
  return !/^(chrome:|edge:|about:|chrome-extension:|moz-extension:|view-source:|data:)/i.test(url) &&
    !/^https?:\/\/chrome\.google\.com\/webstore/i.test(url) &&
    !/^https?:\/\/chromewebstore\.google\.com/i.test(url);
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

async function toggleInTab(tabId) {
  var on = null;
  try {
    var resp = await chrome.tabs.sendMessage(tabId, { cmd: 'VS_TOGGLE' });
    if (resp && typeof resp.on === 'boolean') on = resp.on;
  } catch (e) {
    // If content script was not already loaded, inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
      var resp2 = await chrome.tabs.sendMessage(tabId, { cmd: 'VS_TOGGLE' });
      if (resp2 && typeof resp2.on === 'boolean') on = resp2.on;
    } catch (e2) {
      try {
        var res = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function () { return window.__vs ? window.__vs.toggle() : null; }
        });
        var v = res && res[0] && res[0].result;
        if (v && typeof v.then === 'function') v = await v;
        on = (v === null || v === undefined) ? null : !!v;
      } catch (e3) {
        on = null;
      }
    }
  }
  if (on !== null) updateBadge(tabId, on);
  return on;
}

chrome.commands.onCommand.addListener(function (cmd) {
  if (cmd !== 'toggle-voice-scroll') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(async function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    if (!isScriptable(tab.url)) return;
    await toggleInTab(tab.id);
  }).catch(function () {});
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.cmd === 'VS_BG_TOGGLE') {
    (async function () {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs && tabs[0];
      if (!tab || !tab.id || !isScriptable(tab.url)) { sendResponse({ ok: false, reason: 'restricted' }); return; }
      var on = await toggleInTab(tab.id);
      sendResponse({ ok: on !== null, on: !!on });
    })();
    return true;
  }
  if (msg.cmd === 'VS_STATE_CHANGED' && sender && sender.tab && sender.tab.id) {
    updateBadge(sender.tab.id, !!msg.on);
    return false;
  }
  return false;
});
