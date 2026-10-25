// Player models, name labels, death markers.
import * as THREE from '../vendor/three.module.min.js';
import { COLORS } from './util.js';

const EYE_STAND = 64;
const EYE_CROUCH = 46;
const DEG = Math.PI / 180;

const bodyGeo = new THREE.CapsuleGeometry(13, 34, 4, 12);
bodyGeo.translate(0, 13 + 17, 0);
const headGeo = new THREE.SphereGeometry(7.5, 16, 12);
const gunGeo = new THREE.BoxGeometry(30, 3.5, 3.5);
gunGeo.translate(15, 0, 0);
const ringGeo = new THREE.RingGeometry(17, 21, 32);
ringGeo.rotateX(-Math.PI / 2);
const dirGeo = new THREE.ConeGeometry(5, 14, 3);
dirGeo.rotateZ(-Math.PI / 2);
dirGeo.translate(28, 0, 0);

function teamMaterials(side) {
  const color = new THREE.Color(COLORS[side]);
  return {
    body: new THREE.MeshLambertMaterial({ color }),
    head: new THREE.MeshLambertMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.25) }),
    gun: new THREE.MeshLambertMaterial({ color: 0x222222 }),
    ring: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
    ghost: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.38, depthWrite: false, depthFunc: THREE.GreaterDepth,
    }),
  };
}

const MATS = { T: teamMaterials('T'), CT: teamMaterials('CT') };
const SELECT_RING = new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.95, depthWrite: false });

class Label {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 64;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.texture, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true,
    }));
    this.sprite.renderOrder = 20;
    this.sprite.center.set(0.5, 0);
    this.key = '';
  }

  draw(name, side, hp, badge, highlight) {
    const key = `${name}|${side}|${hp}|${badge}|${highlight}`;
    if (key === this.key) return;
    this.key = key;
    const c = this.ctx;
    c.clearRect(0, 0, 256, 64);
    c.font = '600 22px "Segoe UI", system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const text = name.length > 18 ? name.slice(0, 17) + '…' : name;
    const w = Math.min(250, c.measureText(text).width + (badge ? 52 : 18));
    c.fillStyle = highlight ? 'rgba(60,45,10,0.85)' : 'rgba(10,12,15,0.72)';
    roundRect(c, 128 - w / 2, 4, w, 32, 7);
    c.fill();
    if (highlight) { c.strokeStyle = '#ffd34d'; c.lineWidth = 2; c.stroke(); }
    c.fillStyle = COLORS[side];
    c.fillText(text, 128 - (badge ? 16 : 0), 21);
    if (badge) {
      c.fillStyle = '#e5484d';
      roundRect(c, 128 + w / 2 - 40, 10, 32, 20, 4);
      c.fill();
      c.fillStyle = '#fff';
      c.font = '700 14px system-ui, sans-serif';
      c.fillText(badge, 128 + w / 2 - 24, 21);
    }
    // HP bar
    c.fillStyle = 'rgba(10,12,15,0.8)';
    c.fillRect(78, 42, 100, 8);
    c.fillStyle = hp > 30 ? '#3fb950' : '#e5484d';
    c.fillRect(79, 43, 98 * Math.max(0, Math.min(100, hp)) / 100, 6);
    this.texture.needsUpdate = true;
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

class PlayerModel {
  constructor(index, name) {
    this.index = index;
    this.name = name;
    this.side = 'T';
    this.root = new THREE.Group();
    this.body = new THREE.Mesh(bodyGeo, MATS.T.body);
    this.head = new THREE.Mesh(headGeo, MATS.T.head);
    this.aim = new THREE.Group();
    this.aim.rotation.order = 'YZX';
    this.gun = new THREE.Mesh(gunGeo, MATS.T.gun);
    this.cone = new THREE.Mesh(dirGeo, MATS.T.ring);
    this.aim.add(this.gun, this.cone);
    this.ring = new THREE.Mesh(ringGeo, MATS.T.ring);
    this.ring.position.y = 1.5;
    this.ghostBody = new THREE.Mesh(bodyGeo, MATS.T.ghost);
    this.ghostHead = new THREE.Mesh(headGeo, MATS.T.ghost);
    this.ghostBody.renderOrder = 10;
    this.ghostHead.renderOrder = 10;
    this.label = new Label();
    this.root.add(this.body, this.head, this.aim, this.ring, this.ghostBody, this.ghostHead, this.label.sprite);
  }

  setSide(side) {
    if (side === this.side) return;
    this.side = side;
    const m = MATS[side];
    this.body.material = m.body;
    this.head.material = m.head;
    this.cone.material = m.ring;
    this.ghostBody.material = m.ghost;
    this.ghostHead.material = m.ghost;
    if (this.ring.material !== SELECT_RING) this.ring.material = m.ring;
  }
}

export class PlayersView {
  constructor(scene, demo) {
    this.demo = demo;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.models = demo.players.map((p, i) => {
      const m = new PlayerModel(i, p.name);
      this.group.add(m.root);
      return m;
    });
    this.deathPool = [];
    this.deathGroup = new THREE.Group();
    scene.add(this.deathGroup);
    this.deathTex = { T: crossTexture(COLORS.T), CT: crossTexture(COLORS.CT) };
    this.options = { xray: true, labels: true, deaths: true };
    this.labelScale = 0.05;
  }

  /** Eye position in scene coordinates for a player state. */
  static eye(st, out) {
    const h = EYE_STAND - (EYE_STAND - EYE_CROUCH) * st.duck;
    return out.set(st.x, st.z + h, -st.y);
  }

  static viewDir(st, out) {
    const y = st.yaw * DEG, p = st.pitch * DEG;
    return out.set(Math.cos(p) * Math.cos(y), -Math.sin(p), -Math.cos(p) * Math.sin(y));
  }

  update(tick, states, ctx) {
    const { hidden = -1, selected = -1, bombCarrier = -1 } = ctx;
    for (const m of this.models) {
      const st = states[m.index];
      const visible = st.present && st.alive && m.index !== hidden;
      m.root.visible = visible;
      if (!visible) continue;
      m.setSide(st.side);
      m.root.position.set(st.x, st.z, -st.y);
      const crouch = 1 - 0.25 * st.duck;
      m.body.scale.set(1, crouch, 1);
      m.ghostBody.scale.set(1, crouch, 1);
      const eyeH = EYE_STAND - (EYE_STAND - EYE_CROUCH) * st.duck;
      m.head.position.y = eyeH;
      m.ghostHead.position.y = eyeH;
      m.aim.position.y = eyeH - 12;
      m.aim.rotation.y = st.yaw * DEG;
      m.aim.rotation.z = -st.pitch * DEG;
      m.ghostBody.visible = m.ghostHead.visible = this.options.xray;
      const isSel = m.index === selected;
      m.ring.material = isSel ? SELECT_RING : MATS[st.side].ring;
      m.ring.scale.setScalar(isSel ? 1.35 : 1);
      m.label.sprite.visible = this.options.labels;
      if (this.options.labels) {
        m.label.draw(m.name, st.side, st.hp, m.index === bombCarrier ? 'C4' : '', isSel);
        m.label.sprite.position.y = eyeH + 14;
        // sizeAttenuation=false: scale is relative to the viewport height.
        const s = this.labelScale;
        m.label.sprite.scale.set(s * 4, s, 1);
      }
    }
    this._deaths(tick, ctx.roundStart ?? 0);
  }

  _deaths(tick, roundStart) {
    let n = 0;
    if (this.options.deaths) {
      for (const k of this.demo.kills) {
        if (k.tick > tick) break;
        if (k.tick < roundStart || !k.pos) continue;
        let sp = this.deathPool[n];
        if (!sp) {
          sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, transparent: true, sizeAttenuation: true }));
          sp.scale.set(26, 26, 1);
          this.deathPool.push(sp);
          this.deathGroup.add(sp);
        }
        const side = k.victimSide || 'T';
        if (sp.material.map !== this.deathTex[side]) {
          sp.material.map = this.deathTex[side];
          sp.material.needsUpdate = true;
        }
        sp.position.set(k.pos[0], k.pos[2] + 12, -k.pos[1]);
        sp.visible = true;
        n++;
      }
    }
    for (let i = n; i < this.deathPool.length; i++) this.deathPool[i].visible = false;
  }
}

function crossTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 14;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke();
  g.strokeStyle = color;
  g.lineWidth = 8;
  g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
