// Parse worker: loads the WebAssembly demoparser, copies the demo into its
// memory in chunks and runs the JS port of the Python parser. Demos inside a
// .rar are unpacked on the fly straight into the parser (parse/rar.js), and
// so are compressed demos (FACEIT: .dem.zst, older .dem.gz).
//
// Messages: {op: 'list', file}               -> {type: 'entries', entries}
//           {op: 'parse', file, entry, step} -> {type: 'done', meta, frames}
//           {op: 'extract', file, entry}     -> {type: 'done', blob}
// ("entry" = {name, size} of a file in the archive, null for a plain .dem)
import init, * as wasm from '../../vendor/demoparser/cs2wasm.js';
import { Decompress } from '../../vendor/fzstd/fzstd.mjs';
import { parseLoaded } from './parser.js';
import { baseName, openRar } from './rar.js';

const CHUNK = 8 << 20;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (fraction, message) => post({ type: 'progress', fraction, message });

async function openArchive(file) {
  const wasmBinary = await fetch(new URL('../../vendor/unrar/unrar.wasm', import.meta.url)).then((r) => r.arrayBuffer());
  const reader = new FileReaderSync();
  return openRar({
    size: file.size,
    readAt: (pos, len) => new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + len))),
    wasmBinary,
  });
}

/** Unpack ``entry`` feeding each chunk to ``sink``; checks nothing went missing. */
function unpack(rar, entry, sink, label, share = 1) {
  let last = 0;
  let got = 0;
  rar.extract(entry.name, (chunk, done) => {
    sink(chunk);
    got = done;
    if (done - last > CHUNK) {
      last = done;
      progress((share * done) / entry.size, label);
    }
  });
  if (got !== entry.size) throw new Error(`Файл ${baseName(entry.name)} распакован не полностью (${got} из ${entry.size} байт)`);
}

/** Size of the demo inside a .zst (frame header) / .gz (trailer), or 0 when it doesn't say. */
async function unpackedSize(file, kind) {
  if (kind === 'gzip') {
    const t = new DataView(await file.slice(Math.max(0, file.size - 4)).arrayBuffer());
    return t.byteLength === 4 ? t.getUint32(0, true) : 0;
  }
  const h = new Uint8Array(await file.slice(0, 18).arrayBuffer());
  const fhd = h[4];
  const single = (fhd >> 5) & 1, fcsFlag = fhd >> 6;
  let p = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3];
  const n = [single ? 1 : 0, 2, 4, 8][fcsFlag];
  let size = 0;
  for (let i = n - 1; i >= 0; i--) size = size * 256 + h[p + i];
  return n === 2 ? size + 256 : size;
}

/** 'zstd' / 'gzip' when ``file`` is compressed (by its first bytes), else null. */
async function compression(file) {
  const h = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (h[0] === 0x28 && h[1] === 0xb5 && h[2] === 0x2f && h[3] === 0xfd) return 'zstd';
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  return null;
}

/** Decompress ``file`` chunk by chunk into ``sink``; ``onRead(bytesRead)``. */
async function unpackStream(file, kind, sink, onRead) {
  if (kind === 'gzip') {
    let read = 0;
    const counted = file.stream().pipeThrough(new TransformStream({
      transform(chunk, ctl) { read += chunk.length; onRead(read); ctl.enqueue(chunk); },
    }));
    const reader = counted.pipeThrough(new DecompressionStream('gzip')).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sink(value);
    }
    return;
  }
  const z = new Decompress((chunk) => sink(chunk));
  for (let off = 0; off < file.size; off += CHUNK) {
    const end = Math.min(file.size, off + CHUNK);
    z.push(new Uint8Array(await file.slice(off, end).arrayBuffer()), end >= file.size);
    onRead(end);
  }
}

async function parse(file, entry, step) {
  progress(0, 'Загрузка парсера');
  const pre = entry || /\.(zst|gz)$/i.test(file.name) ? 0.25 : 0.1; // share of the bar for reading / unpacking
  await init({ module_or_path: new URL('../../vendor/demoparser/cs2wasm_bg.wasm', import.meta.url) });
  const packed = entry ? null : await compression(file);
  if (entry) {
    const rar = await openArchive(file);
    wasm.begin(entry.size);
    unpack(rar, entry, (chunk) => wasm.push(chunk), 'Распаковка архива', pre);
  } else if (packed) {
    // Unknown size: guess, the buffer grows if needed.
    wasm.begin((await unpackedSize(file, packed)) || file.size * 3);
    let last = 0, got = 0;
    await unpackStream(file, packed, (chunk) => { wasm.push(chunk); got += chunk.length; }, (read) => {
      if (read - last > CHUNK || read === file.size) {
        last = read;
        progress((0.25 * read) / file.size, 'Распаковка демо');
      }
    });
    if (!got) throw new Error('Архив пуст');
  } else {
    wasm.begin(file.size);
    for (let off = 0; off < file.size; off += CHUNK) {
      const chunk = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      wasm.push(chunk);
      progress(pre * Math.min(1, (off + CHUNK) / file.size), 'Чтение файла');
    }
  }
  const { meta, frames } = parseLoaded(wasm, {
    fileName: entry ? baseName(entry.name) : file.name.replace(/\.(zst|gz)$/i, ''),
    step,
    now: () => performance.now(),
    progress: (f, m) => progress(pre + (1 - pre) * f, m),
  });
  wasm.release();
  post({ type: 'done', meta, frames }, [frames]);
}

/** Unpack one file to a Blob (the server version uploads it). */
async function extract(file, entry) {
  const rar = await openArchive(file);
  const parts = [];
  let buf = new Uint8Array(CHUNK);
  let used = 0;
  unpack(rar, entry, (chunk) => {
    for (let off = 0; off < chunk.length;) {
      const n = Math.min(chunk.length - off, buf.length - used);
      buf.set(chunk.subarray(off, off + n), used);
      used += n;
      off += n;
      if (used === buf.length) {
        parts.push(buf);
        buf = new Uint8Array(CHUNK);
        used = 0;
      }
    }
  }, 'Распаковка архива');
  if (used) parts.push(buf.subarray(0, used));
  post({ type: 'done', blob: new Blob(parts, { type: 'application/octet-stream' }) });
}

self.onmessage = async (e) => {
  const { op = 'parse', file, entry = null, step } = e.data;
  try {
    if (op === 'list') post({ type: 'entries', entries: (await openArchive(file)).list() });
    else if (op === 'extract') await extract(file, entry);
    else await parse(file, entry, step);
  } catch (err) {
    console.error(err);
    const size = entry ? entry.size : file.size;
    let message = err?.message || String(err);
    if (err instanceof RangeError || /memory|allocation/i.test(message)) {
      message = `Не хватило памяти браузера для этой демки (${Math.round(size / 1e6)} МБ). Попробуйте на компьютере или закройте другие вкладки.`;
    } else if (/unreachable/i.test(message)) {
      message = `Парсер не смог разобрать файл: ${message}. Это точно демка CS2 (.dem)?`;
    }
    post({ type: 'error', message });
  }
};
