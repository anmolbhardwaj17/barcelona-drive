/**
 * On-screen direction arrow (compass) showing car heading. N = up, arrow = forward.
 */
const SIZE = 56;

/**
 * Create direction indicator: N label + rotating arrow for car heading.
 * @returns {{ element: HTMLElement, setHeading: (headingDeg: number) => void }}
 */
export function createDirectionDisplay() {
  const el = document.createElement('div');
  el.id = 'direction-display';
  el.innerHTML = `
    <div class="dir-label">N</div>
    <div class="dir-arrow-wrap">
      <svg class="dir-arrow" viewBox="0 0 24 24" width="${SIZE}" height="${SIZE}">
        <path d="M12 4 L12 20 M12 4 L8 10 M12 4 L16 10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  `;
  el.style.cssText = `
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: ${SIZE}px;
    height: ${SIZE}px;
    z-index: 10;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  `;
  const wrap = el.querySelector('.dir-arrow-wrap');
  wrap.style.cssText = `transform-origin: center center;`;
  const arrow = el.querySelector('.dir-arrow');
  arrow.style.cssText = `display: block; color: rgba(255,255,255,0.9); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.8));`;
  const label = el.querySelector('.dir-label');
  label.style.cssText = `
    font-size: 10px;
    font-weight: 700;
    color: rgba(255,255,255,0.95);
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    line-height: 1;
    margin-bottom: -4px;
  `;
  document.body.appendChild(el);

  return {
    element: el,
    setHeading(headingDeg) {
      // Arrow points forward. N = 0° (world +Z). Our forward = -Z so heading 0° = arrow up.
      // headingDeg: 0 = north (+Z), 90 = east (+X). Arrow rotation = headingDeg (N is up).
      wrap.style.transform = `rotate(${headingDeg}deg)`;
    },
  };
}
