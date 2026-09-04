/**
 * objectiveHud.js — one objective card, for every mode.
 *
 * ── WHAT IT REPLACES ──────────────────────────────────────────────────────────────────────────
 * Three near-identical hand-built pills — `dashMode`'s "NEXT CHECKPOINT", `taxiMode`'s "PICK UP" /
 * "DROP OFF", `deliveryMode`'s — each ~15 lines of inline `cssText` and an `innerHTML` string, each
 * at a slightly different `top:` (150px / 132px / its own), each with its own border colour and its
 * own CSS triangle built out of `border-left:8px solid transparent`. Fixing the type in one fixed it
 * in one third of the game.
 *
 * ── WHAT IT ADDS ──────────────────────────────────────────────────────────────────────────────
 * The old pill showed a bearing triangle and a CROW-FLIES distance. On an Eixample grid that number
 * goes UP while you drive the correct route round a block, which is worse than showing nothing. This
 * shows the next MANEUVER — "Turn left onto Carrer d'Aragó, in 120 m" — over the distance remaining
 * ALONG THE ROADS, and keeps the bearing arrow only as the fallback for when no route exists yet
 * (the far end of the trip may still be streaming in).
 *
 * Pure DOM, one element, `textContent` per frame — never `innerHTML`, which is what made the old
 * per-frame HUD re-parse and reflow 60×/s while a mode was running.
 */

const ARROW = {
  'Turn left': '↰', 'Sharp left': '↰', 'Bear left': '↖',
  'Turn right': '↱', 'Sharp right': '↱', 'Bear right': '↗',
  'U-turn': '⤺',
};

let _styleInjected = false;
function injectStyle() {
  if (_styleInjected) return;
  _styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
.ddoh { position:fixed; top:96px; left:50%; transform:translateX(-50%); z-index:1290; display:none;
  pointer-events:none; user-select:none; font-family:Inter, system-ui, sans-serif; color:#fff;
  min-width:212px; border-radius:16px; overflow:hidden;
  background:linear-gradient(168deg, rgba(14,18,26,.93), rgba(9,12,18,.93));
  border:1px solid rgba(255,255,255,.13);
  box-shadow:0 10px 30px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.07); }
/* No outline, and no accent bar either. The bar was the first fix for the old warning-style border
   and was itself furniture: a hard vertical rule against a rounded panel fights the corner radius,
   and the card already carries the mode's colour on the turn glyph, the label and the distance —
   the three things that actually mean something. */
.ddoh-top { display:flex; align-items:center; gap:11px; padding:11px 16px 10px; }
.ddoh-glyph { font-size:30px; line-height:1; width:32px; text-align:center; color:#fff;
  filter:drop-shadow(0 0 8px currentColor); }
.ddoh-instr { min-width:0; }
.ddoh-in { font:800 11px/1 Inter, sans-serif; letter-spacing:.16em; text-transform:uppercase;
  color:rgba(255,255,255,.55); }
.ddoh-street { font:700 15px/1.25 Inter, sans-serif; margin-top:3px; max-width:210px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ddoh-bot { display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  padding:8px 16px 10px; border-top:1px solid rgba(255,255,255,.09);
  background:rgba(255,255,255,.03); }
.ddoh-label { font:800 10px/1 Inter, sans-serif; letter-spacing:.18em; text-transform:uppercase; }
.ddoh-dist { font:700 19px/1 Inter, sans-serif; }
.ddoh-sub { font:600 10px/1 Inter, sans-serif; letter-spacing:.1em; text-transform:uppercase;
  color:rgba(255,255,255,.45); margin-top:3px; }`;
  document.head.appendChild(st);
}

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
/** m:ss, or "<1 min" — an ETA of "0:04" on a 40 m walk-up is noise, not information. */
const fmtEta = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 45) return 'under a min';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/**
 * @param {{label?:string, color?:string}} [o]
 */
export function createObjectiveHud({ label = 'OBJECTIVE', color = '#35e0ff' } = {}) {
  injectStyle();
  const el = document.createElement('div');
  el.className = 'ddoh';
  el.innerHTML =
    '<div class="ddoh-top"><div class="ddoh-glyph">↑</div>' +
    '<div class="ddoh-instr"><div class="ddoh-in">Head for</div><div class="ddoh-street">—</div></div></div>' +
    '<div class="ddoh-bot"><div><div class="ddoh-label">OBJECTIVE</div><div class="ddoh-sub"></div></div>' +
    '<div class="ddoh-dist">0 m</div></div>';
  const glyphEl = el.querySelector('.ddoh-glyph');
  const inEl = el.querySelector('.ddoh-in');
  const street = el.querySelector('.ddoh-street');
  const labelEl = el.querySelector('.ddoh-label');
  const distEl = el.querySelector('.ddoh-dist');
  const subEl = el.querySelector('.ddoh-sub');
  document.body.appendChild(el);

  let _label = label, _color = color;
  labelEl.style.color = color;
  labelEl.textContent = label;

  return {
    el,
    show(on) { el.style.display = on ? 'block' : 'none'; },
    /** Re-label between phases — PICK UP → DROP OFF, checkpoint 3 → 4. */
    setLabel(text, col) {
      if (text !== undefined && text !== _label) { _label = text; labelEl.textContent = text; }
      if (col && col !== _color) { _color = col; labelEl.style.color = col; }
    },
    /**
     * @param {object} nav  the object returned by objectiveNav.update()
     * @param {string} [sub] small line under the label (tip %, time left, checkpoint count…)
     */
    update(nav, sub = '') {
      if (!nav) return;
      if (nav.next) {
        // A real instruction. The glyph carries the turn; the street carries the where.
        glyphEl.textContent = ARROW[nav.next.dir] || '↑';
        glyphEl.style.color = _color;
        glyphEl.style.transform = '';
        inEl.textContent = `${nav.next.dir}${nav.next.inM >= 20 ? ` in ${fmtM(nav.next.inM)}` : ' now'}`;
        street.textContent = nav.next.onto || '—';
      } else if (nav.hasRoute) {
        // On the route with nothing to do but keep going — say so rather than showing a stale turn.
        glyphEl.textContent = '↑'; glyphEl.style.color = _color; glyphEl.style.transform = '';
        inEl.textContent = 'Continue';
        street.textContent = 'Straight ahead';
      } else {
        // No route yet: the far end may still be streaming. Do not invent a turn — say what is true.
        glyphEl.textContent = '◎'; glyphEl.style.color = 'rgba(255,255,255,.7)'; glyphEl.style.transform = '';
        inEl.textContent = 'Direct';
        street.textContent = 'No road route yet';
      }
      // M-9: distance AND time. The router minimises time, so the ETA is the search's own answer —
      // see planRoute. Shown beside the distance rather than in `sub`, which the modes already own.
      const eta = nav.hasRoute ? fmtEta(nav.etaS) : '';
      const dtxt = eta ? `${fmtM(nav.remainingM || 0)} · ${eta}` : fmtM(nav.remainingM || 0);
      if (distEl.textContent !== dtxt) distEl.textContent = dtxt;
      distEl.style.color = _color;
      if (subEl.textContent !== sub) subEl.textContent = sub;
    },
    /**
     * Drive the top half directly, for a mode with no ROUTE.
     *
     * Heat has no destination — the objective is "away" — so `update(nav)` has nothing to say and
     * would print its honest "No road route yet" fallback forever. This is the same card, filled in
     * by a mode that knows something a router does not.
     *
     * @param {{kicker?:string, text?:string, glyph?:string, rotateRad?:number, dist?:string, sub?:string}} o
     */
    setInstruction({ kicker = '', text = '', glyph = '↑', rotateRad = null, dist = '', sub = '' } = {}) {
      if (glyphEl.textContent !== glyph) glyphEl.textContent = glyph;
      glyphEl.style.color = _color;
      // Rotating the glyph is why this exists: a fixed arrow that means "away" points at nothing.
      glyphEl.style.transform = rotateRad === null ? '' : `rotate(${rotateRad}rad)`;
      if (inEl.textContent !== kicker) inEl.textContent = kicker;
      if (street.textContent !== text) street.textContent = text;
      if (distEl.textContent !== dist) distEl.textContent = dist;
      distEl.style.color = _color;
      if (subEl.textContent !== sub) subEl.textContent = sub;
    },
    remove() { el.remove(); },
  };
}
