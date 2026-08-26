#!/usr/bin/env python3
"""
cardAtlas.py — the shared machinery for magenta-keyed cutout card atlases (trees, bushes, ...).

WHY THIS IS SHARED. Trees and bushes go through an identical pipeline: key the magenta plate, bleed
the RGB under the alpha, run art-bible §4.4 normalize, derive a foliage normal, pack into cells, emit
a manifest and a contact sheet. Copying that into a second tool is how the two quietly diverge — the
key in particular took several rounds to get right (see key_magenta), and only one copy would carry
the fixes. `assembleRings` in the bake taught the same lesson.

The per-asset decisions — which species, what real-world size, which palette anchor — stay in the
calling tool. Only the mechanism lives here.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN


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


def repair_key_contamination(rgb, alpha, band, target_hue, strength, chroma_mul):
    """
    Undo hue contamination left by the magenta key, BEFORE normalize runs.

    This is an ingest repair (STEP 1 territory), not a grading exemption. The jacaranda ships with
    despill=0 because its violet blossom overlaps the key and any despill strong enough to clear
    the plate also eats the flowers — so the blossom keeps a magenta lean it never had. Left in, the
    §4.4 pipeline then faithfully normalizes the WRONG hue: the tree passes gate 4 on the numbers
    and still reads as a hot-pink blob next to five olive-greens, which is precisely the failure the
    contact sheet exists to catch. Real Jacaranda mimosifolia is blue-violet, not pink.

    Rotates only hues inside `band` (degrees, may wrap) toward `target_hue`, and scales their chroma.
    """
    lab = AN.rgb_to_lab(rgb)
    L, C, h = AN.lab_to_lch(lab)
    lo, hi = band
    inb = (h >= lo) | (h <= hi) if lo > hi else (h >= lo) & (h <= hi)
    inb &= alpha > 0.02
    d = (target_hue - h + 180) % 360 - 180
    h2 = np.where(inb, (h + strength * d) % 360, h)
    C2 = np.where(inb, C * chroma_mul, C)
    return AN.lab_to_rgb(AN.lch_to_lab(L, C2, h2))


def build_card_atlas(cfg):
    """Key -> normalize -> normal -> pack -> manifest -> contact sheet. See module docstring."""
    os.makedirs(cfg['CUT'], exist_ok=True)
    os.makedirs(cfg['OUT'], exist_ok=True)
    atlas = Image.new('RGBA', (cfg['CELL'] * cfg['COLS'], cfg['CELL'] * cfg['ROWS']), (0, 0, 0, 0))
    natlas = Image.new('RGBA', (cfg['CELL'] * cfg['COLS'], cfg['CELL'] * cfg['ROWS']), (128, 128, 255, 0))
    manifest = {'cell': cfg['CELL'], 'cols': cfg['COLS'], 'rows': cfg['ROWS'],
                'normalizeVersion': cfg['NORMALIZE_VERSION'], 'species': []}

    for i, (name, h_m, w_m, despill, note) in enumerate(cfg['SPECIES']):
        src = Image.open(f"{cfg['SRC']}/{name}.png").convert('RGB')
        rgb = np.asarray(src, dtype=np.float32) / 255.0
        rgb, alpha = key_magenta(rgb, despill)
        rgb = bleed_rgb(rgb, alpha)     # MUST precede every resample — see bleed_rgb()

        if name in cfg['PLATE_REPAIR']:
            rgb = repair_key_contamination(rgb, alpha, *cfg['PLATE_REPAIR'][name])

        # ── art-bible §4.4 STEPS 2/3/5/6 — NOT optional (rule N-5) ───────────────────────────
        # Without this the plates keep their own baked sun and their own exposure, the scene then
        # lights them a second time, and six differently-graded photos sit in a desaturated
        # low-poly city looking pasted on. This is the step that makes a card belong.
        rgb, stats = AN.normalize_albedo(
            rgb, alpha, source_type=cfg['SOURCE_TYPE'], surface_class=cfg['SURFACE_CLASS'],
            anchor=cfg['PALETTE_ANCHOR'], alpha_snap=cfg['SNAP_ALPHA'])
        rgb = bleed_rgb(rgb, alpha)     # re-bleed: normalize moved the transparent margin too

        # Normal is derived AFTER de-light so it encodes surface shape, not the plate's lighting.
        nrm = foliage_normal(rgb, alpha)
        nrm, n_before, n_after, n_ok = AN.step4_calibrate_normal(nrm, cfg['NORMAL_BAND'])

        keep = alpha > 0.02
        ys, xs = np.nonzero(keep)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        cw, ch = x1 - x0, y1 - y0
        # Fit the tree inside the cell preserving aspect, then sit it ON the cell floor: the
        # renderer anchors a card at the trunk base, so a consistent floor is what makes six cards
        # of different proportions plant at the same ground line.
        avail = cfg['CELL'] - cfg['MARGIN'] * 2
        s = min(avail / cw, avail / ch)
        nw, nh = max(1, int(cw * s)), max(1, int(ch * s))
        ox, oy = (cfg['CELL'] - nw) // 2, cfg['CELL'] - cfg['MARGIN'] - nh

        def place(arr, canvas, mode):
            im = Image.fromarray((np.dstack([arr, alpha]) * 255).astype(np.uint8), 'RGBA') if mode == 'a' \
                 else Image.fromarray((np.dstack([arr, alpha]) * 255).astype(np.uint8), 'RGBA')
            im = im.crop((x0, y0, x1, y1)).resize((nw, nh), Image.LANCZOS)
            canvas.paste(im, ((i % cfg['COLS']) * cfg['CELL'] + ox, (i // cfg['COLS']) * cfg['CELL'] + oy))
            return im

        card = place(rgb, atlas, 'a')
        place(nrm, natlas, 'n')
        card.save(f"{cfg['CUT']}/{name}.png")

        cx0, cy0 = (i % cfg['COLS']) * cfg['CELL'], (i // cfg['COLS']) * cfg['CELL']
        u0 = ((i % cfg['COLS']) * cfg['CELL']) / (cfg['CELL'] * cfg['COLS'])
        v0 = 1.0 - (((i // cfg['COLS']) + 1) * cfg['CELL']) / (cfg['CELL'] * cfg['ROWS'])
        manifest['species'].append({
            'name': name, 'cell': i, 'note': note,
            'heightM': h_m, 'canopyM': w_m,
            'uv': [round(u0, 6), round(v0, 6), round(1 / cfg['COLS'], 6), round(1 / cfg['ROWS'], 6)],
            # Where the trunk meets the ground, as a fraction of the cell. The card is anchored here.
            'trunkBase': [round((ox + nw / 2) / cfg['CELL'], 4), round((cfg['CELL'] - cfg['MARGIN']) / cfg['CELL'], 4)],
            'aspect': round(nw / nh, 4),
            # The OPAQUE sub-rect inside the cell, in atlas UV space. This is what the renderer maps
            # onto a card quad: mapping the whole cell instead would wrap the transparent margin into
            # the quad, so a card sized to heightM would draw a tree visibly shorter than heightM.
            'contentUV': [
                round((cx0 + ox) / (cfg['CELL'] * cfg['COLS']), 6),
                round((cfg['CELL'] * cfg['ROWS'] - (cy0 + oy + nh)) / (cfg['CELL'] * cfg['ROWS']), 6),
                round(nw / (cfg['CELL'] * cfg['COLS']), 6),
                round(nh / (cfg['CELL'] * cfg['ROWS']), 6),
            ],
        })
        manifest['species'][-1]['normalize'] = {
            'version': cfg['NORMALIZE_VERSION'], 'sourceType': cfg['SOURCE_TYPE'], 'k': AN.DELIGHT_K[cfg['SOURCE_TYPE']],
            'surfaceClass': cfg['SURFACE_CLASS'], 'anchor': cfg['PALETTE_ANCHOR'], 'snapAlpha': cfg['SNAP_ALPHA'],
            'LStar': round(stats['L_mean'], 1), 'CStar': round(stats['C_mean'], 1),
            'nearestAnchor': stats['anchor'], 'deltaE2000': round(stats['deltaE'], 2),
            'gate4Pass': bool(stats['gate4_pass']),
            'normalMeanXY': round(float(n_after), 3), 'normalBandPass': bool(n_ok),
            'rallyClipPct': round(stats['rally_clip_pct'], 3),
        }
        op = float((alpha > 0.98).mean() * 100)
        gate = 'OK ' if stats['gate4_pass'] else 'FAIL'
        print(f'  {name:<18} {nw}x{nh}  opaque {op:5.2f}%  '
              f'L* {stats["src_L_mean"]:5.1f}->{stats["L_mean"]:5.1f}  '
              f'C* {stats["src_C_mean"]:5.1f}->{stats["C_mean"]:5.1f}  '
              f'|N.xy| {n_before:.3f}->{n_after:.3f}{"" if n_ok else " cfg['OUT']-OF-BAND"}  '
              f'dE {stats["deltaE"]:5.2f} vs {stats["anchor"]:<20} {gate}  '
              f'rallyclip {stats["rally_clip_pct"]:.2f}%')

    # ── STEP 8 — CONTACT SHEET ────────────────────────────────────────────────────────────────
    # "every library asset rendered at identical fixed lighting on identical geometry, labelled...
    # This sheet is the kitbash detector and no automated check substitutes for it." Six plates that
    # each pass gate 4 individually can still not belong together; only the eye catches that.
    SW, SH = 420, 460
    sheet = Image.new('RGB', (SW * cfg['COLS'], SH * cfg['ROWS']), (128, 128, 128))
    for i, (name, *_rest) in enumerate(cfg['SPECIES']):
        card = Image.open(f"{cfg['CUT']}/{name}.png").convert('RGBA')
        card.thumbnail((SW - 40, SH - 60), Image.LANCZOS)
        cell = Image.new('RGBA', (SW, SH), (128, 128, 128, 255))
        cell.alpha_composite(card, ((SW - card.width) // 2, SH - 40 - card.height))
        d = ImageDraw.Draw(cell)
        st = manifest['species'][i]['normalize']
        d.text((10, SH - 32), f"{name}  L*{st['LStar']} C*{st['CStar']}  dE {st['deltaE2000']}"
                              f" -> {st['nearestAnchor'].split('_',1)[1]}", fill=(255, 255, 255))
        sheet.paste(cell.convert('RGB'), ((i % cfg['COLS']) * SW, (i // cfg['COLS']) * SH))
    sheet.save(f"{cfg['OUT']}/{cfg['PREFIX']}_contact_sheet.png")

    atlas.save(f"{cfg['OUT']}/{cfg['PREFIX']}_albedo.png")
    natlas.save(f"{cfg['OUT']}/{cfg['PREFIX']}_normal.png")
    with open(cfg['MANIFEST'], 'w') as f:
        f.write(f"// GENERATED by {cfg['TOOL']} — do not edit by hand.\n")
        f.write('// Re-run the tool after changing SPECIES or any source plate.\n')
        f.write('export default ' + json.dumps(manifest, indent=2) + ';\n')
    print(f"\natlas {atlas.size[0]}x{atlas.size[1]}  ->  {cfg['OUT']}/")
    print(f"manifest -> {cfg['MANIFEST']}")

