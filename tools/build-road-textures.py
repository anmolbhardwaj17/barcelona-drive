#!/usr/bin/env python3
"""
build-road-textures.py — asphalt + panot tiling materials. v3 P3-08.

TEXTURE SPAN IS THE DECISION THAT MATTERS HERE, more than the source plate. A texture covers a stated
number of real metres, and getting that wrong is not a subtle art call — it changes what the surface
IS. The kerb granite shipped at a 1 m span first and read as gravel, because the plate's ~1 cm
speckle then WAS 1 cm of stone when granite grain is 1-3 mm. Same plate at 0.35 m reads as granite.
So each entry below states its span explicitly and the renderer uses it.

NORMALS ARE DERIVED FROM LUMINANCE, and that is a known compromise the art bible names (AD-1a): only
a photoscan ships a TRUE normal, and a luminance-derived one reads a dark stone as a pit and a light
one as a bump, which for asphalt aggregate is often backwards. It is still far better than none —
asphalt with no normal turns to grey mush at bumper distance — but the honest upgrade path is an
ambientCG CC0 scan, which is what P3-08 actually specifies.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN

SRC = 'art-src/road-v1/src'
OUT = 'frontend/public/textures/road'
MANIFEST = 'frontend/src/map/roadTextures.js'
NORMALIZE_VERSION = 2

#  name            size  spanM  class       anchor                 normal band  strength  note
SURFACES = [
    ('asphalt_worn',  1024, 4.0, 'asphalt',  'P8_carriageway_grey', 'ground',  5.0,
     'Worn carriageway - exposed aggregate, patching, tyre polish'),
    ('asphalt_fresh', 1024, 4.0, 'asphalt',  'P8_carriageway_grey', 'ground',  4.0,
     'Recently laid - tight aggregate still coated in binder'),
    # 0.40 m because the plate is a 2x2 of 20 cm panot tiles. Anything else and the Flor de Barcelona
    # comes out the wrong size, which is the one surface in the city everyone can measure by eye.
    ('panot',         1024, 0.40, 'sidewalk', 'P6_panot_grey',      'masonry', 3.0,
     'Flor de Barcelona panot - 2x2 of 20 cm tiles'),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {'normalizeVersion': NORMALIZE_VERSION, 'surfaces': []}

    for name, size, span, cls, anchor, band, nstr, note in SURFACES:
        img = Image.open(f'{SRC}/{name}.png').convert('RGB')
        rgb = np.asarray(img, dtype=np.float64) / 255.0

        _, raw_ratio, _ = AN.step1_tile_verify(rgb)
        rgb, ratio, tile_ok, how = AN.make_tiling(rgb)
        if not tile_ok:
            raise SystemExit(f'{name}: does not tile ({ratio:.2f}) after {how} — reject, never ship')
        if rgb.shape[0] != size:
            rgb = AN.resize_tiling(rgb, size)   # wrap-aware, or the repair above is undone

        alpha = np.ones(rgb.shape[:2])
        rgb, stats = AN.normalize_albedo(
            rgb, alpha, source_type='ai', surface_class=cls,
            anchor=AN.ANCHORS[anchor],
            alpha_snap=AN.SNAP_ALPHA['large_surface'],   # road and pavement are large continuous surfaces
            tiling=True)

        nrm = AN.height_normal(rgb, strength=nstr)
        nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, band)

        Image.fromarray((rgb * 255).astype(np.uint8), 'RGB').save(f'{OUT}/{name}_albedo.png')
        Image.fromarray((nrm * 255).astype(np.uint8), 'RGB').save(f'{OUT}/{name}_normal.png')

        # MEAN LUMINANCE — needed because ROAD_V2 uses this texture as a MULTIPLIER
        # (`diffuseColor.rgb *= grain`), not as a base albedo. The generator it replaces produced a
        # modulation field centred near 1.0; an authored albedo sits at its class L* (0.10 linear for
        # asphalt), so multiplying by it darkens the road by 10x on top of a base that is already
        # dark. The renderer divides by this so the plate modulates around 1.0 — keeping the base
        # palette colour, the vertex colours and the baked AO, and adding real photographic grain on
        # top rather than replacing all three.
        lin = AN.srgb_to_linear(rgb)
        mean_luma = float((lin @ np.array([0.2126, 0.7152, 0.0722])).mean())

        manifest['surfaces'].append({
            'name': name, 'size': size, 'spanM': span, 'note': note,
            'meanLuma': round(mean_luma, 5),
            'normalize': {
                'version': NORMALIZE_VERSION, 'sourceType': 'ai', 'surfaceClass': cls,
                'anchor': AN.ANCHORS[anchor], 'tileRaw': round(raw_ratio, 2),
                'tileRatio': round(ratio, 3), 'tileRepair': how, 'tileVerifyPass': bool(tile_ok),
                'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
                'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
                'gate4Pass': bool(stats['gate4_pass']),
                'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
                'normalSource': 'luminance-derived (AD-1a: photoscan is the upgrade)',
                'rallyClipPct': round(stats['rally_clip_pct'], 3),
            },
        })
        gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
        print(f'  {name:<14} span {span:>4.2f}m  tile {raw_ratio:5.2f}->{ratio:4.2f} ({how})  '
              f'L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
              f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:4.1f}  '
              f'|N.xy| {n_before:.3f}->{n_after:.3f}{"" if n_ok else " OUT-OF-BAND"}  '
              f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<20} {gate}')

    # Contact sheet, tiled 2x2 per surface — repetition is a tiling texture's real failure mode.
    SW = 380
    sheet = Image.new('RGB', (SW * len(SURFACES), SW + 30), (128, 128, 128))
    for i, (name, *_r) in enumerate(SURFACES):
        arr = np.asarray(Image.open(f'{OUT}/{name}_albedo.png'), dtype=np.float64) / 255.0
        cell = Image.fromarray((AN.resize_tiling(arr, SW // 2) * 255).astype(np.uint8), 'RGB')
        pane = Image.new('RGB', (SW, SW))
        for a in range(2):
            for b in range(2):
                pane.paste(cell, (a * (SW // 2), b * (SW // 2)))
        sheet.paste(pane, (i * SW, 0))
        st = manifest['surfaces'][i]['normalize']
        ImageDraw.Draw(sheet).text((i * SW + 8, SW + 8),
            f"{name}  L*{st['LStar']} C*{st['CStar']}  dE {st['deltaE2000']} -> "
            f"{st['nearestAnchor'].split('_',1)[1]}", fill=(255, 255, 255))
    sheet.save(f'{OUT}/road_contact_sheet.png')

    with open(MANIFEST, 'w') as f:
        f.write('// GENERATED by tools/build-road-textures.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')
    print(f'\n-> {OUT}/  ·  manifest {MANIFEST}')


main()
