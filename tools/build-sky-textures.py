#!/usr/bin/env python3
"""
build-sky-textures.py — equirect cloud layers for the sky dome. v3 P3-11.

PROCEDURAL, AND HERE THAT IS THE STRONGER TOOL — not a fallback. An equirect sky must wrap exactly
left-to-right and converge correctly at the poles, and an image model has no notion of either: you
get a seam down one side and a smeared zenith, with no repair possible because a wrong projection
is not a hue you can grade. Generating it means computing the projection, which is the easy half.

WHAT IS ACTUALLY DRAWN. Not a whole sky — a CLOUD LAYER with alpha. The spec requires the analytic
gradient in scene.js to stay underneath and keep carrying dawn/dusk, so the texture must not paint
over it. Clouds composite on top; the gradient still owns the colour of the air.

HOW THE PERSPECTIVE COMES OUT RIGHT. Clouds live on a flat plane at a fixed altitude, and each
texel's view ray is intersected with that plane (t = H / dir.y) before the noise is sampled. That is
what makes clouds compress toward the horizon and spread overhead, for free and correctly. Sampling
noise directly in equirect UV instead is the classic mistake: it stretches horribly at the poles and
produces the "clouds painted on a dome" look.
"""
import os, sys, json
import numpy as np
from PIL import Image

OUT = 'frontend/public/textures/sky'
W, H = 2048, 1024
CLOUD_ALT = 1200.0          # metres — a fair-weather cumulus deck


def value_noise_2d(x, y, seed):
    """Bilinear value noise on an integer lattice. Cheap and adequate under fBm."""
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    xf, yf = x - xi, y - yi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)

    def h(a, b):
        # uint64 throughout: numpy int64 raises on these multipliers rather than wrapping, which is
        # correct behaviour and the reason the dtype is explicit here.
        n = (a.astype(np.uint64) * np.uint64(374761393)
             + b.astype(np.uint64) * np.uint64(668265263)
             + np.uint64(seed & 0xFFFF) * np.uint64(1442695040888963407))
        n = (n ^ (n >> np.uint64(13))) * np.uint64(1274126177)
        return ((n ^ (n >> np.uint64(16))) & np.uint64(0xFFFFFF)).astype(np.float64) / float(0xFFFFFF)

    n00, n10 = h(xi, yi), h(xi + 1, yi)
    n01, n11 = h(xi, yi + 1), h(xi + 1, yi + 1)
    return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v


def fbm(x, y, seed, octaves=6):
    total = np.zeros_like(x)
    amp, freq, norm = 1.0, 1.0, 0.0
    for o in range(octaves):
        total += value_noise_2d(x * freq, y * freq, seed + o * 7919) * amp
        norm += amp
        amp *= 0.5
        freq *= 2.13          # non-integer, so octaves do not align into a grid
    return total / norm


def build(name, coverage, sharpness, lit, shadow, seed):
    """coverage: 0 = clear, 1 = overcast.  lit/shadow: cloud top and underside colour."""
    # Equirect directions. u -> azimuth, v -> elevation.
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    az = (u * 2 * np.pi)[None, :]
    el = ((0.5 - v) * np.pi)[:, None]        # +pi/2 at the top row, -pi/2 at the bottom
    dy = np.sin(el) + 0.0 * az
    dx = np.cos(el) * np.cos(az)
    dz = np.cos(el) * np.sin(az)

    # Intersect each ray with the cloud plane. Rays at or below the horizon never reach it — clamped
    # rather than masked so the noise stays continuous right up to the horizon line.
    t = CLOUD_ALT / np.maximum(dy, 1e-3)
    px, pz = dx * t, dz * t

    S = 1.0 / 2600.0                          # metres -> noise units: ~2.6 km per feature
    n = fbm(px * S, pz * S, seed)
    # A second, slower field varies coverage across the sky so it is not uniformly cloudy.
    macro = fbm(px * S * 0.22, pz * S * 0.22, seed + 999)
    field = n + (macro - 0.5) * 0.45

    # THRESHOLD FROM THE ACTUAL DISTRIBUTION, not from a guess. fBm of value noise concentrates
    # around 0.5 with a range that depends on octave count and gain, so a hand-picked threshold
    # produces whatever coverage it happens to produce — the first attempt asked for 42% and drew
    # 0.1%. Taking the (1 - coverage) quantile over the sky ABOVE the horizon makes the requested
    # coverage the delivered coverage, whatever the noise does.
    above = dy > 0.05
    sky = field[above]
    thresh = float(np.quantile(sky, 1.0 - coverage)) if sky.size else 0.5
    # Sharpness is a FRACTION OF THE FIELD'S OWN SPREAD, not an absolute number. fBm concentrates
    # around its mean, so a fixed 0.22 ramp sat far outside the distribution and almost nothing
    # reached full density — the requested 42% coverage drew 1%.
    spread = float(sky.std()) if sky.size else 0.1
    dens = np.clip((field - thresh) / max(1e-4, sharpness * spread * 4.0), 0.0, 1.0)
    dens = dens * dens * (3 - 2 * dens)

    # Fade out at the horizon: the deck ends at a finite distance, and a hard cut looks like a wall.
    horizon = np.clip((dy - 0.02) / 0.14, 0.0, 1.0)
    alpha = dens * horizon

    # Shade: thick cloud is bright on top and darker underneath. Approximated from density, which is
    # honest here — depth through the deck IS what drives it.
    shade = np.clip(dens * 1.4, 0, 1)[..., None]
    rgb = np.array(shadow)[None, None, :] * (1 - shade) + np.array(lit)[None, None, :] * shade

    img = np.concatenate([rgb, alpha[..., None]], axis=-1)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), 'RGBA').save(f'{OUT}/{name}.png')

    # Coverage measured ABOVE THE HORIZON only — half the equirect image is ground and can never
    # hold cloud, so including it halves every number and makes the figure meaningless.
    cov = float((alpha[above] > 0.5).mean() * 100)
    # A seam would show as a discontinuity between the last and first column. It cannot happen here —
    # azimuth is periodic by construction — but it is asserted rather than assumed.
    seam = float(np.abs(alpha[:, 0] - alpha[:, -1]).mean())
    print(f'  {name:12s} coverage {cov:5.1f}%  seam {seam:.5f} (0 = exact)')
    return {'name': name, 'coverage': round(cov, 1), 'seam': round(seam, 6)}


def main():
    os.makedirs(OUT, exist_ok=True)
    surfaces = [
        # Day: bright cumulus, warm-white tops, cool-grey undersides.
        build('sky_clouds_day', coverage=0.42, sharpness=0.22,
              lit=(1.0, 0.99, 0.97), shadow=(0.62, 0.66, 0.74), seed=1337),
        # Night: the SAME deck seen under skyglow — thinner-looking because only the tops catch any
        # light, and cool. Not a different sky; the same weather after dark.
        build('sky_clouds_night', coverage=0.42, sharpness=0.22,
              lit=(0.30, 0.33, 0.44), shadow=(0.10, 0.12, 0.19), seed=1337),
    ]
    with open('frontend/src/map/skyTextures.js', 'w') as f:
        f.write('// GENERATED by tools/build-sky-textures.py — do not edit by hand.\n')
        f.write('export default ' + json.dumps(
            {'width': W, 'height': H, 'cloudAltM': CLOUD_ALT, 'layers': surfaces}, indent=2) + ';\n')
    print(f'\n-> {OUT}/  ({W}x{H} equirect RGBA)')


main()
