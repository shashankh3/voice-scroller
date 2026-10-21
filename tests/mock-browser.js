/* Shared browser mocks for the VoiceScroll test suites.
 * A tiny fake DOM + chrome API so the real extension files can be loaded
 * and driven in Node.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');

function el(tag) {
  return {
    tagName: String(tag || 'div'),
    id: '', textContent: '', innerHTML: '', className: '', title: '',
    style: {}, dataset: {}, children: [], value: '', checked: false,
    options: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    remove() {},
    focus() {}, click() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; },
    scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, clientHeight: 500, clientWidth: 500
  };
}

function makeWindow(opts) {
  opts = opts || {};
  const win = {
    innerWidth: 1280, innerHeight: 800, scrollY: 0, scrollX: 0, devicePixelRatio: 1,
    scrollToCalls: [], scrollToTimes: [],
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(fn) { return setTimeout(() => fn(Date.now()), 16); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    getComputedStyle() { return { overflowY: 'auto', overflowX: 'hidden' }; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    scrollTo(o) {
      win.scrollToCalls.push(o);
      win.scrollToTimes.push(Date.now());
      // `scrollLocked` simulates a page that cannot be scrolled at all.
      if (!win.scrollLocked && o && typeof o.top === 'number') win.scrollY = o.top;
    },
    scrollBy(dy) { win.scrollY += (dy || 0); },
    matchMedia() { return { matches: false, addListener() {} }; },
    SpeechRecognition: null, webkitSpeechRecognition: null, AudioContext: null
  };
  win.top = win; win.self = win; win.window = win;
  win.scrollLocked = !!opts.scrollLocked;
  win.document = {
    body: el('body'), documentElement: el('html'), head: el('head'),
    createElement: (t) => el(t),
    getElementById: (id) => { const e = el('div'); e.id = id; return e; },
    querySelector: opts.querySelector || (() => null),
    querySelectorAll: () => [],
    elementsFromPoint: () => [],
    addEventListener() {}, removeEventListener() {},
    contains: () => true,
    contentType: 'text/html', readyState: 'complete'
  };
  return win;
}

function makeChrome(win, opts) {
  opts = opts || {};
  const listeners = { message: [], installed: [], command: [], tabRemoved: [], tabUpdated: [], detach: [], storageChanged: [] };
  const calls = { sendMessage: [], badge: [], storageSet: [], tabMessages: [], tabsQuery: [] };
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      sendMessage(msg, cb) {
        calls.sendMessage.push(msg);
        if (typeof cb === 'function') cb({});
        return Promise.resolve({});
      },
      getURL(p) { return 'chrome-extension://voice-scroll-test/' + p; },
      lastError: null
    },
    storage: {
      sync: {
        get(defs, cb) {
          if (opts.storageThrows) throw new Error('storage unavailable');
          if (typeof cb === 'function') cb(Object.assign({}, defs));
        },
        set(obj, cb) {
          if (opts.storageThrows) throw new Error('storage unavailable');
          calls.storageSet.push(obj);
          if (typeof cb === 'function') cb();
        }
      },
      session: {
        get(defs, cb) { if (typeof cb === 'function') cb(Object.assign({}, defs)); },
        set(obj, cb) { calls.storageSet.push(obj); if (typeof cb === 'function') cb(); }
      },
      onChanged: { addListener(fn) { listeners.storageChanged.push(fn); } }
    },
    tabs: {
      async query(q) { calls.tabsQuery.push(q); return []; },
      async sendMessage(tabId, msg) { calls.tabMessages.push({ tabId, msg }); return { on: false }; },
      async create() { return { id: 99, url: 'chrome-extension://voice-scroll-test/voice-hub.html' }; },
      async reload() {},
      onRemoved: { addListener(fn) { listeners.tabRemoved.push(fn); } },
      onUpdated: { addListener(fn) { listeners.tabUpdated.push(fn); } }
    },
    action: {
      setBadgeText(o) { calls.badge.push(o); return Promise.resolve(); },
      setBadgeBackgroundColor() { return Promise.resolve(); },
      setTitle() { return Promise.resolve(); }
    },
    debugger: {
      onDetach: { addListener(fn) { listeners.detach.push(fn); } },
      async attach() {}, async detach() {},
      sendCommand(t, m, p, cb) { if (typeof cb === 'function') cb({}); }
    },
    offscreen: { async createDocument() {}, async closeDocument() {} },
    commands: { onCommand: { addListener(fn) { listeners.command.push(fn); } } },
    scripting: { async executeScript() { return []; } }
  };
  win.chrome = chrome;
  return { chrome, listeners, calls };
}

function loadInto(win, file) {
  vm.runInContext(read(file), vm.createContext(win), { filename: file });
}

// A recognizer that behaves like Chrome's: abort() fires another "end"
// event, and start() throws when the service is not ready.
function makeFakeSR(store, opts) {
  opts = opts || {};
  // The attempt counter is global: a service that is temporarily unavailable
  // fails the first N start() calls, not the first N of each instance.
  let attempts = 0;
  function FakeSR() {
    store.push(this);
    this.started = false;
    this.ended = false;
  }
  FakeSR.prototype.start = function () {
    attempts++;
    if (opts.failTimes && attempts <= opts.failTimes) {
      throw new Error('InvalidStateError: recognition already started');
    }
    if (opts.alwaysFail) throw new Error('InvalidStateError: service not ready');
    this.started = true;
    if (this.onstart) this.onstart();
  };
  FakeSR.prototype.abort = function () {
    if (this.ended) return;
    this.ended = true;
    if (this.onend) this.onend();       // Chrome fires "end" on abort
  };
  FakeSR.prototype.stop = function () { this.abort(); };
  return FakeSR;
}

// Simulates Chrome's SpeechRecognitionResultList: every utterance gets a new
// index and the result list accumulates, exactly like the browser does.
function makeSpeaker(rec) {
  let idx = 0;
  return function (text, isFinal) {
    const results = [];
    for (let i = 0; i <= idx; i++) {
      results.push({
        length: 1,
        isFinal: i < idx ? true : (isFinal !== false),
        0: { transcript: i === idx ? text : 'previous utterance', confidence: 0.9 }
      });
    }
    rec.onresult({ resultIndex: idx, results });
    idx++;
  };
}

module.exports = { el, makeWindow, makeChrome, makeFakeSR, makeSpeaker, loadInto, read, EXT };
