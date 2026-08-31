#!/usr/bin/env python3
"""
build-surface-plates.py — the three flat tiling plates: bridge soffit, compound wall, sign back.

WHY ONE TOOL FOR THREE. They are the same job with different numbers: one square photograph, one
declared span, the art-bible §4.4 normalize, a height-derived normal, and a KTX2 pair. Giving each
its own script would triple the places the span convention could drift.

WHY THE FURNITURE ATLAS IS NOT HERE. It is a 2x2 of four DIFFERENT materials — galvanised steel,
powder-coated dark metal, precast concrete, signal red. A palette snap is a per-surface operation
and running one over the whole sheet would drag the red toward a Barcelona anchor and destroy the
one thing that makes it read as street furniture. It needs per-cell classes and per-cell tiling,
and it belongs with P4-17 which is what consumes it.

⚠ D-31 DOES NOT APPLY TO THESE. That rule ("plates must be near-WHITE") exists because roof and
facade colour lives in VERTEX COLOUR against a white material, so a tinted plate multiplies a tint
that is already there. None of these three work that way: each replaces a SOLID material colour
(slab 0xa9a49d, compound wall 0xC8B89A, sign back 0x888888), so the plate IS the colour and
forcing it near-white would wash the surface out.

Usage:  python3 tools/build-surface-plates.py [soffit|wall|signback|all]
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN
from encodeKtx2 import encode

SIZE = 1024
NORMALIZE_VERSION = 1

# ── SPAN IS A PHYSICAL CLAIM AND IT GETS MEASURED ─────────────────────────────────────────────
# `measure_grain_mm` isolates the dominant high-frequency feature and asks whether it is plausible
# at the declared span. This exists because the kerb granite AND the asphalt both shipped at
# GUESSED spans and both read as gravel — the plates were fine and the spans were wrong.
SURFACES = {
    'soffit': {
        'src':   'art-src/soffit-v1/src/slab_soffit.png',
        'out':   'frontend/public/textures/road',
        'name':  'slab_soffit',
        'span':  4.0,          # form-board courses read ~40 cm; 8 to a 4 m repeat
        'class': 'sidewalk',   # pale concrete, L* 62 / C* 6
        'anchor': ['P6_panot_grey', 'P8_carriageway_grey', 'P7_bordillo_granite'],
        'snap':  'large_surface',   # a deck underside IS part of the ground palette
        'band':  'masonry',
        'use':   'bridge/viaduct deck underside (getSlabMaterial)',
        'strength': 3.0,
    },
    'wall': {
        'src':   'art-src/wall-v1/src/compound_render.png',
        'out':   'frontend/public/textures/wall',
        'name':  'compound_render',
        'span':  3.0,
        'class': 'facade',     # painted render, warm — L* 74 / C* 14
        'anchor': ['P1_eixample_cream', 'P2_ochre_sand'],
        'snap':  'large_surface',
        'band':  'masonry',
        'use':   'compound/boundary wall (barrierRenderer compound_wall)',
        'strength': 2.5,
        # ⚠ CLAMPS VERTICALLY. The plate carries a damp band along its BOTTOM edge, which is right
        # for a wall — that is where rising damp is — and fatal for a repeating V: the band would
        # reappear as a stripe partway up. The consumer must map V across the wall's height ONCE.
        'wrap_v': 'clamp',
    },
    'signback': {
        'src':   'art-src/signback-v1/src/sign_back.png',
        'out':   'frontend/public/textures/road',
        'name':  'sign_back',
        'span':  0.8,
        'class': 'metal',      # L* 58 / C* 3
        'anchor': ['P8_carriageway_grey', 'P6_panot_grey'],
        'snap':  'prop',       # a sign back is a prop, not the ground palette
        'band':  'prop',
        'use':   'traffic-sign reverse face (roadInfraRenderer sharedSignBackMat)',
        'strength': 2.0,
    },
}


def build(key, cfg):
    print(f'\n── {key} ─────────────────────────────────────────────')
    os.makedirs(cfg['out'], exist_ok=True)
    rgb = np.asarray(Image.open(cfg['src']).convert('RGB')).astype(np.float32) / 255.0
    if rgb.shape[0] != rgb.shape[1]:
        n = min(rgb.shape[0], rgb.shape[1]); rgb = rgb[:n, :n]
    if rgb.shape[0] != SIZE:
        rgb = AN.resize_tiling(rgb, SIZE)
        print(f'  resized to {SIZE} (tiling-safe path, not a plain resize)')

    ok_before, ratio_before, _ = AN.step1_tile_verify(rgb)
    # A wall that clamps vertically still has to tile HORIZONTALLY, and make_tiling works on both
    # axes. Repairing V here is harmless — the consumer never repeats it — and repairing U is
    # required, so the ladder runs either way.
    rgb, ratio, tile_ok, how = AN.make_tiling(rgb)
    print(f'  tile: {ratio_before:.2f} -> {ratio:.2f} ({how}) {"PASS" if tile_ok else "FAIL"}')

    # ── THE FINE-GRAIN BAND DOES NOT DESCRIBE THESE SURFACES ──────────────────────────────────
    # `check_grain` compares the dominant high-frequency feature against a class band that means
    # GRAIN — 1-6 mm for concrete, 1-5 mm for render. What actually dominates a soffit or a painted
    # wall is MOTTLE: staining patches, thinned paint, pour variation, a few centimetres across. So
    # the band is reported and not enforced, exactly as build-trench-rock.py does for a conglomerate
    # whose pebbles can never land in a fine-grain band at any sane span.
    #
    # What IS asserted is that the feature is a plausible mottle at the declared span. That keeps
    # the check honest: it still catches a span wrong by an order of magnitude, which is the failure
    # it exists for (the kerb granite and the asphalt both shipped at guessed spans and read as
    # gravel), without waving through a number nobody looked at.
    MOTTLE_MM = (10, 90)
    mm, grain_ok, band = AN.check_grain(rgb, cfg['span'], cfg['class'])
    mottle_ok = MOTTLE_MM[0] <= mm <= MOTTLE_MM[1]
    bandtxt = f'{band[0]}-{band[1]} mm' if band else 'no band for this class'
    print(f'  grain: {mm:.1f} mm at {cfg["span"]} m span (fine-grain band {bandtxt}) — reported')
    print(f'  mottle: {mm:.1f} mm plausible {MOTTLE_MM[0]}-{MOTTLE_MM[1]} mm '
          f'{"OK" if mottle_ok else "IMPLAUSIBLE — the declared span is wrong"}')

    alpha = np.ones(rgb.shape[:2], dtype=np.float32)
    rgb, stats = AN.normalize_albedo(
        rgb, alpha, source_type='ai', surface_class=cfg['class'],
        anchor=[AN.ANCHORS[a] for a in cfg['anchor']],
        alpha_snap=AN.SNAP_ALPHA[cfg['snap']], tiling=True)

    # ── NORMALS ARE COMPUTED, CHECKED, AND ONLY SHIPPED IF SOMETHING SAMPLES THEM ─────────────
    # The roof plates shipped a full set of normal maps that no material ever bound — 7.6 MB of
    # nothing, caught only when the art budget was measured. The budget is the constraint here too:
    # albedo is ~0.45 MB a plate and the UASTC normal is ~0.95 MB, and there is 4 MB of headroom in
    # total. So a normal is BUILT and gated (a bad one is worth knowing about) and shipped only when
    # `with_normal` is set, which happens when the consuming material actually binds one.
    nrm = AN.height_normal(rgb, strength=cfg['strength'])
    nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, cfg['band'])

    print(f'  L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
          f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
          f'|N.xy| {n_before:.3f}->{n_after:.3f}{"" if n_ok else " OUT-OF-BAND"}  '
          f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<22} '
          f'{"OK " if stats["gate4_pass"] else "FAIL"}')

    base = f'{cfg["out"]}/{cfg["name"]}'
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB').save(f'{base}_albedo.png')
    kinds = [('_albedo', 'etc1s', False)]
    if cfg.get('with_normal'):
        Image.fromarray((np.clip(nrm, 0, 1) * 255).astype(np.uint8), 'RGB').save(f'{base}_normal.png')
        kinds.append(('_normal', 'uastc', True))
    else:
        print('  normal: built and gated, NOT shipped — no material binds one yet')

    # ── SHIP KTX2, NOT PNG. The pack was measured at exactly 24 MB of a 24 MB cap; the roof plates
    # alone went 2.83 -> 0.44 MB as KTX2. ETC1S for opaque colour, UASTC for the normal (ETC1S
    # quantises to a small palette, which bands a normal into visible facets).
    tot_png = tot_ktx = 0
    for suffix, codec, is_nrm in kinds:
        png = f'{base}{suffix}.png'
        _, a, b = encode(png, codec=codec, normal_map=is_nrm)
        # The LOW tier requests `<name>.half.ktx2`; ktx2Library.test.js asserts it exists and a
        # missing one 404s on low-end devices.
        half_png = f'{base}{suffix}.half.png'
        im = Image.open(png)
        im.resize((im.size[0] // 2, im.size[1] // 2), Image.LANCZOS).save(half_png)
        encode(half_png, out_path=f'{base}{suffix}.half.ktx2', codec=codec, normal_map=is_nrm)
        os.remove(half_png)
        os.remove(png)      # the PNG is an intermediate; art-src keeps the source
        tot_png += a; tot_ktx += b
    print(f'  shipped KTX2: {tot_png/1048576:.2f} -> {tot_ktx/1048576:.2f} MB (+ .half variants)')

    return {
        'name': cfg['name'], 'spanM': cfg['span'], 'texelsPerM': round(SIZE / cfg['span'], 1),
        'use': cfg['use'], 'wrapV': cfg.get('wrap_v', 'repeat'),
        'normalize': {
            'version': NORMALIZE_VERSION, 'sourceType': 'ai', 'surfaceClass': cfg['class'],
            'snapAlpha': AN.SNAP_ALPHA[cfg['snap']], 'normalSource': 'height-derived',
            'tileRatioBefore': round(ratio_before, 3), 'tileRatio': round(ratio, 3),
            'tileVerifyPass': bool(tile_ok), 'tileRepair': how,
            'grainMm': round(float(mm), 2), 'grainBandApplies': False,
            'mottleMm': round(float(mm), 1), 'mottlePlausible': bool(mottle_ok),
            'normalShipped': bool(cfg.get('with_normal')),
            'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
            'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
            'gate4Pass': bool(stats['gate4_pass']),
            'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
        },
        '_pass': bool(tile_ok and stats['gate4_pass'] and n_ok and mottle_ok),
    }


def main(which):
    keys = list(SURFACES) if which in (None, 'all') else [which]
    results = {}
    for k in keys:
        results[k] = build(k, SURFACES[k])
    # One manifest per output directory, merged with anything already there.
    by_dir = {}
    for k in keys:
        by_dir.setdefault(SURFACES[k]['out'], []).append(results[k])
    for d, entries in by_dir.items():
        path = f'{d}/surface_plates.json'
        m = {'surfaces': []}
        if os.path.exists(path):
            try: m = json.load(open(path))
            except Exception: pass
        keep = [s for s in m.get('surfaces', []) if s['name'] not in {e['name'] for e in entries}]
        m['surfaces'] = keep + [{k2: v for k2, v in e.items() if k2 != '_pass'} for e in entries]
        json.dump(m, open(path, 'w'), indent=2)
        print(f'\nwrote {path}')
    failed = [k for k in keys if not results[k]['_pass']]
    if failed:
        print(f'\n⚠ gates FAILED for: {", ".join(failed)} — fix or reject, do not ship (art bible N-5)')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'all'))
