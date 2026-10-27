// Opus-MT (ru<->en) in the browser via transformers.js (ONNX Runtime Web, int8). Runs in a worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;
const MODELS = { 'ru-en': 'Xenova/opus-mt-ru-en', 'en-ru': 'Xenova/opus-mt-en-ru' };
const pipes = {};

function load(pair) {
  if (!pipes[pair]) {
    pipes[pair] = pipeline('translation', MODELS[pair], {
      dtype: 'q8',
      progress_callback: (p) => postMessage({ type: 'progress', pair, p }),
    });
  }
  return pipes[pair];
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await Promise.all([load('ru-en'), load('en-ru')]);
      postMessage({ type: 'ready' });
    } else if (m.type === 'translate') {
      const p = await load(m.src + '-' + m.tgt);
      // One sentence at a time: batching pads the inputs and makes Opus-MT emit stray "......".
      const parts = [];
      for (const s of m.sentences) {
        const out = await p(s, { max_new_tokens: 160 });
        parts.push(out[0].translation_text);
      }
      postMessage({ type: 'result', id: m.id, text: parts.join(' ') });
    }
  } catch (err) {
    postMessage(m.type === 'translate'
      ? { type: 'result', id: m.id, error: String(err && err.message || err) }
      : { type: 'error', message: String(err && err.message || err) });
  }
};
