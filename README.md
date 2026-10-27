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
The ElevenLabs key is typed on the device and stored in `localStorage` of that browser (the "Remember" checkbox).
It is never in the repository. Give the tester a **restricted** key (Speech to Text + User only) and set a usage limit.

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
- Translation speed is 0.7–1.5 s per sentence on a desktop browser; a phone may be 2–3× slower.
- Not verified yet with a real microphone and a real ElevenLabs session (only unit tests, the translation worker and the UI
  with simulated events).
