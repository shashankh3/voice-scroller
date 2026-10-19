/* VoiceScroll Ultimate — shared command-matching engine (vs-core).
 * Loaded in every context that needs to decode speech into commands:
 * content scripts, the voice hub (offscreen / tab fallback) and the
 * background service worker (via importScripts).
 * Exposes VSCore.createMatcher(cfg) -> { parseCommand, parseModifier },
 * plus isKeep() for auto-scroll detection and locale packs for
 * English + हिन्दी (Devanagari AND romanized Hinglish).
 */
var VSCore = (function () {
  'use strict';

  // ---------- normalization ----------
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
    'स्टाॅप': 'स्टॉप', 'स्तॉप': 'स्टॉप',
    'पेजस': 'पेज',
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
    'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाच': 5, 'छह': 6, 'छः': 6,
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

  var CMD_ORDER = ['sleep', 'wake', 'stop', 'faster', 'slower', 'pd', 'pu', 'top', 'bot', 'dn', 'up', 'help'];

  // "keep scrolling" detection shared by content, hub and background —
  // English + हिन्दी (चलते रहो / जारी रखो) + romanized Hinglish.
  var KEEP_RE = /\b(keep|continue|keep going|keep scrolling|start scrolling)\b/i;
  var HI_KEEP_RE = /चलते रहो|चलती रहो|चलाते रहो|स्क्रॉल करते रहो|जारी रखो|जारी रहो|chalte raho|chaltee raho|challate raho|scroll karte raho|jaari rakho|jari rakho|jari raho/i;

  function isKeep(raw) {
    var t = ' ' + normalize(raw) + ' ';
    return KEEP_RE.test(t) || HI_KEEP_RE.test(t);
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
    var sensitivity = cfg && cfg.sensitivity || 'balanced';
    var isHindi = /^hi(-|_|$)/i.test(String((cfg && cfg.lang) || ''));

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
      var map = {
        dn: cfg.cDn, up: cfg.cUp, pd: cfg.cPd, pu: cfg.cPu,
        top: cfg.cTop, bot: cfg.cBot, stop: cfg.cStop,
        sleep: cfg.cSleep, wake: cfg.cWake,
        faster: cfg.cFaster, slower: cfg.cSlower, help: cfg.cHelp
      };
      var pack = isHindi ? HI_PHRASES : null;
      for (var k in map) {
        var list = splitPhrases(map[k]);
        if (pack && pack[k]) {
          var seen = {};
          for (var i = 0; i < list.length; i++) seen[list[i].join(' ')] = 1;
          for (var j = 0; j < pack[k].length; j++) {
            var p = homophoneFix(normalize(pack[k][j]).split(' ').filter(Boolean), HOMOPHONES);
            if (p.length && !seen[p.join(' ')]) {
              seen[p.join(' ')] = 1;
              list.push(p);
            }
          }
        }
        list.sort(function (a, b) { return b.length - a.length; }); // longer phrases first
        phrases[k] = list;
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
      var edgeDown = /all the way down|right to the bottom|to the very bottom|all down/.test(t) ||
        (isHindi && /एकदम नीचे|पूरा नीचे|पूरे नीचे|पूरी नीचे|बिल्कुल नीचे/.test(t));
      var edgeUp = /all the way up|right to the top|to the very top|all up/.test(t) ||
        (isHindi && /एकदम ऊपर|पूरा ऊपर|पूरे ऊपर|पूरी ऊपर|बिल्कुल ऊपर/.test(t));
      if (edgeDown && (cmd === 'dn' || cmd === 'pd')) return { mult: 0, edge: 'bot' };
      if (edgeUp && (cmd === 'up' || cmd === 'pu')) return { mult: 0, edge: 'top' };

      var halfRe = /half(\s*a)? page|halfway/;
      if (isHindi) halfRe = /half(\s*a)? page|halfway|आधा( पेज)?|aadha( page)?/;
      if (halfRe.test(t)) return { mult: 0.5, edge: null, page: true };

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
        if (!n && isHindi) {
          for (var h in HI_NUM_WORDS) {
            if (t.indexOf(' ' + h + ' ') !== -1) {
              n = HI_NUM_WORDS[h];
              break;
            }
          }
        }
      }
      if (n >= 1 && n <= 10) return { mult: n, edge: null };

      var littleRe = /little|bit|slight|gentle|slowly|tiny|touch|nudge/;
      var lotRe = /lot|much|far|fast|big|more|chunk|huge/;
      if (isHindi) {
        littleRe = /little|bit|slight|gentle|slowly|tiny|touch|nudge|थोडा|थोडी|जरा|हल्का|zara|thoda|thodi|halka/;
        lotRe = /lot|much|far|fast|big|more|chunk|huge|बहुत|ज्यादा|काफी|bahut|zyada|kaafi|kafi/;
      }
      if (littleRe.test(t)) return { mult: 0.35, edge: null };
      if (lotRe.test(t)) return { mult: 2.5, edge: null };
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
    isKeep: isKeep,
    HOMOPHONES: HOMOPHONES,
    NUM_WORDS: NUM_WORDS,
    HI_NUM_WORDS: HI_NUM_WORDS,
    HI_PHRASES: HI_PHRASES,
    CMD_ORDER: CMD_ORDER
  };
})();

if (typeof window !== 'undefined') window.VSCore = VSCore;
if (typeof self !== 'undefined' && self) self.VSCore = VSCore;
