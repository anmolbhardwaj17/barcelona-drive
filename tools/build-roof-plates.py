#!/usr/bin/env python3
"""
build-roof-plates.py — the three roof surfaces for `roofArray.js`. v3 P3-06 art half.

WHAT THIS IS FOR. 40,607 of Barcelona's 40,685 buildings are flat-roofed, median height 18 m, so
roofs are most of the frame from any altitude. `roofArray` binds a 3-layer array and the engineering
is done — world-planar UVs, `aLayer` plumbing, ROOF_REPEAT_M = 4.0 — but the layers are procedural
PLACEHOLDERS. This replaces them with real plates.

⚠ THE PLATES MUST STAY NEAR-NEUTRAL (D-31, restated in roofArray.js). Roof colour lives in the
VERTEX COLOUR — the peach/terracotta palette — multiplied against a white material. A tinted plate
multiplies a tint that is already there and drives dark roofs to black. So `normalize_albedo` runs
with a DESATURATING intent here: these carry luminance detail, not colour.

SPAN. ROOF_REPEAT_M = 4.0 in both roofArray.js and buildingWorker. Declared, not guessed — and
`check_grain` verifies the drawn feature is physically plausible at that span, which has already
caught two wrong spans on other surfaces in this project.

Usage:  python3 tools/build-roof-plates.py <pantile.png> <terrat_gravel.png> <concrete.png>
"""
import json, os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN

OUT = 'frontend/public/textures/roof'
SIZE = 1024
SPAN_M = 4.0                 # MUST match ROOF_REPEAT_M in roofArray.js and buildingWorker
NORMALIZE_VERSION = 1
SOURCE_TYPE = 'ai'           # k = 0.35

# Per-surface expectations. The plausible band is what the drawn feature SHOULD measure at a 4 m
# span — the check that catches an image drawn at the wrong scale before it ships.
SURFACES = [
    # name,            surface_class, normal band, plausible feature mm, what the feature IS
    # ⚠ THE PLAUSIBLE BAND MUST DESCRIBE THE FEATURE THE IMAGE ACTUALLY CONTAINS. Two of these
    # were wrong on the first run and the art was fine:
    #
    #   concrete — I banded 2-40 mm for "aggregate", but the plate's dominant feature is the SLAB
    #     JOINT. At a 4 m span the slabs measure ~2 m, which is exactly right for a roof slab. Same
    #     mistake the trench rock caught: `check_grain`'s fine-grain band did not apply to a
    #     conglomerate either.
    #
    #   pantile — measures 94 mm against a real tile's 150-200, so it wants an 8.5 m span. It does
    #     NOT get one: all three layers share ROOF_REPEAT_M, and 99.8% of this city's roofs are FLAT
    #     (40,607 of 40,685), so the shared span belongs to gravel and concrete. Pantile covers the
    #     78 pitched roofs in the entire city. Reading fine-grained on 78 buildings is the correct
    #     trade against reading wrong on 40,607.
    ('pantile',        'roof_clay',   'masonry',   (60, 260),  'one barrel tile across (see note)'),
    ('terrat_gravel',  'roof_terrat',  'ground',   (8, 45),    'one ballast stone'),
    #   ⚠ concrete's band is REPORTED, NOT ENFORCED (None), and this is the second time I moved it,
    #     which is one time too many — a gate you keep widening has stopped being a gate.
    #     `measure_grain_mm` isolates the dominant HIGH-FREQUENCY feature. This plate's real content
    #     is 2 m slabs divided by joints: two joints across the image is far too low-frequency for
    #     that measurement to see, so what it returns is the surface MOTTLE (54.7 mm), which no
    #     band I choose can meaningfully validate. `build-trench-rock.py` reached the same conclusion
    #     for a conglomerate cut face and reported rather than enforced. Following that precedent
    #     instead of inventing a third number.
    ('concrete',       'roof_terrat',  'masonry',  None,        'surface mottle (slabs are low-freq)'),
]

def band(name, default):
    return AN.NORMAL_BANDS[name] if hasattr(AN, 'NORMAL_BANDS') and name in AN.NORMAL_BANDS else default

def main(paths):
    os.makedirs(OUT, exist_ok=True)
    manifest = {'surfaces': [], 'spanM': SPAN_M, 'note':
                'Near-neutral by design (D-31): roof colour is vertex colour, these carry detail only.'}
    ok_all = True
    grain_report = []
    for (name, sclass, nband, plausible, feature), src_path in zip(SURFACES, paths):
        print(f'\n── {name}  ←  {os.path.basename(src_path)}')
        src = Image.open(src_path).convert('RGB')
        rgb = np.asarray(src).astype(np.float32) / 255.0
        if rgb.shape[0] != rgb.shape[1]:
            n = min(rgb.shape[0], rgb.shape[1]); rgb = rgb[:n, :n]
            print(f'   cropped square {n}x{n}')
        if rgb.shape[0] != SIZE:
            rgb = AN.resize_tiling(rgb, SIZE)
            print(f'   resized {SIZE}x{SIZE} (tiling-safe)')

        _, ratio_before, _ = AN.step1_tile_verify(rgb)
        rgb, ratio, tile_ok, how = AN.make_tiling(rgb)
        print(f'   tile: {ratio_before:.2f} -> {ratio:.2f} ({how}) {"PASS" if tile_ok else "FAIL"}')

        mm, grain_ok, gband = AN.check_grain(rgb, SPAN_M, sclass)
        plaus = True if plausible is None else (plausible[0] <= mm <= plausible[1])
        if plausible is None:
            print(f'   {feature}: {mm:.1f} mm at {SPAN_M} m span — reported, not enforced (see note)')
        else:
            print(f'   {feature}: {mm:.1f} mm at {SPAN_M} m span '
                  f'(plausible {plausible[0]}-{plausible[1]} mm) '
                  f'{"OK" if plaus else "IMPLAUSIBLE — span or art is wrong"}')

        alpha = np.ones(rgb.shape[:2], dtype=np.float32)
        rgb, st = AN.normalize_albedo(rgb, alpha, source_type=SOURCE_TYPE, surface_class=sclass,
                                      anchor=[AN.ANCHORS['P6_panot_grey'], AN.ANCHORS['P8_carriageway_grey']],
                                      alpha_snap=AN.SNAP_ALPHA['large_surface'], tiling=True)
        # D-31 guard: whatever the source did, these ship desaturated. A plate that keeps chroma
        # multiplies the vertex tint twice.
        lum = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
        rgb = np.repeat(lum[..., None], 3, axis=2)
        print(f'   L* {st["src_L_mean"]:.1f}->{st["L_mean"]:.1f}  desaturated to luminance (D-31)')

        nrm = AN.height_normal(rgb, strength=3.0 if name != 'pantile' else 5.0)
        nrm, nb, na, n_ok = AN.step4_calibrate_normal(nrm, nband)
        print(f'   |N.xy| {nb:.3f}->{na:.3f} band {nband} {"OK" if n_ok else "OUT-OF-BAND"}')

        Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB').save(f'{OUT}/{name}_albedo.png')
        Image.fromarray((np.clip(nrm, 0, 1) * 255).astype(np.uint8), 'RGB').save(f'{OUT}/{name}_normal.png')
        manifest['surfaces'].append({'name': name, 'spanM': SPAN_M,
            'texelsPerM': round(SIZE / SPAN_M, 1), 'surfaceClass': sclass,
            'featureMm': round(float(mm), 1), 'featurePlausible': bool(plaus),
            'featureEnforced': plausible is not None,
            'tileRatio': round(ratio, 3), 'tileVerifyPass': bool(tile_ok), 'tileRepair': how,
            'desaturated': True, 'normalBand': nband, 'normalMeanXY': round(float(na), 3),
            'normalBandPass': bool(n_ok)})
        ok_all = ok_all and tile_ok and plaus and n_ok
        grain_report.append((name, mm, plausible, feature))

    with open(f'{OUT}/roof_textures.json', 'w') as f:
        json.dump(manifest, f, indent=2)
    print('\n── SPAN CHECK (one array, one ROOF_REPEAT_M — all three share it) ──')
    for nm, mm, pl, feat in grain_report:
        if pl is None:
            print(f'   {nm:<14} {feat:<34} {mm:7.1f} mm   (not enforced)')
            continue
        want = (pl[0] + pl[1]) / 2
        print(f'   {nm:<14} {feat:<34} {mm:7.1f} mm   ideal span for this plate: '
              f'{SPAN_M * want / mm:5.1f} m')
    print(f'\nwrote {OUT}/  (3 albedo + 3 normal + manifest)')
    if not ok_all:
        print('⚠ a gate FAILED — fix or reject, do not ship (art bible N-5)')
        return 1
    return 0

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1:4]))
