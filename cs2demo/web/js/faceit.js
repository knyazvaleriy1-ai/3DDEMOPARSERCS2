// FACEIT matches by link. The demo's address comes from FACEIT's API, which
// needs a secret key, so the link is resolved by a backend: the Python server
// (/api/faceit, it also downloads and parses) or, for the web version on
// Vercel, the api/faceit.js function (returns a signed link the browser
// downloads; through the function itself when FACEIT's storage forbids it).
import { STATIC } from './backend.js';
import { fetchJSON } from './util.js';

const MATCH_RE = /\b1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The match id in a FACEIT link (…/cs2/room/1-…/scoreboard) or the id itself. */
export function faceitMatchId(text) {
  const m = MATCH_RE.exec(text || '');
  return m ? m[0].toLowerCase() : null;
}

const endpoint = () => (STATIC ? 'api/faceit' : '/api/faceit');

let status = null;
/** {available: a backend answers, configured: it has a FACEIT key}. */
export function faceitStatus() {
  if (!status) {
    status = (async () => {
      try {
        const res = await fetch(endpoint(), { headers: { Accept: 'application/json' } });
        const json = res.ok && /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
        return { available: !!json, configured: !!json?.configured };
      } catch (_) {
        return { available: false, configured: false };
      }
    })();
  }
  return status;
}

export const MANUAL_HINT = 'На странице матча FACEIT нажмите «Watch demo» и перетащите скачанный .dem.zst сюда.';

/** Static version: {match, demos: [{name, url, proxy, size?}]} from the site's function. */
export async function resolveMatch(id) {
  let res;
  try {
    res = await fetch(`${endpoint()}?match=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Сервис FACEIT недоступен: ${err.message}`);
  }
  const json = /json/.test(res.headers.get('content-type') || '') ? await res.json().catch(() => null) : null;
  if (!res.ok || !json) {
    if (!json && res.status === 404) {
      throw new Error(`Скачивание по ссылке работает в версии сайта на Vercel или на своём сервере. ${MANUAL_HINT}`);
    }
    throw new Error(json?.error || `FACEIT: ошибка ${res.status}`);
  }
  // The proxy comes as a query string for this same endpoint.
  for (const d of json.demos || []) if (d.proxy?.startsWith('?')) d.proxy = `${endpoint()}${d.proxy}`;
  return json;
}

/**
 * Download one demo of ``resolveMatch`` to a File with progress. Tries
 * FACEIT's signed link first, then the site's proxy (the storage may not
 * allow other sites to read it). ``exists(file-like)`` lets a demo parsed
 * before skip the download (true: resolves to null).
 */
export async function downloadDemo(demo, { lastModified = 0, onProgress, exists } = {}) {
  let res = null;
  try {
    res = await fetch(demo.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (!demo.proxy) throw new Error(`Демо не скачалось: ${err.message}`);
    res = await fetch(demo.proxy);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error || `Демо не скачалось (HTTP ${res.status}): ссылка устарела или демо удалено`);
  }
  const total = Number(res.headers.get('content-length')) || demo.size || 0;
  if (total && exists && (await exists({ name: demo.name, size: total, lastModified }))) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(total ? got / total : 0, got);
  }
  return new File(parts, demo.name, { type: 'application/octet-stream', lastModified });
}

/** Server version: the server downloads and parses; resolves to the demo ids. */
export async function serverDownload(link, onStatus) {
  const { job } = await fetchJSON('/api/faceit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }),
  });
  for (;;) {
    const st = await fetchJSON(`/api/jobs/${encodeURIComponent(job)}`);
    if (st.status === 'error') throw new Error(st.message || 'Ошибка FACEIT');
    if (st.status === 'done') return st.result;
    onStatus?.(st.progress || 0, st.message || '…');
    await new Promise((r) => setTimeout(r, 700));
  }
}

/** A bookmarklet that opens the current FACEIT match page in this viewer. */
export function bookmarklet() {
  const site = `${location.origin}${location.pathname}`;
  return `javascript:location.href=${JSON.stringify(`${site}?faceit=`)}+encodeURIComponent(location.href)`;
}
