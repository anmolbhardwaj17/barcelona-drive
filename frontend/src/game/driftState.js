/**
 * driftState — tiny shared singleton for the live drift chain. styleSystem (scoring) WRITES the current
 * chain tier/colour each frame; carEffects (render) READS it to colour the tyre smoke. Keeps the scorer and
 * the particle renderer decoupled (they live in different subsystems created at different times).
 */
export const driftState = {
  active: false,    // a scored drift chain is currently live
  tier: 0,          // 0..5 — escalating chain tier
  color: 0xffffff,  // smoke colour for the current tier
  time: 0,          // seconds the current chain has been held
  set(active, tier, color, time) { this.active = active; this.tier = tier; this.color = color; this.time = time; },
  reset() { this.active = false; this.tier = 0; this.color = 0xffffff; this.time = 0; },
};
