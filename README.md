# VoiceScroll Ultimate (v25) — Chrome extension for voice scrolling

Hands-free scrolling for **webpages and PDFs** opened in Chrome, using the built-in
Web Speech API (no extra server, no API key — audio is processed by Chrome's
speech service). Click **Enable Microphone**, then speak.

Folder: `extension/` (load this folder as an unpacked extension).

## What makes execution absolutely perfect in v25

- **Muse minimalist UI** — warm paper popup and on-page indicator: quiet borders,
  one terracotta accent, no gradients or glow. Same engine, calmer look.

- **Zero-Latency Interim Engine** — commands fire on interim speech with an intelligent 210 ms settling debounce instead of waiting 1.5–2.0 seconds in silence for Chrome's `isFinal`. Speech recognition feels instant.
- **Immediate Emergency Halt** — `"stop"` and `"sleep"` execute with **0 ms delay**, stopping continuous scroll the exact millisecond the word is uttered.
- **Segment Deduplication** — tracks speech segment indices to completely eliminate double-scrolls between interim and final results, while allowing rapid-fire successive commands (`"down" … "down" … "down"`).
- **CSS `scroll-behavior: smooth` Override** — precision rAF scroller uses `behavior: 'instant'` during frame interpolation, preventing modern CSS smooth-scrolling rules from causing jitter, lag, or rubberbanding.
- **Native Chrome PDF Support** — dual-engine PDF scroller pierces shadow DOM (`#viewerContainer`) and falls back to synthetic `WheelEvent` and keyboard dispatch on Chrome's native PDF plugin embed.
- **Direct Inner-Container Resolution** — on single-page apps (ChatGPT, Slack, Gmail, Notion, GitHub, Reddit) where the scrollable container is an inner `<div>`, scrolling targets the active container directly without wasting 400 ms on a static `window`.
- **Top-Frame Audio Guard** — prevents subframes (ads, widgets, analytics iframes) from competing for mic permissions, throwing errors, or spawning duplicate HUDs.
- **Web Audio Earcons** — subtle synthetic audio chimes and blips confirm recognition without taking your eyes off the text (toggleable in popup).
- **Toolbar Status Badge** — displays a sleek green `ON` badge on the Chrome toolbar whenever VoiceScroll is actively listening.
- **Full `file://` Scheme Support** — background script fully allows local HTML files and local PDFs (requires enabling *Allow access to file URLs* in Chrome extension settings).
- **Refined Phonetic Matching** — strict first-letter guard + expanded homophone library (`done → down`, `stock → stop`, `app → up`) prevents false hits like `"top"` matching `"stop"` or 2-letter words colliding.
- **Redesigned Glassmorphic Popup** — live soundwave animations, instant Quick-Test chips, precision tuning sliders, and full command customization.

## Voice commands (defaults, all editable in popup)

- **Scroll:** `down`, `up` (also `scroll down`, `go down`, …)
- **Quantifiers:** `down three`, `down twice`, `down a little`, `down a lot`, `half page`
- **Page:** `page down`, `page up` (also `next page`, `previous page`, …)
- **Jump:** `top`, `bottom` (or `all the way down`, `all the way up`)
- **Auto-scroll:** `keep scrolling down` / `keep scrolling up` → `faster` / `slower` → `stop`
- **Hands-free Pause:** `sleep` → `wake up`
- **Shortcut:** `Alt+Shift+V` toggles listening anywhere.

## Install (Developer mode)

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → open the `voice-scroller` folder → select the **`extension`**
   folder (the one containing `manifest.json`) → **Select Folder**.
   ⚠️ Selecting the outer `voice-scroller` folder itself gives
   “Could not load manifest” — you must pick the inner `extension` folder.
3. Pin **VoiceScroll Ultimate** to the toolbar.
4. Open any long page (e.g. `https://en.wikipedia.org/wiki/Chrome`),
   click the icon → **Enable Microphone** → **Allow** mic when Chrome asks.
5. Say `down`, `up`, `page down`, `top`, `bottom`, `stop`.

## PDFs

- **HTTPS PDFs** (e.g. arXiv paper URL): open the PDF, enable VoiceScroll, and speak.
- **Local `file://` PDFs:**
  1. Open `chrome://extensions`
  2. Click **Details** on VoiceScroll Ultimate
  3. Toggle **Allow access to file URLs** to ON
  4. Reload your PDF tab.
- If a PDF downloads instead of opening in Chrome:
  Turn OFF *Download PDFs* at `chrome://settings/content/pdfDocuments`.

## Troubleshooting

- **"Mic blocked"** → click the 🔒/🎤 icon in the address bar → set Microphone to
  **Allow** → reload → Enable again. Mic permission is per-site.
- **"Extensions are blocked on this page"** → Chrome forbids extensions on the
  Web Store, `chrome://`, `edge://`, `about:` pages. Use any normal site or PDF.
- **"Could not load manifest" at install** → you selected the wrong folder.
  Re-do **Load unpacked** and pick the inner `extension/` folder (check it
  contains `manifest.json`). Do not load the outer `voice-scroller/` folder
  or a `.zip` file.
- **"Could not start here — refresh"** → reload the tab (a tab opened before
  extension install or reload has no content script yet), then Enable.
- **Listening stops after silence** → auto-restarts with smooth backoff; if the
  network drops, it backs off and resumes automatically.
- **Voice language** → select your language under Precision → Speech language.

## Verification

```powershell
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
python -c "import json; json.load(open('extension/manifest.json')); print('manifest OK')"
```

Reload at `chrome://extensions` → **⟳ Reload** to apply changes.
