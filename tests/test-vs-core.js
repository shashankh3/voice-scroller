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
  cSlower: 'slower, slow down, speed down, go slower'
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

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
