#!/usr/bin/env python3
"""
build-kerb-texture.py — tiling Barcelona kerb granite (albedo + normal). v3 P3-09.

PROCEDURAL, NOT PHOTOGRAPHIC, and deliberately. A kerb is granite: a dense speckle of light quartz,
mid feldspar and dark mica at millimetre scale with no large-scale features. That is precisely what
band-limited noise is good at and precisely what an image generator is bad at — it invents cracks,
mortar lines and lighting that a 0.30 m kerb face has no room for. It also tiles PERFECTLY by
construction, because every octave is built from sin/cos at integer frequencies, so STEP 1 is exact
rather than repaired.

Still goes through art-bible §4.4 like everything else: class `kerb` (L* 51 / sigma 10, C* 5), anchor
P7 Bordillo Granite — which is the anchor the palette table names for "kerb face, bollards, stone
plinths" in the first place.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN

SRC = 'art-src/kerb-v1/src'
# The shipped plate. Procedural noise (SOURCE=None) was the first pass and is kept as the fallback:
# it tiles exactly and needs no asset. But measured side by side the AI granite wins on the gate that
# matters — dE2000 0.99 against P7 Bordillo Granite versus 5.48 procedural — because it has real
# mineral variation rather than statistically uniform speckle, and a kerb runs the length of every
# street where uniformity reads as plastic.
SOURCE = 'granite_b'

OUT = 'frontend/public/textures/road'
SIZE = 512
SPAN_M = 1.0          # the texture covers 1 real metre — see AD-12 texel-density reasoning
NORMALIZE_VERSION = 2


def periodic_noise(size, freq, seed):
    """Band-limited noise that is exactly periodic over `size` — integer frequencies only."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size * 2 * np.pi
    acc = np.zeros((size, size))
    for _ in range(6):
        fx, fy = rng.integers(1, freq + 1), rng.integers(1, freq + 1)
        ph = rng.uniform(0, 2 * np.pi)
        acc += np.sin(fx * x + ph) * np.cos(fy * y + ph * 0.7)
    return acc / 6.0


def main():
    os.makedirs(OUT, exist_ok=True)

    # Three mineral scales: coarse feldspar mottle, mid grain, fine quartz speckle.
    coarse = periodic_noise(SIZE, 6, 11)
    mid    = periodic_noise(SIZE, 24, 22)
    fine   = periodic_noise(SIZE, 96, 33)
    grain = 0.45 * coarse + 0.35 * mid + 0.20 * fine

    # Dark mica flecks — sparse, small, and NOT symmetric with the light speckle, which is what stops
    # granite reading as uniform noise.
    mica = periodic_noise(SIZE, 140, 44)
    flecks = np.clip((mica - 0.45) * 6.0, 0, 1)

    v = 0.62 + grain * 0.30 - flecks * 0.28
    v = np.clip(v, 0.05, 1.0)
    # Faint cool cast: Catalan granite is grey-blue, not neutral.
    rgb = np.dstack([v * 0.985, v, v * 1.02])
    source_type = 'flat'          # authored, not photographed → de-light k = 0

    if SOURCE:
        img = Image.open(f'{SRC}/{SOURCE}.png').convert('RGB')
        rgb = np.asarray(img, dtype=np.float64) / 255.0
        if rgb.shape[0] != SIZE:
            rgb = AN.resize_tiling(rgb, SIZE)   # wrap-aware — a plain resize breaks the tile
        source_type = 'ai'
        # REPAIR ONLY IF IT FAILS. make_tileable blends, and blending a texture that already wraps
        # cleanly makes it worse, not better — this plate scored 1.28 raw (a pass) and 2.82 after an
        # unconditional repair. "Fix or reject" means fix what is broken, not everything that arrives.
        ok, ratio, _ = AN.step1_tile_verify(rgb)
        raw_ratio = ratio
        if not ok:
            src_for_drift = rgb
            rgb = AN.make_tileable(rgb)
            ok, ratio, _ = AN.step1_tile_verify(rgb, drift_ref=src_for_drift)
        print(f'  tile verify: {raw_ratio:.2f}' + ('' if raw_ratio == ratio else f' -> {ratio:.2f} (repaired)') +
              f'  {"PASS" if ok else "FAIL — judge on the contact sheet"}')
    else:
        ok, ratio, _ = AN.step1_tile_verify(rgb)
        print(f'  tile verify: {ratio:.3f}  {"PASS" if ok else "FAIL"}  (periodic by construction)')

    alpha = np.ones((SIZE, SIZE))
    rgb, stats = AN.normalize_albedo(
        rgb, alpha, source_type=source_type,
        surface_class='kerb',
        anchor=AN.ANCHORS['P7_bordillo_granite'],
        alpha_snap=AN.SNAP_ALPHA['large_surface'], # a kerb runs the length of every street
        tiling=True)

    nrm = AN.height_normal(rgb, strength=5.0)
    nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, 'masonry')

    Image.fromarray((rgb * 255).astype(np.uint8), 'RGB').save(f'{OUT}/kerb_granite_albedo.png')
    Image.fromarray((nrm * 255).astype(np.uint8), 'RGB').save(f'{OUT}/kerb_granite_normal.png')

    manifest = {
        'name': 'kerb_granite', 'size': SIZE, 'spanM': SPAN_M,
        'normalize': {
            'version': NORMALIZE_VERSION, 'sourceType': source_type,
            'source': SOURCE or 'procedural', 'surfaceClass': 'kerb',
            'anchor': AN.ANCHORS['P7_bordillo_granite'],
            'tileRatio': round(ratio, 3), 'tileVerifyPass': bool(ok),
            'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
            'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
            'gate4Pass': bool(stats['gate4_pass']),
            'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
            'rallyClipPct': round(stats['rally_clip_pct'], 3),
        },
    }
    with open('frontend/src/map/kerbTexture.js', 'w') as f:
        f.write('// GENERATED by tools/build-kerb-texture.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')

    # Contact sheet: tiled 3x3, because repetition is a tiling texture's real failure mode.
    cell = Image.open(f'{OUT}/kerb_granite_albedo.png').resize((150, 150), Image.LANCZOS)
    sheet = Image.new('RGB', (450, 480), (128, 128, 128))
    for a in range(3):
        for b in range(3):
            sheet.paste(cell, (a * 150, b * 150))
    ImageDraw.Draw(sheet).text((8, 458),
        f"kerb_granite  L*{manifest['normalize']['LStar']} C*{manifest['normalize']['CStar']}  "
        f"dE {manifest['normalize']['deltaE2000']} -> {stats['anchor'].split('_',1)[1]}", fill=(255, 255, 255))
    sheet.save(f'{OUT}/kerb_granite_contact_sheet.png')

    gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
    print(f'  kerb_granite  L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
          f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
          f'|N.xy| {n_before:.3f}->{n_after:.3f}{"" if n_ok else " OUT-OF-BAND"}  '
          f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<22} {gate}')
    print(f'\n-> {OUT}/kerb_granite_{{albedo,normal}}.png  ({SIZE}²)')


main()
