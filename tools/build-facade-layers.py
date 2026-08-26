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
from encodeKtx2 import encode_set, encode_array

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


def plaster_mode(lab, bins=48):
    """
    The dominant RENDER colour, as the LIGHTEST significant cluster in (a*, b*).

    Not simply the largest cluster. "A facade's biggest surface is its plaster" is false exactly
    where it matters: a curtain-wall office is ~40% glazing in continuous bands, and on that plate
    the modal colour IS the glass — measured, it put the source L* at 24.3 and returned a 0.0%
    window mask, i.e. it decided the whole facade was window and the windows were wall.
    
    Render is lighter than glazing on every facade ever built, so among the clusters big enough to
    be a real surface, take the brightest. That holds for the office and for the brick warehouse
    (whose dark steel windows are also enormous) without special-casing either.
    """
    a, b = lab[..., 1].ravel(), lab[..., 2].ravel()
    L = lab[..., 0].ravel()
    Hh, ae, be = np.histogram2d(a, b, bins=bins, range=[[-40, 60], [-40, 70]])
    total = Hh.sum()
    best = None
    for i in range(bins):
        for j in range(bins):
            if Hh[i, j] < total * 0.02:      # too small to be a surface
                continue
            ac, bc = (ae[i] + ae[i + 1]) / 2, (be[j] + be[j + 1]) / 2
            sel = (np.abs(lab[..., 1] - ac) < 6) & (np.abs(lab[..., 2] - bc) < 6)
            if not sel.any():
                continue
            Lc = float(lab[..., 0][sel].mean())
            if best is None or Lc > best[0]:
                best = (Lc, ac, bc)
    if best is None:
        return np.array([float(L.mean()), float(a.mean()), float(b.mean())])
    return np.array(best)
def facade_masks(rgb):
    """
    Two masks, because they answer two different questions.

    NOT-PLASTER — everything that is not the render: glazing, frames, ironwork, stone surrounds.
    This is what the normalize step needs, since the `facade` surface class describes render only.

    WINDOW — glazing alone, for night emissive. Narrower: it must exclude the ironwork and stone that
    not-plaster includes, or balcony railings light up at night.

    The previous version tested "dark and desaturated" and MEASURED ITS OWN FAILURE — two plates came
    back at 0.7% and 0.2% window area, because their glazing sits behind pale curtains and is neither
    dark nor grey. Distance from the plaster's own modal colour does not care how bright the glass
    is; it only cares that it is not the render.
    """
    lab = AN.rgb_to_lab(rgb)
    mode = plaster_mode(lab)

    # Perceptual distance from the render. Chroma difference is weighted above lightness because
    # plaster varies a lot in L* (weathering, streaking) and very little in hue.
    dL = (lab[..., 0] - mode[0]) / 26.0
    da = (lab[..., 1] - mode[1]) / 9.0
    db = (lab[..., 2] - mode[2]) / 9.0
    dist = np.sqrt(dL * dL + da * da + db * db)
    not_plaster = np.clip((dist - 0.85) / 0.9, 0.0, 1.0)

    # Windows are FILLED regions; railings and mouldings are thin. A median filter keeps the first
    # and erases the second, which is the whole difference between the two masks.
    def clean(m, k):
        return np.asarray(Image.fromarray((m * 255).astype(np.uint8), 'L')
                          .filter(ImageFilter.MedianFilter(k)), dtype=np.float64) / 255.0

    not_plaster = clean(not_plaster, 5)
    # ── WINDOW: three independent signals, because no one of them survives all eight plates ──
    # Checked visually and each was added against a specific observed failure:
    #
    #  DARK, with a real margin. "Darker than plaster" alone flagged the old-town facade's exposed
    #  STONE as window, because its plaster is near-white and the stone is merely mid-tone.
    darker = np.clip((mode[0] - lab[..., 0] - 8.0) / 26.0, 0.0, 1.0)
    #
    #  NOT WARMER than the render. Stone, mortar and terracotta all sit on the warm side of the
    #  plaster they abut; glazing is neutral or cool. This is what separates glass from masonry when
    #  both are darker than the wall.
    cool = np.clip(1.0 - (lab[..., 2] - mode[2]) / 26.0, 0.0, 1.0)
    #
    #  FILLED, not linear. Mortar joints are darker and roughly neutral too, and on the brick
    #  warehouse they lit up the entire wall. A window is centimetres of glass across; a mortar joint
    #  is one. A wide median keeps the first and erases the second.
    window = clean(not_plaster * darker * cool, 9)
    window = clean(window, 15)
    return not_plaster, window
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

        not_plaster, window = facade_masks(rgb)
        mask = window

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
        plaster = 1.0 - not_plaster
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
        # Alpha carries the WINDOW mask (night emissive), not not-plaster — ironwork must not glow.
        rgba = np.concatenate([rgb, window[..., None]], axis=-1)
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
                'windowFrac': round(float((window > 0.5).mean() * 100), 1),
                'notPlasterFrac': round(float((not_plaster > 0.5).mean() * 100), 1),
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

    # ── STEP 7 — ENCODE ───────────────────────────────────────────────────────────────────────
    # UASTC for both, not ETC1S. The albedo's ALPHA CARRIES THE WINDOW MASK, and ETC1S quantises to a
    # small palette — it bands a mask's edges, which on a facade means ragged glazing at night. And a
    # banded normal map reads as facets. ETC1S is right for opaque photographic colour and wrong for
    # both of these, so the extra ~2x of UASTC is bought deliberately.
    # ── V-FLIP BEFORE ENCODING ────────────────────────────────────────────────────────────────
    # PNG is top-down, KTX2 is bottom-up, and three CANNOT apply `flipY` to a compressed texture —
    # there is no way to flip block-compressed data on upload, so the flag is ignored. The result was
    # facades rendering upside down: balconies and sills sitting ABOVE their windows.
    #
    # Flipped here rather than in the shader so the shipped artefact is correct by construction. A
    # shader flip would work and would leave a trap: the .ktx2 and the .png would disagree, and the
    # next thing to load the PNG directly would be wrong in the opposite direction.
    print('\n  encoding KTX2 ARRAYS (UASTC -> BC7, 1 byte/texel against RGBA8 4):')
    names = [n for n, *_r in LAYERS]
    flip_dir = f'{OUT}/.flipped'
    os.makedirs(flip_dir, exist_ok=True)
    for n in names:
        for kind in ('albedo', 'normal'):
            im = Image.open(f'{OUT}/{n}_{kind}.png')
            im.transpose(Image.FLIP_TOP_BOTTOM).save(f'{flip_dir}/{n}_{kind}.png')
    for kind, is_nrm in (('albedo', False), ('normal', True)):
        out, sz = encode_array([f'{flip_dir}/{n}_{kind}.png' for n in names],
                               f'{OUT}/facade_body_{kind}.ktx2', codec='uastc', normal_map=is_nrm)
        print(f'    {os.path.basename(out):32s} {sz/1048576:5.2f} MB   ({len(names)} layers)')
    manifest['arrays'] = {'albedo': 'facade_body_albedo.ktx2', 'normal': 'facade_body_normal.ktx2',
                          'layerOrder': names}

    n = len(LAYERS)
    rgba = n * SIZE * SIZE * 4 * 2 * 1.333 / 1048576      # albedo + normal, mipped
    bc7  = n * SIZE * SIZE * 1 * 2 * 1.333 / 1048576
    print(f'\n  VRAM: {rgba:.0f} MiB uncompressed -> {bc7:.0f} MiB as BC7  (this is the number that matters;')
    print(f'        the PNG-vs-KTX2 file sizes above understate it, because PNG is already compressed)')
    manifest['vram'] = {'uncompressedMiB': round(rgba, 1), 'bc7MiB': round(bc7, 1)}

    with open(MANIFEST, 'w') as f:
        f.write('// GENERATED by tools/build-facade-layers.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')
    print(f'\n-> {OUT}/  ·  {SIZE}^2 at {SIZE / LAYER_W_M:.0f} texels/m  ·  manifest {MANIFEST}')


main()
