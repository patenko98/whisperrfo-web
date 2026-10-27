// Pure helpers of the web version (no DOM): language by script, sentence split, Scribe protocol, throttle.

export const WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
export const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';

/** "ru" when Cyrillic letters are >= 40 % of letters, "en" otherwise; null: no letters or mostly another script. */
export function classify(text) {
  let letters = 0, cyr = 0, other = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    const cp = ch.codePointAt(0);
    if ((cp >= 0x0400 && cp <= 0x052f) || (cp >= 0x1c80 && cp <= 0x1c8f) || (cp >= 0x2de0 && cp <= 0x2dff) || (cp >= 0xa640 && cp <= 0xa69f)) cyr++;
    else if (cp < 0x0250 || (cp >= 0x1e00 && cp <= 0x1eff)) { /* Latin */ } else other++;
  }
  if (letters === 0) return null;
  if (cyr / letters >= 0.4) return 'ru';
  if (other / letters > 0.5) return null;
  return 'en';
}

export const opposite = (lang) => (lang === 'ru' ? 'en' : 'ru');

/** Splits text into sentences (Opus-MT truncates long multi-sentence inputs); tiny fragments are glued to the previous one. */
export function splitSentences(text) {
  const t = text.trim();
  if (!t) return [];
  const raw = t.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) || [t];
  const out = [];
  for (const part of raw) {
    const s = part.trim();
    if (!s) continue;
    if (out.length && (s.length < 4 || !/\p{L}/u.test(s))) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out;
}

const ERROR_TYPES = new Set(['error', 'auth_error', 'quota_exceeded', 'commit_throttled', 'unaccepted_terms', 'rate_limited',
  'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded', 'input_error', 'invalid_request',
  'chunk_size_exceeded', 'insufficient_audio_activity', 'transcriber_error']);

/** Parses one Scribe text frame into {type, ...}; null for unknown/ignorable frames. */
export function parseEvent(json) {
  let o;
  try { o = JSON.parse(json); } catch { return null; }
  const type = o.message_type || '';
  switch (type) {
    case 'session_started': return { type: 'session', id: o.session_id || null };
    case 'partial_transcript': return { type: 'partial', text: o.text || '' };
    case 'committed_transcript': return { type: 'committed', text: o.text || '' };
    case 'committed_transcript_with_timestamps': return { type: 'committed', text: o.text || '', lang: o.language_code || null };
    case 'warning': return { type: 'warning', text: o.warning || '' };
    default:
      return ERROR_TYPES.has(type) ? errorEvent(type, String(o.error || '')) : null;
  }
}

export function errorEvent(type, detail) {
  const d = detail.slice(0, 200);
  const sfx = d ? ': ' + d : '';
  switch (type) {
    case 'auth_error': return fail('invalid_key', 'Неверный ключ ElevenLabs', true);
    case 'quota_exceeded': return fail('no_credits', 'Закончились кредиты ElevenLabs', true);
    case 'unaccepted_terms': return fail('terms', 'Примите условия ElevenLabs в личном кабинете', true);
    case 'invalid_request': return fail('invalid_request', 'Сервис отклонил запрос' + sfx, true);
    case 'rate_limited': case 'resource_exhausted': case 'queue_overflow':
      return fail('rate_limit', 'ElevenLabs: слишком много запросов, повторяю', false);
    case 'session_time_limit_exceeded': return fail('session_limit', 'Сессия достигла лимита времени, продолжаю', false);
    case 'commit_throttled': case 'insufficient_audio_activity': return null;
    default: return fail('server', 'Ошибка ElevenLabs' + sfx, false);
  }
}

/** Maps an HTTP status of the token request / failed upgrade. */
export function httpError(code) {
  switch (code) {
    case 401: return fail('invalid_key', 'Неверный ключ ElevenLabs', true);
    case 402: return fail('no_credits', 'Закончились кредиты ElevenLabs', true);
    case 403: return fail('invalid_key', 'У ключа нет доступа к распознаванию речи (Speech to Text)', true);
    case 429: return fail('rate_limit', 'ElevenLabs: слишком много запросов, повторяю', false);
    default: return code >= 500
      ? fail('server', `Сервер ElevenLabs недоступен (${code})`, false)
      : fail('server', `Ошибка соединения с ElevenLabs (${code})`, false);
  }
}

export const networkError = () => fail('network', 'Нет связи с ElevenLabs. Проверьте интернет', false);

function fail(kind, message, fatal) { return { type: 'failure', kind, message, fatal }; }

export function wsUrl(token, { sampleRate = 16000, vadSilence = 0.8, base = WS_BASE } = {}) {
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: 'pcm_' + sampleRate,
    commit_strategy: 'vad',
    vad_silence_threshold_secs: String(vadSilence),
    include_timestamps: 'false',
    token,
  });
  return base + '?' + q.toString();
}

export function audioChunkMessage(base64, sampleRate = 16000, commit = false) {
  return JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64, commit, sample_rate: sampleRate });
}

/** At most one draft translation per [minIntervalMs] and only when the text grew/changed by >= [minWordDelta] words. */
export class PartialThrottle {
  constructor(minIntervalMs = 700, minWordDelta = 3) {
    this.minIntervalMs = minIntervalMs; this.minWordDelta = minWordDelta; this.reset();
  }
  reset() { this.words = []; this.at = -Infinity; }
  should(text, now) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length || now - this.at < this.minIntervalMs) return false;
    let common = 0;
    while (common < words.length && common < this.words.length && words[common] === this.words[common]) common++;
    if (Math.max(words.length - common, this.words.length - common) < this.minWordDelta) return false;
    this.words = words; this.at = now;
    return true;
  }
}
