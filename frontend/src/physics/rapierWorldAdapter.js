/**
 * rapierWorldAdapter — presents a cannon-es-World-compatible surface (addBody / removeBody / bodies) but
 * converts each cannon Body's shapes into Rapier colliders. This lets tileManager keep building CANNON.Body
 * collider descriptions EXACTLY as it does for cannon, while the actual simulation runs on Rapier.
 *
 * Both cannon and the Rapier car operate in the same physics/local frame (px = -(worldX-originX)), and the
 * cannon bodies tileManager builds are already in that frame — so shapes/offsets convert 1:1, no mirror math.
 *
 * Terrain uses Rapier's NATIVE heightfield (implicit grid: no BVH build on tile load, near-free wheel
 * raycasts — this is where Rapier's speed/alloc win over cannon comes from). Verified API contract
 * (rapier3d-compat d.ts): ColliderDesc.heightfield(nrows, ncols, heights, scale) where nrows/ncols are CELL
 * counts, heights is a column-major (nrows+1)×(ncols+1) POINT matrix along local y, and scale.x/scale.z are
 * the total extents of the local x/z plane (centred at the origin; columns span x, rows span z).
 *
 * The one thing the docs do NOT pin down is which direction the row/col indices run along z/x. Guessing a
 * convention is how migrations silently misplace geometry — so we PROBE it at init: build a 1-cell
 * heightfield with a known tilt far below the map, raycast it, and read the actual orientation. The matrix
 * fill self-corrects from the probe; if the probe fails entirely we fall back to the (slower but proven)
 * trimesh conversion and warn loudly.
 */

import * as CANNON from 'cannon-es';

const SIN45 = Math.SQRT1_2, COS45 = Math.SQRT1_2; // Rx(+90°) quaternion components

// quaternion multiply a∘b and rotate-vector-by-quaternion (tiny, dependency-free)
const _qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const _qrot = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
};

/**
 * Probe Rapier's heightfield index conventions at runtime. Builds two 1-cell fields with known tilts far
 * below the world, raycasts them, and reads which way the column/row indices actually run along local x/z.
 * Returns { colsRunPlusX, rowsRunPlusZ } or null if the probe can't confirm (→ caller falls back to trimesh).
 * MUST run before gameplay bodies exist: it calls world.step() once to refresh the query pipeline.
 */
function probeHeightfieldConvention(world, RAPIER) {
  const probes = [];
  try {
    const mk = (x0, heights) => {
      const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x0, -2000, 0));
      world.createCollider(RAPIER.ColliderDesc.heightfield(1, 1, Float32Array.from(heights), { x: 2, y: 1, z: 2 }), rb);
      probes.push(rb);
      return rb;
    };
    // Column-major 2×2 point matrix: [c0r0, c0r1, c1r0, c1r1]
    mk(0, [0, 0, 10, 10]);     // height rises with COLUMN index → tells us the x direction
    mk(100, [0, 10, 0, 10]);   // height rises with ROW index    → tells us the z direction
    world.step(); // query pipeline refresh — world contains only the probes at this point

    const h = (x, z) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: -1980, z }, { x: 0, y: -1, z: 0 }), 40, true);
      return hit ? 20 - hit.timeOfImpact : null; // height above the body origin (y=-2000)
    };
    // At +x/+z quarter-points the field reads 7.5 if the index runs positive, 2.5 if it runs negative.
    const hx = h(0.5, 0), hz = h(100, 0.5);
    const read = (v) => (v != null && Math.abs(v - 7.5) < 0.5) ? true : (v != null && Math.abs(v - 2.5) < 0.5) ? false : null;
    const colsRunPlusX = read(hx), rowsRunPlusZ = read(hz);
    if (colsRunPlusX == null || rowsRunPlusZ == null) {
      console.warn(`[rapier] heightfield probe inconclusive (hx=${hx}, hz=${hz}) — falling back to trimesh terrain`);
      return null;
    }
    console.warn(`[rapier] heightfield convention probed: colsRunPlusX=${colsRunPlusX}, rowsRunPlusZ=${rowsRunPlusZ}`);
    return { colsRunPlusX, rowsRunPlusZ };
  } catch (e) {
    console.warn('[rapier] heightfield probe failed — falling back to trimesh terrain:', e);
    return null;
  } finally {
    for (const rb of probes) { try { world.removeRigidBody(rb); } catch {} }
  }
}

export function createRapierWorldAdapter(rapierWorld, RAPIER) {
  const bodies = [];                 // cannon bodies "in the world" (tileManager reads world.bodies)
  const _rb = new WeakMap();         // cannon body -> Rapier rigid body
  const T = CANNON.Shape.types;

  // Probe ONCE, eagerly (the adapter is created before the car / before gameplay stepping).
  const hfConv = probeHeightfieldConvention(rapierWorld, RAPIER);

  // Fallback: cannon Heightfield → trimesh in the shape's LOCAL frame (proven placement; slower).
  function heightfieldTrimeshDesc(shape) {
    const data = shape.data; const es = shape.elementSize;
    const cols = data.length, rows = data[0].length;
    const stride = Math.max(1, Math.ceil(Math.max(cols, rows) / 24));
    const cN = Math.floor((cols - 1) / stride) + 1, rN = Math.floor((rows - 1) / stride) + 1;
    const verts = new Float32Array(cN * rN * 3);
    for (let ci = 0; ci < cN; ci++) {
      const c = Math.min(ci * stride, cols - 1);
      for (let ri = 0; ri < rN; ri++) {
        const r = Math.min(ri * stride, rows - 1);
        const k = (ci * rN + ri) * 3;
        verts[k] = c * es; verts[k + 1] = r * es; verts[k + 2] = data[c][r];
      }
    }
    const idx = new Uint32Array((cN - 1) * (rN - 1) * 6);
    let n = 0;
    for (let ci = 0; ci < cN - 1; ci++) for (let ri = 0; ri < rN - 1; ri++) {
      const a = ci * rN + ri, b = (ci + 1) * rN + ri, cc = (ci + 1) * rN + (ri + 1), d = ci * rN + (ri + 1);
      idx[n++] = a; idx[n++] = b; idx[n++] = cc; idx[n++] = a; idx[n++] = cc; idx[n++] = d;
    }
    return RAPIER.ColliderDesc.trimesh(verts, idx);
  }

  // Native heightfield. The cannon HF is authored in its LOCAL frame as data[c][r] → point (c·es, r·es,
  // height) with the BODY carrying a −90° X rotation into the world. We build the Rapier field in Rapier's
  // own frame (y-up, centred), then attach a collider-LOCAL transform (Rx(+90°) + centre offset) that maps
  // it onto cannon's local frame exactly — so the body transform lands it precisely where cannon put it
  // (same placement the proven trimesh had). Index directions come from the runtime probe, not assumption:
  //   x_c = sx/2 + x_r  → cannon col c = ci   (or cols-1-ci if columns run −x)
  //   y_c = sz/2 − z_r  → cannon row r = rows-1-rj (or rj if rows run −z)
  function heightfieldNativeDesc(shape) {
    const data = shape.data; const es = shape.elementSize;
    const cols = data.length, rows = data[0].length;
    if (cols < 2 || rows < 2) return null;
    const sx = (cols - 1) * es, sz = (rows - 1) * es;
    const heights = new Float32Array(cols * rows); // column-major, cols columns × rows points each
    for (let ci = 0; ci < cols; ci++) {
      const c = hfConv.colsRunPlusX ? ci : cols - 1 - ci;
      const col = data[c];
      const base = ci * rows;
      if (hfConv.rowsRunPlusZ) {
        for (let rj = 0; rj < rows; rj++) heights[base + rj] = col[rows - 1 - rj];
      } else {
        for (let rj = 0; rj < rows; rj++) heights[base + rj] = col[rj];
      }
    }
    return RAPIER.ColliderDesc.heightfield(rows - 1, cols - 1, heights, { x: sx, y: 1, z: sz })
      .setTranslation(sx / 2, sz / 2, 0)
      .setRotation({ x: SIN45, y: 0, z: 0, w: COS45 });
  }

  function shapeDesc(shape) {
    switch (shape.type) {
      case T.BOX: {
        const h = shape.halfExtents;
        return RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z);
      }
      case T.TRIMESH: {
        const v = shape.vertices instanceof Float32Array ? shape.vertices : Float32Array.from(shape.vertices);
        const idx = shape.indices instanceof Uint32Array ? shape.indices : Uint32Array.from(shape.indices);
        return RAPIER.ColliderDesc.trimesh(v, idx);
      }
      case T.CONVEXPOLYHEDRON: {
        const pts = new Float32Array(shape.vertices.length * 3);
        for (let i = 0; i < shape.vertices.length; i++) { const p = shape.vertices[i]; pts[i * 3] = p.x; pts[i * 3 + 1] = p.y; pts[i * 3 + 2] = p.z; }
        return RAPIER.ColliderDesc.convexHull(pts);
      }
      case T.CYLINDER:
        // cannon Cylinder axis ≈ Y here (vertical pillars); Rapier cylinder is Y-axis too.
        return RAPIER.ColliderDesc.cylinder((shape.height ?? 1) / 2, shape.radiusTop ?? shape.radius ?? 0.5);
      case T.HEIGHTFIELD:
        return hfConv ? heightfieldNativeDesc(shape) : heightfieldTrimeshDesc(shape);
      default:
        return null; // unsupported → skip this shape
    }
  }

  // ── Streaming mirror ────────────────────────────────────────────────────────
  // Measured (Node experiment + in-game): Rapier's step cost scales with resident collider count — 32k
  // mirrored colliders ⇒ ~8ms/step, worse than cannon. Statics the car can't reach contribute cost and
  // nothing else. So the mirror keeps a WORKING SET: every cannon body is registered (with a cheap bounding
  // radius), but only bodies within R_IN of the car are materialized as Rapier colliders; past R_OUT they
  // dematerialize. Materialization is budgeted per frame so tile arrival never spikes. tick() also syncs
  // poses for cannon bodies that move (traffic cars etc.) so the mirror never holds stale obstacles.
  const R_IN = 260, R_OUT = 340;            // hysteresis (car tops out ~30 m/s; streaming has huge margin)
  const MATERIALIZE_BUDGET = 900;           // max colliders created per tick (spread big tiles over frames)
  const entries = [];                       // { body, r, rb } — r = bounding radius around body.position
  const _entryOf = new WeakMap();

  function shapeRadius(shape) {
    switch (shape.type) {
      case T.BOX: { const h = shape.halfExtents; return Math.hypot(h.x, h.y, h.z); }
      case T.TRIMESH: {
        let m = 0; const v = shape.vertices;
        for (let i = 0; i < v.length; i += 3) { const d = v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2]; if (d > m) m = d; }
        return Math.sqrt(m);
      }
      case T.CONVEXPOLYHEDRON: {
        let m = 0; for (const p of shape.vertices) { const d = p.x * p.x + p.y * p.y + p.z * p.z; if (d > m) m = d; }
        return Math.sqrt(m);
      }
      case T.CYLINDER: return Math.max(shape.radiusTop ?? shape.radius ?? 0.5, (shape.height ?? 1) / 2);
      case T.HEIGHTFIELD: {
        const es = shape.elementSize, cols = shape.data.length, rows = shape.data[0].length;
        return Math.hypot((cols - 1) * es, (rows - 1) * es); // corner-origin field → generous full-diagonal
      }
      default: return 5;
    }
  }

  function boundingRadius(cannonBody) {
    const shapes = cannonBody.shapes, offs = cannonBody.shapeOffsets;
    let r = 0;
    for (let i = 0; i < shapes.length; i++) {
      const o = offs[i];
      const rr = Math.hypot(o.x, o.y, o.z) + shapeRadius(shapes[i]);
      if (rr > r) r = rr;
    }
    return r;
  }

  function materialize(entry) {
    const cannonBody = entry.body;
    const p = cannonBody.position, q = cannonBody.quaternion;
    const rb = rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    const shapes = cannonBody.shapes, offs = cannonBody.shapeOffsets, oris = cannonBody.shapeOrientations;
    let added = 0;
    for (let i = 0; i < shapes.length; i++) {
      const desc = shapeDesc(shapes[i]);
      if (!desc) continue;
      // COMPOSE the cannon shape offset with any local transform the desc already carries (the native
      // heightfield sets one) instead of overwriting it: final = cannonOffset ∘ descLocal.
      const o = offs[i], r = oris[i];
      const p0 = desc.translation || { x: 0, y: 0, z: 0 };
      const r0 = desc.rotation || { x: 0, y: 0, z: 0, w: 1 };
      const pr = _qrot(r, p0);
      desc.setTranslation(o.x + pr.x, o.y + pr.y, o.z + pr.z).setRotation(_qmul(r, r0));
      try { rapierWorld.createCollider(desc, rb); added++; } catch (e) { /* skip a bad shape rather than crash the tile */ }
    }
    if (added === 0) { rapierWorld.removeRigidBody(rb); entry.dead = true; return 0; } // nothing supported
    entry.rb = rb;
    entry.px = p.x; entry.py = p.y; entry.pz = p.z; entry.qy = q.y; entry.qw = q.w;
    return added;
  }

  function dematerialize(entry) {
    if (!entry.rb) return;
    try { rapierWorld.removeRigidBody(entry.rb); } catch {}
    entry.rb = null;
  }

  function addBody(cannonBody) {
    bodies.push(cannonBody);
    const entry = { body: cannonBody, r: boundingRadius(cannonBody), rb: null, dead: false, px: 0, py: 0, pz: 0, qy: 0, qw: 1 };
    entries.push(entry);
    _entryOf.set(cannonBody, entry);
    return cannonBody;
  }

  function removeBody(cannonBody) {
    const entry = _entryOf.get(cannonBody);
    if (entry) {
      dematerialize(entry);
      _entryOf.delete(cannonBody);
      const j = entries.indexOf(entry);
      if (j >= 0) entries.splice(j, 1);
    }
    const i = bodies.indexOf(cannonBody);
    if (i >= 0) bodies.splice(i, 1);
  }

  /**
   * Stream the working set around (x, z) — call once per frame with the car's physics-frame position.
   * Materializes bodies entering R_IN (budgeted), drops bodies past R_OUT, and re-syncs the pose of any
   * materialized body whose cannon source moved (traffic cars are repositioned every frame by trafficSystem).
   */
  function tick(x, z) {
    let budget = MATERIALIZE_BUDGET;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.dead) continue;
      const bp = e.body.position;
      const d = Math.hypot(bp.x - x, bp.z - z) - e.r;
      if (!e.rb) {
        if (d < R_IN && budget > 0) budget -= materialize(e);
      } else if (d > R_OUT) {
        dematerialize(e);
      } else {
        // Pose sync for movers (yaw-only rotation covers traffic; full quat would also be fine).
        const bq = e.body.quaternion;
        if (Math.abs(bp.x - e.px) + Math.abs(bp.y - e.py) + Math.abs(bp.z - e.pz) > 1e-3 ||
            Math.abs(bq.y - e.qy) + Math.abs(bq.w - e.qw) > 1e-3) {
          e.rb.setTranslation({ x: bp.x, y: bp.y, z: bp.z }, false);
          e.rb.setRotation({ x: bq.x, y: bq.y, z: bq.z, w: bq.w }, false);
          e.px = bp.x; e.py = bp.y; e.pz = bp.z; e.qy = bq.y; e.qw = bq.w;
        }
      }
    }
  }

  // Cannon-World surface tileManager touches. Most are no-ops (Rapier needs none of them).
  return {
    addBody,
    removeBody,
    bodies,
    tick,
    gravity: { x: 0, y: -9.82, z: 0 },
    addContactMaterial() {},
    removeContactMaterial() {},
    step() {},                        // stepping is owned by the car (Rapier world.step)
    get _isRapierAdapter() { return true; },
  };
}
