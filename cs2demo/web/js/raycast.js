// Ray casts against the map's collision mesh: where bullets hit walls, and
// which smoke voxels a wall separates. Triangles are binned into a uniform
// grid on the ground plane (XZ in three.js coordinates, Y up); a ray walks
// the cells it crosses (2D DDA) and only tests their triangles.

const EPS = 1e-7;

export class MeshRaycaster {
  /** ``positions``: xyz per vertex (three.js coordinates), ``index``: 3 per triangle. */
  constructor(positions, index, cell = 96) {
    this.pos = positions;
    this.idx = index;
    this.cell = cell;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], z = positions[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!(minX <= maxX)) { minX = maxX = minZ = maxZ = 0; }
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
    this.nz = Math.max(1, Math.floor((maxZ - minZ) / cell) + 1);
    const nt = index.length / 3;
    const ranges = new Int32Array(nt * 4);
    const counts = new Uint32Array(this.nx * this.nz + 1);
    for (let t = 0; t < nt; t++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k] * 3;
        const x = positions[v], z = positions[v + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const cx0 = this._cx(x0), cx1 = this._cx(x1), cz0 = this._cz(z0), cz1 = this._cz(z1);
      ranges.set([cx0, cx1, cz0, cz1], t * 4);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) counts[cz * this.nx + cx + 1]++;
    }
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    this.start = counts;
    this.items = new Uint32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    for (let t = 0; t < nt; t++) {
      const [cx0, cx1, cz0, cz1] = ranges.subarray(t * 4, t * 4 + 4);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.items[fill[cz * this.nx + cx]++] = t;
    }
    this.stamp = new Uint32Array(nt);
    this.stampId = 0;
  }

  _cx(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))); }
  _cz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell))); }

  /**
   * Nearest hit of the ray o + t·d (``d`` normalised) with 0 < t <= maxT:
   * fills ``out`` with {t, nx, ny, nz} (normal facing the ray) and returns it, or null.
   */
  cast(ox, oy, oz, dx, dy, dz, maxT, out = {}) {
    if (++this.stampId === 0xffffffff) { this.stamp.fill(0); this.stampId = 1; }
    const id = this.stampId;
    const cell = this.cell;
    const fx = (ox - this.minX) / cell, fz = (oz - this.minZ) / cell;
    let cx = Math.floor(fx), cz = Math.floor(fz);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(cell / dz) : Infinity;
    let tMaxX = dx > 0 ? (cx + 1 - fx) * tDeltaX : dx < 0 ? (fx - cx) * tDeltaX : Infinity;
    let tMaxZ = dz > 0 ? (cz + 1 - fz) * tDeltaZ : dz < 0 ? (fz - cz) * tDeltaZ : Infinity;
    let best = maxT, bestTri = -1, tCell = 0;
    for (let guard = 0; tCell <= best && guard < 100000; guard++) {
      if (cx >= 0 && cz >= 0 && cx < this.nx && cz < this.nz) {
        const c = cz * this.nx + cx;
        for (let i = this.start[c], end = this.start[c + 1]; i < end; i++) {
          const tri = this.items[i];
          if (this.stamp[tri] === id) continue;
          this.stamp[tri] = id;
          const t = this._hit(tri, ox, oy, oz, dx, dy, dz);
          if (t > 1e-3 && t < best) { best = t; bestTri = tri; }
        }
      } else if ((cx < 0 && stepX < 0) || (cx >= this.nx && stepX > 0) || (cz < 0 && stepZ < 0) || (cz >= this.nz && stepZ > 0)
        || (dx === 0 && (cx < 0 || cx >= this.nx)) || (dz === 0 && (cz < 0 || cz >= this.nz))) {
        break; // left the grid for good
      }
      if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDeltaX; cx += stepX; } else { tCell = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
      if (tCell === Infinity) break;
    }
    if (bestTri < 0) return null;
    this._normal(bestTri, out);
    if (out.nx * dx + out.ny * dy + out.nz * dz > 0) { out.nx = -out.nx; out.ny = -out.ny; out.nz = -out.nz; }
    out.t = best;
    return out;
  }

  /** Is the straight line from a to b blocked by a wall? */
  blocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    return this.cast(ax, ay, az, dx / len, dy / len, dz / len, len) !== null;
  }

  // Möller–Trumbore, two-sided: distance along the ray or -1.
  _hit(tri, ox, oy, oz, dx, dy, dz) {
    const p = this.pos, i = this.idx;
    const a = i[tri * 3] * 3, b = i[tri * 3 + 1] * 3, c = i[tri * 3 + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -EPS && det < EPS) return -1;
    const inv = 1 / det;
    const tx = ox - p[a], ty = oy - p[a + 1], tz = oz - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  _normal(tri, out) {
    const p = this.pos, i = this.idx;
    const a = i[tri * 3] * 3, b = i[tri * 3 + 1] * 3, c = i[tri * 3 + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    out.nx = nx; out.ny = ny; out.nz = nz;
    return out;
  }
}
