// Grenades in flight, smokes, fires, explosions, bullet tracers, bullet holes
// and the bomb.
import * as THREE from '../vendor/three.module.min.js';
import { ShotImpacts } from './bullets.js';
import { HE_REACH, HE_SECONDS, HOLE_SECONDS, SMOKE_REACH, SmokeVolume } from './smoke.js';

const GRENADE_COLORS = {
  smoke: 0xd8dde4,
  flash: 0xffffff,
  he: 0xff5a36,
  molotov: 0xff9a1f,
  decoy: 0x9aa3ad,
};

const MAX_DECALS = 800; // bullet holes kept per round (CS2 keeps a few hundred)
const MAX_SMOKES = 24; // smoke volumes kept built (seeking back reuses them)

// First index whose tick (element [0]) is >= tick; lists are sorted by tick.
function lowerBound(list, tick) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] < tick) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A bullet hole: dark core, scorched rim, a few cracks. */
function holeTexture() {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(8,8,8,1)');
  g.addColorStop(0.28, 'rgba(18,16,14,0.95)');
  g.addColorStop(0.42, 'rgba(60,54,46,0.6)');
  g.addColorStop(1, 'rgba(60,54,46,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  c.strokeStyle = 'rgba(20,18,16,0.55)';
  c.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4 * Math.sin(i * 7);
    c.beginPath();
    c.moveTo(32 + Math.cos(a) * 9, 32 + Math.sin(a) * 9);
    c.lineTo(32 + Math.cos(a + 0.2) * 19, 32 + Math.sin(a + 0.2) * 19);
    c.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function pool(factory) {
  const items = [];
  let used = 0;
  return {
    begin() { used = 0; },
    next() {
      if (used >= items.length) items.push(factory());
      const it = items[used++];
      it.visible = true;
      return it;
    },
    end() { for (let i = used; i < items.length; i++) items[i].visible = false; },
  };
}

export class EffectsView {
  /** ``getRay`` returns the map's MeshRaycaster (null without a map mesh). */
  constructor(scene, demo, getRay = () => null) {
    this.demo = demo;
    this.rate = demo.tickRate;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.options = { grenades: true, tracers: true, holes: true };
    this.getRay = getRay;
    this.impacts = new ShotImpacts(demo, getRay);
    const g = this.group;

    // Smokes: voxel volumes (smoke.js), built when they first show up.
    this.smokeGeo = new THREE.IcosahedronGeometry(1, 1);
    this.smokeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.volumes = new Map(); // smoke -> SmokeVolume

    // Bullet holes on walls.
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    this.decals = new THREE.InstancedMesh(decalGeo, new THREE.MeshBasicMaterial({
      map: holeTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }), MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;
    this._decalKey = '';
    g.add(this.decals);

    const discGeo = new THREE.CircleGeometry(1, 40);
    discGeo.rotateX(-Math.PI / 2);
    this.fires = pool(() => {
      const grp = new THREE.Group();
      const outer = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
        color: 0xff5a00, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const inner = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
        color: 0xffc040, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      inner.position.y = 1;
      grp.add(outer, inner);
      grp.userData = { outer, inner };
      g.add(grp);
      return grp;
    });

    const ballGeo = new THREE.SphereGeometry(1, 20, 14);
    this.bursts = pool(() => {
      const m = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      g.add(m);
      return m;
    });

    this.nades = pool(() => {
      const m = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      m.scale.setScalar(4);
      g.add(m);
      return m;
    });

    this.trails = pool(() => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 512), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }));
      line.frustumCulled = false;
      g.add(line);
      return line;
    });

    const MAX_TRACERS = 96;
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    tgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    this.tracers = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.tracers.frustumCulled = false;
    this.maxTracers = MAX_TRACERS;
    g.add(this.tracers);

    this.bomb = new THREE.Mesh(new THREE.BoxGeometry(14, 7, 10), new THREE.MeshLambertMaterial({ color: 0xb02020 }));
    this.bombLight = new THREE.Mesh(new THREE.SphereGeometry(3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    this.bombLight.position.y = 6;
    this.bomb.add(this.bombLight);
    this.bombRing = new THREE.Mesh(new THREE.RingGeometry(26, 30, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.6, depthWrite: false }));
    this.bomb.add(this.bombRing);
    g.add(this.bomb);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._z = new THREE.Vector3(0, 0, 1);
    this._s = new THREE.Vector3();
  }

  update(tick, ctx) {
    const rate = this.rate;
    const fx = this.demo.effects;
    const roundStart = ctx.roundStart ?? -Infinity;

    this._smokes(tick, roundStart);

    // Molotov / incendiary fires
    this.fires.begin();
    for (const f of fx.infernos || []) {
      if (tick < f.start || tick > f.end || f.start < roundStart) continue;
      const age = (tick - f.start) / rate;
      const left = (f.end - tick) / rate;
      const r = 40 + 95 * Math.min(1, age / 0.8);
      const flicker = 0.85 + 0.15 * Math.sin(tick * 0.9 + f.start);
      const fade = Math.min(1, left / 0.8);
      const grp = this.fires.next();
      grp.position.set(f.pos[0], f.pos[2] + 3, -f.pos[1]);
      grp.userData.outer.scale.setScalar(r);
      grp.userData.inner.scale.setScalar(r * 0.6 * flicker);
      grp.userData.outer.material.opacity = 0.5 * fade * flicker;
      grp.userData.inner.material.opacity = 0.55 * fade;
    }
    this.fires.end();

    // Flash / HE bursts
    this.bursts.begin();
    const burst = (list, color, size, life) => {
      for (const b of list || []) {
        const age = (tick - b.tick) / rate;
        if (age < 0 || age > life) continue;
        const m = this.bursts.next();
        const k = age / life;
        m.material.color.setHex(color);
        m.material.opacity = (1 - k) * 0.9;
        m.scale.setScalar(size * (0.3 + 0.7 * Math.sqrt(k)));
        m.position.set(b.pos[0], b.pos[2], -b.pos[1]);
      }
    };
    burst(fx.flashes, 0xffffff, 110, 0.35);
    burst(fx.hes, 0xff6a2a, 170, 0.55);
    // Dust where bullets hit walls.
    if (this.options.tracers || this.options.holes) {
      const shots = this.demo.shots;
      for (let i = lowerBound(shots, tick - 0.16 * rate); i < shots.length && shots[i][0] <= tick; i++) {
        const imp = this.impacts.get(i);
        if (!imp || !imp.wall) continue;
        const k = (tick - imp.tick) / (0.16 * rate);
        const m = this.bursts.next();
        m.material.color.setHex(0xb8b0a0);
        m.material.opacity = (1 - k) * 0.7;
        m.scale.setScalar(3 + 9 * Math.sqrt(k));
        const t = imp.wall.t - 2;
        m.position.set(imp.o[0] + imp.d[0] * t, imp.o[1] + imp.d[1] * t, imp.o[2] + imp.d[2] * t);
      }
    }
    this.bursts.end();

    // Grenades in flight (+ fading trail)
    this.nades.begin();
    this.trails.begin();
    if (this.options.grenades) {
      for (const gr of this.demo.grenades) {
        const t0 = gr.ticks[0];
        const t1 = gr.ticks[gr.ticks.length - 1];
        if (tick < t0 || tick > t1 + rate * 1.5) continue;
        if (t1 < roundStart) continue;
        const color = GRENADE_COLORS[gr.type] ?? 0xffffff;
        const n = gr.ticks.length;
        let idx = n - 1;
        for (let i = 0; i < n; i++) { if (gr.ticks[i] > tick) { idx = i - 1; break; } }
        if (idx < 0) continue;
        const line = this.trails.next();
        const arr = line.geometry.attributes.position.array;
        const count = Math.min(idx + 1, 510);
        const startI = idx + 1 - count;
        for (let i = 0; i < count; i++) {
          const j = (startI + i) * 3;
          arr[i * 3] = gr.pts[j];
          arr[i * 3 + 1] = gr.pts[j + 2];
          arr[i * 3 + 2] = -gr.pts[j + 1];
        }
        let cx = gr.pts[idx * 3], cy = gr.pts[idx * 3 + 1], cz = gr.pts[idx * 3 + 2];
        if (tick <= t1 && idx + 1 < n) {
          const ta = gr.ticks[idx], tb = gr.ticks[idx + 1];
          const t = (tick - ta) / Math.max(1, tb - ta);
          const j = (idx + 1) * 3;
          cx += (gr.pts[j] - cx) * t; cy += (gr.pts[j + 1] - cy) * t; cz += (gr.pts[j + 2] - cz) * t;
          arr[count * 3] = cx; arr[count * 3 + 1] = cz; arr[count * 3 + 2] = -cy;
          line.geometry.setDrawRange(0, count + 1);
        } else {
          line.geometry.setDrawRange(0, count);
        }
        line.geometry.attributes.position.needsUpdate = true;
        line.material.color.setHex(color);
        line.material.opacity = tick > t1 ? 0.8 * (1 - (tick - t1) / (rate * 1.5)) : 0.8;
        if (tick <= t1) {
          const m = this.nades.next();
          m.material.color.setHex(color);
          m.position.set(cx, cz, -cy);
        }
      }
    }
    this.nades.end();
    this.trails.end();

    this._tracers(tick);
    this._decals(tick, roundStart, ctx.cut ?? 1e6);
    this._bomb(tick, ctx);
  }

  /** Smoke volumes of this round, with bullet tunnels and HE blowouts. */
  _smokes(tick, roundStart) {
    const rate = this.rate;
    const fx = this.demo.effects;
    let shots = null;
    const live = new Set();
    for (const s of fx.smokes || []) {
      if (tick < s.start || tick > s.end || s.start < roundStart) continue;
      live.add(s);
      let vol = this.volumes.get(s);
      if (!vol) {
        vol = new SmokeVolume(s, this.getRay(), this.smokeGeo, this.smokeMat);
        this.group.add(vol.mesh);
        this.volumes.set(s, vol);
      }
      if (!shots) shots = this._recentShots(tick, HOLE_SECONDS);
      const near = shots.filter((sh) => vol.near(sh.o, sh.d, sh.len));
      const c = vol.center;
      const hes = (fx.hes || []).filter((h) => h.tick <= tick && h.tick >= tick - HE_SECONDS * rate
        && Math.hypot(h.pos[0] - c.x, h.pos[2] - c.y, -h.pos[1] - c.z) < SMOKE_REACH + HE_REACH);
      vol.update(tick, rate, near, hes);
      vol.mesh.visible = true;
    }
    for (const [s, vol] of this.volumes) {
      if (live.has(s)) continue;
      vol.mesh.visible = false;
      if (this.volumes.size > MAX_SMOKES) {
        vol.dispose();
        this.volumes.delete(s);
      }
    }
  }

  /** Bullets fired in the last ``seconds``: [{key, tick, o, d, len}]. */
  _recentShots(tick, seconds) {
    const shots = this.demo.shots;
    const out = [];
    for (let i = lowerBound(shots, tick - seconds * this.rate); i < shots.length && shots[i][0] <= tick; i++) {
      const imp = this.impacts.get(i);
      if (imp) out.push({ key: i, tick: imp.tick, o: imp.o, d: imp.d, len: imp.len });
    }
    return out;
  }

  /** Bullet holes from this round's shots so far (above the roof cut hidden). */
  _decals(tick, roundStart, cut) {
    const shots = this.demo.shots;
    const from = lowerBound(shots, roundStart);
    const to = lowerBound(shots, tick + 1e-6);
    const key = this.options.holes ? `${from}:${to}:${Math.round(cut)}` : '';
    if (key === this._decalKey) return;
    this._decalKey = key;
    let n = 0;
    if (this.options.holes) {
      const m = this._m, q = this._q, p = this._v1, nrm = this._v2;
      for (let i = to - 1; i >= from && n < MAX_DECALS; i--) {
        const imp = this.impacts.get(i);
        if (!imp || !imp.wall) continue;
        const t = imp.wall.t;
        p.set(imp.o[0] + imp.d[0] * t, imp.o[1] + imp.d[1] * t, imp.o[2] + imp.d[2] * t);
        if (p.y > cut) continue;
        nrm.fromArray(imp.wall.n);
        p.addScaledVector(nrm, 0.25);
        q.setFromUnitVectors(this._z, nrm);
        const size = 4 + (i % 5) * 0.35;
        this.decals.setMatrixAt(n++, m.compose(p, q, this._s.set(size, size, 1)));
      }
    }
    this.decals.count = n;
    this.decals.instanceMatrix.needsUpdate = true;
  }

  _tracers(tick) {
    const geo = this.tracers.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    let n = 0;
    if (this.options.tracers) {
      const life = 0.09 * this.rate;
      const shots = this.demo.shots;
      const lo = lowerBound(shots, tick - life);
      const eye = this._v1, dir = this._v2;
      for (let i = lo; i < shots.length && n < this.maxTracers; i++) {
        const t = shots[i][0];
        if (t > tick) break;
        const imp = this.impacts.get(i);
        if (!imp) continue;
        eye.fromArray(imp.o);
        dir.fromArray(imp.d);
        eye.y -= 6;
        const len = imp.len;
        const k = 1 - (tick - t) / life;
        const o = n * 6;
        pos[o] = eye.x + dir.x * 20; pos[o + 1] = eye.y + dir.y * 20; pos[o + 2] = eye.z + dir.z * 20;
        pos[o + 3] = eye.x + dir.x * len; pos[o + 4] = eye.y + dir.y * len; pos[o + 5] = eye.z + dir.z * len;
        col[o] = 1.0 * k; col[o + 1] = 0.9 * k; col[o + 2] = 0.5 * k;
        col[o + 3] = 0.6 * k; col[o + 4] = 0.45 * k; col[o + 5] = 0.15 * k;
        n++;
      }
    }
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  _bomb(tick, ctx) {
    const b = ctx.bomb;
    this.bomb.visible = false;
    if (!b || b.state === 'carried' || !b.pos) return;
    if (b.state === 'exploded' && tick - b.endTick > this.rate * 0.5) return;
    this.bomb.visible = true;
    this.bomb.position.set(b.pos[0], b.pos[2] + 4, -b.pos[1]);
    const planted = b.state === 'planted';
    this.bombRing.visible = planted;
    if (planted) {
      const elapsed = (tick - b.plantTick) / this.rate;
      const period = elapsed > 30 ? 0.25 : elapsed > 20 ? 0.5 : 1.0;
      this.bombLight.visible = (elapsed % period) < period * 0.35;
      this.bombRing.scale.setScalar(1 + (elapsed % 1) * 0.6);
      this.bombRing.material.opacity = 0.6 * (1 - (elapsed % 1));
    } else {
      this.bombLight.visible = false;
    }
  }
}
