# Web demo (PWA) — live RU⇄EN translation in a browser

Folder: `web/` (static files, no build step). For a quick test on an iPhone/iPad (iOS 17+) or any modern browser.

## How it works
- Microphone → AudioWorklet (`pcm-worklet.js`) → 16 kHz PCM16, 100 ms chunks.
- Speech recognition: ElevenLabs Scribe v2 Realtime over WebSocket. The browser cannot set the `xi-api-key` header, so the
  page first requests a single-use token (`POST /v1/single-use-token/realtime_scribe`, 15 min, consumed on first use) and
  connects with `?token=`. On a drop it reconnects with a fresh token (backoff 0.5…8 s, 5 s of audio replayed).
- Language per phrase by script (Cyrillic share ≥ 40 % → ru, else en), as in the Android app.
- Translation: Opus-MT ru⇄en (Xenova/opus-mt-*, int8) in a Web Worker via transformers.js 3.5.1 (ONNX Runtime Web, WASM).
  Sentences are translated one at a time (batching made Opus-MT emit stray "......"). The models (~150 MB) are downloaded
  once and cached by the browser. No text is sent to anyone for translation.
- UI: Paper palette, big translation + small original, font size, "Original" toggle, face-to-face mode (top half rotated
  180°), end-of-session screen with copy / download .txt.

## Key handling
The ElevenLabs key is typed on the device. By default it lives in `sessionStorage` (gone when the tab is closed);
only with the "Remember" checkbox (off by default) it is also written to `localStorage`. It is never in the repository.
Give the tester a **restricted** key (Speech to Text + User only) and set a usage limit.

## Privacy - this is a demo
- Speech is recognized in the **ElevenLabs cloud**: the audio leaves the device. **Do not use the web demo for confidential
  meetings.** (For those use the secure Android flavor, see the review.)
- The transcript is autosaved in the browser (`localStorage`, key `wr_session`) so it survives a reload or a call. It stays on
  the device; delete it with "Delete saved" on the start or summary screen.
- A Content-Security-Policy limits where scripts may come from and where the page may connect (ElevenLabs, jsDelivr, Hugging Face).

## What is new (2026-10-29)
See `web/CHANGELOG.md`: commit of the last phrase on Stop, autosave + restore, pause, stop confirmation, fatal-error state,
wake lock / interrupted audio handling, timeouts and worker restart, number check and glossary, service worker v2 with the
update banner, CSP, debug hook only with `?debug=1`.

## Local run
```
cd web && python -m http.server 8765 --bind 127.0.0.1
node web/lib.test.mjs          # unit tests of the pure logic
```
`http://127.0.0.1:8765` is a secure context, so the microphone works locally. On a phone the page must be served over
https (e.g. GitHub Pages).

## Limits
- Needs internet (recognition is in the cloud) and Wi-Fi for the first model download.
- iOS stops the microphone when the page goes to the background or the screen locks; the wake lock keeps the screen on.
  The page warns about it and tries to resume the sound when you come back; speech during the gap is lost.
- Translation speed is 0.7–1.5 s per sentence on a desktop browser; a phone may be 2–3× slower.
- Not verified yet with a real microphone and a real ElevenLabs session (only unit tests, the translation worker and the UI
  with simulated events).
