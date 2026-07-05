#!/usr/bin/env node
// ============================================================
// TriciGo — Driver app icon generator (pin + lightning logo)
//
// Source: apps/driver/assets/driver-icon-design.png
//   = the finished black squircle design (hollow white pin +
//     orange lightning bolt) on a transparent margin, 1024x1024.
//
// We extract the colored SYMBOL (white pin + orange bolt) from the
// black square once, then place it so BOTH apps' icons are geometric
// twins on every surface (user decision 2026-07-05). The CLIENT
// assets are the single source of truth: their pin/glyph metrics are
// measured at runtime, never hardcoded, so re-running this script can
// never drift the two apps apart.
//
//   - icon.png (1024, OPAQUE): symbol scaled + positioned to the
//     client pin's measured bbox height and center, on a full-bleed
//     flat near-black square (iOS masks the corners itself).
//   - adaptive-icon.png (1024, transparent): symbol centered at 45.4%
//     of the canvas — matches the client adaptive icon foreground so
//     the Android launcher renders both logos the same size. The
//     launcher fills the rest with adaptiveIcon.backgroundColor
//     (#000000) and expo-splash-screen reuses this asset.
//   - notification-icon.png (96): pure-white silhouette of the symbol
//     at the client glyph's measured height and center; Android tints
//     it with expo-notifications.color.
//
// Run: node scripts/generate-driver-icon.js   (requires sharp)
// ============================================================

const sharp = require('sharp');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'apps/driver/assets');
const CLIENT_DIR = path.join(ROOT, 'apps/client/assets');
const SRC = path.join(DIR, 'driver-icon-design.png');

const SIZE = 1024;
const SYMBOL_RATIO = 0.454; // adaptive-icon symbol height — matches the client adaptive icon (45.4%)
// Flat near-black of the shipped master (squircle interior of the design).
const BG = { r: 18, g: 19, b: 19 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

async function loadRaw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// bbox of pixels matching a predicate over (r, g, b, a).
function bboxOf({ data, width, height }, keep) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (keep(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    minX, minY, maxX, maxY,
    w: maxX - minX + 1, h: maxY - minY + 1,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  };
}

// Client pin metrics (near-white pixels on the flat orange master).
async function clientPinMetrics() {
  const img = await loadRaw(path.join(CLIENT_DIR, 'icon.png'));
  return bboxOf(img, (r, g, b, a) => a > 8 && r > 240 && g > 240 && b > 240);
}

// Client notification glyph metrics (alpha bbox in the 96px canvas).
async function clientNotifMetrics() {
  const img = await loadRaw(path.join(CLIENT_DIR, 'notification-icon.png'));
  return { canvas: img.width, ...bboxOf(img, (_r, _g, _b, a) => a > 8) };
}

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

// Scale the symbol to `targetH` px and composite it so its center lands on
// (targetCx, targetCy) of a SIZE x SIZE canvas with the given background.
async function placeSymbol(symbol, background, targetH, targetCx, targetCy) {
  const meta = await sharp(symbol).metadata();
  const newH = Math.round(targetH);
  const newW = Math.round(meta.width * (newH / meta.height));
  const scaled = await sharp(symbol)
    .resize(newW, newH, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .toBuffer();
  const left = Math.round(targetCx - newW / 2);
  const top = Math.round(targetCy - newH / 2);
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background } })
    .composite([{ input: scaled, left, top }])
    .png()
    .toBuffer();
}

async function main() {
  const symbol = await extractSymbol();
  const pin = await clientPinMetrics();
  console.log(`client pin reference: ${pin.w}x${pin.h} @ (${pin.cx},${pin.cy})`);

  // icon.png — symbol at client-pin parity on opaque full-bleed near-black
  const iconBuf = await placeSymbol(symbol, { ...BG, alpha: 1 }, pin.h, pin.cx, pin.cy);
  await sharp(iconBuf).flatten({ background: BG }).png().toFile(path.join(DIR, 'icon.png'));
  console.log(`icon.png -> ${SIZE}x${SIZE} opaque (near-black + symbol at client parity)`);

  // adaptive-icon.png — symbol on transparent (launcher/splash fill behind)
  const adaptiveBuf = await placeSymbol(symbol, TRANSPARENT, SIZE * SYMBOL_RATIO, SIZE / 2, SIZE / 2);
  await sharp(adaptiveBuf).png().toFile(path.join(DIR, 'adaptive-icon.png'));
  console.log(`adaptive-icon.png -> ${SIZE}x${SIZE} symbol on transparent (${(SYMBOL_RATIO * 100).toFixed(1)}% — client parity)`);

  // notification-icon.png — pure white silhouette at client glyph parity
  const notif = await clientNotifMetrics();
  console.log(`client notification reference: ${notif.w}x${notif.h} @ (${notif.cx},${notif.cy}) in ${notif.canvas}px`);
  const { data, info } = await sharp(symbol).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Buffer.from(data);
  for (let p = 0; p < w.length; p += 4) {
    if (w[p + 3] > 40) {
      w[p] = 255; w[p + 1] = 255; w[p + 2] = 255; w[p + 3] = 255;
    } else {
      w[p + 3] = 0;
    }
  }
  const glyphW = Math.round(info.width * (notif.h / info.height));
  const glyph = await sharp(w, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(glyphW, notif.h, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .png()
    .toBuffer();
  await sharp({ create: { width: notif.canvas, height: notif.canvas, channels: 4, background: TRANSPARENT } })
    .composite([{ input: glyph, left: Math.round(notif.cx - glyphW / 2), top: Math.round(notif.cy - notif.h / 2) }])
    .png()
    .toFile(path.join(DIR, 'notification-icon.png'));
  console.log(`notification-icon.png -> ${notif.canvas}x${notif.canvas} white silhouette at client parity`);

  console.log('\n✓ Driver icon assets regenerated from driver-icon-design.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
