// Sound. Gunshots, grenades and the bomb are synthesised from acoustic models
// rather than tones: the blast wave of the muzzle (a Friedlander pulse), the
// supersonic crack of rifle bullets, the gas and the gun's mechanism, a few
// takes of each so bursts don't sound like a machine. Footsteps, hits, helmet
// clinks, grenade bounces, glass and the bomb being planted are real
// recordings (Kenney, CC0; web/audio/). Everything plays in one room: a
// convolution reverb (more of it the farther the sound), positioned around the
// listener, through a compressor. Players' voice chat (voice.js) sits on top
// and ducks the game while someone talks.
//
// Users can replace any sound with their own file: put e.g. ``ak47.wav`` into
// ``<data>/sounds/`` (names: see SOUND_NAMES) and it is used instead.
import { urls } from './backend.js';
import { firesBullets, weaponIcon } from './util.js';
import { VOICE_SAMPLE_RATE, voiceBuffer, voiceFilter } from './voice.js';

export const SOUND_NAMES = [
  'rifle', 'ak47', 'm4', 'silenced', 'sniper', 'auto_sniper', 'pistol', 'deagle', 'smg', 'shotgun', 'lmg',
  'taser', 'knife', 'throw', 'bounce', 'he', 'flash', 'smoke', 'molotov', 'glass', 'fire_loop', 'decoy',
  'bomb_beep', 'bomb_planted', 'bomb_defused', 'c4_explode', 'step', 'hit', 'headshot', 'helmet',
];

const VARIANTS = 4; // takes of each synthesised sound
const C4_TIMER = 40; // s from plant to explosion (mp_c4timer; the event comes ~1 s later)
const VOICE_GAIN = 1.0;
const DUCK = 0.5; // game level while someone talks

// -- preferences ----------------------------------------------------------------------------

/** Which kinds of sounds play (remembered): footsteps, hit sounds. */
export const soundPrefs = { steps: true, hits: true };
try {
  Object.assign(soundPrefs, JSON.parse(localStorage.getItem('cs2demo.sfx') || '{}'));
} catch (_) { /* private mode */ }

export function setSoundPref(key, value) {
  soundPrefs[key] = !!value;
  try { localStorage.setItem('cs2demo.sfx', JSON.stringify(soundPrefs)); } catch (_) { /* ignore */ }
}

// -- DSP helpers ----------------------------------------------------------------------------

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noise(n, r) {
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

/** Exponential decay envelope (``attack`` linear ramp, ``delay`` silence first), in place. */
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
  for (let i = 0; i < src.length && i + offset < dst.length; i++) {
    if (i + offset >= 0) dst[i + offset] += src[i] * gain;
  }
  return dst;
}

/**
 * Level a sound by its loudness (the loudest 50 ms, in dBFS) rather than its
 * peak, then catch the peaks with a soft limiter, like a recorded and
 * mastered game sound. The end fades out without a click.
 */
function finish(x, loud = -12, sr = 48000) {
  const win = Math.max(1, Math.round(0.05 * sr)), hop = Math.max(1, win >> 2);
  let st = 0;
  for (let i = 0; i + win <= x.length || i === 0; i += hop) {
    let e = 0;
    const end = Math.min(x.length, i + win);
    for (let j = i; j < end; j++) e += x[j] * x[j];
    st = Math.max(st, Math.sqrt(e / win));
    if (end === x.length) break;
  }
  if (st > 0) {
    const k = 10 ** (loud / 20) / st, knee = 0.6, room = 0.97 - knee;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * k;
      const a = Math.abs(v);
      x[i] = a < knee ? v : Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
    }
  }
  const fade = Math.min(x.length, 512);
  for (let i = 0; i < fade; i++) x[x.length - 1 - i] *= i / fade;
  return x;
}

/**
 * Friedlander blast wave, the pressure pulse of a muzzle blast or an
 * explosion: p(t) = (1 - t/T) e^(-b t/T). The positive phase T sets the
 * weight: ~0.5 ms for a pistol, ~2 ms for a shotgun, ~10 ms for C4.
 */
function friedlander(n, sr, T, b, delay = 0) {
  const out = new Float32Array(n);
  const d = Math.round(delay * sr);
  for (let i = d; i < n; i++) {
    const t = (i - d) / sr;
    out[i] = (1 - t / T) * Math.exp((-b * t) / T);
  }
  return biquad(out, 'lp', 11000, 0.7, sr); // finite rise time
}

/** Supersonic bullet crack: an N-wave, a fraction of a millisecond long. */
function nWave(n, sr, ms) {
  const out = new Float32Array(n);
  const d = Math.max(3, Math.round((ms / 1000) * sr));
  for (let i = 0; i < d && i < n; i++) out[i] = 1 - (2 * i) / d;
  return out;
}

/** Short mechanical clicks (bolt, slide, pump): bandpassed noise ticks. */
function clicks(n, sr, r, list, freq = 3800) {
  const out = new Float32Array(n);
  for (const [at, g] of list) {
    const tick = biquad(noise(Math.ceil(0.02 * sr), r), 'bp', freq * (0.9 + 0.2 * r()), 2.5, sr);
    envelope(tick, sr, 0.0002, 0.0035);
    mixInto(out, tick, g, Math.round(at * sr));
  }
  return out;
}

// -- guns -----------------------------------------------------------------------------------

/**
 * A dry gunshot (the room adds the tail): the bullet's crack, the muzzle
 * blast and its reflection off the ground, the gas roaring out, the low-mid
 * boom that carries most of the sound, the sub thump, the mechanism. Each
 * take varies a little.
 */
function gunshot(sr, p, r) {
  const n = Math.ceil(sr * p.len);
  const out = new Float32Array(n);
  const v = () => 0.9 + 0.2 * r();
  const lead = p.crack ? 0.0007 : 0; // the crack arrives first
  if (p.crack) mixInto(out, biquad(nWave(n, sr, 0.25), 'hp', 1500, 0.7, sr), p.crack);
  const blast = friedlander(n, sr, (p.T / 1000) * v(), p.b ?? 1.5, lead);
  mixInto(out, blast, p.blast ?? 1);
  mixInto(out, biquad(blast.slice(), 'lp', 3000, 0.7, sr), 0.5 * (p.blast ?? 1), Math.round((0.0018 + 0.001 * r()) * sr));
  const gas = biquad(biquad(noise(n, r), 'lp', p.gasLp * v(), 0.7, sr), 'hp', 150, 0.7, sr);
  mixInto(out, envelope(gas, sr, 0.0004, p.gas[0] * v(), lead), p.gas[1]);
  const boom = biquad(biquad(biquad(noise(n, r), 'lp', p.boomLp * v(), 0.7, sr), 'lp', p.boomLp, 0.7, sr), 'hp', 60, 0.7, sr);
  mixInto(out, envelope(boom, sr, 0.0015, p.boom[0] * v(), lead), p.boom[1]);
  if (p.sub) {
    const low = biquad(biquad(noise(n, r), 'lp', 110, 0.7, sr), 'lp', 110, 0.7, sr);
    mixInto(out, envelope(low, sr, 0.004, p.sub[0], lead), p.sub[1]);
  }
  if (p.mech) mixInto(out, clicks(n, sr, r, p.mech.map(([at, g]) => [at * v(), g]), p.mechHz));
  return finish(out, p.loud ?? -11, sr);
}

// T: blast positive phase (ms); crack: level of the supersonic crack; gas /
// boom / sub: [decay s, level] of the gas noise (low-passed at gasLp), the
// low-mid boom (at boomLp) and the sub thump; mech: [[time s, level]] clicks
// at mechHz; loud: loudness of the result (dBFS).
const GUNS = {
  pistol: { len: 0.3, T: 0.6, gas: [0.014, 0.6], gasLp: 5500, boom: [0.03, 0.9], boomLp: 1500, mech: [[0.02, 0.15]], loud: -13 },
  deagle: {
    len: 0.45, T: 1.1, crack: 0.3, gas: [0.025, 0.6], gasLp: 4500, boom: [0.06, 1.2], boomLp: 1100, sub: [0.07, 3],
    mech: [[0.022, 0.12]], loud: -10,
  },
  smg: { len: 0.25, T: 0.5, gas: [0.012, 0.6], gasLp: 6000, boom: [0.025, 0.8], boomLp: 1600, mech: [[0.012, 0.2], [0.03, 0.1]], loud: -13 },
  rifle: { len: 0.4, T: 0.85, crack: 0.35, gas: [0.02, 0.6], gasLp: 5000, boom: [0.05, 1.1], boomLp: 1300, sub: [0.05, 2], mech: [[0.016, 0.12]] },
  ak47: { len: 0.42, T: 1.0, crack: 0.4, gas: [0.024, 0.6], gasLp: 4500, boom: [0.06, 1.2], boomLp: 1150, sub: [0.06, 2.5], mech: [[0.017, 0.14]] },
  m4: { len: 0.38, T: 0.8, crack: 0.35, gas: [0.018, 0.6], gasLp: 5500, boom: [0.045, 1.0], boomLp: 1400, sub: [0.045, 2], mech: [[0.014, 0.12]] },
  silenced: {
    len: 0.22, T: 0.3, blast: 0.35, gas: [0.014, 0.6], gasLp: 1800, boom: [0.022, 0.7], boomLp: 1000,
    mech: [[0.004, 0.4], [0.024, 0.3]], mechHz: 3000, loud: -17,
  },
  sniper: {
    len: 0.95, T: 1.7, crack: 0.6, b: 1.3, gas: [0.04, 0.6], gasLp: 4000, boom: [0.11, 1.4], boomLp: 900, sub: [0.12, 4],
    mech: [[0.62, 0.18], [0.78, 0.2]], mechHz: 2600, loud: -8,
  },
  auto_sniper: {
    len: 0.55, T: 1.3, crack: 0.5, gas: [0.03, 0.6], gasLp: 4200, boom: [0.08, 1.3], boomLp: 1000, sub: [0.08, 3],
    mech: [[0.02, 0.12]], loud: -9,
  },
  shotgun: {
    len: 0.7, T: 1.9, b: 1.3, gas: [0.05, 0.6], gasLp: 3500, boom: [0.1, 1.4], boomLp: 800, sub: [0.1, 3.5],
    mech: [[0.42, 0.2], [0.52, 0.22]], mechHz: 2200, loud: -9,
  },
  lmg: { len: 0.4, T: 0.95, crack: 0.35, gas: [0.022, 0.6], gasLp: 4800, boom: [0.055, 1.2], boomLp: 1200, sub: [0.055, 2.5], mech: [[0.016, 0.14]] },
};

// -- grenades, bomb, the rest -----------------------------------------------------------------

function explosion(sr, r, { len, T, rumble, debris, crunch = 0.6 }) {
  const n = Math.ceil(sr * len);
  const out = friedlander(n, sr, (T / 1000) * (0.9 + 0.2 * r()), 1.2);
  const low = biquad(biquad(noise(n, r), 'lp', 220, 0.7, sr), 'lp', 220, 0.7, sr);
  mixInto(out, envelope(low, sr, 0.006, rumble), 7);
  mixInto(out, envelope(biquad(noise(n, r), 'bp', 900, 0.7, sr), sr, 0.001, 0.09), crunch);
  // debris: sparse ticks fading out
  const bits = new Float32Array(n);
  for (let i = 0; i < n; i++) if (r() < 0.0015 * Math.exp(-i / sr / debris)) bits[i] = r() * 2 - 1;
  mixInto(out, biquad(bits, 'bp', 2600, 1.2, sr), 0.9, Math.round(0.03 * sr));
  return finish(out, -7, sr);
}

function whoosh(sr, r, len, f0, f1, decay) {
  const n = Math.ceil(sr * len);
  const out = new Float32Array(n);
  const src = noise(n, r);
  // a band-pass sweeping f0 -> f1 (state-variable filter)
  let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = 2 * Math.sin((Math.PI * (f0 + (f1 - f0) * t)) / sr);
    low += f * band;
    const high = src[i] - low - 0.7 * band;
    band += f * high;
    out[i] = band;
  }
  return finish(envelope(out, sr, len * 0.35, decay), -17, sr);
}

const RECIPES = {
  ...Object.fromEntries(Object.entries(GUNS).map(([k, p]) => [k, (sr, r) => gunshot(sr, p, r)])),
  decoy: (sr, r) => gunshot(sr, GUNS.pistol, r),
  taser(sr, r) {
    // an electric arc: dense crackle with a fast on/off flutter
    const n = Math.ceil(sr * 0.3);
    const out = new Float32Array(n);
    let gate = 1;
    for (let i = 0; i < n; i++) {
      if (i % Math.round(sr / (40 + 30 * r())) === 0) gate = r() < 0.75 ? 1 : 0.2;
      out[i] = (r() < 0.35 ? r() * 2 - 1 : 0) * gate * Math.exp(-i / sr / 0.12);
    }
    biquad(biquad(out, 'hp', 1800, 0.7, sr), 'lp', 7000, 0.7, sr);
    return finish(out, -15, sr);
  },
  knife: (sr, r) => whoosh(sr, r, 0.16, 900, 3800, 0.05),
  throw: (sr, r) => whoosh(sr, r, 0.2, 500, 1600, 0.06),
  he: (sr, r) => explosion(sr, r, { len: 1.8, T: 5, rumble: 0.55, debris: 0.5 }),
  c4_explode: (sr, r) => explosion(sr, r, { len: 3.4, T: 10, rumble: 1.3, debris: 1.0, crunch: 0.8 }),
  flash(sr, r) {
    const n = Math.ceil(sr * 0.5);
    const out = friedlander(n, sr, 0.0014 * (0.9 + 0.2 * r()), 1.4);
    mixInto(out, envelope(biquad(noise(n, r), 'hp', 3000, 0.7, sr), sr, 0, 0.008), 0.7);
    mixInto(out, envelope(biquad(noise(n, r), 'lp', 1800, 0.7, sr), sr, 0.0005, 0.03), 0.5);
    return finish(out, -11, sr);
  },
  smoke(sr, r) {
    const n = Math.ceil(sr * 2.6);
    const out = friedlander(n, sr, 0.0015, 1.5);
    for (let i = 0; i < n; i++) out[i] *= 0.3;
    const hiss = biquad(biquad(noise(n, r), 'hp', 1500, 0.7, sr), 'lp', 7000, 0.7, sr);
    const ph = r() * 6;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      hiss[i] *= Math.min(1, t / 0.12) * Math.exp(-t / 1.4) * (0.82 + 0.18 * Math.sin(t * 11 + ph) * Math.sin(t * 3.1));
    }
    mixInto(out, hiss, 0.5, Math.round(0.04 * sr));
    return finish(out, -17, sr);
  },
  molotov(sr, r) {
    // the fire catching: a soft roar swelling up
    const n = Math.ceil(sr * 1.2);
    const out = biquad(biquad(noise(n, r), 'lp', 700, 0.7, sr), 'hp', 80, 0.7, sr);
    envelope(out, sr, 0.18, 0.45);
    return finish(out, -13, sr);
  },
  fire_loop(sr, r) {
    // roar + crackles, made to loop seamlessly (cross-faded seam)
    const n = Math.ceil(sr * 3);
    const fade = Math.ceil(sr * 0.25);
    const raw = biquad(biquad(noise(n + fade, r), 'lp', 420, 0.7, sr), 'hp', 60, 0.7, sr);
    const ph = r() * 6;
    for (let i = 0; i < raw.length; i++) raw[i] *= 0.6 + 0.4 * Math.sin(i / sr * 1.7 + ph) * Math.sin(i / sr * 0.6);
    const crack = new Float32Array(n + fade);
    for (let i = 0; i < crack.length; i++) if (r() < 0.002) crack[i] = (r() * 2 - 1) * 5;
    mixInto(raw, biquad(crack, 'bp', 2400, 1.5, sr), 0.5);
    const out = raw.slice(0, n);
    for (let i = 0; i < fade; i++) out[i] = out[i] * (i / fade) + raw[n + i] * (1 - i / fade);
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] *= 0.5 / (m || 1);
    return out;
  },
  bomb_beep(sr) {
    // the C4 beep: short, a little nasal
    const n = Math.ceil(sr * 0.11);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.004) * (t < 0.07 ? 1 : Math.exp(-(t - 0.07) / 0.012));
      out[i] = (Math.sin(2 * Math.PI * 2650 * t) + 0.25 * Math.sin(2 * Math.PI * 5300 * t)) * env;
    }
    return finish(out, -18, sr);
  },
  bomb_defused(sr, r) {
    const n = Math.ceil(sr * 0.4);
    const out = clicks(n, sr, r, [[0, 0.9], [0.09, 0.7]], 2600);
    for (let i = Math.round(0.16 * sr); i < n; i++) {
      const t = i / sr - 0.16;
      out[i] += Math.sin(2 * Math.PI * 1900 * t) * Math.min(1, t / 0.004) * Math.exp(-t / 0.06) * 0.35;
    }
    return finish(out, -16, sr);
  },
  // Fallbacks for the recorded sounds (used until / unless the files load).
  step(sr, r) {
    const n = Math.ceil(sr * 0.1);
    const out = envelope(biquad(noise(n, r), 'lp', 600, 0.7, sr), sr, 0.002, 0.02);
    mixInto(out, envelope(biquad(noise(n, r), 'bp', 2500, 1.2, sr), sr, 0.001, 0.01, 0.008), 0.25);
    return finish(out, -15, sr);
  },
  hit: (sr, r) => finish(envelope(biquad(noise(Math.ceil(sr * 0.1), r), 'lp', 350, 0.7, sr), sr, 0.001, 0.025), -12, sr),
  headshot: (sr, r) => finish(envelope(biquad(noise(Math.ceil(sr * 0.12), r), 'lp', 500, 0.7, sr), sr, 0.001, 0.03), -12, sr),
  helmet: (sr, r) => finish(clicks(Math.ceil(sr * 0.08), sr, r, [[0, 0.5]], 5200), -14, sr),
  bounce: (sr, r) => finish(clicks(Math.ceil(sr * 0.06), sr, r, [[0, 0.35]], 2200), -16, sr),
  glass: (sr, r) => finish(envelope(biquad(noise(Math.ceil(sr * 0.3), r), 'hp', 3500, 0.7, sr), sr, 0, 0.06), -15, sr),
  bomb_planted: (sr, r) => finish(clicks(Math.ceil(sr * 0.2), sr, r, [[0, 0.7], [0.05, 0.5]], 1800), -14, sr),
};

/** Take ``take`` of the synthesised sound ``name`` (Float32Array, mono), or null. */
export function synthesize(name, sampleRate, take = 0) {
  const recipe = RECIPES[name];
  return recipe ? recipe(sampleRate, rng(name.length * 7919 + take * 104729 + 1)) : null;
}

// Recordings (web/audio/*.wav, CC0): name -> files.
export const SAMPLES = {
  step: ['step_0', 'step_1', 'step_2', 'step_3', 'step_4'],
  hit: ['hit_0', 'hit_1', 'hit_2', 'hit_3'],
  headshot: ['headshot_0', 'headshot_1', 'headshot_2'],
  helmet: ['helmet_0', 'helmet_1', 'helmet_2', 'helmet_3'],
  bounce: ['bounce_0', 'bounce_1', 'bounce_2', 'bounce_3'],
  glass: ['glass_0', 'glass_1', 'glass_2'],
  bomb_planted: ['plant_0', 'plant_1', 'plant_2'],
};

// -- sound bank -------------------------------------------------------------------------------

let overrideFiles = null; // name -> ArrayBuffer (raw file), fetched once
let sampleFiles = null; // file -> ArrayBuffer

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

async function fetchSamples() {
  if (sampleFiles) return sampleFiles;
  sampleFiles = {};
  const files = [...new Set(Object.values(SAMPLES).flat())];
  await Promise.all(files.map(async (f) => {
    try {
      const res = await fetch(new URL(`../audio/${f}.wav`, import.meta.url));
      if (res.ok) sampleFiles[f] = await res.arrayBuffer();
    } catch (_) { /* offline: synthesised fallback */ }
  }));
  return sampleFiles;
}

/**
 * Sounds for one (Offline)AudioContext: user overrides, then the recordings,
 * then synthesis. ``get(name, key)`` picks one of the takes by ``key``.
 */
export class SoundBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.takes = new Map(); // name -> [AudioBuffer]
  }

  async load() {
    const [over, samples] = await Promise.all([fetchOverrides(), fetchSamples()]);
    const decode = async (data) => {
      try { return await this.ctx.decodeAudioData(data.slice(0)); } catch (err) { console.warn('bad sound', err); return null; }
    };
    for (const [name, files] of Object.entries(SAMPLES)) {
      if (over[name]) continue;
      const bufs = (await Promise.all(files.filter((f) => samples[f]).map((f) => decode(samples[f])))).filter(Boolean);
      if (bufs.length) this.takes.set(name, bufs);
    }
    for (const [name, data] of Object.entries(over)) {
      const buf = await decode(data);
      if (buf) this.takes.set(name, [buf]);
    }
    return this;
  }

  get(name, key = 0) {
    let list = this.takes.get(name);
    if (!list) {
      if (!RECIPES[name]) return null;
      const sr = this.ctx.sampleRate;
      list = [];
      for (let v = 0; v < VARIANTS; v++) {
        const data = synthesize(name, sr, v);
        const buf = this.ctx.createBuffer(1, data.length, sr);
        buf.copyToChannel(data, 0);
        list.push(buf);
      }
      this.takes.set(name, list);
    }
    return list[Math.abs(key | 0) % list.length];
  }

  /** The room: a stereo impulse response (early reflections, a darkening 1.1 s tail). */
  impulse() {
    if (this._ir) return this._ir;
    const sr = this.ctx.sampleRate;
    const n = Math.ceil(sr * 1.6);
    const ir = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      const r = rng(4242 + ch * 99);
      const pre = Math.round(0.01 * sr);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        const fc = 1500 + 8000 * Math.exp(-t / 0.3); // highs die first
        lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (r() * 2 - 1 - lp);
        d[i] = lp * Math.exp((-6.9 * t) / 1.1) * Math.min(1, 0.25 + t / 0.03);
      }
      for (const [ms, g] of [[8, 0.6], [13, 0.45], [21, 0.35], [29, 0.28], [41, 0.2], [55, 0.14]]) {
        const i = pre + Math.round(((ms + (ch ? 1.3 : 0)) * sr) / 1000);
        if (i < n) d[i] += g * (r() < 0.5 ? 1 : -1) * ((ms + ch) % 2 ? 1 : 0.7);
      }
    }
    this._ir = ir;
    return ir;
  }
}

/** A soft limiter: transparent below -3 dBFS, rounding peaks off up to 0 dB (signal / 2 in, see buildGraph). */
function softClipCurve() {
  const n = 4097, curve = new Float32Array(n), knee = 0.7, room = 0.99 - knee;
  for (let i = 0; i < n; i++) {
    const v = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(v);
    curve[i] = a < knee ? v : Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

/**
 * The mixing graph of a context: game sounds (dry + a send into the room
 * reverb) and voice chat, summed, through a soft limiter into ``out``
 * (volume). The sounds are levelled when made, so there's no compressor to
 * pump the mix.
 */
export function buildGraph(ctx, bank) {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = '2x';
  clip.connect(out);
  const master = ctx.createGain();
  master.gain.value = 0.5 * 0.8; // the curve takes signal / 2
  master.connect(clip);
  const game = ctx.createGain();
  game.connect(master);
  const verb = ctx.createConvolver();
  verb.buffer = bank.impulse();
  const verbOut = ctx.createGain();
  verbOut.gain.value = 0.8;
  verb.connect(verbOut).connect(game);
  const voice = ctx.createGain();
  voice.gain.value = VOICE_GAIN;
  voice.connect(master);
  return { out, game, verb, voice };
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

// Level of each kind of sound in the mix (the synthesised ones are made at
// their loudness already: guns ≈ -11 dB, explosions -7), and the distance
// (units) a sound fades out over.
const LOUD = {
  he: 1.2, c4_explode: 1.5, smoke: 0.6, molotov: 0.6, glass: 0.7, step: 0.4, hit: 0.35, headshot: 0.45, helmet: 0.55,
  bounce: 0.45, bomb_beep: 1, bomb_planted: 0.6, knife: 0.6, throw: 0.5, taser: 0.8,
};
const RANGE = {
  step: 1100, hit: 700, headshot: 1100, helmet: 1300, throw: 700, knife: 700, bounce: 1000, silenced: 1600,
  bomb_beep: 2200, fire_loop: 1200, glass: 1500,
};

function lowerBound(list, tick) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][0] < tick) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Footsteps derived from movement: a step every ~78 units while running (CS walking is silent). */
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
 * Where grenades hit the ground or a wall: [tick, x, y, z] sorted by tick.
 * In flight a grenade's velocity only changes by gravity; anything else is
 * an impact.
 */
export function grenadeBounces(demo) {
  if (demo._bounces) return demo._bounces;
  const out = [];
  const g = 800 / (demo.tickRate * demo.tickRate); // sv_gravity, units / tick²
  for (const gr of demo.grenades || []) {
    const { ticks, pts } = gr;
    const vel = (i) => {
      const dt = Math.max(1, ticks[i + 1] - ticks[i]);
      return [(pts[i * 3 + 3] - pts[i * 3]) / dt, (pts[i * 3 + 4] - pts[i * 3 + 1]) / dt, (pts[i * 3 + 5] - pts[i * 3 + 2]) / dt];
    };
    let last = -Infinity;
    for (let i = 1; i + 1 < ticks.length; i++) {
      const a = vel(i - 1), b = vel(i);
      const speed = Math.hypot(...a);
      if (speed < 1.5) continue; // resting or rolling slowly
      const dt = (ticks[i + 1] - ticks[i - 1]) / 2;
      const off = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2] + g * dt);
      if (off > Math.max(1.2, 0.3 * speed) && ticks[i] - last > demo.tickRate * 0.15) {
        out.push([ticks[i], pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]);
        last = ticks[i];
      }
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  demo._bounces = out;
  return out;
}

/**
 * Each planted bomb: {plant, end, how, pos}. It ticks until it is defused or
 * explodes (``how``), or until the round is over without either: in CS2 the
 * round ends at once when every CT is dead, and the bomb is gone with it.
 */
export function bombTimers(demo) {
  if (demo._bombTimers) return demo._bombTimers;
  const out = [];
  const starts = (demo.rounds || []).map((r) => r.start);
  const bomb = demo.bomb || [];
  bomb.forEach((b, i) => {
    if (b.type !== 'plant') return;
    let end = Math.min(b.tick + (C4_TIMER + 3) * demo.tickRate, demo.endTick ?? Infinity);
    const next = starts.find((s) => s > b.tick);
    if (next !== undefined) end = Math.min(end, next);
    let how = null;
    for (let j = i + 1; j < bomb.length && bomb[j].tick <= end; j++) {
      if (bomb[j].type === 'plant') { end = bomb[j].tick; break; }
      if (bomb[j].type === 'defuse' || bomb[j].type === 'explode') {
        end = bomb[j].tick;
        how = bomb[j].type;
        break;
      }
    }
    out.push({ plant: b.tick, end, how, pos: b.pos });
  });
  demo._bombTimers = out;
  return out;
}

/**
 * Sound events with tick in (t0, t1]. Each: {tick, name, pos:[x,y,z] (world) | null, gain, player, key}.
 * ``opts.footsteps === false`` leaves footsteps out (fast playback).
 */
export function collectEvents(demo, t0, t1, _listenerPlayer = -1, opts = {}) {
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
    if (name) out.push({ tick, name, pos: posOf(p, tick), gain: 1, player: p, key: i });
  }
  if (soundPrefs.hits) {
    for (let i = lowerBound(demo.hurts, t0 + 1e-6); i < demo.hurts.length; i++) {
      const h = demo.hurts[i];
      if (h[0] > t1) break;
      if (h[0] <= t0) continue;
      const pos = posOf(h[2], h[0] - 1);
      let name = 'hit';
      if (h[5] === 'head') name = st.helmet ? 'helmet' : 'headshot';
      out.push({ tick: h[0], name, pos, gain: 1, player: h[2], key: i });
    }
  }
  const fx = demo.effects || {};
  const point = (list, name, key = 'tick') => {
    (list || []).forEach((e, i) => {
      const t = e[key];
      if (t > t0 && t <= t1) out.push({ tick: t, name, pos: e.pos, gain: 1, key: i });
    });
  };
  point(fx.hes, 'he');
  point(fx.flashes, 'flash');
  point(fx.smokes, 'smoke', 'start');
  point(fx.infernos, 'molotov', 'start');
  point(fx.infernos, 'glass', 'start');
  (demo.grenades || []).forEach((g, i) => {
    const t = g.ticks[0];
    if (t > t0 && t <= t1) out.push({ tick: t, name: 'throw', pos: [g.pts[0], g.pts[1], g.pts[2]], gain: 1, key: i });
  });
  const bounces = grenadeBounces(demo);
  for (let i = lowerBound(bounces, t0 + 1e-6); i < bounces.length && bounces[i][0] <= t1; i++) {
    const [tick, x, y, z] = bounces[i];
    out.push({ tick, name: 'bounce', pos: [x, y, z], gain: 1, key: i });
  }
  // Bomb: plant, beeps speeding up while it ticks, defuse, explosion.
  for (const c4 of bombTimers(demo)) {
    if (c4.plant > t1) break;
    if (c4.end <= t0) continue;
    const { pos } = c4;
    if (c4.plant > t0) out.push({ tick: c4.plant, name: 'bomb_planted', pos, gain: 1 });
    if (c4.how && c4.end > t0 && c4.end <= t1) {
      out.push({ tick: c4.end, name: c4.how === 'defuse' ? 'bomb_defused' : 'c4_explode', pos, gain: 1 });
    }
    let t = c4.plant + demo.tickRate;
    while (t < c4.end && t <= t1) {
      if (t > t0) out.push({ tick: t, name: 'bomb_beep', pos, gain: 1 });
      const elapsed = (t - c4.plant) / demo.tickRate;
      t += demo.tickRate * Math.max(0.12, 1 - elapsed / 42);
    }
  }
  if (opts.footsteps !== false && soundPrefs.steps) {
    const steps = synthFootsteps(demo);
    for (let i = lowerBound(steps, t0 + 1e-6); i < steps.length; i++) {
      const [tick, p] = steps[i];
      if (tick > t1) break;
      if (tick > t0) out.push({ tick, name: 'step', pos: posOf(p, tick).map((v, j) => (j === 2 ? v - 48 : v)), gain: 1, player: p, key: i });
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
 * Gain / pan / low-pass / reverb send for a source at world ``pos`` heard by
 * ``listener`` ({x, y, z, yaw} in world units, yaw in degrees). Far sounds
 * lose their highs and are mostly room.
 */
export function spatial(listener, pos, name) {
  if (!pos || !listener) return { gain: 1, pan: 0, cutoff: 20000, wet: 0.12 };
  const dx = pos[0] - listener.x, dy = pos[1] - listener.y, dz = pos[2] - listener.z;
  const d = Math.hypot(dx, dy, dz);
  const range = RANGE[name] || 3600;
  if (d > range * 1.5) return null;
  // ~6 dB per doubling of distance past ``near``, faded out from 0.6 to 1.5 x range
  const near = range * 0.2;
  const fade = Math.min(1, (range * 1.5 - d) / (range * 0.9));
  const gain = (near / (near + d)) * fade;
  const yaw = (listener.yaw * Math.PI) / 180;
  // listener right vector in world XY: (sin yaw, -cos yaw)
  const h = Math.hypot(dx, dy) || 1;
  const pan = Math.max(-1, Math.min(1, ((dx * Math.sin(yaw) - dy * Math.cos(yaw)) / h) * 0.75));
  const cutoff = 18000 - 15000 * Math.min(1, Math.max(0, (d - 250) / 2600));
  // The room's share falls off slower than the direct sound.
  const wet = 0.1 + 0.32 * Math.min(1, d / 2200) * fade + 0.08 * (1 - gain);
  return { gain, pan, cutoff, wet };
}

/** Play ``buffer`` at ``when`` through filter + pan into the graph's dry bus and the room send. */
export function play(ctx, graph, buffer, when, sp, gain, rate = 1) {
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
  src.connect(lp).connect(pan).connect(g).connect(graph.game);
  const send = ctx.createGain();
  send.gain.value = gain * Math.max(sp.gain, 0.05) * sp.wet * 5.5;
  lp.connect(send).connect(graph.verb);
  src.start(Math.max(when, 0));
  return { src, gain: g, send };
}

/** A slight, repeatable pitch variation per event. */
const jitter = (key) => 1 + (((key * 2654435761) >>> 0) / 4294967296 - 0.5) * 0.06;

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
    this.duckUntil = 0;
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
    this.bank = new SoundBank(this.ctx);
    this.bank.load();
    this.graph = buildGraph(this.ctx, this.bank);
    this._applyVolume();
    return this.ctx;
  }

  setVolume(v) { this.volume = v; this._applyVolume(); this._save(); }
  setMuted(m) { this.muted = m; this._applyVolume(); this._save(); }
  _applyVolume() { if (this.graph) this.graph.out.gain.value = this.muted ? 0 : this.volume; }
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
      const buf = this.bank.get(e.name, e.key ?? 0);
      const sp = spatial(listener, e.pos, e.name);
      if (!buf || !sp) continue;
      const offset = ((e.tick - prev) / demo.tickRate) / speed;
      play(ctx, this.graph, buf, ctx.currentTime + 0.02 + offset, sp, (LOUD[e.name] || 1) * e.gain, rate * jitter(e.key ?? 0));
      n++;
    }
    // Burning molotovs: looping crackle while active.
    const active = activeFires(demo, tick);
    const keep = new Set();
    for (const f of active) {
      keep.add(f.key);
      const sp = spatial(listener, f.pos, 'fire_loop') || { gain: 0, pan: 0, cutoff: 2000, wet: 0.2 };
      let node = this.fires.get(f.key);
      if (!node) {
        node = play(ctx, this.graph, this.bank.get('fire_loop'), ctx.currentTime, sp, 0.5, rate);
        node.src.loop = true;
        this.fires.set(f.key, node);
      }
      node.gain.gain.value = 0.5 * sp.gain;
    }
    for (const [key, node] of this.fires) {
      if (!keep.has(key)) { node.src.stop(); this.fires.delete(key); }
    }
  }

  stopFires() {
    for (const node of this.fires.values()) node.src.stop();
    this.fires.clear();
  }

  /** Lower the game from ``start`` to ``end`` (context time) so speech stays clear. */
  _duck(start, end) {
    const g = this.graph.game.gain;
    this.duckUntil = Math.max(this.duckUntil, end);
    g.cancelScheduledValues(start);
    g.setTargetAtTime(DUCK, start, 0.05);
    g.setTargetAtTime(1, this.duckUntil, 0.2);
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
      track.ready().catch(() => {});
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
      const dur = pcm.length / VOICE_SAMPLE_RATE - offset;
      if (dur < 0.02) continue;
      const src = ctx.createBufferSource();
      src.buffer = voiceBuffer(ctx, pcm);
      src.playbackRate.value = rate;
      src.connect(this.graph.voice);
      src.onended = () => { if (this.voiceSources.get(s) === src) this.voiceSources.delete(s); };
      const at = ctx.currentTime + 0.02;
      src.start(at, offset);
      this._duck(at, at + dur / rate);
      this.voiceSources.set(s, src);
    }
  }

  stopVoice() {
    for (const src of this.voiceSources.values()) {
      try { src.stop(); } catch (_) { /* not started */ }
    }
    this.voiceSources.clear();
    this.voiceKey = '';
    if (this.graph && this.duckUntil) {
      const g = this.graph.game.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(1, this.ctx.currentTime, 0.1);
      this.duckUntil = 0;
    }
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
 * ``listenerAt(tick)`` -> {x, y, z, yaw} hears from elsewhere (a moving camera).
 */
export async function renderClipAudio(demo, ticks, fps, player, { sampleRate = 48000, voice = 'off', listenerAt = null } = {}) {
  const duration = ticks.length / fps;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const bank = await new SoundBank(ctx).load();
  const graph = buildGraph(ctx, bank);
  graph.out.gain.value = 0.9;
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
  listenerAt ||= (tick) => {
    demo.state(player, tick, st);
    return { x: st.x, y: st.y, z: st.z + 64, yaw: st.yaw };
  };
  for (const e of collectEvents(demo, t0 - 1e-6, t1, player)) {
    const buf = bank.get(e.name, e.key ?? 0);
    const speed = localSpeed(e.tick);
    if (!buf || speed > 1.5) continue;
    const sp = spatial(listenerAt(e.tick), e.pos, e.name);
    if (!sp) continue;
    const rate = Math.max(0.55, Math.min(1, speed)) * jitter(e.key ?? 0);
    play(ctx, graph, buf, timeOf(e.tick), sp, (LOUD[e.name] || 1) * e.gain, rate);
  }
  for (const f of demo.effects?.infernos || []) {
    if (f.end <= t0 || f.start >= t1) continue;
    const start = timeOf(Math.max(f.start, t0)), end = timeOf(Math.min(f.end, t1));
    const sp = spatial(listenerAt(Math.max(f.start, t0)), f.pos, 'fire_loop');
    if (!sp || end - start < 0.3 * ((Math.min(f.end, t1) - Math.max(f.start, t0)) / demo.tickRate)) continue;
    const node = play(ctx, graph, bank.get('fire_loop'), start, sp, 0.5);
    node.src.loop = true;
    node.src.stop(end);
  }
  try {
    await mixVoice(ctx, graph, demo, ticks, timeOf, voice, player);
  } catch (err) {
    console.warn('voice chat left out of the clip', err); // the game sound still records
  }
  return ctx.startRendering();
}

/**
 * Voice chat for a clip. Speech always plays at normal speed from the moment
 * it starts in the clip (slow motion and fast-forward don't pitch it); a
 * player's next spurt waits for the previous one, or is dropped when it would
 * come more than 2 s late. The game ducks under it.
 */
async function mixVoice(ctx, graph, demo, ticks, timeOf, mode, focus) {
  const allow = voiceFilter(demo, mode, focus);
  const track = demo.voice;
  if (!allow || !track.available || !(await track.ready())) return;
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const busy = new Map(); // player -> time their audio ends
  const spans = [];
  const rate = demo.tickRate;
  const total = ctx.length / ctx.sampleRate;
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
    if (at >= total) continue;
    const src = ctx.createBufferSource();
    src.buffer = voiceBuffer(ctx, pcm);
    src.connect(graph.voice);
    src.start(at, offset);
    busy.set(s.player, at + dur);
    spans.push([at, Math.min(total, at + dur)]);
  }
  // Duck the game under the speech (overlapping spans merged).
  spans.sort((a, b) => a[0] - b[0]);
  const g = graph.game.gain;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    g.setTargetAtTime(DUCK, Math.max(0, cur[0] - 0.03), 0.05);
    g.setTargetAtTime(1, cur[1], 0.2);
  };
  for (const span of spans) {
    if (cur && span[0] <= cur[1] + 0.3) cur[1] = Math.max(cur[1], span[1]);
    else { flush(); cur = [...span]; }
  }
  flush();
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
