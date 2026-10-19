/* Regression tests for the shared command matcher (extension/vs-core.js).
 * Run: node tests/test-vs-core.js   (no dependencies)
 * Guards the homophone table, the EXACT_ONLY collision guards, quantifiers,
 * edge jumps, sensitivities and custom phrase overrides.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'vs-core.js'), 'utf8');
const sandbox = { window: {}, self: {} };
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
function cmdOf(matcher, raw) {
  const hit = matcher.parseCommand(raw);
  return hit ? hit.cmd : null;
}

// Mirrors the DEFAULTS command phrases from content.js / popup.js — real
// callers always build the matcher from a cfg containing these fields.
const PHRASE_DEFAULTS = {
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
eq(cmdOf(m, 'bottom'), 'bot', 'bottom -> bot');
eq(cmdOf(m, 'stop'), 'stop', 'stop -> stop');
eq(cmdOf(m, 'stop scrolling'), 'stop', 'longer phrase wins');
eq(cmdOf(m, 'sleep'), 'sleep', 'sleep -> sleep');
eq(cmdOf(m, 'wake up'), 'wake', 'wake up -> wake');
eq(cmdOf(m, 'faster'), 'faster', 'faster -> faster');
eq(cmdOf(m, 'slower'), 'slower', 'slower -> slower');

// --- homophones (curated mishearings always corrected) ---
eq(cmdOf(m, 'done'), 'dn', 'done -> down');
eq(cmdOf(m, 'town'), 'dn', 'town -> down');
eq(cmdOf(m, 'app'), 'up', 'app -> up');
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

// --- quantifiers ---
eq(m.parseModifier('down three', 'dn').mult, 3, 'down three -> x3');
eq(m.parseModifier('down twice', 'dn').mult, 2, 'down twice -> x2');
eq(m.parseModifier('down a little', 'dn').mult, 0.35, 'down a little -> nudge');
eq(m.parseModifier('down a lot', 'dn').mult, 2.5, 'down a lot -> x2.5');
eq(m.parseModifier('half page', 'dn').page, true, 'half page -> page flag');
eq(m.parseModifier('half page', 'dn').mult, 0.5, 'half page -> x0.5');
eq(m.parseModifier('down', 'dn').mult, 1, 'bare down -> x1');

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
eq(VSCore.isKeep('चलते रहो नीचे'), true, 'isKeep चलते रहो');
eq(VSCore.isKeep('जारी रखो'), true, 'isKeep जारी रखो');
eq(VSCore.isKeep('chalte raho'), true, 'isKeep chalte raho');
eq(VSCore.isKeep('down'), false, 'isKeep negative');
eq(VSCore.isKeep('नीचे'), false, 'isKeep hindi negative');

// --- Hindi packs must NOT leak into English mode ---
eq(cmdOf(m, 'नीचे'), null, 'Hindi phrase inert for en matcher');
eq(cmdOf(m, 'ruko'), null, 'Hinglish phrase inert for en matcher');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
