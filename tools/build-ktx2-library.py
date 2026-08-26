#!/usr/bin/env python3
"""
build-ktx2-library.py — encode the world-texture library to KTX2 (v3 P3-GATE-01).

WHY. P3's exit gate caps resident texture VRAM at 200 MiB. Only the facade arrays were ever
encoded; everything else still shipped as PNG/JPG and decoded to full RGBA8 on upload. Measured
2026-08-27: 153.3 MiB of live PNG, which with the facades and render targets put the scene at
roughly 242 MiB — over the cap with no margin to borrow from.

TWO THINGS THIS TOOL GETS RIGHT THAT A PLAIN `basisu` CALL DOES NOT:

1. FLIP AT ENCODE TIME. `TextureLoader` applies flipY=true to a PNG, so every UV in the codebase is
   authored against a vertically flipped image. WebGL IGNORES UNPACK_FLIP_Y_WEBGL for compressed
   textures, so a KTX2 encoded from the same PNG arrives upside down and no sampler setting can fix
   it. We flip the source before encoding, which reproduces the old orientation exactly and means
   NO UV or atlas-layout changes anywhere. (This is the bug that shipped the facades upside down.)

2. CODEC BY WHAT THE CHANNEL MEANS, not by file type — see tools/encodeKtx2.py. UASTC for alpha
   that carries data (a card cutout, a cloud mask) and for every normal map; ETC1S for opaque
   photographic colour, where ~6:1 beats UASTC's ~4:1 and its artefacts hide in the detail.

Also emits the `.half` variant that QUALITY.textureVariant expects on the LOW tier. Nothing ever
emitted those, so LOW-tier devices were requesting `name.half.ktx2` and getting a 404.
"""
import os, sys, subprocess
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(__file__))
from encodeKtx2 import encode

ROOT = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'public', 'textures')
TMP  = os.environ.get('TMPDIR', '/tmp')

# (relative path, codec, is_normal_map, why)
LIBRARY = [
    ('vegetation/tree_atlas_albedo.png',  'uastc', False, 'alpha IS the card cutout — ETC1S bands the edge'),
    ('vegetation/tree_atlas_normal.png',  'uastc', True,  'normal'),
    ('vegetation/bush_atlas_albedo.png',  'uastc', False, 'alpha IS the card cutout'),
    ('vegetation/bush_atlas_normal.png',  'uastc', True,  'normal'),
    ('vegetation/rock_atlas_albedo.png',  'etc1s', False, 'opaque (no alpha channel — rocks are not cut cards)'),
    ('vegetation/rock_atlas_normal.png',  'uastc', True,  'normal'),
    ('road/asphalt_fresh_albedo.png',     'etc1s', False, 'opaque photographic'),
    ('road/asphalt_fresh_normal.png',     'uastc', True,  'normal'),
    ('road/asphalt_worn_albedo.png',      'etc1s', False, 'opaque photographic'),
    ('road/asphalt_worn_normal.png',      'uastc', True,  'normal'),
    ('road/panot_albedo.png',             'etc1s', False, 'opaque photographic'),
    ('road/panot_normal.png',             'uastc', True,  'normal'),
    ('road/kerb_granite_albedo.png',      'etc1s', False, 'opaque photographic'),
    ('road/kerb_granite_normal.png',      'uastc', True,  'normal'),
    ('sky/sky_clouds_day.png',            'uastc', False, 'alpha is the cloud MASK — banding is visible on sky'),
    ('sky/sky_clouds_night.png',          'uastc', False, 'alpha is the cloud MASK'),
    ('railway/railway_01.png',            'etc1s', False, 'opaque'),
    ('wall/wall_01.jpg',                  'etc1s', False, 'opaque'),
]

BPT = {'uastc': 1.0, 'etc1s': 0.5}   # bytes/texel after transcode (BC7 / BC1)


def prep(src, dst, half=False):
    """Flip vertically (see note 1) and optionally halve. Returns (w, h)."""
    im = Image.open(src)
    im = im.convert('RGBA' if 'A' in im.getbands() or im.mode == 'P' and 'transparency' in im.info else 'RGB')
    if half:
        im = im.resize((max(4, im.width // 2), max(4, im.height // 2)), Image.LANCZOS)
    ImageOps.flip(im).save(dst)
    return im.size


def main():
    png_total = ktx_total = 0
    vram_before = vram_after = 0
    print(f'{"asset":42s} {"disk":>16s}  {"VRAM":>16s}')
    for rel, codec, is_nrm, _why in LIBRARY:
        src = os.path.join(ROOT, rel)
        if not os.path.exists(src):
            print(f'  MISSING {rel}'); continue
        out = os.path.splitext(src)[0] + '.ktx2'

        tmp = os.path.join(TMP, 'ktx_' + os.path.basename(rel).replace('.jpg', '.png'))
        w, h = prep(src, tmp)
        _, _, ktx_bytes = encode(tmp, out, codec=codec, normal_map=is_nrm)
        png_bytes = os.path.getsize(src)

        # half variant for QUALITY.textureVariant === 'half' (LOW tier)
        tmp_h = tmp.replace('.png', '.half.png')
        prep(src, tmp_h, half=True)
        out_h = out.replace('.ktx2', '.half.ktx2')
        encode(tmp_h, out_h, codec=codec, normal_map=is_nrm)

        vb = w * h * 4 * 1.333 / 1048576
        va = w * h * BPT[codec] * 1.333 / 1048576
        png_total += png_bytes; ktx_total += ktx_bytes
        vram_before += vb; vram_after += va
        print(f'  {rel:40s} {png_bytes/1048576:6.1f}->{ktx_bytes/1048576:5.1f} MB  '
              f'{vb:6.1f}->{va:5.1f} MiB  {codec}')
        os.remove(tmp); os.remove(tmp_h)

    print(f'\n  {"TOTAL":40s} {png_total/1048576:6.1f}->{ktx_total/1048576:5.1f} MB  '
          f'{vram_before:6.1f}->{vram_after:5.1f} MiB')
    print(f'  VRAM saved: {vram_before - vram_after:.1f} MiB  ({vram_before/max(vram_after,.01):.1f}:1)')


if __name__ == '__main__':
    main()
