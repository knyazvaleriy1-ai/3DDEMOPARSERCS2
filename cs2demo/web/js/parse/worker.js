// Parse worker: loads the WebAssembly demoparser, copies the File into its
// memory in chunks and runs the JS port of the Python parser.
import init, * as wasm from '../../vendor/demoparser/cs2wasm.js';
import { parseLoaded } from './parser.js';

const CHUNK = 8 << 20;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (fraction, message) => post({ type: 'progress', fraction, message });

self.onmessage = async (e) => {
  const { file, step } = e.data;
  try {
    progress(0, 'Загрузка парсера');
    await init({ module_or_path: new URL('../../vendor/demoparser/cs2wasm_bg.wasm', import.meta.url) });
    wasm.begin(file.size);
    for (let off = 0; off < file.size; off += CHUNK) {
      const chunk = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      wasm.push(chunk);
      progress(0.1 * Math.min(1, (off + CHUNK) / file.size), 'Чтение файла');
    }
    const { meta, frames } = parseLoaded(wasm, {
      fileName: file.name,
      step,
      now: () => performance.now(),
      progress: (f, m) => progress(0.1 + 0.9 * f, m),
    });
    wasm.release();
    post({ type: 'done', meta, frames }, [frames]);
  } catch (err) {
    console.error(err);
    let message = err?.message || String(err);
    if (err instanceof RangeError || /memory|allocation/i.test(message)) {
      message = `Не хватило памяти браузера для этой демки (${Math.round(file.size / 1e6)} МБ). Попробуйте на компьютере или закройте другие вкладки.`;
    } else if (/unreachable/i.test(message)) {
      message = `Парсер не смог разобрать файл: ${message}. Это точно демка CS2 (.dem)?`;
    }
    post({ type: 'error', message });
  }
};
