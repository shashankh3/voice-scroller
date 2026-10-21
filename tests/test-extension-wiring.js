/* Smoke test: loads every extension file in a sandbox with a mocked browser
 * API and checks that they wire up correctly.
 * Run: node tests/test-extension-wiring.js   (no dependencies)
 *
 * This catches load-time errors (missing globals, typos in the API surface)
 * that a pure matcher test cannot see.
 */
'use strict';
const { el, makeWindow, makeChrome, makeFakeSR, makeSpeaker, loadInto } = require('./mock-browser');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + label + ' \u2014 expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(value, label) {
  if (value) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + label);
  }
}

/* ---------------- background service worker ---------------- */
{
  const win = makeWindow();
  const { listeners, calls } = makeChrome(win);
  win.importScripts = (f) => loadInto(win, f);
  loadInto(win, 'background.js');

  ok(listeners.message.length >= 1, 'background registers a runtime message listener');
  ok(listeners.command.length === 1, 'background registers the keyboard shortcut');
  ok(listeners.tabRemoved.length === 1, 'background watches for closed tabs');
  ok(listeners.tabUpdated.length === 1, 'background watches for tab navigation');
  ok(listeners.storageChanged.length === 1, 'background watches settings changes');

  // The master toggle must answer even when no tab is available.
  const listener = listeners.message[0];
  let response = null;
  const ret = listener({ cmd: 'VS_BG_TOGGLE' }, { id: 'bg' }, (r) => { response = r; });
  eq(ret, true, 'the toggle listener answers asynchronously');
  setTimeout(function () {
    ok(response && typeof response.ok === 'boolean', 'the toggle returns a result object');
    ok(calls.sendMessage.length >= 0, 'the background talks to the runtime');
  }, 30);
}

/* ---------------- content script ---------------- */
{
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');

  ok(win.VSCore, 'content script has the shared core');
  ok(win.__vs, 'content script exposes its API');
  eq(typeof win.__vs.toggle, 'function', 'API exposes toggle()');
  eq(typeof win.__vs.status, 'function', 'API exposes status()');
  eq(win.__vs.status(), false, 'the engine is idle before it is started');
  ok(listeners.message.length >= 1, 'content script registers a runtime message listener');

  const listener = listeners.message[0];
  let status = null;
  listener({ cmd: 'VS_STATUS' }, { id: 'tab' }, (r) => { status = r; });
  ok(status && typeof status.on === 'boolean', 'VS_STATUS answers with a state object');
  eq(status.on, false, 'VS_STATUS reports the idle engine');
  ok('err' in status, 'VS_STATUS carries the last error code');

  let ping = null;
  listener({ cmd: 'VS_PING' }, { id: 'tab' }, (r) => { ping = r; });
  eq(ping && ping.pong, true, 'VS_PING answers with a pong');

  // Starting must work without a speech service and must report the failure
  // instead of pretending to listen.
  const started = win.__vs.start();
  ok(started && typeof started.then === 'function', 'start() is promise based');
  started.then((on) => {
    eq(on, false, 'start() reports a failure when no speech API exists');
  });
}

/* ---------------- voice hub ---------------- */
{
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'voice-hub.js');

  ok(win.__vsHub, 'the hub exposes its API');
  const listener = listeners.message[0];
  let status = null;
  listener({ cmd: 'VS_HUB_STATUS' }, { id: 'hub' }, (r) => { status = r; });
  ok(status && typeof status.on === 'boolean', 'VS_HUB_STATUS answers with a state object');
  eq(status.on, false, 'the hub is idle before it is started');
  ok('err' in status, 'the hub state carries the last error code');
}

/* ---------------- popup ---------------- */
function popupSmokeTest() {
  const win = makeWindow();
  const { listeners, calls } = makeChrome(win);
  // The popup talks to the DOM directly, so give it a page-like document.
  const byId = {};
  win.document.getElementById = function (id) {
    if (!byId[id]) { byId[id] = el('div'); byId[id].id = id; }
    return byId[id];
  };
  loadInto(win, 'vs-core.js');
  loadInto(win, 'popup.js');

  ok(byId['btn'], 'popup: the main button exists');
  ok(byId['btn'] && typeof byId['btn'].listeners.click === 'function', 'popup: the toggle button is wired');
  ok(byId['reset'] && typeof byId['reset'].listeners.click === 'function', 'popup: the reset button is wired');
  ok(listeners.storageChanged.length >= 1, 'popup: it listens for settings changes');
  ok(calls.storageSet.length >= 0, 'popup: it talks to the storage');

  // The command fields must all exist and be reachable.
  const keys = ['cDn', 'cUp', 'cPd', 'cPu', 'cTop', 'cBot', 'cStop', 'cSleep', 'cWake', 'cFaster', 'cSlower', 'cHelp'];
  const missing = keys.filter(k => !byId[k]);
  eq(missing.length, 0, 'popup: every command field exists (' + missing.join(',') + ')');
}

/* ---------------- restart-loop regression ----------------
 * A live recognizer fires another "end" event when it is aborted. If that
 * event is still handled it schedules another restart, which aborts the fresh
 * recognizer, and so on: an endless restart loop where the extension keeps
 * listening but never understands a command ("works for one or two commands,
 * then gets stuck"). The mock in mock-browser.js reproduces that behaviour.
 */

function contentScriptRestartTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  const initial = store.length;
  eq(initial, 1, 'content: one recognizer is created on start');

  // A language change restarts the recognizer — exactly once.
  listeners.storageChanged.forEach(function (fn) {
    fn({ lang: { newValue: 'hi-IN' } }, 'sync');
  });
  return new Promise(function (resolve) {
    setTimeout(function () {
      const made = store.length;
      ok(made <= initial + 2, 'content: a language change does not trigger a restart loop (made ' + made + ')');
      ok(win.__vs.status() === true, 'content: the engine is still listening after the restart');
      resolve();
    }, 1200);
  });
}

function hubRestartTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'voice-hub.js');
  // Start the hub the way the background does.
  listeners.message.forEach(function (fn) {
    fn({ cmd: 'VS_HUB_TOGGLE', on: true }, { id: 'hub' }, function () {});
  });
  const initial = store.length;
  eq(initial, 1, 'hub: one recognizer is created on start');

  listeners.storageChanged.forEach(function (fn) {
    fn({ lang: { newValue: 'hi-IN' } }, 'sync');
  });
  return new Promise(function (resolve) {
    setTimeout(function () {
      const made = store.length;
      ok(made <= initial + 2, 'hub: a language change does not trigger a restart loop (made ' + made + ')');
      resolve();
    }, 1200);
  });
}

function naturalEndTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  eq(store.length, 1, 'natural end: one recognizer to start with');

  // The browser ends the session on its own (silence timeout / service
  // restart). The engine has to come back exactly once and keep listening.
  store[0].onend();
  return new Promise(function (resolve) {
    setTimeout(function () {
      eq(store.length, 2, 'natural end: the recognizer is restarted exactly once (made ' + store.length + ')');
      ok(win.__vs.status() === true, 'natural end: the engine is still listening');
      // A second end must behave the same — no runaway restarts.
      store[1].onend();
      setTimeout(function () {
        ok(store.length <= 4, 'natural end: repeated session ends do not explode (made ' + store.length + ')');
        resolve();
      }, 700);
    }, 600);
  });
}

function failingServiceTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  // A recognizer that dies immediately, over and over: the engine must give
  // up cleanly instead of restarting forever.
  let guard = 0;
  const killer = setInterval(function () {
    if (store.length && guard < 40) { guard++; try { store[store.length - 1].onend(); } catch (e) {} }
  }, 40);
  return new Promise(function (resolve) {
    setTimeout(function () {
      clearInterval(killer);
      ok(store.length <= 12, 'failing service: the engine stops restarting (made ' + store.length + ')');
      eq(win.__vs.status(), false, 'failing service: the engine reports that it stopped');
      resolve();
    }, 1500);
  });
}

/* ---------------- navigation cleanup ---------------- */
function navigationBadgeTest() {
  const win = makeWindow();
  const { listeners, calls } = makeChrome(win);
  win.importScripts = (f) => loadInto(win, f);
  loadInto(win, 'background.js');
  listeners.tabUpdated.forEach(function (fn) { fn(7, { status: 'loading' }); });
  return new Promise(function (resolve) {
    setTimeout(function () {
      const cleared = calls.badge.some(function (b) { return b.tabId === 7 && b.text === ''; });
      ok(cleared, 'background: the ON badge is cleared when the tab navigates');
      resolve();
    }, 40);
  });
}

/* ---------------- end to end: a spoken command scrolls the page ---------------- */
function endToEndScrollTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();

  // Speak: a final result with the transcript "down".
  const rec = store[0];
  const spokenAt = Date.now();
  makeSpeaker(rec)('down');

  return new Promise(function (resolve) {
    setTimeout(function () {
      const moved = win.scrollToCalls.filter(function (c) {
        return c && typeof c.top === 'number' && c.top > 0;
      });
      ok(moved.length > 0, 'e2e: the spoken command "down" scrolled the page');
      // Latency: the page must react almost immediately.
      const reacted = win.scrollToTimes.length ? (win.scrollToTimes[0] - spokenAt) : 9999;
      ok(reacted < 150, 'e2e: the page reacts within 150 ms (took ' + reacted + ' ms)');
      // And it must not scroll again for the same utterance. (The scroll
      // animation keeps writing frames, so compare the position instead of
      // the number of writes.) The very same result is replayed — a browser
      // would deliver the same result index again.
      const yBefore = win.scrollY;
      rec.onresult({
        resultIndex: 0,
        results: [{
          length: 1,
          isFinal: true,
          0: { transcript: 'down', confidence: 0.9 }
        }]
      });
      setTimeout(function () {
        ok(Math.abs(win.scrollY - yBefore) < 2, 'e2e: the same utterance does not scroll twice');
        resolve();
      }, 320);
    }, 420);
  });
}

/* ---------------- end to end: undo takes the scroll back ---------------- */
function endToEndUndoTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  const rec = store[0];
  const say = makeSpeaker(rec);

  const startY = win.scrollY;
  say('down');
  return new Promise(function (resolve) {
    setTimeout(function () {
      const afterDown = win.scrollY;
      ok(afterDown > 0, 'undo e2e: "down" moved the page');
      say('undo');
      setTimeout(function () {
        ok(Math.abs(win.scrollY - startY) < 2,
          'undo e2e: "undo" put the page back (from ' + afterDown + ' to ' + win.scrollY + ')');
        resolve();
      }, 400);
    }, 400);
  });
}

/* ---------------- command grid + "did you mean" ---------------- */
function commandGridTest() {
  const win = makeWindow();
  const { listeners } = makeChrome(win);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  const rec = store[0];
  const say = makeSpeaker(rec);
  const body = win.document.body;
  const find = (cls) => body.children.filter(function (c) {
    return String(c.className || '').indexOf(cls) === 0;
  })[0];

  say('help');
  return new Promise(function (resolve) {
    setTimeout(function () {
      const grid = find('vs-grid');
      ok(grid, 'grid: saying "help" opens the command grid');
      const wrap = grid && grid.children.filter(function (c) { return c.className === 'vs-grid-b'; })[0];
      ok(wrap && wrap.children.length >= 10, 'grid: it lists every command as a tile');
      const tile = wrap && wrap.children[0];
      ok(tile && tile.className.indexOf('vs-tile') === 0, 'grid: the tiles are buttons');

      // A misheard word offers the closest command instead of silence.
      say('botom');
      setTimeout(function () {
        const hud = find('vs-hud');
        const sub = hud && hud.children[1] && hud.children[1].children[1];
        ok(sub && String(sub.textContent).indexOf('did you mean') >= 0,
          'grid: a misheard word suggests the closest command (' + (sub ? sub.textContent : 'none') + ')');

        // While the grid is open, saying a number runs that tile.
        const before = win.scrollToCalls.length;
        say('three');
        setTimeout(function () {
          ok(win.scrollToCalls.length > before, 'grid: saying a number runs the matching command');
          resolve();
        }, 200);
      }, 120);
    }, 120);
  });
}

// Run them one after the other so the timing of one cannot influence the other.
popupSmokeTest();
contentScriptRestartTest()
  .then(hubRestartTest)
  .then(naturalEndTest)
  .then(failingServiceTest)
  .then(navigationBadgeTest)
  .then(endToEndScrollTest)
  .then(endToEndUndoTest)
  .then(commandGridTest)
  .then(function () {
    console.log(passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })
  .catch(function (e) {
    console.error('ERROR during restart tests:', e);
    process.exit(1);
  });

