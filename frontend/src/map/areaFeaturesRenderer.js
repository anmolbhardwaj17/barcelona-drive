/**
 * areaFeaturesRenderer — flat polygon meshes for v7 area features that had no renderer until now:
 * BEACHES (sand) and PEDESTRIAN AREAS (plaza paving). Baked since May 2026, parsed by
 * tileParserWorker (readAreaFeatures), and dropped on the floor — Barceloneta rendered as bare
 * terrain. Mirrors greensRenderer's lifecycle exactly: terrain-following flat ShapeGeometry merged
 * per kind, one material PER TILE (unload disposes geometry+material; programs are shared because
 * the patch source is identical), tracked in entry.greenMeshes so streaming/unload come free.
 *
 * Polygon coords are parser-convention {x, y} world objects (y = world Z) — same frame as greens.
 */
import * as THREE from 'three';
import { applyGroundLayer } from './groundLayers.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldToLatLon } from '../projection.js';
import { CONFIG } from '../config.js';
import { patchAoDarkening } from './aoSampler.js';
import { getPanotSurfaceMaterial } from './roadRenderer.js';

/** `?plazatex=0` — revert pedestrian plazas to the flat fill. Attribution switch, read once. */
const PLAZA_TEXTURE = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('plazatex') !== '0';

/**
 * `?pedareas=0` — draw no pedestrian plazas at all.
 *
 * ⚠ This is a DIAGNOSTIC, not a preference. `?plazatex=0` only swaps the material, so it cannot
 * answer "are these polygons the thing I am looking at?" — which is exactly the question that cost
 * a round trip. This one removes them, so one reload settles identity. Barcelona really does have
 * large pedestrianised areas (measured: six polygons, 6,648 m², largest 3,143 m² in an 89x89 m
 * footprint, in the Gran Via tile alone), so OFF is the wrong long-term default — it deletes real
 * city. Use it to identify, then argue about how they should LOOK.
 */
const PED_AREAS_ON = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('pedareas') !== '0';

const AREA_OFFSET_Y = 0.02;   // above greens' 0.01 so shared-edge coast strips don't z-race

// Mid-dark, desaturated bases — the rally grade multiplies saturation ×1.52 and brightens, so
// palettes are tuned BELOW the target on-screen colour (same lesson as the roof palette).
const KINDS = {
  beach: {
    color: 0x9c8f68,          // dry Mediterranean sand (reads warm light sand after the grade)
    noise: 0.06,              // grain amplitude — sand wants visible mottle
    layer: 'beach',
  },
  pedArea: {
    color: 0x77746c,          // warm granite/panot plaza paving (sidewalk-adjacent, a hair warmer)
    noise: 0.03,              // subtle slab variation
    layer: 'pedArea',
  },
};

/** Deterministic value noise (same recipe as roadRenderer.roadNoise — stateless, seam-free). */
function areaNoise(x, z, seed) {
  const n = Math.sin(x * 0.11 + seed) * Math.cos(z * 0.13 + seed * 0.7)
          + Math.sin((x + z) * 0.045 + seed * 1.3) * 0.5;
  return n * 0.5; // ~-0.75..0.75 → scaled by kind.noise
}

/**
 * @param {Array<{ id:number, type:string, polygon:{x:number,y:number}[], isLine?:boolean }>} features
 * @param {'beach'|'pedArea'} kindName
 * @param {(lat:number, lon:number) => number} [getElevationAt]
 * @returns {THREE.Mesh[]} 0 or 1 merged mesh (array for uniform handling with greens)
 */
export function createAreaFeatureMeshes(features, kindName, getElevationAt) {
  // `?pedareas=0` — see PED_AREAS_ON. Identity diagnostic; beaches are unaffected.
  if (kindName === 'pedArea' && !PED_AREAS_ON) return [];
  const kind = KINDS[kindName];
  if (!kind || !features?.length) return [];

  const vertExag = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION))
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const geometries = [];
  for (const f of features) {
    const poly = f.polygon;
    if (f.isLine || !poly || poly.length < 3) continue;

    let cx = 0, cz = 0;
    for (const p of poly) { cx += p.x; cz += p.y; }
    cx /= poly.length; cz /= poly.length;
    const { lat, lon } = worldToLatLon(cx, cz);
    const rawY = getElevationAt ? getElevationAt(lat, lon) : 0;
    const baseY = Number.isFinite(rawY) ? rawY : 0;
    const y = baseY * vertExag + AREA_OFFSET_Y;

    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
    shape.closePath();

    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, y, 0);
    geometries.push(geom);
  }
  if (geometries.length === 0) return [];

  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  if (!merged) return [];

  // GROUND-COVER-FIX follow-up: a PLAZA IS PANOT, and it was the only paved surface without it.
  //
  // These polygons were invisible until D-73 (they rode the 170 m TREE rule on a distance that
  // includes camera altitude, so from any height every plaza in the city vanished at once). The
  // moment they appeared, they read as "big sidewalks" — and measured, they are: six polygons
  // totalling 6,648 m² in the Gran Via tile, the largest 3,143 m² in a 89x89 m footprint. At that
  // size a flat vertex-coloured field beside the pavement's photographic panot plate reads as a
  // blob, which is a MATERIAL problem, not a size one. Barcelona lays its pedestrianised plazas in
  // the same panot as its pavements, so they get the same plate — on the `pedArea` layer, never the
  // pavement's, or a plaza would paint over the carriageway it touches (R-J4).
  //
  // ATTRIBUTION SWITCH, in the house style of `?roadv2=0` / `?treecards=0`: `?plazatex=0` restores
  // the flat fill. Drive both before arguing about it.
  const texturedPlaza = kindName === 'pedArea' && PLAZA_TEXTURE;

  // Per-vertex colour mottle — flat single-colour polygons read as untextured plastic.
  const pos = merged.getAttribute('position');
  // Under a texture the mottle must ride NEAR WHITE, or `map * vertexColor` halves the plate's
  // brightness and the plaza goes muddy instead of paved. Keep a whisper of the granite tint.
  const base = new THREE.Color(texturedPlaza ? 0xd8d3c8 : kind.color);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 1 + areaNoise(pos.getX(i), pos.getZ(i), kindName === 'beach' ? 5.0 : 9.0) * kind.noise;
    colors[i * 3] = base.r * v;
    colors[i * 3 + 1] = base.g * v;
    colors[i * 3 + 2] = base.b * v;
  }
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const material = texturedPlaza
    ? getPanotSurfaceMaterial('pedArea')   // shared, cached per layer — already AO- and ground-layered
    : patchAoDarkening(applyGroundLayer(new THREE.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true,
      }), kind.layer));

  const mesh = new THREE.Mesh(merged, material);
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData = { type: 'areaFeature', areaKind: kindName };
  return [mesh];
}
