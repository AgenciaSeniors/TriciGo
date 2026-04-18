#!/usr/bin/env node
// ============================================================
// TriciGo — Mobile icon + splash asset regenerator
//
// Generates:
//   - adaptive-icon.png (Android adaptive foreground): logo ONLY
//     on a transparent background, centered in the 66% safe zone.
//     Android fills the outer area with adaptiveIcon.backgroundColor
//     from app.json — so the final rendered icon matches no matter
//     what mask (circle / squircle / teardrop) the launcher uses.
//
//   - splash-logo-hd.png: high-res wordmark (2400x572) using Lanczos-3
//     so the splash doesn't pixelate on high-DPI devices.
//
// The chroma-key step below strips the navy/orange background square
// baked into icon.png, leaving only the orange/white logo with a
// transparent matte. This is what makes the icon render correctly.
//
// Run: node scripts/generate-mobile-icons.js
// Requires: sharp (already in root devDependencies)
// ============================================================

const sharp = require('sharp');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const APPS = [
  {
    name: 'driver',
    dir: path.join(ROOT, 'apps/driver/assets'),
    iconSource: 'icon.png',
    wordmarkSource: 'wordmark-hd.png',
    // Driver icon logo is ORANGE on NAVY. Keep pixels where red channel
    // dominates (orange/warm), drop the cool-tone navy. No radial mask
    // needed.
    keepPixel: (r, g, _b) => r > 150 && r > g + 30,
    radialMaskRatio: null,
    // Splash lives on a dark (#111111) background → recolor all non-
    // transparent pixels of the wordmark to white for contrast.
    splashRecolor: 'white',
  },
  {
    name: 'client',
    dir: path.join(ROOT, 'apps/client/assets'),
    iconSource: 'icon.png',
    wordmarkSource: 'wordmark-hd.png',
    // Client icon logo is WHITE on ORANGE with an outer white frame.
    // Keep only near-white pixels within the center 40% radius.
    keepPixel: (r, g, b) => r > 245 && g > 245 && b > 245,
    radialMaskRatio: 0.4,
    // Splash lives on white background → use the wordmark AS-IS (color).
    splashRecolor: null,
  },
];

const ADAPTIVE_CANVAS = 1024;
const SAFE_ZONE = 0.66;
// Splash uses the HD wordmark at native ratio (1536x1024 ≈ 3:2). We keep
// the original aspect, just compress (no upscale needed — source is hi-res).
const SPLASH_TARGET_W = 1536;
const SPLASH_TARGET_H = 1024;

async function extractLogo(srcPath, keepPixel, radialMaskRatio) {
  // Load raw RGBA, zero-out alpha where keepPixel returns false
  // (and optionally where pixel falls outside a center circle).
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const cx = W / 2;
  const cy = H / 2;
  const radius = radialMaskRatio ? Math.min(W, H) * radialMaskRatio : null;
  const radiusSq = radius ? radius * radius : null;

  const out = Buffer.from(data);
  for (let p = 0; p < out.length; p += 4) {
    const pixelIdx = p / 4;
    const x = pixelIdx % W;
    const y = Math.floor(pixelIdx / W);
    const r = out[p];
    const g = out[p + 1];
    const b = out[p + 2];

    const inRadius = radiusSq == null || ((x - cx) ** 2 + (y - cy) ** 2) <= radiusSq;
    if (!inRadius || !keepPixel(r, g, b)) {
      out[p + 3] = 0;
    }
  }

  return sharp(out, {
    raw: { width: W, height: H, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function regenerateAdaptiveIcon(app) {
  const srcPath = path.join(app.dir, app.iconSource);
  const outPath = path.join(app.dir, 'adaptive-icon.png');

  // 1. Extract logo on transparent
  const logoOnly = await extractLogo(srcPath, app.keepPixel, app.radialMaskRatio);

  // 2. Scale logo to 66% of canvas, centered on transparent canvas
  const scaledSize = Math.round(ADAPTIVE_CANVAS * SAFE_ZONE);
  const pad = Math.round((ADAPTIVE_CANVAS - scaledSize) / 2);

  const scaled = await sharp(logoOnly)
    .resize(scaledSize, scaledSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: ADAPTIVE_CANVAS,
      height: ADAPTIVE_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: scaled, left: pad, top: pad }])
    .png()
    .toFile(outPath);

  console.log(`[${app.name}] adaptive-icon.png → ${ADAPTIVE_CANVAS}×${ADAPTIVE_CANVAS}, logo-only ${scaledSize}px centered`);
}

async function regenerateSplashHd(app) {
  const srcPath = path.join(app.dir, app.wordmarkSource);
  const outPath = path.join(app.dir, 'splash-logo-hd.png');

  let pipeline = sharp(srcPath);

  if (app.splashRecolor === 'white') {
    // Recolor every opaque pixel to pure white while preserving alpha
    // (for dark splash backgrounds where the original dark-text version
    // would disappear into the background).
    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.from(data);
    for (let p = 0; p < out.length; p += 4) {
      // Only touch non-transparent pixels
      if (out[p + 3] > 0) {
        out[p] = 255;
        out[p + 1] = 255;
        out[p + 2] = 255;
      }
    }
    pipeline = sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } });
  }

  await pipeline
    .resize(SPLASH_TARGET_W, SPLASH_TARGET_H, {
      kernel: 'lanczos3',
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  const recolorLabel = app.splashRecolor ? ` [recolored ${app.splashRecolor}]` : '';
  console.log(`[${app.name}] splash-logo-hd.png → ${SPLASH_TARGET_W}×${SPLASH_TARGET_H}${recolorLabel}`);
}

async function main() {
  for (const app of APPS) {
    console.log(`\n=== ${app.name} ===`);
    await regenerateAdaptiveIcon(app);
    await regenerateSplashHd(app);
  }
  console.log('\n✓ All assets regenerated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
