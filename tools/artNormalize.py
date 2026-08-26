#!/usr/bin/env python3
"""
artNormalize.py — the v3 art-bible §4.4 normalization procedure, colour + normal steps.

WHY THIS FILE EXISTS. Art-bible rule N-5: "Every asset passes normalize, no exceptions, including
'it already looked fine.'" The tree-card atlas was first shipped WITHOUT it, and the result was the
exact failure §4.4 predicts — six plates each carrying their own baked sun and their own exposure,
dropped into a scene that then lights them again. They read as stickers.

RELATIONSHIP TO BLK-2. The bible specifies this as `scripts/build-art.mjs`, one committed
implementation for the whole library ("No domain runs its own version"). That artefact does not
exist yet and building it is a separate job. This module is deliberately a SHARED one — importable
by any asset tool — rather than a copy pasted into the tree pipeline, so that when build-art.mjs
lands there is one procedure to port and not several that have already drifted.

Implements: STEP 2 de-light · STEP 3 Lab L*/C* rescale · STEP 4 normal calibration ·
STEP 5 palette snap · STEP 6 pre-grade compensation · the ΔE2000 gate-4 assertion.
STEP 0/1/7/8 (ingest, tile verify, encode, manifest) stay with the calling tool.
"""
import numpy as np
from PIL import Image, ImageFilter

# ── §4.1 the ten world anchors ────────────────────────────────────────────────────────────────
ANCHORS = {
    'P1_eixample_cream':   '#E7DECB', 'P2_ochre_sand':      '#D3C5A8',
    'P3_modernisme_rose':  '#C89A78', 'P4_teula_clay':      '#A76A5C',
    'P5_poblenou_brick':   '#9E5A3E', 'P6_panot_grey':      '#B4B0A6',
    'P7_bordillo_granite': '#7C7A76', 'P8_carriageway_grey':'#4F4E4C',
    'P9_platanus_green':   '#6E7A55', 'P10_mediterrani_blue':'#2F5C77',
    # P11 — jacaranda violet. AMENDMENT to §4.1, 2026-08-27.
    #
    # The other ten anchors sit at hues 38, 48, 62, 89, 90, 90, 91, 94, 121 and 251 degrees, because
    # §4.1 was derived from Barcelona's BUILT environment: stone, stucco, clay tile, sea. That leaves
    # a 147-degree hole exactly where violet lives, and a jacaranda in flower (hue ~305) has no legal
    # representation in it — its nearest anchor was P7 bordillo granite, a neutral GREY, at dE 21.
    # Gate 4 was therefore reporting a hole in the PALETTE as a defect in the ASSET.
    #
    # The alternatives were worse. Widening the threshold to 18 weakens the gate for every asset to
    # accommodate one. Desaturating the blossom until it passes makes a jacaranda not a jacaranda,
    # which is the same mistake that bleached the shopfront plates to the `facade` class.
    #
    # It is a real Barcelona colour: the city's jacarandas flower across May and June.
    # 21.1 dE from its nearest existing anchor, so it is a new anchor and not a near-duplicate.
    'P11_jacaranda_violet': '#8E7FAB',
}

# Anchors admissible ONLY for specific surface classes. Without this, adding a violet anchor to the
# global set would let ANY asset claim it — a violet facade would pass gate 4 on P11. The restriction
# is the reason the amendment is safe.
RESTRICTED_ANCHORS = {'P11_jacaranda_violet': {'foliage_leaf'}}

# ── §4.4 STEP 3 surface-class targets (pre-grade) ─────────────────────────────────────────────
CLASS_TARGETS = {           # L* mean, L* sigma, C* mean
    'asphalt':        (38,  8,  4), 'sidewalk':   (62,  9,  6), 'kerb':      (51, 10,  5),
    'facade':         (74, 10, 14), 'brick':      (45, 11, 26), 'roof_clay': (48, 10, 28),
    'roof_terrat':    (58,  9,  8), 'terrain_grass': (47, 12, 20),
    'terrain_dirt':   (63, 10, 18), 'rock':       (55, 13,  8), 'metal':     (58, 14,  3),
    'foliage_leaf':   (45, 13, 24), 'bark':       (42, 12, 12), 'fabric':    (60, 15, 30),
    'water':          (36,  7, 16),
}

# ── §4.4 STEP 2 de-light coefficients, by source type ─────────────────────────────────────────
DELIGHT_K = {'photoscan': 0.85, 'ai': 0.35, 'blender_ao': 1.00, 'flat': 0.00}

# ── §4.4 STEP 5 palette-snap strength, by class of use ────────────────────────────────────────
SNAP_ALPHA = {'large_surface': 0.60, 'prop': 0.35, 'exempt': 0.00}

# ── §3.7 normal-strength bands: mean |N.xy| ───────────────────────────────────────────────────
NORMAL_BANDS = {
    'ground':  (0.10, 0.22), 'masonry': (0.18, 0.32),
    'prop':    (0.15, 0.30), 'foliage': (0.20, 0.35),
}

PRE_GRADE_SAT = 1.15        # colorGradePass.js:49 satAmt at uRally=0
RALLY_SAT     = 1.52        # the rally path we must SURVIVE but never author against

# ══ colour space ══════════════════════════════════════════════════════════════════════════════
_M_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                       [0.2126729, 0.7151522, 0.0721750],
                       [0.0193339, 0.1191920, 0.9503041]])
_M_XYZ2RGB = np.linalg.inv(_M_RGB2XYZ)
_WHITE = np.array([0.95047, 1.0, 1.08883])
_D = 6.0 / 29.0


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((np.clip(c, 0, None) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def rgb_to_lab(rgb):
    """rgb: (...,3) float in [0,1] sRGB -> Lab."""
    xyz = srgb_to_linear(rgb) @ _M_RGB2XYZ.T / _WHITE
    f = np.where(xyz > _D ** 3, np.cbrt(np.clip(xyz, 0, None)), xyz / (3 * _D * _D) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_rgb(lab):
    fy = (lab[..., 0] + 16) / 116
    fx, fz = fy + lab[..., 1] / 500, fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f > _D, f ** 3, 3 * _D * _D * (f - 4 / 29)) * _WHITE
    return np.clip(linear_to_srgb(xyz @ _M_XYZ2RGB.T), 0, 1)


def hex_to_lab(h):
    v = np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float64)
    return rgb_to_lab(v)


def lab_to_lch(lab):
    C = np.hypot(lab[..., 1], lab[..., 2])
    h = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360
    return lab[..., 0], C, h


def lch_to_lab(L, C, h):
    r = np.radians(h)
    return np.stack([L, C * np.cos(r), C * np.sin(r)], axis=-1)


def delta_e_2000(lab1, lab2):
    """CIEDE2000 between two Lab colours (arrays broadcast)."""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25.0 ** 7 + 1e-12)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, np.where(dhp < -180, dhp + 360, dhp))
    dhp = np.where(C1p * C2p == 0, 0, dhp)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp) / 2)
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hsum = h1p + h2p
    hdiff = np.abs(h1p - h2p)
    hbp = np.where(C1p * C2p == 0, hsum,
          np.where(hdiff <= 180, hsum / 2,
          np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp))
         + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63)))
    dTh = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25.0 ** 7 + 1e-12))
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / np.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dTh)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                   + Rt * (dCp / Sc) * (dHp / Sh))


# ══ the steps ═════════════════════════════════════════════════════════════════════════════════
def step2_delight(lab, mask, source_type, tiling=False):
    """
    STEP 2 — remove the source's OWN baked lighting.

    The game supplies its own occlusion (the v9 baked sky-visibility AO grid). A plate's baked sun
    is a different light from a different scene; shipped as-is it fights a grid that is correct.
    Low-frequency luminance is the lighting, high-frequency is the material — subtract the former.
    """
    k = DELIGHT_K[source_type]
    if k == 0:
        return lab
    L = lab[..., 0]
    # Blur only where the asset actually is; transparent margin would drag the low-frequency
    # estimate toward black and the de-light would then BRIGHTEN the silhouette edge.
    filled = np.where(mask, L, L[mask].mean() if mask.any() else 0)
    sigma = max(1.0, L.shape[1] / 8.0)
    # PIL cannot blur a float image, so the blur runs on L* quantised to 8 bits. That costs ~0.4
    # L* of precision in a deliberately LOW-FREQUENCY estimate (sigma = W/8), where it is far below
    # the signal being extracted — the alternative, a 128-px-sigma kernel in numpy, buys nothing.
    q = np.clip(filled, 0, 100) * 2.55
    if tiling:
        # A TILING texture must be blurred with WRAP, not edge-clamp. PIL clamps, which pulls the
        # border toward its own value — so the de-light would apply a different correction either
        # side of the seam and break the very seam STEP 1 just verified. Tiling 3x3 and taking the
        # centre gives a wrapped blur for the cost of one resample.
        h, w = q.shape
        tiled = np.tile(q, (3, 3))
        blurred = np.asarray(Image.fromarray(tiled.astype(np.uint8), 'L')
                             .filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float64)
        low = blurred[h:2 * h, w:2 * w] / 2.55
    else:
        low = np.asarray(Image.fromarray(q.astype(np.uint8), 'L')
                         .filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float64) / 2.55
    out = lab.copy()
    out[..., 0] = np.clip(L - k * (low - (L[mask].mean() if mask.any() else 0)), 0, 100)
    return out


def step3_rescale(lab, mask, surface_class, rescale_L=True, rescale_C=True):
    """
    STEP 3 — rescale L* and C* into the surface class's pre-grade target distribution.

    `rescale_L=False` for surfaces whose VALUE is their identity rather than a property of their
    material. A shopfront is dark joinery, dark glass and a stone plinth; forcing it to the facade
    class's plaster L* 74 lifted a dark green bar by 51 points and rendered it pale mint. The class
    targets describe a WALL, and the ground floor is not one.

    `rescale_C=False` where real object colour lives in the plate — a greengrocer's produce is not
    a material sample and greying it to a wall's chroma target is not normalisation, it is damage.
    """
    Lt, Ls, Ct = CLASS_TARGETS[surface_class]
    L, C, h = lab_to_lch(lab)
    mL, sL = L[mask].mean(), L[mask].std()
    mC, sC = C[mask].mean(), C[mask].std()
    L2 = Lt + (L - mL) * (Ls / max(sL, 1e-6)) if rescale_L else L
    # Only the C* MEAN is specified; scaling spread by the same ratio as its mean keeps the
    # relative chroma structure of the plate (a flower still reads brighter than a leaf).
    C2 = C * (Ct / max(mC, 1e-6)) if rescale_C else C
    return lch_to_lab(np.clip(L2, 0, 100), np.clip(C2, 0, None), h), (mL, sL, mC)


def step5_palette_snap(lab, mask, anchor_hexes, alpha):
    """
    STEP 5 — rotate hue toward the NEAREST allowed anchor by alpha, per pixel.

    "Nearest" is load-bearing and was the source of a real bug when this snapped every pixel to one
    anchor. A hue roughly OPPOSITE its anchor has two ~180-degree arcs to travel, and the shortest
    one can run through a hue that is in the palette's spirit far less than where it started: the
    jacaranda's violet blossom (hue ~315) snapped toward P9 Platanus Green (hue ~121) took the short
    way round THROUGH RED and landed on hot pink. Snapping each pixel toward whichever allowed
    anchor it is already closest to cannot do that — the rotation is always short and always inward.

    anchor_hexes: a single hex, or a list of the anchors allowed for this surface class.
    """
    if alpha == 0:
        return lab
    if isinstance(anchor_hexes, str):
        anchor_hexes = [anchor_hexes]
    L, C, h = lab_to_lch(lab)
    anchor_h = np.array([lab_to_lch(hex_to_lab(a))[2] for a in anchor_hexes])
    # signed shortest arc from each pixel to each anchor -> pick the anchor with the smallest |arc|
    d_all = (anchor_h[None, None, :] - h[..., None] + 180) % 360 - 180
    pick = np.argmin(np.abs(d_all), axis=-1)
    d = np.take_along_axis(d_all, pick[..., None], axis=-1)[..., 0]
    return lch_to_lab(L, C, (h + alpha * d) % 360)


def step6_pre_grade(lab):
    """
    STEP 6 — divide C* by the shipping grade's saturation so the asset is authored for the
    POST-grade look. Absent this step every recorded overshoot in the repo happened.
    """
    L, C, h = lab_to_lch(lab)
    return lch_to_lab(L, C / PRE_GRADE_SAT, h)


def step4_calibrate_normal(nrm_rgb, band='foliage'):
    """
    STEP 4 — rescale XY so mean |N.xy| lands in the class band, then renormalise Z.
    Per AD-5 this is what makes runtime normalScale = 1.0 correct.
    """
    lo, hi = NORMAL_BANDS[band]
    n = nrm_rgb * 2.0 - 1.0
    xy = n[..., :2]
    mean_mag = np.hypot(xy[..., 0], xy[..., 1]).mean()
    target = (lo + hi) / 2
    scale = target / max(mean_mag, 1e-6)
    xy = xy * scale
    z = np.sqrt(np.clip(1.0 - np.clip(xy[..., 0] ** 2 + xy[..., 1] ** 2, 0, 1), 0, 1))
    out = np.dstack([xy[..., 0], xy[..., 1], z])
    after = np.hypot(out[..., 0], out[..., 1]).mean()
    return (out + 1.0) / 2.0, mean_mag, after, (lo <= after <= hi)


def gate4_delta_e(lab, mask, surface_class=None):
    """
    Gate 4 — mean colour must sit within ΔE2000 <= 15 of at least one §4.1 anchor.

    `surface_class` gates the RESTRICTED anchors (see RESTRICTED_ANCHORS). Passing None — the
    default — checks against the unrestricted ten only, so a caller that does not declare what it is
    measuring cannot accidentally borrow a class-specific anchor to pass.
    """
    mean_lab = np.array([lab[..., i][mask].mean() for i in range(3)])
    best, best_d = None, 1e9
    for name, hx in ANCHORS.items():
        allowed = RESTRICTED_ANCHORS.get(name)
        if allowed is not None and surface_class not in allowed:
            continue
        d = float(delta_e_2000(mean_lab, hex_to_lab(hx)))
        if d < best_d:
            best, best_d = name, d
    return best, best_d, mean_lab


def rally_clip_check(lab, mask):
    """
    STEP 6's second half — re-render at the rally saturation and assert no channel clips.
    Returns the fraction of opaque pixels that would clip.
    """
    L, C, h = lab_to_lch(lab)
    rgb = lab_to_rgb(lch_to_lab(L, C * RALLY_SAT, h))
    # lab_to_rgb clamps, so detect clipping before the clamp by recomputing linear XYZ->RGB.
    fy = (L + 16) / 116
    labr = lch_to_lab(L, C * RALLY_SAT, h)
    fx, fz = fy + labr[..., 1] / 500, fy - labr[..., 2] / 200
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f > _D, f ** 3, 3 * _D * _D * (f - 4 / 29)) * _WHITE
    lin = xyz @ _M_XYZ2RGB.T
    clipped = ((lin < -1e-3) | (lin > 1.0 + 1e-3)).any(axis=-1)
    return float(clipped[mask].mean()), rgb


def normalize_albedo(rgb, alpha, *, source_type, surface_class, anchor, alpha_snap,
                     alpha_threshold=0.02, tiling=False, rescale_L=True, rescale_C=True):
    """
    Run STEPS 2 -> 3 -> 5 -> 6 on an RGBA plate. Statistics are computed over OPAQUE pixels only:
    including the transparent margin would drag every mean toward the background and silently
    wreck the rescale.
    """
    mask = alpha > alpha_threshold
    lab = rgb_to_lab(rgb)
    lab = step2_delight(lab, mask, source_type, tiling=tiling)
    lab, before = step3_rescale(lab, mask, surface_class, rescale_L=rescale_L, rescale_C=rescale_C)
    lab = step5_palette_snap(lab, mask, anchor, alpha_snap)
    lab = step6_pre_grade(lab)
    # pass the declared class through, so a foliage plate may reach a foliage-restricted anchor
    anchor_name, dE, mean_lab = gate4_delta_e(lab, mask, surface_class)
    clip_frac, out_rgb = rally_clip_check(lab, mask)
    return out_rgb, {
        'src_L_mean': before[0], 'src_L_std': before[1], 'src_C_mean': before[2],
        'L_mean': mean_lab[0], 'C_mean': float(np.hypot(mean_lab[1], mean_lab[2])),
        'anchor': anchor_name, 'deltaE': dE, 'rally_clip_pct': clip_frac * 100,
        'gate4_pass': dE <= 15.0,
    }


def step1_tile_verify(rgb, drift_ref=None, axes='both'):
    """
    STEP 1 — TILE VERIFY. "Fail = fix or reject, never ship." A cutout card does not tile so the card
    pipeline skips this; a rock or kerb surface does, and a seam repeating every metre across a
    hillside is the most obvious tell there is.

    Returns (passed, coherence, coherence).

    `axes` — 'both', 'u' or 'v'. A shopfront tiles ALONG a street and never vertically: its bottom
    edge is the pavement and its top edge meets the floor above, so judging its v seam would fail a
    texture that is correct. Only ask about the axis that has to wrap.

    `drift_ref` — measure the natural-variation denominator against THIS image instead of `rgb`.
    Pass the pre-repair source when checking a repaired texture: make_tileable blends, blending
    flattens the interior, and a smaller denominator inflates the ratio for a wrap that is now
    correct. The question is whether the seam is special relative to the texture's OWN natural
    variation, and that is a property of the source, not of the repair.

    THE METRIC TOOK FIVE ATTEMPTS and each failure is worth recording, because each was wrong in a
    different way and I "fixed" good assets on two of them:
      1. seam max vs image MEDIAN — the bible's literal wording, and unpassable: for any natural
         texture the high percentiles sit far above the median, so a PERFECT tile fails. Repairing
         against it made the scores WORSE, because the repair was answering a broken question.
      2. seam p99 vs image p99 — like-for-like at last, but blind to a smooth coherent step.
      3. averaging the two axes — a clean vertical wrap masked a broken horizontal one on all three
         rock plates, whose left/right edges matched to 0.1-2 levels while top/bottom stepped 6-10.
      4. mean-of-ABSOLUTE difference — cannot separate a coherent seam from ordinary variation on a
         texture whose interior is already busy, which is why the banded sandstone scored a clean
         1.01 with a plainly visible seam.
      5. keeping a percentile "spike" term alongside coherence — it compares the p99 of ~1,000 seam
         samples against the p99 of ~262,000 interior ones, which is not a like-for-like quantile.
         It scored 2.28 on a texture that is periodic to 1e-17 BY CONSTRUCTION.

    What survives is coherence alone, and it is anchored at BOTH ends: the three AI rock plates with
    visible seams score 2.7-4.2, and procedurally periodic noise scores 0.07-0.09. Having a true
    negative and a true positive is what makes this a gate rather than a number I keep re-deriving.

    Coherence uses the SIGNED mean, because what makes a seam visible is that every pixel along it
    steps the SAME WAY; ordinary interior variation is just as large per pixel and cancels. It takes
    the MAX of the two axes, never the mean, so one clean wrap cannot hide a broken one.
    """
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    h, w = lum.shape

    bias_v = abs(float(np.mean(lum[:, 0] - lum[:, w - 1])))
    bias_h = abs(float(np.mean(lum[0, :] - lum[h - 1, :])))
    # Reference: how much adjacent column/row means normally drift. A seamless wrap's step is just
    # another adjacent step, so a seamless texture lands near 1.0 or below.
    dl = lum if drift_ref is None else (drift_ref @ np.array([0.2126, 0.7152, 0.0722]))
    drift_v = float(np.mean(np.abs(np.diff(dl.mean(axis=0)))))
    drift_h = float(np.mean(np.abs(np.diff(dl.mean(axis=1)))))
    ru = bias_v / max(drift_v, 1e-12)      # left/right wrap
    rv = bias_h / max(drift_h, 1e-12)      # top/bottom wrap
    coherence = ru if axes == 'u' else rv if axes == 'v' else max(ru, rv)

    # ABSOLUTE FLOOR. A ratio is meaningless when both terms are ~0: procedurally periodic textures
    # have a seam bias around 1e-16 AND a drift around 1e-17, and the quotient is then pure
    # floating-point noise — the kerb granite, periodic by construction, scored 2.28 that way. A step
    # smaller than one 8-bit level cannot be seen, so it passes whatever the ratio says.
    checked_bias = bias_v if axes == 'u' else bias_h if axes == 'v' else max(bias_v, bias_h)
    if checked_bias < (1.0 / 255.0):
        return True, min(coherence, 1.0), coherence
    return coherence <= 1.5, coherence, coherence


def height_normal(rgb, strength=1.0):
    """
    Tangent-space normal from luminance treated as height, with WRAPPED derivatives so the map
    tiles as cleanly as the albedo it came from.
    """
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    gx = (np.roll(lum, -1, axis=1) - np.roll(lum, 1, axis=1)) * 0.5 * strength
    gy = (np.roll(lum, -1, axis=0) - np.roll(lum, 1, axis=0)) * 0.5 * strength
    nx, ny = -gx, -gy
    nz = np.ones_like(nx) * 0.25
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.dstack([nx / ln, ny / ln, nz / ln]) * 0.5 + 0.5


def make_tileable(rgb, band_frac=0.22):
    """
    Repair a nearly-tiling texture so it actually wraps. STEP 1's "fix or reject" path.

    METHOD. Roll the image by half its size in both axes: the original border seams now run as a
    cross through the middle, and the image's own smooth interior sits along the border. Blend the
    rolled copy over the original with a mask that is 0 at the border and 1 in the middle. The
    border is then taken entirely from the rolled copy — whose values there are adjacent columns of
    the original interior — so it is continuous by construction, while the rolled copy's own seam
    cross falls where the mask is 1 and the original is used instead.

    The cost is a soft blend band where the two overlap, which on a stochastic surface like rock
    reads as slightly gentler detail. Mirroring would tile perfectly with no blend, but mirror
    symmetry across a hillside is far more visible than softened grain.
    """
    h, w = rgb.shape[:2]
    rolled = np.roll(np.roll(rgb, h // 2, axis=0), w // 2, axis=1)

    def ramp(n, b):
        x = np.arange(n, dtype=np.float64)
        d = np.minimum(x, n - 1 - x) / max(b, 1)      # 0 at the border, 1 at band depth
        d = np.clip(d, 0, 1)
        return d * d * (3 - 2 * d)                     # smoothstep

    b = max(1, int(min(h, w) * band_frac))
    m = np.minimum(ramp(h, b)[:, None], ramp(w, b)[None, :])[..., None]
    return rgb * m + rolled * (1 - m)


def resize_tiling(rgb, size):
    """
    Resample a TILING texture without breaking its wrap.

    PIL clamps at the image edge, so a plain resize invents new border pixels from one side only and
    the seam that step 1 just verified stops matching. (Measured: a sandstone plate passing at 0.73
    grew a visible seam cross purely from a 1254 -> 1024 resize.) Tiling 3x3 before the resample
    gives every border real neighbours to interpolate from; the centre tile is then still seamless.

    Same shape of mistake as bleed_rgb in the card pipeline: a resample is where wrap and alpha
    assumptions go to die, so both are handled BEFORE any resize, never after.
    """
    h, w = rgb.shape[:2]
    tiled = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB')
    big = Image.new('RGB', (w * 3, h * 3))
    for a in range(3):
        for b in range(3):
            big.paste(tiled, (a * w, b * h))
    big = big.resize((size * 3, size * 3), Image.LANCZOS)
    return np.asarray(big.crop((size, size, size * 2, size * 2)), dtype=np.float64) / 255.0


def align_tiling(rgb, coarse=1, axes='both'):
    """
    LOSSLESS tiling repair: roll the image so its natural period lands on the frame edge.

    A structured texture — panot paving, brick, a building facade — usually tiles perfectly and is
    simply FRAMED wrong: the generator cropped mid-tile, so the frame edge cuts through a flower, or
    through a window row. Measured: a panot plate scored 31.93 as delivered and 0.02 after a roll.
    Nothing was wrong with the pixels.

    Tried BEFORE make_tileable, and the order matters: a roll moves pixels, a blend destroys them.
    Blending a facade ghosts every window; blending a grid smears its joints.

    SEPARABLE, which is why this is fast enough to run at full resolution. The horizontal seam
    depends only on the COLUMN roll and the vertical seam only on the ROW roll, so the two axes are
    independent and each is a 1-D search. Brute-forcing the 2-D product instead is O(w*h) evaluations
    of an O(w) statistic — on a 1254 px facade that did not finish in two minutes, and it also
    settles for a coarse grid rather than the true optimum.
    """
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    h, w = lum.shape
    col = lum.mean(axis=0)          # column means -> drives the vertical (u) seam
    row = lum.mean(axis=1)          # row means    -> drives the horizontal (v) seam

    def best_roll(profile, n):
        # |profile[k] - profile[k-1]| for every candidate wrap point k; the smallest is the roll that
        # puts the frame edge where the texture already changes least — between storeys, on a grout
        # line, in blank render.
        diffs = np.abs(profile - np.roll(profile, 1))
        k = int(np.argmin(diffs[::max(1, coarse)]) * max(1, coarse))
        return (n - k) % n

    dx = best_roll(col, w) if axes in ('both', 'u') else 0
    # Never roll v on a texture that does not tile vertically — it would slide the pavement plinth
    # off the bottom edge and wrap it round to the top.
    dy = best_roll(row, h) if axes in ('both', 'v') else 0
    return np.roll(np.roll(rgb, dy, axis=0), dx, axis=1), dy, dx


def make_tiling(rgb):
    """
    The repair LADDER, cheapest and least destructive first:
      1. already tiles          -> ship untouched
      2. framed off-grid        -> roll into alignment (lossless)
      3. genuinely discontinuous-> blend (lossy, and only then)

    Running step 3 unconditionally is a mistake I made and measured: blending a plate that already
    wrapped cleanly took it from 1.28 to 2.82.

    Returns (rgb, ratio, passed, how).
    """
    ok, ratio, _ = step1_tile_verify(rgb)
    if ok:
        return rgb, ratio, True, 'as-generated'

    rolled, dy, dx = align_tiling(rgb)
    ok2, ratio2, _ = step1_tile_verify(rolled)
    if ok2:
        return rolled, ratio2, True, f'aligned (roll {dy},{dx})'

    src = rgb
    blended = make_tileable(rolled if ratio2 < ratio else rgb)
    ok3, ratio3, _ = step1_tile_verify(blended, drift_ref=src)
    return blended, ratio3, ok3, 'blended'


# Physically sane grain size per surface class, in millimetres. What one "stone" of the texture
# should measure in the world once the declared span is applied.
GRAIN_MM = {
    'asphalt':       (5, 15),    # bitumen aggregate chips
    'kerb':          (1, 3),     # granite crystal
    'rock':          (1, 6),     # schist / sandstone grain
    # Widened from (1,4) on evidence, not to silence a warning: the panot plate measures 4.7 mm and
    # its span is independently confirmed twice over — its grout lines sit at 0/625/1250 px of 1254,
    # exactly two 20 cm tiles, and it was signed off by eye in game. Concrete fines at ~5 mm are real.
    'sidewalk':      (1, 6),     # concrete fines (the panot MOTIF is geometry, not grain)
    'facade':        (1, 5),
    'terrain_dirt':  (1, 8),
    'terrain_grass': (2, 20),
}


def measure_grain_mm(rgb, span_m):
    """
    How big is one grain of this texture, in real millimetres, at the declared span?

    THIS EXISTS BECAUSE THE SAME MISTAKE HAPPENED TWICE. The kerb granite shipped at a 1 m span and
    read as gravel (its grain was ~8 mm where granite is 1-3); the asphalt shipped at 4 m and read as
    gravel too (23 mm where aggregate is 5-15). Both times the plate was fine and the SPAN was a
    guess — and both times it took a human looking at a screenshot to catch what is a one-line
    measurement. Span is a physical claim, so it can be checked like one.

    Grain is isolated from large-scale mottling with a high-pass first, otherwise the measurement
    returns the size of the patching and wear rather than the stones: the asphalt plate measures 164
    px unfiltered (16% of the page, obviously not a stone) and 6 px once the low frequencies are out.
    """
    lum = (rgb @ np.array([0.2126, 0.7152, 0.0722]))
    img = Image.fromarray((np.clip(lum, 0, 1) * 255).astype(np.uint8), 'L')
    low = np.asarray(img.filter(ImageFilter.GaussianBlur(12)), dtype=np.float64)
    hi = np.asarray(img, dtype=np.float64) - low

    h, w = hi.shape
    band = hi[max(0, h // 2 - 96):h // 2 + 96].mean(axis=0)
    ac = np.correlate(band, band, 'full')[w - 1:]
    ac = ac / max(ac[0], 1e-12)
    first_zero = next((i for i in range(1, min(200, w // 2)) if ac[i] <= 0), None)
    if first_zero is None:
        return None
    grain_px = 2 * first_zero
    return grain_px / w * span_m * 1000.0


def check_grain(rgb, span_m, surface_class):
    """(mm, ok, band) — is the grain physically sane for this class at this span?"""
    mm = measure_grain_mm(rgb, span_m)
    band = GRAIN_MM.get(surface_class)
    if mm is None or band is None:
        return mm, True, band
    return mm, band[0] <= mm <= band[1], band
