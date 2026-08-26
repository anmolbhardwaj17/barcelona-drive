#!/usr/bin/env python3
"""
build-shopfront-layers.py — the 8 GROUND-array shopfront layers. v3 P3-05, second half.

THE GROUND LAYER IS NOT THE BODY LAYER, and the difference is the whole design:

    BODY    tiles in BOTH axes. u wraps around corners, v wraps every 2 storeys.
    GROUND  tiles in u ONLY. "The bottom edge is the pavement and the top edge meets the body
            band's first row" — it is addressed once, v 0 -> 1, and never wrapped.

So the tile check and the alignment repair both run u-ONLY here. Judging the v seam would fail a
texture that is correct, and rolling v would slide the pavement plinth off the bottom and wrap it
round to the top — which is exactly the kind of "repair" that breaks a good asset.

Sized 896 x 512 for 7.0 m x 4.0 m: 128 texels/m on BOTH axes, matching the body layers. The plan
allowed 64 across on a 512 square; a 1.75:1 page hits the body's density in both directions for the
same memory, and a square page would have stretched every shopfront 1.75x horizontally.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN
from encodeKtx2 import encode_array

SRC = 'art-src/shopfronts-v1/src'
OUT = 'frontend/public/art/v1/facades'
MANIFEST = 'frontend/src/map/shopfrontLayers.js'
W, H = 896, 512               # 7.0 m x 4.0 m at 128 texels/m
LAYER_W_M, LAYER_H_M = 7.0, 4.0
NORMALIZE_VERSION = 2

#  name                  class      anchors                                    normal band
LAYERS = [
    ('residential_cream',  'facade', ['P1_eixample_cream', 'P2_ochre_sand'],    'masonry'),
    ('residential_ochre',  'facade', ['P2_ochre_sand', 'P6_panot_grey'],        'masonry'),
    ('residential_rose',   'facade', ['P3_modernisme_rose', 'P4_teula_clay'],   'masonry'),
    ('residential_grey',   'facade', ['P6_panot_grey', 'P7_bordillo_granite'],  'masonry'),
    ('residential_oldtown','facade', ['P2_ochre_sand', 'P1_eixample_cream'],    'masonry'),
    ('commercial',         'facade', ['P6_panot_grey', 'P7_bordillo_granite'],  'masonry'),
    ('office',             'facade', ['P6_panot_grey', 'P1_eixample_cream'],    'masonry'),
    ('industrial_brick',   'brick',  ['P5_poblenou_brick', 'P4_teula_clay'],    'masonry'),
]


def resize_u_tiling(rgb, w, h):
    """
    Resample tiling in u, clamping in v — the same split the texture itself has.

    A plain resize invents border pixels from one side only and breaks the horizontal wrap; a fully
    wrapped resize would fold the pavement into the fascia. Tiling 3x across and once down gives the
    left and right edges real neighbours while leaving top and bottom alone.
    """
    src = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB')
    sw, sh = src.size
    wide = Image.new('RGB', (sw * 3, sh))
    for i in range(3):
        wide.paste(src, (i * sw, 0))
    wide = wide.resize((w * 3, h), Image.LANCZOS)
    return np.asarray(wide.crop((w, 0, w * 2, h)), dtype=np.float64) / 255.0


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {'layerWidthM': LAYER_W_M, 'layerHeightM': LAYER_H_M, 'width': W, 'height': H,
                'texelsPerM': W / LAYER_W_M, 'normalizeVersion': NORMALIZE_VERSION, 'layers': []}

    for idx, (name, cls, anchors, band) in enumerate(LAYERS):
        rgb = np.asarray(Image.open(f'{SRC}/{name}.png').convert('RGB'), dtype=np.float64) / 255.0

        ok, raw_ratio, _ = AN.step1_tile_verify(rgb, axes='u')
        dy = dx = 0
        if not ok:
            rolled, dy, dx = AN.align_tiling(rgb, axes='u')
            ok2, r2, _ = AN.step1_tile_verify(rolled, axes='u')
            if r2 < raw_ratio:
                rgb, ratio, ok = rolled, r2, ok2
            else:
                ratio, dx = raw_ratio, 0
        else:
            ratio = raw_ratio
        if not ok:
            raise SystemExit(f'{name}: does not tile horizontally ({ratio:.2f}) — reframe the plate')

        rgb = resize_u_tiling(rgb, W, H)

        # ⚠ NO L* RESCALE, AND NO CHROMA RESCALE. A shopfront's VALUE is its identity — dark green
        # joinery, dark glass, a pale stone plinth — and the `facade` class describes a WALL at
        # L* 74. Applying it lifted the green bar 51 points and rendered it pale mint; every plate
        # came out bleached. Chroma is left alone for the same reason: a greengrocer's produce is
        # real object colour, not a material sample, and greying it to a wall's target is damage.
        #
        # De-light, palette snap and the pre-grade divide all still run. Those remove the plate's
        # own baked lighting and keep it inside the Barcelona palette, which is what normalize is
        # actually for here.
        alpha = np.ones(rgb.shape[:2])
        rgb, stats = AN.normalize_albedo(
            rgb, alpha, source_type='ai', surface_class=cls,
            anchor=[AN.ANCHORS[a] for a in anchors],
            alpha_snap=AN.SNAP_ALPHA['prop'],   # a shopfront is joinery and fittings, not a wall
            tiling=True, rescale_L=False, rescale_C=False)

        nrm = AN.height_normal(rgb, strength=4.0)
        nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, band)
        grain_mm, grain_ok, _ = AN.check_grain(rgb, LAYER_W_M, cls)

        Image.fromarray((rgb * 255).astype(np.uint8), 'RGB').save(f'{OUT}/shop_{name}_albedo.png')
        Image.fromarray((nrm * 255).astype(np.uint8), 'RGB').save(f'{OUT}/shop_{name}_normal.png')

        manifest['layers'].append({
            'name': name, 'index': idx, 'surfaceClass': cls,
            'normalize': {
                'version': NORMALIZE_VERSION, 'sourceType': 'ai', 'surfaceClass': cls,
                'anchors': anchors, 'tileAxis': 'u', 'tileRaw': round(raw_ratio, 2),
                'tileRatio': round(ratio, 3), 'tileRoll': [0, int(dx)], 'tileVerifyPass': bool(ok),
                'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
                'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
                'gate4Pass': bool(stats['gate4_pass']),
                'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
                'grainMM': round(grain_mm, 1) if grain_mm else None, 'grainBandPass': bool(grain_ok),
            },
        })
        gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
        print(f'  {name:22s} u-tile {raw_ratio:5.2f}->{ratio:4.2f}  '
              f'L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
              f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
              f'|N.xy| {n_after:.3f}{"" if n_ok else " OUT"}  '
              f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<22} {gate}')

    # V-FLIP before encoding — KTX2 is bottom-up and three cannot flip compressed data. Same trap the
    # body layers hit, where balconies rendered above their windows.
    flip = f'{OUT}/.flipped_shop'
    os.makedirs(flip, exist_ok=True)
    names = [n for n, *_r in LAYERS]
    print('\n  encoding KTX2 ARRAYS:')
    for kind, is_nrm in (('albedo', False), ('normal', True)):
        for n in names:
            Image.open(f'{OUT}/shop_{n}_{kind}.png').transpose(Image.FLIP_TOP_BOTTOM) \
                 .save(f'{flip}/{n}_{kind}.png')
        out, sz = encode_array([f'{flip}/{n}_{kind}.png' for n in names],
                               f'{OUT}/facade_ground_{kind}.ktx2',
                               codec='uastc' if is_nrm else 'etc1s', normal_map=is_nrm)
        print(f'    {os.path.basename(out):32s} {sz / 1048576:5.2f} MB   ({len(names)} layers)')
    manifest['arrays'] = {'albedo': 'facade_ground_albedo.ktx2',
                          'normal': 'facade_ground_normal.ktx2', 'layerOrder': names}

    SW = 340
    sheet = Image.new('RGB', (SW * 4, (int(SW / 1.75) + 26) * 2), (128, 128, 128))
    for i, (name, *_r) in enumerate(LAYERS):
        cell = Image.open(f'{OUT}/shop_{name}_albedo.png').resize((SW, int(SW / 1.75)), Image.LANCZOS)
        ox, oy = (i % 4) * SW, (i // 4) * (int(SW / 1.75) + 26)
        sheet.paste(cell, (ox, oy))
        st = manifest['layers'][i]['normalize']
        ImageDraw.Draw(sheet).text((ox + 6, oy + int(SW / 1.75) + 6),
            f"{name}  L*{st['LStar']} dE{st['deltaE2000']}", fill=(255, 255, 255))
    sheet.save(f'{OUT}/shopfront_contact_sheet.png')

    with open(MANIFEST, 'w') as f:
        f.write('// GENERATED by tools/build-shopfront-layers.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')
    print(f'\n-> {OUT}/  ·  {W}x{H} at {W / LAYER_W_M:.0f} texels/m  ·  manifest {MANIFEST}')


main()
