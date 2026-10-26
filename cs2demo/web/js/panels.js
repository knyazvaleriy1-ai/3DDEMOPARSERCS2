// Sidebar tabs: players, highlights (+ clip recording), clips library, view settings.
import { STATIC, library } from './backend.js';
import { esc, fmtBytes, fmtMoney, fmtTime, fetchJSON, iconSvg, toast, weaponIcon } from './util.js';
import { ICONS } from './icons.js';
import {
  ClipDirector, POV_LABELS, downloadBlob, exportMp4, exportRealtime, uploadClip, webCodecsSupported,
} from './clips.js';

// -- Players ------------------------------------------------------------------------

export class PlayersPanel {
  constructor(el, viewer) {
    this.el = el;
    this.viewer = viewer;
    this.signature = '';
    this.rows = [];
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.prow');
      if (!row) return;
      const p = Number(row.dataset.p);
      if (this.viewer.focus === p) this.viewer.setMode('free', -1);
      else this.viewer.setFocus(p);
    });
  }

  reset() { this.signature = ''; this.el.innerHTML = ''; }

  update() {
    const v = this.viewer, d = v.demo;
    if (!d) return;
    const states = v.states;
    const sides = states.map((s) => (s.present ? s.side : 'X'));
    const signature = sides.join('');
    if (signature !== this.signature) this._build(sides);
    this.signature = signature;
    const stats = d.statsAt(v.tick);
    const score = d.scoreAt(v.tick, states);
    for (const side of ['T', 'CT']) {
      const el = this.el.querySelector(`.team.${side} .score`);
      if (el) el.textContent = score[side];
    }
    for (const r of this.rows) {
      const st = states[r.p];
      const s = stats[r.p];
      r.el.classList.toggle('dead', !st.alive);
      r.el.classList.toggle('selected', v.focus === r.p);
      r.hp.style.width = `${st.alive ? st.hp : 0}%`;
      r.hpWrap.classList.toggle('low', st.hp <= 30);
      const weapon = st.alive ? st.weapon : '';
      if (r.weaponName !== weapon) {
        r.weaponName = weapon;
        const key = weaponIcon(weapon);
        r.weapon.innerHTML = weapon ? `${key ? iconSvg(ICONS, key, 13) : ''}<span>${esc(weapon)}</span>` : '—';
      }
      r.money.textContent = fmtMoney(st.money);
      r.kda.textContent = `${s.k} / ${s.d} / ${s.a}${s.adr ? ` · ${s.adr} ADR` : ''}`;
      r.place.textContent = st.alive ? st.place : '';
      r.armor.textContent = st.alive && st.armor ? (st.helmet ? '🛡+' : '🛡') : '';
    }
  }

  _build(sides) {
    const d = this.viewer.demo;
    const names = {};
    for (const side of ['T', 'CT']) {
      const clans = d.players.filter((p, i) => sides[i] === side && p.clan).map((p) => p.clan);
      names[side] = clans[0] || (side === 'T' ? 'Террористы' : 'Спецназ');
    }
    let html = '';
    for (const side of ['T', 'CT']) {
      html += `<div class="team ${side}"><div class="team-head"><span>${side} · ${esc(names[side])}</span><span class="score">0</span></div>`;
      d.players.forEach((p, i) => {
        if (sides[i] !== side) return;
        html += `<div class="prow" data-p="${i}">
          <div class="pname" title="${esc(p.name)}">${esc(p.name)}</div><div class="kda"></div>
          <div class="pinfo"><div class="hp"><div></div></div><span class="armor"></span>
          <span class="weapon"></span><span class="place"></span><span class="money"></span></div></div>`;
      });
      html += '</div>';
    }
    this.el.innerHTML = html + '<p class="muted small">Клик по игроку — следить за ним. Клавиши 1–6 — режимы камеры.</p>';
    this.rows = [...this.el.querySelectorAll('.prow')].map((el) => ({
      el,
      p: Number(el.dataset.p),
      hp: el.querySelector('.hp > div'),
      hpWrap: el.querySelector('.hp'),
      weapon: el.querySelector('.weapon'),
      money: el.querySelector('.money'),
      kda: el.querySelector('.kda'),
      place: el.querySelector('.place'),
      armor: el.querySelector('.armor'),
    }));
  }
}

// -- Highlights + recording ------------------------------------------------------------

const RESOLUTIONS = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], 'vertical': [1080, 1920] };

export class HighlightsPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.viewer = app.viewer;
    this.selected = new Set();
    this.filter = { minScore: 0, player: '', kind: '' };
    this.busy = false;
    this.abort = null;
    this.opts = loadOpts();
  }

  get demo() { return this.viewer.demo; }

  reset() {
    const d = this.demo;
    this.selected = new Set(
      [...(d?.highlights || [])].sort((a, b) => b.score - a.score).slice(0, 5).map((h) => h.id),
    );
    this.render();
  }

  render() {
    const d = this.demo;
    if (!d) { this.el.innerHTML = ''; return; }
    const o = this.opts;
    const players = d.players.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
    this.el.innerHTML = `
      <div class="panel">
        <h3>Автозапись клипов</h3>
        <div class="form-grid">
          <label>Камера</label>
          <select data-opt="pov">${Object.entries(POV_LABELS).map(([k, v]) => `<option value="${k}" ${o.pov === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <label>Размер</label>
          <select data-opt="res">${Object.keys(RESOLUTIONS).map((k) => `<option ${o.res === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <label>FPS</label>
          <select data-opt="fps">${[30, 60].map((f) => `<option ${o.fps === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
        </div>
        <label class="check"><input type="checkbox" data-opt="slowmo" ${o.slowmo ? 'checked' : ''}> Замедление в момент киллов</label>
        <label class="check"><input type="checkbox" data-opt="hud" ${o.hud ? 'checked' : ''}> HUD, килфид и титры</label>
        <label class="check"><input type="checkbox" data-opt="sound" ${o.sound ? 'checked' : ''}> Звук (выстрелы, гранаты, шаги)</label>
        <label class="check" title="После загрузки нового демо сразу записать 5 лучших хайлайтов">
          <input type="checkbox" data-opt="auto" ${o.auto ? 'checked' : ''}> Автозапись 5 лучших после загрузки демо</label>
        <div class="btn-row">
          <button class="btn primary" data-act="record">● Записать выбранные</button>
          ${STATIC ? '' : '<button class="btn" data-act="server" title="Покадровый рендер в MP4 на сервере (headless Chromium)">Рендер на сервере</button>'}
        </div>
        <div class="status-line" id="rec-status"></div>
      </div>
      <div class="panel">
        <div class="form-grid">
          <label>Мин. очков</label><input type="range" min="0" max="150" step="5" value="${this.filter.minScore}" data-filter="minScore">
          <label>Игрок</label><select data-filter="player"><option value="">все</option>${players}</select>
          <label>Тип</label><select data-filter="kind"><option value="">все</option><option value="multikill">мультикиллы</option><option value="clutch">клатчи</option><option value="kill">особые киллы</option></select>
        </div>
        <div class="btn-row">
          <button class="btn small" data-act="top5">Лучшие 5</button>
          <button class="btn small" data-act="all">Все видимые</button>
          <button class="btn small" data-act="none">Снять выбор</button>
        </div>
      </div>
      <div class="hl-list"></div>`;
    this.el.querySelector('[data-filter=player]').value = this.filter.player;
    this.el.querySelector('[data-filter=kind]').value = this.filter.kind;
    this._bind();
    this.renderList();
  }

  _visible() {
    const f = this.filter;
    return this.demo.highlights.filter((h) => h.score >= f.minScore
      && (f.player === '' || String(h.player) === f.player)
      && (f.kind === '' || h.kind === f.kind));
  }

  renderList() {
    const list = this.el.querySelector('.hl-list');
    if (!list) return;
    const vis = this._visible();
    const rate = this.demo.tickRate;
    list.innerHTML = vis.length ? vis.map((h) => `
      <div class="hl ${h.side || ''}" data-id="${esc(h.id)}">
        <input type="checkbox" ${this.selected.has(h.id) ? 'checked' : ''} data-sel title="Выбрать для записи">
        <div><div class="title">${esc(h.title)}</div>
          <div class="meta">Раунд ${h.round} · ${fmtTime((h.start - this.demo.startTick) / rate)} · ${h.duration.toFixed(1)} с</div></div>
        <div class="score" title="Очки хайлайта">${h.score}</div>
        <div class="tags">${h.tags.map((t) => `<span class="tag ${/^(ACE|\dK|клатч)/.test(t) ? 'big' : ''}">${esc(t)}</span>`).join('')}</div>
        <div class="actions">
          <button class="btn small" data-act="watch">▶ Смотреть</button>
          <button class="btn small" data-act="rec1">● Записать</button>
          <button class="btn small" data-act="cmd" title="Скопировать команду консоли CS2 для перехода к моменту">CS2</button>
        </div>
      </div>`).join('') : '<p class="muted">Нет хайлайтов под фильтр. Уменьшите «Мин. очков».</p>';
    this._selCount();
    document.getElementById('hl-count').textContent = this.demo.highlights.length || '';
  }

  _selCount() {
    const btn = this.el.querySelector('[data-act=record]');
    if (btn) btn.textContent = `● Записать выбранные (${this.selected.size})`;
  }

  _bind() {
    const el = this.el;
    el.querySelectorAll('[data-opt]').forEach((input) => input.addEventListener('change', () => {
      const k = input.dataset.opt;
      this.opts[k] = input.type === 'checkbox' ? input.checked : k === 'fps' ? Number(input.value) : input.value;
      saveOpts(this.opts);
    }));
    el.querySelectorAll('[data-filter]').forEach((input) => input.addEventListener('input', () => {
      const k = input.dataset.filter;
      this.filter[k] = k === 'minScore' ? Number(input.value) : input.value;
      this.renderList();
    }));
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('change', (e) => {
      if (!e.target.matches('[data-sel]')) return;
      const id = e.target.closest('.hl').dataset.id;
      if (e.target.checked) this.selected.add(id); else this.selected.delete(id);
      this._selCount();
    });
  }

  _onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const card = btn.closest('.hl');
    const h = card ? this.demo.highlights.find((x) => x.id === card.dataset.id) : null;
    switch (act) {
      case 'watch': return this.watch(h);
      case 'rec1': return this.recordList([h]);
      case 'cmd': {
        const name = this.demo.players[h.player]?.name || '';
        const cmd = `demo_gototick ${h.start}; spec_player "${name.replace(/"/g, '')}"`;
        navigator.clipboard?.writeText(cmd).then(() => toast(`Скопировано: ${cmd}`), () => toast(cmd, 'info', 8000));
        return;
      }
      case 'record': return this.recordList(this.demo.highlights.filter((x) => this.selected.has(x.id)));
      case 'server': return this.serverRender();
      case 'top5':
        this.selected = new Set([...this._visible()].sort((a, b) => b.score - a.score).slice(0, 5).map((x) => x.id));
        return this.renderList();
      case 'all':
        this._visible().forEach((x) => this.selected.add(x.id));
        return this.renderList();
      case 'none':
        this.selected.clear();
        return this.renderList();
      default:
    }
  }

  /** Record the best ``n`` highlights (used right after a new demo is uploaded). */
  autoRecord(n = 5) {
    const best = [...this.demo.highlights].sort((a, b) => b.score - a.score).slice(0, n)
      .sort((a, b) => a.start - b.start);
    if (best.length) this.recordList(best);
  }

  watch(h) {
    const v = this.viewer;
    this.el.querySelectorAll('.hl').forEach((c) => c.classList.toggle('active', c.dataset.id === h.id));
    this.app.timeline.activeHighlight = h;
    const mode = { first: 'pov', third: 'chase', overview: 'overview' }[this.opts.pov] || 'pov';
    v.setTick(h.start);
    v.setMode(mode, h.player);
    v.clip = this.opts.hud ? h : null;
    v.playRange(h.start, h.end, () => { v.clip = null; });
  }

  _status(text) {
    const el = this.el.querySelector('#rec-status');
    if (el) el.textContent = text;
  }

  async recordList(list) {
    if (this.busy) { toast('Запись уже идёт'); return; }
    if (!list.length) { toast('Отметьте хайлайты для записи'); return; }
    const [width, height] = RESOLUTIONS[this.opts.res] || RESOLUTIONS['720p'];
    const fps = this.opts.fps;
    const fast = await webCodecsSupported(width, height, fps);
    this.busy = true;
    this.abort = new AbortController();
    const rec = document.getElementById('rec-indicator');
    const recText = document.getElementById('rec-text');
    rec.classList.remove('hidden');
    document.getElementById('rec-cancel').onclick = () => this.abort?.abort();
    let saved = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        const director = new ClipDirector(this.viewer, h, {
          pov: this.opts.pov, fps, width, height, slowmo: this.opts.slowmo, hud: this.opts.hud, sound: this.opts.sound,
        });
        const label = `Клип ${i + 1}/${list.length}: ${h.title}`;
        const onProgress = (f) => {
          recText.textContent = `REC ${i + 1}/${list.length} · ${Math.round(f * 100)}%`;
          this._status(`${label} — ${Math.round(f * 100)}%${fast ? '' : ' (реальное время, не сворачивайте вкладку)'}`);
        };
        const blob = fast
          ? await exportMp4(director, { onProgress, signal: this.abort.signal })
          : await exportRealtime(director, { onProgress, signal: this.abort.signal });
        try {
          if (STATIC) {
            const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
            await library.putClip(this.demo.meta.id, `${director.fileName}.${ext}`, director.info, blob);
          } else {
            await uploadClip(this.demo.meta.id, director, blob);
          }
          saved++;
        } catch (err) {
          downloadBlob(blob, `${director.fileName}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
          toast(`${err.message}. Клип скачан браузером.`, 'error');
        }
      }
      this._status(`Готово: записано ${saved} из ${list.length}. Смотрите вкладку «Клипы».`);
      toast(`Записано клипов: ${saved}`);
    } catch (err) {
      if (err.name === 'AbortError') this._status('Запись отменена');
      else { console.error(err); this._status(`Ошибка записи: ${err.message}`); toast(err.message, 'error'); }
    } finally {
      this.busy = false;
      this.abort = null;
      rec.classList.add('hidden');
      this.app.clipsPanel.refresh();
    }
  }

  async serverRender() {
    const ids = this.demo.highlights.filter((x) => this.selected.has(x.id)).map((x) => x.id);
    if (!ids.length) { toast('Отметьте хайлайты для записи'); return; }
    const [width, height] = RESOLUTIONS[this.opts.res] || RESOLUTIONS['720p'];
    try {
      const res = await fetchJSON(`/api/demos/${this.demo.meta.id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips: ids, pov: this.opts.pov, width, height, fps: this.opts.fps,
          slowmo: this.opts.slowmo, hud: this.opts.hud, sound: this.opts.sound }),
      });
      this._status(`Рендер на сервере запущен (${res.clips.length} клип.)`);
      this._pollJob(res.job);
    } catch (err) {
      this._status(err.message);
      toast(err.message, 'error', 6000);
    }
  }

  async _pollJob(key) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      let job;
      try { job = await fetchJSON(`/api/jobs/${key}`); } catch (_) { return; }
      this._status(`Сервер: ${job.message || job.status} ${job.progress != null ? Math.round(job.progress * 100) + '%' : ''}`);
      if (job.status === 'done' || job.status === 'error') {
        if (job.status === 'done') toast('Рендер на сервере завершён');
        else toast(job.message, 'error', 6000);
        this.app.clipsPanel.refresh();
        return;
      }
    }
  }
}

function loadOpts() {
  const defaults = { pov: 'first', res: '720p', fps: 30, slowmo: false, hud: true, sound: true, auto: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('cs2demo.rec') || '{}') };
  } catch (_) {
    return defaults;
  }
}

function saveOpts(o) {
  try { localStorage.setItem('cs2demo.rec', JSON.stringify(o)); } catch (_) { /* private mode */ }
}

// -- Clips library -------------------------------------------------------------------

export class ClipsPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.all = false;
    this.picked = [];
    el.addEventListener('change', (e) => {
      if (!e.target.matches('[data-pick]')) return;
      const key = e.target.dataset.pick;
      this.picked = this.picked.filter((k) => k !== key);
      if (e.target.checked) this.picked.push(key);
      this._pickLabel();
    });
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'montage') { this.montage(); return; }
      if (btn.dataset.act === 'toggle-all') { this.all = !this.all; this.refresh(); return; }
      if (btn.dataset.act === 'refresh') { this.refresh(); return; }
      if (btn.dataset.act === 'delete') {
        const { demo, file } = btn.dataset;
        if (!confirm(`Удалить клип ${file}?`)) return;
        if (STATIC) await library.removeClip(`${demo}/${file}`);
        else await fetch(`/api/clips/${demo}/${encodeURIComponent(file)}`, { method: 'DELETE' });
        this.refresh();
      }
      if (btn.dataset.act === 'share') this.share(btn.dataset.key);
    });
  }

  async refresh() {
    const demoId = this.app.viewer.demo?.meta.id;
    let clips = [];
    try {
      clips = STATIC ? await this._localClips(demoId) : await fetchJSON(`/api/clips${!this.all && demoId ? `?demo=${demoId}` : ''}`);
    } catch (err) {
      this.el.innerHTML = `<p class="muted">Не удалось получить список клипов: ${esc(err.message)}</p>`;
      return;
    }
    document.getElementById('clip-count').textContent = clips.length || '';
    const head = `<div class="btn-row" style="margin:0 0 10px">
      <button class="btn small" data-act="refresh">Обновить</button>
      <button class="btn small" data-act="toggle-all">${this.all ? 'Только это демо' : 'Клипы всех демо'}</button>
      ${STATIC ? '' : '<button class="btn small primary" data-act="montage" title="Отметьте клипы в нужном порядке">Склеить в нарезку</button>'}</div>
      <div class="status-line" id="montage-status"></div>`;
    if (!clips.length) {
      this.el.innerHTML = head + '<p class="muted">Клипов пока нет. Откройте «Хайлайты», отметьте моменты и нажмите «Записать».</p>';
      return;
    }
    this.el.innerHTML = head + clips.map((c) => `
      <div class="clip">
        <video src="${esc(c.url)}" controls preload="metadata" playsinline></video>
        <div class="clip-body">
          <label class="check title">${STATIC ? '' : `<input type="checkbox" data-pick="${esc(c.demo)}/${esc(c.file)}"
            ${this.picked.includes(`${c.demo}/${c.file}`) ? 'checked' : ''}>`} ${esc(c.title || c.file)}</label>
          <div class="muted small">${esc([c.pov && POV_LABELS[c.pov], c.width && `${c.width}×${c.height}`, c.fps && `${c.fps} fps`,
            c.duration && `${c.duration} с`, fmtBytes(c.size)].filter(Boolean).join(' · '))}</div>
          <div class="btn-row">
            <a class="btn small" href="${esc(c.url)}" download="${esc(c.file)}">Скачать</a>
            ${STATIC && navigator.canShare ? `<button class="btn small" data-act="share" data-key="${esc(c.key)}">Поделиться</button>` : ''}
            <button class="btn small danger" data-act="delete" data-demo="${esc(c.demo)}" data-file="${esc(c.file)}">Удалить</button>
          </div>
        </div>
      </div>`).join('');
  }
}

Object.assign(ClipsPanel.prototype, {
  /** Static version: clips recorded in this browser (IndexedDB). */
  async _localClips(demoId) {
    const clips = await library.listClips(!this.all && demoId ? demoId : null);
    // Revoke the previous list's URLs once its <video>s have been replaced.
    const old = this._urls || [];
    setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 0);
    this._urls = [];
    this._blobs = new Map();
    return clips.map((c) => {
      const url = URL.createObjectURL(c.blob);
      this._urls.push(url);
      this._blobs.set(c.key, c);
      return { ...c, url };
    });
  },

  async share(key) {
    const c = this._blobs?.get(key);
    if (!c) return;
    const file = new File([c.blob], c.file, { type: c.blob.type });
    if (!navigator.canShare?.({ files: [file] })) { toast('Браузер не умеет делиться файлами — нажмите «Скачать»'); return; }
    try {
      await navigator.share({ files: [file], title: c.title || c.file });
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, 'error');
    }
  },

  _pickLabel() {
    const st = this.el.querySelector('#montage-status');
    if (st) st.textContent = this.picked.length ? `В нарезке: ${this.picked.length} (в порядке отметки)` : '';
  },

  async montage() {
    if (this.picked.length < 2) { toast('Отметьте хотя бы два клипа — в том порядке, в каком их склеить'); return; }
    const title = prompt('Заголовок нарезки', 'CS2 хайлайты');
    if (title === null) return;
    const clips = this.picked.map((k) => { const [demo, file] = k.split('/'); return { demo, file }; });
    const st = this.el.querySelector('#montage-status');
    try {
      await fetchJSON('/api/montage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips, title }),
      });
    } catch (err) { toast(err.message, 'error', 6000); return; }
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      let job;
      try { job = await fetchJSON('/api/jobs/montage'); } catch (_) { return; }
      if (st) st.textContent = `Нарезка: ${job.message || job.status}`;
      if (job.status === 'done' || job.status === 'error') {
        toast(job.status === 'done' ? 'Нарезка готова (Клипы всех демо → montages)' : job.message, job.status === 'done' ? 'info' : 'error', 6000);
        this.picked = [];
        this.all = true;
        this.refresh();
        return;
      }
    }
  },
});

// -- View settings ---------------------------------------------------------------------

export class ViewPanel {
  constructor(el, viewer) {
    this.el = el;
    this.viewer = viewer;
  }

  render() {
    const s = this.viewer.settings;
    const b = this.viewer.bounds;
    const minY = b ? Math.floor(b.min.y - 100) : -1000;
    const maxY = b ? Math.ceil(b.max.y + 600) : 1000;
    const mapKind = { mesh: '3D-геометрия карты', radar: 'радар (3D-геометрия недоступна)', grid: 'сетка (нет данных карты)' }[this.viewer.map?.kind] || '';
    this.el.innerHTML = `
      <div class="panel">
        <h3>Отображение</h3>
        <label class="check"><input type="checkbox" data-s="labels" ${s.labels ? 'checked' : ''}> Ники и HP над игроками</label>
        <label class="check"><input type="checkbox" data-s="xray" ${s.xray ? 'checked' : ''}> Видеть игроков сквозь стены</label>
        <label class="check"><input type="checkbox" data-s="grenades" ${s.grenades ? 'checked' : ''}> Траектории гранат</label>
        <label class="check"><input type="checkbox" data-s="tracers" ${s.tracers ? 'checked' : ''}> Трассеры выстрелов</label>
        <label class="check"><input type="checkbox" data-s="shadows" ${s.shadows ? 'checked' : ''}> Тени от солнца</label>
        <label class="check"><input type="checkbox" data-s="viewmodel" ${s.viewmodel ? 'checked' : ''}> Оружие в руках (от 1-го лица)</label>
        <label class="check"><input type="checkbox" data-s="detail" ${s.detail ? 'checked' : ''}> Детальные материалы карты</label>
        <label class="check"><input type="checkbox" data-s="radar" ${s.radar ? 'checked' : ''}> Радар на полу</label>
        <label class="check"><input type="checkbox" data-s="grid" ${s.grid ? 'checked' : ''}> Сетка 64 юнита</label>
      </div>
      <div class="panel">
        <h3>Крыши и потолки</h3>
        <select data-s="roofCut">
          <option value="auto" ${s.roofCut === 'auto' ? 'selected' : ''}>Авто: срезать над выбранным игроком</option>
          <option value="off" ${s.roofCut === 'off' ? 'selected' : ''}>Показывать всё</option>
          <option value="manual" ${s.roofCut === 'manual' ? 'selected' : ''}>Срез на высоте…</option>
        </select>
        <input type="range" data-s="cutHeight" min="${minY}" max="${maxY}" value="${s.cutHeight}" ${s.roofCut === 'manual' ? '' : 'disabled'} style="margin-top:8px">
      </div>
      <div class="panel">
        <h3>Камера</h3>
        <div class="btn-row"><button class="btn small" data-act="reset">Сбросить камеру</button></div>
        <p class="muted small">Мышь: ЛКМ — вращать, ПКМ — сдвиг, колесо — зум.<br>
        Клавиши: Пробел — пауза, ←/→ — 5 с, Shift+←/→ — раунд, 1–6 — камера
        (свободная, следить, от 1-го лица, из-за спины, сверху, обзор), [ и ] — скорость, Tab — следующий игрок.</p>
        <p class="muted small">Карта: ${esc(mapKind)}</p>
      </div>`;
    this.el.querySelectorAll('[data-s]').forEach((input) => input.addEventListener('input', () => {
      const k = input.dataset.s;
      s[k] = input.type === 'checkbox' ? input.checked : k === 'cutHeight' ? Number(input.value) : input.value;
      if (k === 'roofCut') this.el.querySelector('[data-s=cutHeight]').disabled = s.roofCut !== 'manual';
      this.viewer.applySettings();
    }));
    this.el.querySelector('[data-act=reset]').onclick = () => { this.viewer.setMode('free', -1); this.viewer.resetCamera(); };
  }
}
