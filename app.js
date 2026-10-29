import {
  classify, opposite, splitSentences, parseEvent, wsUrl, audioChunkMessage, httpError, networkError,
  TOKEN_URL, PartialThrottle,
  cleanTranslation, missingNumbers, parseGlossary, glossaryPre, glossaryRestore, glossaryPost,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const mkStore = (area) => ({
  get(k) { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v) { try { window[area].setItem(k, v); return true; } catch { return false; } },
  del(k) { try { window[area].removeItem(k); } catch { /* private mode */ } },
});
const store = mkStore('localStorage');
const session = mkStore('sessionStorage');

const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const FONT_SCALES = [0.85, 1, 1.3, 1.6];
const LANG_NAME = { ru: 'Русский', en: 'English' };
const MAX_BUFFER_CHUNKS = 50; // 5 s of audio replayed after a reconnect
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const TOKEN_TIMEOUT_MS = 10000;
const MT_TIMEOUT_PER_SENTENCE_MS = 20000;
const COMMIT_WAIT_MS = 1500;
const AUTOSAVE_MS = 5000;
const SAVE_KEY = 'wr_session';
const GLOSSARY_KEY = 'wr_glossary';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  running: false, stopping: false, paused: false, phrases: [], partial: '', partialTr: '', partialLang: null,
  fontIdx: Number(store.get('fontIdx') ?? 1) || 1, showOrig: store.get('showOrig') !== '0', face: false,
  startedAt: 0,
};
let GLOS = { pre: [], post: [] };

// ---------------------------------------------------------------- translation (worker)
class Translator {
  constructor(onState) {
    this.onState = onState; this.state = 'idle'; this.pending = new Map(); this.seq = 0; this.files = new Map();
    this.busy = 0; this.restarts = 0;
  }
  init() {
    if (this.worker) return;
    this.state = 'loading'; this.onState(this.state, 0);
    try {
      this.worker = new Worker('translate-worker.js', { type: 'module' });
    } catch (e) { this.fail('Браузер не поддерживает фоновые модули: ' + e.message); return; }
    this.worker.onerror = (e) => this.fail(e.message || 'ошибка модуля перевода');
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.postMessage({ type: 'init' });
  }
  onMessage(m) {
    if (m.type === 'progress') {
      const p = m.p;
      if (p && p.file && typeof p.total === 'number' && p.total > 0) {
        this.files.set(m.pair + '/' + p.file, { loaded: p.loaded || 0, total: p.total });
        let l = 0, t = 0;
        for (const f of this.files.values()) { l += f.loaded; t += f.total; }
        this.onState('loading', t ? Math.min(99, Math.round((100 * l) / t)) : 0);
      }
    } else if (m.type === 'ready') {
      this.state = 'ready'; this.restarts = 0; this.onState('ready', 100);
      for (const id of this.pending.keys()) this.arm(id);
    } else if (m.type === 'error') {
      this.fail(m.message);
    } else if (m.type === 'result') {
      const e = this.pending.get(m.id);
      if (!e) return;
      clearTimeout(e.timer);
      this.pending.delete(m.id); this.busy = Math.max(0, this.pending.size);
      m.error ? e.reject(new Error(m.error)) : e.resolve(m.text);
    }
  }
  fail(msg) {
    this.state = 'error'; this.onState('error', 0, msg);
    for (const e of this.pending.values()) { clearTimeout(e.timer); e.reject(new Error(msg)); }
    this.pending.clear(); this.busy = 0;
  }
  // The timeout runs only while the models are ready (the first download can take minutes).
  arm(id) {
    const e = this.pending.get(id);
    if (!e || e.timer) return;
    e.timer = setTimeout(() => this.onTimeout(id), MT_TIMEOUT_PER_SENTENCE_MS * e.n);
  }
  onTimeout(id) {
    const e = this.pending.get(id);
    if (!e) return;
    this.pending.delete(id); this.busy = this.pending.size;
    e.reject(new Error('timeout'));
    this.restart();
  }
  /** The worker hangs: replace it (models come from the browser cache) and re-send the queued requests. */
  restart() {
    try { this.worker && this.worker.terminate(); } catch { /* ignore */ }
    this.worker = null; this.files.clear();
    if (++this.restarts > 3) { this.fail('модуль перевода завис несколько раз подряд'); return; }
    for (const e of this.pending.values()) { clearTimeout(e.timer); e.timer = null; }
    this.init();
    for (const [id, e] of this.pending) this.worker.postMessage({ type: 'translate', id, ...e.payload });
  }
  translate(text, src, tgt) {
    const sentences = splitSentences(text);
    if (!sentences.length) return Promise.resolve('');
    if (this.state === 'error' || !this.worker) return Promise.reject(new Error('translator unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const payload = { src, tgt, sentences };
      this.pending.set(id, { resolve, reject, payload, n: sentences.length, timer: null });
      this.busy = this.pending.size;
      this.worker.postMessage({ type: 'translate', id, ...payload });
      if (this.state === 'ready') this.arm(id);
    });
  }
}

/** Full pipeline of one phrase: glossary placeholders -> Opus-MT -> cleanup -> glossary restore / "=>" rules. */
async function translateFull(text, lang) {
  const tgt = opposite(lang);
  const pre = glossaryPre(text, lang, GLOS);
  let out = cleanTranslation(await mt.translate(pre.text, lang, tgt));
  if (pre.map.length) {
    const r = glossaryRestore(out, pre.map);
    out = r.ok ? r.text : cleanTranslation(await mt.translate(text, lang, tgt)); // placeholder lost: plain translation
  }
  out = glossaryPost(out, tgt, GLOS).trim();
  if (!out) throw new Error('empty translation');
  return out;
}

// ---------------------------------------------------------------- Scribe realtime client
class Scribe {
  constructor(key, h) {
    this.key = key; this.h = h; this.ws = null; this.stopped = false; this.attempt = 0; this.queue = [];
    this.connecting = false; this.paused = false;
  }
  async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.h.status(this.attempt ? 'Переподключение…' : 'Подключение…');
    let token;
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), TOKEN_TIMEOUT_MS);
    try {
      const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': this.key }, signal: ac.signal });
      if (!r.ok) { this.connecting = false; return this.failure(httpError(r.status)); }
      token = (await r.json()).token;
      if (!token) { this.connecting = false; return this.failure(httpError(500)); }
    } catch {
      this.connecting = false; return this.failure(networkError());
    } finally { clearTimeout(tm); }
    if (this.stopped) { this.connecting = false; return; }
    const ws = new WebSocket(wsUrl(token));
    this.ws = ws;
    ws.onopen = () => {
      this.connecting = false; this.attempt = 0; this.h.status('Слушаю');
      this.h.clearError();
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (e) => { const ev = parseEvent(String(e.data)); if (ev) this.handle(ev); };
    ws.onerror = () => { /* followed by close */ };
    ws.onclose = (e) => {
      this.connecting = false;
      if (this.stopped || this.ws !== ws) return;
      this.ws = null;
      if (e.code === 1008 || e.code === 4001) return this.failure(httpError(401));
      this.scheduleReconnect();
    };
  }
  handle(ev) {
    if (ev.type === 'failure') return this.failure(ev);
    this.h.event(ev);
  }
  failure(f) {
    this.h.error(f.message, f.fatal);
    if (f.fatal) { this.stopped = true; this.close(); this.h.fatal(f.message); return; }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.stopped || this.timer || this.paused) return; // on pause the connection is restored by setPaused(false)
    const d = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.h.status('Переподключение…');
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, d);
  }
  setPaused(p) {
    this.paused = p;
    if (!p && !this.stopped && !this.connecting && !this.timer && !(this.ws && this.ws.readyState <= WebSocket.OPEN)) this.connect();
  }
  get open() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  send(buf) {
    let bin = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x2000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
    const msg = audioChunkMessage(btoa(bin));
    if (this.open) this.ws.send(msg);
    else { this.queue.push(msg); if (this.queue.length > MAX_BUFFER_CHUNKS) this.queue.shift(); }
  }
  /** Asks the server to finalize the phrase that is being spoken (empty audio + commit=true). */
  commit() {
    if (!this.open) return false;
    this.ws.send(audioChunkMessage('', 16000, true));
    return true;
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }
  stop() { this.stopped = true; this.close(); }
}

// ---------------------------------------------------------------- session
const mt = new Translator((state, pct, msg) => {
  $('mt').textContent = state === 'ready' ? 'Перевод: готов' : state === 'error' ? 'Перевод: ошибка' : 'Перевод: загрузка';
  $('loadBanner').hidden = state !== 'loading';
  $('loadPct').textContent = String(pct); $('loadBar').style.width = pct + '%';
  if (state === 'error') showError('Модель перевода не загрузилась: ' + (msg || '') + '. Проверьте интернет и перезапустите.');
  else if (state === 'ready') clearError();
});

let scribe = null, audioCtx = null, stream = null, node = null, wake = null;
let autosaveTimer = null, commitWaiter = null, hiddenAt = 0, warnTimer = null;
const throttle = new PartialThrottle();
let draftSeq = 0;

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
}
function showError(text, fatal = false) {
  $('errText').textContent = text; $('fatalBtns').hidden = !fatal; $('errBanner').hidden = false;
}
function clearError() { if (!$('fatalBtns').hidden) return; $('errBanner').hidden = true; }
function setWarn(text, { action = false, autoHideMs = 0 } = {}) {
  clearTimeout(warnTimer);
  $('warnText').textContent = text; $('bWarnAct').hidden = !action; $('warnBanner').hidden = false;
  if (autoHideMs) warnTimer = setTimeout(clearWarn, autoHideMs);
}
function clearWarn() { clearTimeout(warnTimer); $('warnBanner').hidden = true; }
function setStatus(t) { const v = S.paused && S.running ? 'Пауза' : t; $('status').textContent = v; $('faceStatus').textContent = v; }

const MIC_CONSTRAINTS = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

async function start() {
  if ($('start').disabled) return;
  const key = $('key').value.trim();
  $('setupErr').textContent = '';
  if (key.length < 20) { $('setupErr').textContent = 'Вставьте ключ ElevenLabs'; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('setupErr').textContent = 'Этот браузер не даёт доступ к микрофону. Откройте страницу в Safari или Chrome по https.'; return;
  }
  if (!window.AudioContext && !window.webkitAudioContext) { $('setupErr').textContent = 'Браузер не поддерживает обработку звука'; return; }
  $('start').disabled = true;
  try {
    // iOS: the audio context must be created and resumed inside the tap handler.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.onstatechange = checkAudioHealth;
    try { await audioCtx.resume(); } catch { /* ignore */ }
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (e) {
      throw new Error(e && e.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону. Разрешите его в настройках браузера и попробуйте снова.'
        : 'Не удалось открыть микрофон: ' + (e && e.message || e));
    }
    watchTracks();
    await startAudio();
  } catch (e) {
    releaseMedia();
    $('setupErr').textContent = e && e.message || String(e);
    $('start').disabled = false;
    return;
  }

  // The key: sessionStorage by default, localStorage only with "Remember".
  session.set('xikey', key);
  if ($('remember').checked) store.set('xikey', key); else store.del('xikey');
  store.set(GLOSSARY_KEY, $('glossary').value);
  GLOS = parseGlossary($('glossary').value);

  S.running = true; S.stopping = false; S.paused = false;
  S.phrases = []; S.partial = ''; S.partialTr = ''; S.startedAt = Date.now(); S.endedAt = 0;
  throttle.reset(); hiddenAt = 0;
  $('live').classList.remove('ended'); $('fatalBtns').hidden = true; $('sum').classList.remove('on');
  updatePauseUi(); clearWarn();
  showScreen('live'); clearError(); applyPrefs(); renderAll();
  mt.init();
  acquireWake();
  saveNow();
  autosaveTimer = setInterval(saveNow, AUTOSAVE_MS);

  scribe = new Scribe(key, {
    status: setStatus,
    clearError,
    error: (m, fatal) => showError(m, false),
    fatal: (m) => onFatal(m),
    event: onScribeEvent,
  });
  scribe.connect();
  $('start').disabled = false;
}

function watchTracks() {
  for (const t of stream.getAudioTracks()) t.addEventListener('ended', checkAudioHealth);
}

async function startAudio() {
  if (!audioCtx.audioWorklet) throw new Error('Браузер слишком старый для обработки звука. Обновите iOS/браузер.');
  try { node && node.disconnect(); } catch { /* ignore */ }
  const src = audioCtx.createMediaStreamSource(stream);
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');
  node = new AudioWorkletNode(audioCtx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  node.port.onmessage = (e) => {
    if (!S.running || S.paused || S.stopping) return;
    scribe && scribe.send(e.data.buf);
    $('dot').classList.toggle('rec', e.data.rms > 0.008);
  };
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(audioCtx.destination);
}

/** Stops the microphone / audio graph / wake lock. Safe to call repeatedly. */
function releaseMedia() {
  try { node && node.disconnect(); } catch { /* ignore */ }
  node = null;
  if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } } stream = null; }
  if (audioCtx) { audioCtx.onstatechange = null; audioCtx.close().catch(() => {}); audioCtx = null; }
  if (wake) { const w = wake; wake = null; w.release().catch(() => {}); }
  $('dot').classList.remove('rec');
}

function stopTimers() { clearInterval(autosaveTimer); autosaveTimer = null; }

// ---- audio health: interrupted context (phone call), ended track, background
function checkAudioHealth() {
  if (!S.running || S.stopping) return;
  const track = stream && stream.getAudioTracks()[0];
  const ctxBad = !audioCtx || audioCtx.state !== 'running';
  const trackBad = !track || track.readyState === 'ended';
  if (ctxBad || trackBad) {
    setWarn(trackBad ? 'Микрофон отключился (звонок, другое приложение?). Звук не записывается.' : 'Звук прерван (звонок?). Звук не записывается.', { action: true });
  } else if (!$('warnBanner').hidden && $('bWarnAct').hidden === false) clearWarn();
}

async function resumeAudio() {
  if (!S.running || S.stopping) return;
  try {
    if (audioCtx && audioCtx.state !== 'running') await audioCtx.resume();
    const track = stream && stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      watchTracks();
      if (S.paused) for (const t of stream.getAudioTracks()) t.enabled = false;
      await startAudio();
    }
  } catch (e) {
    setWarn('Не удалось возобновить звук: ' + (e && e.message || e) + '. Нажмите «Возобновить звук» ещё раз или начните заново.', { action: true });
    return;
  }
  checkAudioHealth();
}

async function acquireWake() {
  try {
    if (!navigator.wakeLock || wake || !S.running) return;
    const w = await navigator.wakeLock.request('screen');
    wake = w;
    w.addEventListener('release', () => { if (wake === w) wake = null; });
  } catch { /* optional */ }
}

// ---- fatal error: the session is over, microphone and timers are released
function onFatal(message) {
  if (!S.running && !S.stopping) return;
  S.running = false; S.stopping = false; S.paused = false;
  stopTimers();
  if (scribe) { scribe.stop(); scribe = null; }
  releaseMedia();
  commitWaiter && commitWaiter();
  // an unfinished draft stays in the transcript
  if (S.partial.trim()) addPhrase(S.partial.trim());
  S.partial = ''; S.partialTr = '';
  saveNow();
  setStatus('Остановлено');
  $('live').classList.add('ended');
  clearWarn();
  showError((message || 'Ошибка') + '. Запись остановлена, микрофон выключен.', true);
  renderAll();
}

// ---------------------------------------------------------------- phrases
function addPhrase(text) {
  const lang = classify(text);
  if (!text || !lang) return null;
  const p = { id: S.phrases.length, lang, text, tr: null, failed: false, warnNum: false, at: Date.now() };
  S.phrases.push(p);
  renderAll();
  translateFull(text, lang).then((tr) => {
    p.tr = tr; p.warnNum = missingNumbers(text, tr).length > 0;
  }).catch(() => { p.failed = true; }).finally(() => { renderAll(); saveNow(); });
  saveNow();
  return p;
}

function onScribeEvent(ev) {
  if (ev.type === 'partial') {
    if (S.stopping && !ev.text) return;
    S.partial = ev.text;
    S.partialLang = classify(ev.text);
    if (!ev.text) S.partialTr = '';
    renderDraft();
    if (S.partialLang && !S.stopping && throttle.should(ev.text, performance.now()) && mt.busy === 0 && mt.state === 'ready') {
      const my = ++draftSeq; const lang = S.partialLang; const txt = ev.text;
      translateFull(txt, lang).then((tr) => { if (my === draftSeq && S.partial === txt) { S.partialTr = tr; renderDraft(); } }).catch(() => {});
    }
  } else if (ev.type === 'committed') {
    const text = ev.text.trim();
    S.partial = ''; S.partialTr = ''; draftSeq++; throttle.reset();
    if (!text) renderDraft(); else addPhrase(text);
    if (commitWaiter) commitWaiter();
  }
}

function updatePauseUi() {
  for (const id of ['bPause', 'bFacePause']) {
    const b = $(id); if (!b) continue;
    b.classList.toggle('sel', S.paused);
    if (id === 'bPause') b.innerHTML = S.paused ? '<b>▶</b>Продолжить' : '<b>❚❚</b>Пауза';
    else b.textContent = S.paused ? 'Продолжить' : 'Пауза';
  }
  $('dot').classList.toggle('paused', S.paused);
}

function togglePause() {
  if (!S.running || S.stopping) return;
  S.paused = !S.paused;
  if (stream) for (const t of stream.getAudioTracks()) t.enabled = !S.paused;
  if (scribe) {
    if (S.paused && S.partial) scribe.commit(); // finish the phrase before the pause
    scribe.setPaused(S.paused);
  }
  if (S.paused) $('dot').classList.remove('rec');
  setStatus(S.paused ? 'Пауза' : (scribe && scribe.open ? 'Слушаю' : 'Подключение…'));
  updatePauseUi();
}

/** Normal end: mic off at once, commit of the last phrase (waits up to 1.5 s), then the summary. */
async function finish() {
  if (!S.running || S.stopping) return;
  S.stopping = true;
  setStatus('Завершаю…');
  stopTimers();
  // microphone first: nothing is recorded after the user pressed Stop
  try { node && node.disconnect(); } catch { /* ignore */ }
  node = null;
  if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } } stream = null; }
  if (scribe && S.partial.trim()) {
    const waiter = new Promise((res) => { commitWaiter = res; });
    if (scribe.commit()) await Promise.race([waiter, sleep(COMMIT_WAIT_MS)]);
    commitWaiter = null;
  }
  if (S.partial.trim()) addPhrase(S.partial.trim()); // no commit came: the draft becomes final as it is
  S.partial = ''; S.partialTr = ''; draftSeq++;
  S.running = false; S.stopping = false; S.paused = false; S.endedAt = Date.now();
  if (scribe) { scribe.stop(); scribe = null; }
  releaseMedia();
  clearWarn(); clearError();
  setFace(false);
  saveNow();
  showSummary();
}

function showSummary(restored = false) {
  const mins = Math.max(1, Math.round(((S.endedAt || Date.now()) - S.startedAt) / 60000));
  $('sumInfo').textContent = S.phrases.length
    ? (restored ? 'Восстановлен прошлый разговор. ' : '') + `Фраз: ${S.phrases.length}.` + (restored ? '' : ` Длительность: ${mins} мин.`)
    : 'Фраз не распознано.';
  $('sumText').textContent = transcriptText();
  $('sum').classList.add('on');
}

function transcriptText() {
  return S.phrases.map((p) => {
    const ru = p.lang === 'ru' ? p.text : (p.tr ?? '…'); const en = p.lang === 'en' ? p.text : (p.tr ?? '…');
    return `RU: ${ru}\nEN: ${en}` + (p.warnNum ? '\n⚠ проверьте цифры' : '');
  }).join('\n\n');
}

// ---------------------------------------------------------------- autosave / restore
function saveNow() {
  if (!S.phrases.length && !S.partial) return;
  const data = {
    v: 1, startedAt: S.startedAt, savedAt: Date.now(), partial: S.partial,
    phrases: S.phrases.map(({ lang, text, tr, failed, warnNum, at }) => ({ lang, text, tr, failed, warnNum, at })),
  };
  store.set(SAVE_KEY, JSON.stringify(data));
  if ($('sum').classList.contains('on')) $('sumText').textContent = transcriptText();
}
function loadSaved() {
  try {
    const d = JSON.parse(store.get(SAVE_KEY) || 'null');
    if (!d || d.v !== 1 || !Array.isArray(d.phrases)) return null;
    if (!d.phrases.length && !d.partial) return null;
    return d;
  } catch { return null; }
}
function refreshSavedCard() {
  const d = loadSaved();
  $('restoreCard').hidden = !d;
  if (d) {
    const n = d.phrases.length + (d.partial ? 1 : 0);
    $('restoreInfo').textContent = `Сохранён разговор: фраз ${n}, ${new Date(d.savedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}.`;
  }
}
function restoreSaved() {
  const d = loadSaved();
  if (!d) return;
  S.phrases = d.phrases.map((p, i) => ({ ...p, id: i, warnNum: !!p.warnNum }));
  if (d.partial && d.partial.trim() && classify(d.partial)) S.phrases.push({ id: S.phrases.length, lang: classify(d.partial), text: d.partial.trim(), tr: null, failed: true, warnNum: false, at: d.savedAt });
  S.partial = ''; S.startedAt = d.startedAt || d.savedAt; S.endedAt = d.savedAt;
  showSummary(true);
}
function deleteSaved() {
  store.del(SAVE_KEY);
  refreshSavedCard();
  if ($('sum').classList.contains('on')) $('sumInfo').textContent = 'Сохранённая копия удалена из браузера. Текст ниже виден, пока вы не закроете экран, - скопируйте его при необходимости.';
}

// ---------------------------------------------------------------- rendering
function applyPrefs() {
  document.documentElement.style.setProperty('--fs', String(FONT_SCALES[S.fontIdx % FONT_SCALES.length]));
  $('live').classList.toggle('hide-orig', !S.showOrig);
  $('bOrig').classList.toggle('sel', S.showOrig);
  $('bFace').classList.toggle('sel', S.face);
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function renderAll() { renderList(); renderDraft(); renderFace(); }

function renderList() {
  const list = $('list');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.textContent = '';
  for (const p of S.phrases) {
    const a = el('article', 'ph ' + p.lang);
    a.append(el('div', 'tag', p.lang === 'ru' ? 'RU → EN' : 'EN → RU'));
    a.append(el('div', 'orig', p.text));
    const tr = el('div', 'tr serif' + (p.tr ? '' : ' wait'), p.tr ?? (p.failed ? '— перевод не удался —' : 'перевожу…'));
    a.append(tr);
    if (p.warnNum) a.append(el('div', 'numwarn', '⚠ проверьте цифры'));
    list.append(a);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderDraft() {
  const d = $('draft'); d.textContent = '';
  if (S.partial) {
    d.append(el('div', 'orig', S.partial));
    if (S.partialTr) d.append(el('div', 'tr serif', S.partialTr));
  }
  renderFace();
}

function renderFace() {
  if (!S.face) return;
  fillHalf($('faceTop'), 'en'); fillHalf($('faceBottom'), 'ru');
}

function fillHalf(box, reader) {
  box.textContent = '';
  box.append(el('div', 'hd', LANG_NAME[reader]));
  for (const p of S.phrases) {
    const own = p.lang === reader;
    const text = own ? p.text : p.tr;
    if (!text) continue;
    box.append(el('div', 'line serif' + (own ? '' : ' tr-line'), text + (!own && p.warnNum ? ' ⚠' : '')));
  }
  if (S.partial && S.partialLang === reader) box.append(el('div', 'line serif partial', S.partial));
  else if (S.partial && S.partialTr && S.partialLang && S.partialLang !== reader) box.append(el('div', 'line serif partial tr-line', S.partialTr));
  box.scrollTop = box.scrollHeight;
}

function setFace(on) {
  S.face = on && S.running;
  $('face').classList.toggle('on', S.face);
  applyPrefs(); renderFace();
}

// ---------------------------------------------------------------- wiring
function askStop() {
  if (!S.running || S.stopping) return;
  $('confirm').classList.add('on'); $('bConfirmNo').focus();
}
$('start').addEventListener('click', start);
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
$('bStop').addEventListener('click', askStop);
$('bFaceStop').addEventListener('click', askStop);
$('bConfirmYes').addEventListener('click', () => { $('confirm').classList.remove('on'); finish(); });
$('bConfirmNo').addEventListener('click', () => $('confirm').classList.remove('on'));
$('bPause').addEventListener('click', togglePause);
$('bFacePause').addEventListener('click', togglePause);
$('bWarnAct').addEventListener('click', resumeAudio);
$('bFont').addEventListener('click', () => { S.fontIdx = (S.fontIdx + 1) % FONT_SCALES.length; store.set('fontIdx', String(S.fontIdx)); applyPrefs(); renderAll(); });
$('bOrig').addEventListener('click', () => { S.showOrig = !S.showOrig; store.set('showOrig', S.showOrig ? '1' : '0'); applyPrefs(); });
$('bFace').addEventListener('click', () => setFace(!S.face));
$('bFaceBack').addEventListener('click', () => setFace(false));
$('bCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(transcriptText()); $('bCopy').textContent = 'Скопировано'; } catch { $('bCopy').textContent = 'Не удалось'; }
});
$('bDownload').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' }));
  a.download = 'perevod-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
  document.body.append(a); a.click(); a.remove();
});
$('bNew').addEventListener('click', () => {
  $('sum').classList.remove('on'); $('bCopy').textContent = 'Скопировать текст'; showScreen('setup'); refreshSavedCard();
});
$('bRestore').addEventListener('click', restoreSaved);
$('bDelSaved').addEventListener('click', deleteSaved);
$('bDelSaved2').addEventListener('click', deleteSaved);
$('bRestart').addEventListener('click', () => {
  $('fatalBtns').hidden = true; $('errBanner').hidden = true; $('live').classList.remove('ended');
  setFace(false); showScreen('setup'); refreshSavedCard();
});
$('bFatalSum').addEventListener('click', () => { showSummary(); });
$('bReload').addEventListener('click', () => location.reload());

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    if (S.running) saveNow();
    return;
  }
  navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  if (!S.running || S.stopping) return;
  acquireWake();
  await resumeAudio();
  if (hiddenAt && Date.now() - hiddenAt > 3000 && $('warnBanner').hidden) {
    setWarn(`Страница была в фоне ${Math.round((Date.now() - hiddenAt) / 1000)} с — речь за это время могла не записаться.`, { autoHideMs: 12000 });
  }
  hiddenAt = 0;
});
window.addEventListener('pagehide', () => { if (S.running) saveNow(); });
window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- init
$('key').value = session.get('xikey') || store.get('xikey') || '';
$('remember').checked = !!store.get('xikey');
$('glossary').value = store.get(GLOSSARY_KEY) || '';
$('glossary').addEventListener('change', () => store.set(GLOSSARY_KEY, $('glossary').value));
applyPrefs();
refreshSavedCard();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('updBanner').hidden = false; });
}

if (DEBUG) window.__wr = { S, mt, classify, splitSentences, feed: onScribeEvent, showScreen, setFace, renderAll, translateFull, saveNow, finish, onFatal };
