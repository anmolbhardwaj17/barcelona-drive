/**
 * Tiny shared gate for gameplay key input. The ESC settings menu raises it while open so the car
 * doesn't keep driving/honking/teleporting under the overlay; car controls + recover/horn keys consult it.
 * Decouples input handlers from the menu (no circular imports).
 */
let _blocked = false;
export function setInputBlocked(v) { _blocked = !!v; }
export function isInputBlocked() { return _blocked; }

/** True when the user is typing in a text field — used to avoid hijacking letter keys. */
export function isTypingTarget() {
  const a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
