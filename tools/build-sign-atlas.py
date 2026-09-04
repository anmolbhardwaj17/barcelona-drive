#!/usr/bin/env python3
"""
build-sign-atlas.py — one KTX2 atlas for every sign FACE in the city. v3 P4-11.

Run:  python3 tools/build-sign-atlas.py

── WHY THIS IS A TOOL AND NOT A RUNTIME CANVAS ────────────────────────────────────────────────
Today every sign face is drawn with `document.createElement('canvas')` at load and kept in a Map
that never evicts. Measured on the shipped tiles: 1.00 MB per distinct street name for direction
boards, 0.50 MB per gantry, against 2,427 distinct names in the region and a 200 MiB budget for all
textures. Drawing them once, offline, into one shared page removes both the per-name cost and the
per-sign draw call.

── TWO DELIBERATE DEPARTURES FROM THE P4-11 TICKET ────────────────────────────────────────────
1. **Python in tools/, not `scripts/build-sign-atlas.mjs`.** The ticket predates this repo's art
   pipeline. Every other atlas — trees, bushes, roofs, facades, shopfronts, surfaces — is a Python
   tool in tools/ that ends in `encodeKtx2.encode()`. Matching six working tools beats matching a
   filename in a plan.

2. **UASTC, not "ETC1S + alpha".** `tools/encodeKtx2.py` states the rule and it contradicts the
   ticket: *"UASTC — anything with an ALPHA channel that carries DATA … ETC1S quantises to a small
   palette, which is fine for photographic colour and wrong for a mask (it bands the edges)."* A
   sign is a hard-edged shape on transparency, which is exactly that case. ETC1S would fringe every
   sign border. The cost is ~4:1 instead of ~6:1 on a 2048² page — under a megabyte of difference,
   for edges that are the whole point of a sign.

── WHAT IS AND IS NOT IN HERE ─────────────────────────────────────────────────────────────────
Faces only: shapes, borders, pictograms, the blank retroreflective plate. **Street NAMES are not
here** — 2,427 of them cannot be baked into 64 cells, which is exactly why `signage/textAtlas.js`
exists as a separate bounded page. This atlas is what a sign IS; the text page is what it SAYS.
"""
import json, math, os, sys
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from encodeKtx2 import encode

OUT_DIR  = 'frontend/public/textures/signage'
PNG      = os.path.join(OUT_DIR, 'sign_atlas_albedo.png')
KTX2     = os.path.join(OUT_DIR, 'sign_atlas_albedo.ktx2')
# Emitted as a JS module rather than JSON for the same reason treeAtlas.js is: the test runner is
# bare `node --test`, where a JSON import needs an import attribute that Vite treats differently.
MANIFEST = 'frontend/src/map/signage/signAtlasCells.js'

CELL   = 256
# 8x4 = 32 cells at 2048x1024. Sized to the CONTENT, not to a round number: 18 cells are used today
# and P4-12/P4-13 add roughly six more (tobacconist T, ONCE kiosk, hotel, parking P, traffic-light
# faces), so this leaves real headroom without paying for it. A 2048-square page would have been 64
# cells, 72% of them empty, and UASTC is FIXED-RATE — empty cells cost exactly as much VRAM as full
# ones. That is 2.9 MB of nothing, on the one budget in this project with no headroom to borrow from.
COLS   = 8
ROWS   = 4
MARGIN = 10                     # px of empty cell edge so mips cannot bleed one sign into the next

# Barcelona / Spanish señalización palette. Pre-graded per the art bible — these are the on-screen
# values, not sRGB swatches from a spec sheet.
WHITE   = (238, 238, 234, 255)  # retroreflective panel white, never pure #fff
INK     = (28, 28, 30, 255)     # near-black charcoal; Spanish signs use black on white
RED     = (178, 34, 38, 255)
BLUE    = (26, 62, 122, 255)
GREEN   = (22, 122, 68, 255)    # pharmacy cross
YELLOW  = (232, 178, 30, 255)


def _disc(d, cx, cy, r, fill):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def regulatory_ring(img, colour=RED):
    """Circular white plate with a coloured ring — the base for every speed/prohibition sign."""
    d = ImageDraw.Draw(img)
    c = CELL / 2
    r = CELL / 2 - MARGIN
    _disc(d, c, c, r, colour)
    _disc(d, c, c, r * 0.78, WHITE)


def speed_plate(img, speed):
    regulatory_ring(img)
    d = ImageDraw.Draw(img)
    # Digits as blocks rather than a font: a font would have to ship with the tool and match across
    # machines, and a speed plate is 3 glyphs. Drawn from a 7-segment description so 20..120 all work.
    _digits(d, str(speed), CELL / 2, CELL / 2, CELL * 0.30)


_SEG = {  # 7-segment: top, tl, tr, mid, bl, br, bottom
    '0': 0b1110111, '1': 0b0010010, '2': 0b1011101, '3': 0b1011011, '4': 0b0111010,
    '5': 0b1101011, '6': 0b1101111, '7': 0b1010010, '8': 0b1111111, '9': 0b1111011,
}


def _digits(d, text, cx, cy, h):
    w = h * 0.56
    gap = w * 0.22
    total = len(text) * w + (len(text) - 1) * gap
    x = cx - total / 2
    for ch in text:
        _seg_digit(d, x, cy - h / 2, w, h, _SEG.get(ch, 0))
        x += w + gap


def _seg_digit(d, x, y, w, h, mask):
    t = max(2, int(w * 0.20))                      # stroke thickness
    segs = [
        (mask >> 6 & 1, [x, y, x + w, y + t]),                       # top
        (mask >> 5 & 1, [x, y, x + t, y + h / 2]),                   # top-left
        (mask >> 4 & 1, [x + w - t, y, x + w, y + h / 2]),           # top-right
        (mask >> 3 & 1, [x, y + h / 2 - t / 2, x + w, y + h / 2 + t / 2]),   # middle
        (mask >> 2 & 1, [x, y + h / 2, x + t, y + h]),               # bottom-left
        (mask >> 1 & 1, [x + w - t, y + h / 2, x + w, y + h]),       # bottom-right
        (mask >> 0 & 1, [x, y + h - t, x + w, y + h]),               # bottom
    ]
    for on, box in segs:
        if on:
            d.rectangle(box, fill=INK)


def arrow(img, kind):
    """Lane pictogram, white on transparent — painted ON the road, so no plate behind it."""
    d = ImageDraw.Draw(img)
    cx = CELL / 2
    shaft_w = CELL * 0.16
    head_w = CELL * 0.40
    top, bot = MARGIN + CELL * 0.06, CELL - MARGIN
    if kind in ('straight', 'straight_left', 'straight_right'):
        d.rectangle([cx - shaft_w / 2, top + head_w * 0.55, cx + shaft_w / 2, bot], fill=WHITE)
        d.polygon([(cx, top), (cx - head_w / 2, top + head_w * 0.62),
                   (cx + head_w / 2, top + head_w * 0.62)], fill=WHITE)
    if kind in ('left', 'straight_left', 'uturn'):
        _side_arrow(d, cx, -1, shaft_w, head_w, bot)
    if kind in ('right', 'straight_right'):
        _side_arrow(d, cx, 1, shaft_w, head_w, bot)


def _side_arrow(d, cx, sign, shaft_w, head_w, bot):
    y = bot - shaft_w * 2.2
    tip = cx + sign * (CELL / 2 - MARGIN)
    d.rectangle([cx - shaft_w / 2, y, cx + shaft_w / 2, bot], fill=WHITE)
    x0 = min(cx, tip - sign * head_w * 0.62)
    x1 = max(cx, tip - sign * head_w * 0.62)
    d.rectangle([x0, y - shaft_w / 2, x1, y + shaft_w / 2], fill=WHITE)
    d.polygon([(tip, y), (tip - sign * head_w * 0.62, y - head_w / 2),
               (tip - sign * head_w * 0.62, y + head_w / 2)], fill=WHITE)


def plate(img, colour=WHITE, border=INK):
    """The blank retroreflective panel a street name is drawn onto by the TEXT PAGE."""
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([MARGIN, MARGIN, CELL - MARGIN, CELL - MARGIN],
                        radius=CELL * 0.06, fill=colour, outline=border, width=max(3, CELL // 42))


def pharmacy_cross(img):
    """P4-13's highest-value night cell: an illuminated green cross, on every other Barcelona block."""
    d = ImageDraw.Draw(img)
    c, arm, th = CELL / 2, CELL / 2 - MARGIN, CELL * 0.26
    d.rectangle([c - th / 2, c - arm, c + th / 2, c + arm], fill=GREEN)
    d.rectangle([c - arm, c - th / 2, c + arm, c + th / 2], fill=GREEN)


def metro_roundel(img):
    d = ImageDraw.Draw(img)
    c, r = CELL / 2, CELL / 2 - MARGIN
    _disc(d, c, c, r, RED)
    _disc(d, c, c, r * 0.80, WHITE)
    # An 'M' from four bars — same reasoning as the digits: no font dependency.
    t = CELL * 0.085
    h = CELL * 0.34
    d.polygon([(c - h * 0.72, c + h / 2), (c - h * 0.72 + t, c + h / 2),
               (c - h * 0.72 + t, c - h / 2), (c - h * 0.72, c - h / 2)], fill=RED)
    d.polygon([(c + h * 0.72 - t, c + h / 2), (c + h * 0.72, c + h / 2),
               (c + h * 0.72, c - h / 2), (c + h * 0.72 - t, c - h / 2)], fill=RED)
    d.polygon([(c - h * 0.72, c - h / 2), (c, c + h * 0.10), (c - t * 1.4, c - h / 2)], fill=RED)
    d.polygon([(c + h * 0.72, c - h / 2), (c, c + h * 0.10), (c + t * 1.4, c - h / 2)], fill=RED)


def stop_sign(img):
    d = ImageDraw.Draw(img)
    c, r = CELL / 2, CELL / 2 - MARGIN
    pts = [(c + r * math.cos(math.pi / 8 + i * math.pi / 4),
            c + r * math.sin(math.pi / 8 + i * math.pi / 4)) for i in range(8)]
    d.polygon(pts, fill=RED)
    d.polygon([(x * 0.86 + c * 0.14, y * 0.86 + c * 0.14) for x, y in pts], outline=WHITE,
              width=max(3, CELL // 52))


def yield_sign(img):
    """Ceda el paso — inverted triangle, red border on white."""
    d = ImageDraw.Draw(img)
    c, r = CELL / 2, CELL / 2 - MARGIN
    outer = [(c, c + r), (c - r * 0.94, c - r * 0.58), (c + r * 0.94, c - r * 0.58)]
    d.polygon(outer, fill=RED)
    k = 0.72
    d.polygon([(c + (x - c) * k, c + (y - c) * k) for x, y in outer], fill=WHITE)


def no_entry(img):
    d = ImageDraw.Draw(img)
    c, r = CELL / 2, CELL / 2 - MARGIN
    _disc(d, c, c, r, RED)
    d.rectangle([c - r * 0.62, c - r * 0.17, c + r * 0.62, c + r * 0.17], fill=WHITE)


# name → (painter, note). ORDER IS THE CELL ORDER and it is part of the manifest, so appending is
# safe and reordering is not.
CELLS = [
    ('plate_white',    lambda im: plate(im),                    'blank retroreflective panel — the text page draws the street name onto this'),
    ('plate_blue',     lambda im: plate(im, BLUE, WHITE),       'blue urban direction panel'),
    ('speed_20',       lambda im: speed_plate(im, 20),          'zona 30 side streets and school zones'),
    ('speed_30',       lambda im: speed_plate(im, 30),          'the Barcelona default — most of the city'),
    ('speed_40',       lambda im: speed_plate(im, 40),          ''),
    ('speed_50',       lambda im: speed_plate(im, 50),          'primary/secondary in town'),
    ('speed_60',       lambda im: speed_plate(im, 60),          ''),
    ('speed_80',       lambda im: speed_plate(im, 80),          'ronda / autovia'),
    ('stop',           stop_sign,                               ''),
    ('yield',          yield_sign,                              'ceda el paso'),
    ('no_entry',       no_entry,                                'direccion prohibida'),
    ('arrow_straight',       lambda im: arrow(im, 'straight'),       'lane pictogram, painted on asphalt'),
    ('arrow_left',           lambda im: arrow(im, 'left'),           ''),
    ('arrow_right',          lambda im: arrow(im, 'right'),          ''),
    ('arrow_straight_left',  lambda im: arrow(im, 'straight_left'),  ''),
    ('arrow_straight_right', lambda im: arrow(im, 'straight_right'), ''),
    ('pharmacy_cross', pharmacy_cross,                          'P4-13 night set — emissive'),
    ('metro_roundel',  metro_roundel,                           'P4-13 night set — emissive'),
]


def main():
    if len(CELLS) > COLS * ROWS:
        raise SystemExit(f'{len(CELLS)} cells will not fit in {COLS}x{ROWS}')
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)

    page = Image.new('RGBA', (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    entries = []
    for i, (name, paint, note) in enumerate(CELLS):
        cell = Image.new('RGBA', (CELL, CELL), (0, 0, 0, 0))
        paint(cell)
        cx, cy = (i % COLS) * CELL, (i // COLS) * CELL
        page.paste(cell, (cx, cy))
        entries.append({
            'name': name, 'cell': i, 'note': note,
            # u0,v0,u1,v1 with V measured from the BOTTOM, because that is what a GL sampler wants and
            # converting at every call site is how a flipped atlas ships.
            'uv': [cx / page.width, 1 - (cy + CELL) / page.height,
                   (cx + CELL) / page.width, 1 - cy / page.height],
        })

    page.save(PNG)
    out, src_b, out_b = encode(PNG, KTX2, codec='uastc', mipmaps=True)
    print(f'  {len(CELLS)} cells -> {page.width}x{page.height}')
    print(f'  PNG  {src_b/1048576:.2f} MB -> KTX2 {out_b/1048576:.2f} MB  ({src_b/out_b:.1f}:1, UASTC)')

    # ── THE .half VARIANT IS NOT OPTIONAL ────────────────────────────────────────────────────────
    # `QUALITY.textureVariant === 'half'` on the LOW tier requests `<name>.half.ktx2`. For a long
    # time nothing emitted those and low-tier devices simply 404'd, so `ktx2Library.test.js` now
    # asserts every KTX2 has one — and it caught this atlas within a minute of it existing, which is
    # the test doing exactly its job.
    half_png = PNG.replace('.png', '.half.png')
    page.resize((page.width // 2, page.height // 2), Image.LANCZOS).save(half_png)
    _, _, half_b = encode(half_png, KTX2.replace('.ktx2', '.half.ktx2'), codec='uastc', mipmaps=True)
    os.remove(half_png)
    print(f'  half {page.width//2}x{page.height//2} -> {half_b/1048576:.2f} MB')

    with open(MANIFEST, 'w') as f:
        f.write('// GENERATED by tools/build-sign-atlas.py — do not edit by hand.\n')
        f.write('// Cell ORDER is part of the contract: appending is safe, reordering is not.\n')
        f.write('export default ' + json.dumps(
            {'cell': CELL, 'cols': COLS, 'rows': ROWS,
             'texture': '/textures/signage/sign_atlas_albedo.ktx2', 'cells': entries},
            indent=2) + ';\n')
    print(f'  manifest -> {MANIFEST}')


if __name__ == '__main__':
    main()
