// Parsed demo in memory: metadata + packed frames, with interpolated lookups.
import { lerp, lerpAngle } from './util.js';

export const FLAG = { PRESENT: 1, ALIVE: 2, CT: 4, SCOPED: 8, DEFUSING: 16, HELMET: 32, DEFUSER: 64 };
const TELEPORT = 260; // units per sample: anything faster is a respawn/teleport

export class PlayerState {
  constructor() {
    this.present = false; this.alive = false; this.side = 'T';
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.pitch = 0;
    this.hp = 0; this.armor = 0; this.flags = 0; this.weapon = ''; this.duck = 0;
    this.money = 0; this.place = ''; this.scoped = false; this.defusing = false;
    this.helmet = false; this.defuser = false;
  }
}

export class DemoData {
  constructor(meta, buffer) {
    this.meta = meta;
    const f = meta.frames;
    this.startTick = f.startTick;
    this.endTick = f.endTick;
    this.step = f.step;
    this.count = f.count;
    this.P = f.players;
    this.tickRate = meta.tickRate || 64;
    this.U = f.u8Fields.length;
    const sec = Object.fromEntries(f.sections.map((s) => [s.name, s]));
    this.pos = new Float32Array(buffer, sec.pos.offset, sec.pos.bytes / 4);
    this.ang = new Int16Array(buffer, sec.ang.offset, sec.ang.bytes / 2);
    this.u8 = new Uint8Array(buffer, sec.u8.offset, sec.u8.bytes);
    this.money = new Uint16Array(buffer, sec.money.offset, sec.money.bytes / 2);
    this.players = meta.players;
    this.rounds = meta.rounds;
    this.kills = meta.kills;
    this.highlights = meta.highlights || [];
    this.shots = meta.shots || [];
    this.hurts = meta.hurts || [];
    this.blinds = meta.blinds || [];
    this.grenades = meta.grenades || [];
    this.effects = meta.effects || {};
    this.bomb = meta.bomb || [];
    this.scoreboard = meta.scoreboard || [];
    this.weapons = meta.weapons || [''];
    this.places = meta.places || [''];
  }

  get duration() {
    return (this.endTick - this.startTick) / this.tickRate;
  }

  secondsAt(tick) {
    return (tick - this.startTick) / this.tickRate;
  }

  // Raw sample accessors -------------------------------------------------------

  _flags(fi, p) { return this.u8[(fi * this.P + p) * this.U + 2]; }

  /** Interpolated state of player ``p`` at fractional ``tick``. */
  state(p, tick, out = new PlayerState()) {
    let f = (tick - this.startTick) / this.step;
    if (f < 0) f = 0;
    if (f > this.count - 1) f = this.count - 1;
    let i0 = Math.floor(f);
    let i1 = Math.min(i0 + 1, this.count - 1);
    let t = f - i0;
    const P = this.P, U = this.U;
    const b0 = (i0 * P + p), b1 = (i1 * P + p);
    const fl0 = this.u8[b0 * U + 2], fl1 = this.u8[b1 * U + 2];
    // Only blend between samples that agree on presence / life / side and
    // aren't a teleport; otherwise snap to the nearer sample.
    let blend = (fl0 & 7) === (fl1 & 7);
    if (blend) {
      const dx = this.pos[b1 * 3] - this.pos[b0 * 3];
      const dy = this.pos[b1 * 3 + 1] - this.pos[b0 * 3 + 1];
      if (dx * dx + dy * dy > TELEPORT * TELEPORT) blend = false;
    }
    if (!blend) {
      t = 0;
      if (f - i0 > 0.5) i0 = i1;
    }
    const a = i0 * P + p, b = i1 * P + p;
    const flags = this.u8[a * U + 2];
    out.flags = flags;
    out.present = !!(flags & FLAG.PRESENT);
    out.alive = !!(flags & FLAG.ALIVE);
    out.side = flags & FLAG.CT ? 'CT' : 'T';
    out.scoped = !!(flags & FLAG.SCOPED);
    out.defusing = !!(flags & FLAG.DEFUSING);
    out.helmet = !!(flags & FLAG.HELMET);
    out.defuser = !!(flags & FLAG.DEFUSER);
    out.x = lerp(this.pos[a * 3], this.pos[b * 3], t);
    out.y = lerp(this.pos[a * 3 + 1], this.pos[b * 3 + 1], t);
    out.z = lerp(this.pos[a * 3 + 2], this.pos[b * 3 + 2], t);
    out.yaw = lerpAngle(this.ang[a * 2] / 100, this.ang[b * 2] / 100, t);
    out.pitch = lerp(this.ang[a * 2 + 1] / 100, this.ang[b * 2 + 1] / 100, t);
    out.hp = this.u8[a * U];
    out.armor = this.u8[a * U + 1];
    out.weapon = this.weapons[this.u8[a * U + 3]] || '';
    out.duck = lerp(this.u8[a * U + 4], this.u8[b * U + 4], t) / 255;
    out.place = this.places[this.u8[a * U + 5]] || '';
    out.money = this.money[a];
    return out;
  }

  // Rounds, score, stats --------------------------------------------------------

  roundIndexAt(tick) {
    let idx = 0;
    for (let i = 0; i < this.rounds.length; i++) {
      if (this.rounds[i].start <= tick) idx = i;
      else break;
    }
    return idx;
  }

  /** Team score as of ``tick`` keyed by the side each team is on right now. */
  scoreAt(tick, states) {
    let snap = null;
    for (const s of this.scoreboard) {
      if (s.tick <= tick) snap = s;
      else break;
    }
    const score = { T: 0, CT: 0 };
    if (!snap) return score;
    for (let p = 0; p < this.P; p++) {
      const st = states[p];
      const stats = snap.stats[p];
      if (!st || !st.present || !stats) continue;
      score[st.side] = Math.max(score[st.side], stats[4]);
    }
    return score;
  }

  /** K/D/A counted from events up to ``tick``; damage from the last snapshot. */
  statsAt(tick) {
    const out = this.players.map(() => ({ k: 0, d: 0, a: 0, adr: 0 }));
    for (const k of this.kills) {
      if (k.tick > tick) break;
      if (k.attacker >= 0 && k.attacker !== k.victim) out[k.attacker].k += k.teamkill ? -1 : 1;
      out[k.victim].d += 1;
      if (k.assister >= 0) out[k.assister].a += 1;
    }
    let snap = null, roundsPlayed = 0;
    for (const s of this.scoreboard) {
      if (s.tick <= tick) { snap = s; roundsPlayed++; } else break;
    }
    if (snap) {
      for (let p = 0; p < this.P; p++) {
        const s = snap.stats[p];
        if (s) out[p].adr = Math.round(s[3] / Math.max(1, roundsPlayed));
      }
    }
    return out;
  }

  /** Bomb state at ``tick``: {state, player, pos, plantTick} or null. */
  bombAt(tick) {
    const r = this.rounds[this.roundIndexAt(tick)];
    let state = null;
    for (const e of this.bomb) {
      if (e.tick > tick) break;
      if (r && e.tick < r.start) continue;
      switch (e.type) {
        case 'pickup': state = { state: 'carried', player: e.player }; break;
        case 'drop': state = { state: 'dropped', pos: e.pos }; break;
        case 'plant': state = { state: 'planted', pos: e.pos, plantTick: e.tick, place: e.place }; break;
        case 'defuse': state = { ...(state || {}), state: 'defused', endTick: e.tick }; break;
        case 'explode': state = { ...(state || {}), state: 'exploded', endTick: e.tick }; break;
        default: break;
      }
    }
    return state;
  }

  killsBetween(t0, t1) {
    const out = [];
    for (const k of this.kills) {
      if (k.tick > t1) break;
      if (k.tick >= t0) out.push(k);
    }
    return out;
  }

  /** Remaining flash blindness (0..1) for ``p`` at ``tick``. */
  blindAt(p, tick) {
    let best = 0;
    for (const b of this.blinds) {
      if (b[0] > tick) break;
      if (b[1] !== p) continue;
      const elapsed = (tick - b[0]) / this.tickRate;
      const dur = b[3];
      if (elapsed < dur) {
        const v = elapsed < dur * 0.6 ? 1 : 1 - (elapsed - dur * 0.6) / (dur * 0.4);
        best = Math.max(best, v * Math.min(1, dur / 1.5 + 0.35));
      }
    }
    return best;
  }
}

export async function loadDemo(id, onProgress) {
  const meta = await fetch(`/api/demos/${id}/meta`).then((r) => {
    if (!r.ok) throw new Error('Не удалось загрузить данные демо');
    return r.json();
  });
  onProgress?.(0.3, 'Загрузка кадров');
  const res = await fetch(`/api/demos/${id}/frames`);
  if (!res.ok) throw new Error('Не удалось загрузить кадры демо');
  const total = Number(res.headers.get('content-length')) || 0;
  let buffer;
  if (res.body && total && !res.headers.get('content-encoding')) {
    const reader = res.body.getReader();
    const bytes = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, got);
      got += value.length;
      onProgress?.(0.3 + 0.6 * (got / total), 'Загрузка кадров');
    }
    buffer = bytes.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }
  return new DemoData(meta, buffer);
}
