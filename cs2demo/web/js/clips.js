// Clip recording. A ClipDirector turns a highlight into a deterministic list of
// frames (camera mode, timing, optional slow motion). Frames are then encoded:
//  * in the browser with WebCodecs + Mediabunny (frame-exact H.264 + AAC MP4,
//    faster than real time on most GPUs),
//  * or, where WebCodecs is missing, in real time with MediaRecorder (WebM),
//  * or by the headless renderer (Python + Chromium), via window.cs2render.
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

// MP4 writing (Mediabunny), loaded on first use. Audio is always AAC: it plays
// everywhere (Opus in MP4 is silent in iOS players and many galleries). Where
// the browser can't encode AAC itself (Chrome on Linux / Android, Safari
// without AudioEncoder), a WebAssembly build of FFmpeg's AAC encoder does it.
let mediabunny = null;
function loadMediabunny() {
  if (!mediabunny) {
    mediabunny = (async () => {
      const mb = await import('../vendor/mediabunny/mediabunny.min.mjs');
      if (!(await mb.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE }))) {
        const { registerAacEncoder } = await import('../vendor/mediabunny/mediabunny-aac-encoder.min.mjs');
        registerAacEncoder();
      }
      return mb;
    })();
    mediabunny.catch(() => { mediabunny = null; });
  }
  return mediabunny;
}

const AUDIO_BITRATE = 160000;
const videoBitrate = (width, height, fps) => Math.round(Math.min(40e6, Math.max(2e6, width * height * fps * 0.14)));

// H.264 first (plays everywhere); VP9-in-MP4 for browsers without an H.264
// encoder (the server re-encodes those to H.264).
async function pickVideoCodec(mb, width, height, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  return mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height, bitrate: videoBitrate(width, height, fps) });
}

export async function webCodecsSupported(width = 1280, height = 720, fps = 30) {
  try {
    return !!(await pickVideoCodec(await loadMediabunny(), width, height, fps));
  } catch (err) {
    console.warn('webcodecs check', err);
    return false;
  }
}

/** Frame-exact export to MP4 (H.264 + AAC) with WebCodecs. Returns a Blob. */
export async function exportMp4(director, { onProgress, signal } = {}) {
  const mb = await loadMediabunny();
  const { width, height, fps } = director.opts;
  const codec = await pickVideoCodec(mb, width, height, fps);
  if (!codec) throw new Error('WebCodecs недоступен');
  director.codec = codec;
  onProgress?.(0);
  const sound = await director.audio();
  let audioCodec = null;
  if (sound) {
    const opts = { numberOfChannels: sound.numberOfChannels, sampleRate: sound.sampleRate, bitrate: AUDIO_BITRATE };
    for (const c of ['aac', 'opus']) {
      if (await mb.canEncodeAudio(c, opts)) { audioCodec = c; break; }
    }
    if (!audioCodec) console.warn('no audio encoder: the clip will be silent');
  }
  director.audioCodec = audioCodec;
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const video = new mb.CanvasSource(director.canvas, {
    codec, bitrate: videoBitrate(width, height, fps), keyFrameInterval: 2,
  });
  output.addVideoTrack(video, { frameRate: fps });
  const audio = audioCodec ? new mb.AudioBufferSource({ codec: audioCodec, bitrate: AUDIO_BITRATE }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  try {
    if (audio) await audio.add(sound);
    director.start();
    const n = director.count;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      director.render(i);
      await video.add(i / fps, 1 / fps);
      if (i % 4 === 0) {
        onProgress?.(i / n);
        await nextFrame();
      }
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    director.finish();
  }
  onProgress?.(1);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
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
    // Created after awaits, i.e. outside the click: mobile browsers start it
    // suspended, which records silence.
    await audioCtx.resume().catch(() => {});
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
