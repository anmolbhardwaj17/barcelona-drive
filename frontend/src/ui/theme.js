/**
 * theme.js — art-of-rally-inspired UI design system.
 *
 * Single source of truth for the HUD / menu chrome. Replaces the old per-component "Brawl-Stars"
 * styling (chunky 3D bevels, saturated yellow/green, Poppins/Lilita One) with a calm, flat,
 * geometric look: Inter, warm frosted glass, one muted coral accent, tight letter-spacing.
 *
 * Usage:
 *   import { UI, glassPanel, iconButton, injectUITheme } from './theme.js';
 *   injectUITheme();                       // once, at boot — adds :hover/:active rules
 *   el.style.cssText = glassPanel();       // frosted HUD panel
 *   btn.style.cssText = iconButton();      // flat square icon button  (add class 'dd-btn')
 */

export const UI = {
  // ── Type ──────────────────────────────────────────────────────────────────
  font:     "'Inter', system-ui, 'Segoe UI', sans-serif",
  fontCond: "'Inter', system-ui, sans-serif",

  // ── Warm paper palette ─────────────────────────────────────────────────────
  cream:    '#f3ede1',            // primary text / light surfaces (warm off-white)
  creamDim: 'rgba(243,237,225,0.62)',
  creamFaint: 'rgba(243,237,225,0.34)',
  ink:      '#2a2521',            // warm near-black — text on cream surfaces
  inkDim:   'rgba(42,37,33,0.55)',

  // Frosted surfaces
  panel:     'rgba(28,25,22,0.44)',   // dark warm glass — HUD overlays on gameplay
  panelDeep: 'rgba(28,25,22,0.62)',   // a touch more opaque, for denser panels
  cream95:   'rgba(243,237,225,0.95)', // warm cream glass — menus / light surfaces

  // Hairlines
  stroke:    'rgba(243,237,225,0.16)',
  strokeSoft:'rgba(243,237,225,0.10)',
  strokeInk: 'rgba(42,37,33,0.12)',

  // ── Accents (muted, one warm coral hero + quiet supports) ──────────────────
  coral:     '#d76a4f',           // the single hero accent (terracotta/coral)
  coralSoft: 'rgba(215,106,79,0.16)',
  sky:       '#7ea6b0',           // cool support (night / info)
  sage:      '#8fa77e',           // quiet green support

  // ── Shape ──────────────────────────────────────────────────────────────────
  radius:    '13px',
  radiusSm:  '9px',
  blur:      'blur(15px) saturate(1.08)',
  shadow:    '0 5px 20px rgba(0,0,0,0.24)',
  shadowSm:  '0 3px 12px rgba(0,0,0,0.20)',
};

/** UPPERCASE, wide-tracked label (the signature art-of-rally caption style). */
export function label({ size = 11, weight = 600, color = UI.creamDim, spacing = 0.04 } = {}) {
  return `font-family:${UI.font};font-size:${size}px;font-weight:${weight};color:${color};` +
         `text-transform:uppercase;letter-spacing:${spacing}em;`;
}

/** Frosted glass HUD panel. */
export function glassPanel({ pad = '10px 13px', radius = UI.radius, deep = false } = {}) {
  return `background:${deep ? UI.panelDeep : UI.panel};` +
         `backdrop-filter:${UI.blur};-webkit-backdrop-filter:${UI.blur};` +
         `border:1px solid ${UI.stroke};border-radius:${radius};padding:${pad};` +
         `font-family:${UI.font};color:${UI.cream};box-shadow:${UI.shadow};`;
}

/** Flat square icon button. Give the element class 'dd-btn' so injectUITheme()'s hover/active applies. */
export function iconButton({ size = 46, radius = UI.radius } = {}) {
  return `width:${size}px;height:${size}px;border-radius:${radius};` +
         `display:flex;align-items:center;justify-content:center;` +
         `background:${UI.panel};backdrop-filter:${UI.blur};-webkit-backdrop-filter:${UI.blur};` +
         `border:1px solid ${UI.stroke};color:${UI.cream};cursor:pointer;user-select:none;` +
         `box-shadow:${UI.shadowSm};transition:background .18s ease,border-color .18s ease,transform .1s ease;`;
}

let _injected = false;
/** Inject the small set of :hover / :active rules inline styles can't express. Idempotent. */
export function injectUITheme() {
  if (_injected) return;
  _injected = true;
  const s = document.createElement('style');
  s.id = 'dd-ui-theme';
  s.textContent = `
    .dd-btn:hover   { background:rgba(243,237,225,0.14); border-color:${UI.stroke}; }
    .dd-btn:active  { transform:translateY(1px) scale(0.97); }
    .dd-btn.dd-on   { background:${UI.coralSoft}; border-color:rgba(215,106,79,0.5); color:${UI.cream}; }
  `;
  document.head.appendChild(s);
}
