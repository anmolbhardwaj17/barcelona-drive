/**
 * DOM overlay showing current street name (or road type fallback).
 */
const DEFAULT_TEXT = '—';

const TYPE_LABELS = {
  motorway: 'Motorway',
  motorway_link: 'Motorway Link',
  trunk: 'Trunk Road',
  trunk_link: 'Trunk Link Road',
  primary: 'Primary Road',
  primary_link: 'Primary Link Road',
  secondary: 'Secondary Road',
  secondary_link: 'Secondary Link Road',
  tertiary: 'Tertiary Road',
  tertiary_link: 'Tertiary Link Road',
  residential: 'Residential Road',
  living_street: 'Living Street',
  service: 'Service Road',
  unclassified: 'Road',
};

/**
 * Create and mount street name UI element.
 * @returns {{ element: HTMLElement, setStreet: (name: string, highwayType?: string) => void }}
 */
export function createStreetDisplay() {
  const el = document.createElement('div');
  el.id = 'street-display';
  el.textContent = DEFAULT_TEXT;
  el.style.cssText = `
    position: fixed;
    bottom: 82px;
    left: 50%;
    transform: translateX(-50%);
    padding: 0;
    background: none;
    color: #f3ede1;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 20px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    text-shadow: 0 1px 6px rgba(0,0,0,0.45);
    pointer-events: none;
    white-space: nowrap;
    z-index: 10;
  `;
  document.body.appendChild(el);
  return {
    element: el,
    setStreet(name, highwayType) {
      if (name != null && name !== '' && name !== '—') {
        el.textContent = name;
      } else if (highwayType) {
        el.textContent = TYPE_LABELS[highwayType] || (highwayType.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' Road');
      } else {
        el.textContent = DEFAULT_TEXT;
      }
    },
  };
}
