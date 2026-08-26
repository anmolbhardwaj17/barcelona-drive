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
from PIL import Image, ImageFilter, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN
# The keying / bleed / normal / packing machinery is SHARED with build-bush-atlas.py — see cardAtlas.
from cardAtlas import build_card_atlas

SRC = 'art-src/trees-v1/src'
CUT = 'art-src/trees-v1/cutout'
OUT = 'frontend/public/textures/vegetation'
# The two atlases are runtime-loaded assets and live in public/. The manifest is NOT an asset: the
# renderer imports it as a module so card geometry can be built synchronously (see treeCards.js).
# It is emitted as JS rather than JSON because the test runner is bare `node --test`, where a JSON
# import needs an import attribute that Vite treats differently — a plain ES module behaves
# identically under both, which is what keeps the tests testing the code the browser runs.
MANIFEST = 'frontend/src/map/treeAtlas.js'
CELL = 1024
COLS, ROWS = 3, 2
MARGIN = 12          # px of empty cell edge, so mip levels cannot bleed one tree into its neighbour

# ── art-bible §4.4 normalize configuration for this asset ─────────────────────────────────────
# The plates are AI-generated (k=0.35), the dominant surface is foliage leaf, and the anchor is P9
# Platanus Green — "dusty olive, never emerald, never lime". alpha=0.35 is the props/foliage snap.
#
# The whole card is normalized as ONE class rather than segmenting bark from leaf. Segmenting by
# colour is exactly wrong here: the jacaranda's violet blossom and the tipuana's gold both read as
# "not green", so a hue-based leaf/bark split would route the very foliage that most needs the
# olive snap into the bark class instead. Foliage is the dominant opaque area; treating the card as
# one surface also keeps it internally consistent, which is what stops it reading as a collage.
# No plate repairs are needed: the jacaranda's blossom measures hue 300-330 straight out of the
# key — genuine violet. The pink it briefly rendered as was a bug in step5's single-anchor snap,
# fixed in artNormalize (see step5_palette_snap).
PLATE_REPAIR = {}

NORMALIZE_VERSION = 2
SOURCE_TYPE   = 'ai'
SURFACE_CLASS = 'foliage_leaf'
# Two anchors are allowed for foliage cards, and each pixel snaps toward whichever it is nearer.
# P9 is the foliage anchor and carries all five green species. The second used to be P10 mediterrani
# blue, admitted purely because it was the only COOL anchor in the ten and a violet-flowering street
# tree had no green-anchor-legal representation — forcing it at P9 rotates it through red into pink.
# That was a workaround for a hole in the palette, and it left the jacaranda at gate-4 dE 17.01.
#
# P11 jacaranda violet (added to §4.1 on 2026-08-27, restricted to foliage) closes the hole properly,
# so the P10-for-foliage amendment is WITHDRAWN: §4.1 assigns P10 to water/haze and foliage no longer
# needs to borrow it. Snapping now moves the blossom toward violet, which is where it already was.
PALETTE_ANCHOR = [AN.ANCHORS['P9_platanus_green'], AN.ANCHORS['P11_jacaranda_violet']]
SNAP_ALPHA    = AN.SNAP_ALPHA['prop']
NORMAL_BAND   = 'foliage'

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

CFG = dict(
    SRC=SRC, CUT=CUT, OUT=OUT, MANIFEST=MANIFEST, PREFIX='tree_atlas',
    TOOL='tools/build-tree-atlas.py',
    CELL=CELL, COLS=COLS, ROWS=ROWS, MARGIN=MARGIN,
    NORMALIZE_VERSION=NORMALIZE_VERSION, SOURCE_TYPE=SOURCE_TYPE, SURFACE_CLASS=SURFACE_CLASS,
    PALETTE_ANCHOR=PALETTE_ANCHOR, SNAP_ALPHA=SNAP_ALPHA, NORMAL_BAND=NORMAL_BAND,
    PLATE_REPAIR=PLATE_REPAIR, SPECIES=SPECIES,
)

build_card_atlas(CFG)
