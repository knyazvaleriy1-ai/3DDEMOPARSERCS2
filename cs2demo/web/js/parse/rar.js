// RAR archives (HLTV demos come as .rar): the UnRAR library compiled to
// WebAssembly (vendor/unrar, node-unrar-js). The archive is read in slices on
// demand and the unpacked bytes are handed to a callback as they come out, so
// neither the archive nor the unpacked demo is ever held in memory twice.
import unrarFactory from '../../vendor/unrar/unrar.js';
import { Extractor } from '../../vendor/unrar/Extractor.js';

const ARCHIVE_FD = 1;
const OUTPUT_FD = 2;
const READ_AHEAD = 4 << 20;

export const isRar = (name) => /\.rar$/i.test(name);
export const isDemo = (name) => /\.dem$/i.test(name);
export const baseName = (name) => name.split(/[\\/]/).pop();

/** UnRAR file callbacks over a random-access reader: readAt(pos, len) -> Uint8Array. */
class StreamExtractor extends Extractor {
  constructor(unrar, size, readAt) {
    super(unrar, '');
    this._filePath = 'archive.rar';
    this.size = size;
    this.readAt = readAt;
    this.pos = 0;
    this.cache = null;
    this.cacheStart = 0;
    this.onData = null;
    this.outName = '';
    this.outPos = 0;
  }

  open(name) {
    if (name !== this._filePath) return 0;
    this.pos = 0;
    return ARCHIVE_FD;
  }

  create(name) {
    this.outName = name;
    this.outPos = 0;
    return OUTPUT_FD;
  }

  closeFile() {}

  read(fd, buf, size) {
    if (fd !== ARCHIVE_FD) return -1;
    const n = Math.max(0, Math.min(size, this.size - this.pos));
    if (n === 0) return 0;
    const c = this.cache;
    if (!c || this.pos < this.cacheStart || this.pos + n > this.cacheStart + c.byteLength) {
      this.cacheStart = this.pos;
      this.cache = this.readAt(this.pos, Math.min(this.size - this.pos, Math.max(n, READ_AHEAD)));
    }
    const off = this.pos - this.cacheStart;
    this.unrar.HEAPU8.set(this.cache.subarray(off, off + n), buf);
    this.pos += n;
    return n;
  }

  write(fd, buf, size) {
    if (fd !== OUTPUT_FD) return false;
    this.outPos += size;
    // A view into wasm memory: the callback must copy what it keeps.
    this.onData?.(this.unrar.HEAPU8.subarray(buf, buf + size), this.outPos);
    return true;
  }

  tell(fd) {
    return fd === ARCHIVE_FD ? this.pos : this.outPos;
  }

  seek(fd, offset, method) {
    if (fd !== ARCHIVE_FD) return false;
    const base = method === 'SET' ? 0 : method === 'CUR' ? this.pos : this.size;
    const pos = base + offset;
    if (pos < 0 || pos > this.size) return false;
    this.pos = pos;
    return true;
  }
}

const MESSAGES = {
  ERAR_MISSING_PASSWORD: 'архив защищён паролем',
  ERAR_BAD_PASSWORD: 'архив защищён паролем',
  ERAR_BAD_ARCHIVE: 'это не RAR-архив',
  ERAR_UNKNOWN_FORMAT: 'неизвестный формат архива',
  ERAR_BAD_DATA: 'архив повреждён (или скачан не полностью)',
  ERAR_EOPEN: 'многотомный архив: нужен один файл .rar',
};

function friendly(err) {
  const reason = MESSAGES[err?.reason];
  return reason ? new Error(`Не удалось распаковать: ${reason}`) : err;
}

/**
 * Open a RAR archive of ``size`` bytes read through ``readAt``.
 * Returns {list(), extract(name, onData)}.
 */
export async function openRar({ size, readAt, wasmBinary }) {
  // A module per archive: its memory (the unpack window) goes away with it.
  const unrar = await unrarFactory({ wasmBinary });
  const ex = new StreamExtractor(unrar, size, readAt);
  unrar.extractor = ex;
  return {
    /** Files in the archive: [{name, size, encrypted}]. */
    list() {
      try {
        const { fileHeaders } = ex.getFileList();
        return [...fileHeaders].filter((h) => !h.flags.directory)
          .map((h) => ({ name: h.name, size: h.unpSize, encrypted: h.flags.encrypted }));
      } catch (err) {
        throw friendly(err);
      }
    },
    /** Unpack ``name``, calling onData(view, bytesSoFar) for every chunk. */
    extract(name, onData) {
      ex.onData = onData;
      try {
        const { files } = ex.extract({ files: [name] });
        let found = false;
        for (const _f of files) found = true;
        if (!found) throw new Error(`В архиве нет ${name}`);
      } catch (err) {
        throw friendly(err);
      } finally {
        ex.onData = null;
      }
    },
  };
}
