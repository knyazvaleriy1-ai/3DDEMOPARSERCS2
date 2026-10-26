// Sound: every effect is synthesised (no sample files needed), positioned in
// 3D relative to a listener, and rendered both live and offline for clips.
//
// Users can replace any sound with their own file: put e.g. ``ak47.wav`` into
// ``<data>/sounds/`` (names: see SOUND_NAMES) and it is used instead.
//
// Players' voice chat (when the demo has it, see voice.js) is mixed in too,
// unpositioned like a radio, filtered by team / player.
import { urls } from './backend.js';
import { firesBullets, weaponIcon } from './util.js';
import { VOICE_SAMPLE_RATE, voiceBuffer, voiceFilter } from './voice.js';

export const SOUND_NAMES = [
  'rifle', 'ak47', 'm4', 'silenced', 'sniper', 'auto_sniper', 'pistol', 'deagle', 'smg', 'shotgun', 'lmg',
  'taser', 'knife', 'throw', 'he', 'flash', 'smoke', 'molotov', 'fire_loop', 'decoy', 'bomb_beep', 'bomb_planted',
  'bomb_defused', 'c4_explode', 'step', 'headshot', 'hit', 'kill',
];

// -- DSP helpers ----------------------------------------------------------------------

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noise(n, seed) {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

/** RBJ biquad, in place. type: lp | hp | bp */
function biquad(x, type, f, q, sr) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cs = Math.cos(w), sn = Math.sin(w), alpha = sn / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

function envelope(x, sr, attack, decay, delay = 0) {
  for (let i = 0; i < x.length; i++) {
    const t = i / sr - delay;
    if (t < 0) { x[i] = 0; continue; }
    const a = attack > 0 ? Math.min(1, t / attack) : 1;
    x[i] *= a * Math.exp(-t / decay);
  }
  return x;
}

function mixInto(dst, src, gain = 1, offset = 0) {
  for (let i = 0; i < src.length && i + offset < dst.length; i++) dst[i + offset] += src[i] * gain;
  return dst;
}

function normalize(x, peak = 0.9, drive = 1.4) {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = Math.tanh(x[i] * drive);
    m = Math.max(m, Math.abs(x[i]));
  }
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  // short fade-out avoids clicks
  const fade = Math.min(x.length, 256);
  for (let i = 0; i < fade; i++) x[x.length - 1 - i] *= i / fade;
  return x;
}

function sweep(n, sr, f0, f1, curve, decay, phase = 0) {
  const out = new Float32Array(n);
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / curve);
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / decay);
  }
  return out;
}

// -- synthesis recipes --------------------------------------------------------------------

function gunshot(sr, p, seed) {
  const len = Math.ceil(sr * p.len);
  const out = new Float32Array(len);
  if (p.crack) mixInto(out, envelope(biquad(noise(len, seed), 'hp', 2500, 0.7, sr), sr, 0, 0.0025), p.crack);
  mixInto(out, envelope(biquad(noise(len, seed + 1), 'lp', p.body, 0.8, sr), sr, 0.0005, p.bodyDecay), 1);
  mixInto(out, sweep(len, sr, p.thump[0], p.thump[1], 0.025, p.thumpDecay), p.thumpGain ?? 0.9);
  const tail = envelope(biquad(noise(len, seed + 2), 'lp', p.tail, 0.7, sr), sr, 0.01, p.tailDecay);
  mixInto(out, tail, p.tailGain);
  // A couple of slap-back echoes for an outdoor feel.
  for (const [delay, g] of [[0.07, 0.25], [0.16, 0.12]]) {
    const echo = envelope(biquad(noise(len, seed + 3), 'lp', p.tail * 0.8, 0.7, sr), sr, 0.002, p.bodyDecay * 1.5, delay);
    mixInto(out, echo, g * p.tailGain * 2);
  }
  if (p.click) mixInto(out, envelope(biquad(noise(len, seed + 4), 'bp', 6000, 4, sr), sr, 0, 0.004, 0.012), p.click);
  return normalize(out, p.peak ?? 0.95, p.drive ?? 1.6);
}

const GUNS = {
  rifle: { len: 0.6, crack: 0.6, body: 3600, bodyDecay: 0.045, thump: [170, 55], thumpDecay: 0.07, tail: 1200, tailDecay: 0.32, tailGain: 0.35 },
  ak47: { len: 0.65, crack: 0.7, body: 3200, bodyDecay: 0.05, thump: [150, 50], thumpDecay: 0.08, tail: 1100, tailDecay: 0.35, tailGain: 0.38 },
  m4: { len: 0.55, crack: 0.6, body: 4300, bodyDecay: 0.035, thump: [190, 60], thumpDecay: 0.06, tail: 1400, tailDecay: 0.3, tailGain: 0.3 },
  silenced: { len: 0.3, crack: 0, body: 2000, bodyDecay: 0.016, thump: [120, 60], thumpDecay: 0.025, thumpGain: 0.4, tail: 700, tailDecay: 0.08, tailGain: 0.12, click: 0.5, peak: 0.6, drive: 1.1 },
  sniper: { len: 1.4, crack: 0.9, body: 2600, bodyDecay: 0.08, thump: [110, 38], thumpDecay: 0.16, thumpGain: 1.1, tail: 900, tailDecay: 0.85, tailGain: 0.5 },
  auto_sniper: { len: 0.9, crack: 0.8, body: 3000, bodyDecay: 0.06, thump: [130, 45], thumpDecay: 0.11, tail: 1000, tailDecay: 0.5, tailGain: 0.42 },
  pistol: { len: 0.4, crack: 0.5, body: 4600, bodyDecay: 0.025, thump: [230, 90], thumpDecay: 0.04, tail: 1500, tailDecay: 0.2, tailGain: 0.24, peak: 0.85 },
  deagle: { len: 0.8, crack: 0.8, body: 3000, bodyDecay: 0.05, thump: [140, 48], thumpDecay: 0.1, thumpGain: 1.0, tail: 1000, tailDecay: 0.45, tailGain: 0.4 },
  smg: { len: 0.35, crack: 0.45, body: 5000, bodyDecay: 0.022, thump: [230, 100], thumpDecay: 0.035, tail: 1600, tailDecay: 0.17, tailGain: 0.2, peak: 0.85 },
  shotgun: { len: 1.0, crack: 0.5, body: 1800, bodyDecay: 0.09, thump: [100, 40], thumpDecay: 0.12, thumpGain: 1.0, tail: 800, tailDecay: 0.55, tailGain: 0.45 },
  lmg: { len: 0.6, crack: 0.6, body: 3400, bodyDecay: 0.045, thump: [150, 55], thumpDecay: 0.075, tail: 1100, tailDecay: 0.38, tailGain: 0.36 },
};

const RECIPES = {
  ...Object.fromEntries(Object.entries(GUNS).map(([k, p]) => [k, (sr) => gunshot(sr, p, k.length * 7919)])),
  taser(sr) {
    const len = Math.ceil(sr * 0.35);
    const out = new Float32Array(len);
    const r = rng(77);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const buzz = Math.sign(Math.sin(2 * Math.PI * 140 * t)) * 0.4 + (r() * 2 - 1) * 0.6;
      out[i] = buzz * Math.exp(-t / 0.12) * (r() < 0.3 ? 1.6 : 1);
    }
    biquad(out, 'bp', 3000, 0.8, sr);
    return normalize(out, 0.8, 1.5);
  },
  knife(sr) {
    const len = Math.ceil(sr * 0.22);
    const out = noise(len, 31);
    const parts = 6;
    const seg = Math.floor(len / parts);
    for (let k = 0; k < parts; k++) biquad(out.subarray(k * seg, (k + 1) * seg), 'bp', 700 + k * 500, 1.5, sr);
    return normalize(envelope(out, sr, 0.06, 0.06), 0.5, 1.0);
  },
  throw(sr) {
    const len = Math.ceil(sr * 0.25);
    const out = noise(len, 41);
    biquad(out, 'bp', 900, 1.2, sr);
    return normalize(envelope(out, sr, 0.08, 0.07), 0.35, 1.0);
  },
  he(sr) {
    const len = Math.ceil(sr * 2.4);
    const out = new Float32Array(len);
    mixInto(out, envelope(biquad(noise(len, 51), 'lp', 450, 0.7, sr), sr, 0.004, 0.55), 1.2);
    mixInto(out, sweep(len, sr, 90, 28, 0.08, 0.4), 1.2);
    mixInto(out, envelope(biquad(noise(len, 52), 'hp', 1800, 0.7, sr), sr, 0, 0.05), 0.6);
    const crackle = noise(len, 53);
    const r = rng(54);
    for (let i = 0; i < len; i++) crackle[i] *= r() < 0.004 ? 6 : 0.02;
    mixInto(out, envelope(biquad(crackle, 'bp', 2500, 1, sr), sr, 0.05, 0.6), 0.5);
    return normalize(out, 1.0, 1.8);
  },
  flash(sr) {
    const len = Math.ceil(sr * 1.1);
    const out = gunshot(sr, { len: 1.1, crack: 1, body: 3400, bodyDecay: 0.03, thump: [160, 50], thumpDecay: 0.06, tail: 1400, tailDecay: 0.25, tailGain: 0.3 }, 61);
    const ring = new Float32Array(len);
    for (let i = 0; i < len; i++) ring[i] = Math.sin((2 * Math.PI * 3300 * i) / sr) * Math.exp(-i / sr / 0.35) * 0.12;
    return normalize(mixInto(out, ring), 0.95, 1.2);
  },
  smoke(sr) {
    const len = Math.ceil(sr * 2.6);
    const out = new Float32Array(len);
    mixInto(out, sweep(len, sr, 120, 60, 0.03, 0.06), 0.6);
    const hiss = biquad(biquad(noise(len, 71), 'hp', 2500, 0.7, sr), 'lp', 9000, 0.7, sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      hiss[i] *= Math.min(1, t / 0.08) * Math.exp(-t / 1.1) * (0.8 + 0.2 * Math.sin(t * 37));
    }
    mixInto(out, hiss, 0.7);
    return normalize(out, 0.7, 1.1);
  },
  molotov(sr) {
    const len = Math.ceil(sr * 1.3);
    const out = new Float32Array(len);
    const glass = noise(len, 81);
    biquad(glass, 'hp', 3500, 0.7, sr);
    const r = rng(82);
    for (let i = 0; i < len; i++) glass[i] *= Math.exp(-i / sr / 0.08) * (r() < 0.2 ? 1.5 : 0.4);
    mixInto(out, glass, 0.8);
    const whoosh = biquad(noise(len, 83), 'lp', 700, 0.7, sr);
    envelope(whoosh, sr, 0.25, 0.4, 0.05);
    mixInto(out, whoosh, 1.2);
    return normalize(out, 0.85, 1.3);
  },
  fire_loop(sr) {
    const len = Math.ceil(sr * 2.0);
    const out = biquad(noise(len, 91), 'lp', 400, 0.7, sr);
    for (let i = 0; i < len; i++) out[i] *= 0.5;
    const r = rng(92);
    const crack = new Float32Array(len);
    for (let i = 0; i < len; i++) if (r() < 0.0025) crack[i] = (r() * 2 - 1) * 4;
    biquad(crack, 'bp', 2200, 1.2, sr);
    mixInto(out, crack, 0.6);
    return normalize(out, 0.5, 1.0);
  },
  decoy(sr) {
    return gunshot(sr, GUNS.pistol, 101);
  },
  bomb_beep(sr) {
    const len = Math.ceil(sr * 0.14);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      out[i] = (Math.sin(2 * Math.PI * 2450 * t) + 0.3 * Math.sin(2 * Math.PI * 4900 * t)) * Math.min(1, t / 0.004) * Math.exp(-t / 0.05);
    }
    return normalize(out, 0.6, 1.0);
  },
  bomb_planted(sr) {
    const len = Math.ceil(sr * 0.9);
    const out = new Float32Array(len);
    for (const [start, f] of [[0, 1800], [0.25, 2400], [0.5, 1800]]) {
      for (let i = 0; i < len; i++) {
        const t = i / sr - start;
        if (t < 0 || t > 0.2) continue;
        out[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.08);
      }
    }
    return normalize(out, 0.6, 1.0);
  },
  bomb_defused(sr) {
    const len = Math.ceil(sr * 0.8);
    const out = new Float32Array(len);
    mixInto(out, envelope(biquad(noise(len, 111), 'bp', 4000, 3, sr), sr, 0, 0.01), 0.8);
    for (let i = 0; i < len; i++) {
      const t = i / sr - 0.1;
      if (t > 0) out[i] += (Math.sin(2 * Math.PI * 1320 * t) + 0.6 * Math.sin(2 * Math.PI * 1980 * t)) * Math.exp(-t / 0.18) * 0.6;
    }
    return normalize(out, 0.6, 1.0);
  },
  c4_explode(sr) {
    const len = Math.ceil(sr * 4);
    const out = new Float32Array(len);
    mixInto(out, envelope(biquad(noise(len, 121), 'lp', 380, 0.7, sr), sr, 0.006, 1.2), 1.4);
    mixInto(out, sweep(len, sr, 70, 22, 0.15, 0.9), 1.4);
    mixInto(out, envelope(biquad(noise(len, 122), 'hp', 1500, 0.7, sr), sr, 0, 0.12), 0.5);
    return normalize(out, 1.0, 2.0);
  },
  step(sr) {
    const len = Math.ceil(sr * 0.12);
    const out = new Float32Array(len);
    mixInto(out, envelope(biquad(noise(len, 131), 'lp', 500, 0.7, sr), sr, 0.002, 0.025), 1);
    mixInto(out, envelope(biquad(noise(len, 132), 'bp', 2200, 1.5, sr), sr, 0.001, 0.015, 0.01), 0.35);
    return normalize(out, 0.5, 1.2);
  },
  headshot(sr) {
    const len = Math.ceil(sr * 0.45);
    const out = new Float32Array(len);
    for (const [f, g] of [[2350, 1], [3720, 0.7], [5130, 0.45], [6890, 0.3]]) {
      for (let i = 0; i < len; i++) out[i] += Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / sr / 0.12) * g;
    }
    mixInto(out, envelope(biquad(noise(len, 141), 'hp', 4000, 0.7, sr), sr, 0, 0.003), 0.8);
    return normalize(out, 0.55, 1.0);
  },
  hit(sr) {
    const len = Math.ceil(sr * 0.12);
    const out = envelope(biquad(noise(len, 151), 'lp', 380, 0.7, sr), sr, 0.001, 0.03);
    return normalize(out, 0.4, 1.3);
  },
  kill(sr) {
    const len = Math.ceil(sr * 0.5);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      out[i] = (Math.sin(2 * Math.PI * 1568 * t) * 0.8 + Math.sin(2 * Math.PI * 2349 * t) * 0.5) * Math.min(1, t / 0.003) * Math.exp(-t / 0.15);
    }
    return normalize(out, 0.32, 1.0);
  },
};

// -- sound bank ---------------------------------------------------------------------------

let overrideFiles = null; // name -> ArrayBuffer (raw file), fetched once

async function fetchOverrides() {
  if (overrideFiles) return overrideFiles;
  overrideFiles = {};
  try {
    const url = urls.sounds();
    const list = url ? await fetch(url).then((r) => (r.ok ? r.json() : [])) : [];
    await Promise.all(list.map(async (s) => {
      const res = await fetch(s.url);
      if (res.ok) overrideFiles[s.name] = await res.arrayBuffer();
    }));
  } catch (_) { /* no overrides */ }
  return overrideFiles;
}

/** Synthesised buffers for one (Offline)AudioContext, with user overrides. */
export class SoundBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffers = new Map();
  }

  async loadOverrides() {
    const files = await fetchOverrides();
    for (const [name, data] of Object.entries(files)) {
      try {
        this.buffers.set(name, await this.ctx.decodeAudioData(data.slice(0)));
      } catch (err) {
        console.warn('bad sound override', name, err);
      }
    }
    return this;
  }

  get(name) {
    if (!this.buffers.has(name)) {
      const recipe = RECIPES[name];
      if (!recipe) return null;
      const sr = this.ctx.sampleRate;
      const data = recipe(sr);
      const buf = this.ctx.createBuffer(1, data.length, sr);
      buf.copyToChannel(data, 0);
      this.buffers.set(name, buf);
    }
    return this.buffers.get(name);
  }
}

// -- events -------------------------------------------------------------------------------

const GUN_BY_ICON = {
  ak47: 'ak47', galil: 'rifle', m4: 'm4', famas: 'rifle', aug: 'rifle', sniper: 'sniper', auto_sniper: 'auto_sniper',
  glock: 'pistol', usp: 'silenced', pistol: 'pistol', cz75: 'pistol', tec9: 'pistol', deagle: 'deagle', revolver: 'deagle',
  mac10: 'smg', mp9: 'smg', mp7: 'smg', mp5: 'smg', ump: 'smg', p90: 'smg', bizon: 'smg', shotgun: 'shotgun',
  sawedoff: 'shotgun', lmg: 'lmg', taser: 'taser', knife: 'knife',
};

export function shotSound(weapon) {
  const raw = (weapon || '').toLowerCase();
  if (raw.includes('silencer') && !raw.includes('_off')) return 'silenced';
  if (raw === 'mp5sd') return 'silenced';
  const icon = weaponIcon(raw);
  if (icon && GUN_BY_ICON[icon]) return GUN_BY_ICON[icon];
  if (!firesBullets(raw)) return /knife|bayonet/.test(raw) ? 'knife' : null;
  return 'rifle';
}

const VOICE_GAIN = 1.1;
const LOUD = { sniper: 1.25, deagle: 1.1, shotgun: 1.15, he: 1.5, c4_explode: 2.2, flash: 1.3, smoke: 0.7, molotov: 1.0 };
const RANGE = { step: 900, hit: 900, headshot: 1600, throw: 700, knife: 700, silenced: 1400, bomb_beep: 2200, fire_loop: 1200 };

function lowerBound(list, tick) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][0] < tick) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Footsteps derived from movement: a step every ~75 units while running (CS walking is silent). */
export function synthFootsteps(demo) {
  if (demo._footsteps) return demo._footsteps;
  const out = [];
  const { P, U, count, step, startTick } = demo;
  const dist = new Float32Array(P);
  for (let f = 1; f < count; f++) {
    for (let p = 0; p < P; p++) {
      const fl = demo.u8[(f * P + p) * U + 2];
      if (!(fl & 2)) { dist[p] = 0; continue; }
      const a = ((f - 1) * P + p) * 3, b = (f * P + p) * 3;
      const dx = demo.pos[b] - demo.pos[a], dy = demo.pos[b + 1] - demo.pos[a + 1], dz = demo.pos[b + 2] - demo.pos[a + 2];
      const d = Math.hypot(dx, dy);
      const speed = (d * demo.tickRate) / step;
      if (speed < 140 || speed > 400 || Math.abs(dz) > 6) continue; // walking, teleport or airborne
      dist[p] += d;
      if (dist[p] >= 78) {
        dist[p] -= 78;
        out.push([startTick + f * step, p]);
      }
    }
  }
  demo._footsteps = out;
  return out;
}

/**
 * Sound events with tick in (t0, t1]. Each: {tick, name, pos:[x,y,z] (world) | null, gain, player}.
 * ``listenerPlayer`` (or -1) gets the non-spatial "kill" confirmation for their kills.
 */
export function collectEvents(demo, t0, t1, listenerPlayer = -1, opts = {}) {
  const out = [];
  const st = demo._scratchState || (demo._scratchState = demo.state(0, demo.startTick));
  const posOf = (p, tick) => {
    demo.state(p, tick, st);
    return [st.x, st.y, st.z + 50];
  };
  for (let i = lowerBound(demo.shots, t0 + 1e-6); i < demo.shots.length; i++) {
    const [tick, p, weapon] = demo.shots[i];
    if (tick > t1) break;
    if (tick <= t0) continue;
    const name = shotSound(weapon);
    if (name) out.push({ tick, name, pos: posOf(p, tick), gain: 1, player: p });
  }
  for (let i = lowerBound(demo.hurts, t0 + 1e-6); i < demo.hurts.length; i++) {
    const h = demo.hurts[i];
    if (h[0] > t1) break;
    if (h[0] <= t0) continue;
    out.push({ tick: h[0], name: h[5] === 'head' ? 'headshot' : 'hit', pos: posOf(h[2], h[0]), gain: 0.8, player: h[2] });
  }
  if (listenerPlayer >= 0) {
    for (const k of demo.kills) {
      if (k.tick > t1) break;
      if (k.tick > t0 && k.attacker === listenerPlayer && k.victim !== k.attacker) out.push({ tick: k.tick, name: 'kill', pos: null, gain: 1 });
    }
  }
  const fx = demo.effects || {};
  const point = (list, name, key = 'tick') => {
    for (const e of list || []) {
      const t = e[key];
      if (t > t0 && t <= t1) out.push({ tick: t, name, pos: e.pos, gain: 1 });
    }
  };
  point(fx.hes, 'he');
  point(fx.flashes, 'flash');
  point(fx.smokes, 'smoke', 'start');
  point(fx.infernos, 'molotov', 'start');
  for (const g of demo.grenades || []) {
    const t = g.ticks[0];
    if (t > t0 && t <= t1) out.push({ tick: t, name: 'throw', pos: [g.pts[0], g.pts[1], g.pts[2]], gain: 1 });
  }
  // Bomb: plant, beeps speeding up over 40 s, defuse, explosion.
  let plant = null;
  for (const b of demo.bomb) {
    if (b.type === 'plant') plant = b;
    if (b.tick > t0 && b.tick <= t1) {
      if (b.type === 'plant') out.push({ tick: b.tick, name: 'bomb_planted', pos: b.pos, gain: 1 });
      if (b.type === 'defuse') out.push({ tick: b.tick, name: 'bomb_defused', pos: b.pos || plant?.pos, gain: 1 });
      if (b.type === 'explode') out.push({ tick: b.tick, name: 'c4_explode', pos: plant?.pos || b.pos, gain: 1 });
    }
    if (b.type === 'plant') {
      const end = demo.bomb.find((e) => e.tick > b.tick && (e.type === 'defuse' || e.type === 'explode'))?.tick ?? b.tick + 40 * demo.tickRate;
      let t = b.tick + demo.tickRate;
      while (t < end && t <= t1) {
        if (t > t0) out.push({ tick: t, name: 'bomb_beep', pos: b.pos, gain: 0.9 });
        const elapsed = (t - b.tick) / demo.tickRate;
        t += demo.tickRate * Math.max(0.12, 1 - elapsed / 42);
      }
    }
  }
  if (opts.footsteps !== false) {
    const steps = synthFootsteps(demo);
    for (let i = lowerBound(steps, t0 + 1e-6); i < steps.length; i++) {
      const [tick, p] = steps[i];
      if (tick > t1) break;
      if (tick > t0) out.push({ tick, name: 'step', pos: posOf(p, tick).map((v, j) => (j === 2 ? v - 48 : v)), gain: 0.7, player: p });
    }
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

/** Active fire loops at ``tick``: [{key, start, end, pos}] */
export function activeFires(demo, tick) {
  return (demo.effects?.infernos || []).filter((f) => tick >= f.start && tick < f.end).map((f, i) => ({ key: `${f.start}:${i}`, ...f }));
}

// -- spatialisation -----------------------------------------------------------------------

/**
 * Gain / pan / lowpass for a source at world ``pos`` heard by ``listener``
 * ({x, y, z, yaw} in world units, yaw in degrees).
 */
export function spatial(listener, pos, name) {
  if (!pos || !listener) return { gain: 1, pan: 0, cutoff: 20000 };
  const dx = pos[0] - listener.x, dy = pos[1] - listener.y, dz = pos[2] - listener.z;
  const d = Math.hypot(dx, dy, dz);
  const range = RANGE[name] || 3200;
  if (d > range * 1.5) return null;
  const gain = (1 / (1 + (d / (range * 0.16)) ** 1.5)) * Math.max(0, 1 - d / (range * 1.5));
  const yaw = (listener.yaw * Math.PI) / 180;
  // listener right vector in world XY: (sin yaw, -cos yaw)
  const h = Math.hypot(dx, dy) || 1;
  const pan = Math.max(-1, Math.min(1, ((dx * Math.sin(yaw) - dy * Math.cos(yaw)) / h) * 0.8));
  const cutoff = 20000 - 16500 * Math.min(1, Math.max(0, (d - 300) / 2500));
  return { gain, pan, cutoff };
}

function play(ctx, dest, buffer, when, sp, gain, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = sp.cutoff;
  const pan = ctx.createStereoPanner();
  pan.pan.value = sp.pan;
  const g = ctx.createGain();
  g.gain.value = gain * sp.gain;
  src.connect(lp).connect(pan).connect(g).connect(dest);
  src.start(Math.max(when, 0));
  return { src, gain: g };
}

// -- live playback ------------------------------------------------------------------------

export class LiveAudio {
  constructor() {
    this.ctx = null;
    this.volume = 0.6;
    this.muted = false;
    try {
      const saved = JSON.parse(localStorage.getItem('cs2demo.audio') || '{}');
      if (typeof saved.volume === 'number') this.volume = saved.volume;
      if (typeof saved.muted === 'boolean') this.muted = saved.muted;
    } catch (_) { /* private mode */ }
    this.fires = new Map();
    this.voiceSources = new Map(); // spurt -> playing source
    this.voiceKey = '';
    this.lastTick = null;
    const unlock = () => this.ensure();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.voiceGain = this.ctx.createGain();
    this.voiceGain.gain.value = VOICE_GAIN;
    this.voiceGain.connect(this.master);
    this._applyVolume();
    this.bank = new SoundBank(this.ctx);
    this.bank.loadOverrides();
    return this.ctx;
  }

  setVolume(v) { this.volume = v; this._applyVolume(); this._save(); }
  setMuted(m) { this.muted = m; this._applyVolume(); this._save(); }
  _applyVolume() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }
  _save() { try { localStorage.setItem('cs2demo.audio', JSON.stringify({ volume: this.volume, muted: this.muted })); } catch (_) { /* ignore */ } }

  /**
   * Called every frame by the viewer. ``voice`` = {mode, focus}: whose voice
   * chat is heard (see voice.js).
   */
  frame(demo, tick, playing, speed, listener, listenerPlayer, voice = null) {
    const prev = this.lastTick;
    this.lastTick = tick;
    const ctx = this.ctx;
    this._voice(demo, prev, tick, playing, speed, voice);
    if (!ctx || ctx.state !== 'running' || this.muted || !playing || speed > 4 || prev === null || tick <= prev || tick - prev > demo.tickRate) {
      if (!playing || speed > 4) this.stopFires();
      return;
    }
    const events = collectEvents(demo, prev, tick, listenerPlayer, { footsteps: speed <= 2 });
    const rate = Math.max(0.5, Math.min(1, speed));
    let n = 0;
    for (const e of events) {
      if (n > 24) break;
      const buf = this.bank.get(e.name);
      const sp = spatial(listener, e.pos, e.name);
      if (!buf || !sp) continue;
      const offset = ((e.tick - prev) / demo.tickRate) / speed;
      play(ctx, this.master, buf, ctx.currentTime + 0.02 + offset, sp, (LOUD[e.name] || 1) * e.gain * 0.8, rate);
      n++;
    }
    // Burning molotovs: looping crackle while active.
    const active = activeFires(demo, tick);
    const keep = new Set();
    for (const f of active) {
      keep.add(f.key);
      const sp = spatial(listener, f.pos, 'fire_loop') || { gain: 0, pan: 0, cutoff: 2000 };
      let node = this.fires.get(f.key);
      if (!node) {
        const buf = this.bank.get('fire_loop');
        node = play(ctx, this.master, buf, ctx.currentTime, sp, 0.6, rate);
        node.src.loop = true;
        this.fires.set(f.key, node);
      }
      node.gain.gain.value = 0.6 * sp.gain;
    }
    for (const [key, node] of this.fires) {
      if (!keep.has(key)) { node.src.stop(); this.fires.delete(key); }
    }
  }

  stopFires() {
    for (const node of this.fires.values()) node.src.stop();
    this.fires.clear();
  }

  /** Start the talk spurts that begin now (or, after a jump, are under way). */
  _voice(demo, prev, tick, playing, speed, opts) {
    const ctx = this.ctx;
    const track = demo.voice;
    // steady: fast-forward after a POV death — speech keeps its normal speed.
    const steady = !!opts?.steady;
    const on = ctx && ctx.state === 'running' && !this.muted && playing && (steady || (speed >= 0.5 && speed <= 2))
      && opts && opts.mode && opts.mode !== 'off' && track.available;
    if (!on) {
      this.stopVoice();
      return;
    }
    if (!track.isReady) {
      track.ready();
      return;
    }
    const rate = steady ? 1 : speed;
    const key = `${opts.mode}:${opts.focus}:${rate}`;
    const jumped = prev === null || tick < prev || tick - prev > demo.tickRate || key !== this.voiceKey;
    if (jumped) {
      this.stopVoice();
      this.voiceKey = key;
      this._voiceAllow = voiceFilter(demo, opts.mode, opts.focus);
    }
    const list = jumped ? track.overlapping(tick, tick) : track.starting(prev, tick);
    for (const s of list) {
      if (this.voiceSources.has(s) || !this._voiceAllow(s.player, s.tick)) continue;
      const pcm = track.pcm(s);
      const offset = steady && !jumped ? 0 : Math.max(0, (tick - s.tick) / demo.tickRate); // seconds already spoken
      if (offset >= pcm.length / VOICE_SAMPLE_RATE - 0.02) continue;
      const src = ctx.createBufferSource();
      src.buffer = voiceBuffer(ctx, pcm);
      src.playbackRate.value = rate;
      src.connect(this.voiceGain);
      src.onended = () => { if (this.voiceSources.get(s) === src) this.voiceSources.delete(s); };
      src.start(ctx.currentTime + 0.02, offset);
      this.voiceSources.set(s, src);
    }
  }

  stopVoice() {
    for (const src of this.voiceSources.values()) {
      try { src.stop(); } catch (_) { /* not started */ }
    }
    this.voiceSources.clear();
    this.voiceKey = '';
  }

  reset() {
    this.lastTick = null;
    this.stopFires();
    this.stopVoice();
  }
}

// -- offline rendering for clips -----------------------------------------------------------

/**
 * Render the soundtrack of a clip. ``ticks`` maps output frame -> demo tick
 * (slow motion stretches time, fast-forward squeezes it: game sounds are left
 * out where the clip runs faster than 1.5x), the listener is ``player``'s head.
 * ``voice``: whose voice chat to mix in (voice.js modes, around ``player``).
 */
export async function renderClipAudio(demo, ticks, fps, player, { sampleRate = 48000, voice = 'off' } = {}) {
  const duration = ticks.length / fps;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const bank = await new SoundBank(ctx).loadOverrides();
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const timeOf = (tick) => {
    let lo = 0, hi = ticks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ticks[mid] <= tick) lo = mid; else hi = mid - 1; }
    const next = Math.min(lo + 1, ticks.length - 1);
    const frac = next > lo ? (tick - ticks[lo]) / (ticks[next] - ticks[lo]) : 0;
    return (lo + Math.max(0, Math.min(1, frac))) / fps;
  };
  const localSpeed = (tick) => {
    const i = Math.max(0, Math.min(ticks.length - 2, Math.floor(timeOf(tick) * fps)));
    return ((ticks[i + 1] - ticks[i]) * fps) / demo.tickRate;
  };
  const st = demo.state(player, t0);
  const listenerAt = (tick) => {
    demo.state(player, tick, st);
    return { x: st.x, y: st.y, z: st.z + 64, yaw: st.yaw };
  };
  for (const e of collectEvents(demo, t0 - 1e-6, t1, player)) {
    const buf = bank.get(e.name);
    const speed = localSpeed(e.tick);
    if (!buf || speed > 1.5) continue;
    const sp = spatial(listenerAt(e.tick), e.pos, e.name);
    if (!sp) continue;
    const rate = Math.max(0.55, Math.min(1, speed));
    play(ctx, master, buf, timeOf(e.tick), sp, (LOUD[e.name] || 1) * e.gain * 0.8, rate);
  }
  for (const f of demo.effects?.infernos || []) {
    if (f.end <= t0 || f.start >= t1) continue;
    const start = timeOf(Math.max(f.start, t0)), end = timeOf(Math.min(f.end, t1));
    const sp = spatial(listenerAt(Math.max(f.start, t0)), f.pos, 'fire_loop');
    if (!sp || end - start < 0.3 * ((Math.min(f.end, t1) - Math.max(f.start, t0)) / demo.tickRate)) continue;
    const node = play(ctx, master, bank.get('fire_loop'), start, sp, 0.6);
    node.src.loop = true;
    node.src.stop(end);
  }
  await mixVoice(ctx, demo, ticks, timeOf, voice, player);
  return ctx.startRendering();
}

/**
 * Voice chat for a clip. Speech always plays at normal speed from the moment
 * it starts in the clip (slow motion and fast-forward don't pitch it); a
 * player's next spurt waits for the previous one, or is dropped when it would
 * come more than 2 s late.
 */
async function mixVoice(ctx, demo, ticks, timeOf, mode, focus) {
  const allow = voiceFilter(demo, mode, focus);
  const track = demo.voice;
  if (!allow || !track.available || !(await track.ready())) return;
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const out = ctx.createGain();
  out.gain.value = VOICE_GAIN;
  out.connect(ctx.destination);
  const busy = new Map(); // player -> time their audio ends
  const rate = demo.tickRate;
  for (const s of track.overlapping(t0, t1)) {
    if (!allow(s.player, s.tick)) continue;
    const pcm = track.pcm(s);
    const offset = Math.max(0, (t0 - s.tick) / rate);
    const dur = pcm.length / VOICE_SAMPLE_RATE - offset;
    if (dur <= 0.02) continue;
    let at = timeOf(Math.max(s.tick, t0));
    const free = busy.get(s.player) ?? 0;
    if (free > at) {
      if (free - at > 2) continue;
      at = free;
    }
    if (at >= ctx.length / ctx.sampleRate) continue;
    const src = ctx.createBufferSource();
    src.buffer = voiceBuffer(ctx, pcm);
    src.connect(out);
    src.start(at, offset);
    busy.set(s.player, at + dur);
  }
}

/** 16-bit PCM WAV from an AudioBuffer. */
export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return out.buffer;
}
