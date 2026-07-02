/**
 * Top-right panel: world coords (x, z), lat/lon, heading, speed.
 */
const ROUND = (v, d = 4) => (Math.round(v * 10 ** d) / 10 ** d);

/**
 * Create metrics panel and mount to body.
 * @returns {{ element: HTMLElement, update: (data: { x?: number, z?: number, lat?: number, lon?: number, roadType?: string, headingDeg?: number, speedKmh?: number }) => void }}
 */
export function createMetricsPanel() {
  const el = document.createElement('div');
  el.id = 'metrics-panel';
  el.innerHTML = `
    <div class="metrics-row"><span class="metrics-k">X</span><span class="metrics-v" id="m-x">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Z</span><span class="metrics-v" id="m-z">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Lat</span><span class="metrics-v" id="m-lat">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Lon</span><span class="metrics-v" id="m-lon">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Road</span><span class="metrics-v" id="m-road">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Heading</span><span class="metrics-v" id="m-heading">—</span></div>
    <div class="metrics-row"><span class="metrics-k">Speed</span><span class="metrics-v" id="m-speed">—</span></div>
  `;
  el.style.cssText = `
    position: fixed;
    top: 64px;
    right: 24px;
    padding: 10px 14px;
    background: rgba(0,0,0,0.65);
    color: #eee;
    font-family: monospace;
    font-size: 12px;
    border-radius: 8px;
    z-index: 10;
    pointer-events: none;
    line-height: 1.5;
    min-width: 140px;
  `;
  el.querySelectorAll('.metrics-row').forEach((row) => {
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.gap = '12px';
  });
  el.querySelectorAll('.metrics-k').forEach((k) => {
    k.style.color = 'rgba(255,255,255,0.7)';
  });
  document.body.appendChild(el);

  const vX = el.querySelector('#m-x');
  const vZ = el.querySelector('#m-z');
  const vLat = el.querySelector('#m-lat');
  const vLon = el.querySelector('#m-lon');
  const vRoad = el.querySelector('#m-road');
  const vHeading = el.querySelector('#m-heading');
  const vSpeed = el.querySelector('#m-speed');

  return {
    element: el,
    update(data) {
      if (data.x != null) vX.textContent = String(ROUND(data.x));
      if (data.z != null) vZ.textContent = String(ROUND(data.z));
      if (data.lat != null) vLat.textContent = String(ROUND(data.lat, 5));
      if (data.lon != null) vLon.textContent = String(ROUND(data.lon, 5));
      if (data.roadType != null) vRoad.textContent = data.roadType || '—';
      if (data.headingDeg != null) vHeading.textContent = `${ROUND(data.headingDeg, 1)}°`;
      if (data.speedKmh != null) vSpeed.textContent = `${Math.round(data.speedKmh)} km/h`;
    },
  };
}
