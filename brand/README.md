# Brand assets — reduced logo

Shareable logo package for social media and press requests.

## What's here

| Path | What it is |
|---|---|
| `TriciGo-logo-versiones-reducidas.pdf` | The document sent to whoever asks for the logo. Spanish, 6 pages: variants, per-network sizing, safe area, palette, misuse, file index. |
| `social/` | The PNGs referenced by that document, ready to upload. |

Both are generated — see *Regenerating* below — so don't hand-edit them.

## The reduced logo

TriciGo's identity has two forms:

- **Wordmark** (`tricigo-logo-horizontal-*.png`) — the full horizontal signature. Used wherever there is room.
- **Isotype** (`tricigo-isotipo-*.png`) — the pin with the bolt. This is the *reduced* version, used wherever the space is small or square: avatars, favicons, app icons, video stamps.

Social networks crop avatars to a circle, so they always take the isotype. The mark's farthest point sits at 72 % of the radius, which clears any circular crop.

## Files in `social/`

Solid-background squares (avatars) come in 1024 / 512 / 400 px; upload the 1024.

- `tricigo-isotipo-naranja-*` — white pin on `#FF4D00`. **Default avatar.**
- `tricigo-isotipo-negro-*` — white pin + orange bolt on `#111111`.
- `tricigo-isotipo-blanco-*` — orange pin on `#FFFFFF`.
- `tricigo-isotipo-blanco-transparente-1024` — white mark, transparent. Over dark photos.
- `tricigo-isotipo-naranja-transparente-1024` — orange mark, transparent. Over light backgrounds.
- `tricigo-isotipo-bicolor-transparente-1024` — white pin + orange bolt, transparent.
- `tricigo-logo-horizontal-600` / `-blanco-600` — wordmark, transparent, master size.

## Colors

Exactly the tokens in `packages/theme/src/brand.ts` — `#FF4D00` (Go Orange), `#111111` (Trici Black), `#FFFFFF`.

The master app icons carry slightly drifted values (`#FE4202`, `#121313`) from earlier export passes. The kit builder repaints the flat areas with the official tokens instead of resampling those PNGs, so every exported file is on-palette. Verify with:

```bash
python3 -c "from PIL import Image; print(Image.open('brand/social/tricigo-isotipo-naranja-1024.png').convert('RGB').getpixel((2,2)))"
# -> (255, 77, 0)
```

## Sources

Derived from masters already in the repo; none of them are modified:

| Master | Feeds |
|---|---|
| `apps/client/assets/icon.png` (1024²) | Mono silhouette → orange, white and transparent variants |
| `apps/driver/assets/icon.png` (1024²) | Duotone split (pin / bolt) → black and bicolor variants |
| `apps/web/public/logo-wordmark{,-white}.png` | Horizontal wordmark, passed through as-is |

## Regenerating

Both scripts need Python packages that aren't part of the JS toolchain, so install them into a throwaway venv:

```bash
python3 -m venv /tmp/brandenv && /tmp/brandenv/bin/pip install Pillow reportlab
/tmp/brandenv/bin/python scripts/build-social-logo-kit.py   # PNGs -> brand/social/
/tmp/brandenv/bin/python scripts/build-social-logo-pdf.py   # PDF  -> brand/
```

Run the kit first: the PDF embeds its output.

## Known gap — no vector

There is no vector master for the logo in this repo. `apps/web/public/bimi-logo.svg` is a hand-traced approximation built for the email BIMI record, not the real artwork, and `apps/web/public/favicon.svg` is a placeholder letter "T" that doesn't match the mark at all.

The PNGs here top out at 1024 px, which covers every screen use. Large-format print needs the original vector from whoever produced the brand — ask before promising an SVG/EPS.
