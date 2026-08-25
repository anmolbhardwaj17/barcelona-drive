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
}

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
def step2_delight(lab, mask, source_type):
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
    low = np.asarray(Image.fromarray(q.astype(np.uint8), 'L')
                     .filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float64) / 2.55
    out = lab.copy()
    out[..., 0] = np.clip(L - k * (low - (L[mask].mean() if mask.any() else 0)), 0, 100)
    return out


def step3_rescale(lab, mask, surface_class):
    """STEP 3 — rescale L* and C* into the surface class's pre-grade target distribution."""
    Lt, Ls, Ct = CLASS_TARGETS[surface_class]
    L, C, h = lab_to_lch(lab)
    mL, sL = L[mask].mean(), L[mask].std()
    mC, sC = C[mask].mean(), C[mask].std()
    L2 = Lt + (L - mL) * (Ls / max(sL, 1e-6))
    # Only the C* MEAN is specified; scaling spread by the same ratio as its mean keeps the
    # relative chroma structure of the plate (a flower still reads brighter than a leaf).
    C2 = C * (Ct / max(mC, 1e-6))
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


def gate4_delta_e(lab, mask):
    """Gate 4 — mean colour must sit within ΔE2000 <= 15 of at least one §4.1 anchor."""
    mean_lab = np.array([lab[..., i][mask].mean() for i in range(3)])
    best, best_d = None, 1e9
    for name, hx in ANCHORS.items():
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
                     alpha_threshold=0.02):
    """
    Run STEPS 2 -> 3 -> 5 -> 6 on an RGBA plate. Statistics are computed over OPAQUE pixels only:
    including the transparent margin would drag every mean toward the background and silently
    wreck the rescale.
    """
    mask = alpha > alpha_threshold
    lab = rgb_to_lab(rgb)
    lab = step2_delight(lab, mask, source_type)
    lab, before = step3_rescale(lab, mask, surface_class)
    lab = step5_palette_snap(lab, mask, anchor, alpha_snap)
    lab = step6_pre_grade(lab)
    anchor_name, dE, mean_lab = gate4_delta_e(lab, mask)
    clip_frac, out_rgb = rally_clip_check(lab, mask)
    return out_rgb, {
        'src_L_mean': before[0], 'src_L_std': before[1], 'src_C_mean': before[2],
        'L_mean': mean_lab[0], 'C_mean': float(np.hypot(mean_lab[1], mean_lab[2])),
        'anchor': anchor_name, 'deltaE': dE, 'rally_clip_pct': clip_frac * 100,
        'gate4_pass': dE <= 15.0,
    }
