/* Resilience / fault-injection tests for VoiceScroll Ultimate.
 * Run: node tests/test-resilience.js   (no dependencies)
 *
 * "Works flawlessly" means surviving the things that actually go wrong in
 * the field: a speech service that refuses to start, a page that cannot be
 * scrolled, storage that is unavailable, and a long session.
 */
'use strict';
const { makeWindow, makeChrome, makeFakeSR, makeSpeaker, loadInto } = require('./mock-browser');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(value, label) {
  if (value) { passed++; }
  else { failed++; console.error('FAIL: ' + label); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Load the page engine and start it. Returns a speaker that mimics Chrome
// (every utterance gets a new result index) and always talks to the
// recognizer that is currently running — after a restart the previous
// instance is stale and its events are ignored on purpose.
function startEngine(opts) {
  opts = opts || {};
  const win = makeWindow(opts);
  const mock = makeChrome(win, opts);
  const store = [];
  win.SpeechRecognition = makeFakeSR(store, opts);
  loadInto(win, 'vs-core.js');
  loadInto(win, 'content.js');
  win.__vs.start();
  const speakers = new Map();
  const say = function (text, isFinal) {
    const rec = store[store.length - 1];
    if (!rec) return;
    if (!speakers.has(rec)) speakers.set(rec, makeSpeaker(rec));
    speakers.get(rec)(text, isFinal);
  };
  return { win, mock, store, say: say };
}

/* ---------- 1. the speech service refuses to start, then recovers ---------- */
async function startRetryTest() {
  const t = startEngine({ failTimes: 2 });
  await sleep(900);
  ok(t.store.length >= 3, 'retry: the engine keeps trying to start the recognizer (' + t.store.length + ' attempts)');
  ok(t.win.__vs.status() === true, 'retry: the engine is listening after the service recovered');
  t.say('down');
  await sleep(200);
  ok(t.win.scrollToCalls.length > 0, 'retry: commands work after the recovery');
}

/* ---------- 2. the speech service never starts ---------- */
async function startGiveUpTest() {
  const t = startEngine({ alwaysFail: true });
  await sleep(1400);
  eq(t.win.__vs.status(), false, 'give up: the engine stops instead of looping');
  ok(t.store.length <= 5, 'give up: the retries are bounded (' + t.store.length + ' attempts)');
  let status = null;
  t.mock.listeners.message.forEach(function (fn) {
    fn({ cmd: 'VS_STATUS' }, { id: 'tab' }, function (r) { status = r; });
  });
  eq(status && status.err, 'start-failed', 'give up: the failure is reported');
}

/* ---------- 3. a page that cannot be scrolled ---------- */
async function nothingToScrollTest() {
  const t = startEngine({ scrollLocked: true });
  t.win.document.documentElement.scrollHeight = 100;
  t.win.document.body.scrollHeight = 100;
  t.say('down');
  await sleep(700);
  // The trusted-input relay is the last resort and must have been used.
  const relayed = t.mock.calls.sendMessage.some(function (m) { return m && m.cmd === 'VS_PDFFB'; });
  ok(relayed, 'no scroll: the trusted-input relay is used as the last resort');
}

/* ---------- 4. storage is unavailable ---------- */
async function storageBrokenTest() {
  const t = startEngine({ storageThrows: true });
  let threw = false;
  try { t.win.__vs.start(); } catch (e) { threw = true; }
  ok(!threw, 'storage: a broken storage API does not break the engine');
  await sleep(120);
  ok(t.win.__vs.status() === true, 'storage: the engine still listens');
  t.say('down');
  await sleep(200);
  ok(t.win.scrollToCalls.length > 0, 'storage: commands still work');
}

/* ---------- 5. a long session must not grow without bound ---------- */
async function longSessionTest() {
  const t = startEngine();
  const words = ['down', 'up', 'page down', 'page up', 'top', 'bottom', 'stop'];
  for (let i = 0; i < 120; i++) t.say(words[i % words.length], true);
  await sleep(300);
  const grids = t.win.document.body.children.filter(function (c) {
    return String(c.className || '').indexOf('vs-grid') === 0;
  });
  ok(grids.length <= 1, 'session: no overlay leak after 120 commands (' + grids.length + ' grids)');
  ok(t.win.scrollToCalls.length > 0, 'session: the engine is still working');
  eq(t.win.__vs.status(), true, 'session: the engine is still listening');
}

/* ---------- 6. a stale recognizer must never act ---------- */
async function staleRecognizerTest() {
  const t = startEngine();
  const first = t.store[0];
  // Force a restart so the first instance becomes stale.
  first.onend();
  await sleep(400);
  const callsBefore = t.win.scrollToCalls.length;
  // The stale instance still fires a result — it must be ignored.
  first.onresult({
    resultIndex: 0,
    results: [{ length: 1, isFinal: true, 0: { transcript: 'down', confidence: 0.9 } }]
  });
  await sleep(200);
  eq(t.win.scrollToCalls.length, callsBefore, 'stale: an old recognizer cannot scroll the page');
}

/* ---------- 7. commands while the engine is being stopped ---------- */
async function stopRaceTest() {
  const t = startEngine();
  t.say('down');
  let threw = false;
  try {
    t.mock.listeners.message.forEach(function (fn) {
      fn({ cmd: 'VS_STOP' }, { id: 'tab' }, function () {});
    });
    t.say('up');
  } catch (e) { threw = true; }
  ok(!threw, 'race: stopping while a command runs does not throw');
  eq(t.win.__vs.status(), false, 'race: the engine is stopped');
}

/* ---------- 8. rapid commands must move the full distance ---------- */
async function rapidCommandsTest() {
  const t = startEngine();
  // "down down" 120 ms apart: the first glide must not be truncated.
  t.say('down');
  await sleep(120);
  t.say('down');
  await sleep(600);
  ok(Math.abs(t.win.scrollY - 800) < 40,
    'rapid: two quick commands move the full distance (moved ' + t.win.scrollY + ', expected ~800)');

  t.say('down');
  await sleep(600);
  ok(Math.abs(t.win.scrollY - 1200) < 40,
    'rapid: a third command keeps adding up (moved ' + t.win.scrollY + ', expected ~1200)');
}

/* ---------- 9. the undo must undo exactly one step ---------- */
async function undoOneStepTest() {
  const t = startEngine();
  t.say('down');
  await sleep(500);
  t.say('down');
  await sleep(500);
  const afterTwo = t.win.scrollY;
  t.say('undo');
  await sleep(500);
  ok(Math.abs(t.win.scrollY - (afterTwo - 400)) < 40,
    'undo: it takes back exactly one step (was ' + afterTwo + ', now ' + t.win.scrollY + ')');
  t.say('undo');
  await sleep(500);
  ok(Math.abs(t.win.scrollY) < 40, 'undo: a second undo goes back to the start (now ' + t.win.scrollY + ')');
}

/* ---------- 10. the same utterance must never scroll twice ---------- */
async function noDoubleScrollTest() {
  const t = startEngine();
  // One utterance delivered three times (interim, interim, final).
  const results = [{ length: 1, isFinal: true, 0: { transcript: 'down', confidence: 0.9 } }];
  t.store[0].onresult({ resultIndex: 0, results });
  await sleep(120);
  t.store[0].onresult({ resultIndex: 0, results });
  await sleep(120);
  t.store[0].onresult({ resultIndex: 0, results });
  await sleep(600);
  ok(Math.abs(t.win.scrollY - 400) < 40,
    'no double: one utterance scrolls exactly once (moved ' + t.win.scrollY + ', expected ~400)');
}

(async function run() {
  await startRetryTest();
  await startGiveUpTest();
  await nothingToScrollTest();
  await storageBrokenTest();
  await longSessionTest();
  await staleRecognizerTest();
  await stopRaceTest();
  await rapidCommandsTest();
  await undoOneStepTest();
  await noDoubleScrollTest();
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('ERROR during resilience tests:', e);
  process.exit(1);
});
