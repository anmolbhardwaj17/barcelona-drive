/**
 * touchControls.js — on-screen driving controls for phones & tablets.
 *
 * Layout (landscape): LEFT cluster = accelerate (▲) over brake (▼);
 * RIGHT cluster = steer left (◀) / steer right (▶), side by side.
 *
 * Input path: buttons dispatch synthetic KeyboardEvents (ArrowUp/Down/Left/Right)
 * on window, so carControls' progressive ramp, ESC-menu input gate and typing
 * guard all apply unchanged — the buttons ARE arrow keys as far as the game knows.
 *
 * Shown only on coarse-pointer (touch) devices. In portrait a full-screen
 * "rotate your device" overlay appears (landscape is the playable orientation);
 * on the first touch we best-effort request fullscreen + orientation lock
 * (Android; iOS Safari has no lock API — the overlay covers that case).
 *
 * Sizing: clamp(56px … 12vmin … 92px) so thumbs get a big target on phones
 * without dinner-plate buttons on tablets. Translucent light glass look
 * (white @ 16% + blur) so the road stays visible behind the controls.
 */

const BTN = [
  { code: 'ArrowUp',    label: 'Accelerate',  cluster: 'left',  glyph: 'M12 5 L4 15 L20 15 Z' },
  { code: 'ArrowDown',  label: 'Brake / reverse', cluster: 'left',  glyph: 'M12 19 L4 9 L20 9 Z' },
  { code: 'ArrowLeft',  label: 'Steer left',  cluster: 'right', glyph: 'M5 12 L15 4 L15 20 Z' },
  { code: 'ArrowRight', label: 'Steer right', cluster: 'right', glyph: 'M19 12 L9 4 L9 20 Z' },
];

const isTouchDevice = () =>
  (typeof window !== 'undefined') &&
  (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 1);

export function initTouchControls() {
  if (!isTouchDevice()) return null;

  const style = document.createElement('style');
  style.textContent = `
    .dd-touch-cluster {
      position: fixed; bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      display: flex; gap: clamp(10px, 2.2vmin, 18px); z-index: 60;
      touch-action: none; -webkit-user-select: none; user-select: none;
      -webkit-touch-callout: none;
    }
    .dd-touch-left  { left:  calc(16px + env(safe-area-inset-left, 0px));  flex-direction: column; }
    .dd-touch-right { right: calc(16px + env(safe-area-inset-right, 0px)); flex-direction: row; }
    .dd-touch-btn {
      width: clamp(56px, 12vmin, 92px); height: clamp(56px, 12vmin, 92px);
      border-radius: 26%; border: 1.5px solid rgba(255,255,255,0.38);
      background: rgba(255,255,255,0.16);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      padding: 0; margin: 0; touch-action: none; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,0.18);
      transition: background 80ms ease, transform 80ms ease;
    }
    .dd-touch-btn svg { width: 44%; height: 44%; fill: rgba(255,255,255,0.92);
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35)); pointer-events: none; }
    .dd-touch-btn.dd-active {
      background: rgba(255,255,255,0.34); transform: scale(0.93);
      border-color: rgba(255,255,255,0.6);
    }
    @media (orientation: portrait) {
      .dd-touch-cluster { display: none; }
      .dd-rotate-overlay { display: flex; }
    }
    .dd-rotate-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(10, 12, 18, 0.92); color: #eef2f7;
      flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; text-align: center; font: 500 17px/1.5 -apple-system, system-ui, sans-serif;
      -webkit-user-select: none; user-select: none;
    }
    .dd-rotate-overlay svg { width: 72px; height: 72px; fill: none;
      stroke: #eef2f7; stroke-width: 1.6; animation: dd-rotate-hint 2.2s ease-in-out infinite; }
    @keyframes dd-rotate-hint {
      0%, 20%  { transform: rotate(0deg); }
      55%, 80% { transform: rotate(90deg); }
      100%     { transform: rotate(90deg); }
    }
  `;
  document.head.appendChild(style);

  // ── Rotate-to-landscape overlay (CSS-gated by the portrait media query) ────
  const rotate = document.createElement('div');
  rotate.className = 'dd-rotate-overlay';
  rotate.setAttribute('role', 'status');
  rotate.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="3" width="10" height="18" rx="2"></rect>
      <circle cx="12" cy="18.2" r="0.9" fill="#eef2f7" stroke="none"></circle>
    </svg>
    <div>Rotate your device to landscape<br>to drive</div>`;
  document.body.appendChild(rotate);

  // Best-effort fullscreen + landscape lock on the first touch anywhere (must be a
  // user gesture; silently unsupported on iOS Safari — the overlay handles portrait).
  let _lockTried = false;
  const tryLock = async () => {
    if (_lockTried) return;
    _lockTried = true;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
      await screen.orientation?.lock?.('landscape');
    } catch { /* unsupported or denied — portrait overlay covers it */ }
  };
  window.addEventListener('pointerdown', tryLock, { once: true, capture: true });

  // ── Button clusters ────────────────────────────────────────────────────────
  const clusters = {
    left:  Object.assign(document.createElement('div'), { className: 'dd-touch-cluster dd-touch-left' }),
    right: Object.assign(document.createElement('div'), { className: 'dd-touch-cluster dd-touch-right' }),
  };

  const sendKey = (type, code) =>
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));

  const disposers = [];
  for (const { code, label, cluster, glyph } of BTN) {
    const btn = document.createElement('button');
    btn.className = 'dd-touch-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${glyph}"></path></svg>`;

    // Track pointers per button (multi-touch: throttle + steer held together).
    const active = new Set();
    const press = (e) => {
      e.preventDefault();
      if (active.size === 0) { sendKey('keydown', code); btn.classList.add('dd-active'); btn.setAttribute('aria-pressed', 'true'); }
      active.add(e.pointerId);
    };
    const release = (e) => {
      if (!active.delete(e.pointerId)) return;
      if (active.size === 0) { sendKey('keyup', code); btn.classList.remove('dd-active'); btn.setAttribute('aria-pressed', 'false'); }
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    disposers.push(() => { for (const id of active) release({ pointerId: id }); });

    clusters[cluster].appendChild(btn);
  }
  document.body.appendChild(clusters.left);
  document.body.appendChild(clusters.right);

  // Release everything if the page hides mid-press (tab switch, incoming call).
  const onHide = () => { for (const d of disposers) d(); };
  document.addEventListener('visibilitychange', onHide);

  return {
    dispose() {
      onHide();
      document.removeEventListener('visibilitychange', onHide);
      clusters.left.remove(); clusters.right.remove();
      rotate.remove(); style.remove();
    },
  };
}
