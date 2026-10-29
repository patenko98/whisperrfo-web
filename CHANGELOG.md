# Changelog (web demo)

## 2026-10-29 - reliability and safety pass (review items 9-15)
- Stop: the microphone is switched off at once, the last phrase is committed (empty audio + `commit=true`, waits up to 1.5 s);
  an unfinished draft is never lost. Stop asks for confirmation.
- Pause / Resume: audio is not sent on pause; the pending phrase is committed first.
- Autosave of the transcript in localStorage (every 5 s, on every phrase, on leaving the page). On the start screen:
  "Restore the previous conversation" and "Delete saved".
- The ElevenLabs key is kept in sessionStorage by default; localStorage only with the "Remember" checkbox (off by default).
- Fatal error: microphone, audio context, timers and wake lock are released, a clear banner with "Start over".
  Errors in `startAudio` no longer leave Start disabled or the microphone open.
- Wake lock is re-acquired after `release` and on return to the page. Interrupted/suspended AudioContext or an ended
  microphone track shows "Sound interrupted" with a "Resume sound" button (also retried on return to the page).
  A hint and a `beforeunload` guard warn that leaving the browser / locking the screen stops the microphone.
- Timeouts: token request 10 s; translation 20 s per sentence (then "translation failed" and the worker is restarted).
- Translation: cleanup of "......" and looped repeats; "check the numbers" mark when a number of the original is missing
  in the translation; glossary ("term = translation" before translation via a placeholder, "phrase => replacement" after).
- Service worker `wr-shell-v2`: caches only `r.ok`, network first with a 4 s timeout, shell now includes `sw.js` and icons;
  "New version available - Reload" banner.
- Content-Security-Policy meta tag (scripts only from self and the pinned cdn.jsdelivr.net transformers.js 3.5.1).
- The `window.__wr` test hook exists only with `?debug=1`.
- Unit tests for the new pure functions in `lib.test.mjs`.

## 2026-10-27 - first version
- Live RU<->EN: ElevenLabs Scribe v2 Realtime + in-browser Opus-MT, face-to-face mode, summary screen.
