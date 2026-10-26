// Where each shot went: from the shooter's eye along their aim to the player
// it hurt, or to the first wall (ray cast against the map mesh). Feeds the
// tracers, bullet holes on walls and the tunnels bullets leave in smokes.
// Demos don't record impacts (bullet_impact isn't broadcast to GOTV) and the
// aim excludes recoil, so sprays land where the crosshair was.
import * as THREE from '../vendor/three.module.min.js';
import { PlayerState } from './demo.js';
import { PlayersView } from './players.js';
import { firesBullets } from './util.js';

const MAX_RANGE = 8192;
const OPEN_RANGE = 4000; // tracer length for shots into the sky

export class ShotImpacts {
  /** ``getRay`` returns the map's MeshRaycaster (or null). */
  constructor(demo, getRay) {
    this.demo = demo;
    this.getRay = getRay;
    this.cache = new Map();
    this._st = new PlayerState();
    this._vs = new PlayerState();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._hit = {};
  }

  /**
   * Shot ``i`` of demo.shots in three.js coordinates: {o: [x,y,z], d: [x,y,z],
   * len (to where the bullet stopped), wall: {t, n: [x,y,z]} | null (first
   * wall hit, also for wallbangs), player: victim index or -1}; null for
   * shots without bullets (knife, grenades) or from a dead player.
   */
  get(i) {
    let r = this.cache.get(i);
    if (r !== undefined) return r;
    r = this._compute(i);
    this.cache.set(i, r);
    return r;
  }

  _compute(i) {
    const d = this.demo;
    const [t, p, weapon] = d.shots[i];
    if (!firesBullets(weapon)) return null;
    const st = d.state(p, t, this._st);
    if (!st.alive) return null;
    const eye = PlayersView.eye(st, this._eye);
    const dir = PlayersView.viewDir(st, this._dir);
    // The victim, if this shot hurt someone (same shooter within 2 ticks).
    let victim = -1, len = Infinity;
    const hurts = d.hurts;
    for (let j = lowerBound(hurts, t - 2); j < hurts.length && hurts[j][0] <= t + 2; j++) {
      const h = hurts[j];
      if (h[1] !== p) continue;
      const vs = d.state(h[2], t, this._vs);
      len = Math.hypot(vs.x - st.x, vs.y - st.y, vs.z + 40 - (st.z + 58));
      victim = h[2];
      break;
    }
    const ray = this.getRay();
    let wall = null;
    if (ray) {
      const hit = ray.cast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, MAX_RANGE, this._hit);
      if (hit && (victim < 0 || hit.t < len)) wall = { t: hit.t, n: [hit.nx, hit.ny, hit.nz] };
    }
    if (victim < 0) len = wall ? wall.t : OPEN_RANGE;
    return { tick: t, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], len, wall, player: victim };
  }
}

// First index whose tick (element [0]) is >= tick.
export function lowerBound(list, tick) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] < tick) lo = mid + 1; else hi = mid;
  }
  return lo;
}
