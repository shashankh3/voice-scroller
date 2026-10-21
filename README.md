# VoiceScroll Ultimate (v28.0) — voice scrolling for Chrome AND Edge

Hands-free scrolling for **any website, any native PDF, any embedded file**
opened inside Chrome or Edge, using the built-in Web Speech API (no extra
server, no API key — audio is processed by the browser's speech service).
Click **Enable Microphone**, then speak.

Folder: `extension/` (load this folder as an unpacked extension).

## What's new in v28.1 — "works flawlessly"

A reliability pass over every path that can fail in the field, with a new
**fault-injection suite** that proves each one (264 assertions in total).

- **A scroll command can never silently do nothing.** The target handling is
  now one verified chain — window → inner container → child frame → trusted
  input — and the next target is only tried when the previous one *really*
  did not move. If nothing can move, the indicator says **"Nothing to scroll
  here"** instead of pretending it worked.
- **Quick commands move the full distance.** Two commands 120 ms apart used
  to cut the first glide short ("down down" moved 400 px instead of 800 px).
  A running animation is now *finished* rather than cancelled, and the echo
  guard shrank from 380 ms to 50 ms (below the shortest possible gap between
  two spoken words) so a deliberate "down down" is never swallowed.
- **A speech service that refuses to start no longer kills the engine.**
  `start()` failures are retried (3 × with backoff) before giving up, and
  only then reported as *"Could not start mic"*.
- **The auto-scroll only reports "End of page" when the target really is at
  the end** — a step that rounds to zero no longer looks like the end of the
  document, and the minimum step is one pixel per frame.
- **The indicator stops nagging.** The *"no command"* hint is shown for the
  first unmatched utterance of a row only, and a *speed* change no longer
  overwrites the "Faster" message of the very command that caused it.
- **The popup never piles up requests** — a refresh that is still running
  blocks the next one.
- **The tests now simulate Chrome correctly.** The result list grows per
  utterance, exactly like the browser's `SpeechRecognitionResultList`; the
  new `tests/mock-browser.js` shares one mock across all suites.

## What's new in v28.0 — learn from the best, then do better

Borrowed the interaction ideas that make the OS voice controls (Apple Voice
Control, Google Voice Access, Windows Voice Access) and voice-first tools
(Talon, Dragon) genuinely usable — and added the two things none of them
have.

- **An interactive command grid** (Apple/Google Voice Control style). Say
  `help` and the page shows a grid of everything you can say, built from
  *your* configured phrases — not a static cheat sheet:
  - the tile of the command you just said lights up,
  - **say a number to run that command** ("three" → page down),
  - click a tile to run it, `Esc` or a click outside closes the grid,
  - fully keyboard accessible (`role="dialog"`, focus ring, `Esc`/`Enter`).
  It teaches the vocabulary while you use it — the single biggest thing
  every competitor leaves out.
- **"did you mean …"** — when nothing matched, the closest command is
  offered instead of silence: *"botom"* → *"did you mean “bottom”?"*. Built
  on the same edit-distance machinery the matcher already uses.
- **A new `undo` command** — a correction gesture that *no* voice tool has:
  say `undo` (or `undo that`, `take it back`, `back up`, `पीछे`) and the
  last scroll **or the last jump to an edge** is taken back. It works on web
  pages, in inner scroll containers and in PDF mode.
- **More natural edge jumps** — "to the bottom of the page", "to the very
  end", "to the beginning", "scroll to the top" now do what they say.
- **`undo` wins over a scroll command** when both are heard ("undo scroll
  down"), because an undo modifies the last action instead of being one.
- The command grid, the suggestions and the undo are all covered by the test
  suite (243 assertions), including an end-to-end check that `undo` really
  puts the page back where it was.

## What's new in v27.2 — instant response, no errors, never stuck

The command path is now as short as the Web Speech API allows: a spoken
command moves the page **within ~60 ms** of the browser delivering the
transcript, and the whole page reacts in well under 120 ms.

- **The settling window shrank from 210 ms to 60 ms** — and, crucially, it is
  no longer an open-ended debounce. A burst of interim results is coalesced
  inside the window, but a hard cap (120 ms) makes sure a command can never
  be postponed by a long utterance. Multi-word commands ("down three") are
  still completed exactly, by the upgrade path: the first step runs
  immediately and the remaining steps are added the moment the number is
  heard.
- **The scroll animation is shorter and punchier** (90–240 ms instead of
  160–520 ms) and the cubic ease-out front-loads the travel, so most of the
  distance is covered in the first frames.
- **Auto-scroll and the cross-frame bridge no longer fight the page.** A
  page with `scroll-behavior: smooth` used to make every scroll lag behind
  (and could even trigger the "end of page" stop). All scrolling now uses
  the explicit `instant` behavior, for the window *and* for inner
  containers.
- **A watchdog brings the engine back** if it ever claims to be listening
  while the recognizer is actually gone — the extension can no longer end
  up "listening but dead".
- **No console output, ever.** The extension never logs, so the page console
  stays clean; every API call, callback and animation frame is guarded, so
  a failure can never surface as an unhandled error.
- **The latency is now part of the test suite.** The engine test asserts
  that a command fires within 120 ms, and the end-to-end test asserts that
  the page really reacts to a spoken "down" within 120 ms.

## Fixed in v27.1 — the "works once, then gets stuck" bug + production hardening

- **The recognizer can no longer get stuck in a restart loop.** Aborting a
  live recognizer makes the browser fire one more `end` event. That event
  used to be handled as if the session had ended on its own, so it
  scheduled *another* restart — which aborted the freshly started
  recognizer, which fired another `end` event… The result was a new
  recognizer every 150–250 ms: the extension kept showing "Listening" but
  could never hear a complete command, so it worked for the first word or
  two and then appeared dead.
  - Every recognizer instance is now **invalidated before it is aborted**,
    and all of its events (`start`, `result`, `error`, `end`) are ignored
    once a newer instance exists. A stale instance can therefore never
    schedule a restart or deliver a result into the new session.
  - `restartRecognizer()` no longer aborts and restarts in two steps.
  - A recognizer that dies immediately over and over (a genuinely broken
    speech service) now stops cleanly with *"Speech service unstable"*
    instead of restarting forever. A normal session end (the browser's
    silence timeout) is not treated as a failure and restarts in 150 ms.
- **No single exception can kill a feature any more.** The scroll and
  auto-scroll `requestAnimationFrame` loops always reschedule themselves,
  and every recognizer callback is guarded — an error in the page can no
  longer leave the scroller silently frozen.
- **The ON badge does not survive a page reload** (it used to stick to a
  tab whose engine was gone). PDF tabs in hub mode keep their badge.
- **The cross-frame scroll bridge is authenticated.** Payloads carry a
  random per-session token, so a web page can no longer post forged
  scroll messages into an embedded frame.
- **A hidden tab stops auto-scrolling** and every timer is released when
  the page goes away.
- **Settings survive managed browsers.** Sync storage is still the primary
  store, but if it is disabled the extension falls back to local storage
  instead of losing every setting.
- **The PDF input engine explains itself.** "DevTools is already debugging
  this tab" now produces a real hint instead of a generic failure.
- **The popup is production-grade UI:** `aria-live` status and alert
  regions, accessible names on every command field, visible keyboard focus,
  `prefers-reduced-motion` support, live validation that flags command
  groups with an empty phrase list, and prioritised warnings (a status
  refresh can no longer wipe an error message).
- **Regression tests for exactly this.** `tests/test-extension-wiring.js`
  drives the extension with a mock recognizer that reproduces the
  browser's "abort fires `end`" behaviour and asserts that a language
  change, a natural session end, a failing service and a navigation each
  lead to bounded, correct behaviour. `npm test` runs the whole suite
  (205 assertions) plus a syntax and manifest check.

## What's new in v27.0 — one engine, no lost commands, honest errors

- **One shared speech engine.** The interim/final decision logic (segment
  dedup, the 210 ms settling window, quantifier upgrades) now lives in
  `vs-core.js` and is used by *both* the page engine and the PDF voice hub,
  so a command behaves identically everywhere — and it is unit-tested
  (`tests/test-vs-core.js`, 153 assertions).
- **A command is never swallowed.** The final transcript is authoritative: if
  the interim guess was "down" but the final result is "page down" (or
  **"stop"**), the final command runs instead of being dropped. Previously a
  safety command like *stop* could be eaten by an earlier partial result, so
  auto-scroll kept running. A final result that matches nothing also cancels
  the stale interim, so a wrong command can no longer fire late.
- **Changing the speech language now takes effect immediately.** The matcher
  is rebuilt when the language changes, so the हिन्दी pack activates without
  reloading the page.
- **One microphone at a time.** The background keeps a registry of the
  listening tab; starting an engine anywhere retires the previous one (page
  engine *and* PDF hub), and the toolbar button is now a true global
  on/off switch. Two live recognizers used to fight over the mic and both
  died with "audio-capture".
- **Honest error reporting.** Blocked microphone, missing hardware, refused
  language or a missing speech service are reported in the popup (and on the
  page) instead of silently showing "Inactive".
- **The cheat sheet matches your configuration.** Say `help` and the on-page
  card is generated from the phrases you actually configured (plus the Hindi
  pack when the language is हिन्दी).
- **Auto-scroll stops at the edge.** When the end of the document is reached
  the glide stops with an "End of page" note instead of grinding against the
  bottom forever; a stuck inner container no longer blocks the frame/debugger
  fallbacks.
- **Smoother PDF scrolling.** The viewport size of a PDF tab is cached, so
  each auto-scroll tick needs one debugger round trip instead of two — the
  glide is visibly smoother and cheaper.
- **Single source of truth.** The settings defaults live in `vs-core.js`
  instead of being copied into four files, and the manifest declares
  `minimum_chrome_version: 109`.
- **New smoke test.** `tests/test-extension-wiring.js` loads every extension
  file in a sandbox with a mocked browser API and verifies that the
  background, the content script and the voice hub all wire up correctly.

## Kept from v26.0

- **हिन्दी voice commands (Devanagari + Hinglish)** — नीचे / ऊपर / पेज नीचे /
  पेज ऊपर / टॉप / सबसे नीचे / रुको / सो जाओ / जागो / तेज़ / धीरे / मदद, plus
  romanized Hinglish (neeche, oopar, ruko, jago, tez, dheere, madad) and
  quantifiers (नीचे तीन, थोड़ा, बहुत, आधा पेज, एकदम नीचे). Normalization
  collapses spelling variants (nukta: तेज़→तेज; anusvara: नीचें→नीचे) and
  converts Devanagari digits (१२ → 12). English stays active alongside Hindi.
- **"help" voice command + on-page cheat sheet** — say `help` /
  `what can I say` / `मदद` for an instant on-page command card (auto-hides in
  8 s, click to dismiss). The floating 🎤 orb is clickable to toggle
  listening, same as Alt+Shift+V.
- **Frame-locked auto-scroll** — the web auto-scroller runs on
  requestAnimationFrame with time-based velocity (speed 40 ≈ 800 px/s)
  instead of 45 ms interval jumps: equally smooth at 60/120/144 Hz.
- **Zero-latency interim engine** (210 ms settling), per-segment settle
  timers, cached inner-scroll scan, cross-frame scroll bridge, native PDF
  mode with trusted input, earcons, ON badge, popup tuning.

## How the engine picks its mode

| Active tab is… | Recognition runs in… | Scrolling done by… |
|---|---|---|
| Normal website / SPA | content.js in the page | rAF precision scroller (window, inner container, sub-frame bridge) |
| Native PDF viewer tab | voice hub (offscreen doc, tab fallback) | `chrome.debugger` trusted wheel / keys |
| Embedded PDF inside a page | content.js in the page | debugger relay, then synthetic wheel |
| `chrome://`, `edge://`, store pages | — | blocked by the browser (popup explains) |

## Voice commands (defaults, all editable in popup)

- **Scroll:** `down`, `up` (also `scroll down`, `go down`, …)
- **Quantifiers:** `down three`, `down twice`, `down a little`, `down a lot`, `half page`
- **Page:** `page down`, `page up` (also `next page`, `previous page`, …)
- **Jump:** `top`, `bottom` (or `all the way down`, `to the very end`, `to the beginning`)
- **Undo:** `undo`, `undo that`, `take it back`, `back up` — takes back the last scroll or jump
- **Auto-scroll:** `keep scrolling down` / `keep scrolling up` → `faster` / `slower` → `stop`
- **Hands-free Pause:** `sleep` → `wake up`
- **Help:** `help`, `what can I say` — opens the interactive command grid (say a number to run a command)
- **हिन्दी (speech language hi-IN):** `नीचे` · `ऊपर` · `पेज नीचे` · `पेज ऊपर` ·
  `टॉप` · `सबसे नीचे` · `रुको` · `सो जाओ` / `जागो` · `तेज़` / `धीरे` ·
  `चलते रहो` · `पीछे` (undo) · `मदद` — plus Hinglish (neeche, oopar, ruko,
  tez, madad…)
- **Shortcut:** `Alt+Shift+V` toggles listening anywhere (web and PDF tabs);
  the 🎤 orb on the page is clickable too.

## Install (Developer mode) — Chrome

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → select the **`extension`** folder (the one containing
   `manifest.json`) → **Select Folder**.
   ⚠️ Selecting the outer `voice-scroller` folder itself gives
   "Could not load manifest" — you must pick the inner `extension` folder.
3. Pin **VoiceScroll Ultimate** to the toolbar.
4. Open any long page (e.g. `https://en.wikipedia.org/wiki/Chrome`),
   click the icon → **Enable Microphone** → **Allow** mic when the browser asks.
5. Say `down`, `up`, `page down`, `top`, `bottom`, `stop`.

## Install — Microsoft Edge (Chromium)

Same steps at `edge://extensions`. Notes:

- Speech runs through Edge's speech service; on-device recognition (Edge 150+,
  experimental) can be enabled in Edge settings.
- PDFs work identically (Edge's PDF viewer is the same Chromium architecture).
- If Edge reports a language as unsupported, either pick English (US) or update
  Edge — the engine will not restart-loop; it stops cleanly with a message.

## PDFs

- **HTTPS PDFs** (e.g. arXiv paper): open the PDF, click **Enable** — the popup
  switches to **PDF mode** automatically. Allow mic once (popup prompt);
  afterwards the hub starts silently.
- **Local `file://` PDFs:** PDF mode does not need "Allow access to file URLs".
- **PDFs embedded in web pages** (`<embed>/<object>/<iframe>`): handled by the
  content script + trusted-input relay automatically.
- If a PDF downloads instead of opening:
  `chrome://settings/content/pdfDocuments` → turn OFF *Download PDFs*.

## Troubleshooting

- **"Mic blocked"** → click the 🔒/🎤 icon in the address bar → set Microphone to
  **Allow** → reload → Enable again. Mic permission is per-site.
- **"Microphone blocked" in the popup** → the error code is shown next to the
  status card; allow the mic for the extension origin (the popup asks once)
  and press Enable again.
- **A thin "is debugging this browser" bar appears** → that's PDF mode: the
  trusted input engine drives the PDF viewer. It disappears when you stop the
  hub (or is dismissed by clicking its ✕, which disables PDF scrolling).
- **"Extensions are blocked on this page"** → browsers forbid extensions on the
  Web/Edge store, `chrome://`, `edge://`, `about:` pages. Use any normal site or PDF.
- **"Could not load manifest" at install** → you selected the wrong folder.
  Re-do **Load unpacked** and pick the inner `extension/` folder.
- **"Could not start here — refresh"** → reload the tab (a tab opened before
  extension install or reload has no content script yet), then Enable.
- **Listening stops after silence** → auto-restarts with smooth backoff; if the
  network drops, it backs off and resumes automatically.
- **It worked for a word or two and then went quiet** → that was the restart
  loop fixed in v27.1; reload the extension at `chrome://extensions` (⟳ Reload)
  to pick up the fix. If it happens again, the page HUD shows
  *"Speech service unstable"* — that means the browser's speech service is
  failing, and pressing Enable again usually clears it.
- **Two tabs seem to fight over the mic** → they cannot any more: enabling
  listening in one place retires the engine everywhere else.
- **Voice language** → select your language under Precision → Speech language.
  The हिन्दी pack activates immediately, no reload needed.

## Privacy

- **Nothing leaves your browser.** VoiceScroll has no server, no account
  and no analytics. Speech is recognised by the browser's own speech
  service (Chrome/Edge) — the extension only sees the transcript text.
- **The extension stores your settings** (scroll distance, speed, language,
  your custom command phrases) in `chrome.storage.sync`, so they follow you
  to another browser profile. If sync storage is unavailable (managed
  browser), the settings are kept in `chrome.storage.local` instead.
- **The microphone is only used while listening is enabled.** The browser's
  speech service is the only consumer of the audio; the extension never
  records or uploads it.
- **The `debugger` permission is only used in PDF mode**, to drive the
  native PDF viewer with trusted wheel / Home / End events. It is attached
  only while PDF mode is running and is detached again when you stop.
- **Page content is never read** beyond what is needed to find the scroll
  container of the page you are on.

## Verification

```powershell
npm test          # syntax + manifest + 264 assertions
```

or step by step:

```powershell
node --check extension/vs-core.js
node --check extension/content.js
node --check extension/background.js
node --check extension/voice-hub.js
node --check extension/popup.js
node tests/test-vs-core.js
node tests/test-extension-wiring.js
node tests/test-resilience.js
python -c "import json; json.load(open('extension/manifest.json')); print('manifest OK')"
```

Reload at `chrome://extensions` → **⟳ Reload** to apply changes.
