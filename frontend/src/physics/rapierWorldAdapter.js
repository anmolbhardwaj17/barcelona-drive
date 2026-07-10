/**
 * rapierWorldAdapter — presents a cannon-es-World-compatible surface (addBody / removeBody / bodies) but
 * converts each cannon Body's shapes into Rapier colliders. This lets tileManager keep building CANNON.Body
 * collider descriptions EXACTLY as it does for cannon, while the actual simulation runs on Rapier.
 *
 * Both cannon and the Rapier car operate in the same physics/local frame (px = -(worldX-originX)), and the
 * cannon bodies tileManager builds are already in that frame — so shapes/offsets convert 1:1, no mirror math.
 *
 * PHASE 2a: Box, Trimesh, ConvexPolyhedron, Cylinder. Heightfield (terrain) is deferred to Phase 2b — a
 * heightfield body converts to an empty rigid-body here (skipped), so the car falls back to the flat ground.
 */

import * as CANNON from 'cannon-es';

export function createRapierWorldAdapter(rapierWorld, RAPIER) {
  const bodies = [];                 // cannon bodies "in the world" (tileManager reads world.bodies)
  const _rb = new WeakMap();         // cannon body -> Rapier rigid body
  const T = CANNON.Shape.types;

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
      default:
        return null; // deferred / unsupported → skip this shape
    }
  }

  function addBody(cannonBody) {
    bodies.push(cannonBody);
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
      const o = offs[i], r = oris[i];
      desc.setTranslation(o.x, o.y, o.z).setRotation({ x: r.x, y: r.y, z: r.z, w: r.w });
      try { rapierWorld.createCollider(desc, rb); added++; } catch (e) { /* skip a bad shape rather than crash the tile */ }
    }
    if (added === 0) { rapierWorld.removeRigidBody(rb); return cannonBody; } // all shapes unsupported (e.g. heightfield)
    _rb.set(cannonBody, rb);
    return cannonBody;
  }

  function removeBody(cannonBody) {
    const rb = _rb.get(cannonBody);
    if (rb) { try { rapierWorld.removeRigidBody(rb); } catch {} _rb.delete(cannonBody); }
    const i = bodies.indexOf(cannonBody);
    if (i >= 0) bodies.splice(i, 1);
  }

  // Cannon-World surface tileManager touches. Most are no-ops (Rapier needs none of them).
  return {
    addBody,
    removeBody,
    bodies,
    gravity: { x: 0, y: -9.82, z: 0 },
    addContactMaterial() {},
    removeContactMaterial() {},
    step() {},                        // stepping is owned by the car (Rapier world.step)
    get _isRapierAdapter() { return true; },
  };
}
