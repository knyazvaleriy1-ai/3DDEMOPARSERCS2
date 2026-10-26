// Map geometry: the awpy-data collision mesh (AWMH), painted procedurally with a
// per-map palette (plaster / bricks / stone blocks / concrete walls, paved floors,
// tiled roofs), lit by a shadow-casting sun and a sky dome. Falls back to a flat
// radar plane, or a grid if nothing is available.
import * as THREE from '../vendor/three.module.min.js';
import { fetchMapMesh, urls } from './backend.js';
import { paletteFor } from './palettes.js';

const PAINT_PARS = /* glsl */ `
  uniform float cutY;
  uniform vec3 uWall;
  uniform vec3 uWall2;
  uniform vec3 uGround;
  uniform vec3 uRoof;
  uniform vec3 uRoofAlt;
  uniform float uRoofAltFrac;
  uniform vec3 uCeiling;
  uniform vec2 uHeight;      // playable height range (scene Y)
  uniform float uWallPattern;
  uniform vec2 uWallBlock;
  uniform float uFloorTile;
  uniform float uGrout;
  uniform float uAlt;
  uniform float uGrid;
  uniform float uRadarMix;
  uniform sampler2D radar;
  uniform sampler2D radarLower;
  uniform float hasRadar;
  uniform float hasLower;
  uniform float lowerMaxY;
  uniform vec4 radarXf;      // pos_x, pos_y, scale, image size
  varying vec3 vWorldPos;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // 1 inside a cell, dropping to 0 on the mortar / grout lines (anti-aliased).
  float cells(vec2 p, vec2 size, float offsetRows, float width, out vec2 id) {
    vec2 q = p / size;
    q.x += offsetRows * 0.5 * mod(floor(q.y), 2.0);
    id = floor(q);
    vec2 f = fract(q);
    vec2 d = min(f, 1.0 - f) * size;            // distance to the edge in units
    vec2 aa = max(fwidth(p), vec2(1e-3));
    vec2 m = smoothstep(vec2(width) - aa, vec2(width) + aa, d);
    return m.x * m.y;
  }
  float gridLines(vec2 p, float size) {
    vec2 q = p / size;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  // Value noise, 2 octaves (full-detail build only).
  float grain(vec2 p) {
    return 0.65 * vnoise(p) + 0.35 * vnoise(p * 2.7 + 11.3);
  }

  vec3 paintColor() {
    vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    if (dot(n, cameraPosition - vWorldPos) < 0.0) n = -n;
    vec3 an = abs(n);
    vec2 fuv = vWorldPos.xz;
    vec3 col;
#ifndef PAINT_DETAIL
    // Fast build (software GL): flat palette colours, a shade per building.
    if (n.y > 0.7) {
      col = vWorldPos.y > uHeight.y + 60.0 ? mix(uRoof, uRoofAlt, step(1.0 - uRoofAltFrac, hash12(floor(fuv / 320.0) + 7.0))) : uGround;
    } else if (n.y < -0.7) {
      col = uCeiling;
    } else {
      float bld = hash12(floor((vWorldPos.xz - n.xz * 8.0) / 384.0));
      col = mix(uWall, uWall2, step(1.0 - uAlt, bld)) * (0.92 + 0.14 * fract(bld * 97.0));
    }
    return col;
#endif
    // Only the branch for this surface type is evaluated (cheap on software GL).
    if (n.y > 0.7) {
      if (vWorldPos.y > uHeight.y + 60.0) {
        // Roofs: up-facing surfaces above anything a player stands on.
        float roofId = hash12(floor(fuv / 320.0) + 7.0);
        float tiled = step(1.0 - uRoofAltFrac, roofId);
        col = mix(uRoof, uRoofAlt, tiled) * (0.9 + 0.16 * hash12(floor(fuv / 320.0)));
        col *= tiled > 0.5 ? 0.9 + 0.12 * smoothstep(0.3, 0.7, fract(fuv.x / 22.0 + 0.3 * sin(fuv.y / 40.0)))
                           : 0.92 + 0.12 * grain(fuv / 60.0);
      } else {
        // Floors: paving with per-tile variation, dirt noise.
        col = uGround * (0.86 + 0.26 * grain(fuv / 150.0));
        if (uFloorTile > 0.5) {
          vec2 tid;
          float m = cells(fuv, vec2(uFloorTile), 0.0, 0.8, tid);
          col *= mix(1.0 - uGrout * 2.0, 1.0, m) * (0.93 + 0.14 * hash12(tid));
        }
      }
    } else if (n.y < -0.7) {
      col = uCeiling * (0.9 + 0.2 * grain(fuv / 90.0));
    } else {
      // Walls: each "building" (384u cell) gets its own shade, some the alt colour.
      vec2 wuv = an.x > an.z ? vec2(vWorldPos.z, vWorldPos.y) : vec2(vWorldPos.x, vWorldPos.y);
      float h = clamp((vWorldPos.y - uHeight.x) / max(1.0, uHeight.y - uHeight.x), 0.0, 1.0);
      float bld = hash12(floor((vWorldPos.xz - n.xz * 8.0) / 384.0));
      col = mix(uWall, uWall2, step(1.0 - uAlt, bld));
      col *= 0.93 + 0.14 * hash12(vec2(bld * 97.0, 3.0));
      col *= 0.88 + 0.22 * grain(wuv / 70.0);
      if (uWallPattern > 0.5) {
        vec2 bid;
        float width = uWallPattern > 2.5 ? 0.9 : uWallPattern > 1.5 ? 1.1 : 0.7;
        float m = cells(wuv, uWallBlock, uWallPattern > 2.5 ? 0.0 : 1.0, width, bid);
        float depth = uWallPattern > 2.5 ? 0.78 : uWallPattern > 1.5 ? 0.72 : 0.68;
        col *= mix(depth, 1.0, m) * (0.9 + 0.2 * hash12(bid));
      }
      col *= mix(0.82, 1.03, smoothstep(0.0, 0.35, h));   // grime near the ground
    }

    if (hasRadar > 0.5 && uRadarMix > 0.0) {
      vec2 px = vec2((vWorldPos.x - radarXf.x) / radarXf.z, (radarXf.y + vWorldPos.z) / radarXf.z) / radarXf.w;
      vec2 uv = vec2(px.x, 1.0 - px.y);
      vec4 rc = (hasLower > 0.5 && vWorldPos.y < lowerMaxY) ? texture2D(radarLower, uv) : texture2D(radar, uv);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      col = mix(col, rc.rgb * 1.2 + 0.04, rc.a * inside * smoothstep(0.55, 0.85, n.y) * uRadarMix);
    }
    if (uGrid > 0.5) {
      vec2 gp = (an.y > an.x && an.y > an.z) ? fuv : (an.x > an.z ? vec2(vWorldPos.z, vWorldPos.y) : vec2(vWorldPos.x, vWorldPos.y));
      float fade = 1.0 - smoothstep(1200.0, 5000.0, length(cameraPosition - vWorldPos));
      col *= 1.0 - fade * (0.07 * gridLines(gp, 64.0) + 0.12 * gridLines(gp, 256.0));
    }
    return col;
  }
`;

function srgb(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

export class MapView {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = {
      cutY: { value: 1e6 },
      uWall: { value: new THREE.Color() },
      uWall2: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uRoof: { value: new THREE.Color() },
      uRoofAlt: { value: new THREE.Color() },
      uRoofAltFrac: { value: 0 },
      uCeiling: { value: new THREE.Color() },
      uHeight: { value: new THREE.Vector2(-500, 500) },
      uWallPattern: { value: 0 },
      uWallBlock: { value: new THREE.Vector2(48, 24) },
      uFloorTile: { value: 48 },
      uGrout: { value: 0.15 },
      uAlt: { value: 0.35 },
      uGrid: { value: 0 },
      uRadarMix: { value: 0 },
      radar: { value: null },
      radarLower: { value: null },
      hasRadar: { value: 0 },
      hasLower: { value: 0 },
      lowerMaxY: { value: -1e9 },
      radarXf: { value: new THREE.Vector4(0, 0, 1, 1024) },
    };
    this.bounds = null;
    this.kind = 'none';
    this.info = null;
    this.palette = paletteFor('');
  }

  setCut(y) {
    this.uniforms.cutY.value = y;
  }

  setOptions({ grid, radar, detail }) {
    if (grid !== undefined) this.uniforms.uGrid.value = grid ? 1 : 0;
    if (detail !== undefined && this.material) {
      const want = detail ? { PAINT_DETAIL: 1 } : {};
      if (('PAINT_DETAIL' in this.material.defines) !== !!detail) {
        this.material.defines = want;
        this.material.needsUpdate = true;
      }
    }
    if (radar !== undefined) this.uniforms.uRadarMix.value = radar ? 0.85 : 0;
  }

  _applyPalette(p) {
    const u = this.uniforms;
    u.uWall.value.copy(srgb(p.wall));
    u.uWall2.value.copy(srgb(p.wall2));
    u.uGround.value.copy(srgb(p.ground));
    u.uRoof.value.copy(srgb(p.roof));
    u.uRoofAlt.value.copy(srgb(p.roofAlt));
    u.uRoofAltFrac.value = p.roofAltFrac;
    u.uCeiling.value.copy(srgb(p.ceiling));
    u.uWallPattern.value = p.wallPattern;
    u.uWallBlock.value.set(p.wallBlock[0], p.wallBlock[1]);
    u.uFloorTile.value = p.floorTile;
    u.uGrout.value = p.grout;
    u.uAlt.value = p.alt;
  }

  _material() {
    const u = this.uniforms;
    const inject = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      return shader;
    };
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true });
    mat.defines = { PAINT_DETAIL: 1 };
    this.material = mat;
    mat.onBeforeCompile = (shader) => {
      inject(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PAINT_PARS}`)
        .replace('void main() {', 'void main() {\n  if (vWorldPos.y > cutY) discard;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( paintColor(), opacity );');
    };
    return mat;
  }

  /**
   * Load geometry + radar and set up sky and sun.
   * ``lights`` = {hemi, sun, renderer} owned by the viewer.
   */
  async load(mapName, playerBounds, lights) {
    let info = null;
    try {
      info = await fetch(urls.mapInfo(mapName)).then((r) => r.json());
    } catch (_) { /* offline */ }
    this.info = info;
    const xf = info && info.transform;
    this.palette = paletteFor(mapName);
    this._applyPalette(this.palette);

    const radarTasks = [];
    if (xf) {
      radarTasks.push(loadTexture(urls.mapRadar(mapName)).then((tex) => {
        if (!tex) return;
        this.uniforms.radar.value = tex;
        this.uniforms.hasRadar.value = 1;
        this.uniforms.radarXf.value.set(xf.pos_x, xf.pos_y, xf.scale, tex.image.width || 1024);
        this.radarTex = tex;
      }));
      if (info.lower) {
        radarTasks.push(loadTexture(urls.mapRadar(mapName, true)).then((tex) => {
          if (!tex) return;
          this.uniforms.radarLower.value = tex;
          this.uniforms.hasLower.value = 1;
          this.uniforms.lowerMaxY.value = info.lowerMaxZ;
        }));
      }
    }

    let mesh = null;
    try {
      const buf = await fetchMapMesh(mapName);
      if (buf) mesh = parseMesh(buf);
    } catch (err) {
      console.warn('map mesh unavailable', err);
    }
    await Promise.all(radarTasks);

    if (playerBounds) this.uniforms.uHeight.value.set(playerBounds.min.y - 40, playerBounds.max.y + 90);
    if (mesh) {
      // Chunks of 1024u let the renderer skip everything outside the view
      // (big maps like Inferno have ~0.5M triangles).
      const material = this._material();
      for (const part of chunkGeometry(mesh, 1024)) {
        const obj = new THREE.Mesh(part, material);
        obj.castShadow = true;
        obj.receiveShadow = true;
        this.group.add(obj);
      }
      mesh.computeBoundingBox();
      this.bounds = mesh.boundingBox.clone();
      this.kind = 'mesh';
    } else if (this.radarTex && xf) {
      this._radarPlane(xf, playerBounds);
      this.kind = 'radar';
    } else {
      this._grid(playerBounds);
      this.kind = 'grid';
    }
    this.mesh = mesh;
    this._sky();
    if (lights) this._lights(lights, playerBounds || this.bounds);
    return this.kind;
  }

  _sky() {
    const p = this.palette;
    const geo = new THREE.SphereGeometry(1, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(p.skyTop) },
        horizon: { value: new THREE.Color(p.skyHorizon) },
        sunDir: { value: new THREE.Vector3(...p.sunDir).normalize() },
      },
      vertexShader: `varying vec3 vDir; void main() { vDir = position; vec4 v = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * v; gl_Position.z = gl_Position.w * 0.99999; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main() { vec3 d = normalize(vDir); float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
          vec3 c = mix(horizon, top, t); c = mix(c, horizon * 0.8, clamp(-d.y * 3.0, 0.0, 1.0));
          float sun = pow(max(dot(d, sunDir), 0.0), 600.0) * 1.5 + pow(max(dot(d, sunDir), 0.0), 12.0) * 0.18;
          gl_FragColor = vec4(c + vec3(1.0, 0.95, 0.85) * sun, 1.0); }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.sky.scale.setScalar(30000);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(new THREE.Color(p.skyHorizon), 9000, 40000);
  }

  _lights({ hemi, sun, renderer }, bounds) {
    const p = this.palette;
    // Neutral-ish fill light so the palette colours read as painted, not orange.
    hemi.color.set(p.skyTop).lerp(new THREE.Color('#ffffff'), 0.65);
    hemi.groundColor.set(p.ground).lerp(new THREE.Color('#8a8a8a'), 0.5);
    hemi.intensity = 1.25;
    sun.color.set(p.sun).lerp(new THREE.Color('#ffffff'), 0.5);
    sun.intensity = 2.3;
    const b = bounds || new THREE.Box3(new THREE.Vector3(-3000, -200, -3000), new THREE.Vector3(3000, 400, 3000));
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.62 + 300;
    const dir = new THREE.Vector3(...p.sunDir).normalize();
    sun.position.copy(center).addScaledVector(dir, radius * 2);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    sun.castShadow = true;
    const cam = sun.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 10; cam.far = radius * 4;
    cam.updateProjectionMatrix();
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 1.5;
    if (renderer) {
      // The map is static: its shadow map is rendered once (see Viewer.applySettings).
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.setClearColor(new THREE.Color(p.skyHorizon), 1);
    }
  }

  /** Keep the sky dome centred on the camera. */
  follow(camera) {
    if (this.sky) this.sky.position.copy(camera.position);
  }

  _radarPlane(xf, playerBounds) {
    const size = (this.radarTex.image.width || 1024) * xf.scale;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({ map: this.radarTex, transparent: true, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    const floorY = playerBounds ? playerBounds.min.y - 2 : 0;
    plane.position.set(xf.pos_x + size / 2, floorY, -(xf.pos_y - size / 2));
    this.group.add(plane);
    this.bounds = new THREE.Box3().setFromObject(plane);
    this._grid(playerBounds, 0.25);
  }

  _grid(playerBounds, opacity = 0.6) {
    const b = playerBounds || new THREE.Box3(new THREE.Vector3(-3000, 0, -3000), new THREE.Vector3(3000, 0, 3000));
    const size = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) + 1500;
    const grid = new THREE.GridHelper(size, Math.round(size / 128), 0x3a414d, 0x22262e);
    grid.material.transparent = true;
    grid.material.opacity = opacity;
    grid.position.set((b.min.x + b.max.x) / 2, b.min.y - 4, (b.min.z + b.max.z) / 2);
    this.group.add(grid);
    if (!this.bounds) this.bounds = b.clone();
  }
}

function loadTexture(url) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        resolve(tex);
      },
      undefined,
      () => resolve(null),
    );
  });
}

export function parseMesh(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'AWMH') throw new Error('bad mesh magic');
  const nv = dv.getUint32(8, true);
  const nt = dv.getUint32(12, true);
  const src = new Float32Array(buffer, 16, nv * 3);
  const idx = new Uint32Array(buffer.slice(16 + nv * 12, 16 + nv * 12 + nt * 12));
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = src[i * 3];
    pos[i * 3 + 1] = src[i * 3 + 2];
    pos[i * 3 + 2] = -src[i * 3 + 1];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // Shading uses per-pixel flat normals; vertex normals only feed the shadow normal bias.
  geo.computeVertexNormals();
  return geo;
}

/**
 * Split an indexed geometry into spatial chunks (by triangle centroid on the
 * XZ grid). Chunks share the vertex attributes; each gets its own index and a
 * bounding volume of just its triangles, so frustum culling works per chunk.
 */
export function chunkGeometry(geo, cell = 1024) {
  const pos = geo.attributes.position.array;
  const idx = geo.index.array;
  const buckets = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const cx = (pos[a] + pos[b] + pos[c]) / 3;
    const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    const key = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
    let tris = buckets.get(key);
    if (!tris) buckets.set(key, (tris = []));
    tris.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const v = new THREE.Vector3();
  const out = [];
  for (const tris of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    if (geo.attributes.normal) g.setAttribute('normal', geo.attributes.normal);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1));
    const box = new THREE.Box3();
    for (const i of tris) box.expandByPoint(v.fromArray(pos, i * 3));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    out.push(g);
  }
  return out;
}
