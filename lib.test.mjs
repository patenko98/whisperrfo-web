// Run: node web/lib.test.mjs
import assert from 'node:assert/strict';
import {
  classify, opposite, splitSentences, parseEvent, wsUrl, audioChunkMessage, httpError, PartialThrottle,
  cleanTranslation, extractNumbers, missingNumbers, parseGlossary, glossaryPre, glossaryRestore, glossaryPost,
} from './lib.js';

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

// commit message (end of session)
assert.deepEqual(JSON.parse(audioChunkMessage('', 16000, true)), { message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 });

// cleanTranslation
assert.equal(cleanTranslation('......'), '');
assert.equal(cleanTranslation('Hello ...... world'), 'Hello … world');
assert.equal(cleanTranslation('Wait... what?'), 'Wait... what?');
assert.equal(cleanTranslation('the the the the the cat'), 'the cat');
assert.equal(cleanTranslation('no no no'), 'no no no');
assert.equal(cleanTranslation('I want to go, I want to go, I want to go, now'), 'I want to go, now');
assert.equal(cleanTranslation('Да да да да да'), 'Да');
assert.equal(cleanTranslation('  Нормально   сказано .  '), 'Нормально сказано.');
assert.equal(cleanTranslation(null), '');

// numbers
assert.deepEqual(extractNumbers('Цена 1 500 рублей, скидка 2,50 и 15%'), ['1500', '2.5', '15']);
assert.deepEqual(extractNumbers('It costs $1,500.00 or 3.5'), ['1500', '3.5']);
assert.deepEqual(missingNumbers('Нас было 15 человек, 2024 год', 'We were 15 people in 2024'), []);
assert.deepEqual(missingNumbers('Нас было 15 человек', 'We were 50 people'), ['15']);
assert.deepEqual(missingNumbers('Всего 1 500', 'Total 1,500'), []);
assert.deepEqual(missingNumbers('Привет', 'Hello'), []);

// glossary
const g = parseGlossary(['# comment', 'договор поставки = supply agreement', 'НДС = VAT', 'license = лицензия', 'stock => inventory', 'plain line'].join(String.fromCharCode(10)));
assert.equal(g.pre.length, 3);
assert.equal(g.post.length, 1);
let r = glossaryPre('Подпишем договор поставки и НДС включён. Договор поставки ок.', 'ru', g);
assert.equal(r.text, 'Подпишем Qx0Q и Qx1Q включён. Qx0Q ок.');
assert.deepEqual(r.map.map((m) => m.to), ['supply agreement', 'VAT']);
let back = glossaryRestore('We will sign Qx0Q and Qx1Q is included. Qx0Q ok.', r.map);
assert.equal(back.ok, true);
assert.equal(back.text, 'We will sign supply agreement and VAT is included. supply agreement ok.');
assert.equal(glossaryRestore('We will sign it', r.map).ok, false);
assert.equal(glossaryRestore('qx 0 q', r.map).text, 'supply agreement');
assert.equal(glossaryPre('NDS and договорённость', 'en', g).map.length, 0);   // ru term does not touch en text
assert.equal(glossaryPre('Our license is valid', 'en', g).text, 'Our Qx0Q is valid');
assert.equal(glossaryPre('договоры', 'ru', g).map.length, 0);                 // whole words only
assert.equal(glossaryPost('We have stock left', 'en', g), 'We have inventory left');
assert.equal(glossaryPost('stock', 'ru', g), 'stock');                         // "=>" rule is English, target is Russian

console.log('lib tests OK');
