// Smoke lineups. Every smoke of the demo: where it was thrown from and how
// (jumpthrow, on the run, crouched; left / right / both mouse buttons), where
// it bloomed, how far and how long it flew, and whether the thrower could see
// the spot at all. The same throw repeated over rounds (or by both teams) is
// one lineup. Lineups are scored so the interesting ones come first: long,
// blind, practised throws over the smokes thrown at one's own feet.
import { FLAG } from './demo.js';

export const THROW_LABELS = {
  jump: 'джампсроу', runjump: 'разбег + прыжок', run: 'с бега', walk: 'шагом', crouch: 'присев', stand: 'стоя',
};
export const CLICK_LABELS = { left: 'ЛКМ', right: 'ПКМ', both: 'ЛКМ+ПКМ' };

const MATCH_DIST = 180; // units between a grenade's last point and its smoke
const SAME_FROM = 48; // same lineup: thrown from within this many units...
const SAME_TO = 150; // ...landing within this many...
const SAME_ANGLE = 5; // ...aiming within this many degrees

/** "TSpawn" -> "T Spawn", "BombsiteA" -> "Bombsite A". */
export function placeName(raw) {
  return String(raw || '').replace(/([a-z])of([A-Z])/g, '$1 of $2').replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/^(CT|T)([A-Z])/, '$1 $2');
}

function frameAt(demo, tick) {
  return Math.min(demo.count - 1, Math.max(0, Math.floor((tick - demo.startTick) / demo.step)));
}

function airborne(demo, p, f) {
  return (demo.u8[(f * demo.P + p) * demo.U + 2] & FLAG.AIRBORNE) !== 0;
}

/** Horizontal speed (units/s) of ``p`` around frame ``f``. */
function speedAt(demo, p, f) {
  const a = Math.max(0, f - 2), b = Math.min(demo.count - 1, f + 1);
  if (b <= a) return 0;
  const i = (a * demo.P + p) * 3, j = (b * demo.P + p) * 3;
  const d = Math.hypot(demo.pos[j] - demo.pos[i], demo.pos[j + 1] - demo.pos[i + 1]);
  return (d * demo.tickRate) / ((b - a) * demo.step);
}

/**
 * How ``p`` threw a grenade released at ``release``: {kind (THROW_LABELS),
 * click (CLICK_LABELS or null without key data), takeoff (tick the jump
 * started, or null)}.
 */
export function throwTechnique(demo, p, release) {
  const rate = demo.tickRate;
  const fr = frameAt(demo, release);
  // A jumpthrow bind releases the grenade and jumps on the same tick: the
  // player may only leave the ground a tick or two after the release.
  let takeoff = null;
  const lo = frameAt(demo, release - 0.6 * rate), hi = frameAt(demo, release + 0.12 * rate);
  for (let f = hi; f > lo; f--) {
    if (airborne(demo, p, f) && !airborne(demo, p, f - 1)) { takeoff = f; break; }
  }
  const inAir = airborne(demo, p, Math.min(demo.count - 1, fr + 1)) || airborne(demo, p, fr);
  const takeoffTick = takeoff !== null ? demo.startTick + takeoff * demo.step : null;
  const jumped = inAir && (takeoff !== null || airborne(demo, p, fr));
  const groundFrame = takeoff !== null ? takeoff - 1 : fr;
  const speed = speedAt(demo, p, groundFrame);
  const keys = demo.keys ? demo.keysAt(p, release - 1) : null;
  const duck = demo.u8[(fr * demo.P + p) * demo.U + 4] / 255;
  let kind;
  if (jumped) kind = speed > 130 ? 'runjump' : 'jump';
  else if (speed > 135) kind = 'run';
  else if (speed > 30) kind = duck > 0.5 ? 'crouch' : 'walk';
  else kind = duck > 0.5 || keys?.CTRL ? 'crouch' : 'stand';
  // Which buttons were held while winding up (left: far throw, right: lob, both: medium).
  let click = null;
  if (demo.keys && demo.keysKnown.has('LMB')) {
    let l = false, r = false;
    const out = {};
    for (let f = frameAt(demo, release - 1.2 * rate); f <= fr; f++) {
      demo.keysAt(p, demo.startTick + f * demo.step, out);
      l ||= out.LMB;
      r ||= out.RMB;
    }
    click = l && r ? 'both' : r ? 'right' : 'left';
  }
  return { kind, click, takeoff: takeoffTick, speed: Math.round(speed) };
}

/** Name of the place around world point ``pos`` (from where players stood). */
export function placeAt(demo, pos) {
  if (!demo._placeGrid) {
    const grid = new Map();
    const stride = Math.max(1, Math.round(demo.tickRate / demo.step / 2)); // ~2 samples a second
    for (let f = 0; f < demo.count; f += stride) {
      for (let p = 0; p < demo.P; p++) {
        const u = (f * demo.P + p) * demo.U;
        if (!(demo.u8[u + 2] & FLAG.ALIVE) || !demo.u8[u + 5]) continue;
        const i = (f * demo.P + p) * 3;
        const x = demo.pos[i], y = demo.pos[i + 1];
        const key = `${Math.floor(x / 200)},${Math.floor(y / 200)}`;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        if (cell.length < 400) cell.push([x, y, demo.pos[i + 2], demo.u8[u + 5]]);
      }
    }
    demo._placeGrid = grid;
  }
  const cx = Math.floor(pos[0] / 200), cy = Math.floor(pos[1] / 200);
  let best = 0, bestD = 900;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (const [x, y, z, place] of demo._placeGrid.get(`${cx + dx},${cy + dy}`) || []) {
        const d = Math.hypot(x - pos[0], y - pos[1]) + Math.max(0, Math.abs(z - pos[2]) - 80) * 2;
        if (d < bestD) { bestD = d; best = place; }
      }
    }
  }
  return placeName(demo.places[best] || '');
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Smoke throws of the demo and the lineups they make, best first.
 * ``raycaster`` (map.js) tells whether the thrower could see where the smoke
 * landed. Returns {throws, lineups}; a lineup = {id, throws: [throw], ...the
 * first throw's fields, count, rounds, players, score, interesting, tags}.
 */
export function findSmokes(demo, { raycaster = null } = {}) {
  const key = raycaster ? 'ray' : 'plain';
  if (demo._smokes?.key === key) return demo._smokes;
  const rate = demo.tickRate;
  const effects = demo.effects?.smokes || [];
  const used = new Set();
  const st = demo.state(0, demo.startTick);
  const throws = [];
  demo.grenades.forEach((g, gi) => {
    if (g.type !== 'smoke' || !(g.thrower >= 0) || g.ticks.length < 3) return;
    const n = g.ticks.length;
    const lx = g.pts[n * 3 - 3], ly = g.pts[n * 3 - 2], lz = g.pts[n * 3 - 1];
    let smoke = -1, bestD = MATCH_DIST;
    effects.forEach((e, ei) => {
      if (used.has(ei) || e.start < g.ticks[0] || e.start > g.ticks[n - 1] + 3 * rate) return;
      const d = Math.hypot(e.pos[0] - lx, e.pos[1] - ly, e.pos[2] - lz) + (e.thrower === g.thrower ? 0 : 60);
      if (d < bestD) { smoke = ei; bestD = d; }
    });
    if (smoke < 0) return; // never bloomed (round over, extinguished in fire...)
    used.add(smoke);
    const e = effects[smoke];
    const release = g.ticks[0];
    const ri = demo.roundIndexAt(release);
    const round = demo.rounds[ri];
    if (round?.knife) return;
    demo.state(g.thrower, release - 1, st);
    if (!st.present || !st.alive) return;
    const tech = throwTechnique(demo, g.thrower, release);
    const aim = { pitch: +st.pitch.toFixed(2), yaw: +st.yaw.toFixed(2) };
    const at = [st.x, st.y, st.z];
    const fromPlace = placeName(st.place);
    const side = st.side;
    // Where to stand: on the ground where the jump started.
    if (tech.takeoff !== null) {
      demo.state(g.thrower, tech.takeoff - demo.step, st);
      at[0] = st.x; at[1] = st.y; at[2] = st.z;
    }
    const to = e.pos;
    const distance = Math.round(Math.hypot(to[0] - at[0], to[1] - at[1]));
    let path = 0;
    for (let i = 1; i < n && g.ticks[i] <= e.start; i++) {
      path += Math.hypot(g.pts[i * 3] - g.pts[i * 3 - 3], g.pts[i * 3 + 1] - g.pts[i * 3 - 2], g.pts[i * 3 + 2] - g.pts[i * 3 - 1]);
    }
    // Could the thrower see the spot? (three.js coordinates: x, z up, -y)
    const blind = raycaster
      ? raycaster.blocked(at[0], at[2] + 64, -at[1], to[0], to[2] + 40, -to[1])
      : null;
    throws.push({
      grenade: gi, smoke: smoke, player: g.thrower, side, round: ri, roundNum: round ? round.num : 0,
      release, land: e.start, end: e.end, from: at.map((v) => +v.toFixed(2)), to, aim,
      fromPlace, toPlace: placeAt(demo, to), technique: tech.kind, click: tech.click,
      takeoff: tech.takeoff, distance, path: Math.round(path), flight: +((e.start - release) / rate).toFixed(2),
      blind,
    });
  });

  // The same lineup thrown again (another round, the other team): one entry.
  const groups = [];
  for (const t of throws) {
    const same = groups.find((gr) => {
      const f = gr[0];
      return Math.hypot(f.from[0] - t.from[0], f.from[1] - t.from[1]) <= SAME_FROM && Math.abs(f.from[2] - t.from[2]) < 40
        && Math.hypot(f.to[0] - t.to[0], f.to[1] - t.to[1]) <= SAME_TO
        && angleDiff(f.aim.yaw, t.aim.yaw) <= SAME_ANGLE && Math.abs(f.aim.pitch - t.aim.pitch) <= SAME_ANGLE
        && (f.technique === 'jump' || f.technique === 'runjump') === (t.technique === 'jump' || t.technique === 'runjump');
    });
    if (same) same.push(t); else groups.push([t]);
  }
  const lineups = groups.map((list) => lineup(demo, list));
  lineups.sort((a, b) => b.score - a.score || a.release - b.release);
  demo._smokes = { key, throws, lineups };
  return demo._smokes;
}

function lineup(demo, list) {
  const t = list[0];
  const count = list.length;
  const jump = t.technique === 'jump' || t.technique === 'runjump';
  // A lineup: thrown from afar at a spot, not at one's feet or across a room.
  const interesting = t.distance >= 600 && (t.blind === true || jump || count > 1 || t.distance >= 1400);
  let score = Math.min(45, t.distance / 40) + (t.blind ? 20 : 0) + (jump ? 10 : 0)
    + Math.min(16, (count - 1) * 8) + (t.flight >= 2 ? 5 : 0);
  if (!interesting) score *= 0.4;
  const tags = [THROW_LABELS[t.technique]];
  if (t.click) tags.push(CLICK_LABELS[t.click]);
  tags.push(`${t.distance} u`, `${t.flight.toFixed(1)} с`);
  if (t.blind) tags.push('вслепую');
  if (count > 1) tags.push(`×${count}`);
  const players = [...new Set(list.map((x) => x.player))];
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x';
  return {
    ...t,
    id: `smoke-r${String(t.roundNum).padStart(2, '0')}-${slug(t.toPlace)}-${slug(t.fromPlace)}-${t.grenade}`,
    throws: list, count, rounds: [...new Set(list.map((x) => x.roundNum))], players,
    playerNames: players.map((p) => demo.players[p]?.name || ''),
    title: `${t.toPlace || 'Смок'} ← ${t.fromPlace || '?'}`,
    score: Math.round(score), interesting, tags,
  };
}

/** CS2 console line that puts you where the lineup was thrown from (sv_cheats 1). */
export function setposCommand(l) {
  const [x, y, z] = l.from;
  return `setpos ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}; setang ${l.aim.pitch.toFixed(2)} ${l.aim.yaw.toFixed(2)} 0`;
}
