#!/usr/bin/env python3
"""
build-bush-atlas.py — magenta-keyed bush cards -> one albedo atlas + a foliage normal atlas.

All mechanism is shared with the tree atlas (tools/cardAtlas.py): the same spill-based key, the same
alpha bleed, the same art-bible §4.4 normalize, the same packing and contact sheet. Only the asset
decisions live here. See cardAtlas's docstring for why that is shared rather than copied.

WHY BUSHES MATTER NOW. The tree cards made the canopy photographic and left the undergrowth as
3-lobe dodecahedron blobs — and once the hillsides filled with generated woodland, that undergrowth
became the weakest thing on screen. A wooded slope is mostly NOT tree canopy at eye level.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artNormalize as AN
from cardAtlas import build_card_atlas

SRC = 'art-src/bushes-v1/src'
CUT = 'art-src/bushes-v1/cutout'
OUT = 'frontend/public/textures/vegetation'
MANIFEST = 'frontend/src/map/bushAtlas.js'

# 512, not the trees' 1024. A bush is roughly a tenth the screen height of a plane tree at the same
# distance, so a 1024 cell would spend four times the memory on texels no one can resolve. Six cells
# at 512 is a 1536x1024 page against the tree atlas's 3072x2048.
CELL = 512
COLS, ROWS = 3, 2
MARGIN = 8

NORMALIZE_VERSION = 2
SOURCE_TYPE   = 'ai'            # k = 0.35
SURFACE_CLASS = 'foliage_leaf'  # L* 45 / sigma 13, C* 24 — same class as tree canopy
# Single anchor here, unlike the trees: none of these six flower, so nothing needs the cool anchor
# that the jacaranda's violet blossom required.
PALETTE_ANCHOR = AN.ANCHORS['P9_platanus_green']
SNAP_ALPHA    = AN.SNAP_ALPHA['prop']
NORMAL_BAND   = 'foliage'
PLATE_REPAIR  = {}

# name, height_m, width_m, despill, note
SPECIES = [
    ('lentisc',     1.2, 1.4, 1.0, 'Pistacia lentiscus - the defining Collserola scrub'),
    ('rosemary',    1.0, 0.9, 1.0, 'Rosmarinus officinalis - dry hillside and verge'),
    ('kermes_oak',  1.3, 1.6, 1.0, 'Quercus coccifera - spiny hillside scrub'),
    ('pittosporum', 1.1, 1.3, 1.0, 'Pittosporum tobira - the Barcelona street shrub'),
    ('box_hedge',   0.8, 1.2, 1.0, 'Clipped Buxus - formal plaza and garden edging'),
    ('chamaerops',  1.5, 1.5, 1.0, 'Chamaerops humilis - the native Catalan dwarf fan palm'),
]

CFG = dict(
    SRC=SRC, CUT=CUT, OUT=OUT, MANIFEST=MANIFEST, PREFIX='bush_atlas',
    TOOL='tools/build-bush-atlas.py',
    CELL=CELL, COLS=COLS, ROWS=ROWS, MARGIN=MARGIN,
    NORMALIZE_VERSION=NORMALIZE_VERSION, SOURCE_TYPE=SOURCE_TYPE, SURFACE_CLASS=SURFACE_CLASS,
    PALETTE_ANCHOR=PALETTE_ANCHOR, SNAP_ALPHA=SNAP_ALPHA, NORMAL_BAND=NORMAL_BAND,
    PLATE_REPAIR=PLATE_REPAIR, SPECIES=SPECIES,
)

build_card_atlas(CFG)
