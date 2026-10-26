// The "Смоки" tab: smoke lineups found in the demo (lineups.js) and their
// replays with a utility camera: the thrower's aim (slow motion at the
// release), then the grenade in flight from behind, then a slow orbit around
// the smoke as it blooms. Replays play live or record to MP4 like highlights.
import * as THREE from '../vendor/three.module.min.js';
import { ClipDirector } from './clips.js';
import { renderClipAudio } from './audio.js';
import { PlayersView } from './players.js';
import { CLICK_LABELS, THROW_LABELS, findSmokes, setposCommand } from './lineups.js';
import { POV_FOV } from './viewer.js';
import { RESOLUTIONS } from './panels.js';
import { esc, fmtTime, toast } from './util.js';

const PRE = 1.8; // s of the thrower's aim before the release
const BLOOM = 3.5; // s around the smoke once it pops
const SLOW = 0.35; // playback speed at the release
const CHASE_FOV = 62;
const ORBIT = 430; // units from the smoke while it blooms

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Drives the viewer's camera through one lineup (viewer.utilityCam). */
export class UtilityCam {
  constructor(demo, lineup, raycaster = null) {
    this.demo = demo;
    this.l = lineup;
    this.g = demo.grenades[lineup.grenade];
    this.ray = raycaster;
    const rate = demo.tickRate;
    this.player = lineup.player;
    this.release = lineup.release;
    this.land = lineup.land;
    this.start = Math.max(demo.startTick, this.release - PRE * rate);
    this.end = Math.min(demo.endTick, this.land + BLOOM * rate);
    this.pov = true; // the HUD shows a crosshair while we look through the thrower's eyes
    const how = [THROW_LABELS[lineup.technique], CLICK_LABELS[lineup.click]].filter(Boolean).join(', ');
    this.banner = { text: `Смок: ${lineup.title} · ${how}`, ff: 0 };
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._dir = new THREE.Vector3(1, 0, 0);
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._has = false;
    this._orbit = null;
    this._hit = {};
    this._st = demo.state(this.player, this.start);
  }

  /** Playback speed at ``tick``: slow motion from just before to just after the release. */
  speedAt(tick) {
    const d = (tick - this.release) / this.demo.tickRate;
    const w = smooth((d + 0.7) / 0.3) * smooth((0.6 - d) / 0.3);
    return 1 - (1 - SLOW) * w;
  }

  /** Frame -> tick of a recording at ``fps``. */
  ticks(fps) {
    const out = [];
    const step = this.demo.tickRate / fps;
    for (let t = this.start; t <= this.end && out.length < 20000; t += step * this.speedAt(t)) out.push(t);
    return out;
  }

  phase(tick) {
    return tick < this.release ? 'aim' : tick < this.land ? 'flight' : 'bloom';
  }

  /** The grenade at ``tick`` (three.js coordinates) into ``pos``; its heading into ``dir`` (false: at rest). */
  grenade(tick, pos, dir) {
    const { ticks, pts } = this.g;
    const n = ticks.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ticks[mid] <= tick) lo = mid; else hi = mid - 1; }
    const i = Math.min(lo, n - 2);
    const t = Math.max(0, Math.min(1, (tick - ticks[i]) / Math.max(1, ticks[i + 1] - ticks[i])));
    const x = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * t;
    const y = pts[i * 3 + 1] + (pts[i * 3 + 4] - pts[i * 3 + 1]) * t;
    const z = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * t;
    pos.set(x, z, -y);
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 3);
    dir.set(pts[b * 3] - pts[a * 3], pts[b * 3 + 2] - pts[a * 3 + 2], -(pts[b * 3 + 1] - pts[a * 3 + 1]));
    if (dir.lengthSq() < 4) return false;
    dir.normalize();
    return true;
  }

  /** ``want`` pulled in front of the first wall between ``from`` and it. */
  _clear(from, want) {
    if (!this.ray) return want;
    const d = this._v[3].subVectors(want, from);
    const len = d.length();
    if (len < 1) return want;
    d.divideScalar(len);
    const hit = this.ray.cast(from.x, from.y, from.z, d.x, d.y, d.z, len + 12, this._hit);
    if (hit) want.copy(from).addScaledVector(d, Math.max(8, hit.t - 14));
    return want;
  }

  /** Free distance from ``from`` towards ``want`` (up to the full length). */
  _clearance(from, want) {
    const d = this._v[3].subVectors(want, from);
    const len = d.length();
    if (!this.ray || len < 1) return len;
    d.divideScalar(len);
    const hit = this.ray.cast(from.x, from.y, from.z, d.x, d.y, d.z, len, this._hit);
    return hit ? hit.t : len;
  }

  /** The side to watch the smoke from: open, and close to where the camera comes from. */
  _bestView(L, from) {
    const a0 = from ? Math.atan2(from.z - L.z, from.x - L.x) : 0;
    const p = new THREE.Vector3();
    let best = { angle: a0, height: 150, score: -Infinity };
    for (let i = 0; i < 24; i++) {
      const off = ((i + 12) % 24 - 12) * (Math.PI / 12); // 0, ±15°, ±30°, ...
      for (const height of [110, 170]) {
        const angle = a0 + off;
        p.set(L.x + Math.cos(angle) * ORBIT, L.y + height, L.z + Math.sin(angle) * ORBIT);
        const score = Math.min(this._clearance(L, p), ORBIT) - Math.abs(off) * 25 + (height === 110 ? 5 : 0);
        if (score > best.score) best = { angle, height, score };
      }
    }
    return best;
  }

  _fov(cam, fov) {
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Place the viewer's camera for ``viewer.tick``: {hidden, cut} like Viewer._updateCamera. */
  update(viewer, dt) {
    const cam = viewer.camera;
    const tick = viewer.tick;
    const rate = this.demo.tickRate;
    const k = (r) => (this._has ? 1 - Math.exp(-r * Math.max(dt, 1 / 240)) : 1);
    const [a, b, c] = this._v;
    const ph = this.phase(tick);
    const st = viewer.states[this.player];
    this.pov = ph === 'aim' && !!st?.present && st.alive;
    if (this.pov) {
      PlayersView.eye(st, a);
      PlayersView.viewDir(st, b);
      cam.position.copy(a);
      cam.lookAt(c.copy(a).add(b));
      this._fov(cam, POV_FOV);
      this._pos.copy(a);
      this._look.copy(a).addScaledVector(b, 120);
      this._dir.copy(b);
      this._has = true;
      return { hidden: this.player, cut: 1e6 };
    }
    this._fov(cam, CHASE_FOV);
    if (ph !== 'bloom') {
      // Behind the grenade, a little above, turning with it (smoothly: bounces flip its heading).
      const moving = this.grenade(Math.max(tick, this.release), a, b);
      if (moving) this._dir.lerp(b, k(3)).normalize();
      const want = c.copy(a).addScaledVector(this._dir, -130);
      want.y += 38;
      this._clear(a, want);
      this._pos.lerp(want, k(6));
      this._look.lerp(b.copy(a).addScaledVector(this._dir, 50), k(12));
    } else {
      // A slow orbit around the smoke, from the most open side near where the chase left off.
      const to = this.l.to;
      const L = a.set(to[0], to[2] + 70, -to[1]);
      if (!this._orbit) this._orbit = { ...this._bestView(L, this._has ? this._pos : null), t0: tick };
      const s = (tick - this._orbit.t0) / rate;
      const angle = this._orbit.angle + 0.16 * s;
      const want = c.set(L.x + Math.cos(angle) * ORBIT, L.y + this._orbit.height, L.z + Math.sin(angle) * ORBIT);
      this._clear(L, want);
      this._pos.lerp(want, k(3));
      this._look.lerp(L, k(4));
    }
    cam.position.copy(this._pos);
    cam.lookAt(this._look);
    this._has = true;
    // Leaving the thrower's eyes: don't show the inside of their head.
    const near = st?.present && PlayersView.eye(st, a).distanceTo(this._pos) < 90;
    return { hidden: near ? this.player : -1, cut: 1e6 };
  }

  /** Where the clip is heard from (world units, Z up): the thrower, the grenade, the smoke. */
  listenerAt(tick) {
    const ph = this.phase(tick);
    if (ph === 'aim') {
      const st = this.demo.state(this.player, tick, this._st);
      return { x: st.x, y: st.y, z: st.z + 64, yaw: st.yaw };
    }
    const p = this._v[0], d = this._v[1];
    if (ph === 'flight' && this.grenade(tick, p, d)) {
      return { x: p.x, y: -p.z, z: p.y, yaw: (Math.atan2(-d.z, d.x) * 180) / Math.PI };
    }
    const to = this.l.to;
    return { x: to[0] - 300, y: to[1], z: to[2] + 170, yaw: 0 };
  }
}

/** Records a lineup replay (see clips.js for the export). */
export class SmokeDirector extends ClipDirector {
  constructor(viewer, lineup, opts = {}) {
    const demo = viewer.demo;
    const cam = new UtilityCam(demo, lineup, viewer.map?.raycaster() || null);
    const name = demo.players[lineup.player]?.name || '';
    const h = {
      id: lineup.id, player: lineup.player, playerName: name, title: lineup.title, label: null,
      round: lineup.roundNum, score: lineup.score, tags: lineup.tags, side: lineup.side,
      start: cam.start, end: cam.end, killTicks: [],
    };
    super(viewer, h, { ...opts, pov: 'first', slowmo: false }, cam.ticks(opts.fps || 30));
    this.cam = cam;
    this.lineup = lineup;
  }

  get fileName() { return this.h.id; }

  start() {
    super.start();
    const v = this.viewer;
    this.saved.banner = v.banner;
    v.utilityCam = this.cam;
    v.focus = this.cam.player;
    v.banner = this.cam.banner;
  }

  finish() {
    if (!this.started) return;
    const v = this.viewer;
    v.utilityCam = null;
    v.banner = this.saved.banner;
    super.finish();
  }

  async audio() {
    if (!this.opts.sound || typeof OfflineAudioContext === 'undefined') return null;
    if (!this._audio) {
      this._audio = await renderClipAudio(this.viewer.demo, this.ticks, this.opts.fps, this.h.player, {
        voice: this.voiceMode, listenerAt: (tick) => this.cam.listenerAt(tick),
      });
    }
    return this._audio;
  }

  get info() {
    return { ...super.info, pov: 'utility', title: this.h.title, setpos: setposCommand(this.lineup) };
  }
}

/** Headless renderer: a lineup by id (or the best one). */
export function installSmokeRenderApi(api) {
  api.smokes = () => findSmokes(api.getDemo(), { raycaster: api.viewer.map?.raycaster() || null }).lineups
    .map((l) => ({ id: l.id, title: l.title, score: l.score, interesting: l.interesting, tags: l.tags }));
  api.beginSmoke = (id, opts = {}) => {
    const { lineups } = findSmokes(api.getDemo(), { raycaster: api.viewer.map?.raycaster() || null });
    const l = id ? lineups.find((x) => x.id === id) : lineups[0];
    if (!l) throw new Error(`нет лайнапа ${id}`);
    const director = new SmokeDirector(api.viewer, l, { ...opts, width: window.innerWidth, height: window.innerHeight });
    return { ...api.use(director), file: director.fileName, info: director.info };
  };
}

// -- the tab --------------------------------------------------------------------------

export class SmokesPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.filter = { show: 'interesting', side: '', to: '', tech: '', player: '' };
    this.selected = new Set();
    this.data = null;
  }

  get viewer() { return this.app.viewer; }
  get demo() { return this.app.demo; }

  reset() {
    this.data = null;
    this.selected.clear();
    this.filter.to = '';
    this.filter.player = '';
    const n = this._data()?.lineups.filter((l) => l.interesting).length;
    const badge = document.getElementById('smoke-count');
    if (badge) badge.textContent = n || '';
  }

  _data() {
    if (!this.demo) return null;
    if (!this.data) this.data = findSmokes(this.demo, { raycaster: this.viewer.map?.raycaster() || null });
    return this.data;
  }

  render() {
    const data = this._data();
    if (!data) { this.el.innerHTML = ''; return; }
    const f = this.filter;
    const places = [...new Set(data.lineups.map((l) => l.toPlace).filter(Boolean))].sort();
    const opt = (v, t, sel) => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(t)}</option>`;
    this.el.innerHTML = `
      <div class="panel">
        <h3>Smoke lineups</h3>
        <p class="muted small">Все смоки демо: откуда и как брошен (джампсроу, с бега, ЛКМ/ПКМ), куда упал.
          Лайнапами помечены дальние броски по точке — вслепую, в прыжке, повторённые в нескольких раундах.
          ▶ — повтор с камерой гранаты: прицел игрока (замедление на броске), полёт, раскрытие дыма.
          <b>setpos</b> копирует позицию и угол для консоли CS2 (на своём сервере, sv_cheats 1).</p>
        <div class="form-grid">
          <label>Показать</label><select data-f="show">${opt('interesting', 'только лайнапы', f.show)}${opt('all', 'все смоки', f.show)}</select>
          <label>Сторона</label><select data-f="side">${opt('', 'обе', f.side)}${opt('T', 'T', f.side)}${opt('CT', 'CT', f.side)}</select>
          <label>Куда</label><select data-f="to">${opt('', 'все места', f.to)}${places.map((p) => opt(p, p, f.to)).join('')}</select>
          <label>Бросок</label><select data-f="tech">${opt('', 'любой', f.tech)}${Object.entries(THROW_LABELS).map(([k, v]) => opt(k, v, f.tech)).join('')}</select>
          <label>Игрок</label><select data-f="player">${opt('', 'все', f.player)}${this.demo.players.map((p, i) => opt(String(i), p.name, f.player)).join('')}</select>
        </div>
        <div class="btn-row">
          <button class="btn primary" data-act="rec-sel">● Записать выбранные</button>
          <button class="btn small" data-act="sel-all">Выбрать видимые</button>
          <button class="btn small" data-act="sel-none">Снять выбор</button>
        </div>
        <p class="muted small">Запись — с настройками вкладки «Хайлайты» (размер, FPS, звук, войс, HUD).</p>
      </div>
      <div class="smoke-list"></div>`;
    this.el.querySelectorAll('[data-f]').forEach((s) => s.addEventListener('change', () => {
      this.filter[s.dataset.f] = s.value;
      this.renderList();
    }));
    if (!this._bound) {
      this._bound = true;
      this.el.addEventListener('click', (e) => this._onClick(e));
      this.el.addEventListener('change', (e) => {
        if (!e.target.matches('[data-sel]')) return;
        const id = e.target.closest('.hl').dataset.id;
        if (e.target.checked) this.selected.add(id); else this.selected.delete(id);
        this._selCount();
      });
    }
    this.renderList();
  }

  _visible() {
    const f = this.filter;
    return this._data().lineups.filter((l) => (f.show === 'all' || l.interesting)
      && (!f.side || l.side === f.side) && (!f.to || l.toPlace === f.to) && (!f.tech || l.technique === f.tech)
      && (!f.player || l.players.includes(Number(f.player))));
  }

  renderList() {
    const list = this.el.querySelector('.smoke-list');
    if (!list) return;
    const d = this.demo;
    const vis = this._visible();
    list.innerHTML = vis.length ? vis.map((l) => `
      <div class="hl smoke ${l.side}" data-id="${esc(l.id)}">
        <input type="checkbox" ${this.selected.has(l.id) ? 'checked' : ''} data-sel title="Выбрать для записи">
        <div><div class="title">${esc(l.title)}</div>
          <div class="meta">Раунд ${l.rounds.join(', ')} · ${esc(l.playerNames.join(', '))} · ${fmtTime((l.release - d.startTick) / d.tickRate)}</div></div>
        <div class="score" title="Насколько интересен лайнап">${l.score}</div>
        <div class="tags">${l.tags.map((t, i) => `<span class="tag ${i === 0 && /джамп|прыж/.test(t) ? 'big' : ''}">${esc(t)}</span>`).join('')}</div>
        <div class="actions">
          <button class="btn small" data-act="replay" title="Камера гранаты: прицел, полёт, раскрытие">▶ Повтор</button>
          <button class="btn small" data-act="rec1">● Записать</button>
          <button class="btn small" data-act="goto" title="Смотреть бросок глазами игрока">От лица</button>
          <button class="btn small" data-act="setpos" title="${esc(setposCommand(l))}">setpos</button>
        </div>
      </div>`).join('') : `<p class="muted">${this._data().throws.length ? 'Нет смоков под фильтр. Попробуйте «все смоки».' : 'В демо нет смоков.'}</p>`;
    this._selCount();
  }

  _selCount() {
    const btn = this.el.querySelector('[data-act=rec-sel]');
    if (btn) btn.textContent = `● Записать выбранные (${this.selected.size})`;
  }

  _onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.hl');
    const l = card ? this._data().lineups.find((x) => x.id === card.dataset.id) : null;
    switch (btn.dataset.act) {
      case 'replay': return this.replay(l);
      case 'rec1': return this.record([l]);
      case 'goto': {
        const v = this.viewer;
        v.setTick(l.release - 3 * this.demo.tickRate);
        v.setMode('pov', l.player);
        v.play();
        return;
      }
      case 'setpos': {
        const cmd = setposCommand(l);
        navigator.clipboard?.writeText(cmd).then(() => toast(`Скопировано: ${cmd}`), () => toast(cmd, 'info', 10000));
        return;
      }
      case 'rec-sel': return this.record(this._data().lineups.filter((x) => this.selected.has(x.id)));
      case 'sel-all':
        this._visible().forEach((x) => this.selected.add(x.id));
        return this.renderList();
      case 'sel-none':
        this.selected.clear();
        return this.renderList();
      default:
    }
  }

  replay(l) {
    this.el.querySelectorAll('.hl').forEach((c) => c.classList.toggle('active', c.dataset.id === l.id));
    const v = this.viewer;
    v.playUtility(new UtilityCam(this.demo, l, v.map?.raycaster() || null));
  }

  async record(list) {
    if (!list.length) { toast('Отметьте смоки для записи'); return; }
    const hp = this.app.highlightsPanel;
    const o = hp.opts;
    const [width, height] = RESOLUTIONS[o.res] || RESOLUTIONS['720p'];
    if (this.viewer.utilityCam) this.viewer.stopUtility();
    const directors = list.map((l) => new SmokeDirector(this.viewer, l, {
      fps: o.fps, width, height, hud: o.hud, sound: o.sound, keys: false, voice: o.voice,
    }));
    await hp._record(directors, (i, f) => `Смок ${i + 1}/${list.length}: ${list[i].title} — ${Math.round(f * 100)}%`);
  }
}

