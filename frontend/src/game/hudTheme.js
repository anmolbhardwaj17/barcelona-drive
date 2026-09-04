/**
 * hudTheme.js — ONE panel look for every in-game card.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────────────────────
 * City Cab put two cards on screen at once that shared nothing: a green-bordered money panel in the
 * corner and the dark objective card in the middle. Two design languages, at the same moment, in the
 * same game. That is not a style preference, it is the thing that makes a HUD look assembled rather
 * than designed — and the same three modes each had their own copy of the CSS, so it could only get
 * worse.
 *
 * ── WHAT THE GREEN BORDER WAS ACTUALLY DOING ──────────────────────────────────────────────────
 * A 2px saturated outline all the way round a panel is the browser's warning-dialog idiom, so the
 * card read as an alert rather than a readout. Worse, the panel was green, the border was green and
 * the number was mint — and City Cab's objectives sit in parks. Over foliage the whole card
 * disappeared into the background it was drawn over.
 *
 * So: a NEUTRAL dark panel, and the mode's colour carried by a 3px bar down one edge and the label.
 * The bar reads as a tag rather than a warning, it survives any accent colour a mode wants, and the
 * value stays WHITE, which is the only thing that reads over both night asphalt and a sunlit hedge.
 */

let _injected = false;
export function injectHudTheme() {
  if (_injected || typeof document === 'undefined') return;
  _injected = true;
  const st = document.createElement('style');
  st.textContent = `
/* ── The right-hand rail ──────────────────────────────────────────────────────────────────────
   Cards STACK here rather than each carrying its own top offset. Rush Hour has two (a countdown and
   a cargo readout) and only shows the countdown during a drop-off, so with hard-coded offsets the
   cargo card kept its 106px and hung in mid-air with the timer's empty slot above it. A flex column
   closes that gap when a card hides, because display:none leaves the layout rather than leaving a
   hole. CSS order sets the sequence, so a card's position does not depend on when it was built.
   NOTE: no backticks in this comment. It lives inside a template literal, and one closed it. */
.ddc-rail { position:fixed; top:14px; right:14px; z-index:1290; display:flex; flex-direction:column;
  align-items:flex-end; gap:10px; pointer-events:none; }
.ddc-rail > .ddc { position:static; }

.ddc { position:fixed; z-index:1290; display:none; pointer-events:none; user-select:none;
  font-family:Inter, system-ui, sans-serif; color:#fff; border-radius:16px; overflow:hidden;
  background:linear-gradient(168deg, rgba(14,18,26,.93), rgba(9,12,18,.93));
  border:1px solid rgba(255,255,255,.13);
  box-shadow:0 10px 30px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.07); }
/* NO accent bar and no accent border. The bar replaced the old warning-style outline and was itself
   too much: a hard vertical rule against a rounded panel fights the corner radius it sits inside,
   and the card already carries its colour where it means something — on the label and the value.
   An accent that has to be drawn as furniture is an accent doing no work. */
.ddc-body { padding:10px 16px 12px; }
.ddc-label { font:800 10px/1 Inter, sans-serif; letter-spacing:.18em; text-transform:uppercase; }
/* tabular-nums so a rising total does not shuffle its own digits sideways as it counts up. */
.ddc-value { font:700 30px/1 Inter, sans-serif; font-variant-numeric:tabular-nums;
  margin-top:6px; text-shadow:0 2px 8px rgba(0,0,0,.55); }
.ddc-sub { font:600 11px/1 Inter, sans-serif; letter-spacing:.06em; color:rgba(255,255,255,.55);
  margin-top:6px; }
.ddc-meter { margin-top:9px; display:flex; align-items:center; gap:8px; }
.ddc-track { flex:1 1 auto; height:4px; border-radius:2px; background:rgba(255,255,255,.14);
  overflow:hidden; }
.ddc-fill { height:100%; width:60%; border-radius:2px; transition:width .25s ease-out; }
.ddc-meterval { font:700 10px/1 Inter, sans-serif; font-variant-numeric:tabular-nums;
  letter-spacing:.06em; }

/* ── Result panel — the end-of-run summary ── */
.ddr { position:fixed; top:34%; left:50%; z-index:1300; pointer-events:none; user-select:none;
  font-family:Inter, system-ui, sans-serif; color:#fff; text-align:center; min-width:260px;
  border-radius:20px; overflow:hidden; opacity:0;
  background:linear-gradient(168deg, rgba(14,18,26,.94), rgba(9,12,18,.94));
  border:1px solid rgba(255,255,255,.13);
  box-shadow:0 18px 50px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08); }
.ddr-top { height:3px; }
.ddr-body { padding:18px 34px 20px; }
.ddr-kicker { font:800 11px/1 Inter, sans-serif; letter-spacing:.3em; text-transform:uppercase; }
.ddr-value { font:800 46px/1 Inter, sans-serif; font-variant-numeric:tabular-nums; margin-top:12px;
  text-shadow:0 3px 14px rgba(0,0,0,.55); }
.ddr-stats { display:flex; justify-content:center; gap:22px; margin-top:14px;
  padding-top:13px; border-top:1px solid rgba(255,255,255,.10); }
.ddr-stat { font:600 11px/1.35 Inter, sans-serif; letter-spacing:.14em; text-transform:uppercase;
  color:rgba(255,255,255,.5); }
.ddr-stat b { display:block; font:700 15px/1 Inter, sans-serif; font-variant-numeric:tabular-nums;
  letter-spacing:.02em; color:#fff; margin-bottom:4px; }`;
  document.head.appendChild(st);
}

/** The shared top-right column. Created on first use; every railed card lives in it. */
let _rail = null;
export function hudRail() {
  injectHudTheme();
  if (!_rail) {
    _rail = document.createElement('div');
    _rail.className = 'ddc-rail';
    document.body.appendChild(_rail);
  }
  return _rail;
}

/**
 * A corner readout: label, big value, optional sub-line and optional meter.
 *
 * @param {object} o
 * @param {string} [o.label]  letterspaced caps, in the accent colour
 * @param {string} [o.color]  mode accent
 * @param {string} [o.pos]    absolute placement CSS — ignored when `rail` is set
 * @param {boolean} [o.rail]   stack in the shared top-right column instead of positioning by hand
 * @param {number}  [o.order]  position within the rail (lower is higher up)
 */
export function createStatCard({ label = '', color = '#35e0ff', pos = 'top:92px;left:14px;', rail = false, order = 0 } = {}) {
  injectHudTheme();
  const el = document.createElement('div');
  el.className = 'ddc';
  if (rail) el.style.order = String(order);
  else el.style.cssText = pos;
  el.innerHTML =
    '<div class="ddc-body">' +
      '<div class="ddc-label"></div>' +
      '<div class="ddc-value">—</div>' +
      '<div class="ddc-sub"></div>' +
      '<div class="ddc-meter" hidden><div class="ddc-track"><div class="ddc-fill"></div></div>' +
      '<div class="ddc-meterval"></div></div>' +
    '</div>';
  const labelEl = el.querySelector('.ddc-label');
  const valueEl = el.querySelector('.ddc-value');
  const subEl = el.querySelector('.ddc-sub');
  const meterEl = el.querySelector('.ddc-meter');
  const fillEl = el.querySelector('.ddc-fill');
  const meterVal = el.querySelector('.ddc-meterval');
  (rail ? hudRail() : document.body).appendChild(el);

  labelEl.style.color = color;
  labelEl.textContent = label;

  return {
    el,
    show(on) { el.style.display = on ? 'block' : 'none'; },
    setAccent(col) { labelEl.style.color = col; },
    setLabel(t) { if (labelEl.textContent !== t) labelEl.textContent = t; },
    /** textContent, never innerHTML — a per-frame HUD must not re-parse and reflow 60×/s. */
    set(value, sub = '') {
      if (valueEl.textContent !== value) valueEl.textContent = value;
      if (subEl.textContent !== sub) subEl.textContent = sub;
    },
    /** @param {number|null} frac 0..1, or null to hide the meter entirely */
    meter(frac, text = '', col = '#ffd23f') {
      const on = frac !== null && frac !== undefined;
      meterEl.hidden = !on;
      if (!on) return;
      fillEl.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      fillEl.style.background = col;
      meterVal.style.color = col;
      if (meterVal.textContent !== text) meterVal.textContent = text;
    },
    remove() { el.remove(); },
  };
}

/**
 * End-of-run summary panel.
 *
 * ⚠ It FADES. The one this replaces was toggled with `display:none` on a `setTimeout`, so after
 * nine seconds of sitting there it vanished between one frame and the next — which reads as a bug
 * rather than as an ending. `hide()` returns a promise that settles when it has actually gone.
 */
export function createResultCard({ color = '#35e0ff' } = {}) {
  injectHudTheme();
  const el = document.createElement('div');
  el.className = 'ddr';
  el.style.display = 'none';
  el.innerHTML = '<div class="ddr-top"></div><div class="ddr-body">' +
    '<div class="ddr-kicker"></div><div class="ddr-value"></div>' +
    '<div class="ddr-stats"></div></div>';
  const top = el.querySelector('.ddr-top');
  const kicker = el.querySelector('.ddr-kicker');
  const value = el.querySelector('.ddr-value');
  const stats = el.querySelector('.ddr-stats');
  document.body.appendChild(el);
  top.style.background = `linear-gradient(90deg, transparent, ${color}, transparent)`;
  kicker.style.color = color;
  let _anim = null;

  return {
    el,
    /** @param {{kicker:string, value:string, stats:{label:string,value:string}[], color?:string}} d */
    show(d) {
      if (d.color) {
        top.style.background = `linear-gradient(90deg, transparent, ${d.color}, transparent)`;
        kicker.style.color = d.color;
      }
      kicker.textContent = d.kicker || '';
      value.textContent = d.value || '';
      stats.replaceChildren();
      for (const st of d.stats || []) {
        const w = document.createElement('div');
        w.className = 'ddr-stat';
        const b = document.createElement('b');
        b.textContent = st.value;          // textContent, not innerHTML — see fxEvent's note
        w.appendChild(b);
        w.appendChild(document.createTextNode(st.label));
        stats.appendChild(w);
      }
      stats.style.display = (d.stats || []).length ? 'flex' : 'none';
      el.style.display = 'block';
      _anim?.cancel();
      _anim = el.animate([
        { opacity: 0, transform: 'translate(-50%,-44%) scale(.93)' },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
      ], { duration: 420, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
    },
    /** @returns {Promise<void>} settles once the panel has actually gone. */
    hide() {
      if (el.style.display === 'none') return Promise.resolve();
      _anim?.cancel();
      _anim = el.animate([
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
        { opacity: 0, transform: 'translate(-50%,-56%) scale(.98)' },
      ], { duration: 520, easing: 'ease-in', fill: 'both' });
      return new Promise((r) => {
        const done = () => { el.style.display = 'none'; r(); };
        _anim.onfinish = done;
        setTimeout(done, 700);           // never leave a panel stuck because an animation was cancelled
      });
    },
    remove() { el.remove(); },
  };
}

/**
 * The 3 · 2 · 1 · GO countdown.
 *
 * ⚠ WHAT THIS REPLACES, and why it read as cheap: a bare 120px number with a CSS keyframe that
 * ended at `scale(.85); opacity:.85` — so each digit finished SHRUNK AND DIMMED and then sat there
 * until the next one replaced it. A countdown that fades out early is telling you the wrong thing:
 * the tension should build into the number, not leak out of it.
 *
 * Now the digit is wrapped in a ring that sweeps once per second, which is the affordance a
 * countdown actually has — you can see the second running out rather than only being told about it.
 */
export function createCountdown({ color = '#35e0ff' } = {}) {
  injectHudTheme();
  if (!document.getElementById('ddcd-style')) {
    const st = document.createElement('style');
    st.id = 'ddcd-style';
    st.textContent = `
.ddcd { position:fixed; top:42%; left:50%; transform:translate(-50%,-50%); z-index:1300;
  display:none; pointer-events:none; user-select:none; text-align:center;
  font-family:Inter, system-ui, sans-serif; color:#fff; }
.ddcd-kicker { font:800 11px/1 Inter, sans-serif; letter-spacing:.32em; text-transform:uppercase;
  margin-bottom:14px; text-shadow:0 2px 10px rgba(0,0,0,.7); }
.ddcd-ring { position:relative; width:170px; height:170px; margin:0 auto; }
.ddcd-ring svg { position:absolute; inset:0; transform:rotate(-90deg); }
.ddcd-num { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font:800 76px/1 Inter, sans-serif; font-variant-numeric:tabular-nums;
  text-shadow:0 4px 22px rgba(0,0,0,.7); }`;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.className = 'ddcd';
  const R = 76, C = 2 * Math.PI * R;
  el.innerHTML =
    '<div class="ddcd-kicker">Get ready</div>' +
    '<div class="ddcd-ring">' +
      `<svg viewBox="0 0 170 170"><circle cx="85" cy="85" r="${R}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="5"/>` +
      `<circle class="ddcd-arc" cx="85" cy="85" r="${R}" fill="none" stroke-width="5" stroke-linecap="round"` +
      ` stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>` +
      '<div class="ddcd-num"></div>' +
    '</div>';
  const kicker = el.querySelector('.ddcd-kicker');
  const arc = el.querySelector('.ddcd-arc');
  const num = el.querySelector('.ddcd-num');
  document.body.appendChild(el);
  kicker.style.color = color;
  arc.style.stroke = color;
  let _numAnim = null, _arcAnim = null;

  return {
    el,
    /** A new digit: pop it, and sweep the ring down over the second it represents. */
    set(n) {
      el.style.display = 'block';
      kicker.style.opacity = '1';
      num.textContent = String(n);
      num.style.color = '#fff';
      _numAnim?.cancel();
      _numAnim = num.animate([
        { transform: 'scale(.55)', opacity: 0 },
        { transform: 'scale(1.12)', opacity: 1, offset: 0.3 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 420, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
      _arcAnim?.cancel();
      _arcAnim = arc.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: C }],
        { duration: 1000, easing: 'linear', fill: 'both' });
    },
    go() {
      el.style.display = 'block';
      kicker.style.opacity = '0';
      num.textContent = 'GO';
      num.style.color = color;
      _arcAnim?.cancel();
      arc.style.strokeDashoffset = '0';
      _numAnim?.cancel();
      _numAnim = num.animate([
        { transform: 'scale(.7)', opacity: 0 },
        { transform: 'scale(1.2)', opacity: 1, offset: 0.25 },
        { transform: 'scale(1.55)', opacity: 0 },
      ], { duration: 900, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
      _arcAnim = arc.animate([{ opacity: 1, strokeWidth: 5 }, { opacity: 0, strokeWidth: 16 }],
        { duration: 900, easing: 'ease-out', fill: 'both' });
    },
    hide() { el.style.display = 'none'; _numAnim?.cancel(); _arcAnim?.cancel(); },
    remove() { el.remove(); },
  };
}
