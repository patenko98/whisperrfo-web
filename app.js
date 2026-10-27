import {
  classify, opposite, splitSentences, parseEvent, wsUrl, audioChunkMessage, httpError, networkError,
  TOKEN_URL, PartialThrottle,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

const FONT_SCALES = [0.85, 1, 1.3, 1.6];
const LANG_NAME = { ru: 'Русский', en: 'English' };
const MAX_BUFFER_CHUNKS = 50; // 5 s of audio replayed after a reconnect
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

const S = {
  running: false, phrases: [], partial: '', partialTr: '', partialLang: null,
  fontIdx: Number(store.get('fontIdx') ?? 1) || 1, showOrig: store.get('showOrig') !== '0', face: false,
  startedAt: 0,
};

// ---------------------------------------------------------------- translation (worker)
class Translator {
  constructor(onState) {
    this.onState = onState; this.state = 'idle'; this.pending = new Map(); this.seq = 0; this.files = new Map();
    this.busy = 0;
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
      this.state = 'ready'; this.onState('ready', 100);
    } else if (m.type === 'error') {
      this.fail(m.message);
    } else if (m.type === 'result') {
      const cb = this.pending.get(m.id);
      this.pending.delete(m.id); this.busy = Math.max(0, this.busy - 1);
      if (cb) m.error ? cb.reject(new Error(m.error)) : cb.resolve(m.text);
    }
  }
  fail(msg) {
    this.state = 'error'; this.onState('error', 0, msg);
    for (const cb of this.pending.values()) cb.reject(new Error(msg));
    this.pending.clear();
  }
  translate(text, src, tgt) {
    const sentences = splitSentences(text);
    if (!sentences.length) return Promise.resolve('');
    if (this.state === 'error' || !this.worker) return Promise.reject(new Error('translator unavailable'));
    const id = ++this.seq; this.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'translate', id, src, tgt, sentences });
    });
  }
}

// ---------------------------------------------------------------- Scribe realtime client
class Scribe {
  constructor(key, h) {
    this.key = key; this.h = h; this.ws = null; this.stopped = false; this.attempt = 0; this.queue = [];
    this.connecting = false;
  }
  async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.h.status(this.attempt ? 'Переподключение…' : 'Подключение…');
    let token;
    try {
      const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': this.key } });
      if (!r.ok) { this.connecting = false; return this.failure(httpError(r.status)); }
      token = (await r.json()).token;
      if (!token) { this.connecting = false; return this.failure(httpError(500)); }
    } catch {
      this.connecting = false; return this.failure(networkError());
    }
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
    if (f.fatal) { this.stopped = true; this.close(); this.h.fatal(); return; }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const d = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.h.status('Переподключение…');
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, d);
  }
  send(buf) {
    let bin = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x2000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
    const msg = audioChunkMessage(btoa(bin));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else { this.queue.push(msg); if (this.queue.length > MAX_BUFFER_CHUNKS) this.queue.shift(); }
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
  if (state === 'error') showError('Модель перевода не загрузилась: ' + (msg || '') + '. Проверьте интернет и перезапустите.', false);
  else if (state === 'ready') clearError();
});

let scribe = null, audioCtx = null, stream = null, node = null, wake = null;
const throttle = new PartialThrottle();
let draftSeq = 0;

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
}
function showError(text) { const b = $('errBanner'); b.textContent = text; b.hidden = false; }
function clearError() { $('errBanner').hidden = true; }

async function start() {
  const key = $('key').value.trim();
  $('setupErr').textContent = '';
  if (key.length < 20) { $('setupErr').textContent = 'Вставьте ключ ElevenLabs'; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('setupErr').textContent = 'Этот браузер не даёт доступ к микрофону. Откройте страницу в Safari или Chrome по https.'; return;
  }
  if (!window.AudioContext && !window.webkitAudioContext) { $('setupErr').textContent = 'Браузер не поддерживает обработку звука'; return; }
  $('start').disabled = true;
  // iOS: the audio context must be created and resumed inside the tap handler.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await audioCtx.resume(); } catch { /* ignore */ }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    $('start').disabled = false;
    $('setupErr').textContent = e && e.name === 'NotAllowedError'
      ? 'Нет доступа к микрофону. Разрешите его в настройках браузера и попробуйте снова.'
      : 'Не удалось открыть микрофон: ' + (e && e.message || e);
    try { await audioCtx.close(); } catch { /* ignore */ }
    return;
  }
  if (document.querySelector('#remember').checked) store.set('xikey', key); else store.del('xikey');

  S.running = true; S.phrases = []; S.partial = ''; S.partialTr = ''; S.startedAt = Date.now();
  throttle.reset();
  showScreen('live'); clearError(); applyPrefs(); renderAll();
  mt.init();
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* optional */ }

  scribe = new Scribe(key, {
    status: setStatus,
    clearError,
    error: (m) => showError(m),
    fatal: () => { setStatus('Остановлено'); },
    event: onScribeEvent,
  });
  scribe.connect();
  await startAudio();
  $('start').disabled = false;
}

async function startAudio() {
  const src = audioCtx.createMediaStreamSource(stream);
  if (audioCtx.audioWorklet) {
    await audioCtx.audioWorklet.addModule('pcm-worklet.js');
    node = new AudioWorkletNode(audioCtx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => {
      if (!S.running) return;
      scribe && scribe.send(e.data.buf);
      $('dot').classList.toggle('rec', e.data.rms > 0.008);
    };
    const mute = audioCtx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(audioCtx.destination);
  } else {
    showError('Браузер слишком старый для обработки звука. Обновите iOS/браузер.');
  }
}

function setStatus(t) { $('status').textContent = t; $('faceStatus').textContent = t; }

function onScribeEvent(ev) {
  if (ev.type === 'partial') {
    S.partial = ev.text;
    S.partialLang = classify(ev.text);
    if (!ev.text) S.partialTr = '';
    renderDraft();
    if (S.partialLang && throttle.should(ev.text, performance.now()) && mt.busy === 0 && mt.state === 'ready') {
      const my = ++draftSeq; const lang = S.partialLang; const txt = ev.text;
      mt.translate(txt, lang, opposite(lang)).then((tr) => { if (my === draftSeq && S.partial === txt) { S.partialTr = tr; renderDraft(); } }).catch(() => {});
    }
  } else if (ev.type === 'committed') {
    const text = ev.text.trim();
    S.partial = ''; S.partialTr = ''; draftSeq++; throttle.reset();
    const lang = classify(text);
    if (!text || !lang) { renderDraft(); return; }
    const p = { id: S.phrases.length, lang, text, tr: null, failed: false, at: Date.now() };
    S.phrases.push(p);
    renderAll();
    mt.translate(text, lang, opposite(lang)).then((tr) => { p.tr = tr; renderAll(); }).catch(() => { p.failed = true; renderAll(); });
  }
}

function stop() {
  if (!S.running) return;
  S.running = false;
  if (scribe) { scribe.stop(); scribe = null; }
  try { node && node.disconnect(); } catch { /* ignore */ }
  node = null;
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (wake) { wake.release().catch(() => {}); wake = null; }
  setFace(false);
  const text = transcriptText();
  $('sumInfo').textContent = S.phrases.length
    ? `Фраз: ${S.phrases.length}. Длительность: ${Math.max(1, Math.round((Date.now() - S.startedAt) / 60000))} мин.`
    : 'Фраз не распознано.';
  $('sumText').textContent = text;
  $('sum').classList.add('on');
}

function transcriptText() {
  return S.phrases.map((p) => {
    const ru = p.lang === 'ru' ? p.text : p.tr; const en = p.lang === 'en' ? p.text : p.tr;
    return `RU: ${ru ?? '…'}\nEN: ${en ?? '…'}`;
  }).join('\n\n');
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
    box.append(el('div', 'line serif' + (own ? '' : ' tr-line'), text));
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
$('start').addEventListener('click', start);
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
$('bStop').addEventListener('click', stop);
$('bFaceStop').addEventListener('click', stop);
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
  $('sum').classList.remove('on'); $('bCopy').textContent = 'Скопировать текст'; showScreen('setup');
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.running) {
    try { if (audioCtx && audioCtx.state !== 'running') await audioCtx.resume(); } catch { /* ignore */ }
    try { if (navigator.wakeLock && !wake) wake = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
  }
});

$('key').value = store.get('xikey') || '';
applyPrefs();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// Test hook (used by the local smoke tests only).
window.__wr = { S, mt, classify, splitSentences, feed: onScribeEvent, showScreen, setFace, renderAll };
