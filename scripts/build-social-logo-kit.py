#!/usr/bin/env python3
"""
TriciGo - Social media logo kit builder
=======================================

Re-renders the reduced logo (isotype / pin mark) into the square, ready-to-upload
assets that social networks ask for, plus the horizontal wordmark.

Every output is derived from the master app icons already in the repo, but the
flat colors are re-painted with the OFFICIAL brand tokens from
packages/theme/src/brand.ts, so the exported files carry exactly #FF4D00 /
#111111 / #FFFFFF instead of the slightly drifted values baked into the PNGs.

Sources (masters, never modified):
  apps/client/assets/icon.png   1024x1024  white pin on orange  -> mono silhouette
  apps/driver/assets/icon.png   1024x1024  white pin + orange bolt on black -> duotone
  apps/web/public/logo-wordmark{,-white}.png  600x143  horizontal wordmark

Run: python3 scripts/build-social-logo-kit.py
Requires: Pillow  (pip install Pillow)
"""

import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "brand", "social")

# Official brand tokens - packages/theme/src/brand.ts
ORANGE = (255, 77, 0)      # Go Orange   #FF4D00
BLACK = (17, 17, 17)       # Trici Black #111111
WHITE = (255, 255, 255)

CLIENT_ICON = os.path.join(ROOT, "apps/client/assets/icon.png")
DRIVER_ICON = os.path.join(ROOT, "apps/driver/assets/icon.png")
WORDMARK = os.path.join(ROOT, "apps/web/public/logo-wordmark.png")
WORDMARK_WHITE = os.path.join(ROOT, "apps/web/public/logo-wordmark-white.png")

AVATAR_SIZES = [1024, 512, 400]


def mono_mask(path):
    """Alpha mask of the pin from the client icon (white figure on orange plate).

    Projects every pixel onto the orange->white axis, which keeps the antialiased
    edges intact instead of hard-thresholding them.
    """
    im = Image.open(path).convert("RGB")
    px = im.load()
    bg = px[1, 1]                                   # sampled plate color
    fg = (254, 254, 254)                            # sampled figure color
    d = tuple(f - b for f, b in zip(fg, bg))
    den = sum(c * c for c in d) or 1
    mask = Image.new("L", im.size)
    mpx = mask.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b = px[x, y]
            t = ((r - bg[0]) * d[0] + (g - bg[1]) * d[1] + (b - bg[2]) * d[2]) / den
            mpx[x, y] = 0 if t <= 0 else (255 if t >= 1 else int(t * 255 + 0.5))
    return mask


def duotone_masks(path):
    """Split the driver icon into (white pin mask, orange bolt mask).

    whiteness = how far min(r,g,b) sits above the black plate -> the pin.
    orangeness = the red/blue spread -> the bolt.
    The larger of the two claims the pixel, so the shared antialiased border
    between pin and bolt is assigned once and never double-painted.
    """
    im = Image.open(path).convert("RGB")
    px = im.load()
    w_mask = Image.new("L", im.size)
    o_mask = Image.new("L", im.size)
    wp, op = w_mask.load(), o_mask.load()
    floor = 30          # plate luminance, anything below is background
    span = 255 - floor
    # Saturation reference sampled from the bolt itself (255,90,21) -> spread 165.
    # Normalising by the real spread (instead of a guessed 225) is what keeps a
    # fully-orange pixel at alpha 1.0; otherwise the bolt blends with the plate
    # and exports muddy brown.
    bolt_spread = 165
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b = px[x, y]
            whiteness = max(0.0, (min(r, g, b) - floor) / span)
            orangeness = max(0.0, (r - max(g, b)) / bolt_spread)
            whiteness = min(1.0, whiteness)
            orangeness = min(1.0, orangeness)
            if whiteness >= orangeness:
                wp[x, y] = int(whiteness * 255 + 0.5)
                op[x, y] = 0
            else:
                wp[x, y] = 0
                op[x, y] = int(orangeness * 255 + 0.5)
    return w_mask, o_mask


def paint(mask, color, size=None):
    """RGBA layer: flat `color` carried by `mask` as alpha."""
    layer = Image.new("RGBA", mask.size, color + (0,))
    layer.putalpha(mask)
    if size and size != mask.size[0]:
        layer = layer.resize((size, size), Image.LANCZOS)
    return layer


def on_plate(layers, plate, size):
    """Flatten RGBA layers over a solid square plate."""
    out = Image.new("RGB", layers[0].size, plate)
    for l in layers:
        out.paste(l, (0, 0), l)
    if size != out.size[0]:
        out = out.resize((size, size), Image.LANCZOS)
    return out


def save(im, name):
    p = os.path.join(OUT, name)
    im.save(p, "PNG", optimize=True)
    print(f"  {name:<52} {im.size[0]}x{im.size[1]}  {os.path.getsize(p)//1024} KB")


def main():
    os.makedirs(OUT, exist_ok=True)
    print("Building TriciGo social logo kit ->", OUT)

    print("\nIsotype - mono silhouette (from client icon)")
    mono = mono_mask(CLIENT_ICON)
    white_layer = paint(mono, WHITE)
    orange_layer = paint(mono, ORANGE)

    for s in AVATAR_SIZES:
        save(on_plate([white_layer], ORANGE, s), f"tricigo-isotipo-naranja-{s}.png")
    for s in AVATAR_SIZES:
        save(on_plate([orange_layer], WHITE, s), f"tricigo-isotipo-blanco-{s}.png")

    print("\nIsotype - duotone (from driver icon)")
    w_mask, o_mask = duotone_masks(DRIVER_ICON)
    pin = paint(w_mask, WHITE)
    bolt = paint(o_mask, ORANGE)
    for s in AVATAR_SIZES:
        save(on_plate([pin, bolt], BLACK, s), f"tricigo-isotipo-negro-{s}.png")

    print("\nIsotype - transparent background")
    save(paint(mono, WHITE, 1024), "tricigo-isotipo-blanco-transparente-1024.png")
    save(paint(mono, ORANGE, 1024), "tricigo-isotipo-naranja-transparente-1024.png")
    duo = Image.new("RGBA", pin.size, (0, 0, 0, 0))
    duo.paste(pin, (0, 0), pin)
    duo.paste(bolt, (0, 0), bolt)
    save(duo, "tricigo-isotipo-bicolor-transparente-1024.png")

    print("\nHorizontal wordmark (native master size, transparent)")
    for src, name in ((WORDMARK, "tricigo-logo-horizontal-600.png"),
                      (WORDMARK_WHITE, "tricigo-logo-horizontal-blanco-600.png")):
        save(Image.open(src).convert("RGBA"), name)

    print("\nDone.")


if __name__ == "__main__":
    main()
