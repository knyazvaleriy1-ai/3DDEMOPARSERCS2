// FACEIT match link -> demo, for the web version on Vercel: the FACEIT API key
// stays here, on the server (Vercel -> Settings -> Environment Variables).
//
//   GET /api/faceit                          {configured}
//   GET /api/faceit?match=<link or id>       {match, demos: [{name, url, proxy}]}
//                                            url: FACEIT's signed download link
//   GET /api/faceit?match=<id>&file=<n>      the demo itself, streamed through here
//                                            (when the browser can't read FACEIT's link)
//
// Env: FACEIT_API_KEY (server-side key from developers.faceit.com) and, if the
// Downloads API access FACEIT approved came as a separate token,
// FACEIT_DOWNLOADS_TOKEN. Same flow as cs2demo/faceit.py.
const { Readable } = require('node:stream');

const DOCS_URL = 'https://docs.faceit.com/getting-started/Guides/download-api/';
const MATCH_RE = /\b1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const apiUrl = () => process.env.FACEIT_API_URL || 'https://open.faceit.com';
const apiKey = () => (process.env.FACEIT_API_KEY || '').trim();
const downloadsToken = () => (process.env.FACEIT_DOWNLOADS_TOKEN || '').trim() || apiKey();

class FaceitError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function matchId(text) {
  const m = MATCH_RE.exec(text || '');
  return m ? m[0].toLowerCase() : null;
}

function explain(status, what) {
  if (what === 'download' && (status === 401 || status === 403)) {
    return 'FACEIT не отдал ссылку на демо: ключу не открыт доступ к Downloads API. Его выдают по заявке '
      + `(${DOCS_URL}, рассматривают около 30 дней). Пока можно скачать демо на странице матча `
      + '(кнопка Watch demo) и открыть файл .dem.zst здесь.';
  }
  if (status === 401) return 'FACEIT отклонил ключ API: проверьте FACEIT_API_KEY';
  if (status === 403) return 'FACEIT запретил доступ к матчу для этого ключа';
  if (status === 404) return 'Матч не найден на FACEIT';
  if (status === 429) return 'Слишком много запросов к FACEIT, попробуйте через минуту';
  return `Ошибка FACEIT API (${status})`;
}

async function call(method, path, token, body, what) {
  let res;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new FaceitError(`FACEIT недоступен: ${err.message}`);
  }
  if (!res.ok) throw new FaceitError(explain(res.status, what), res.status === 404 ? 404 : 502);
  return res.json();
}

function matchInfo(match) {
  const teams = match.teams || {};
  const names = ['faction1', 'faction2'].map((f) => String((teams[f] || {}).name || '?'));
  const picks = ((match.voting || {}).map || {}).pick || [];
  return {
    id: match.match_id,
    title: names.join(' vs '),
    map: picks[0] || '',
    finishedAt: match.finished_at || null,
    status: match.status || null,
    demos: (match.demo_url || []).filter(Boolean),
  };
}

function fileName(info, url, index) {
  const path = new URL(url, 'https://x/').pathname.toLowerCase();
  const suffix = path.endsWith('.zst') ? '.dem.zst' : path.endsWith('.gz') ? '.dem.gz' : '.dem';
  const raw = info.map ? `faceit-${info.map}-${info.title.replace(' vs ', '-vs-')}` : `faceit-${info.id}`;
  const base = raw.replace(/[^0-9a-zA-Z_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'faceit';
  return `${base}${index ? `-${index + 1}` : ''}${suffix}`;
}

async function resolve(id) {
  const info = matchInfo(await call('GET', `/data/v4/matches/${id}`, apiKey(), null, 'match'));
  if (!info.demos.length) {
    throw new FaceitError('У матча нет демо: оно ещё не загружено (появляется через несколько минут после матча) '
      + 'или уже удалено — FACEIT хранит демо около 30 дней', 404);
  }
  return info;
}

async function signedUrl(resource) {
  const res = await call('POST', '/download/v2/demos/download', downloadsToken(), { resource_url: resource }, 'download');
  const url = (res.payload || {}).download_url;
  if (!url) throw new FaceitError('FACEIT не вернул ссылку на демо');
  return url;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  if (!q.get('match')) return send(res, 200, { configured: !!apiKey() });
  if (!apiKey()) {
    return send(res, 501, { error: 'На сайте не задан ключ FACEIT API: добавьте FACEIT_API_KEY в настройки Vercel' });
  }
  const id = matchId(q.get('match'));
  if (!id) return send(res, 400, { error: 'Не похоже на ссылку на матч FACEIT' });
  try {
    const info = await resolve(id);
    if (q.get('file') === null) {
      const demos = [];
      for (const [i, resource] of info.demos.entries()) {
        demos.push({
          name: fileName(info, resource, i),
          url: await signedUrl(resource),
          proxy: `?match=${id}&file=${i}`,
        });
      }
      const { demos: _resources, ...match } = info;
      return send(res, 200, { match, demos });
    }
    // Proxy: stream the file through (only FACEIT's own storage, via a fresh signed link).
    const i = Number(q.get('file'));
    if (!Number.isInteger(i) || i < 0 || i >= info.demos.length) return send(res, 400, { error: 'Нет такого файла' });
    const upstream = await fetch(await signedUrl(info.demos[i]));
    if (!upstream.ok || !upstream.body) {
      return send(res, 502, { error: `Демо не скачалось (HTTP ${upstream.status}): ссылка устарела или демо удалено` });
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(info, info.demos[i], i)}"`);
    res.setHeader('Cache-Control', 'no-store');
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    // Keep the function alive until the whole file has gone out.
    await new Promise((done, fail) => {
      const body = Readable.fromWeb(upstream.body);
      body.on('error', fail);
      res.on('close', done);
      body.pipe(res);
    });
    return undefined;
  } catch (err) {
    if (err instanceof FaceitError) return send(res, err.status, { error: err.message });
    return send(res, 500, { error: `Ошибка: ${err.message}` });
  }
}

module.exports = handler;
module.exports.matchId = matchId;
module.exports.matchInfo = matchInfo;
module.exports.fileName = fileName;
