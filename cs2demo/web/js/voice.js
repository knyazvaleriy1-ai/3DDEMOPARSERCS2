// Voice chat recorded in the demo (FACEIT, ESEA and players' own POV demos;
// GOTV demos of pro matches usually have none). The parser keeps the raw
// packets ("voice" + "voiceData" sections); they are decoded here with libopus
// compiled to WebAssembly, one talk spurt at a time. Since the 2024 Arms Race
// update a packet is one Opus frame; older demos use Steam's voice format
// (a header, then several Opus frames), handled too.
//
// Speech is levelled per spurt (people talk at very different volumes) so it
// stays clear over gunfire; audio.js also ducks the game while someone talks.

const SAMPLE_RATE = 48000;
// A packet arriving this many ticks after the audio decoded so far would end
// starts a new spurt (aligned to its own tick, so timing never drifts).
const GAP_TICKS = 6;
const CACHE_SAMPLES = 60 * SAMPLE_RATE;
const TARGET_RMS = 0.11; // ~ -19 dBFS speech
const MAX_GAIN = 6;

/** Who is heard: everyone, the followed player's team, only them, one side, nobody. */
export const VOICE_MODES = ['all', 'team', 'player', 'T', 'CT', 'off'];
export const VOICE_LABELS = {
  all: 'Все', team: 'Команда игрока', player: 'Только игрок', T: 'Только T', CT: 'Только CT', off: 'Выкл',
};

let opusLib = null;
function loadOpus() {
  if (!opusLib) {
    // UMD bundle: as a module it registers itself on globalThis.
    opusLib = import('../vendor/opus/opus-decoder.min.mjs').then(() => globalThis['opus-decoder'].OpusDecoder);
    opusLib.catch(() => { opusLib = null; });
  }
  return opusLib;
}

/** Talk spurts of a demo: {player, tick, endTick, seconds, packets: [row…]} sorted by tick. */
export class VoiceTrack {
  constructor(demo) {
    this.demo = demo;
    this.rate = demo.tickRate;
    this.rows = demo.voiceRows || new Uint32Array(0);
    this.data = demo.voiceData || new Uint8Array(0);
    const n = this.rows.length / 3;
    this.offsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i] + this.rows[i * 3 + 2];
    this.spurts = [];
    const open = new Map();
    for (let i = 0; i < n; i++) {
      const tick = this.rows[i * 3], p = this.rows[i * 3 + 1];
      let s = open.get(p);
      if (!s || tick > s.endTick + GAP_TICKS) {
        s = { player: p, tick, endTick: tick, seconds: 0, packets: [] };
        open.set(p, s);
        this.spurts.push(s);
      }
      s.packets.push(i);
      s.seconds += this._packetSeconds(i);
      s.endTick = s.tick + s.seconds * this.rate;
    }
    this.maxSpan = this.spurts.reduce((m, s) => Math.max(m, s.endTick - s.tick), 0);
    this.cache = new Map();
    this.cached = 0;
    this.decoders = new Map();
    this.isReady = false;
    this._ready = null;
  }

  get available() { return this.spurts.length > 0; }

  get speakers() { return [...new Set(this.spurts.map((s) => s.player))].sort((a, b) => a - b); }

  /** The Opus frames of packet ``i`` (one, or several in Steam's voice format). */
  _frames(i) {
    return opusFrames(this.data.subarray(this.offsets[i], this.offsets[i + 1]));
  }

  /** Duration of packet ``i`` from the Opus TOC bytes (10 ms when unknown). */
  _packetSeconds(i) {
    const frames = this._frames(i);
    if (!frames.length) return 0.01;
    return frames.reduce((sum, f) => sum + opusSeconds(f), 0);
  }

  /** Load libopus and create a decoder per speaker (once). */
  ready() {
    if (!this.available) return Promise.resolve(false);
    if (!this._ready) {
      this._ready = (async () => {
        const OpusDecoder = await loadOpus();
        for (const p of this.speakers) {
          const dec = new OpusDecoder({ sampleRate: SAMPLE_RATE, channels: 1 });
          await dec.ready;
          this.decoders.set(p, dec);
        }
        this.isReady = true;
        return true;
      })();
      this._ready.catch((err) => { console.warn('voice decoder', err); this._ready = null; });
    }
    return this._ready;
  }

  /** Decoded samples (mono, 48 kHz) of a spurt; needs ready(). */
  pcm(s) {
    let out = this.cache.get(s);
    if (out) return out;
    const dec = this.decoders.get(s.player);
    if (!dec) return new Float32Array(0);
    const parts = [];
    let total = 0;
    for (const i of s.packets) {
      for (const frame of this._frames(i)) {
        try {
          const r = dec.decodeFrame(frame);
          if (r.samplesDecoded) {
            parts.push(r.channelData[0].slice(0, r.samplesDecoded));
            total += r.samplesDecoded;
          }
        } catch (_) { /* corrupt packet: skip */ }
      }
    }
    out = new Float32Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    level(out);
    this.cache.set(s, out);
    this.cached += out.length;
    for (const [key, buf] of this.cache) {
      if (this.cached <= CACHE_SAMPLES || key === s) break;
      this.cache.delete(key);
      this.cached -= buf.length;
    }
    return out;
  }

  /** First spurt index with tick > t. */
  _after(t) {
    let lo = 0, hi = this.spurts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.spurts[mid].tick <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Spurts starting in (t0, t1]. */
  starting(t0, t1) {
    const out = [];
    for (let i = this._after(t0); i < this.spurts.length && this.spurts[i].tick <= t1; i++) out.push(this.spurts[i]);
    return out;
  }

  /** Spurts that overlap [t0, t1]. */
  overlapping(t0, t1) {
    const out = [];
    for (let i = this._after(t0 - this.maxSpan - 1); i < this.spurts.length && this.spurts[i].tick <= t1; i++) {
      const s = this.spurts[i];
      if (s.endTick >= t0) out.push(s);
    }
    return out;
  }

  /** Players talking at ``tick`` (that ``allow`` lets through). */
  speakingAt(tick, allow) {
    const out = [];
    for (const s of this.overlapping(tick, tick)) {
      if (s.tick <= tick && (!allow || allow(s.player, s.tick)) && !out.includes(s.player)) out.push(s.player);
    }
    return out;
  }
}

/** Duration of one Opus packet from its TOC byte(s). */
export function opusSeconds(bytes) {
  if (!bytes.length) return 0.01;
  const toc = bytes[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [0.01, 0.02, 0.04, 0.06][config & 3];
  else if (config < 16) frame = (config & 1) ? 0.02 : 0.01;
  else frame = [0.0025, 0.005, 0.01, 0.02][config & 3];
  const code = toc & 3;
  if (code === 0) return frame;
  if (code === 3) return frame * ((bytes[1] || 0) & 0x3f || 1);
  return frame * 2;
}

/** Is this a Steam voice packet (steamid, 0x0B, rate, codec, length, data, crc)? */
export const isSteamVoice = (b) => b.length >= 18 && b[8] === 0x0b;

/**
 * Opus frames in a voice packet: the packet itself (CS2 since 2024), or the
 * frames inside a Steam voice packet: [int16 length][uint16 sequence][frame]…
 */
export function opusFrames(b) {
  if (!b.length) return [];
  if (!isSteamVoice(b)) return [b];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[11] !== 0x06) return []; // 0x00: silence
  const len = dv.getUint16(12, true);
  const end = Math.min(b.length - 4, 14 + len);
  const out = [];
  for (let p = 14; p + 4 <= end;) {
    const n = dv.getInt16(p, true);
    if (n < 0) break; // -1: end of stream
    const frame = b.subarray(p + 4, p + 4 + n);
    if (frame.length !== n) break;
    if (n) out.push(frame);
    p += 4 + n;
  }
  return out;
}

/** Bring speech to a steady level (in place): gain toward TARGET_RMS, soft peak limit. */
function level(x) {
  let sum = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Math.abs(v) > 0.003) { sum += v * v; n++; }
  }
  if (!n) return x;
  const gain = Math.min(MAX_GAIN, Math.max(0.5, TARGET_RMS / Math.sqrt(sum / n)));
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * gain;
    x[i] = Math.abs(v) < 0.8 ? v : Math.sign(v) * (0.8 + 0.2 * Math.tanh((Math.abs(v) - 0.8) / 0.2));
  }
  return x;
}

/**
 * Filter for voice ``mode`` around the followed player ``focus``:
 * (speaker, tick) -> heard? null when voice is off.
 */
export function voiceFilter(demo, mode, focus) {
  if (!mode || mode === 'off') return null;
  const st = demo.state(0, demo.startTick);
  const sideOf = (p, tick) => {
    demo.state(p, tick, st);
    return st.present ? st.side : null;
  };
  switch (mode) {
    case 'player': return (p) => focus < 0 || p === focus;
    case 'team': return (p, tick) => focus < 0 || p === focus || sideOf(p, tick) === sideOf(focus, tick);
    case 'T':
    case 'CT': return (p, tick) => sideOf(p, tick) === mode;
    default: return () => true;
  }
}

/** An AudioBuffer holding ``samples`` (mono, 48 kHz) for ``ctx``. */
export function voiceBuffer(ctx, samples) {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), SAMPLE_RATE);
  buf.copyToChannel(samples, 0);
  return buf;
}

export const VOICE_SAMPLE_RATE = SAMPLE_RATE;
