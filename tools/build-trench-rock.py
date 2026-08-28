#!/usr/bin/env python3
"""
build-trench-rock.py — the trench cut-face rock surface. v3 P4-18.

WHAT THIS IS FOR. `buildTrenchCliffWalls` draws the cut rock face of the Ronda de Dalt trench, and
the spawn sits at a trench portal, so this surface is in frame on the first drive of every session.
It shipped as a flat `RETAINING_COLOR` fill because `public/textures/terrain/` contains nothing but
a README — the terrain pack was never built.

WHY THIS IS NOT build-rock-atlas.py. That tool makes an ATLAS of discrete boulders for the
vegetation pack: cells, per-stone UV rects, `SNAP_ALPHA['prop']`. This is one continuous TILING
plate for a large surface, so it takes `SNAP_ALPHA['large_surface']` (0.60 against a prop's 0.35) —
a cliff face is read as part of the world's ground palette, and a weak snap lets it drift away from
it. Same normalize procedure, different surface.

SPAN. Art bible §5, "Terrain rock layer": 1024 square over 8.0 x 8.0 real metres = 128 texels/m.
Declared here and consumed by `roadTextures`-style manifest, never guessed at the call site.

SOURCE. AI-generated (`source_type='ai'`, k=0.35), not a photoscan. The bible prefers photoscans for
rock because they carry TRUE normal maps; this plate has no normal, so one is height-derived and
calibrated into the masonry band. That is a real fidelity compromise and it is recorded in the
manifest rather than hidden: `sourceType: 'ai'` and `normalSource: 'height-derived'`.

Usage:  python3 tools/build-trench-rock.py <source.png>
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN

OUT = 'frontend/public/textures/terrain'
SIZE = 1024
# ── SPAN IS A PHYSICAL CLAIM, AND IT WAS MEASURED, NOT ASSUMED ────────────────────────────────
# The art bible §5 "Terrain rock layer" row says 1024 over 8.0 m (128 texels/m). This plate does not
# contain 8 m of wall. `measure_grain_mm` isolates the dominant high-frequency feature at ~18 px;
# at an 8 m span that makes the pebbles 14 cm across, and a conglomerate's clasts run 2-6 cm. At
# 3.0 m they measure 5.3 cm, which is right. Declaring 8 m would ship a wall at 2.7x life size.
#
# The cost of the honest number is that the plate repeats every 3 m instead of every 8, and that is
# the correct trade: `measure_grain_mm` exists because the kerb granite and the asphalt BOTH shipped
# at guessed spans and read as gravel, and both times the plate was fine and the SPAN was wrong.
SPAN_M = 3.0                # measured, not the table's 8.0 — see above. 341 texels/m.
NORMALIZE_VERSION = 1

SOURCE_TYPE   = 'ai'        # k = 0.35
SURFACE_CLASS = 'rock'      # L* 55 / sigma 13, C* 8
# The stone family, same as the boulder atlas: sandstone finds P2 ochre, schist/granite P6/P7.
PALETTE_ANCHOR = [AN.ANCHORS['P2_ochre_sand'], AN.ANCHORS['P6_panot_grey'],
                  AN.ANCHORS['P7_bordillo_granite'], AN.ANCHORS['P8_carriageway_grey']]
SNAP_ALPHA  = AN.SNAP_ALPHA['large_surface']   # a cut face IS the ground palette, not a prop on it
NORMAL_BAND = 'masonry'                         # 0.18-0.32, art bible 3.7


def main(src_path):
    os.makedirs(OUT, exist_ok=True)
    print(f'source: {src_path}')

    # STEP 0 — ingest. Square, resized on the tiling-safe path (a plain resize breaks the wrap).
    src = Image.open(src_path).convert('RGB')
    rgb = np.asarray(src).astype(np.float32) / 255.0
    if rgb.shape[0] != rgb.shape[1]:
        n = min(rgb.shape[0], rgb.shape[1])
        rgb = rgb[:n, :n]
        print(f'  cropped to square {n}x{n}')
    if rgb.shape[0] != SIZE:
        rgb = AN.resize_tiling(rgb, SIZE)
        print(f'  resized to {SIZE}x{SIZE} (tiling-safe)')

    # STEP 1 — tile verify, then the REPAIR LADDER. `make_tiling` tries "already tiles" and the
    # lossless roll-into-alignment before it blends, and that order matters: the module records
    # blending a plate that already wrapped cleanly taking it from 1.28 to 2.82.
    ok_before, ratio_before, _ = AN.step1_tile_verify(rgb)
    rgb, ratio, tile_ok, how = AN.make_tiling(rgb)
    print(f'  tile: {ratio_before:.2f} -> {ratio:.2f}  ({how})  {"PASS" if tile_ok else "FAIL"}')

    # Grain sanity: is what is drawn physically plausible at the declared span?
    # ⚠ The 'rock' band (1-6 mm) describes fine schist/sandstone GRAIN. This plate is a
    # CONGLOMERATE cut face whose dominant feature is pebbles, so it cannot land in that band at any
    # sane span and the check is reported rather than enforced. What matters physically is that the
    # measured feature is a plausible PEBBLE, which is asserted separately below.
    mm, grain_ok, band = AN.check_grain(rgb, SPAN_M, SURFACE_CLASS)
    PEBBLE_MM = (20, 70)
    pebble_ok = PEBBLE_MM[0] <= mm <= PEBBLE_MM[1]
    print(f'  grain: {mm:.1f} mm at {SPAN_M} m span — fine-grain band {band[0]}-{band[1]} mm '
          f'{"OK" if grain_ok else "n/a (conglomerate, pebble-dominated)"}')
    print(f'  pebble size: {mm:.1f} mm (plausible {PEBBLE_MM[0]}-{PEBBLE_MM[1]} mm) '
          f'{"OK" if pebble_ok else "IMPLAUSIBLE — the declared span is wrong"}')

    # STEPS 2-6 — de-light, Lab rescale, palette snap, pre-grade divide, gates.
    alpha = np.ones(rgb.shape[:2], dtype=np.float32)
    rgb, stats = AN.normalize_albedo(
        rgb, alpha, source_type=SOURCE_TYPE, surface_class=SURFACE_CLASS,
        anchor=PALETTE_ANCHOR, alpha_snap=SNAP_ALPHA, tiling=True)

    # STEP 4 — normal. Height-derived, because the source carries none. Lower strength than the
    # boulder atlas (6.0): a bedded cut face is shallow relief across the plate, and a boulder's is
    # its whole silhouette.
    nrm = AN.height_normal(rgb, strength=3.5)
    nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, NORMAL_BAND)

    gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
    print(f'  L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
          f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
          f'|N.xy| {n_before:.3f}->{n_after:.3f}{"" if n_ok else " OUT-OF-BAND"}  '
          f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<22} {gate}  '
          f'rallyclip {stats["rally_clip_pct"]:.2f}%')

    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB').save(
        f'{OUT}/rock_face_albedo.png')
    Image.fromarray((np.clip(nrm, 0, 1) * 255).astype(np.uint8), 'RGB').save(
        f'{OUT}/rock_face_normal.png')

    # STEP 8 — contact sheet, TILED 2x2. A tiling texture's real failure is repetition, and a
    # single square never shows it.
    sheet = Image.new('RGB', (SIZE, SIZE))
    half = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB').resize(
        (SIZE // 2, SIZE // 2), Image.LANCZOS)
    for qx in (0, SIZE // 2):
        for qy in (0, SIZE // 2):
            sheet.paste(half, (qx, qy))
    sheet.save(f'{OUT}/rock_face_contact_sheet.png')

    manifest = {
        'surfaces': [{
            'name': 'rock_face',
            'spanM': SPAN_M,
            'texelsPerM': round(SIZE / SPAN_M, 1),
            'use': 'trench cut face (buildTrenchCliffWalls)',
            'normalize': {
                'version': NORMALIZE_VERSION, 'sourceType': SOURCE_TYPE,
                'k': AN.DELIGHT_K[SOURCE_TYPE], 'surfaceClass': SURFACE_CLASS,
                'snapAlpha': SNAP_ALPHA,
                'normalSource': 'height-derived',   # NOT a scanned normal — see the header
                'tileRatioBefore': round(ratio_before, 3),
                'tileRatio': round(ratio, 3), 'tileVerifyPass': bool(tile_ok), 'tileRepair': how,
                'grainMm': round(float(mm), 2), 'grainPass': bool(grain_ok),
                'grainBandApplies': False,   # 'rock' band is fine grain; this is a conglomerate
                'pebbleMm': round(float(mm), 1), 'pebblePlausible': bool(pebble_ok),
                'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
                'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
                'gate4Pass': bool(stats['gate4_pass']),
                'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
                'rallyClipPct': round(stats['rally_clip_pct'], 3),
            },
        }],
    }
    with open(f'{OUT}/terrain_textures.json', 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'\nwrote {OUT}/rock_face_albedo.png + _normal.png + contact sheet + manifest')
    if not (tile_ok and stats['gate4_pass'] and n_ok and pebble_ok):
        print('⚠ one or more gates FAILED — fix or reject, do not ship (art bible N-5)')
        return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
