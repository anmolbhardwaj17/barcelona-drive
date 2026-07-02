/**
 * Local physics origin (floating origin): spawn tile south-west in world coords.
 * All physics positions use local = world - origin so the simulation runs near (0,0,0).
 */

let originOffsetX = 0;
let originOffsetZ = 0;

export function getOriginOffset() {
  return { x: originOffsetX, z: originOffsetZ };
}

export function setOriginOffset(x, z) {
  if (Number.isFinite(x)) originOffsetX = x;
  if (Number.isFinite(z)) originOffsetZ = z;
}
