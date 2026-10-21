/* Test runner for VoiceScroll Ultimate.
 * Run: npm test        (or: node tests/run-all.js)
 *
 * 1. syntax check of every extension file
 * 2. manifest validation
 * 3. the matcher / engine test suite
 * 4. the extension wiring smoke test
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
let failed = 0;

function step(name, fn) {
  process.stdout.write('• ' + name + ' … ');
  try {
    const out = fn();
    process.stdout.write((out ? out + ' ' : '') + 'OK\n');
  } catch (e) {
    failed++;
    process.stdout.write('FAILED\n');
    console.error('  ' + String((e && e.message) || e));
    if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  }
}

// 1. syntax
const JS_FILES = ['vs-core.js', 'content.js', 'background.js', 'voice-hub.js', 'popup.js'];
step('syntax check', function () {
  for (const f of JS_FILES) {
    execFileSync(process.execPath, ['--check', path.join(EXT, f)], { stdio: 'pipe' });
  }
  return JS_FILES.length + ' files';
});

// 2. manifest
step('manifest', function () {
  const raw = fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  const problems = [];
  if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!m.version) problems.push('version missing');
  if (!m.name) problems.push('name missing');
  const scripts = (m.content_scripts || []).flatMap(c => c.js || []);
  for (const required of ['vs-core.js', 'content.js']) {
    if (!scripts.includes(required)) problems.push('content script missing ' + required);
  }
  if (!m.background || !m.background.service_worker) problems.push('background service worker missing');
  if (!m.action || !m.action.default_popup) problems.push('action popup missing');
  if (!m.permissions.includes('storage')) problems.push('storage permission missing');
  if (!m.permissions.includes('scripting')) problems.push('scripting permission missing');
  if (problems.length) throw new Error(problems.join('; '));
  // The HTML pages must load the shared core before their own script.
  for (const page of ['popup.html', 'voice-hub.html']) {
    const html = fs.readFileSync(path.join(EXT, page), 'utf8');
    const core = html.indexOf('vs-core.js');
    const own = html.indexOf(page === 'popup.html' ? 'popup.js' : 'voice-hub.js');
    if (core < 0) throw new Error(page + ' does not load vs-core.js');
    if (own < 0 || core > own) throw new Error(page + ' must load vs-core.js before its own script');
  }
  return 'v' + m.version;
});

// 3. the shared core must be loadable on its own (service worker uses
//    importScripts, content scripts load it as a plain script)
step('vs-core loads standalone', function () {
  const code = fs.readFileSync(path.join(EXT, 'vs-core.js'), 'utf8');
  const sandbox = { window: {}, self: {}, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const core = sandbox.VSCore;
  if (!core) throw new Error('VSCore not exported');
  for (const key of ['createMatcher', 'createEngine', 'normalize', 'isKeep', 'helpRows', 'storageGet', 'storageSet', 'DEFAULTS']) {
    if (typeof core[key] === 'undefined') throw new Error('VSCore.' + key + ' missing');
  }
  if (!core.DEFAULTS || !core.DEFAULTS.cDn) throw new Error('DEFAULTS incomplete');
  return 'ok';
});

// 4. the test suites
step('matcher + engine suite', function () {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'test-vs-core.js')], { encoding: 'utf8' });
  process.stdout.write('\n  ' + out.trim() + '  ');
  return '';
});

step('extension wiring suite', function () {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'test-extension-wiring.js')], { encoding: 'utf8' });
  process.stdout.write('\n  ' + out.trim() + '  ');
  return '';
});

step('resilience / fault injection suite', function () {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'test-resilience.js')], { encoding: 'utf8' });
  process.stdout.write('\n  ' + out.trim() + '  ');
  return '';
});

console.log(failed ? '\n' + failed + ' step(s) FAILED' : '\nAll checks passed');
process.exit(failed ? 1 : 0);
