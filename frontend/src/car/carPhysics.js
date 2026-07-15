/**
 * Cannon contact materials — the ONLY survivor of the old cannon-es car.
 *
 * The cannon RaycastVehicle (createCarPhysics) and the ?physics=cannon escape hatch were
 * DELETED 2026-07-16 after the Rapier release soak — the car runs exclusively on Rapier
 * (carPhysicsRapier.js). cannon-es itself remains as the collider DESCRIPTOR layer:
 * tileManager still builds CANNON bodies and the rapierWorldAdapter mirrors them.
 *
 * getCarContactMaterials() stays because tileManager brands new terrain / deck bodies
 * with the road material (the adapter reads friction off the branded bodies).
 */
import * as CANNON from 'cannon-es';

// ── Shared materials (lazily created once per page load) ─────────────────────
let _roadMat = null;
let _carMat  = null;

export function getCarContactMaterials(world) {
  if (!_roadMat) {
    _roadMat = new CANNON.Material('road');
    _carMat  = new CANNON.Material('car');
    world.addContactMaterial(new CANNON.ContactMaterial(_roadMat, _carMat, {
      friction:                   0.6,
      restitution:                0.0,
      contactEquationStiffness:   1e8,
      contactEquationRelaxation:  4,
      frictionEquationStiffness:  1e8,
      frictionEquationRelaxation: 4,
    }));
  }
  return { roadMaterial: _roadMat, carMaterial: _carMat };
}
