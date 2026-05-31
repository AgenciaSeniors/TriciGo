#!/usr/bin/env node
// ============================================================
// TriciGo — Driver app icon generator (pin + lightning logo)
//
// Source: apps/driver/assets/driver-icon-design.png
//   = the finished black squircle design (solid white pin +
//     orange lightning bolt) on a transparent margin, 1024x1024.
//
// We extract the colored SYMBOL (white pin + orange bolt) from the
// black square once, then place it consistently so iOS, Android and
// the splash all match:
//
//   - icon.png (1024, OPAQUE): symbol on a full-bleed black square.
//     iOS masks the corners itself, so it must be a true square.
//   - adaptive-icon.png (1024, transparent): symbol centered in the
//     66% Android safe zone on transparent. The launcher fills the
//     rest with android.adaptiveIcon.backgroundColor (#000000), and
//     expo-splash-screen reuses this asset so the splash shows the
//     logo (not a black box) on its dark background.
//   - notification-icon.png (96): pure-white silhouette of the
//     symbol; Android tints it with expo-notifications.color.
//
// Run: node scripts/generate-driver-icon.js   (requires sharp)
// ============================================================

const sharp = require('sharp');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'apps/driver/assets');
const SRC = path.join(DIR, 'driver-icon-design.png');

const SIZE = 1024;
const NOTIF = 96;
const SYMBOL_RATIO = 0.6; // symbol size relative to the icon (within 66% safe zone)
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// Keep light/orange pixels (white pin + orange bolt), drop the near-black
// square and the pin's black counter, then trim to the symbol bbox.
async function extractSymbol() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let p = 0; p < out.length; p += 4) {
    const mx = Math.max(out[p], out[p + 1], out[p + 2]);
    if (!(out[p + 3] > 40 && mx >= 80)) out[p + 3] = 0;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim()
    .png()
    .toBuffer();
}

// Scale the symbol to SYMBOL_RATIO of the canvas and center it on `background`.
async function placeSymbol(symbol, background) {
  const inner = Math.round(SIZE * SYMBOL_RATIO);
  const pad = Math.round((SIZE - inner) / 2);
  const scaled = await sharp(symbol)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .toBuffer();
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background } })
    .composite([{ input: scaled, left: pad, top: pad }])
    .png()
    .toBuffer();
}

async function main() {
  const symbol = await extractSymbol();

  // icon.png — symbol on opaque full-bleed black square
  const iconBuf = await placeSymbol(symbol, BLACK);
  await sharp(iconBuf).flatten({ background: BLACK }).png().toFile(path.join(DIR, 'icon.png'));
  console.log(`icon.png -> ${SIZE}x${SIZE} opaque (black + symbol)`);

  // adaptive-icon.png — symbol on transparent (launcher/splash fill behind)
  const adaptiveBuf = await placeSymbol(symbol, TRANSPARENT);
  await sharp(adaptiveBuf).png().toFile(path.join(DIR, 'adaptive-icon.png'));
  console.log(`adaptive-icon.png -> ${SIZE}x${SIZE} symbol on transparent (66% safe zone)`);

  // notification-icon.png — pure white silhouette
  const { data, info } = await sharp(symbol).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Buffer.from(data);
  for (let p = 0; p < w.length; p += 4) {
    if (w[p + 3] > 40) {
      w[p] = 255; w[p + 1] = 255; w[p + 2] = 255; w[p + 3] = 255;
    } else {
      w[p + 3] = 0;
    }
  }
  await sharp(w, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(NOTIF, NOTIF, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toFile(path.join(DIR, 'notification-icon.png'));
  console.log(`notification-icon.png -> ${NOTIF}x${NOTIF} white silhouette`);

  console.log('\n✓ Driver icon assets regenerated from driver-icon-design.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
