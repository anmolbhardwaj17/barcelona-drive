/**
 * Cannon-es collision filter groups and masks.
 * Use powers-of-two so masks can combine groups with bitwise OR.
 */
export const COLLISION_GROUP_GROUND  = 1;   // road/bridge/tunnel DECK boxes (wheel-ray contact; chassis EXCLUDES to avoid box-edge clipping)
export const COLLISION_GROUP_VEHICLE = 2;   // car chassis
export const COLLISION_GROUP_WORLD   = 4;   // buildings, static scenery (future)
export const COLLISION_GROUP_FLOOR   = 8;   // fallback ground plane (can be selectively ignored)
export const COLLISION_GROUP_TERRAIN = 16;  // terrain trimesh — own group so the chassis can use it as a
                                            // body-collision BACKSTOP (prevents fast off-road tunnel-through
                                            // of the thin wheel ray) WITHOUT clipping on road-deck box edges. See G-49.

/**
 * G-51 fail-fast: collision filters are a TWO-SIDED handshake — bodies A and B collide only if
 * (A.group & B.mask) && (B.group & A.mask). The terrain trimesh (group TERRAIN, mask VEHICLE)
 * is the car's ONLY off-road hold (wheel rays can't hit Trimesh — G-49), so the chassis mask
 * MUST include TERRAIN. The D-16 revert dropped TERRAIN from the chassis mask while keeping
 * trimesh terrain → every terrain body silently collided with nothing → off-road free-fall.
 * Called from both sides' creation sites (createTerrainTrimesh, chassis setup) so whichever
 * is created second validates the pair. Throws loudly — never silent-wrong.
 */
export function assertTerrainVehicleHandshake(world) {
  if (!world) return;
  const terrain = world.bodies.find((b) => b.collisionFilterGroup === COLLISION_GROUP_TERRAIN
    && (b.collisionFilterMask & COLLISION_GROUP_VEHICLE) !== 0);
  if (!terrain) return; // no terrain body expecting the vehicle (yet)
  const vehicle = world.bodies.find((b) => b.collisionFilterGroup === COLLISION_GROUP_VEHICLE);
  if (!vehicle) return; // fly mode / car not created yet
  if ((vehicle.collisionFilterMask & COLLISION_GROUP_TERRAIN) === 0) {
    throw new Error(
      '[collisionGroups] G-51 one-sided filter handshake: terrain trimesh (group TERRAIN) asks for '
      + 'VEHICLE, but the chassis mask excludes TERRAIN — terrain collides with NOTHING and the car '
      + 'free-falls off-road. Set chassis collisionFilterMask = COLLISION_GROUP_WORLD | COLLISION_GROUP_TERRAIN (G-49 backstop).');
  }
}
