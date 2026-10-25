// Map geometry: awpy-data collision mesh (AWMH) with the radar image projected
// onto floors. Falls back to a flat radar plane, or a grid if nothing is available.
import * as THREE from '../vendor/three.module.min.js';

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D radar;
  uniform sampler2D radarLower;
  uniform float hasRadar;
  uniform float hasLower;
  uniform float lowerMaxY;
  uniform vec4 radarXf;      // pos_x, pos_y, scale, image size
  uniform float cutY;        // discard everything above (roof cut)
  uniform vec3 fogColor;
  uniform vec2 fogRange;
  uniform vec3 sunDir;
  uniform vec2 heightRange;
  varying vec3 vWorld;

  // Anti-aliased grid lines (distance to the nearest line, in pixels).
  float gridLines(vec2 p, float size) {
    vec2 q = p / size;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    if (vWorld.y > cutY) discard;
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 toCam = cameraPosition - vWorld;
    if (dot(n, toCam) < 0.0) n = -n;
    float up = clamp(n.y, 0.0, 1.0);
    float floorness = smoothstep(0.55, 0.85, up);

    float h = clamp((vWorld.y - heightRange.x) / max(1.0, heightRange.y - heightRange.x), 0.0, 1.0);
    vec3 wallC = mix(vec3(0.50, 0.52, 0.56), vec3(0.80, 0.78, 0.74), h);
    vec3 floorC = mix(vec3(0.42, 0.44, 0.46), vec3(0.66, 0.64, 0.58), h);
    vec3 base = mix(wallC, floorC, floorness);

    if (hasRadar > 0.5) {
      float wx = vWorld.x;
      float wy = -vWorld.z;
      vec2 px = vec2((wx - radarXf.x) / radarXf.z, (radarXf.y - wy) / radarXf.z) / radarXf.w;
      vec2 uv = vec2(px.x, 1.0 - px.y);
      vec4 rc = (hasLower > 0.5 && vWorld.y < lowerMaxY) ? texture2D(radarLower, uv) : texture2D(radar, uv);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      float k = rc.a * inside * (0.25 + 0.6 * floorness);
      base = mix(base, rc.rgb * 1.15 + 0.05, k);
    }

    // Faces pointing along X and Z get slightly different tints so walls read
    // as separate planes even in flat lighting.
    vec3 an = abs(n);
    base *= mix(1.0, mix(0.93, 1.04, an.x / max(an.x + an.z, 1e-3)), 1.0 - floorness);

    float diff = max(dot(n, normalize(sunDir)), 0.0);
    float hemi = 0.5 + 0.5 * n.y;
    vec3 col = base * (0.30 + 0.40 * hemi + 0.55 * diff);

    // "Dev texture" grid: 64u minor / 256u major lines, fading with distance.
    vec2 gp = (an.y > an.x && an.y > an.z) ? vWorld.xz : (an.x > an.z ? vWorld.zy : vWorld.xy);
    float camDist = length(toCam);
    float gridFade = 1.0 - smoothstep(1200.0, 5000.0, camDist);
    col *= 1.0 - gridFade * (0.06 * gridLines(gp, 64.0) + 0.10 * gridLines(gp, 256.0));
    // Darken towards the cut plane slightly to hint at depth when roofs are removed.
    col *= mix(1.0, 0.82, smoothstep(cutY - 400.0, cutY, vWorld.y) * step(cutY, 1.0e5));
    col = mix(col, fogColor, smoothstep(fogRange.x, fogRange.y, camDist) * 0.85);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class MapView {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = {
      radar: { value: null },
      radarLower: { value: null },
      hasRadar: { value: 0 },
      hasLower: { value: 0 },
      lowerMaxY: { value: -1e9 },
      radarXf: { value: new THREE.Vector4(0, 0, 1, 1024) },
      cutY: { value: 1e6 },
      fogColor: { value: new THREE.Color(0x0d0f12) },
      fogRange: { value: new THREE.Vector2(4000, 14000) },
      sunDir: { value: new THREE.Vector3(0.45, 0.8, 0.35) },
      heightRange: { value: new THREE.Vector2(-500, 500) },
    };
    this.bounds = null;
    this.kind = 'none';
    this.info = null;
  }

  setCut(y) {
    this.uniforms.cutY.value = y;
  }

  async load(mapName, playerBounds) {
    let info = null;
    try {
      info = await fetch(`/api/maps/${mapName}/info`).then((r) => r.json());
    } catch (_) { /* offline */ }
    this.info = info;
    const xf = info && info.transform;

    const radarTasks = [];
    if (xf) {
      radarTasks.push(loadTexture(`/api/maps/${mapName}/radar`).then((tex) => {
        if (!tex) return;
        this.uniforms.radar.value = tex;
        this.uniforms.hasRadar.value = 1;
        this.uniforms.radarXf.value.set(xf.pos_x, xf.pos_y, xf.scale, tex.image.width || 1024);
        this.radarTex = tex;
      }));
      if (info.lower) {
        radarTasks.push(loadTexture(`/api/maps/${mapName}/radar?lower=1`).then((tex) => {
          if (!tex) return;
          this.uniforms.radarLower.value = tex;
          this.uniforms.hasLower.value = 1;
          this.uniforms.lowerMaxY.value = info.lowerMaxZ;
        }));
      }
    }

    let mesh = null;
    try {
      const res = await fetch(`/api/maps/${mapName}/mesh`);
      if (res.ok) mesh = parseMesh(await res.arrayBuffer());
    } catch (err) {
      console.warn('map mesh unavailable', err);
    }
    await Promise.all(radarTasks);

    if (mesh) {
      const material = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
      });
      const obj = new THREE.Mesh(mesh, material);
      obj.frustumCulled = false;
      this.group.add(obj);
      mesh.computeBoundingBox();
      this.bounds = mesh.boundingBox.clone();
      this.kind = 'mesh';
      // Use the player height range (not skybox junk) for colouring.
      if (playerBounds) this.uniforms.heightRange.value.set(playerBounds.min.y - 100, playerBounds.max.y + 250);
      else this.uniforms.heightRange.value.set(this.bounds.min.y, this.bounds.max.y);
    } else if (this.radarTex && xf) {
      this._radarPlane(xf, playerBounds);
      this.kind = 'radar';
    } else {
      this._grid(playerBounds);
      this.kind = 'grid';
    }
    this.mesh = mesh;
    return this.kind;
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
        tex.colorSpace = THREE.NoColorSpace;
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
  return geo;
}
