/* VoiceScroll Ultimate — shared engine (vs-core).
 * Loaded in every context that needs to decode speech into commands:
 * content scripts, the voice hub (offscreen / tab fallback), the background
 * service worker (via importScripts) and the popup.
 *
 * Exposes
 *   VSCore.DEFAULTS        single source of truth for the settings
 *   VSCore.createMatcher(cfg) -> { parseCommand, parseModifier, refresh, phrases }
 *   VSCore.createEngine(opts)  -> shared interim/final speech engine
 *   VSCore.isKeep(text)    auto-scroll intent detection
 *   VSCore.helpRows(cfg)   cheat-sheet rows built from the user's own phrases
 *   VSCore.normalize(text) text -> comparable form
 */
var VSCore = (function () {
  'use strict';

  /* ================= settings (single source of truth) ================= */
  // Every context (content script, voice hub, background, popup) reads its
  // defaults from here so the four copies can never drift apart.
  var DEFAULTS = {
    dist: 400,
    smooth: true,
    sound: true,
    lang: 'en-US',
    sensitivity: 'balanced',   // strict | balanced | lenient
    speed: 40,                 // auto-scroll speed 1..100
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
    cSlower: 'slower, slow down, speed down, go slower',
    cUndo: 'undo, undo that, take it back, back up',
    cHelp: 'help, what can i say, show commands'
  };

  // command id -> settings key holding its phrase list
  var CMD_KEYS = {
    dn: 'cDn', up: 'cUp', pd: 'cPd', pu: 'cPu', top: 'cTop', bot: 'cBot',
    stop: 'cStop', sleep: 'cSleep', wake: 'cWake', faster: 'cFaster',
    slower: 'cSlower', undo: 'cUndo', help: 'cHelp'
  };

  /* ================= normalization ================= */
  // Keeps Latin letters/digits AND the Devanagari block (हिन्दी). Collapses
  // spelling variants the speech service emits: ZWJ/ZWNJ removed, anusvara &
  // candrabindu stripped (नीचें → नीचे, कमांड → कमाड), nukta stripped
  // (तेज़ → तेज, काफ़ी → काफी) and Devanagari digits converted (१२ → 12) so
  // numeric parsing stays uniform. Both heard text and phrase packs run
  // through this, so only the normalized forms ever meet.
  function normalize(s) {
    return String(s || '').toLowerCase()
      .replace(/[\u200c\u200d]/g, '')
      .replace(/[\u0901\u0902]/g, '')
      .replace(/\u093C/g, '')
      .replace(/[\u0966-\u096F]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0x0966 + 48);
      })
      .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // Curated homophone dictionary — only proven Web Speech mishearings.
  // Common English words (button, wait, star, pop, brown...) are deliberately
  // NOT mapped, so normal speech never triggers a scroll. Devanagari entries
  // can never collide with English transcripts (different script), and the
  // romanized ones only matter when Hindi phrases are in the tables.
  // NOTE: keys are compared against *normalized* words, so they must be
  // written in normalized form (nukta / anusvara free).
  var HOMOPHONES = {
    done: 'down', town: 'down', dawn: 'down', dowm: 'down', doun: 'down',
    doon: 'down', domn: 'down',
    app: 'up', opp: 'up', yup: 'up', sup: 'up',
    pages: 'page', payge: 'page', paige: 'page',
    stock: 'stop', shop: 'stop', stopp: 'stop',
    slip: 'sleep', sleap: 'sleep', seep: 'sleep',
    week: 'wake', weigh: 'wake', awake: 'wake', wakeup: 'wake',
    quicker: 'faster',
    // हिन्दी (Devanagari) mishearings
    'निचे': 'नीचे', 'निचेे': 'नीचे',
    'उपर': 'ऊपर', 'उप्पर': 'ऊपर', 'ऊप्पर': 'ऊपर',
    'रूको': 'रुको', 'रोको': 'रुको', 'रुकोगे': 'रुको',
    'धिरे': 'धीरे',
    'स्टॉप': 'स्टॉप', 'स्तॉप': 'स्टॉप',
    'पेजस': 'पेज',
    'बोटम': 'बॉटम', 'बोटोम': 'बॉटम', 'बाटम': 'बॉटम',
    'टोप': 'टॉप', 'बोट्टम': 'बॉटम',
    'मद्द': 'मदद', 'मदद': 'मदद',
    // Hinglish romanizations
    niche: 'neeche', upar: 'oopar', rukko: 'ruko', roko: 'ruko',
    jaggo: 'jago', dhirre: 'dheere', oopar: 'oopar'
  };

  var NUM_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10,
    once: 1, twice: 2, thrice: 3,
    couple: 2, few: 3, several: 3
  };

  // हिन्दी numerals — consulted only when the configured speech language is
  // Hindi. Keys are post-normalization forms ( anusvara/nukta stripped:
  // पांच/पाँच → पाच ).
  var HI_NUM_WORDS = {
    'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाच': 5, 'छह': 6, 'छ': 6, 'छः': 6,
    'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
    ek: 1, do: 2, teen: 3, char: 4, paanch: 5, chhe: 6, che: 6,
    saat: 7, aath: 8, nau: 9, das: 10
  };

  // Common English words that one-substitution fuzzy matching would otherwise
  // turn into commands (wait->wake, step->stop, half->halt, stops->stop,
  // fast->faster, slowly->slower, button->bottom). They only match exactly.
  var EXACT_ONLY = {
    wait: 1, woke: 1, wave: 1, wade: 1, wage: 1, step: 1, stops: 1,
    half: 1, fast: 1, slowly: 1, button: 1
  };

  // Priority order used to break ties between equally long matching phrases
  // (e.g. "stop" beats "down" for the transcript "stop down").
  var CMD_ORDER = ['sleep', 'wake', 'stop', 'faster', 'slower', 'pd', 'pu', 'top', 'bot', 'dn', 'up', 'undo', 'help'];

  // Commands whose quantifier can grow while the utterance is still running
  // ("down" -> "down three"). Safety commands are never upgraded.
  var UPGRADABLE = { dn: 1, up: 1, pd: 1, pu: 1 };
  // Commands that must never be swallowed by deduplication.
  var IMMEDIATE = { stop: 1, sleep: 1, wake: 1 };

  // "keep scrolling" detection shared by content, hub and background —
  // English + हिन्दी (चलते रहो / जारी रखो) + romanized Hinglish.
  // "keep" on its own is not enough: the intent needs a motion word, or a
  // trailing direction ("keep down"), so idiomatic English such as
  // "keep up the good work" never starts an auto-scroll.
  var KEEP_RE = /\b(keep|continue|resume|start)\b[^.]{0,28}?\b(scroll|scrolls|scrolling|roll|rolling|going|moving|it|them)\b/i;
  var KEEP_DIR_RE = /\b(keep|continue)\s+(down|up)\s*$/i;
  var KEEP_RE2 = /\b(auto|continuous)\s+scroll(ing)?\b/i;
  var HI_KEEP_RE = /चलते रहो|चलती रहो|चलाते रहो|स्क्रॉल करते रहो|जारी रखो|जारी रहो|chalte raho|chaltee raho|challate raho|scroll karte raho|jaari rakho|jari rakho|jari raho/i;

  function isKeep(raw) {
    var t = ' ' + normalize(raw) + ' ';
    return KEEP_RE.test(t) || KEEP_DIR_RE.test(t) || KEEP_RE2.test(t) || HI_KEEP_RE.test(t);
  }

  // Hindi phrase pack — appended to the user's editable command phrases when
  // the speech language is Hindi (en phrases stay active alongside, so
  // bilingual users lose nothing). Pack entries pass through normalize() at
  // rebuild time, so natural spellings (तेज़, पॉज़, कमांड) are fine here.
  var HI_PHRASES = {
    dn: ['नीचे', 'स्क्रॉल नीचे', 'नीचे स्क्रॉल करो', 'नीचे जाओ', 'नीचे करो',
      'neeche', 'scroll neeche', 'neeche jao', 'neeche karo'],
    up: ['ऊपर', 'स्क्रॉल ऊपर', 'ऊपर स्क्रॉल करो', 'ऊपर जाओ',
      'oopar', 'scroll oopar', 'oopar jao'],
    pd: ['पेज नीचे', 'अगला पेज', 'page neeche', 'agla page'],
    pu: ['पेज ऊपर', 'पिछला पेज', 'page upar', 'pichla page'],
    top: ['टॉप', 'सबसे ऊपर', 'एकदम ऊपर', 'top', 'sabse oopar', 'ekdam oopar', 'shuru par'],
    bot: ['बॉटम', 'सबसे नीचे', 'अंत तक', 'अंत में', 'bottom', 'sabse neeche', 'ant tak', 'bilkul neeche'],
    stop: ['रुको', 'रुक जाओ', 'स्टॉप', 'बंद करो', 'ruko', 'ruk jao', 'band karo'],
    sleep: ['सो जाओ', 'ठहरो', 'ठहर जाओ', 'पॉज़ करो', 'so jao', 'thehro', 'thahro', 'pause karo'],
    wake: ['जागो', 'उठो', 'जाग जाओ', 'शुरू करो', 'jago', 'utho', 'jag jao', 'shuru karo'],
    faster: ['तेज़', 'और तेज़', 'तेज़ करो', 'जल्दी', 'tez', 'aur tez', 'tez karo', 'jaldi'],
    slower: ['धीरे', 'और धीरे', 'धीमा', 'धीमा करो', 'dheere', 'aur dheere', 'dheema', 'dheema karo', 'dheemi karo'],
    undo: ['पीछे', 'वापस', 'पहले जैसा', 'पीछे करो', 'undo', 'peeche', 'wapas', 'wapas karo'],
    help: ['मदद', 'कमांड', 'कमांड दिखाओ', 'क्या बोलूं', 'madad', 'command', 'commands', 'command dikhao', 'kya bolu']
  };

  function homophoneFix(words, homophones) {
    return words.map(function (w) { return homophones[w] || w; });
  }

  function lev(a, b) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (!la) return lb; if (!lb) return la;
    if (Math.abs(la - lb) > 3) return 99;
    var prev = [], cur = [], i, j;
    for (i = 0; i <= lb; i++) prev[i] = i;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  function createMatcher(cfg) {
    cfg = cfg || {};
    var sensitivity = cfg.sensitivity || 'balanced';
    var isHindi = /^hi(-|_|$)/i.test(String(cfg.lang || ''));

    function wordMatch(phraseWord, heardWord) {
      if (phraseWord === heardWord) return true;
      if (sensitivity === 'strict') return false;

      // First letter must match (phonetic homophones already handle variants like done->down, app->up)
      if (phraseWord.charAt(0) !== heardWord.charAt(0)) return false;

      // Short words (length <= 3, e.g. "top", "up") require exact match to prevent false collisions
      if (phraseWord.length <= 3 || heardWord.length <= 3) return false;

      // Common words never fuzzy-match (e.g. "wait" must not become "wake").
      if (EXACT_ONLY[heardWord]) return false;

      var d = lev(phraseWord, heardWord);
      if (sensitivity === 'lenient') {
        return phraseWord.length <= 5 ? d <= 1 : d <= 2;
      }

      // Balanced mode: a single substitution, identical length, first two
      // letters shared. Forgiving of real mishearings while preventing common
      // collisions like stops->stop, fast->faster and slowly->slower.
      return d <= 1 && phraseWord.length === heardWord.length &&
        phraseWord.slice(0, 2) === heardWord.slice(0, 2);
    }

    // All words of phrase must appear in order, allowing up to 3 filler words
    // between phrase tokens so natural speech ("please scroll a little bit down") still matches.
    function phraseInTranscript(phraseWords, heardWords) {
      var hi = 0;
      var lastHi = -1;
      for (var pi = 0; pi < phraseWords.length; pi++) {
        var found = false;
        while (hi < heardWords.length) {
          if (wordMatch(phraseWords[pi], heardWords[hi])) {
            // If not the first word of phrase, ensure the gap is bounded (<= 3 filler words)
            if (lastHi >= 0 && (hi - lastHi) > 4) {
              return false;
            }
            found = true;
            lastHi = hi;
            hi++;
            break;
          }
          hi++;
        }
        if (!found) return false;
      }
      return true;
    }

    // Evaluates transcript against all commands; longest matching phrase wins, ties broken by CMD_ORDER priority.
    function parseCommand(raw) {
      var heard = homophoneFix(normalize(raw).split(' ').filter(Boolean), HOMOPHONES);
      if (!heard.length) return null;

      var bestCmd = null;
      var bestScore = 0;

      for (var oi = 0; oi < CMD_ORDER.length; oi++) {
        var cmd = CMD_ORDER[oi];
        var list = (phrases && phrases[cmd]) || [];
        for (var i = 0; i < list.length; i++) {
          if (phraseInTranscript(list[i], heard)) {
            if (list[i].length > bestScore) {
              bestScore = list[i].length;
              bestCmd = cmd;
            }
          }
        }
      }

      if (bestCmd) {
        // "undo" modifies the previous action rather than being one: when it
        // is heard together with a scroll command it wins ("undo scroll down").
        if (bestCmd !== 'undo' &&
            (bestCmd === 'dn' || bestCmd === 'up' || bestCmd === 'pd' || bestCmd === 'pu')) {
          var undoList = (phrases && phrases.undo) || [];
          for (var u = 0; u < undoList.length; u++) {
            if (phraseInTranscript(undoList[u], heard)) { bestCmd = 'undo'; break; }
          }
        }
        return { cmd: bestCmd, score: bestScore, words: heard };
      }
      return null;
    }

    function splitPhrases(s) {
      return String(s || '').split(',')
        .map(function (x) { return homophoneFix(normalize(x).split(' ').filter(Boolean), HOMOPHONES); })
        .filter(function (a) { return a.length; });
    }

    // Rebuild the phrase tables from a cfg-like object with cDn..cHelp fields.
    // When the speech language is Hindi the locale pack is appended (dedup by
    // normalized phrase) so Hindi + Hinglish work next to the English (or
    // customized) phrases.
    function rebuild() {
      phrases = {};
      var pack = isHindi ? HI_PHRASES : null;
      for (var cmd in CMD_KEYS) {
        var key = CMD_KEYS[cmd];
        var list = splitPhrases(cfg[key]);
        var seen = {};
        for (var i = 0; i < list.length; i++) {
          seen[list[i].join(' ')] = 1;
        }
        if (pack && pack[cmd]) {
          for (var j = 0; j < pack[cmd].length; j++) {
            var rawPack = String(pack[cmd][j]);
            var p = homophoneFix(normalize(rawPack).split(' ').filter(Boolean), HOMOPHONES);
            if (p.length && !seen[p.join(' ')]) {
              seen[p.join(' ')] = 1;
              list.push(p);
            }
          }
        }
        list.sort(function (a, b) { return b.length - a.length; }); // longer phrases first
        phrases[cmd] = list;
      }
    }

    var phrases = null;
    rebuild();

    // Modifiers: "down three" -> x3, "down a little" -> x0.35, "all the way down" -> edge.
    // हिन्दी: "नीचे तीन" -> x3, "थोड़ा" -> nudge, "बहुत" -> a lot,
    // "आधा पेज" -> half page, "एकदम नीचे/ऊपर" -> edge jump.
    // Hindi regexes are written against NORMALIZED text (nukta/anusvara
    // stripped: थोड़ा → थोडा, ज़्यादा → ज्यादा).
    function parseModifier(raw, cmd) {
      var t = ' ' + normalize(raw) + ' ';
      var scrollFamily = (cmd === 'dn' || cmd === 'up' || cmd === 'pd' || cmd === 'pu');
      var edgeDown = /all the way down|right to the bottom|to the very bottom|all down|down to the bottom|to the bottom of the page|scroll to the bottom|to the very end|to the end|all the way to the end/.test(t) ||
        (isHindi && /एकदम नीचे|पूरा नीचे|पूरे नीचे|पूरी नीचे|बिल्कुल नीचे/.test(t));
      var edgeUp = /all the way up|right to the top|to the very top|all up|up to the top|to the top of the page|scroll to the top|to the very beginning|to the beginning|to the start/.test(t) ||
        (isHindi && /एकदम ऊपर|पूरा ऊपर|पूरे ऊपर|पूरी ऊपर|बिल्कुल ऊपर/.test(t));
      if (edgeDown && (cmd === 'dn' || cmd === 'pd')) return { mult: 0, edge: 'bot' };
      if (edgeUp && (cmd === 'up' || cmd === 'pu')) return { mult: 0, edge: 'top' };

      // Quantifiers only make sense for the scroll family.
      if (!scrollFamily) return { mult: 1, edge: null, page: false };

      var halfRe = /half(\s*a)? page|halfway/;
      if (isHindi) halfRe = /half(\s*a)? page|halfway|आधा( पेज)?|aadha( page)?/;
      if (halfRe.test(t)) return { mult: 0.5, edge: null, page: true };

      var n = 0;
      var m = t.match(/\b(\d+)\b/);
      if (m) {
        n = parseInt(m[1], 10);
        // A spoken digit count above ten is clamped to the maximum step.
        if (n > 10) n = 10;
      } else {
        for (var w in NUM_WORDS) {
          if (t.indexOf(' ' + w + ' ') !== -1 || t.indexOf(' ' + w + 's ') !== -1) {
            n = NUM_WORDS[w];
            break;
          }
        }
        if (!n && isHindi) {
          for (var h in HI_NUM_WORDS) {
            if (t.indexOf(' ' + h + ' ') !== -1) {
              n = HI_NUM_WORDS[h];
              break;
            }
          }
        }
      }
      if (n >= 1) return { mult: n, edge: null, page: false };

      var littleRe = /little|bit|slight|gentle|slowly|tiny|touch|nudge/;
      var lotRe = /lot|much|far|fast|big|more|chunk|huge/;
      if (isHindi) {
        littleRe = /little|bit|slight|gentle|slowly|tiny|touch|nudge|थोडा|थोडी|जरा|हल्का|zara|thoda|thodi|halka/;
        lotRe = /lot|much|far|fast|big|more|chunk|huge|बहुत|ज्यादा|काफी|bahut|zyada|kaafi|kafi/;
      }
      if (littleRe.test(t)) return { mult: 0.35, edge: null, page: false };
      if (lotRe.test(t)) return { mult: 2.5, edge: null, page: false };
      return { mult: 1, edge: null, page: false };
    }

    // "Did you mean …" support: when nothing matched, find the phrase that
    // is closest to what was heard. This turns a misheard word into a
    // helpful hint instead of silence.
    function suggest(raw) {
      var heard = normalize(raw);
      if (!heard || heard.length < 2) return null;
      var best = null;
      for (var oi = 0; oi < CMD_ORDER.length; oi++) {
        var cmd = CMD_ORDER[oi];
        var list = (phrases && phrases[cmd]) || [];
        for (var i = 0; i < list.length; i++) {
          var phrase = list[i].join(' ');
          var d = lev(heard, phrase);
          var limit = phrase.length <= 5 ? 1 : 2;
          // A spoken word that starts like a command word ("downward") is
          // just as likely a mishearing as a typo.
          if (d > limit && heard.length > 3 && phrase.length > 3 &&
              heard.indexOf(phrase) === 0) d = Math.min(d, limit);
          if (d > limit) continue;
          if (d === 0) continue; // an exact match is not a mishearing
          if (!best || d < best.distance || (d === best.distance && phrase.length > best.phrase.length)) {
            best = { cmd: cmd, phrase: phrase, distance: d };
          }
        }
      }
      return best;
    }

    return {
      parseCommand: parseCommand,
      parseModifier: parseModifier,
      suggest: suggest,
      refresh: rebuild,
      isHindi: isHindi
    };
  }

  /* ================= settings storage ================= */
  // Sync storage is the primary store so the settings follow the user across
  // devices. Managed browsers can disable it — there we fall back to local
  // storage instead of silently losing every setting.
  var storageMode = 'sync';

  function storageGet(defaults, cb) {
    var done = function (items) {
      try { cb(items && typeof items === 'object' ? items : defaults); } catch (e) {}
    };
    var run = function (areaName) {
      try {
        var area = chrome.storage[areaName];
        if (!area || typeof area.get !== 'function') { done(defaults); return; }
        area.get(defaults, function (items) {
          var err = (chrome.runtime && chrome.runtime.lastError) || null;
          if (err && areaName === 'sync') {
            storageMode = 'local';
            run('local');
            return;
          }
          done(items);
        });
      } catch (e) { done(defaults); }
    };
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) { done(defaults); return; }
      run(storageMode);
    } catch (e) { done(defaults); }
  }

  function storageSet(data, cb) {
    var done = function (err) { if (typeof cb === 'function') { try { cb(err); } catch (e) {} } };
    var run = function (areaName) {
      try {
        var area = chrome.storage[areaName];
        if (!area || typeof area.set !== 'function') { done(null); return; }
        var p = area.set(data);
        if (p && typeof p.then === 'function') {
          p.then(function () { done(null); }, function (err) {
            if (areaName === 'sync') { storageMode = 'local'; run('local'); }
            else done(err);
          });
        } else done(null);
      } catch (e) { done(e); }
    };
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) { done(null); return; }
      run(storageMode);
    } catch (e) { done(e); }
  }

  /* ================= shared speech engine ================= */
  // Both the page engine (content.js) and the voice hub (voice-hub.js) feed
  // recognizer results through this, so they behave identically:
  //  - per-segment deduplication (one command per utterance)
  //  - a short interim settling window so "down three" is never cut in half
  //  - incremental upgrades ("down" -> "down three" scrolls only the rest)
  //  - final-transcript authority: a changed final command is never swallowed
  //
  // opts:
  //   match(text)            -> { cmd, score } | null
  //   mod(text, cmd)         -> { mult, edge, page }
  //   onExec(action)         -> called with the action to perform
  //   onMiss(text, conf)     -> called when a final transcript matched nothing
  //   settleMs               -> interim settling window (default 60 ms)
  //   maxWaitMs              -> hard cap for that window (default 120 ms)
  function createEngine(opts) {
    var o = opts || {};
    var match = typeof o.match === 'function' ? o.match : function () { return null; };
    var mod = typeof o.mod === 'function' ? o.mod : function () { return { mult: 1, edge: null, page: false }; };
    var onExec = typeof o.onExec === 'function' ? o.onExec : function () {};
    var onMiss = typeof o.onMiss === 'function' ? o.onMiss : function () {};
    // The settling window is deliberately short: a command must feel instant.
    // A burst of interim results is coalesced inside this window, and the
    // hard cap makes sure the wait can never grow beyond maxWaitMs — a
    // longer phrase ("down three") is completed by the upgrade path anyway.
    var settleMs = (typeof o.settleMs === 'number') ? o.settleMs : 60;
    var maxWaitMs = (typeof o.maxWaitMs === 'number') ? o.maxWaitMs : 120;
    var maxSegments = o.maxSegments || 60;
    var maxAgeMs = o.maxAgeMs || 120000;

    var segments = {};   // segment index -> { t, cmd, done, final, mod, text }
    var timers = {};     // segment index -> pending settle timer
    var firstSeen = {};  // segment index -> when the first match arrived

    function clearTimers() {
      for (var k in timers) {
        try { clearTimeout(timers[k]); } catch (e) {}
      }
      timers = {};
      firstSeen = {};
    }

    function prune() {
      try {
        var keys = Object.keys(segments);
        if (keys.length <= maxSegments) return;
        var now = Date.now();
        for (var i = 0; i < keys.length; i++) {
          var en = segments[keys[i]];
          if (en && (now - en.t) > maxAgeMs) delete segments[keys[i]];
        }
        var rest = Object.keys(segments);
        if (rest.length > maxSegments) {
          rest.sort(function (a, b) { return segments[a].t - segments[b].t; });
          for (var j = 0; j < rest.length - maxSegments; j++) delete segments[rest[j]];
        }
      } catch (e) {}
    }

    function clearTimer(seg) {
      if (timers[seg]) {
        try { clearTimeout(timers[seg]); } catch (e) {}
        delete timers[seg];
      }
    }

    function record(seg, cmd, modObj, text, final) {
      segments[seg] = { t: Date.now(), cmd: cmd, done: true, final: !!final, mod: modObj, text: text };
      delete firstSeen[seg];
    }

    // Pick the best alternative: a longer matched phrase always wins, then
    // the earlier alternative (Chrome already returns them in confidence
    // order), then the raw confidence as a last tiebreaker.
    function pick(cands) {
      var best = null;
      for (var i = 0; i < (cands || []).length; i++) {
        var c = cands[i];
        if (!c || !c.text) continue;
        var hit = match(c.text);
        if (!hit) continue;
        var s = (hit.score || 0) * 1000 - i * 100 + Math.round((c.conf || 0) * 10);
        if (!best || s > best.s) {
          best = { hit: hit, s: s, text: c.text, conf: c.conf || 0, alt: i };
        }
      }
      return best;
    }

    function emit(action) {
      try { onExec(action); } catch (e) {}
      return action;
    }

    // Returns the action that was performed (or null).
    function handle(cands, isFinal, seg) {
      prune();
      seg = String(seg);
      var prev = segments[seg];
      var best = pick(cands);

      if (!best) {
        // A final transcript that matches nothing must not leave a stale
        // interim command waiting to fire.
        if (isFinal) {
          clearTimer(seg);
          if (prev) prev.final = true;
          var top = (cands && cands[0]) || null;
          try { onMiss(top ? top.text : '', top ? (top.conf || 0) : 0); } catch (e) {}
        }
        return null;
      }

      var cmd = best.hit.cmd;
      var m = mod(best.text, cmd) || { mult: 1, edge: null, page: false };
      if (typeof m.mult !== 'number' || !isFinite(m.mult)) m.mult = 1;

      // ---- this segment already produced a command ----
      if (prev && prev.done) {
        if (cmd === prev.cmd) {
          // Same command: only a *bigger* quantifier / a new edge may fire.
          if (UPGRADABLE[cmd]) {
            var om = prev.mod || { mult: 1, edge: null, page: false };
            if (m.edge && m.edge !== om.edge) {
              record(seg, cmd, m, best.text, isFinal);
              return emit({
                type: 'upgrade', cmd: cmd, mod: m, text: best.text, conf: best.conf,
                segment: seg, edge: m.edge, delta: 0, page: !!m.page
              });
            }
            if (!m.edge && !om.edge && (m.mult || 1) > (om.mult || 1)) {
              record(seg, cmd, m, best.text, isFinal);
              return emit({
                type: 'upgrade', cmd: cmd, mod: m, text: best.text, conf: best.conf,
                segment: seg, edge: null, delta: (m.mult || 1) - (om.mult || 1), page: !!m.page
              });
            }
          }
          if (isFinal) prev.final = true;
          return null; // genuine duplicate interim/final overlap
        }

        // Different command in the same utterance. The interim guess was
        // wrong, so the final transcript wins — a command is never dropped
        // (this is what keeps "stop" from being swallowed by a "down" that
        // was heard a moment earlier).
        if (isFinal) {
          clearTimer(seg);
          record(seg, cmd, m, best.text, true);
          return emit({
            type: 'command', cmd: cmd, mod: m, text: best.text, conf: best.conf, segment: seg
          });
        }
        return null; // wait for the final transcript to decide
      }

      // ---- first command of this segment ----
      if (IMMEDIATE[cmd]) {
        // Safety commands fire with zero delay.
        clearTimer(seg);
        record(seg, cmd, m, best.text, true);
        return emit({
          type: 'command', cmd: cmd, mod: m, text: best.text, conf: best.conf, segment: seg
        });
      }

      if (isFinal) {
        clearTimer(seg);
        record(seg, cmd, m, best.text, true);
        return emit({
          type: 'command', cmd: cmd, mod: m, text: best.text, conf: best.conf, segment: seg
        });
      }

      // Interim: wait for the settling window so multi-word modifiers
      // ("down three") are heard in full. The window is short and hard
      // capped — a command must never feel delayed.
      var now = Date.now();
      if (!firstSeen[seg]) firstSeen[seg] = now;
      if (timers[seg]) clearTimer(seg);
      // The deadline is the earlier of "settleMs from now" and the hard cap
      // measured from the first match: a burst of interim results can never
      // push the command beyond it.
      var deadline = now + settleMs;
      var hard = firstSeen[seg] + maxWaitMs;
      if (hard < deadline) deadline = hard;
      var wait = deadline - now;
      if (wait < 0) wait = 0;
      (function (s, b, mm) {
        timers[s] = setTimeout(function () {
          delete timers[s];
          delete firstSeen[s];
          var p = segments[s];
          if (p && p.done) return;
          record(s, b.hit.cmd, mm, b.text, false);
          emit({
            type: 'command', cmd: b.hit.cmd, mod: mm, text: b.text, conf: b.conf || 0, segment: s
          });
        }, wait);
      })(seg, best, m);
      return null;
    }

    return {
      handle: handle,
      // A fresh recognizer restarts result indices at 0; stale dedup entries
      // from the previous instance would suppress new commands, so drop them.
      reset: function () {
        clearTimers();
        segments = {};
      },
      stop: function () { clearTimers(); },
      segments: function () { return segments; }
    };
  }

  /* ================= cheat sheet rows ================= */
  // Builds the on-page help card from the phrases the user actually
  // configured, so the sheet always matches the live configuration.
  var HELP_MEANING = {
    dn: 'Scroll a step', up: 'Scroll a step back', pd: 'Scroll by page', pu: 'Scroll by page back',
    top: 'Jump to the top', bot: 'Jump to the bottom',
    stop: 'Stop scrolling', sleep: 'Pause listening', wake: 'Resume listening',
    faster: 'Speed up', slower: 'Slow down', help: 'Show this cheat sheet'
  };

  var HELP_MEANING_HI = {
    dn: 'नीचे स्क्रॉल', up: 'ऊपर स्क्रॉल', pd: 'पूरा पेज नीचे', pu: 'पूरा पेज ऊपर',
    top: 'सबसे ऊपर', bot: 'सबसे नीचे',
    stop: 'रोकें', sleep: 'सुनना रोकें', wake: 'फिर से सुनें',
    faster: 'तेज़ करें', slower: 'धीमा करें', help: 'यह चीट शीट'
  };

  function helpRows(cfg) {
    cfg = cfg || DEFAULTS;
    var hi = /^hi(-|_|$)/i.test(String(cfg.lang || ''));
    var order = ['dn', 'up', 'pd', 'pu', 'top', 'bot', 'stop', 'sleep', 'wake', 'faster', 'slower', 'help'];
    var rows = [];

    for (var i = 0; i < order.length; i++) {
      var cmd = order[i];
      var key = CMD_KEYS[cmd];
      var list = String(cfg[key] || '').split(',');
      var picked = [];
      for (var j = 0; j < list.length && picked.length < 2; j++) {
        var t = String(list[j]).trim();
        if (t) picked.push(t);
      }
      if (hi && HI_PHRASES[cmd] && HI_PHRASES[cmd].length) {
        picked.push(String(HI_PHRASES[cmd][0]).trim());
      }
      if (!picked.length) continue;
      rows.push([picked.join(' · '), hi ? HELP_MEANING_HI[cmd] : HELP_MEANING[cmd]]);
    }
    return rows;
  }

  /* ================= command list ================= */
  // The data behind the on-page command grid: what you can say, in the
  // wording the user actually configured.
  var GRID_ORDER = ['dn', 'up', 'pd', 'pu', 'top', 'bot', 'faster', 'slower',
                    'undo', 'stop', 'sleep', 'wake', 'help'];

  function commandList(cfg) {
    cfg = cfg || DEFAULTS;
    var hi = /^hi(-|_|$)/i.test(String(cfg.lang || ''));
    var out = [];
    for (var i = 0; i < GRID_ORDER.length; i++) {
      var cmd = GRID_ORDER[i];
      var key = CMD_KEYS[cmd];
      var raw = String(cfg[key] || '').split(',');
      var en = '';
      for (var j = 0; j < raw.length && !en; j++) {
        var t = String(raw[j]).trim();
        if (t) en = t;
      }
      var hiPhrase = (hi && HI_PHRASES[cmd] && HI_PHRASES[cmd].length) ? String(HI_PHRASES[cmd][0]) : '';
      out.push({
        cmd: cmd,
        label: hi ? (HELP_MEANING_HI[cmd] || cmd) : (HELP_MEANING[cmd] || cmd),
        phrase: hi ? (hiPhrase || en || cmd) : (en || cmd),
        alt: hi ? en : hiPhrase
      });
    }
    return out;
  }

  return {
    createMatcher: createMatcher,
    createEngine: createEngine,
    normalize: normalize,
    isKeep: isKeep,
    helpRows: helpRows,
    commandList: commandList,
    storageGet: storageGet,
    storageSet: storageSet,
    storageMode: function () { return storageMode; },
    DEFAULTS: DEFAULTS,
    CMD_KEYS: CMD_KEYS,
    HOMOPHONES: HOMOPHONES,
    NUM_WORDS: NUM_WORDS,
    HI_NUM_WORDS: HI_NUM_WORDS,
    HI_PHRASES: HI_PHRASES,
    CMD_ORDER: CMD_ORDER
  };
})();

if (typeof window !== 'undefined') window.VSCore = VSCore;
if (typeof self !== 'undefined' && self) self.VSCore = VSCore;
