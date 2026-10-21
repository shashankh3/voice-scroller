/* Regression tests for the shared engine (extension/vs-core.js).
 * Run: node tests/test-vs-core.js   (no dependencies)
 *
 * Covers the homophone table, the EXACT_ONLY collision guards, quantifiers,
 * edge jumps, sensitivities, custom phrase overrides, the हिन्दी locale pack
 * and the shared interim/final speech engine (dedup, settling, upgrades and
 * the "final transcript wins" rule).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'vs-core.js'), 'utf8');
const sandbox = { window: {}, self: {}, setTimeout, clearTimeout, setInterval, clearInterval };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const VSCore = sandbox.VSCore || sandbox.window.VSCore;
if (!VSCore) { console.error('FAIL: VSCore did not load'); process.exit(1); }

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
  else {
    failed++;
    console.error('FAIL: ' + label);
  }
}
function cmdOf(matcher, raw) {
  const hit = matcher.parseCommand(raw);
  return hit ? hit.cmd : null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Mirrors the DEFAULTS command phrases from the popup — real callers always
// build the matcher from a cfg containing these fields.
const PHRASE_DEFAULTS = {
  cDn: 'down, scroll down, go down, move down',
  cUp: 'up, scroll up, go up, move up',
  cPd: 'page down, next page, page forward',
  cPu: 'page up, previous page, page back',
  cTop: 'top, go to top, scroll to top',
  cBot: 'bottom, go to bottom, scroll to bottom',
  cStop: 'stop, halt, freeze, stop scrolling',
  cUndo: 'undo, undo that, take it back, back up',
  cSleep: 'sleep, pause, pause listening',
  cWake: 'wake up, wake, resume, start listening',
  cFaster: 'faster, speed up, quicker, go faster',
  cSlower: 'slower, slow down, speed down, go slower',
  cHelp: 'help, what can i say, show commands'
};

const m = VSCore.createMatcher(Object.assign({ sensitivity: 'balanced' }, PHRASE_DEFAULTS));

// --- normalize ---
eq(VSCore.normalize('  Hello,  WORLD! '), 'hello world', 'normalize strips punctuation/case');

// --- core commands ---
eq(cmdOf(m, 'down'), 'dn', 'down -> dn');
eq(cmdOf(m, 'scroll down'), 'dn', 'scroll down -> dn');
eq(cmdOf(m, 'go down a bit please'), 'dn', 'filler words tolerated');
eq(cmdOf(m, 'up'), 'up', 'up -> up');
eq(cmdOf(m, 'page down'), 'pd', 'page down -> pd');
eq(cmdOf(m, 'next page'), 'pd', 'next page -> pd');
eq(cmdOf(m, 'top'), 'top', 'top -> top');
eq(cmdOf(m, 'go to top'), 'top', 'go to top -> top');
eq(cmdOf(m, 'bottom'), 'bot', 'bot -> bot');
eq(cmdOf(m, 'stop'), 'stop', 'stop -> stop');
eq(cmdOf(m, 'stop scrolling'), 'stop', 'longer phrase wins');
eq(cmdOf(m, 'sleep'), 'sleep', 'sleep -> sleep');
eq(cmdOf(m, 'wake up'), 'wake', 'wake -> wake');
eq(cmdOf(m, 'faster'), 'faster', 'faster -> faster');
eq(cmdOf(m, 'slower'), 'slower', 'slower -> slower');

// --- homophones (curated mishearings always corrected) ---
eq(cmdOf(m, 'done'), 'dn', 'done -> down');
eq(cmdOf(m, 'town'), 'dn', 'town -> down');
eq(cmdOf(m, 'app'), 'up', 'up -> app');
eq(cmdOf(m, 'stock'), 'stop', 'stock -> stop');
eq(cmdOf(m, 'awake'), 'wake', 'awake -> wake');

// --- collision guards (common words must NOT trigger commands) ---
eq(cmdOf(m, 'wait'), null, 'wait must not become wake');
eq(cmdOf(m, 'stops'), null, 'stops must not become stop');
eq(cmdOf(m, 'step'), null, 'step must not become stop');
eq(cmdOf(m, 'fast'), null, 'fast must not become faster');
eq(cmdOf(m, 'slowly'), null, 'slowly alone is not a command');
eq(cmdOf(m, 'button'), null, 'button must not become bottom');
eq(cmdOf(m, 'the browser limits'), null, 'random text -> no command');
eq(cmdOf(m, 'download'), null, 'download must not become down');
eq(cmdOf(m, 'come up with a plan'), 'up', '...but the exact word "up" still works');

// --- quantifiers ---
eq(m.parseModifier('down three', 'dn').mult, 3, 'down three -> x3');
eq(m.parseModifier('down twice', 'dn').mult, 2, 'down twice -> x2');
eq(m.parseModifier('down a little', 'dn').mult, 0.35, 'down a little -> nudge');
eq(m.parseModifier('down a lot', 'dn').mult, 2.5, 'down a lot -> x2.5');
eq(m.parseModifier('half page', 'dn').page, true, 'half page -> page flag');
eq(m.parseModifier('half page', 'dn').mult, 0.5, 'half page -> x0.5');
eq(m.parseModifier('down', 'dn').mult, 1, 'bare down -> x1');
eq(m.parseModifier('down 50', 'dn').mult, 10, 'huge digit count is clamped');
eq(m.parseModifier('stop three', 'stop').mult, 1, 'quantifiers ignored for non-scroll commands');
eq(m.parseModifier('down three', 'stop').mult, 1, 'quantifiers ignored for stop');

// --- edge jumps ---
eq(m.parseModifier('all the way down', 'dn').edge, 'bot', 'all the way down -> bottom edge');
eq(m.parseModifier('all the way up', 'up').edge, 'top', 'all the way up -> top edge');
eq(cmdOf(m, 'all the way down'), 'dn', 'all the way down still parses as dn');
eq(cmdOf(m, 'all the way up'), 'up', 'all the way up still parses as up');

// --- sensitivity levels ---
const strict = VSCore.createMatcher(Object.assign({ sensitivity: 'strict' }, PHRASE_DEFAULTS));
eq(cmdOf(strict, 'done'), 'dn', 'homophones still work in strict');
eq(cmdOf(strict, 'doen'), null, 'no fuzzy matching in strict');
const lenient = VSCore.createMatcher(Object.assign({ sensitivity: 'lenient' }, PHRASE_DEFAULTS));
eq(cmdOf(lenient, 'doen'), 'dn', 'lenient forgives doen');

// --- custom phrase overrides ---
const custom = VSCore.createMatcher(Object.assign({}, PHRASE_DEFAULTS, { sensitivity: 'balanced', cDn: 'descend, lower', cUp: 'ascend' }));
eq(cmdOf(custom, 'descend'), 'dn', 'custom down phrase');
eq(cmdOf(custom, 'lower'), 'dn', 'custom down phrase 2');
eq(cmdOf(custom, 'ascend'), 'up', 'custom up phrase');
eq(cmdOf(custom, 'down'), null, 'default phrase removed when overridden');

// --- help command (English) ---
eq(cmdOf(m, 'help'), 'help', 'help -> help');
eq(cmdOf(m, 'what can i say'), 'help', 'what can i say -> help');
eq(cmdOf(m, 'help me scroll down a lot'), 'dn', 'real command beats help on ties');

// --- undo (a correction gesture) ---
eq(cmdOf(m, 'undo'), 'undo', 'undo -> undo');
eq(cmdOf(m, 'undo that'), 'undo', 'undo that -> undo');
eq(cmdOf(m, 'take it back'), 'undo', 'take it back -> undo');
eq(cmdOf(m, 'back up'), 'undo', 'back up -> undo (beats the bare "up")');
eq(cmdOf(m, 'undo scroll down'), 'undo', 'undo wins over down on a longer phrase');
eq(cmdOf(m, 'download'), null, 'download must not become undo/down');

// --- "did you mean" suggestions ---
eq(m.suggest('scrol down') && m.suggest('scrol down').cmd, 'dn', 'suggest: "scrol down" -> scroll down');
eq(m.suggest('scrol down') && m.suggest('scrol down').phrase, 'scroll down', 'suggest: returns the phrase');
eq(m.suggest('pge down') && m.suggest('pge down').cmd, 'pd', 'suggest: "pge down" -> page down');
eq(m.suggest('downward') && m.suggest('downward').cmd, 'dn', 'suggest: "downward" -> down');
eq(m.suggest('completely unrelated speech'), null, 'suggest: unrelated text has no suggestion');
eq(m.suggest(''), null, 'suggest: empty text has no suggestion');
eq(m.suggest('down'), null, 'suggest: an exact match needs no suggestion');

// --- command list (the grid data) ---
const list = VSCore.commandList(VSCore.DEFAULTS);
eq(list.length, 13, 'command list covers every command');
eq(list[0].cmd, 'dn', 'command list starts with down');
eq(list[0].phrase, 'down', 'command list uses the configured phrase');
eq(list.some(r => r.cmd === 'undo'), true, 'command list includes undo');
const hiList = VSCore.commandList(Object.assign({}, VSCore.DEFAULTS, { lang: 'hi-IN' }));
eq(hiList[0].phrase, 'नीचे', 'Hindi command list uses the Hindi phrase');
eq(hiList[0].alt, 'down', 'Hindi command list keeps the English phrase as an alternative');
const customList = VSCore.commandList(Object.assign({}, VSCore.DEFAULTS, { cDn: 'descend, lower' }));
eq(customList[0].phrase, 'descend', 'command list follows the custom phrase');

// ================= हिन्दी (hi-IN) =================
const hm = VSCore.createMatcher(Object.assign({}, PHRASE_DEFAULTS, {
  sensitivity: 'balanced',
  lang: 'hi-IN',
  cHelp: 'help, what can i say, show commands'
}));

// --- normalization of Devanagari variants ---
eq(VSCore.normalize('नीचें'), 'नीचे', 'anusvara stripped: नीचें -> नीचे');
eq(VSCore.normalize('तेज़'), 'तेज', 'nukta stripped: तेज़ -> तेज');
eq(VSCore.normalize('नीचे १२'), 'नीचे 12', 'Devanagari digits -> ASCII');

// --- Devanagari commands ---
eq(cmdOf(hm, 'नीचे'), 'dn', 'नीचे -> dn');
eq(cmdOf(hm, 'स्क्रॉल नीचे'), 'dn', 'स्क्रॉल नीचे -> dn');
eq(cmdOf(hm, 'नीचे जाओ'), 'dn', 'नीचे जाओ -> dn');
eq(cmdOf(hm, 'निचे'), 'dn', 'homophone निचे -> dn');
eq(cmdOf(hm, 'ऊपर'), 'up', 'ऊपर -> up');
eq(cmdOf(hm, 'उपर'), 'up', 'homophone उपर -> up');
eq(cmdOf(hm, 'पेज नीचे'), 'pd', 'पेज नीचे -> pd');
eq(cmdOf(hm, 'अगला पेज'), 'pd', 'अगला पेज -> pd');
eq(cmdOf(hm, 'पेज ऊपर'), 'pu', 'पेज ऊपर -> pu');
eq(cmdOf(hm, 'टॉप'), 'top', 'टॉप -> top');
eq(cmdOf(hm, 'सबसे ऊपर'), 'top', 'सबसे ऊपर -> top');
eq(cmdOf(hm, 'सबसे नीचे'), 'bot', 'सबसे नीचे -> bot');
eq(cmdOf(hm, 'बॉटम'), 'bot', 'बॉटम -> bot');
eq(cmdOf(hm, 'बोटम'), 'bot', 'homophone बोटम -> bot');
eq(cmdOf(hm, 'रुको'), 'stop', 'रुको -> stop');
eq(cmdOf(hm, 'रुक जाओ'), 'stop', 'रुक जाओ -> stop');
eq(cmdOf(hm, 'रोको'), 'stop', 'homophone रोको -> stop');
eq(cmdOf(hm, 'सो जाओ'), 'sleep', 'सो जाओ -> sleep');
eq(cmdOf(hm, 'जागो'), 'wake', 'जागो -> wake');
eq(cmdOf(hm, 'उठो'), 'wake', 'उठो -> wake');
eq(cmdOf(hm, 'तेज़'), 'faster', 'तेज़ -> faster');
eq(cmdOf(hm, 'तेज'), 'faster', 'तेज -> faster');
eq(cmdOf(hm, 'धीरे'), 'slower', 'धीरे -> slower');
eq(cmdOf(hm, 'मदद'), 'help', 'मदद -> help');
eq(cmdOf(hm, 'down'), 'dn', 'English phrases still work in Hindi mode');

// --- Hinglish (romanized) commands ---
eq(cmdOf(hm, 'neeche'), 'dn', 'neeche -> dn');
eq(cmdOf(hm, 'niche'), 'dn', 'homophone niche -> dn');
eq(cmdOf(hm, 'oopar'), 'up', 'oopar -> up');
eq(cmdOf(hm, 'ruko'), 'stop', 'ruko -> stop');
eq(cmdOf(hm, 'jago'), 'wake', 'jago -> wake');
eq(cmdOf(hm, 'tez'), 'faster', 'tez -> faster');
eq(cmdOf(hm, 'dheere'), 'slower', 'dheere -> slower');
eq(cmdOf(hm, 'madad'), 'help', 'madad -> help');
eq(cmdOf(hm, 'page neeche'), 'pd', 'page neeche -> pd');
eq(cmdOf(hm, 'sabse neeche'), 'bot', 'sabse neeche -> bot');

// --- Hindi quantifiers ---
eq(hm.parseModifier('नीचे तीन', 'dn').mult, 3, 'नीचे तीन -> x3');
eq(hm.parseModifier('नीचे चार', 'dn').mult, 4, 'नीचे चार -> x4');
eq(hm.parseModifier('नीचे दो', 'dn').mult, 2, 'नीचे दो -> x2');
eq(hm.parseModifier('नीचे दस', 'dn').mult, 10, 'नीचे दस -> x10');
eq(hm.parseModifier('नीचे ३', 'dn').mult, 3, 'Devanagari digit ३ -> x3');
eq(hm.parseModifier('नीचे थोड़ा', 'dn').mult, 0.35, 'नीचे थोड़ा -> nudge');
eq(hm.parseModifier('नीचे बहुत', 'dn').mult, 2.5, 'नीचे बहुत -> a lot');
eq(hm.parseModifier('नीचे आधा पेज', 'dn').page, true, 'आधा पेज -> page flag');
eq(hm.parseModifier('नीचे आधा पेज', 'dn').mult, 0.5, 'आधा पेज -> x0.5');
eq(hm.parseModifier('neeche teen', 'dn').mult, 3, 'Hinglish teen -> x3');
eq(hm.parseModifier('neeche thoda', 'dn').mult, 0.35, 'Hinglish thoda -> nudge');
eq(hm.parseModifier('एकदम नीचे', 'dn').edge, 'bot', 'एकदम नीचे -> bottom edge');
eq(hm.parseModifier('एकदम ऊपर', 'up').edge, 'top', 'एकदम ऊपर -> top edge');
eq(cmdOf(hm, 'एकदम नीचे'), 'dn', 'एकदम नीचे still parses as dn');

// --- keep-scrolling detection (shared by all three engines) ---
eq(VSCore.isKeep('keep scrolling down'), true, 'isKeep english');
eq(VSCore.isKeep('please continue scrolling'), true, 'isKeep continue');
eq(VSCore.isKeep('keep going down'), true, 'isKeep keep going');
eq(VSCore.isKeep('start scrolling'), true, 'isKeep start scrolling');
eq(VSCore.isKeep('keep down'), true, 'isKeep trailing direction');
eq(VSCore.isKeep('keep up the good work'), false, 'idiomatic English is not a scroll intent');
eq(VSCore.isKeep('auto scroll'), true, 'isKeep auto scroll');
eq(VSCore.isKeep('चलते रहो नीचे'), true, 'isKeep चलते रहो');
eq(VSCore.isKeep('जारी रखो'), true, 'isKeep जारी रखो');
eq(VSCore.isKeep('chalte raho'), true, 'isKeep chalte raho');
eq(VSCore.isKeep('down'), false, 'isKeep negative');
eq(VSCore.isKeep('नीचे'), false, 'isKeep hindi negative');

// --- Hindi packs must NOT leak into English mode ---
eq(cmdOf(m, 'नीचे'), null, 'Hindi phrase inert for en matcher');
eq(cmdOf(m, 'ruko'), null, 'Hinglish phrase inert for en matcher');

// --- shared defaults + help rows ---
eq(VSCore.DEFAULTS.cDn, PHRASE_DEFAULTS.cDn, 'DEFAULTS holds the default phrases');
eq(typeof VSCore.DEFAULTS.dist, 'number', 'DEFAULTS holds numeric settings');
const rows = VSCore.helpRows(VSCore.DEFAULTS);
eq(Array.isArray(rows), true, 'helpRows returns an array');
eq(rows.length >= 12, true, 'helpRows covers every command group');
eq(rows[0][0].indexOf('down') >= 0, true, 'helpRows starts with the down phrases');
eq(rows.some(r => r[0].indexOf('नीचे') >= 0), false, 'English sheet has no Hindi rows');
const hiRows = VSCore.helpRows(Object.assign({}, VSCore.DEFAULTS, { lang: 'hi-IN' }));
eq(hiRows.some(r => r[0].indexOf('नीचे') >= 0), true, 'Hindi sheet includes नीचे');
eq(VSCore.helpRows(Object.assign({}, VSCore.DEFAULTS, { cDn: 'descend' }))[0][0].indexOf('descend') >= 0, true, 'helpRows follows custom phrases');

// ================= shared speech engine =================
function makeEngine(matcher) {
  const log = [];
  const engine = VSCore.createEngine({
    match: (text) => matcher.parseCommand(text),
    mod: (text, cmd) => matcher.parseModifier(text, cmd),
    // mirrors the values used by content.js / voice-hub.js
    settleMs: 60,
    maxWaitMs: 120,
    onExec: (a) => log.push(a),
    onMiss: (text) => log.push({ type: 'miss', text })
  });
  return { engine, log };
}
const cands = (text, conf) => [{ text, conf: conf || 0 }];

async function engineTests() {
  // --- interim settles into a command ---
  let t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  eq(t.log.length, 0, 'interim does not fire immediately');
  await sleep(280);
  eq(t.log.length, 1, 'interim fires after the settling window');
  eq(t.log[0] && t.log[0].type, 'command', 'interim produces a command action');
  eq(t.log[0] && t.log[0].cmd, 'dn', 'interim command is dn');

  // --- latency: a command must not feel delayed ---
  t = makeEngine(m);
  let firedAt = 0;
  const t0 = Date.now();
  t.engine.handle(cands('down'), false, 0);
  while (!firedAt && Date.now() - t0 < 500) {
    if (t.log.length) firedAt = Date.now() - t0;
    else await sleep(2);
  }
  ok(firedAt > 0, 'latency: the command fires');
  // The settling window is 60 ms; the upper bound leaves room for a loaded
  // machine but still catches the old 210 ms window.
  ok(firedAt <= 150, 'latency: the command fires within 150 ms (was ' + firedAt + ' ms)');

  // --- a burst of interim results must not postpone the command ---
  t = makeEngine(m);
  const burstStart = Date.now();
  let burstFiredAt = 0;
  for (let i = 0; i < 10; i++) {
    t.engine.handle(cands('down'), false, 0);
    if (!burstFiredAt && t.log.length) burstFiredAt = Date.now() - burstStart;
    await sleep(25);
  }
  ok(t.log.length === 1, 'latency: a burst of interim results fires the command exactly once');
  ok(burstFiredAt > 0 && burstFiredAt <= 160, 'latency: the burst fires the command within 160 ms (was ' + burstFiredAt + ' ms)');
  eq(t.log[0] && t.log[0].cmd, 'dn', 'latency: the burst produced the right command');

  // --- a final result fires immediately ---
  t = makeEngine(m);
  t.engine.handle(cands('page down'), true, 0);
  eq(t.log.length, 1, 'final fires immediately');
  eq(t.log[0].cmd, 'pd', 'final command is pd');

  // --- the same segment never fires twice ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(280);
  t.engine.handle(cands('down'), true, 0);
  eq(t.log.length, 1, 'interim + final of the same segment fires once');

  // --- a different final command is never swallowed ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(280);
  t.engine.handle(cands('page down'), true, 0);
  eq(t.log.length, 2, 'changed final command still runs');
  eq(t.log[1] && t.log[1].cmd, 'pd', 'changed final command is the new one');

  // --- "stop" is never swallowed by an earlier "down" ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(280);
  t.engine.handle(cands('stop'), true, 0);
  eq(t.log.length, 2, 'stop survives a preceding down');
  eq(t.log[1] && t.log[1].cmd, 'stop', 'stop is executed');

  // --- safety commands fire with zero delay ---
  t = makeEngine(m);
  t.engine.handle(cands('stop'), false, 0);
  eq(t.log.length, 1, 'stop fires without waiting');
  eq(t.log[0].cmd, 'stop', 'stop is immediate');
  t = makeEngine(m);
  t.engine.handle(cands('sleep'), false, 0);
  eq(t.log.length, 1, 'sleep fires without waiting');

  // --- growing quantifier only scrolls the remainder ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(280);
  t.engine.handle(cands('down three'), true, 0);
  eq(t.log.length, 2, 'quantifier upgrade produces a second action');
  eq(t.log[1] && t.log[1].type, 'upgrade', 'quantifier upgrade type');
  eq(t.log[1] && t.log[1].delta, 2, 'upgrade scrolls only the remaining 2 steps');

  // --- a final that arrives before the settle window replaces the interim ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(30);                                   // still inside the window
  t.engine.handle(cands('down three'), true, 0);
  await sleep(280);
  eq(t.log.length, 1, 'final before the settle window runs exactly once');
  eq(t.log[0] && t.log[0].cmd, 'dn', 'the final command wins');
  eq(t.log[0] && t.log[0].mod.mult, 3, 'the full quantifier is applied');

  // --- a final that matches nothing cancels the pending interim ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(30);                                   // still inside the window
  t.engine.handle(cands('the weather today'), true, 0);
  await sleep(280);
  eq(t.log.length, 1, 'stale interim is cancelled by a non-matching final');
  eq(t.log[0] && t.log[0].type, 'miss', 'the miss is reported');

  // --- a quantifier that arrives after the first step still completes ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), false, 0);
  await sleep(120);                                  // the first step ran
  t.engine.handle(cands('down three'), true, 0);
  await sleep(60);
  eq(t.log.length, 2, 'a later quantifier adds one more action');
  eq(t.log[1] && t.log[1].type, 'upgrade', 'the later quantifier is an upgrade');
  eq(t.log[1] && t.log[1].delta, 2, 'the upgrade scrolls the remaining two steps');

  // --- segments are independent ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), true, 0);
  t.engine.handle(cands('up'), true, 1);
  eq(t.log.length, 2, 'two segments both fire');
  eq(t.log[0].cmd, 'dn', 'segment 0 is dn');
  eq(t.log[1].cmd, 'up', 'segment 1 is up');

  // --- reset() clears the dedup state (new recognizer instance) ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), true, 0);
  t.engine.reset();
  t.engine.handle(cands('down'), true, 0);
  eq(t.log.length, 2, 'reset allows the same command again');

  // --- a matching alternative wins over a non-matching one ---
  t = makeEngine(m);
  t.engine.handle([{ text: 'the weather is nice', conf: 0.9 }, { text: 'down', conf: 0.4 }], true, 0);
  eq(t.log.length, 1, 'a later alternative can still match');
  eq(t.log[0] && t.log[0].cmd, 'dn', 'the matching alternative is used');

  // --- a whole session: every utterance must be heard (not just the first) ---
  t = makeEngine(m);
  const session = [
    ['down', 'down'],
    ['up', 'up'],
    ['page down', 'page down'],
    ['down', 'down three'],   // the quantifier grows while speaking
    ['top', 'top'],
    ['bottom', 'bottom'],
    ['stop', 'stop']
  ];
  for (let i = 0; i < session.length; i++) {
    t.engine.handle(cands(session[i][0]), false, i);   // interim
    await sleep(240);                                    // settling window fires
    t.engine.handle(cands(session[i][1]), true, i);     // final
  }
  eq(t.log.length, session.length + 1, 'every utterance of a session is executed (plus the quantifier upgrade)');
  eq(t.log.map(a => a.cmd).join(','), 'dn,up,pd,dn,dn,top,bot,stop', 'the session runs the commands in order');
  eq(t.log[4] && t.log[4].type, 'upgrade', 'a growing quantifier is an upgrade');
  eq(t.log[4] && t.log[4].delta, 2, 'the quantifier upgrade scrolls the remainder only');

  // --- Chrome batches events: a final and the next interim arrive together ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), true, 0);    // final of utterance 0
  t.engine.handle(cands('up'), false, 1);     // interim of utterance 1 (same event)
  await sleep(260);
  t.engine.handle(cands('up'), true, 1);
  t.engine.handle(cands('page down'), false, 2);
  await sleep(260);
  t.engine.handle(cands('page down'), true, 2);
  eq(t.log.length, 3, 'batched events still run every command');
  eq(t.log.map(a => a.cmd).join(','), 'dn,up,pd', 'batched commands keep their order');

  // --- a fast double command ("down down") is not swallowed ---
  t = makeEngine(m);
  t.engine.handle(cands('down'), true, 0);
  t.engine.handle(cands('down'), true, 1);
  eq(t.log.length, 2, 'two identical commands in a row both run');
}

engineTests().then(function () {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('ERROR during engine tests:', e);
  process.exit(1);
});
