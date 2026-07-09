/**
 * Circular tachometer-style speed gauge with gear indicator.
 * Canvas-based, positioned bottom-right to mirror the minimap on bottom-left.
 */

const GAUGE_SIZE = 210;         // matches minimap+compass total size (218px)
const BORDER = 4;
const TOTAL = GAUGE_SIZE + BORDER * 2;
const CX = TOTAL / 2;
const CY = TOTAL / 2;
const R = GAUGE_SIZE / 2 - 8;  // main arc radius

// RPM range: 0–7 (×1000) — gauge display scale. Matches the engine: REDLINE 6500, MAX 7000. (Was 0–9,
// which left the top third of the dial dead and put the redzone at an unreachable 7500 rpm.)
const GAUGE_MAX_RPM = 7;
const REDZONE_RPM = 6.0;   // gauge units (×1000) — coral from here up; engine redline is 6.5
// Arc spans from 135° to 405° (270° sweep)
const ARC_START = 135;
const ARC_SWEEP = 270;

function degToRad(d) { return d * Math.PI / 180; }

function rpmToAngle(rpm) {
  return ARC_START + (rpm / GAUGE_MAX_RPM) * ARC_SWEEP;
}

/**
 * Create and mount speed display.
 * @returns {{ element: HTMLElement, setSpeed: (kmh: number) => void }}
 */
export function createSpeedDisplay() {
  const canvas = document.createElement('canvas');
  canvas.width = TOTAL * 2;   // 2x for retina
  canvas.height = TOTAL * 2;
  canvas.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: ${TOTAL}px;
    height: ${TOTAL}px;
    pointer-events: none;
    z-index: 10;
    filter: drop-shadow(0 3px 12px rgba(0, 0, 0, 0.22));
  `;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2); // retina

  let _targetRpm = 0;      // gauge-scale target (0-9)
  let _displayRpm = 0;     // smoothed display RPM
  let _targetSpeed = 0;
  let _displaySpeed = 0;
  let _currentGear = 1;
  let _prevDisplayGear = 1;
  let _gearShiftAnim = 0;  // 0 = idle, 0→1 = animating
  let _gearShiftDir = 1;   // 1 = upshift, -1 = downshift
  let _gearOld = 1;
  let _lastFrame = performance.now();
  let _rafId = null;

  const GEAR_ANIM_SPEED = 5; // animation speed (higher = faster)

  function _animLoop() {
    _rafId = requestAnimationFrame(_animLoop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - _lastFrame) / 1000);
    _lastFrame = now;

    // Smooth RPM — needle sweeps up/down naturally
    const rpmDiff = _targetRpm - _displayRpm;
    const rpmSpeed = Math.abs(rpmDiff) > 2 ? 8 : 5; // faster for big jumps (gear shifts)
    _displayRpm += rpmDiff * Math.min(1, rpmSpeed * dt);

    // Smooth speed
    _displaySpeed += (_targetSpeed - _displaySpeed) * Math.min(1, 10 * dt);

    // Gear shift animation
    if (_gearShiftAnim > 0) {
      _gearShiftAnim = Math.max(0, _gearShiftAnim - GEAR_ANIM_SPEED * dt);
    }

    _draw(_displaySpeed, _currentGear, _displayRpm);
  }
  _rafId = requestAnimationFrame(_animLoop);

  // Art-of-rally palette (canvas can't read CSS tokens — kept in sync with theme.js).
  const CREAM = '#f3ede1';
  const CORAL = '#d76a4f';

  function _draw(speed, gear, rpm) {
    ctx.clearRect(0, 0, TOTAL, TOTAL);

    const needleAngle = rpmToAngle(rpm);
    const ARC_R = R - 6;
    const inRedzone = rpm >= REDZONE_RPM;

    // Faint frosted disc behind the readout — keeps the number legible over bright roads.
    ctx.beginPath();
    ctx.arc(CX, CY, ARC_R - 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,25,22,0.34)';
    ctx.fill();

    // Background track arc (thin, faint cream).
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(CX, CY, ARC_R, degToRad(ARC_START), degToRad(ARC_START + ARC_SWEEP));
    ctx.strokeStyle = 'rgba(243,237,225,0.14)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Progress arc — fills with RPM; turns coral in the redzone.
    ctx.beginPath();
    ctx.arc(CX, CY, ARC_R, degToRad(ARC_START), degToRad(needleAngle));
    ctx.strokeStyle = inRedzone ? CORAL : 'rgba(243,237,225,0.9)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Redzone start marker.
    {
      const a = degToRad(rpmToAngle(REDZONE_RPM));
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * (ARC_R - 6), CY + Math.sin(a) * (ARC_R - 6));
      ctx.lineTo(CX + Math.cos(a) * (ARC_R + 5), CY + Math.sin(a) * (ARC_R + 5));
      ctx.strokeStyle = 'rgba(215,106,79,0.75)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Speed number.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 38px Inter, system-ui, sans-serif';
    ctx.fillStyle = CREAM;
    ctx.fillText(`${Math.round(speed)}`, CX, CY - 7);

    // KM/H label — wide-tracked uppercase (art-of-rally caption).
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(243,237,225,0.55)';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    ctx.fillText('KM/H', CX + 1, CY + 17);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Gear chip — flat pill (coral in redzone, else faint cream), with the slide animation.
    const gw = 30, gh = 22;
    const gearBaseY = CY + ARC_R - 20;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(CX - gw / 2, gearBaseY - gh / 2, gw, gh, 7);
    ctx.fillStyle = inRedzone ? CORAL : 'rgba(243,237,225,0.14)';
    ctx.fill();
    ctx.clip();
    ctx.font = '600 15px Inter, system-ui, sans-serif';
    ctx.fillStyle = inRedzone ? CREAM : 'rgba(243,237,225,0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (_gearShiftAnim > 0) {
      const slideRange = gh + 4;
      const t = 1 - _gearShiftAnim;            // 0→1 progress
      const ease = t * t * (3 - 2 * t);        // smoothstep
      const offset = ease * slideRange;
      const dir = _gearShiftDir;
      ctx.fillText(_gearOld < 0 ? 'R' : `${_gearOld}`, CX, gearBaseY - dir * offset + 1);
      ctx.fillText(gear < 0 ? 'R' : `${gear}`, CX, gearBaseY + dir * (slideRange - offset) + 1);
    } else {
      ctx.fillText(gear < 0 ? 'R' : `${gear}`, CX, gearBaseY + 1);
    }
    ctx.restore();
  }

  return {
    element: canvas,
    setSpeed(kmh, gear = 1, rpm = 800) {
      _targetSpeed = Number.isFinite(kmh) ? Math.abs(kmh) : 0;
      _targetRpm = Math.min(GAUGE_MAX_RPM, Math.max(0, rpm / 1000));
      if (gear !== _currentGear) {
        _gearOld = _currentGear;
        _gearShiftDir = gear > _currentGear ? 1 : -1;
        _gearShiftAnim = 1;
        _currentGear = gear;
      }
    },
    dispose() {
      if (_rafId) cancelAnimationFrame(_rafId);
    },
  };
}
