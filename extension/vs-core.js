/* VoiceScroll Ultimate — shared command-matching engine (vs-core).
 * Loaded in every context that needs to decode speech into commands:
 * content scripts, the voice hub (offscreen / tab fallback) and popup.
 * Exposes VSCore.createMatcher(cfg) -> { parseCommand(raw, cmd), parseModifier(raw, cmd) }.
 */
var VSCore = (function () {
  'use strict';

  // Curated phonetic homophone dictionary — only proven Web Speech mishearings.
  // Common English words (button, wait, star, pop, brown...) are deliberately NOT
  // mapped, so normal speech never triggers a scroll.
  var HOMOPHONES = {
    done: 'down', town: 'down', dawn: 'down', dowm: 'down', doun: 'down',
    doon: 'down', domn: 'down',
    app: 'up', opp: 'up', yup: 'up', sup: 'up',
    pages: 'page', payge: 'page', paige: 'page',
    stock: 'stop', shop: 'stop', stopp: 'stop',
    slip: 'sleep', sleap: 'sleep', seep: 'sleep',
    week: 'wake', weigh: 'wake', awake: 'wake', wakeup: 'wake',
    quicker: 'faster'
  };

  var NUM_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10,
    once: 1, twice: 2, thrice: 3,
    couple: 2, few: 3, several: 3
  };

  // Common English words that one-substitution fuzzy matching would otherwise
  // turn into commands (wait->wake, step->stop, half->halt, stops->stop,
  // fast->faster, slowly->slower, button->bottom). They only match exactly.
  var EXACT_ONLY = {
    wait: 1, woke: 1, wave: 1, wade: 1, wage: 1, step: 1, stops: 1,
    half: 1, fast: 1, slowly: 1, button: 1
  };

  var CMD_ORDER = ['sleep', 'wake', 'stop', 'faster', 'slower', 'pd', 'pu', 'top', 'bot', 'dn', 'up'];

  function normalize(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

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
    var sensitivity = cfg && cfg.sensitivity || 'balanced';

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
        return { cmd: bestCmd, score: bestScore, words: heard };
      }
      return null;
    }

    // Rebuild the phrase tables from a cfg-like object with cDn..cSlower fields.
    function rebuild() {
      phrases = {};
      var map = {
        dn: cfg.cDn, up: cfg.cUp, pd: cfg.cPd, pu: cfg.cPu,
        top: cfg.cTop, bot: cfg.cBot, stop: cfg.cStop,
        sleep: cfg.cSleep, wake: cfg.cWake,
        faster: cfg.cFaster, slower: cfg.cSlower
      };
      for (var k in map) {
        var list = String(map[k] || '').split(',')
          .map(function (s) { return homophoneFix(normalize(s).split(' ').filter(Boolean), HOMOPHONES); })
          .filter(function (a) { return a.length; });
        list.sort(function (a, b) { return b.length - a.length; }); // longer phrases first
        phrases[k] = list;
      }
    }

    var phrases = null;
    rebuild();

    // Modifiers: "down three" -> x3, "down a little" -> x0.35, "all the way down" -> edge.
    function parseModifier(raw, cmd) {
      var t = ' ' + normalize(raw) + ' ';
      var edgeDown = /all the way down|right to the bottom|to the very bottom|all down/.test(t);
      var edgeUp = /all the way up|right to the top|to the very top|all up/.test(t);
      if (edgeDown && (cmd === 'dn' || cmd === 'pd')) return { mult: 0, edge: 'bot' };
      if (edgeUp && (cmd === 'up' || cmd === 'pu')) return { mult: 0, edge: 'top' };
      if (/half(\s*a)? page|halfway/.test(t)) return { mult: 0.5, edge: null, page: true };

      var m = t.match(/\b(\d+)\b/);
      var n = 0;
      if (m) {
        n = parseInt(m[1], 10);
      } else {
        for (var w in NUM_WORDS) {
          if (t.indexOf(' ' + w + ' ') !== -1 || t.indexOf(' ' + w + 's ') !== -1) {
            n = NUM_WORDS[w];
            break;
          }
        }
      }
      if (n >= 1 && n <= 10) return { mult: n, edge: null };
      if (/little|bit|slight|gentle|slowly|tiny|touch|nudge/.test(t)) return { mult: 0.35, edge: null };
      if (/lot|much|far|fast|big|more|chunk|huge/.test(t)) return { mult: 2.5, edge: null };
      return { mult: 1, edge: null };
    }

    return {
      parseCommand: parseCommand,
      parseModifier: parseModifier,
      refresh: rebuild
    };
  }

  return {
    createMatcher: createMatcher,
    normalize: normalize,
    HOMOPHONES: HOMOPHONES,
    NUM_WORDS: NUM_WORDS,
    CMD_ORDER: CMD_ORDER
  };
})();

if (typeof window !== 'undefined') window.VSCore = VSCore;
if (typeof self !== 'undefined' && self) self.VSCore = VSCore;
