// Procedural low-poly weapon models (no external assets). Every model points
// along +X with +Y up; the right-hand grip is at the origin and
// ``userData.support`` is where the left hand goes (null = one-handed).
// Units are Hammer units (a player is 72 tall).
import * as THREE from '../vendor/three.module.min.js';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';
import { weaponIcon } from './util.js';

const MATS = {
  metal: new THREE.MeshLambertMaterial({ color: 0x2b2e33 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x1b1d20 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x8a5532 }),
  polymer: new THREE.MeshLambertMaterial({ color: 0x3a3c3f }),
  tan: new THREE.MeshLambertMaterial({ color: 0x9c8a6a }),
  green: new THREE.MeshLambertMaterial({ color: 0x4f5e3c }),
  chrome: new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }),
  blade: new THREE.MeshLambertMaterial({ color: 0xc8ccd0 }),
  yellow: new THREE.MeshLambertMaterial({ color: 0xd6b02a }),
  red: new THREE.MeshLambertMaterial({ color: 0xb02a22 }),
  glass: new THREE.MeshLambertMaterial({ color: 0x6f8a4a, transparent: true, opacity: 0.85 }),
  cloth: new THREE.MeshLambertMaterial({ color: 0xd8d0c0 }),
  he: new THREE.MeshLambertMaterial({ color: 0x4a5a32 }),
  flash: new THREE.MeshLambertMaterial({ color: 0xb8bcc0 }),
  smoke: new THREE.MeshLambertMaterial({ color: 0x6f7f8f }),
};

/** Small builder: collects primitives per material and merges them. */
class Builder {
  constructor() { this.parts = new Map(); }

  _add(mat, geo, x, y, z, rz = 0, ry = 0, rx = 0) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YZX')),
      new THREE.Vector3(1, 1, 1),
    );
    geo.applyMatrix4(m);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(geo.index ? geo.toNonIndexed() : geo);
    return this;
  }

  /** Box from x0..x1 (length along the barrel), centred on y / z. */
  box(mat, x0, x1, y, h, w = 1.6, z = 0, rz = 0) {
    const g = new THREE.BoxGeometry(x1 - x0, h, w);
    return this._add(mat, g, (x0 + x1) / 2, y, z, rz);
  }

  /** Cylinder along X. */
  tube(mat, x0, x1, y, r, z = 0, seg = 10) {
    const g = new THREE.CylinderGeometry(r, r, x1 - x0, seg);
    g.rotateZ(-Math.PI / 2);
    return this._add(mat, g, (x0 + x1) / 2, y, z);
  }

  /** Grip / magazine: box of size (w x h) rotated by ``tilt`` radians, top at (x, y). */
  slab(mat, x, y, len, h, tilt, w = 1.4) {
    const g = new THREE.BoxGeometry(len, h, w);
    g.translate(0, -h / 2, 0);
    return this._add(mat, g, x, y, 0, tilt);
  }

  sphere(mat, x, y, r, sy = 1) {
    const g = new THREE.SphereGeometry(r, 12, 8);
    g.scale(1, sy, 1);
    return this._add(mat, g, x, y, 0);
  }

  build(support = null) {
    const group = new THREE.Group();
    for (const [mat, geos] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      group.add(mesh);
    }
    group.userData.support = support;
    return group;
  }
}

const v3 = (x, y, z = 0) => new THREE.Vector3(x, y, z);

const FACTORIES = {
  ak(wood = true) {
    const b = new Builder();
    const furn = wood ? MATS.wood : MATS.polymer;
    b.box(MATS.metal, -3, 11, 1.6, 3.2)                 // receiver
      .box(furn, 10, 17, 1.3, 2.6, 1.8)                   // handguard
      .tube(MATS.metal, 17, 25, 1.9, 0.45)                // barrel
      .tube(MATS.metal, 11, 22, 2.9, 0.35)                // gas tube
      .box(MATS.metal, 23.5, 24.5, 3.1, 1.2, 0.5)         // front sight
      .box(furn, -14, -3, 0.8, 3.2, 1.6, 0.08)            // stock
      .slab(MATS.metal, 6, 0.2, 2.4, 7, 0.32)             // curved-ish magazine
      .slab(furn, 0.6, 0.4, 2, 4.6, -0.3);               // pistol grip
    return b.build(v3(14, 0.4));
  },
  m4(color = MATS.polymer) {
    const b = new Builder();
    b.box(color, -3, 10, 1.8, 3.4)
      .box(MATS.metal, 10, 17, 1.8, 2.6, 2.0)
      .tube(MATS.metal, 17, 24, 2.0, 0.42)
      .box(MATS.dark, 1, 8, 4.0, 1.0, 1.0)                // top rail
      .box(MATS.dark, 22, 23, 3.4, 1.8, 0.6)              // front sight
      .box(color, -13, -3, 1.4, 3.0, 1.6, 0.04)
      .slab(MATS.metal, 6.5, 0.4, 2.2, 6.4, 0.1)
      .slab(color, 0.4, 0.4, 2, 4.6, -0.3);
    return b.build(v3(13.5, 0.6));
  },
  bullpup(color = MATS.polymer) {
    const b = new Builder();
    b.box(color, -12, 8, 1.6, 4.2)
      .tube(MATS.metal, 8, 16, 2.2, 0.45)
      .box(MATS.dark, -4, 5, 4.4, 1.2, 1.2)
      .slab(MATS.metal, -6, -0.2, 2.2, 5.6, 0.05)
      .slab(color, 0.6, 0, 2, 4.4, -0.25);
    return b.build(v3(6, 0));
  },
  awp() {
    const b = new Builder();
    b.box(MATS.green, -15, 9, 1.4, 3.6, 1.8)           // stock + body
      .box(MATS.green, -15, -8, -0.6, 3.2, 1.6)
      .tube(MATS.metal, 9, 30, 2.0, 0.6)
      .tube(MATS.dark, -2, 9, 5.0, 1.3)                    // scope
      .tube(MATS.dark, -3.5, -1.8, 5.0, 1.6)
      .tube(MATS.dark, 8.5, 10, 5.0, 1.6)
      .box(MATS.dark, 1, 2, 3.6, 1.6, 0.8)
      .box(MATS.dark, 6, 7, 3.6, 1.6, 0.8)
      .slab(MATS.metal, 3, 0.2, 2, 3.6, 0.05)
      .slab(MATS.green, 0.4, 0.6, 2, 4.6, -0.35);
    return b.build(v3(12, 0.6));
  },
  autoSniper() {
    const b = new Builder();
    b.box(MATS.dark, -13, 10, 1.6, 3.6)
      .tube(MATS.metal, 10, 26, 2.0, 0.55)
      .tube(MATS.dark, -1, 9, 5.0, 1.2)
      .slab(MATS.metal, 5, 0.4, 2.4, 5.8, 0.08)
      .slab(MATS.dark, 0.4, 0.4, 2, 4.6, -0.3);
    return b.build(v3(13, 0.6));
  },
  pistol(silencer = false, big = false) {
    const b = new Builder();
    const len = big ? 10 : 8;
    b.box(big ? MATS.chrome : MATS.metal, -1.5, len - 1.5, 2.3, big ? 2.4 : 2.0, 1.2)
      .slab(MATS.dark, 0.2, 1.4, 1.9, 4.6, -0.28, 1.3);
    if (silencer) b.tube(MATS.dark, len - 1.5, len + 5, 2.4, 0.7);
    return b.build(v3(0.6, -0.6, -0.4));
  },
  smg(color = MATS.dark) {
    const b = new Builder();
    b.box(color, -3, 9, 1.6, 3.4)
      .tube(MATS.metal, 9, 14, 1.8, 0.4)
      .box(color, -10, -3, 1.4, 2.2, 1.2, 0.05)
      .slab(MATS.metal, 5, 0.2, 1.8, 6.2, 0.02)
      .slab(color, 0.4, 0.4, 2, 4.4, -0.3);
    return b.build(v3(8, 0.2));
  },
  shotgun(wood = true) {
    const b = new Builder();
    const furn = wood ? MATS.wood : MATS.polymer;
    b.box(MATS.metal, -3, 7, 1.8, 3.2)
      .tube(MATS.metal, 7, 24, 2.4, 0.6)
      .tube(MATS.metal, 7, 21, 1.2, 0.5)
      .box(furn, 11, 17, 1.0, 2.2, 2.0)                    // pump
      .box(furn, -14, -3, 0.8, 3.2, 1.6, 0.1)
      .slab(furn, 0.4, 0.6, 2, 4.4, -0.35);
    return b.build(v3(14, 0.4));
  },
  lmg() {
    const b = new Builder();
    b.box(MATS.metal, -4, 12, 2.0, 4.4, 2.2)
      .tube(MATS.metal, 12, 26, 2.2, 0.6)
      .box(MATS.dark, 1, 8, -1.6, 4.4, 3.2)                // box magazine
      .box(MATS.polymer, -14, -4, 1.4, 3.4, 1.8)
      .box(MATS.dark, 20, 21, -1.6, 4.6, 0.4, 0, 0.3)
      .slab(MATS.polymer, 0.4, 0.4, 2, 4.4, -0.3);
    return b.build(v3(15, 0.2));
  },
  knife() {
    const b = new Builder();
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.6); shape.lineTo(9, -0.4); shape.lineTo(11.5, 0.6); shape.lineTo(0, 1.0); shape.lineTo(0, -0.6);
    const blade = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
    blade.translate(2.5, 0, -0.12);
    b._add(MATS.blade, blade, 0, 0, 0);
    b.box(MATS.dark, -3.5, 2.5, 0.2, 1.5, 1.1).box(MATS.metal, 2.3, 2.9, 0.2, 2.4, 1.4);
    return b.build(null);
  },
  grenade(mat) {
    const b = new Builder();
    b.sphere(mat, 1.5, 1.2, 1.9, 1.25).box(MATS.metal, 0.6, 2.4, 3.6, 1.0, 1.2).box(MATS.metal, 1.5, 3.4, 2.8, 0.4, 0.6);
    return b.build(null);
  },
  molotov() {
    const b = new Builder();
    const body = new THREE.CylinderGeometry(1.5, 1.6, 4.5, 10);
    b._add(MATS.glass, body, 1.5, 1.4, 0);
    const neck = new THREE.CylinderGeometry(0.6, 0.9, 2.2, 8);
    b._add(MATS.glass, neck, 1.5, 4.6, 0);
    b.box(MATS.cloth, 1, 2, 6.2, 1.6, 0.8);
    return b.build(null);
  },
  c4() {
    const b = new Builder();
    b.box(MATS.tan, -2, 6, 1.2, 2.6, 4.2).box(MATS.dark, -0.5, 4.5, 2.7, 0.4, 2.6).box(MATS.red, 0, 1, 3.0, 0.4, 0.8);
    return b.build(null);
  },
  taser() {
    const b = new Builder();
    b.box(MATS.yellow, -1, 6, 2.2, 2.4, 1.4).box(MATS.dark, 6, 7.5, 2.2, 2.0, 1.2).slab(MATS.dark, 0.2, 1.2, 1.9, 4, -0.25);
    return b.build(null);
  },
};

const BY_ICON = {
  ak47: () => FACTORIES.ak(true),
  galil: () => FACTORIES.ak(false),
  m4: () => FACTORIES.m4(MATS.polymer),
  famas: () => FACTORIES.bullpup(MATS.polymer),
  aug: () => FACTORIES.bullpup(MATS.green),
  sniper: () => FACTORIES.awp(),
  auto_sniper: () => FACTORIES.autoSniper(),
  glock: () => FACTORIES.pistol(false),
  usp: () => FACTORIES.pistol(true),
  pistol: () => FACTORIES.pistol(false),
  cz75: () => FACTORIES.pistol(false),
  tec9: () => FACTORIES.pistol(false),
  deagle: () => FACTORIES.pistol(false, true),
  revolver: () => FACTORIES.pistol(false, true),
  mac10: () => FACTORIES.smg(MATS.dark),
  mp9: () => FACTORIES.smg(MATS.dark),
  mp7: () => FACTORIES.smg(MATS.polymer),
  mp5: () => FACTORIES.smg(MATS.metal),
  ump: () => FACTORIES.smg(MATS.polymer),
  bizon: () => FACTORIES.smg(MATS.metal),
  p90: () => FACTORIES.bullpup(MATS.dark),
  shotgun: () => FACTORIES.shotgun(true),
  sawedoff: () => FACTORIES.shotgun(false),
  lmg: () => FACTORIES.lmg(),
  knife: () => FACTORIES.knife(),
  taser: () => FACTORIES.taser(),
  he: () => FACTORIES.grenade(MATS.he),
  flash: () => FACTORIES.grenade(MATS.flash),
  smoke: () => FACTORIES.grenade(MATS.smoke),
  decoy: () => FACTORIES.grenade(MATS.metal),
  molotov: () => FACTORIES.molotov(),
  c4: () => FACTORIES.c4(),
};

const cache = new Map();

/** Weapon model for an active-weapon display name (shared, do not modify). */
export function weaponModel(name) {
  const key = weaponIcon(name) || 'pistol';
  if (!cache.has(key)) {
    const make = BY_ICON[key] || BY_ICON.pistol;
    const model = make();
    model.userData.kind = key;
    model.userData.twoHanded = !!model.userData.support && !['glock', 'usp', 'pistol', 'cz75', 'tec9', 'deagle', 'revolver'].includes(key);
    cache.set(key, model);
  }
  return cache.get(key);
}

/** A fresh instance (shares geometry and materials). */
export function weaponInstance(name) {
  const src = weaponModel(name);
  const inst = src.clone();
  inst.userData = { ...src.userData };
  return inst;
}
