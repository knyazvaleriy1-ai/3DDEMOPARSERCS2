// Animated player models: a rigged glTF character (default: the three.js
// "Soldier", Mixamo rig) driven by demo data. Locomotion comes from the model's
// idle / walk / run clips blended by speed; on top of that the code bends the
// legs for crouching, leans the spine with the view pitch, solves two-bone IK so
// the hands hold the active weapon, and drops the body when the player dies.
import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/SkeletonUtils.js';
import { COLORS, clamp } from './util.js';
import { weaponInstance } from './weapons.js';

const DEG = Math.PI / 180;
const PLAYER_HEIGHT = 72;
const TINT = { T: 0xffe6c4, CT: 0xb4cbf5 };
const VISOR = { T: 0xff9a2a, CT: 0x3f9bff };

const BONES = {
  hips: 'Hips', spine: 'Spine', spine1: 'Spine1', spine2: 'Spine2', neck: 'Neck', head: 'Head',
  lArm: 'LeftArm', lFore: 'LeftForeArm', lHand: 'LeftHand',
  rArm: 'RightArm', rFore: 'RightForeArm', rHand: 'RightHand',
  lUpLeg: 'LeftUpLeg', lLeg: 'LeftLeg', lFoot: 'LeftFoot', lToe: 'LeftToeBase',
  rUpLeg: 'RightUpLeg', rLeg: 'RightLeg', rFoot: 'RightFoot', rToe: 'RightToeBase',
};

function findBones(root) {
  const all = [];
  root.traverse((o) => { if (o.isBone) all.push(o); });
  // "mixamorigLeftArm", "mixamorig:LeftArm", "Armature|LeftArm", "LeftArm" -> "LeftArm"
  const bare = (name) => name.replace(/^.*mixamorig[:_]?/i, '').replace(/^.*[:|]/, '');
  const out = {};
  for (const [key, suffix] of Object.entries(BONES)) {
    out[key] = all.find((b) => bare(b.name) === suffix) || null;
  }
  return out;
}

/** Load the T and CT models (deduplicated by file). Resolves to null if unavailable. */
export async function loadPlayerAssets() {
  let info;
  try {
    info = await fetch('/api/models').then((r) => (r.ok ? r.json() : null));
  } catch (_) {
    return null;
  }
  if (!info) return null;
  const loader = new GLTFLoader();
  const byFile = new Map();
  const out = {};
  for (const side of ['T', 'CT']) {
    const file = info[side.toLowerCase()]?.file;
    if (!file) return null;
    if (!byFile.has(file)) {
      byFile.set(file, loader.loadAsync(`/api/models/file/${encodeURIComponent(file)}`).then(prepare).catch((err) => {
        console.warn('player model failed to load', err);
        return null;
      }));
    }
    out[side] = await byFile.get(file);
    if (!out[side]) return null;
    out[side] = { ...out[side], materials: teamMaterials(out[side], side) };
  }
  return out;
}

function prepare(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const height = Math.max(1e-3, box.max.y - box.min.y);
  const bones = findBones(scene);
  // Facing: feet point forward (foot -> toe); glTF default is +Z.
  let yawOffset = 0;
  const d = new THREE.Vector3();
  for (const [foot, toe] of [[bones.lFoot, bones.lToe], [bones.rFoot, bones.rToe]]) {
    if (foot && toe) d.add(toe.getWorldPosition(new THREE.Vector3()).sub(foot.getWorldPosition(new THREE.Vector3())));
  }
  if (Math.hypot(d.x, d.z) > 1e-4) yawOffset = Math.atan2(d.x, d.z); // angle of forward from +Z
  const clips = {};
  for (const clip of gltf.animations) {
    const n = clip.name.toLowerCase();
    if (!clips.idle && n.includes('idle')) clips.idle = clip;
    else if (!clips.walk && n.includes('walk')) clips.walk = clip;
    else if (!clips.run && n.includes('run')) clips.run = clip;
  }
  const mats = [];
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.frustumCulled = false;
      mats.push(o.material);
    }
  });
  return {
    scene, clips, minY: box.min.y, scale: PLAYER_HEIGHT / height,
    // Rotate so the model faces local +X (our "forward"): forward was at yawOffset from +Z.
    facing: Math.PI / 2 - yawOffset,
    rigged: !!(bones.rArm && bones.rFore && bones.rHand && bones.lArm && bones.spine2),
  };
}

function teamMaterials(asset, side) {
  const map = new Map();
  asset.scene.traverse((o) => {
    if (!o.isMesh || map.has(o.material)) return;
    const m = o.material.clone();
    const visor = /visor|glass|eye/i.test(m.name || o.name);
    if (visor) {
      m.emissive = new THREE.Color(VISOR[side]);
      m.emissiveIntensity = 0.9;
    } else if (m.color) {
      m.color.multiply(new THREE.Color(TINT[side]));
    }
    map.set(o.material, m);
  });
  return map;
}

// X-ray silhouettes: drawn in the opaque queue after the map but before the
// players (renderOrder 1 vs 2), so they only show where the *map* hides a player,
// never where a body hides its own arm. CustomBlending gives alpha blending
// without moving them to the transparent queue.
export function ghostMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color, opacity: 0.4, depthWrite: false, depthFunc: THREE.GreaterDepth,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}
const GHOST = { T: ghostMaterial(COLORS.T), CT: ghostMaterial(COLORS.CT) };
export const RENDER_ORDER = { ghost: 1, player: 2 };

// Scratch objects
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _grip = new THREE.Vector3(), _sup = new THREE.Vector3(), _sh = new THREE.Vector3(), _ws = new THREE.Vector3();
const _right = new THREE.Vector3(), _pole = new THREE.Vector3();
const _lf = new THREE.Vector3(), _rf = new THREE.Vector3(), _hp = new THREE.Vector3(), _fw = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * AnimationMixer only writes a property when its value differs from the
 * previous frame. We reset bones to the rest pose and tweak them after the
 * mixer every frame, so the blended result must be written unconditionally.
 * (Uses mixer internals of the vendored three.js r170.)
 */
function forceApply(mixer) {
  const bindings = mixer._bindings;
  const n = mixer._nActiveBindings;
  const accu = mixer._accuIndex;
  for (let i = 0; i < n; i++) {
    const pm = bindings[i];
    pm.binding.setValue(pm.buffer, accu * pm.valueSize + pm.valueSize);
  }
}

/** Rotate ``bone`` (in world space, about ``pivot``) so the point ``from`` moves towards ``to``. */
function aimBone(bone, pivot, from, to) {
  _v1.subVectors(from, pivot);
  _v2.subVectors(to, pivot);
  if (_v1.lengthSq() < 1e-8 || _v2.lengthSq() < 1e-8) return;
  _q.setFromUnitVectors(_v1.normalize(), _v2.normalize());
  bone.getWorldQuaternion(_qw);
  bone.parent.getWorldQuaternion(_qp);
  _qw.premultiply(_q);
  bone.quaternion.copy(_qp.invert().multiply(_qw));
  bone.updateMatrixWorld(true);
}

/** Rotate ``bone`` by ``angle`` about a world-space axis. */
function turnBone(bone, axis, angle) {
  if (!bone || !angle) return;
  _q.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_qw);
  bone.parent.getWorldQuaternion(_qp);
  _qw.premultiply(_q);
  bone.quaternion.copy(_qp.invert().multiply(_qw));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK with a pole target for the elbow / knee. */
function solveTwoBone(upper, lower, end, target, pole) {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
  _d.subVectors(target, _a);
  const dist = clamp(_d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  _d.normalize();
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _p.subVectors(pole, _a);
  _p.addScaledVector(_d, -_p.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(0, -1, 0);
  _p.normalize();
  _e.copy(_a).addScaledVector(_d, l1 * cosA).addScaledVector(_p, l1 * sinA);
  _t.copy(_a).addScaledVector(_d, dist);
  aimBone(upper, _a, _b, _e);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  aimBone(lower, _b, _c, _t);
}

export class SkinnedPlayer {
  constructor(index, name, assets, label) {
    this.index = index;
    this.name = name;
    this.assets = assets;
    this.label = label;
    this.side = null;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.weaponHolder = new THREE.Group();
    this.root.add(this.weaponHolder);
    this.weapon = null;
    this.weaponName = null;
    this.phase = 0;
    this.idleTime = index * 0.37;
    this.lastX = null;
    this.speed = 0;
    this.fwd = 1;
    this.root.add(label.sprite);
  }

  _build(side) {
    if (this.model) this.body.remove(this.model);
    const asset = this.assets[side];
    this.asset = asset;
    const model = SkeletonUtils.clone(asset.scene);
    const ghosts = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = asset.materials.get(o.material) || o.material;
      o.castShadow = false; // the shadow map is static (map only); players get blob shadows
      o.frustumCulled = false;
      o.renderOrder = RENDER_ORDER.player;
      if (o.isSkinnedMesh) {
        const g = new THREE.SkinnedMesh(o.geometry, GHOST[side]);
        g.bind(o.skeleton, o.bindMatrix);
        g.castShadow = false;
        g.renderOrder = RENDER_ORDER.ghost;
        g.frustumCulled = false;
        g.position.copy(o.position);
        g.quaternion.copy(o.quaternion);
        g.scale.copy(o.scale);
        ghosts.push([o.parent, g]);
      }
    });
    for (const [parent, g] of ghosts) parent.add(g);
    this.ghosts = ghosts.map(([, g]) => g);
    model.scale.setScalar(asset.scale);
    model.position.y = -asset.minY * asset.scale;
    this.body.rotation.y = asset.facing;
    this.body.add(model);
    this.model = model;
    this.bones = findBones(model);
    // Rest pose: restored every frame so procedural tweaks on bones that the
    // clips don't animate can't accumulate.
    this.rest = [];
    model.traverse((o) => { if (o.isBone) this.rest.push([o, o.quaternion.clone(), o.position.clone()]); });
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const [k, clip] of Object.entries(asset.clips)) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions[k] = a;
    }
    this.side = side;
  }

  _setWeapon(name) {
    if (name === this.weaponName) return;
    this.weaponName = name;
    if (this.weapon) this.weaponHolder.remove(this.weapon);
    this.weapon = name ? weaponInstance(name) : null;
    if (this.weapon) {
      this.weapon.traverse((o) => { o.renderOrder = RENDER_ORDER.player; });
      this.weaponHolder.add(this.weapon);
    }
  }

  /**
   * ``st``: PlayerState; ``ctx``: {dt, death, deathAge, hidden, options, eyeH}.
   * ``dt`` is game time since the previous update (0 after a seek).
   */
  update(st, ctx) {
    if (st.side !== this.side) this._build(st.side);
    const { dt } = ctx;
    const dead = !st.alive;
    const x = dead && ctx.death ? ctx.death.pos[0] : st.x;
    const y = dead && ctx.death ? ctx.death.pos[1] : st.y;
    const z = dead && ctx.death ? ctx.death.pos[2] : st.z;

    // Speed from the change in position (game time), smoothed.
    if (this.lastX !== null && dt > 0 && dt < 0.5) {
      const vx = (st.x - this.lastX) / dt, vy = (st.y - this.lastY) / dt;
      const sp = Math.hypot(vx, vy);
      const k = 1 - Math.exp(-dt * 10);
      this.speed += (Math.min(sp, 320) - this.speed) * k;
      if (sp > 20) {
        const yaw = st.yaw * DEG;
        const along = (vx * Math.cos(yaw) + vy * Math.sin(yaw)) / sp;
        this.fwd += ((along < -0.35 ? -1 : 1) - this.fwd) * k;
      }
    } else if (dt === 0 || dt >= 0.5) {
      this.speed = 0;
    }
    this.lastX = st.x;
    this.lastY = st.y;

    this.root.position.set(x, z, -y);
    this.root.rotation.set(0, st.yaw * DEG, 0);

    // --- locomotion -------------------------------------------------------------
    const a = this.actions;
    const speed = dead ? 0 : this.speed;
    const wRun = clamp((speed - 140) / 80, 0, 1);
    const wMove = clamp((speed - 15) / 60, 0, 1);
    const cycle = 115 + (175 - 115) * wRun;            // units travelled per animation cycle
    this.phase = (this.phase + this.fwd * dt * speed / cycle + 10) % 1;
    this.idleTime += dt;
    const weights = { idle: 1 - wMove, walk: wMove * (1 - wRun), run: wMove * wRun };
    for (const [k, act] of Object.entries(a)) {
      const clip = act.getClip();
      act.setEffectiveWeight(dead ? (k === 'idle' ? 1 : 0) : weights[k] ?? 0);
      act.time = k === 'idle' ? (dead ? 0 : this.idleTime % clip.duration) : this.phase * clip.duration;
    }
    for (const [bone, q, p] of this.rest) {
      bone.quaternion.copy(q);
      bone.position.copy(p);
    }
    this.mixer.update(0);
    forceApply(this.mixer);
    this.root.updateMatrixWorld(true);

    const B = this.bones;
    const rigged = this.asset.rigged;
    const rightAxis = _right.set(0, 0, 1).applyQuaternion(this.root.quaternion);

    // --- death: fall backwards around the feet --------------------------------------
    if (dead) {
      const k = clamp((ctx.deathAge ?? 1) / 0.55, 0, 1);
      const fall = k * k * (3 - 2 * k);
      this.root.rotation.z = fall * Math.PI / 2;
      this.root.position.y += fall * 5;
      this._setWeapon(null);
      this.label.sprite.visible = false;
      for (const g of this.ghosts) g.visible = false;
      return;
    }
    for (const g of this.ghosts) g.visible = ctx.options.xray;

    // --- crouch: lower the hips in world space, keep the feet planted with leg IK ---
    if (rigged && st.duck > 0.01 && B.hips && B.lUpLeg && B.rUpLeg && B.lLeg && B.rLeg && B.lFoot && B.rFoot) {
      const lFoot = B.lFoot.getWorldPosition(_lf);
      const rFoot = B.rFoot.getWorldPosition(_rf);
      B.hips.getWorldPosition(_hp);
      _hp.y -= 18 * st.duck;
      B.hips.parent.worldToLocal(_hp);
      B.hips.position.copy(_hp);
      B.hips.updateMatrixWorld(true);
      const fwd = _fw.set(1, 0, 0).applyQuaternion(this.root.quaternion);
      for (const [up, low, foot, target] of [[B.lUpLeg, B.lLeg, B.lFoot, lFoot], [B.rUpLeg, B.rLeg, B.rFoot, rFoot]]) {
        up.getWorldPosition(_pole).addScaledVector(fwd, 40).addScaledVector(DOWN, 10);
        solveTwoBone(up, low, foot, target, _pole);
      }
    }

    // --- aim: spine and head follow the pitch -------------------------------------
    const pitch = clamp(st.pitch, -80, 80) * DEG;
    if (rigged) {
      turnBone(B.spine1, rightAxis, -pitch * 0.25);
      turnBone(B.spine2, rightAxis, -pitch * 0.3);
      turnBone(B.neck, rightAxis, -pitch * 0.2);
      turnBone(B.head, rightAxis, -pitch * 0.25);
    }

    // --- weapon + hands -------------------------------------------------------------
    this._setWeapon(st.weapon);
    const w = this.weapon;
    if (!w) return;
    const kind = w.userData.kind;
    const pistol = ['glock', 'usp', 'pistol', 'cz75', 'tec9', 'deagle', 'revolver', 'taser'].includes(kind);
    const oneHand = !w.userData.support || ['knife', 'he', 'flash', 'smoke', 'decoy', 'molotov', 'c4'].includes(kind);
    const eyeH = ctx.eyeH;
    // Holder sits at the right shoulder and pitches with the view.
    this.weaponHolder.position.set(2, eyeH - 10, pistol ? 2 : 5);
    this.weaponHolder.rotation.set(0, 0, -pitch, 'YZX');
    if (pistol) w.position.set(17, -2.5, 0);
    else if (oneHand) w.position.set(8, -11, 3);   // knife / grenade held low at the side
    else w.position.set(6, -3, 0);
    w.rotation.set(0, 0, oneHand && !pistol ? -0.35 : 0);
    if (!rigged) return;
    this.root.updateMatrixWorld(true);

    // Elbows point down and outwards (pole targets below / beside the shoulders).
    w.localToWorld(_grip.set(0, 0.4, 0));
    B.rArm.getWorldPosition(_sh);
    _pole.copy(_sh).addScaledVector(DOWN, 30).addScaledVector(rightAxis, 18);
    solveTwoBone(B.rArm, B.rFore, B.rHand, _grip, _pole);
    if (!oneHand || pistol) {
      if (w.userData.support) w.localToWorld(_sup.copy(w.userData.support));
      else w.localToWorld(_sup.set(0.5, -0.8, -1.2));
      B.lArm.getWorldPosition(_sh);
      _pole.copy(_sh).addScaledVector(DOWN, 30).addScaledVector(rightAxis, -18);
      solveTwoBone(B.lArm, B.lFore, B.lHand, _sup, _pole);
    }
  }
}

/** First-person weapon in front of the camera (drawn in a separate pass). */
export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.8));
    const d = new THREE.DirectionalLight(0xffffff, 1.6);
    d.position.set(0.3, 1, 0.5);
    this.scene.add(d);
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.weapon = null;
    this.name = null;
    this.bob = 0;
  }

  update(camera, st, { dt, speed, shotAge }) {
    if (st.weapon !== this.name) {
      this.name = st.weapon;
      if (this.weapon) this.holder.remove(this.weapon);
      this.weapon = st.weapon ? weaponInstance(st.weapon) : null;
      if (this.weapon) {
        this.weapon.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        this.weapon.scale.setScalar(0.85);
        this.holder.add(this.weapon);
      }
    }
    if (!this.weapon) return false;
    const kind = this.weapon.userData.kind;
    const pistol = ['glock', 'usp', 'pistol', 'cz75', 'tec9', 'deagle', 'revolver', 'taser'].includes(kind);
    const small = ['knife', 'he', 'flash', 'smoke', 'decoy', 'molotov', 'c4'].includes(kind);
    this.bob += dt * (4 + speed / 40);
    const amp = Math.min(1, speed / 250);
    const bx = Math.sin(this.bob) * 0.5 * amp, by = Math.abs(Math.cos(this.bob)) * 0.45 * amp;
    const kick = shotAge >= 0 && shotAge < 0.12 ? (1 - shotAge / 0.12) : 0;
    // Camera space: +X right, +Y up, -Z forward.
    const off = pistol ? [7.5, -7.5, -20] : small ? [8, -9, -16] : [8.5, -9.5, -21];
    this.holder.position.set(off[0] + bx, off[1] - by + kick * 0.4, off[2] + kick * 1.6);
    this.holder.position.applyMatrix4(camera.matrixWorld);
    this.holder.quaternion.copy(camera.quaternion);
    // Barrel slightly towards the screen centre, like CS's right-handed viewmodel.
    this.weapon.rotation.set(kick * 0.08, Math.PI / 2 + 0.09, 0.02, 'YXZ');
    if (small) this.weapon.rotation.set(0.2, Math.PI / 2 + 0.4, -0.3, 'YXZ');
    return true;
  }
}
