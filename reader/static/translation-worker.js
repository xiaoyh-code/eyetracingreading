import { env, pipeline } from '@huggingface/transformers';
import { Converter } from 'opencc-js';

// Runtime files are copied beside this worker by the build, never loaded from a CDN.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useFSCache = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/onnx/', import.meta.url).href;

const MODEL = 'Xenova/opus-mt-en-zh';
const REVISION = '046f55aec303cdee3e0318604406d4df20f1e8ea';
const traditional = Converter({ from: 'cn', to: 'twp' });
let translator = null;
let busy = false;

function errorMessage(error, preparing) {
  if (error?.code === 'INPUT_TOO_LONG') return '句子嘅模型字數超過上限；請分開較短句子再翻譯。';
  return preparing
    ? '模型下載或初始化失敗。請檢查網絡、瀏覽器儲存空間及可用記憶體，再重新下載。'
    : '本機翻譯未能完成；請選擇較短英文句子。若持續失敗，請重新載入頁面以釋放記憶體。';
}

async function translate(text, singleWord = false) {
  const encoded = await translator.tokenizer(text);
  if (encoded.input_ids.dims.at(-1) > 256) {
    const error = new Error('input too long'); error.code = 'INPUT_TOO_LONG'; throw error;
  }
  const output = await translator(text, { max_new_tokens: singleWord ? 48 : 192, num_beams: 1, do_sample: false,
    ...(singleWord ? { repetition_penalty: 1.15, no_repeat_ngram_size: 2 } : {}) });
  const result = output?.[0]?.translation_text;
  if (typeof result !== 'string' || !result.trim()) throw new Error('empty translation');
  const translated = traditional(result.trim());
  return singleWord ? translated.replace(/[。.!！?？]+$/u, '') : translated;
}

self.onmessage = async ({ data }) => {
  if (!data || !Number.isInteger(data.id) || !['prepare', 'explain'].includes(data.type)) return;
  const { id, type } = data;
  if (busy) { self.postMessage({ id, type: 'error', message: '本機翻譯忙碌中，請稍候。' }); return; }
  busy = true;
  try {
    if (type === 'prepare') {
      if (!translator) translator = await pipeline('translation', MODEL, {
        revision: REVISION, device: 'wasm', dtype: 'q8',
        progress_callback: progress => self.postMessage({ id, type: 'progress', progress }),
      });
      self.postMessage({ id, type: 'ready' });
    } else {
      if (!translator || typeof data.word !== 'string' || typeof data.sentence !== 'string'
          || !data.word.trim() || data.word.length > 80 || !data.sentence.trim() || data.sentence.length > 1200) throw new Error('invalid input');
      // A sentence terminator helps this sentence translation model handle a
      // standalone word; it is still a machine gloss, not a dictionary entry.
      const meaning = await translate(`${data.word}.`, true);
      const translation = data.sentence === data.word ? meaning : await translate(data.sentence);
      self.postMessage({ id, type: 'result', result: { meaning, translation, source: 'offline', example: '', visual_hint: '', message: '由瀏覽器離線模型翻譯；單字譯法可能需要結合句子判斷。' } });
    }
  } catch (error) {
    if (type === 'prepare' && translator) { await translator.dispose(); translator = null; }
    self.postMessage({ id, type: 'error', message: errorMessage(error, type === 'prepare') });
  } finally { busy = false; }
};
