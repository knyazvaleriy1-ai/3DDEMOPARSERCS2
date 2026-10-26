// Where data comes from: the Python server (/api/…) or, in the static web
// version, the browser itself — demos parsed by the WebAssembly parser in a
// worker and stored in IndexedDB, assets served as plain files.
import { STATIC } from './config.js';

export { STATIC };

// -- asset URLs (relative in the static build: the site lives under /<repo>/) --------

export const urls = {
  mapInfo: (m) => (STATIC ? `assets/maps/${m}/info.json` : `/api/maps/${m}/info`),
  mapRadar: (m, lower = false) => (STATIC
    ? `assets/maps/${m}/radar${lower ? '_lower' : ''}.png`
    : `/api/maps/${m}/radar${lower ? '?lower=1' : ''}`),
  models: () => (STATIC ? 'assets/models/index.json' : '/api/models'),
  modelFile: (f) => (STATIC ? `assets/models/${encodeURIComponent(f)}` : `/api/models/file/${encodeURIComponent(f)}`),
  sounds: () => (STATIC ? null : '/api/sounds'),
};

/** The map's collision mesh as an ArrayBuffer (null if there is none). */
export async function fetchMapMesh(mapName) {
  if (!STATIC) {
    const res = await fetch(`/api/maps/${mapName}/mesh`);
    return res.ok ? res.arrayBuffer() : null;
  }
  // Pre-gzipped: GitHub Pages does not compress unknown binary types.
  const res = await fetch(`assets/maps/${mapName}/mesh.bin.gz`);
  if (!res.ok) return null;
  if (typeof DecompressionStream === 'undefined') throw new Error('браузер не умеет распаковывать gzip');
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// -- IndexedDB library ------------------------------------------------------------------

const DB_NAME = 'cs2demo';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB недоступна')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('summaries', { keyPath: 'id' });
        d.createObjectStore('demos'); // id -> {meta, frames}
        const clips = d.createObjectStore('clips', { keyPath: 'key' });
        clips.createIndex('demo', 'demo');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('транзакция прервана'));
  }));
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Same shape as the server's demo summary (GET /api/demos). */
export function summarize(meta) {
  const players = meta.players || [];
  const last = meta.scoreboard?.length ? meta.scoreboard[meta.scoreboard.length - 1].stats : [];
  const teams = [['T', 'Команда 1'], ['CT', 'Команда 2']].map(([side, fallback]) => {
    const members = players.map((p, i) => [p, i]).filter(([p]) => p.startSide === side);
    const clan = members.map(([p]) => p.clan).find(Boolean);
    const score = Math.max(0, ...members.map(([, i]) => (last[i] ? last[i][4] : 0)));
    return { name: clan || fallback, score };
  });
  return {
    id: meta.id,
    status: 'ready',
    file: meta.file,
    map: meta.map,
    rounds: (meta.rounds || []).length,
    players: players.map((p) => p.name),
    kills: (meta.kills || []).length,
    highlights: (meta.highlights || []).length,
    parsedAt: meta.parsedAt,
    duration: Math.round(((meta.frames.endTick - meta.frames.startTick) / (meta.tickRate || 64)) * 10) / 10,
    teams,
  };
}

export const library = {
  async list() {
    const all = await tx(['summaries'], 'readonly', (t) => reqP(t.objectStore('summaries').getAll()));
    return all.sort((a, b) => (b.parsedAt || 0) - (a.parsedAt || 0));
  },

  async get(id) {
    return tx(['demos'], 'readonly', (t) => reqP(t.objectStore('demos').get(id)));
  },

  async put(meta, frames) {
    await tx(['summaries', 'demos'], 'readwrite', (t) => {
      t.objectStore('demos').put({ meta, frames }, meta.id);
      t.objectStore('summaries').put(summarize(meta));
    });
  },

  async remove(id) {
    // Recorded clips stay, like on the server.
    await tx(['summaries', 'demos'], 'readwrite', (t) => {
      t.objectStore('summaries').delete(id);
      t.objectStore('demos').delete(id);
    });
  },

  async putClip(demo, file, info, blob) {
    const rec = { key: `${demo}/${file}`, demo, file, ...info, size: blob.size, created: Date.now() / 1000, blob };
    await tx(['clips'], 'readwrite', (t) => { t.objectStore('clips').put(rec); });
    return rec;
  },

  async listClips(demo = null) {
    const all = await tx(['clips'], 'readonly', (t) => {
      const store = t.objectStore('clips');
      return reqP(demo ? store.index('demo').getAll(demo) : store.getAll());
    });
    return all.sort((a, b) => b.created - a.created);
  },

  async removeClip(key) {
    await tx(['clips'], 'readwrite', (t) => { t.objectStore('clips').delete(key); });
  },
};

// -- parsing in the browser -----------------------------------------------------------------

/** Stable id from the file's name, size and date (re-opening the same file reuses it). */
export function demoIdFor(file) {
  let h = 0x811c9dc5;
  for (const ch of `${file.name}|${file.size}|${file.lastModified}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const stem = file.name.replace(/\.dem$/i, '');
  const slug = stem.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'demo';
  return `${slug}-${h.toString(16).padStart(8, '0')}`;
}

/** Parse a .dem File in a worker. Resolves to {meta, frames}. */
export function parseFile(file, { step = 2, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse/worker.js', import.meta.url), { type: 'module' });
    const done = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.(msg.fraction, msg.message);
      else if (msg.type === 'done') done(resolve, { meta: msg.meta, frames: msg.frames });
      else if (msg.type === 'error') done(reject, new Error(msg.message));
    };
    worker.onerror = (e) => done(reject, new Error(e.message || 'ошибка парсера'));
    worker.postMessage({ file, step });
  });
}
