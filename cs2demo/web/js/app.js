// Application shell: demo library, upload, playback controls, keyboard, render mode.
import { loadDemo } from './demo.js';
import { Viewer } from './viewer.js';
import { Timeline } from './timeline.js';
import { ClipsPanel, HighlightsPanel, PlayersPanel, ViewPanel } from './panels.js';
import { installRenderApi } from './clips.js';
import {
  STATIC, demoIdFor, extractEntry, isArchive, isDemoFile, library, listArchive, parseFile,
} from './backend.js';
import { esc, fetchJSON, fmtTime, toast } from './util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const RENDER_MODE = params.get('render') === '1';

class App {
  constructor() {
    this.viewer = new Viewer($('gl'), $('hud'), { interactive: !RENDER_MODE });
    this.demo = null;
    if (RENDER_MODE) return;
    this.timeline = new Timeline($('timeline'), this.viewer);
    this.playersPanel = new PlayersPanel($('tab-players'), this.viewer);
    this.highlightsPanel = new HighlightsPanel($('tab-highlights'), this);
    this.clipsPanel = new ClipsPanel($('tab-clips'), this);
    this.viewPanel = new ViewPanel($('tab-view'), this.viewer);
    this._bindUi();
    let last = 0;
    this.viewer.on((type) => {
      const now = performance.now();
      if (type === 'frame' && now - last < 120) return;
      last = now;
      this._refreshUi();
    });
  }

  // -- loading ----------------------------------------------------------------------

  async open(id) {
    const loading = $('loading');
    const setProgress = (f, text) => {
      $('loading-bar').style.width = `${Math.round(f * 100)}%`;
      if (text) $('loading-text').textContent = text;
    };
    loading.classList.remove('hidden');
    $('stage-msg').classList.add('hidden');
    setProgress(0.05, 'Загрузка демо…');
    try {
      const demo = await loadDemo(id, setProgress);
      if (this.demo) { location.href = `?demo=${encodeURIComponent(id)}`; return; }
      this.demo = demo;
      const kind = await this.viewer.setDemo(demo, setProgress);
      if (kind !== 'mesh') toast(kind === 'radar' ? '3D-геометрия карты недоступна — показан радар' : 'Нет данных карты — показана сетка', 'info', 6000);
      history.replaceState(null, '', `?demo=${encodeURIComponent(id)}`);
      this._onDemoLoaded();
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'error', 8000);
      this.showLibrary();
    } finally {
      loading.classList.add('hidden');
    }
  }

  _onDemoLoaded() {
    const d = this.demo;
    const m = d.meta;
    $('demo-title').innerHTML = `<b>${esc(m.map)}</b> · ${esc(m.file || '')} · ${d.rounds.length} раундов · ${fmtTime(d.duration)}`;
    document.title = `${m.map} — CS2 3D Demo Viewer`;
    $('round-select').innerHTML = d.rounds.map((r, i) =>
      `<option value="${i}">Раунд ${r.num}${r.winner ? ` · ${r.winner}` : ''}</option>`).join('');
    this.playersPanel.reset();
    this.highlightsPanel.reset();
    this.clipsPanel.refresh();
    this.viewPanel.render();
    this._refreshUi();
  }

  // -- library ----------------------------------------------------------------------

  async showLibrary() {
    $('library').classList.remove('hidden');
    const list = $('demo-list');
    list.innerHTML = '<p class="muted">Загрузка списка…</p>';
    let demos = [];
    try {
      demos = STATIC ? await library.list() : await fetchJSON('/api/demos');
    } catch (err) {
      list.innerHTML = `<p class="muted">${STATIC ? 'Хранилище браузера недоступно' : 'Сервер недоступен'}: ${esc(err.message)}</p>`;
      return;
    }
    if (!demos.length) {
      list.innerHTML = STATIC
        ? '<p class="muted">Пока нет демо. Откройте .dem файл — он разберётся прямо в браузере и сохранится на этом устройстве.</p>'
        : '<p class="muted">Пока нет разобранных демо. Загрузите .dem файл — он появится здесь.</p>';
      return;
    }
    list.innerHTML = demos.map((d) => {
      if (d.status !== 'ready') {
        return `<div class="demo-card" data-pending="${esc(d.id)}"><div class="dname">${esc(d.file || d.id)}</div>
          <div class="dscore muted small">${d.status === 'error' ? 'ошибка' : `${Math.round((d.progress || 0) * 100)}%`}</div>
          <div class="dmeta">${esc(d.message || '')}</div></div>`;
      }
      const [a, b] = d.teams || [];
      const date = d.parsedAt ? new Date(d.parsedAt * 1000).toLocaleString('ru-RU') : '';
      return `<div class="demo-card" data-id="${esc(d.id)}">
        <div class="dname">${esc(d.map)} — ${esc(d.file || d.id)}</div>
        <div class="dscore">${a ? `${a.score} : ${b.score}` : ''}</div>
        <div class="dmeta">${d.rounds} раундов · ${d.kills} киллов · ${d.highlights} хайлайтов · ${fmtTime(d.duration)} · ${esc(date)}<br>
          ${esc((d.players || []).join(', '))}</div>
        <div class="dactions"><button class="btn small danger" data-del="${esc(d.id)}">Удалить</button></div>
      </div>`;
    }).join('');
  }

  hideLibrary() {
    if (this.demo) $('library').classList.add('hidden');
  }

  /** A .dem, or a .rar with demos inside (HLTV), into the library; opens the first one. */
  async upload(file) {
    if (!file) return;
    const archive = isArchive(file.name);
    if (!archive && !isDemoFile(file.name)) { toast('Нужен файл .dem или архив .rar', 'error'); return; }
    $('library').classList.remove('hidden');
    const bar = $('upload-progress');
    const text = $('upload-text');
    bar.classList.remove('hidden');
    const setBar = (f) => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; };
    setBar(0);
    text.textContent = `${archive ? 'Открытие архива' : 'Загрузка'} ${file.name}…`;
    try {
      let entries = [null];
      if (archive) {
        const demos = await listArchive(file);
        if (!demos.length) throw new Error('В архиве нет демо (.dem)');
        entries = demos.length === 1 ? demos : await this._pickEntries(file.name, demos);
        if (!entries.length) { text.textContent = ''; return; }
      }
      const ids = [];
      for (const [i, entry] of entries.entries()) {
        const label = entries.length > 1 ? ` (${i + 1} из ${entries.length})` : '';
        ids.push(await this._ingest(file, entry, setBar, text, label));
      }
      setBar(1);
      text.textContent = 'Готово!';
      const auto = this.highlightsPanel.opts.auto;
      if (this.demo) location.href = `?demo=${encodeURIComponent(ids[0])}${auto ? '&autorecord=1' : ''}`;
      else {
        $('library').classList.add('hidden');
        await this.open(ids[0]);
        if (auto) this.highlightsPanel.autoRecord(5);
      }
    } catch (err) {
      text.textContent = err.message;
      toast(err.message, 'error', 8000);
    } finally {
      setTimeout(() => bar.classList.add('hidden'), 1500);
    }
  }

  /** One demo (a .dem file, or ``entry`` of a .rar) into the library; returns its id. */
  async _ingest(file, entry, setBar, text, label) {
    if (STATIC) return this._parseLocal(file, entry, setBar, text, label);
    let dem = file;
    if (entry) {
      // The server only takes .dem files: unpack here, then upload.
      dem = await extractEntry(file, entry, (f, m) => { setBar(0.3 * f); text.textContent = `${m}${label}…`; });
    }
    const base = entry ? 0.3 : 0;
    const span = (from, to) => (f) => setBar(base + (1 - base) * (from + (to - from) * f));
    text.textContent = `Загрузка ${dem.name}${label}…`;
    const res = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/demos');
      xhr.upload.onprogress = (e) => e.lengthComputable && span(0, 0.5)(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.detail || `Ошибка загрузки (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Сеть недоступна'));
      const form = new FormData();
      form.append('file', dem);
      xhr.send(form);
    });
    let status = res;
    while (status.status !== 'ready') {
      if (status.status === 'error') throw new Error(status.message || 'Ошибка разбора');
      span(0.5, 1)(status.progress || 0);
      text.textContent = `Разбор демо${label}: ${status.message || '…'}`;
      await new Promise((r) => setTimeout(r, 600));
      status = await fetchJSON(`/api/demos/${res.id}`);
    }
    return res.id;
  }

  /** Static version: parse in a worker, keep the result in IndexedDB. */
  async _parseLocal(file, entry, setBar, text, label) {
    const id = demoIdFor(file, entry);
    const name = entry ? entry.name.split(/[\\/]/).pop() : file.name;
    if (await library.has(id)) return id; // parsed before: just open it
    text.textContent = `Разбор ${name}${label}…`;
    const { meta, frames } = await parseFile(file, {
      entry,
      onProgress: (f, m) => { setBar(f); text.textContent = `Разбор демо в браузере${label}: ${m}`; },
    });
    meta.id = id;
    text.textContent = 'Сохранение…';
    try {
      await library.put(meta, frames);
    } catch (err) {
      throw new Error(`Не удалось сохранить разобранное демо в браузере (${err.message || err}). Освободите место и попробуйте снова.`);
    }
    return id;
  }

  /** Which demos of a multi-map archive to parse. Resolves to the chosen entries ([] = cancel). */
  _pickEntries(archiveName, entries) {
    const dlg = $('archive-picker');
    $('picker-note').textContent = `${archiveName}: ${entries.length} демо. Каждая карта разбирается отдельно`
      + `${STATIC ? ' (в браузере, около минуты на карту)' : ''}; уже разобранные откроются сразу.`;
    $('picker-list').innerHTML = entries.map((e, i) => `
      <label class="check"><input type="checkbox" data-i="${i}" ${i === 0 ? 'checked' : ''}>
        <span>${esc(e.name.split(/[\\/]/).pop())}</span><span class="muted small">${Math.round(e.size / 1e6)} МБ</span></label>`).join('');
    dlg.classList.remove('hidden');
    return new Promise((resolve) => {
      const finish = (chosen) => {
        dlg.classList.add('hidden');
        $('picker-ok').onclick = $('picker-cancel').onclick = $('picker-close').onclick = null;
        resolve(chosen);
      };
      $('picker-ok').onclick = () => finish(
        [...$('picker-list').querySelectorAll('input:checked')].map((c) => entries[Number(c.dataset.i)]));
      $('picker-cancel').onclick = $('picker-close').onclick = () => finish([]);
    });
  }

  // -- UI wiring ----------------------------------------------------------------------

  _bindUi() {
    const v = this.viewer;
    $('btn-library').onclick = () => this.showLibrary();
    $('library-close').onclick = () => this.hideLibrary();
    $('library').addEventListener('click', async (e) => {
      if (e.target === $('library')) return this.hideLibrary();
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        if (!confirm('Удалить демо и его разобранные данные? Записанные клипы останутся.')) return;
        if (STATIC) await library.remove(del.dataset.del);
        else await fetch(`/api/demos/${del.dataset.del}`, { method: 'DELETE' });
        return this.showLibrary();
      }
      const card = e.target.closest('[data-id]');
      if (card) {
        if (this.demo) location.href = `?demo=${encodeURIComponent(card.dataset.id)}`;
        else { $('library').classList.add('hidden'); this.open(card.dataset.id); }
      }
    });
    if (STATIC) {
      document.body.classList.add('static');
      // Android pickers grey out unknown extensions like .dem: accept anything.
      for (const input of [$('file-input'), $('file-input-2')]) input.removeAttribute('accept');
      $('btn-open-label').firstChild.textContent = 'Открыть демо';
      $('dz-note').textContent = 'Демо разбирается прямо в браузере: файл никуда не загружается и остаётся на этом устройстве.';
    }
    for (const input of [$('file-input'), $('file-input-2')]) {
      input.addEventListener('change', () => { this.upload(input.files[0]); input.value = ''; });
    }
    const dz = $('dropzone');
    window.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      this.upload(e.dataTransfer.files[0]);
    });

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'clips') this.clipsPanel.refresh();
      if (b.dataset.tab === 'view') this.viewPanel.render();
    }));

    document.querySelectorAll('#cam-modes button').forEach((b) => b.addEventListener('click', () => v.setMode(b.dataset.cam)));
    $('btn-play').onclick = () => v.toggle();
    $('btn-back').onclick = () => v.setTick(v.tick - 5 * (this.demo?.tickRate || 64));
    $('btn-fwd').onclick = () => v.setTick(v.tick + 5 * (this.demo?.tickRate || 64));
    $('btn-prev-round').onclick = () => this.jumpRound(-1);
    $('btn-next-round').onclick = () => this.jumpRound(1);
    $('speed-select').onchange = (e) => { v.speed = Number(e.target.value); };
    const audio = v.audio;
    const syncSound = () => {
      $('btn-sound').textContent = audio.muted || audio.volume === 0 ? '🔇' : '🔊';
      $('volume').value = String(audio.volume);
    };
    $('btn-sound').onclick = () => { audio.ensure(); audio.setMuted(!audio.muted); syncSound(); };
    $('volume').oninput = (e) => { audio.ensure(); audio.setVolume(Number(e.target.value)); if (audio.muted) audio.setMuted(false); syncSound(); };
    syncSound();
    $('round-select').onchange = (e) => {
      const r = this.demo.rounds[Number(e.target.value)];
      v.setTick(r.freezeEnd - 2 * this.demo.tickRate);
    };

    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea') || !this.demo) return;
      const rate = this.demo.tickRate;
      switch (e.code) {
        case 'Space': e.preventDefault(); v.toggle(); break;
        case 'ArrowLeft': e.preventDefault(); e.shiftKey ? this.jumpRound(-1) : v.setTick(v.tick - 5 * rate); break;
        case 'ArrowRight': e.preventDefault(); e.shiftKey ? this.jumpRound(1) : v.setTick(v.tick + 5 * rate); break;
        case 'BracketLeft': this._speedStep(-1); break;
        case 'BracketRight': this._speedStep(1); break;
        case 'Tab': e.preventDefault(); this._cycleFocus(e.shiftKey ? -1 : 1); break;
        case 'Escape': this.hideLibrary(); break;
        case 'KeyM': $('btn-sound').click(); break;
        default: {
          const modes = { Digit1: 'free', Digit2: 'follow', Digit3: 'pov', Digit4: 'chase', Digit5: 'top', Digit6: 'overview' };
          if (modes[e.code]) v.setMode(modes[e.code]);
        }
      }
    });
  }

  _speedStep(dir) {
    const sel = $('speed-select');
    sel.selectedIndex = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + dir));
    this.viewer.speed = Number(sel.value);
  }

  _cycleFocus(dir) {
    const v = this.viewer;
    const n = this.demo.P;
    let p = v.focus;
    for (let i = 0; i < n; i++) {
      p = (p + dir + n) % n;
      if (v.states[p]?.alive) break;
    }
    v.setFocus(p);
  }

  jumpRound(dir) {
    const d = this.demo;
    if (!d) return;
    const i = d.roundIndexAt(this.viewer.tick);
    const r = d.rounds[i];
    // "previous" from mid-round goes to the start of the current round first.
    let target = i + dir;
    if (dir < 0 && this.viewer.tick > r.freezeEnd + 3 * d.tickRate) target = i;
    target = Math.max(0, Math.min(d.rounds.length - 1, target));
    this.viewer.setTick(d.rounds[target].freezeEnd - 2 * d.tickRate);
  }

  _refreshUi() {
    const v = this.viewer, d = this.demo;
    $('btn-play').textContent = v.playing ? '❚❚' : '▶';
    document.querySelectorAll('#cam-modes button').forEach((b) => b.classList.toggle('active', b.dataset.cam === v.mode));
    if (!d) return;
    $('time-label').textContent = `${fmtTime(d.secondsAt(v.tick))} / ${fmtTime(d.duration)}`;
    const ri = d.roundIndexAt(v.tick);
    if (document.activeElement !== $('round-select')) $('round-select').value = String(ri);
    const target = v.focus >= 0 && v.mode !== 'free' ? d.players[v.focus]?.name : '';
    $('cam-target').innerHTML = target ? `Камера: <b>${esc(target)}</b> · Tab — следующий` : '';
    this.timeline.draw();
    this.playersPanel.update();
  }
}

async function main() {
  const app = new App();
  window.cs2app = app;
  if (RENDER_MODE) {
    document.body.classList.add('render-mode');
    const api = installRenderApi(app.viewer, () => app.demo);
    try {
      const id = params.get('demo');
      app.viewer.setFixedSize({ width: window.innerWidth, height: window.innerHeight });
      app.demo = await loadDemo(id);
      await app.viewer.setDemo(app.demo);
      app.viewer.externalDriver = true;
      api.ready = true;
    } catch (err) {
      api.error = err.message || String(err);
    }
    return;
  }
  const id = params.get('demo');
  if (id) {
    await app.open(id);
    if (params.get('autorecord') === '1' && app.demo) {
      history.replaceState(null, '', `?demo=${encodeURIComponent(id)}`);
      app.highlightsPanel.autoRecord(5);
    }
  } else {
    const msg = $('stage-msg');
    msg.innerHTML = '<h1>3D-просмотр демо CS2</h1>Загрузите .dem файл или выберите демо в библиотеке.';
    msg.classList.remove('hidden');
    app.showLibrary();
  }
}

main();
