# VoiceScroll Ultimate (v26.0) — voice scrolling for Chrome AND Edge

Hands-free scrolling for **any website, any native PDF, any embedded file** opened
inside Chrome or Edge, using the built-in Web Speech API (no extra server, no API
key — audio is processed by the browser's speech service). Click
**Enable Microphone**, then speak.

Folder: `extension/` (load this folder as an unpacked extension).

## What's new in v26.0 — हिन्दी + help overlay + silky auto-scroll

- **हिन्दी voice commands (Devanagari + Hinglish)** — with the speech language
  set to हिन्दी (hi-IN) the matcher understands नीचे / ऊपर / पेज नीचे / पेज ऊपर /
  टॉप / सबसे नीचे / रुको / सो जाओ / जागो / तेज़ / धीरे / मदद — plus romanized
  Hinglish (neeche, oopar, ruko, jago, tez, dheere, madad…), because speech
  services often transcribe Hindi in Latin script. Quantifiers work too:
  नीचे तीन (×3), थोड़ा (nudge), बहुत (a lot), आधा पेज (half page),
  एकदम नीचे / एकदम ऊपर (edge jumps) and चलते रहो / जारी रखो (auto-scroll).
  Normalization collapses spelling variants (nukta: तेज़→तेज; anusvara:
  नीचें→नीचे) and converts Devanagari digits (१२ → 12). English phrases stay
  active alongside Hindi, and Hindi packs are only merged for hi-* languages —
  zero impact on English users.
- **"help" voice command + on-page cheat sheet** — say `help` /
  `what can I say` / `मदद` for an instant on-page command card (auto-hides in
  8 s, click to dismiss). The floating 🎤 orb is now clickable to toggle
  listening, same as Alt+Shift+V.
- **Frame-locked auto-scroll** — the web auto-scroller now runs on
  requestAnimationFrame with time-based velocity (speed 40 ≈ 800 px/s) instead
  of 45 ms interval jumps: equally smooth at 60/120/144 Hz. The
  inner-container and PDF probes are cached between frames so the loop stays
  light even on heavy pages.
- **Honest popup state** — pressing Enable/Stop now distinguishes "stopped"
  from "could not start" (previously a successful stop showed a red error).
  The popup button also self-corrects when listening was toggled off via the
  hotkey or the page orb.
- **Matcher test suite expanded** — `node tests/test-vs-core.js` now covers the
  full Hindi pack (Devanagari, Hinglish, numerals, modifiers, keep-scrolling)
  on top of the English guards.

## What's new in v25.2 — smoothness pass

- **Commands no longer vanish after auto-restarts.** The speech recognizer
  restarts itself routinely (after silence or a network blip); result indices
  restart at 0 while the duplicate-command filter kept stale entries from the
  previous recognizer instance, so a fresh command landing on a reused index
  could be silently ignored. Dedup state now resets on every restart, in both
  the page engine and the PDF voice hub.
- **Rapid commands don't cancel each other.** The 210 ms settle window used a
  single shared timer, so "down" followed quickly by "up" cancelled the pending
  "down" (it only fired late, on finalization). Settle timers are now
  per command segment.
- **Smoother auto-scroll on container-scroll pages** — the inner-scroll target
  scan is cached for 2 s instead of re-scanning every `<div>` in the document
  on each 45 ms tick (less jank on heavy pages). The cheap point-based probe
  still runs live so layout changes are picked up immediately.
- **Late-injected tabs get the full engine** — programmatic injection now
  covers all frames, so the cross-frame scroll bridge also works on tabs that
  were opened before the extension was installed or reloaded.
- **Cleaner PDF-mode state** — closing a PDF tab or navigating it away from a
  PDF now clears its ON badge and pending auto-scroll; stopping the hub resets
  auto-scroll state too.
- **New matcher regression tests** — `node tests/test-vs-core.js` locks down
  homophones, EXACT_ONLY collision guards (wait ≠ wake, button ≠ bottom …),
  quantifiers, edge jumps, sensitivities and custom phrases. No dependencies.

## What's new in v25.1 — "works everywhere"

- **Chrome + Edge** — same manifest, same codebase. Edge uses its own (Azure
  backed) speech service; if it refuses your language, the engine automatically
  retries with English (US), then stops cleanly instead of restart-looping.
- **Native PDF mode (hub + trusted input)** — Chrome/Edge render top-level PDFs
  on internal browser pages where content scripts cannot run. Enabling voice on
  a PDF tab therefore starts a hidden *voice hub* (offscreen document; a tiny
  tab fallback) and scrolling is driven from the background with **trusted
  `chrome.debugger` wheel / Home/End events** — the only mechanism that reliably
  moves native PDF viewers (their content sits behind a shadow-root embed in an
  internal frame). Chrome shows a brief "started debugging" bar while this mode
  is active; it disappears when the hub stops.
- **Embedded PDFs on normal pages** — `<embed>` / `<object>` / `<iframe
  src="*.pdf">` viewers are detected and scrolled through the same trusted
  input relay (with the legacy synthetic-wheel dispatch as fallback).
- **Cross-frame scroll bridge** — when a page's content scrolls inside a
  cross-origin iframe (docs sites, embeds), the scroll is offered to every child
  frame via a postMessage bridge before falling back to trusted input.
- **file:// pages & PDFs** — .html files still honor the "Allow access to file
  URLs" switch, but native PDF tabs no longer need it in PDF mode.
- Kept from v25: zero-latency interim engine (210 ms settling), 0 ms
  stop/sleep, segment deduplication, CSS smooth-behavior override,
  phonetic matching, Muse UI, earcons, ON badge, popup tuning.

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
- **Jump:** `top`, `bottom` (or `all the way down`, `all the way up`)
- **Auto-scroll:** `keep scrolling down` / `keep scrolling up` → `faster` / `slower` → `stop`
- **Hands-free Pause:** `sleep` → `wake up`
- **Help:** `help`, `what can I say` — on-page cheat sheet
- **हिन्दी (speech language hi-IN):** `नीचे` · `ऊपर` · `पेज नीचे` · `पेज ऊपर` · `टॉप` · `सबसे नीचे` · `रुको` · `सो जाओ` / `जागो` · `तेज़` / `धीरे` · `चलते रहो` · `मदद` — plus Hinglish (neeche, oopar, ruko, tez, madad…)
- **Shortcut:** `Alt+Shift+V` toggles listening anywhere (web and PDF tabs); the 🎤 orb on the page is clickable too.

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
- **Voice language** → select your language under Precision → Speech language.

## Verification

```powershell
node --check extension/vs-core.js
node --check extension/content.js
node --check extension/background.js
node --check extension/voice-hub.js
node --check extension/popup.js
node tests/test-vs-core.js
python -c "import json; json.load(open('extension/manifest.json')); print('manifest OK')"
```

Reload at `chrome://extensions` → **⟳ Reload** to apply changes.
