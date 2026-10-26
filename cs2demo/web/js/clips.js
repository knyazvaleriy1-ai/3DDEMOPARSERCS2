// Clip recording. A ClipDirector turns a highlight into a deterministic list of
// frames (camera mode, timing, optional slow motion). Frames are then encoded:
//  * in the browser with WebCodecs + mp4-muxer (frame-exact H.264 MP4, faster
//    than real time on most GPUs),
//  * or, where WebCodecs is missing, in real time with MediaRecorder (WebM),
//  * or by the headless renderer (Python + Chromium), via window.cs2render.
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { encodeWav, renderClipAudio } from './audio.js';

export const POV_TO_MODE = { first: 'pov', third: 'chase', overview: 'overview' };
export const POV_LABELS = { first: 'От первого лица', third: 'Из-за спины', overview: 'Сверху (следить)' };

export function clipTicks(h, fps, slowmo, rate) {
  const out = [];
  const step = rate / fps;
  let t = h.start;
  const kills = h.killTicks || [];
  while (t <= h.end && out.length < 60000) {
    out.push(t);
    let speed = 1;
    if (slowmo) {
      for (const k of kills) {
        const d = Math.abs(t - k) / rate;
        if (d < 0.6) speed = Math.min(speed, 0.3 + 0.7 * (d / 0.6) ** 2);
      }
    }
    t += step * speed;
  }
  return out;
}

export class ClipDirector {
  constructor(viewer, highlight, opts = {}) {
    this.viewer = viewer;
    this.h = highlight;
    this.opts = {
      pov: 'first', fps: 30, slowmo: false, hud: true, sound: true, width: 1280, height: 720, ...opts,
    };
    this.opts.width -= this.opts.width % 2;
    this.opts.height -= this.opts.height % 2;
    this.ticks = clipTicks(highlight, this.opts.fps, this.opts.slowmo, viewer.demo.tickRate);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.opts.width;
    this.canvas.height = this.opts.height;
    this.started = false;
  }

  get count() { return this.ticks.length; }

  start() {
    const v = this.viewer;
    this.saved = {
      mode: v.mode, focus: v.focus, tick: v.tick, playing: v.playing, clip: v.clip,
      fixed: v.fixedSize, target: v.controls.target.clone(), cam: v.camera.position.clone(), keys: v.settings.keys,
    };
    if (this.opts.keys !== undefined) v.settings.keys = !!this.opts.keys;
    v.pause();
    v.externalDriver = true;
    v.setFixedSize({ width: this.opts.width, height: this.opts.height });
    v.tick = this.ticks[0];
    v.setMode(POV_TO_MODE[this.opts.pov] || 'pov', this.h.player);
    v.clip = this.opts.hud ? { ...this.h, badge: this.opts.badge || null, match: this.opts.match || null } : null;
    this.started = true;
  }

  render(i) {
    if (!this.started) this.start();
    const v = this.viewer;
    v.tick = this.ticks[Math.min(i, this.ticks.length - 1)];
    v.update(1 / this.opts.fps);
    v.composite(this.canvas, this.opts.hud);
    return this.canvas;
  }

  finish() {
    if (!this.started) return;
    const v = this.viewer;
    const s = this.saved;
    v.externalDriver = false;
    v.settings.keys = s.keys;
    v.clip = s.clip;
    v.setFixedSize(s.fixed);
    v.tick = s.tick;
    v.setMode(s.mode, s.focus);
    v.controls.target.copy(s.target);
    v.camera.position.copy(s.cam);
    v.controls.update();
    this.started = false;
  }

  get fileName() { return `${this.h.id}-${this.opts.pov}`; }

  /** The clip's soundtrack (AudioBuffer) or null when sound is off / unsupported. */
  async audio() {
    if (!this.opts.sound || typeof OfflineAudioContext === 'undefined') return null;
    if (!this._audio) this._audio = await renderClipAudio(this.viewer.demo, this.ticks, this.opts.fps, this.h.player);
    return this._audio;
  }

  get info() {
    const h = this.h, o = this.opts;
    return {
      highlight: h.id, title: h.title, player: h.playerName, round: h.round, score: h.score,
      tags: h.tags, pov: o.pov, width: o.width, height: o.height, fps: o.fps,
      duration: +(this.count / o.fps).toFixed(2), codec: this.codec || null, audioCodec: this.audioCodec || null,
    };
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const yieldTask = () => new Promise((r) => setTimeout(r, 0));

// H.264 first (plays everywhere); VP9-in-MP4 as a fallback for browsers
// without an H.264 encoder (the server re-encodes those to H.264).
const CODECS = [
  ['avc1.640034', 'avc'], ['avc1.640033', 'avc'], ['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'],
  ['avc1.42001f', 'avc'], ['vp09.00.40.08', 'vp9'], ['vp09.00.10.08', 'vp9'],
];

async function pickEncoderConfig(width, height, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = Math.round(Math.min(40e6, Math.max(2e6, width * height * fps * 0.14)));
  for (const [codec, mux] of CODECS) {
    const config = { codec, width, height, bitrate, framerate: fps };
    if (mux === 'avc') config.avc = { format: 'avc' };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return { config, mux };
    } catch (_) { /* try next */ }
  }
  return null;
}

export async function webCodecsSupported(width = 1280, height = 720, fps = 30) {
  return !!(await pickEncoderConfig(width, height, fps));
}

// AAC where the browser can encode it (Windows / macOS Chrome), Opus otherwise
// (the server converts Opus to AAC when saving the clip).
async function pickAudioConfig(sampleRate, channels) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate, numberOfChannels: channels, bitrate: 160000 };
    try {
      const { supported } = await AudioEncoder.isConfigSupported(config);
      if (supported) return { config, mux };
    } catch (_) { /* try next */ }
  }
  return null;
}

async function encodeAudio(buffer, muxer, picked) {
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  enc.configure(picked.config);
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, block = 4800;
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let start = 0; start < buffer.length; start += block) {
    const n = Math.min(block, buffer.length - start);
    const planar = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(start, start + n), c * n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch,
      timestamp: Math.round((start / sr) * 1e6), data: planar,
    });
    enc.encode(data);
    data.close();
    if (failure) throw failure;
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
}

/** Frame-exact export to MP4 with WebCodecs. Returns a Blob. */
export async function exportMp4(director, { onProgress, signal } = {}) {
  const { width, height, fps } = director.opts;
  const picked = await pickEncoderConfig(width, height, fps);
  if (!picked) throw new Error('WebCodecs недоступен');
  const { config, mux } = picked;
  director.codec = mux;
  onProgress?.(0);
  const sound = await director.audio();
  const audioPick = sound ? await pickAudioConfig(sound.sampleRate, sound.numberOfChannels) : null;
  director.audioCodec = audioPick ? audioPick.mux : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: mux, width, height, frameRate: fps },
    audio: audioPick ? { codec: audioPick.mux, sampleRate: sound.sampleRate, numberOfChannels: sound.numberOfChannels } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  if (audioPick) await encodeAudio(sound, muxer, audioPick);
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(config);
  const frameUs = 1e6 / fps;
  try {
    director.start();
    const n = director.count;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      if (failure) throw failure;
      const canvas = director.render(i);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await yieldTask();
      if (i % 4 === 0) {
        onProgress?.(i / n);
        await nextFrame();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
  } finally {
    director.finish();
    if (encoder.state !== 'closed') encoder.close();
  }
  onProgress?.(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

function recorderMime() {
  const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

/** Real-time fallback: plays the clip once while MediaRecorder captures it. */
export async function exportRealtime(director, { onProgress, signal } = {}) {
  if (!window.MediaRecorder) throw new Error('Браузер не умеет записывать видео (нет MediaRecorder)');
  const { fps, width, height } = director.opts;
  const mime = recorderMime();
  const sound = await director.audio();
  director.start();
  const stream = director.canvas.captureStream(fps);
  let audioCtx = null, audioSrc = null;
  if (sound) {
    audioCtx = new AudioContext({ sampleRate: sound.sampleRate });
    const dest = audioCtx.createMediaStreamDestination();
    audioSrc = audioCtx.createBufferSource();
    audioSrc.buffer = sound;
    audioSrc.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const rec = new MediaRecorder(stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: Math.round(Math.min(25e6, width * height * fps * 0.12)),
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  try {
    director.render(0);
    rec.start(500);
    if (audioSrc) audioSrc.start();
    const t0 = performance.now();
    const n = director.count;
    for (;;) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      await nextFrame();
      const i = Math.floor(((performance.now() - t0) / 1000) * fps);
      if (i >= n) break;
      director.render(i);
      onProgress?.(i / n);
    }
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close();
    director.finish();
  }
  onProgress?.(1);
  return new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
}

export async function uploadClip(demoId, director, blob) {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', blob, `${director.fileName}.${ext}`);
  form.append('name', director.fileName);
  form.append('info', JSON.stringify(director.info));
  const res = await fetch(`/api/demos/${demoId}/clips`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Не удалось сохранить клип (${res.status})`);
  return res.json();
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** API used by the headless renderer (cs2demo/recorder.py). */
export function installRenderApi(viewer, getDemo) {
  let director = null;
  const api = {
    ready: false,
    error: null,
    begin(id, opts) {
      const demo = getDemo();
      const h = demo.highlights.find((x) => x.id === id);
      if (!h) throw new Error(`нет хайлайта ${id}`);
      if (director) director.finish();
      director = new ClipDirector(viewer, h, {
        ...opts, width: window.innerWidth, height: window.innerHeight,
      });
      director.start();
      return { frames: director.count };
    },
    frames(a, b) {
      const out = [];
      const q = director.opts.quality ?? 0.9;
      for (let i = a; i < b; i++) out.push(director.render(i).toDataURL('image/jpeg', q));
      return out;
    },
    /** The current clip's soundtrack as a base64 WAV (null when sound is off). */
    async audio() {
      const buf = director ? await director.audio() : null;
      if (!buf) return null;
      const bytes = new Uint8Array(encodeWav(buf));
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    end() {
      if (director) director.finish();
      director = null;
    },
  };
  window.cs2render = api;
  return api;
}
