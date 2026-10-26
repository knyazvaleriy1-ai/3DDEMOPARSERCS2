// Volumetric smokes, CS2 style: a cloud of voxels that fills the space around
// the grenade without leaking through walls (flood fill checked against the
// map mesh), grows out from the middle, can be shot through (bullets leave
// tunnels that close again) and blown open by an HE grenade for a moment.
// Everything is a function of the tick, so seeking and recorded clips agree.
import * as THREE from '../vendor/three.module.min.js';

const VOX = 26; // voxel spacing
const RADIUS = 150; // horizontal reach
const HEIGHT = 125; // above the grenade
const BELOW = 34; // below it (stairs, dips)
const MAX_VOXELS = 900;
const GROW_STEP = 0.05; // s per voxel step from the middle
const GROW_TIME = 0.45;
const HOLE_R = 21; // bullet tunnel radius
const HOLE_OPEN = 0.3; // s fully open
const HOLE_CLOSE = 1.6; // s to close after that
const HE_R = 230;
const HE_OPEN = 0.55;
const HE_CLOSE = 2.4;
export const SMOKE_REACH = Math.hypot(RADIUS, HEIGHT) + VOX;
export const HOLE_SECONDS = HOLE_OPEN + HOLE_CLOSE;
export const HE_SECONDS = HE_OPEN + 0.5 + HE_CLOSE;
export const HE_REACH = HE_R;

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class SmokeVolume {
  /**
   * ``smoke``: {start, end, pos: [x, y, z] (game coordinates)}; ``ray``: the
   * map's MeshRaycaster or null (then nothing blocks the smoke).
   */
  constructor(smoke, ray, geometry, material) {
    this.smoke = smoke;
    const [gx, gy, gz] = smoke.pos;
    const c = this.center = new THREE.Vector3(gx, gz + 18, -gy);
    const rand = rng(Math.round(gx * 7 + gy * 13 + gz * 3 + smoke.start));
    // Breadth-first fill from the middle over a VOX grid: a neighbour joins
    // when it is inside the dome and no wall lies between the two centres.
    const ri = Math.ceil(RADIUS / VOX), up = Math.ceil(HEIGHT / VOX), down = Math.ceil(BELOW / VOX);
    const span = 2 * ri + 1, layers = up + down + 1;
    const key = (i, j, k) => ((j + down) * span + (k + ri)) * span + (i + ri);
    const inside = (i, j, k) => {
      const h = (i * i + k * k) * (VOX * VOX) / (RADIUS * RADIUS);
      const v = j >= 0 ? (j * VOX) / HEIGHT : (-j * VOX) / BELOW;
      return Math.abs(i) <= ri && Math.abs(k) <= ri && j <= up && j >= -down && h + v * v <= 1;
    };
    const seen = new Uint8Array(span * span * layers);
    const cells = [[0, 0, 0, 0]];
    seen[key(0, 0, 0)] = 1;
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    for (let q = 0; q < cells.length && cells.length < MAX_VOXELS; q++) {
      const [i, j, k, depth] = cells[q];
      const ax = c.x + i * VOX, ay = c.y + j * VOX, az = c.z + k * VOX;
      for (const [di, dj, dk] of dirs) {
        const ni = i + di, nj = j + dj, nk = k + dk;
        if (!inside(ni, nj, nk)) continue;
        const id = key(ni, nj, nk);
        if (seen[id]) continue;
        seen[id] = 1;
        if (ray && ray.blocked(ax, ay, az, c.x + ni * VOX, c.y + nj * VOX, c.z + nk * VOX)) continue;
        cells.push([ni, nj, nk, depth + 1]);
        if (cells.length >= MAX_VOXELS) break;
      }
    }
    const n = this.count = cells.length;
    this.local = new Float32Array(n * 3); // voxel centres relative to `center`
    this.size = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.fadeAt = new Float32Array(n);
    this.cut = new Float32Array(n);
    const color = new THREE.Color();
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.position.copy(c);
    const m = new THREE.Matrix4();
    for (let v = 0; v < n; v++) {
      const [i, j, k, depth] = cells[v];
      this.local[v * 3] = i * VOX + (rand() - 0.5) * 10;
      this.local[v * 3 + 1] = j * VOX + (rand() - 0.5) * 8;
      this.local[v * 3 + 2] = k * VOX + (rand() - 0.5) * 10;
      this.size[v] = VOX * (0.8 + rand() * 0.38);
      this.depth[v] = depth + rand() * 0.6;
      this.fadeAt[v] = rand();
      const shade = 0.86 + rand() * 0.14 - Math.max(0, -j) * 0.04;
      this.mesh.setColorAt(v, color.setRGB(0.74 * shade, 0.76 * shade, 0.8 * shade));
      m.makeScale(this.size[v], this.size[v], this.size[v]).setPosition(this.local[v * 3], this.local[v * 3 + 1], this.local[v * 3 + 2]);
      this.mesh.setMatrixAt(v, m);
    }
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = false;
    this.holes = new Map(); // shot index -> {idx, w}
    this._m = m;
  }

  /**
   * Show the smoke at ``tick``. ``shots``: [{key, tick, o, d, len}] bullets
   * (three.js coordinates) fired recently; ``hes``: HE detonations
   * {tick, pos: game coordinates} nearby.
   */
  update(tick, rate, shots, hes) {
    const s = this.smoke;
    const age = (tick - s.start) / rate;
    const left = (s.end - tick) / rate;
    const cut = this.cut;
    cut.fill(1);
    for (const sh of shots) {
      const a = (tick - sh.tick) / rate;
      if (a < 0 || a > HOLE_SECONDS || sh.tick < s.start) continue;
      const hole = this._hole(sh);
      const open = a < HOLE_OPEN ? 0 : smooth((a - HOLE_OPEN) / HOLE_CLOSE);
      for (let n = 0; n < hole.idx.length; n++) {
        const v = hole.idx[n];
        const f = open + (1 - open) * hole.w[n];
        if (f < cut[v]) cut[v] = f;
      }
    }
    const c = this.center;
    for (const he of hes) {
      const a = (tick - he.tick) / rate;
      if (a < 0 || a > HE_SECONDS || he.tick < s.start) continue;
      const hx = he.pos[0] - c.x, hy = he.pos[2] + 16 - c.y, hz = -he.pos[1] - c.z;
      for (let v = 0; v < this.count; v++) {
        const dx = this.local[v * 3] - hx, dy = this.local[v * 3 + 1] - hy, dz = this.local[v * 3 + 2] - hz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= HE_R) continue;
        const near = 1 - dist / HE_R;
        // The middle stays open longest; the edge of the blast only thins.
        const f = Math.min(1, smooth((a - HE_OPEN - near * 0.5) / HE_CLOSE) + (near < 0.2 ? (0.2 - near) * 4 : 0));
        if (f < cut[v]) cut[v] = f;
      }
    }
    const m = this._m;
    for (let v = 0; v < this.count; v++) {
      const grow = smooth((age - this.depth[v] * GROW_STEP) / GROW_TIME);
      const fade = smooth((left - this.fadeAt[v] * 1.2) / 0.8);
      const k = this.size[v] * grow * fade * cut[v];
      m.makeScale(k, k * 0.92, k).setPosition(this.local[v * 3], this.local[v * 3 + 1], this.local[v * 3 + 2]);
      this.mesh.setMatrixAt(v, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Voxels a bullet passes through (weight 0) or grazes (0..1). */
  _hole(sh) {
    let hole = this.holes.get(sh.key);
    if (hole) return hole;
    const c = this.center;
    const ox = sh.o[0] - c.x, oy = sh.o[1] - c.y, oz = sh.o[2] - c.z;
    const [dx, dy, dz] = sh.d;
    const idx = [], w = [];
    const reach = HOLE_R * 1.7;
    for (let v = 0; v < this.count; v++) {
      const px = this.local[v * 3] - ox, py = this.local[v * 3 + 1] - oy, pz = this.local[v * 3 + 2] - oz;
      const t = Math.max(0, Math.min(sh.len, px * dx + py * dy + pz * dz));
      const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
      const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (dist >= reach) continue;
      idx.push(v);
      w.push(dist <= HOLE_R ? 0 : (dist - HOLE_R) / (reach - HOLE_R));
    }
    hole = { idx: Uint16Array.from(idx), w: Float32Array.from(w) };
    this.holes.set(sh.key, hole);
    return hole;
  }

  /** Does a bullet from ``o`` along ``d`` for ``len`` units pass near this smoke? */
  near(o, d, len) {
    const c = this.center;
    const px = c.x - o[0], py = c.y - o[1], pz = c.z - o[2];
    const t = Math.max(0, Math.min(len, px * d[0] + py * d[1] + pz * d[2]));
    const ex = px - d[0] * t, ey = py - d[1] * t, ez = pz - d[2] * t;
    return ex * ex + ey * ey + ez * ez < SMOKE_REACH * SMOKE_REACH;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
