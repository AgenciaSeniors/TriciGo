#!/usr/bin/env node
// ============================================================
// TriciGo — Mobile icon + splash asset regenerator
//
// Fixes:
//   1. adaptive-icon.png: Android launchers apply a mask (circle,
//      squircle, teardrop) on top of the foreground. The logo must
//      fit inside the center 66% safe zone with a TRANSPARENT
//      background; the OS fills the outer with `backgroundColor`
//      from app.json.
//   2. splash-logo-hd.png: the 600×143 wordmark pixelates at modern
//      DPIs. Upscale to 2400×572 with Lanczos-3.
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
    wordmarkSource: 'logo-wordmark-white.png',
  },
  {
    name: 'client',
    dir: path.join(ROOT, 'apps/client/assets'),
    iconSource: 'icon.png',
    wordmarkSource: 'logo-wordmark-white.png',
  },
];

const ADAPTIVE_CANVAS = 1024;
const SAFE_ZONE = 0.66;
const SPLASH_TARGET_W = 2400;
const SPLASH_TARGET_H = 572; // keeps 600:143 aspect → 2400:572

async function regenerateAdaptiveIcon(app) {
  const srcPath = path.join(app.dir, app.iconSource);
  const outPath = path.join(app.dir, 'adaptive-icon.png');

  const scaledSize = Math.round(ADAPTIVE_CANVAS * SAFE_ZONE);
  const pad = Math.round((ADAPTIVE_CANVAS - scaledSize) / 2);

  // Scale the logo down, then composite on a transparent canvas
  const scaledLogo = await sharp(srcPath)
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
    .composite([{ input: scaledLogo, left: pad, top: pad }])
    .png()
    .toFile(outPath);

  console.log(`[${app.name}] adaptive-icon.png → ${ADAPTIVE_CANVAS}x${ADAPTIVE_CANVAS}, logo at ${scaledSize}px centered`);
}

async function regenerateSplashHd(app) {
  const srcPath = path.join(app.dir, app.wordmarkSource);
  const outPath = path.join(app.dir, 'splash-logo-hd.png');

  await sharp(srcPath)
    .resize(SPLASH_TARGET_W, SPLASH_TARGET_H, {
      kernel: 'lanczos3',
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`[${app.name}] splash-logo-hd.png → ${SPLASH_TARGET_W}x${SPLASH_TARGET_H} (Lanczos-3)`);
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
