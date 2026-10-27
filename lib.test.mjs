// Run: node web/lib.test.mjs
import assert from 'node:assert/strict';
import { classify, opposite, splitSentences, parseEvent, wsUrl, audioChunkMessage, httpError, PartialThrottle } from './lib.js';

assert.equal(classify('Привет, как дела?'), 'ru');
assert.equal(classify('Hello, how are you?'), 'en');
assert.equal(classify('Мы обсудим roadmap и KPI'), 'ru');
assert.equal(classify('Let us discuss Москва'), 'en');
assert.equal(classify('12345 !!!'), null);
assert.equal(classify('مرحبا بالعالم'), null);
assert.equal(opposite('ru'), 'en');
assert.equal(opposite('en'), 'ru');

assert.deepEqual(splitSentences('Привет. Как дела? Хорошо!'), ['Привет.', 'Как дела?', 'Хорошо!']);
assert.deepEqual(splitSentences('One two three'), ['One two three']);
assert.deepEqual(splitSentences('  '), []);
assert.deepEqual(splitSentences('Wait... what?'), ['Wait...', 'what?']);
assert.deepEqual(splitSentences('Да. Ок. Мы договорились о цене.'), ['Да. Ок.', 'Мы договорились о цене.']); // tiny fragments are glued to the previous sentence

assert.deepEqual(parseEvent('{"message_type":"partial_transcript","text":"hi"}'), { type: 'partial', text: 'hi' });
assert.deepEqual(parseEvent('{"message_type":"committed_transcript","text":"hi there"}'), { type: 'committed', text: 'hi there' });
assert.deepEqual(parseEvent('{"message_type":"session_started","session_id":"s1"}'), { type: 'session', id: 's1' });
assert.equal(parseEvent('{"message_type":"auth_error","error":"x"}').fatal, true);
assert.equal(parseEvent('{"message_type":"rate_limited"}').fatal, false);
assert.equal(parseEvent('{"message_type":"insufficient_audio_activity"}'), null);
assert.equal(parseEvent('{"message_type":"unknown_thing"}'), null);
assert.equal(parseEvent('not json'), null);

assert.equal(httpError(401).fatal, true);
assert.equal(httpError(403).kind, 'invalid_key');
assert.equal(httpError(429).fatal, false);
assert.equal(httpError(503).fatal, false);

const u = new URL(wsUrl('TOK'));
assert.equal(u.searchParams.get('token'), 'TOK');
assert.equal(u.searchParams.get('model_id'), 'scribe_v2_realtime');
assert.equal(u.searchParams.get('audio_format'), 'pcm_16000');
assert.equal(u.searchParams.get('commit_strategy'), 'vad');
assert.equal(u.host, 'api.elevenlabs.io');

assert.deepEqual(JSON.parse(audioChunkMessage('AAA')), { message_type: 'input_audio_chunk', audio_base_64: 'AAA', commit: false, sample_rate: 16000 });

const t = new PartialThrottle(700, 3);
assert.equal(t.should('one two', 0), false);       // delta 2 < 3
assert.equal(t.should('one two three', 0), true);
assert.equal(t.should('one two three four five six', 100), false); // interval
assert.equal(t.should('one two three four five six', 900), true);
assert.equal(t.should('one two three four five six seven', 2000), false); // delta 1
t.reset();
assert.equal(t.should('a b c', 0), true);

console.log('lib tests OK');
