#!/usr/bin/env python3
"""
build-facade-layers.py — the 8 BODY facade layers. v3 P3-05.

AUTHORED TO facadeArray.js's UV SPEC, which is unusually strict and worth restating because every
number here is load-bearing:

    BODY layer   8.0 m wide x 8.0 m tall = 2 storeys of 4.0 m.  1024^2 -> 128 texels/m.
                 MUST tile in BOTH axes. u wraps around corners, v wraps every 2 storeys.
                 "The top edge must meet the bottom edge — a window row split across that seam is
                  the single most visible authoring error."

That last line is why align_tiling runs on every plate rather than only the failures. All eight
arrived framed off-grid to some degree — the worst scored 46.04 — and a roll put every one of them
at 0.00, because the search finds the wrap point where the texture changes least, which on a facade
IS the blank render between storeys. A roll moves pixels; blending would ghost every window, so the
blend rung of the ladder is disabled here.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN

SRC = 'art-src/facades-v1/src'
OUT = 'frontend/public/art/v1/facades'
MANIFEST = 'frontend/src/map/facadeLayers.js'
SIZE = 1024
LAYER_W_M = 8.0     # must match facadeArray.LAYER_W_M
LAYER_H_M = 8.0     # must match facadeArray.BODY_LAYER_H_M
NORMALIZE_VERSION = 2

#  name                  class      anchor(s)                                  normal band
LAYERS = [
    ('residential_cream',  'facade', ['P1_eixample_cream', 'P2_ochre_sand'],    'masonry'),
    ('residential_ochre',  'facade', ['P2_ochre_sand', 'P1_eixample_cream'],    'masonry'),
    ('residential_rose',   'facade', ['P3_modernisme_rose', 'P4_teula_clay'],   'masonry'),
    ('residential_grey',   'facade', ['P6_panot_grey', 'P2_ochre_sand'],        'masonry'),
    ('residential_oldtown','facade', ['P1_eixample_cream', 'P2_ochre_sand'],    'masonry'),
    ('commercial',         'facade', ['P6_panot_grey', 'P2_ochre_sand'],        'masonry'),
    ('office',             'facade', ['P6_panot_grey', 'P7_bordillo_granite'],  'masonry'),
    # Brick is its own surface class — L* 45 / C* 26 against the facade class's 74 / 14. Grading a
    # brick warehouse to plaster targets would wash it to a pink render.
    ('industrial_brick',   'brick',  ['P5_poblenou_brick', 'P4_teula_clay'],    'masonry'),
]


def window_mask(rgb):
    """
    Glass mask, derived rather than authored — the plan lists a window mask as a third map, and it
    does not need its own art: glazing is the dark, low-chroma, locally-flat region of a facade, and
    all three of those are measurable. Shipped as the albedo's alpha channel so it costs no extra
    texture unit and no extra upload.
    """
    lab = AN.rgb_to_lab(rgb)
    L, C, _ = AN.lab_to_lch(lab)
    dark = 1.0 - np.clip((L - 18.0) / 34.0, 0.0, 1.0)      # glass is dark
    flat = 1.0 - np.clip(C / 22.0, 0.0, 1.0)               # and desaturated
    m = np.clip(dark * flat, 0.0, 1.0)
    # Clean up speckle: glazing comes in panes, not pixels.
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8), 'L')
                   .filter(ImageFilter.MedianFilter(5)), dtype=np.float64) / 255.0
    return m


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {'layerWidthM': LAYER_W_M, 'layerHeightM': LAYER_H_M, 'size': SIZE,
                'texelsPerM': SIZE / LAYER_W_M, 'normalizeVersion': NORMALIZE_VERSION, 'layers': []}

    for idx, (name, cls, anchors, band) in enumerate(LAYERS):
        rgb = np.asarray(Image.open(f'{SRC}/{name}.png').convert('RGB'), dtype=np.float64) / 255.0

        _, raw_ratio, _ = AN.step1_tile_verify(rgb)
        rolled, dy, dx = AN.align_tiling(rgb)
        ok, ratio, _ = AN.step1_tile_verify(rolled)
        if ratio <= raw_ratio:
            rgb = rolled
        else:
            ratio, dy, dx = raw_ratio, 0, 0
        if not ok and ratio > 1.5:
            # NO BLEND FALLBACK. A blended facade ghosts every window; rejecting is the honest move.
            raise SystemExit(f'{name}: does not tile ({ratio:.2f}) and a facade cannot be blended '
                             f'— reframe the plate so the seam falls between storeys')

        if rgb.shape[0] != SIZE:
            rgb = AN.resize_tiling(rgb, SIZE)   # wrap-aware, or the roll above is undone

        mask = window_mask(rgb)

        # ── NORMALIZE THE PLASTER, NOT THE WINDOWS ────────────────────────────────────────────
        # A facade is not one surface. It is render PLUS glazing PLUS ironwork, and the `facade`
        # class (L* 74 / C* 14) describes only the first of those. Normalizing the whole image as
        # one surface drags the other two with it: measured, the office layer's dark glazing came
        # out MINT GREEN, because the class rescale lifted it toward plaster lightness and the
        # palette snap then rotated its near-neutral hue onto an anchor. The rose plaster washed
        # pale for the same reason from the other direction — its statistics were dragged DOWN by
        # dark windows and balconies, so the rescale over-lifted to compensate.
        #
        # So the window mask does double duty: statistics are gathered over plaster only, and the
        # graded result is composited back over plaster only. Glass and ironwork keep the values the
        # plate gave them, which is correct — the surface class names the surface it governs.
        plaster = 1.0 - mask
        graded, stats = AN.normalize_albedo(
            rgb, plaster, source_type='ai', surface_class=cls,
            anchor=[AN.ANCHORS[a] for a in anchors],
            alpha_snap=AN.SNAP_ALPHA['large_surface'],   # a facade IS a large continuous surface
            alpha_threshold=0.5, tiling=True)
        w = plaster[..., None]
        rgb = graded * w + rgb * (1.0 - w)

        nrm = AN.height_normal(rgb, strength=4.0)
        nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, band)

        grain_mm, grain_ok, grain_band = AN.check_grain(rgb, LAYER_W_M, cls)

        # Albedo carries the window mask in alpha — one upload, not two.
        rgba = np.concatenate([rgb, mask[..., None]], axis=-1)
        Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA').save(f'{OUT}/{name}_albedo.png')
        Image.fromarray((nrm * 255).astype(np.uint8), 'RGB').save(f'{OUT}/{name}_normal.png')

        manifest['layers'].append({
            'name': name, 'index': idx, 'surfaceClass': cls,
            'normalize': {
                'version': NORMALIZE_VERSION, 'sourceType': 'ai', 'surfaceClass': cls,
                'anchors': anchors, 'tileRaw': round(raw_ratio, 2), 'tileRatio': round(ratio, 3),
                'tileRoll': [int(dy), int(dx)], 'tileVerifyPass': bool(ratio <= 1.5),
                'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
                'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
                'gate4Pass': bool(stats['gate4_pass']),
                'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
                'grainMM': round(grain_mm, 1) if grain_mm else None, 'grainBandPass': bool(grain_ok),
                'windowFrac': round(float((mask > 0.5).mean() * 100), 1),
                'rallyClipPct': round(stats['rally_clip_pct'], 3),
            },
        })
        gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
        print(f'  {name:22s} tile {raw_ratio:6.2f}->{ratio:4.2f} roll({dy:4d},{dx:4d})  '
              f'L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
              f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
              f'glass {manifest["layers"][-1]["normalize"]["windowFrac"]:5.1f}%  '
              f'|N.xy| {n_after:.3f}{"" if n_ok else " OUT"}  '
              f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<22} {gate}')

    # STEP 8 — contact sheet. Each layer shown TILED 2x2, because the failure this task names is a
    # seam, and a single square cannot show one.
    SW = 300
    cols, rows = 4, 2
    sheet = Image.new('RGB', (SW * cols, (SW + 26) * rows), (128, 128, 128))
    for i, (name, *_r) in enumerate(LAYERS):
        arr = np.asarray(Image.open(f'{OUT}/{name}_albedo.png').convert('RGB'), dtype=np.float64) / 255.0
        cell = Image.fromarray((AN.resize_tiling(arr, SW // 2) * 255).astype(np.uint8), 'RGB')
        pane = Image.new('RGB', (SW, SW))
        for a in range(2):
            for b in range(2):
                pane.paste(cell, (a * (SW // 2), b * (SW // 2)))
        ox, oy = (i % cols) * SW, (i // cols) * (SW + 26)
        sheet.paste(pane, (ox, oy))
        st = manifest['layers'][i]['normalize']
        ImageDraw.Draw(sheet).text((ox + 6, oy + SW + 6),
            f"{name}  L*{st['LStar']} dE{st['deltaE2000']}", fill=(255, 255, 255))
    sheet.save(f'{OUT}/facade_contact_sheet.png')

    with open(MANIFEST, 'w') as f:
        f.write('// GENERATED by tools/build-facade-layers.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')
    print(f'\n-> {OUT}/  ·  {SIZE}^2 at {SIZE / LAYER_W_M:.0f} texels/m  ·  manifest {MANIFEST}')


main()
