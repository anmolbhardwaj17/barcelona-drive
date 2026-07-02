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

// RPM range: 0–9 (×1000) — gauge display scale
const GAUGE_MAX_RPM = 9;
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
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4));
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

  function _draw(speed, gear, rpm) {

    ctx.clearRect(0, 0, TOTAL, TOTAL);

    // Outer circle background (light, semi-transparent)
    ctx.beginPath();
    ctx.arc(CX, CY, R + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fill();

    const needleAngle = rpmToAngle(rpm);

    // Dense compass-style tick marks around the RPM arc perimeter
    // Each 1k RPM = 30° of arc. Draw ticks every 0.2k RPM (every 6°).
    const TICK_OUTER = R - 1;
    const TICK_MAJOR = R - 10;   // every 1k RPM
    const TICK_MID   = R - 7;    // every 0.5k RPM
    const TICK_MINOR = R - 5;    // every 0.2k RPM

    for (let rpmVal = 0; rpmVal <= GAUGE_MAX_RPM; rpmVal += 0.2) {
      const rounded = Math.round(rpmVal * 10) / 10;
      const isMajor = Math.abs(rounded - Math.round(rounded)) < 0.05;
      const isMid = !isMajor && Math.abs((rounded * 2) - Math.round(rounded * 2)) < 0.05;
      const angle = degToRad(rpmToAngle(rounded));
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const innerR = isMajor ? TICK_MAJOR : isMid ? TICK_MID : TICK_MINOR;
      const inRedzone = rounded >= 7.5;
      const isActive = rpmToAngle(rounded) <= needleAngle;

      let color, lw;
      if (inRedzone) {
        color = isMajor ? 'rgba(255, 50, 50, 0.7)' : isMid ? 'rgba(255, 50, 50, 0.5)' : 'rgba(255, 50, 50, 0.3)';
        lw = isMajor ? 2 : isMid ? 1.2 : 0.7;
      } else if (isActive) {
        color = isMajor ? 'rgba(255, 255, 255, 0.9)' : isMid ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.45)';
        lw = isMajor ? 2 : isMid ? 1.2 : 0.7;
      } else {
        color = isMajor ? 'rgba(255, 255, 255, 0.5)' : isMid ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.15)';
        lw = isMajor ? 1.5 : isMid ? 1 : 0.6;
      }

      ctx.beginPath();
      ctx.moveTo(CX + cos * innerR, CY + sin * innerR);
      ctx.lineTo(CX + cos * TICK_OUTER, CY + sin * TICK_OUTER);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // RPM numbers at major ticks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= GAUGE_MAX_RPM; i++) {
      const angle = degToRad(rpmToAngle(i));
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const numR = R - 18;
      ctx.font = 'bold 11px Futura PT, system-ui, sans-serif';
      ctx.fillStyle = i >= 8 ? 'rgba(255, 50, 50, 0.9)' : 'rgba(255, 255, 255, 0.9)';
      ctx.fillText(`${i}`, CX + cos * numR, CY + sin * numR);
    }

    // Needle (drawn before center disc so inner part is hidden)
    const nAngle = degToRad(needleAngle);
    const nCos = Math.cos(nAngle);
    const nSin = Math.sin(nAngle);
    ctx.beginPath();
    ctx.moveTo(CX - nCos * 8 + 1, CY - nSin * 8 + 1);
    ctx.lineTo(CX + nCos * (R - 13) + 1, CY + nSin * (R - 13) + 1);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX - nCos * 8, CY - nSin * 8);
    ctx.lineTo(CX + nCos * (R - 13), CY + nSin * (R - 13));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Center disc — covers needle center + inner tick ends
    ctx.beginPath();
    ctx.arc(CX, CY, R - 42, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60, 60, 60, 1)';
    ctx.fill();


    // Speed (centered in grey disc)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const speedText = `${Math.round(speed)}`;
    ctx.font = 'bold 30px Futura PT, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(speedText, CX, CY - 4);
    // km/h label below speed
    ctx.font = '10px Futura PT, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText('km/h', CX, CY + 20);

    // Gear indicator (bottom gap of dial arc) with shift animation
    const gw = 26, gh = 26;
    const gearBaseY = CY + R - 16;

    // Clip gear region so text slides within bounds
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(CX - gw / 2, gearBaseY - gh / 2, gw, gh, 6);
    ctx.clip();

    // Red background
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(CX - gw / 2, gearBaseY - gh / 2, gw, gh);

    ctx.font = 'bold 20px Futura PT, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (_gearShiftAnim > 0) {
      // Animate: old gear slides out, new gear slides in
      const slideRange = gh + 4;
      const t = 1 - _gearShiftAnim; // 0→1 progress
      const ease = t * t * (3 - 2 * t); // smoothstep
      const offset = ease * slideRange;
      const dir = _gearShiftDir;

      // Old gear sliding out
      const oldText = _gearOld < 0 ? 'R' : `${_gearOld}`;
      ctx.fillText(oldText, CX, gearBaseY - dir * offset + 1);

      // New gear sliding in
      const newText = gear < 0 ? 'R' : `${gear}`;
      ctx.fillText(newText, CX, gearBaseY + dir * (slideRange - offset) + 1);
    } else {
      const gearText = gear < 0 ? 'R' : `${gear}`;
      ctx.fillText(gearText, CX, gearBaseY + 1);
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
