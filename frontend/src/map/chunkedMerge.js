/**
 * chunkedMerge.js — frame-budgeted geometry merging, shared by tileManager (final per-material
 * merges) and roadRenderer (internal marking/crosswalk family merges — the "p1 roadgen" chunks).
 */
import * as THREE from 'three';

/**
 * Frame-budgeted replacement for BufferGeometryUtils.mergeGeometries: copies buffers
 * geometry-by-geometry with yields between sources, so a big road-family bucket never runs as one
 * 20-36ms synchronous chunk (the measured p1 roads/terrain vsync-misses — fps-diagnosis). Also
 * pre-computes boundingBox/Sphere from the copy pass, killing three's lazy (synchronous)
 * computeBoundingSphere on first render of a 100k-vert merge.
 * Returns null on shapes it doesn't handle (interleaved attrs, mixed indexing) — caller falls
 * back to the sync merge for those rare buckets.
 */
export async function mergeGeometriesChunked(geos, yieldFn) {
  const first = geos[0];
  const attrNames = Object.keys(first.attributes);
  const indexed = !!first.index;
  let totalVerts = 0, totalIdx = 0;
  for (const g of geos) {
    if (!!g.index !== indexed) return null;
    for (const name of attrNames) {
      const a = g.attributes[name];
      if (!a || a.isInterleavedBufferAttribute) return null;
      if (a.itemSize !== first.attributes[name].itemSize) return null;
    }
    if (Object.keys(g.attributes).length !== attrNames.length) return null;
    totalVerts += g.attributes.position.count;
    totalIdx += indexed ? g.index.count : 0;
  }
  const out = new THREE.BufferGeometry();
  const targets = {};
  for (const name of attrNames) {
    const src = first.attributes[name];
    targets[name] = new src.array.constructor(totalVerts * src.itemSize);
  }
  const idxArr = indexed ? new Uint32Array(totalIdx) : null;
  let vOff = 0, iOff = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  // Copy in <=16k-vert SLICES with yields — per-source yields weren't enough ("p1 merge 41.8ms"
  // tag: one merged-marking source can be 60k+ verts, copied + bbox-scanned in one sync span).
  const SLICE = 16384;
  for (const g of geos) {
    const n = g.attributes.position.count;
    for (let s0 = 0; s0 < n; s0 += SLICE) {
      const s1 = Math.min(n, s0 + SLICE);
      for (const name of attrNames) {
        const src = g.attributes[name];
        const isz = src.itemSize;
        targets[name].set(src.array.subarray(s0 * isz, s1 * isz), (vOff + s0) * isz);
      }
      const p = g.attributes.position.array;
      for (let i = s0 * 3, e = s1 * 3; i < e; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (yieldFn) await yieldFn();
    }
    if (indexed) {
      const si = g.index.array;
      for (let i = 0; i < si.length; i++) {
        idxArr[iOff + i] = si[i] + vOff;
        if ((i & 32767) === 32767 && yieldFn) await yieldFn();
      }
      iOff += si.length;
    }
    vOff += n;
    if (yieldFn) await yieldFn();
  }
  for (const name of attrNames) {
    const attr = new THREE.BufferAttribute(targets[name], first.attributes[name].itemSize);
    attr.normalized = first.attributes[name].normalized;
    out.setAttribute(name, attr);
  }
  if (indexed) out.setIndex(new THREE.BufferAttribute(idxArr, 1));
  out.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
  const _c = new THREE.Vector3();
  out.boundingBox.getCenter(_c);
  out.boundingSphere = new THREE.Sphere(_c.clone(), out.boundingBox.getSize(new THREE.Vector3()).length() / 2 + 1e-4);
  return out;
}

