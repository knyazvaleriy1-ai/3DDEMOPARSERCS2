// The 3D viewer: renderer, scene, camera modes and playback clock.
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { PlayerState } from './demo.js';
import { MapView } from './map.js';
import { PlayersView } from './players.js';
import { loadPlayerAssets, Viewmodel } from './skinned.js';
import { EffectsView } from './effects.js';
import { Hud } from './hud.js';
import { LiveAudio } from './audio.js';
import { clamp } from './util.js';

const POV_FOV = 73.74; // CS2: 90° horizontal at 4:3
const FREE_FOV = 55;

export const CAMERA_MODES = ['free', 'follow', 'pov', 'chase', 'top', 'overview'];

export class Viewer {
  constructor(glCanvas, hudCanvas, { interactive = true } = {}) {
    this.canvas = glCanvas;
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x14171c, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.hemi = new THREE.HemisphereLight(0xe6eeff, 0x40382c, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(0.45, 0.8, 0.35);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.camera = new THREE.PerspectiveCamera(FREE_FOV, 16 / 9, 4, 80000);
    this.controls = new OrbitControls(this.camera, glCanvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxDistance = 30000;
    this.controls.enabled = interactive;
    this.interactive = interactive;
    this.hud = new Hud(hudCanvas);
    this.audio = interactive ? new LiveAudio() : null;
    // Software GL (SwiftShader / llvmpipe, e.g. the headless clip renderer) gets
    // cheaper materials and hard shadows.
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    const quality = new URLSearchParams(location.search).get('quality');
    this.softwareGL = quality ? quality === 'low' : /swiftshader|llvmpipe|software/i.test(String(glName));
    this.hudCanvas = hudCanvas;

    this.demo = null;
    this.tick = 0;
    this.playing = false;
    this.speed = 1;
    this.mode = 'free';
    this.focus = -1;
    this.settings = {
      roofCut: 'auto', cutHeight: 400, labels: true, xray: true, grenades: true, tracers: true,
      shadows: true, grid: false, radar: false, viewmodel: true, detail: true,
    };
    this.settings.detail = !this.softwareGL;
    this.clip = null; // highlight shown with a title card (recording)
    this.fixedSize = null;
    this.listeners = new Set();
    this.states = [];
    this._smoothPos = new THREE.Vector3();
    this._smoothLook = new THREE.Vector3();
    this._hasSmooth = false;
    this._prevTarget = new THREE.Vector3();
    this._hasPrevTarget = false;
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._lastTime = performance.now();
    this._rangeEnd = null;
    this._onRangeEnd = null;

    if (interactive) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(glCanvas.parentElement);
      this.resize();
      const loop = (now) => {
        requestAnimationFrame(loop);
        const dt = Math.min(0.1, (now - this._lastTime) / 1000);
        this._lastTime = now;
        if (this.externalDriver) return;
        try {
          this.frame(dt);
        } catch (err) {
          if (!this._loggedError) console.error(err);
          this._loggedError = true;
        }
      };
      requestAnimationFrame(loop);
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(type) { for (const fn of this.listeners) fn(type, this); }

  resize() {
    const parent = this.canvas.parentElement;
    let w, h, dpr;
    if (this.fixedSize) {
      ({ width: w, height: h } = this.fixedSize);
      dpr = 1;
    } else {
      w = Math.max(2, parent.clientWidth);
      h = Math.max(2, parent.clientHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    }
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.hud.resize(Math.round(w * dpr), Math.round(h * dpr));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Render at an exact output size (used while recording); null restores. */
  setFixedSize(size) {
    this.fixedSize = size;
    this.resize();
  }

  async setDemo(demo, onProgress) {
    // this.demo is assigned last: the render loop treats it as "scene ready".
    this.states = demo.players.map(() => new PlayerState());
    this.tick = demo.rounds.length ? demo.rounds[0].freezeEnd : demo.startTick;
    const bounds = this._playerBounds(demo);
    this.map = new MapView(this.scene);
    onProgress?.(0.92, 'Загрузка карты');
    const [kind, assets] = await Promise.all([
      this.map.load(demo.meta.map, bounds, { hemi: this.hemi, sun: this.sun, renderer: this.renderer }),
      loadPlayerAssets(),
    ]);
    this.players = new PlayersView(this.scene, demo, assets);
    this.viewmodel = assets ? new Viewmodel() : null;
    this.effects = new EffectsView(this.scene, demo);
    this.demo = demo;
    this.applySettings();
    this.bounds = bounds;
    this.resetCamera();
    this.update(0);
    return kind;
  }

  _playerBounds(d) {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const stride = Math.max(1, Math.floor(d.count / 400));
    for (let f = 0; f < d.count; f += stride) {
      for (let p = 0; p < d.P; p++) {
        const fl = d.u8[(f * d.P + p) * d.U + 2];
        if (!(fl & 2)) continue;
        const i = (f * d.P + p) * 3;
        box.expandByPoint(v.set(d.pos[i], d.pos[i + 2], -d.pos[i + 1]));
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-2000, -100, -2000), new THREE.Vector3(2000, 100, 2000));
    return box;
  }

  resetCamera() {
    const b = this.bounds;
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);
    this.controls.target.copy(c);
    this.camera.position.set(c.x + span * 0.25, c.y + span * 0.75, c.z + span * 0.55);
    this.camera.fov = FREE_FOV;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  applySettings() {
    if (!this.players) return;
    this.map.setOptions({ grid: this.settings.grid, radar: this.settings.radar, detail: this.settings.detail });
    const shadows = this.settings.shadows && this.map.kind === 'mesh';
    if (shadows !== this._shadowsOn) {
      // Toggling shadows changes shader defines: recompile, and re-render the
      // (static) shadow map once.
      this._shadowsOn = shadows;
      const r = this.renderer;
      r.shadowMap.enabled = shadows;
      r.shadowMap.type = this.softwareGL ? THREE.BasicShadowMap : THREE.PCFShadowMap;
      r.shadowMap.needsUpdate = true;
      this.sun.castShadow = shadows;
      this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    }
    this.players.options.labels = this.settings.labels;
    this.players.options.xray = this.settings.xray;
    this.effects.options.grenades = this.settings.grenades;
    this.effects.options.tracers = this.settings.tracers;
  }

  // -- playback --------------------------------------------------------------------

  setTick(t) {
    if (!this.demo) return;
    this.tick = clamp(t, this.demo.startTick, this.demo.endTick);
    this._hasSmooth = false;
    this.audio?.reset();
    this._emit('seek');
  }

  play() {
    if (!this.demo) return;
    if (this.tick >= this.demo.endTick) this.tick = this.demo.startTick;
    this.playing = true;
    this._emit('play');
  }

  pause() {
    this.playing = false;
    this._emit('pause');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** Play [from, to] then pause and call ``onEnd`` (highlight preview). */
  playRange(from, to, onEnd) {
    this.setTick(from);
    this._rangeEnd = to;
    this._onRangeEnd = onEnd || null;
    this.play();
  }

  setMode(mode, focus = this.focus) {
    if (!CAMERA_MODES.includes(mode)) return;
    const prev = this.mode;
    this.mode = mode;
    if (focus !== undefined) this.focus = focus;
    if ((mode === 'follow' || mode === 'pov' || mode === 'chase' || mode === 'overview') && this.focus < 0) {
      this.focus = this._firstAlive();
    }
    this._hasSmooth = false;
    this._hasPrevTarget = false;
    const c = this.controls;
    c.minPolarAngle = 0;
    c.maxPolarAngle = Math.PI;
    c.enableRotate = true;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.enabled = this.interactive && (mode === 'free' || mode === 'follow' || mode === 'top');
    this.camera.fov = mode === 'pov' ? POV_FOV : FREE_FOV;
    this.camera.updateProjectionMatrix();
    if (mode === 'top') {
      c.minPolarAngle = c.maxPolarAngle = 0.0001;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      const b = this.bounds;
      const center = b.getCenter(new THREE.Vector3());
      const size = b.getSize(new THREE.Vector3());
      if (this.focus < 0) c.target.copy(center);
      const height = Math.max(size.x, size.z) * 0.95;
      this.camera.position.set(c.target.x, c.target.y + height, c.target.z + 1);
      c.update();
    } else if (mode === 'follow' && this.focus >= 0) {
      const st = this.demo.state(this.focus, this.tick, new PlayerState());
      const eye = PlayersView.eye(st, this._v[0]);
      const dir = PlayersView.viewDir(st, this._v[1]);
      c.target.copy(eye);
      this.camera.position.set(eye.x - dir.x * 260, eye.y + 170, eye.z - dir.z * 260);
      c.update();
    } else if (mode === 'free' && (prev === 'pov' || prev === 'chase' || prev === 'overview')) {
      const dir = this.camera.getWorldDirection(this._v[0]);
      c.target.copy(this.camera.position).addScaledVector(dir, 400);
      c.update();
    }
    this._emit('mode');
  }

  setFocus(p) {
    this.focus = p;
    this._hasSmooth = false;
    this._hasPrevTarget = false;
    if (this.mode === 'free') this.setMode('follow', p);
    else this.setMode(this.mode, p);
  }

  _firstAlive() {
    if (!this.demo) return -1;
    for (let p = 0; p < this.demo.P; p++) {
      const st = this.demo.state(p, this.tick, new PlayerState());
      if (st.present && st.alive) return p;
    }
    return 0;
  }

  // -- frame update ----------------------------------------------------------------

  frame(dt) {
    if (!this.demo) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.playing) {
      this.tick += dt * this.demo.tickRate * this.speed;
      if (this._rangeEnd !== null && this.tick >= this._rangeEnd) {
        this.tick = this._rangeEnd;
        this._rangeEnd = null;
        this.pause();
        const cb = this._onRangeEnd;
        this._onRangeEnd = null;
        cb?.();
      }
      if (this.tick >= this.demo.endTick) {
        this.tick = this.demo.endTick;
        this.pause();
      }
    }
    this.update(dt);
    if (this.audio) {
      this.audio.frame(this.demo, this.tick, this.playing, this.speed, this._listener(), this.mode === 'pov' ? this.focus : -1);
    }
    this._emit('frame');
  }

  /** Where sounds are heard from: the camera, in world units (Z up). */
  _listener() {
    const c = this.camera.position;
    const dir = this.camera.getWorldDirection(this._v[3]);
    return { x: c.x, y: -c.z, z: c.y, yaw: (Math.atan2(-dir.z, dir.x) * 180) / Math.PI };
  }

  /** Update every object for ``this.tick`` and render one frame. */
  update(dt) {
    const d = this.demo;
    if (!d) return;
    const tick = this.tick;
    for (let p = 0; p < d.P; p++) d.state(p, tick, this.states[p]);
    const ri = d.roundIndexAt(tick);
    const round = d.rounds[ri];
    const roundStart = round ? round.start : d.startTick;
    const bomb = d.bombAt(tick);
    const carrier = bomb && bomb.state === 'carried' ? bomb.player : -1;

    const cam = this._updateCamera(dt);
    this.players.update(tick, this.states, {
      hidden: cam.hidden, selected: this.focus, bombCarrier: carrier, roundStart,
    });
    this.effects.update(tick, { roundStart, bomb });
    this.map.setCut(cam.cut);
    this.map.follow(this.camera);
    this.renderer.render(this.scene, this.camera);
    this._renderViewmodel(dt);

    const alive = { T: 0, CT: 0 };
    for (const st of this.states) if (st.present && st.alive) alive[st.side]++;
    const pov = this.mode === 'pov' && this.focus >= 0;
    this.hud.draw({
      demo: d, tick, round, roundStart, bomb, alive,
      score: d.scoreAt(tick, this.states),
      focus: this.focus,
      pov,
      povPlayer: this.focus,
      povState: this.focus >= 0 ? this.states[this.focus] : null,
      blind: pov ? d.blindAt(this.focus, tick) : 0,
      clip: this.clip,
    });
  }

  /** First-person weapon, drawn over the scene after clearing depth. */
  _renderViewmodel(dt) {
    const vm = this.viewmodel;
    if (!vm || this.mode !== 'pov' || this.focus < 0 || !this.settings.viewmodel) return;
    const st = this.states[this.focus];
    if (!st || !st.alive) return;
    if (st.scoped && /awp|ssg|scar|g3sg1/i.test(st.weapon)) return; // scope overlay instead
    const shot = this.demo.lastShotTick(this.focus, this.tick);
    const model = this.players.models[this.focus];
    const shown = vm.update(this.camera, st, {
      dt: Math.max(0, dt) * this.speed,
      speed: model && model.speed !== undefined ? model.speed : 0,
      shotAge: shot === null ? -1 : (this.tick - shot) / this.demo.tickRate,
    });
    if (!shown) return;
    const r = this.renderer;
    r.autoClear = false;
    r.clearDepth();
    r.render(vm.scene, this.camera);
    r.autoClear = true;
  }

  _cutFor(playerY) {
    const s = this.settings;
    if (s.roofCut === 'off') return 1e6;
    if (s.roofCut === 'manual') return s.cutHeight;
    return playerY === null ? 1e6 : playerY + 150;
  }

  _updateCamera(dt) {
    const cam = this.camera;
    const c = this.controls;
    const focus = this.focus;
    const st = focus >= 0 ? this.states[focus] : null;
    const [eye, dir, tmp] = this._v;
    let hidden = -1;
    let cut = this._cutFor(null);

    // Exponential smoothing that is frame-rate independent (deterministic in renders).
    const k = (rate) => (this._hasSmooth ? 1 - Math.exp(-rate * Math.max(dt, 1 / 240)) : 1);

    switch (this.mode) {
      case 'pov': {
        if (!st || !st.present) break;
        if (st.alive) {
          PlayersView.eye(st, eye);
          PlayersView.viewDir(st, dir);
          cam.position.copy(eye);
          cam.lookAt(tmp.copy(eye).add(dir));
          hidden = focus;
          cut = this.settings.roofCut === 'manual' ? this.settings.cutHeight : 1e6;
          this._lastPovEye = eye.clone();
        } else {
          // Death cam: hover over the body and look at the killer.
          const death = this._lastDeath(focus);
          const at = death ? tmp.set(death.pos[0], death.pos[2] + 64, -death.pos[1]) : tmp.copy(this._lastPovEye || cam.position);
          const killer = death && death.attacker >= 0 ? this.states[death.attacker] : null;
          const target = killer && killer.alive ? PlayersView.eye(killer, this._v[3]) : null;
          const want = at.clone().add(new THREE.Vector3(0, 90, 0));
          cam.position.lerp(want, k(4));
          if (target) cam.lookAt(target);
          cut = this._cutFor(at.y);
        }
        break;
      }
      case 'chase':
      case 'overview': {
        if (!st || !st.present) break;
        const deadPos = !st.alive ? this._lastDeath(focus) : null;
        if (deadPos) {
          eye.set(deadPos.pos[0], deadPos.pos[2] + 64, -deadPos.pos[1]);
          dir.set(1, 0, 0);
          if (this._hasSmooth) dir.copy(this._smoothLook).sub(cam.position).setY(0).normalize();
        } else {
          PlayersView.eye(st, eye);
          PlayersView.viewDir(st, dir);
        }
        const flat = tmp.set(dir.x, 0, dir.z);
        if (flat.lengthSq() < 1e-6) flat.set(1, 0, 0);
        flat.normalize();
        let want, look;
        if (this.mode === 'chase') {
          // Follow the aim, but keep the pitch moderate so the camera never
          // ends up staring at the floor or the sky.
          const pitch = clamp(Math.asin(clamp(dir.y, -1, 1)), -0.45, 0.35);
          want = eye.clone().addScaledVector(flat, -150).add(new THREE.Vector3(0, 42 - Math.sin(pitch) * 60, 0));
          look = eye.clone().addScaledVector(flat, 260 * Math.cos(pitch)).add(new THREE.Vector3(0, 260 * Math.sin(pitch), 0));
        } else {
          // Overview keeps the heading it had when the shot started: turning
          // with every flick of the player's aim makes the picture unreadable.
          if (!this._hasSmooth || !this._overviewDir) this._overviewDir = flat.clone();
          const heading = this._overviewDir;
          want = eye.clone().addScaledVector(heading, -520).add(new THREE.Vector3(0, 900, 0));
          look = eye.clone().addScaledVector(heading, 120);
        }
        if (!this._hasSmooth) {
          this._smoothPos.copy(want);
          this._smoothLook.copy(look);
        } else {
          this._smoothPos.lerp(want, k(this.mode === 'chase' ? 7 : 3));
          this._smoothLook.lerp(look, k(this.mode === 'chase' ? 10 : 4));
        }
        cam.position.copy(this._smoothPos);
        cam.lookAt(this._smoothLook);
        cut = this._cutFor(eye.y);
        break;
      }
      case 'follow':
      case 'top': {
        if (st && st.present && (st.alive || this.mode === 'top')) {
          PlayersView.eye(st, eye);
          if (this._hasPrevTarget) {
            // Move camera and orbit target together so user orbiting is preserved.
            tmp.copy(eye).sub(this._prevTarget);
            cam.position.add(tmp);
            c.target.add(tmp);
          } else if (this.mode === 'top') {
            const height = cam.position.y - c.target.y;
            c.target.copy(eye);
            cam.position.set(eye.x, eye.y + height, eye.z + 1);
          } else {
            c.target.copy(eye);
          }
          this._prevTarget.copy(eye);
          this._hasPrevTarget = true;
          cut = this._cutFor(eye.y);
        } else {
          this._hasPrevTarget = false;
        }
        c.update();
        break;
      }
      default:
        c.update();
    }
    this._hasSmooth = true;
    return { hidden, cut };
  }

  _lastDeath(p) {
    const d = this.demo;
    const r = d.rounds[d.roundIndexAt(this.tick)];
    let found = null;
    for (const k of d.kills) {
      if (k.tick > this.tick) break;
      if (k.victim === p && (!r || k.tick >= r.start)) found = k;
    }
    return found;
  }

  /** Draw the GL frame and the HUD into ``target`` (a 2D canvas). */
  composite(target, withHud = true) {
    const ctx = target.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0, target.width, target.height);
    if (withHud) ctx.drawImage(this.hudCanvas, 0, 0, target.width, target.height);
  }
}
