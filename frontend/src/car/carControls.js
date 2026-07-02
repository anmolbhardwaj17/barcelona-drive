/**
 * Keyboard input — instance-based, progressive steering/throttle/brake.
 * Keys ramp up smoothly instead of snapping to 0/1 for more realistic feel.
 * Prevents browser scroll on arrow keys.
 */
export function createCarControls() {
  const _keys = new Set();

  // Progressive input state (0..1 for throttle/brake, -1..1 for steer)
  let _throttleVal = 0;
  let _brakeVal = 0;
  let _steerVal = 0;

  // Ramp rates (per second)
  const THROTTLE_RISE = 3.5;   // how fast throttle builds
  const THROTTLE_FALL = 5.0;   // how fast throttle releases (snappier off)
  const BRAKE_RISE    = 4.5;   // brakes engage quickly
  const BRAKE_FALL    = 6.0;   // brakes release fast
  const STEER_RISE    = 3.0;   // steering builds gradually
  const STEER_FALL    = 4.5;   // steering centers faster than it turns

  let _lastTime = performance.now();

  const _typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  const _onDown = (e) => {
    if (_typing()) return; // don't drive the car while typing in a menu search box
    _keys.add(e.code);
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))
      e.preventDefault();
  };
  const _onUp   = (e) => _keys.delete(e.code);
  const _onBlur = ()  => _keys.clear();

  window.addEventListener('keydown', _onDown, { capture: true });
  window.addEventListener('keyup',   _onUp,   { capture: true });
  window.addEventListener('blur',    _onBlur);

  function getState() {
    const now = performance.now();
    const dt = Math.min((now - _lastTime) / 1000, 0.05); // cap at 50ms
    _lastTime = now;

    // Throttle ramp
    const wantThrottle = (_keys.has('KeyW') || _keys.has('ArrowUp')) ? 1 : 0;
    if (wantThrottle > _throttleVal) {
      _throttleVal = Math.min(1, _throttleVal + THROTTLE_RISE * dt);
    } else {
      _throttleVal = Math.max(0, _throttleVal - THROTTLE_FALL * dt);
    }

    // Brake ramp
    const wantBrake = (_keys.has('KeyS') || _keys.has('ArrowDown')) ? 1 : 0;
    if (wantBrake > _brakeVal) {
      _brakeVal = Math.min(1, _brakeVal + BRAKE_RISE * dt);
    } else {
      _brakeVal = Math.max(0, _brakeVal - BRAKE_FALL * dt);
    }

    // Steer ramp
    const wantSteer = (_keys.has('KeyA') || _keys.has('ArrowLeft'))  ?  1
                    : (_keys.has('KeyD') || _keys.has('ArrowRight')) ? -1 : 0;
    if (wantSteer !== 0) {
      // Moving toward target
      const diff = wantSteer - _steerVal;
      _steerVal += Math.sign(diff) * Math.min(Math.abs(diff), STEER_RISE * dt);
    } else {
      // Centering
      if (Math.abs(_steerVal) < STEER_FALL * dt) {
        _steerVal = 0;
      } else {
        _steerVal -= Math.sign(_steerVal) * STEER_FALL * dt;
      }
    }

    return {
      throttle:  _throttleVal,
      brake:     _brakeVal,
      steer:     _steerVal,
      handbrake: _keys.has('Space') ? 1 : 0,
    };
  }

  function dispose() {
    window.removeEventListener('keydown', _onDown, { capture: true });
    window.removeEventListener('keyup',   _onUp,   { capture: true });
    window.removeEventListener('blur',    _onBlur);
  }

  return { getState, dispose };
}
