#!/usr/bin/env python3
"""
build-tree-atlas.py — magenta-keyed tree cards -> one albedo atlas + a foliage normal atlas.

WHY THE KEY IS NOT A HUE TEST. The obvious way to drop a #FF00FF background is "how far is this
pixel from magenta", and it destroys the jacaranda: violet blossom sits close to magenta in every
naive colour metric, so a hue threshold that clears the background also eats the flowers.

What actually separates them is SPILL, not hue. The background is exactly (1,0,1), so magenta only
ever pushes R and B up while leaving G alone. A pixel is background-contaminated to the extent that
BOTH R and B exceed G — and that quantity is near 1 for the plate and near 0 for jacaranda blossom,
which is blue-violet and carries real green. Weighting by brightness separates them further, and a
hard "plenty of green means foliage" floor protects the rest.

The normal map is the half that makes cards stop looking like paper. Sobel on luminance alone gives
leaf-level crinkle and a flat overall canopy; real foliage reads as a VOLUME because its surface
normals splay outward from the mass. So the normal is a dome pointing away from the canopy centroid,
with the sobel detail layered on top.
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

SRC = 'art-src/trees-v1/src'
CUT = 'art-src/trees-v1/cutout'
OUT = 'frontend/public/textures/vegetation'
CELL = 1024
COLS, ROWS = 3, 2
MARGIN = 12          # px of empty cell edge, so mip levels cannot bleed one tree into its neighbour

# Real-world dimensions. The renderer needs these: a Washingtonia is three times the height of a
# bitter orange, and normalising every card to its cell would render them identical. Heights are
# typical Barcelona street specimens.
SPECIES = [
    # name,             height_m, canopy_m, despill, note
    ('plane_pollarded',  12.0,  9.0, 1.0, 'Platanus x acerifolia, pollarded - the signature Barcelona street tree'),
    ('tipuana',          12.0, 14.0, 1.0, 'Tipuana tipu - broad flat crown, second most common'),
    ('celtis',           12.0, 10.0, 1.0, 'Celtis australis - rounded dome, side streets'),
    ('washingtonia',     15.0,  4.5, 1.0, 'Washingtonia robusta - coast and Passeig'),
    # despill 0: violet blossom is the one real colour here that overlaps the key. It needs no
    # cleaning (2.9% soft edge) and despilling it would wash the flowers toward grey-blue.
    ('jacaranda',        10.0,  8.0, 0.0, 'Jacaranda mimosifolia in flower - seasonal accent'),
    ('orange_bitter',     5.0,  4.5, 1.0, 'Citrus x aurantium - plazas and narrow streets'),
]

def key_magenta(rgb, despill=1.0):
    """RGBA float arrays from an RGB float array. Returns (rgb_despilled, alpha)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    m = np.minimum(r, b)
    # Magenta pushes R and B above G and leaves G alone. Brightness-weighted so a dark violet
    # (low min(r,b)) scores far below the bright plate even at a similar hue.
    spill = np.clip(m - g, 0.0, 1.0) * m
    # ⚠ THE RAMP SITS IN A MEASURED GAP, it is not a guessed threshold. On the jacaranda plate the
    # spill score is 0.951; on its violet blossom the 90th percentile is 0.351. A ramp anywhere
    # between those two numbers separates them cleanly. The first version ramped from 0.55 and cut
    # straight through the blossom — 16% opaque and 21% soft edge, against 1-3% soft edge for every
    # other species. Re-derive these two numbers if the plate colour ever changes.
    KEEP, DROP = 0.42, 0.78
    alpha = np.clip((DROP - spill) / (DROP - KEEP), 0.0, 1.0)
    # ⚠ The floor must EXCLUDE contaminated pixels or it defeats the ramp. A fringe pixel that is
    # half plate and half bright leaf still carries g > 0.30, so an unconditional floor forced it
    # fully opaque — and a pixel that is half background has no business being opaque. That left a
    # rust edge on the tipuana and pink frond tips on the palm even after despill, because despill
    # can only shift colour and this pixel's problem is that it should behalf transparent.
    alpha[(g > 0.30) & (spill < KEEP)] = 1.0   # unambiguous foliage: green, and demonstrably clean
    alpha[(m > 0.80) & (g < 0.16)] = 0.0   # unambiguous plate: bright magenta, no green

    # ⚠ DESPILL CANNOT BE GATED ON ALPHA. The first version only despilled where alpha < 1, and the
    # green species came out visibly pink: their fringe pixels are contaminated but score enough
    # green to be forced fully opaque by the floor above, so they were never cleaned. Contamination
    # is what to test for, not transparency.
    #
    # The test that separates contamination from real colour: magenta raises R and B TOGETHER, so a
    # contaminated pixel has BOTH above G. Brown bark has R above G but B below it, and orange fruit
    # is R-dominant — neither trips it. What DOES trip it is genuinely violet foliage, which is why
    # this is per-species: jacaranda's blossom is the one real colour in the set that lives where the
    # key lives, and it is passed despill=0. It needs none — it keys clean at 2.9% soft edge.
    # ⚠ DESPILL CLAMPS, IT DOES NOT SUBTRACT. Subtracting one shared excess from R and B preserves
    # the gap between them — and magenta contamination arrives with R well above B, so the "fixed"
    # pixel came out RED. That is where the palm's rust-coloured frond spikes came from: they were
    # magenta, despilled into red, and survived every later check because a red pixel has B below G
    # and no longer looks contaminated to any test.
    #
    # G is the channel the key never touches, so it is the reference: pull R and B down TO it.
    # Untouched by construction: brown bark (R above G but B below), orange fruit (R-dominant), and
    # anything passed despill=0.
    both_above = (r > g) & (b > g)
    out = rgb.copy()
    out[..., 0] = np.where(both_above, r * (1 - despill) + np.minimum(r, g) * despill, r)
    out[..., 2] = np.where(both_above, b * (1 - despill) + np.minimum(b, g) * despill, b)
    return out, alpha


def bleed_rgb(rgb, alpha, passes=24):
    """Push opaque colour outward into the transparent region before any resampling.

    ⚠ THIS IS NOT COSMETIC. Transparent pixels still hold whatever RGB they had — here, the magenta
    plate — and every resample blends neighbours WITHOUT regard to alpha. So a LANCZOS downscale
    mixes plate magenta back into the leaves it just keyed out, and the palm grew pink frond tips
    even though the keyed image contained zero opaque pink pixels. The GPU repeats the same mistake
    at every mip level.

    Fixing it means the colour channel must be continuous across the silhouette edge: transparent
    pixels carry a plausible foliage colour rather than background. Alpha still defines the shape;
    the bled colour is never seen directly, only sampled into by filtering.
    """
    valid = alpha > 0.5
    out = rgb.copy()
    out[~valid] = 0.0
    for _ in range(passes):
        if valid.all():
            break
        w = valid.astype(np.float32)
        acc = np.zeros_like(out)
        wacc = np.zeros_like(w)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += np.roll(np.roll(out * w[..., None], dy, 0), dx, 1)
                wacc += np.roll(np.roll(w, dy, 0), dx, 1)
        grow = (~valid) & (wacc > 0)
        out[grow] = (acc[grow] / wacc[grow][..., None])
        valid = valid | grow
    return out

def foliage_normal(rgb, alpha):
    """Dome + sobel detail. See module docstring for why the dome is the important half."""
    lum = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]) * alpha
    h = np.asarray(Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32) / 255.0
    gy, gx = np.gradient(h)
    det = np.stack([-gx * 6.0, gy * 6.0, np.ones_like(h)], -1)

    ys, xs = np.nonzero(alpha > 0.5)
    if len(xs) == 0:
        return np.zeros(rgb.shape, np.float32)
    cx, cy = xs.mean(), ys.mean()
    rad = max(np.ptp(xs), np.ptp(ys)) * 0.5 + 1e-6
    Y, X = np.mgrid[0:alpha.shape[0], 0:alpha.shape[1]].astype(np.float32)
    dx, dy = (X - cx) / rad, (Y - cy) / rad
    d = np.clip(np.hypot(dx, dy), 0, 1)
    dome = np.stack([dx * 0.9, -dy * 0.9, np.sqrt(np.clip(1 - d * d, 0.02, 1))], -1)

    n = dome * 0.62 + det * 0.38
    n /= (np.linalg.norm(n, axis=-1, keepdims=True) + 1e-6)
    return n * 0.5 + 0.5

def main():
    os.makedirs(CUT, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    atlas = Image.new('RGBA', (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
    natlas = Image.new('RGBA', (CELL * COLS, CELL * ROWS), (128, 128, 255, 0))
    manifest = {'cell': CELL, 'cols': COLS, 'rows': ROWS, 'species': []}

    for i, (name, h_m, w_m, despill, note) in enumerate(SPECIES):
        src = Image.open(f'{SRC}/{name}.png').convert('RGB')
        rgb = np.asarray(src, dtype=np.float32) / 255.0
        rgb, alpha = key_magenta(rgb, despill)
        rgb = bleed_rgb(rgb, alpha)     # MUST precede every resample — see bleed_rgb()
        nrm = foliage_normal(rgb, alpha)

        keep = alpha > 0.02
        ys, xs = np.nonzero(keep)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        cw, ch = x1 - x0, y1 - y0
        # Fit the tree inside the cell preserving aspect, then sit it ON the cell floor: the
        # renderer anchors a card at the trunk base, so a consistent floor is what makes six cards
        # of different proportions plant at the same ground line.
        avail = CELL - MARGIN * 2
        s = min(avail / cw, avail / ch)
        nw, nh = max(1, int(cw * s)), max(1, int(ch * s))
        ox, oy = (CELL - nw) // 2, CELL - MARGIN - nh

        def place(arr, canvas, mode):
            im = Image.fromarray((np.dstack([arr, alpha]) * 255).astype(np.uint8), 'RGBA') if mode == 'a' \
                 else Image.fromarray((np.dstack([arr, alpha]) * 255).astype(np.uint8), 'RGBA')
            im = im.crop((x0, y0, x1, y1)).resize((nw, nh), Image.LANCZOS)
            canvas.paste(im, ((i % COLS) * CELL + ox, (i // COLS) * CELL + oy))
            return im

        card = place(rgb, atlas, 'a')
        place(nrm, natlas, 'n')
        card.save(f'{CUT}/{name}.png')

        u0 = ((i % COLS) * CELL) / (CELL * COLS)
        v0 = 1.0 - (((i // COLS) + 1) * CELL) / (CELL * ROWS)
        manifest['species'].append({
            'name': name, 'cell': i, 'note': note,
            'heightM': h_m, 'canopyM': w_m,
            'uv': [round(u0, 6), round(v0, 6), round(1 / COLS, 6), round(1 / ROWS, 6)],
            # Where the trunk meets the ground, as a fraction of the cell. The card is anchored here.
            'trunkBase': [round((ox + nw / 2) / CELL, 4), round((CELL - MARGIN) / CELL, 4)],
            'aspect': round(nw / nh, 4),
        })
        op = float((alpha > 0.98).mean() * 100)
        edge = float(((alpha > 0.02) & (alpha < 0.98)).mean() * 100)
        print(f'  {name:<18} {cw}x{ch} -> {nw}x{nh}  opaque {op:5.2f}%  soft-edge {edge:5.2f}%')

    atlas.save(f'{OUT}/tree_atlas_albedo.png')
    natlas.save(f'{OUT}/tree_atlas_normal.png')
    with open(f'{OUT}/tree_atlas.json', 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'\natlas {atlas.size[0]}x{atlas.size[1]}  ->  {OUT}/')

main()
