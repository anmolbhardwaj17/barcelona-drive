/**
 * tunnelDebugOverlay.js — Phase 0 diagnostic overlay (flag-gated, OFF by default).
 *
 * Activate with the URL query param  ?debug=tunnel  (no CONFIG edit, no perf cost
 * when absent — initTunnelDebug() returns false and update() early-returns).
 *
 * Per playbook §0.2 it renders three things so the renderer↔physics contract can be
 * SEEN rather than inferred:
 *   1. Physics body wireframes — delegates to the existing debugColliders.js, which
 *      adds wireframes to `scene` at physics coords (Ox−wx, wz−Oz). worldGroup renders
 *      visual geometry at the same scene coords (scale.x=−1, pos=originOffset), so a
 *      correctly-negated body's wireframe sits ON TOP of its visual mesh; a call site
 *      that forgot to negate X shows up MIRRORED across the tile (the C1/C4 test).
 *   2. Tile-seam markers — vertical lines at zoom-16 tile boundaries near the camera,
 *      so cross-tile continuity (C5) can be checked exactly at the seam.
 *   3. Per-body Y labels — for each static collider body, a sprite at the body's mean
 *      box-centre showing classification + representative physics Y (road_Y proxy) and
 *      shape count. Lets you read floor/ceiling heights in-world.
 *
 * This module is READ-ONLY w.r.t. game state: it never mutates physics, geometry,
 * bake or carve code. It only adds debug meshes/sprites to the scene.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { updateDebugColliders } from './debugColliders.js';
import { getOriginOffset } from './originOffset.js';
import { worldToSlippyTile, tileToBBox, latLonToWorld, TILE_ZOOM } from './projection.js';

let _active = false;
let _group = null;          // seam markers + labels (separate from debugColliders group)
let _frame = 0;
const REBUILD_INTERVAL = 60;
const SEAM_RANGE_TILES = 2; // draw seams for ±2 tiles around the viewer

/** Read ?debug=tunnel once. Returns whether the overlay is active. */
export function initTunnelDebug() {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = (params.get('debug') || '').toLowerCase();
    _active = v.split(',').includes('tunnel');
  } catch {
    _active = false;
  }
  if (_active) {
    // eslint-disable-next-line no-console
    console.log('[tunnelDebug] overlay ACTIVE (?debug=tunnel). Wireframes = physics bodies; ' +
      'green=deck boxes, red/magenta=walls, orange=terrain trimesh. Yellow lines = tile seams.');
  }
  return _active;
}

export function isTunnelDebugActive() { return _active; }

/** world (wx,wz) → scene coords, matching worldGroup(scale.x=-1, pos=originOffset). */
function worldToScene(wx, wz) {
  const o = getOriginOffset();
  return { x: o.x - wx, z: wz - o.z };
}

/** camera scene position → world (wx,wz). */
function sceneToWorld(sx, sz) {
  const o = getOriginOffset();
  return { wx: o.x - sx, wz: sz + o.z };
}

function makeLabelSprite(text, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = color;
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(12, 3, 1);
  spr.renderOrder = 1001;
  return spr;
}

function classifyStatic(body) {
  for (const s of body.shapes) {
    if (s.type === CANNON.Shape.types.TRIMESH) return 'trimesh';
    if (s.type === CANNON.Shape.types.HEIGHTFIELD) return 'heightfield';
    if (s.type === CANNON.Shape.types.PLANE) return 'plane';
  }
  return 'box';
}

/** Build tile-seam vertical line markers around the camera. */
function buildSeamMarkers(group, cameraScenePos) {
  const { wx, wz } = sceneToWorld(cameraScenePos.x, cameraScenePos.z);
  let tile;
  try { tile = worldToSlippyTile(wx, wz); } catch { return; }
  if (!tile) return;

  const mat = new THREE.LineBasicMaterial({ color: 0xffff33, depthTest: false, transparent: true, opacity: 0.8 });
  const yLo = -30, yHi = 30;

  for (let dx = -SEAM_RANGE_TILES; dx <= SEAM_RANGE_TILES + 1; dx++) {
    for (let dy = -SEAM_RANGE_TILES; dy <= SEAM_RANGE_TILES + 1; dy++) {
      const bbox = tileToBBox(tile.x + dx, tile.y + dy, TILE_ZOOM);
      // SW + NE corners in world coords
      const sw = latLonToWorld(bbox.south, bbox.west);
      const ne = latLonToWorld(bbox.north, bbox.east);
      // Draw the two boundary edges meeting at the SW corner (vertical posts at corners).
      const corners = [
        worldToScene(sw.x, sw.z),
        worldToScene(ne.x, sw.z),
        worldToScene(sw.x, ne.z),
      ];
      for (const c of corners) {
        const g = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(c.x, yLo, c.z),
          new THREE.Vector3(c.x, yHi, c.z),
        ]);
        const line = new THREE.Line(g, mat);
        line.renderOrder = 1000;
        line.frustumCulled = false;
        group.add(line);
      }
    }
  }
}

/** Build per-body Y labels for static collider bodies. */
function buildBodyLabels(group, world) {
  for (const body of world.bodies) {
    if (body.mass > 0) continue;               // skip vehicle
    const type = classifyStatic(body);
    if (type === 'plane') continue;            // fallback floor — uninformative
    if (!body.shapes.length) continue;

    // Representative position = mean of box shape offsets (body-local) → world.
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let si = 0; si < body.shapes.length; si++) {
      const s = body.shapes[si];
      if (!(s instanceof CANNON.Box)) continue;
      const off = body.shapeOffsets[si];
      sx += off.x; sy += off.y; sz += off.z; n++;
    }
    let cx, cy, cz, label, color;
    if (n > 0) {
      cx = sx / n + body.position.x;
      cy = sy / n + body.position.y;
      cz = sz / n + body.position.z;
      // y here is physics Y = normalized road/wall Y. Deck boxes ≈ road_Y; walls ≈ road_Y/2.
      color = cy < -0.5 ? '#66ccff' : '#66ff66';
      label = `${type} n=${n} y≈${cy.toFixed(1)}`;
    } else {
      cx = body.position.x; cy = body.position.y; cz = body.position.z;
      color = '#ff8844';
      label = `${type} (${body.shapes.length} shp)`;
    }
    const spr = makeLabelSprite(label, color);
    spr.position.set(cx, cy + 2, cz);
    group.add(spr);
  }
}

/**
 * Per-frame update. Safe to call unconditionally — early-returns when inactive.
 * @param {THREE.Scene} scene
 * @param {CANNON.World} world
 * @param {THREE.Camera} camera
 */
export function updateTunnelDebug(scene, world, camera) {
  if (!_active || !scene || !world) return;

  // 1. Physics wireframes (own rebuild cadence inside debugColliders).
  updateDebugColliders(scene, world);

  // 2 + 3. Seam markers + labels (throttled rebuild).
  _frame++;
  if (_group && _frame % REBUILD_INTERVAL !== 0) return;

  if (_group) {
    scene.remove(_group);
    _group.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  }
  _group = new THREE.Group();
  _group.name = 'tunnelDebugOverlay';

  if (camera) buildSeamMarkers(_group, camera.position);
  buildBodyLabels(_group, world);

  scene.add(_group);
}
