// Unused — mouse orbit removed for collision debugging phase.
// Restore when reintroducing the full camera system.
export function createCarMouseControls() {
  return { getOrbitInput: () => ({ yawDelta: 0, pitchDelta: 0, orbitActive: false }) };
}
