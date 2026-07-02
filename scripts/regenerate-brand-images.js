#!/usr/bin/env node
// ============================================================
// TriciGo — Brand image regenerator (image-quality audit 2026-07-01)
//
// Fixes, all derived from masters that already live in the repo:
//
//  1. WORDMARKS — the shipped 600x143 / 336x80 / 200x48 exports are
//     either hard-aliased (logo-wordmark.png has BINARY alpha → jagged
//     diagonals, visible when tinted white on the client login) or carry
//     a thin white matte fringe from an old background key-out (the
//     white variants + both email logos). All are regenerated from the
//     clean HD master `apps/client/assets/wordmark-hd.png` (1536x1024,
//     content 886x202, proper anti-aliasing — same artwork, verified
//     IoU 0.87 vs the current exports).
//     · Dark variant: master recolored to the currently-shipped flat
//       colors so nothing changes visually (dark #1D1D1D, orange #FD410D).
//     · White variant: the 6 dark letter components → white; the 3
//       orange components (bolt dot, G, o) stay orange. Components never
//       touch, so per-component recoloring cannot bleed across edges.
//
//  2. notification-icon.png (client) — the current file bakes a
//     rounded-square FRAME hugging the canvas edges (Android silhouettes
//     status-bar icons, so the frame renders as a box around every
//     notification) plus 4 stray 1-2px specks inside the glyph's negative
//     space. Keep only the pin component. (The driver icon is clean.)
//
//  3. login-hero.png (client + driver) — leftover background-removal
//     specks: isolated alpha islands floating in the transparent gaps
//     between the vehicles (12 islands client / 29 driver). Drop every
//     connected component under 50px; the vehicles are thousands of px.
//
//  4. markers/dropoff-pin.png (client/driver/web, identical) — 2 stray
//     single-pixel specks. Same component filter.
//
//  5. apps/web/public/icon-512.png — visibly softer than the 1024 master;
//     re-derived with a clean Lanczos-3 downscale from
//     apps/client/assets/icon.png (full-bleed since #723; the web
//     manifest declares it as a plain "any" icon, so full-bleed is right).
//
//  6. coins/tricoin-small*.png (client/driver/web) — the current small
//     coin is a blurry, tiny-in-canvas blob (content only ~39% of the
//     canvas). Re-derived from tricoin-logo@3x.png: crop the coin's
//     bounding box and fit it at ~88% of the canvas → sharper and larger
//     at the same display size.
//
// The admin wordmarks are regenerated at 2x (400x96 instead of 200x48):
// the admin pages render them with `h-10 w-auto`, so the doubled
// resolution is picked up for free on retina displays. The old admin
// dark wordmark also had a hard-baked white box (no alpha channel) —
// the regenerated file has real transparency.
//
// Run: node scripts/regenerate-brand-images.js
// Requires: sharp (root devDependencies) — same toolchain as
// scripts/generate-mobile-icons.js.
// ============================================================

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const P = (...seg) => path.join(ROOT, ...seg);

// Flat colors currently shipped (measured from the live exports) so the
// regeneration changes edge quality, not the look. The HD master's orange
// is slightly redder (254,44,13); we keep today's tone.
const DARK = { r: 29, g: 29, b: 29 };
const ORANGE = { r: 253, g: 65, b: 13 };
const WHITE = { r: 255, g: 255, b: 255 };

// ---------- raw-pixel helpers ----------

async function loadRaw(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function bbox({ data, width, height }, alphaMin = 15) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crop(img, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const src = ((y + box.minY) * img.width + box.minX) * 4;
    img.data.copy(out, y * box.w * 4, src, src + box.w * 4);
  }
  return { data: out, width: box.w, height: box.h };
}

// Connected components (4-conn) over pixels with alpha > 0 so each glyph
// keeps its anti-aliased skirt attached. Returns a label per pixel
// (-1 = transparent) plus per-component size and opaque-core color sums.
function components(img) {
  const { data, width, height } = img;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const comps = [];
  for (let p = 0; p < n; p++) {
    if (data[p * 4 + 3] > 0 && labels[p] === -1) {
      const id = comps.length;
      let sp = 0, size = 0, sr = 0, sg = 0, sb = 0, core = 0;
      stack[sp++] = p;
      labels[p] = id;
      while (sp > 0) {
        const cur = stack[--sp];
        size++;
        const a = data[cur * 4 + 3];
        if (a >= 200) {
          sr += data[cur * 4];
          sg += data[cur * 4 + 1];
          sb += data[cur * 4 + 2];
          core++;
        }
        const cx = cur % width, cy = (cur / width) | 0;
        const tryPush = (q) => {
          if (data[q * 4 + 3] > 0 && labels[q] === -1) { labels[q] = id; stack[sp++] = q; }
        };
        if (cx > 0) tryPush(cur - 1);
        if (cx < width - 1) tryPush(cur + 1);
        if (cy > 0) tryPush(cur - width);
        if (cy < height - 1) tryPush(cur + width);
      }
      comps.push({ id, size, core, r: core ? sr / core : 0, g: core ? sg / core : 0, b: core ? sb / core : 0 });
    }
  }
  return { labels, comps };
}

// Zero-out stray-speck components: everything smaller than minSize, plus
// "ghost clouds" — components whose peak alpha never exceeds 16 (≤6% opacity,
// imperceptible key-out residue), size-capped so a large legitimate soft
// shadow could never match. Solid detached details are ALWAYS preserved:
// the driver login-hero's tricycle + scooter mirror heads float disconnected
// (their thin stalks went semi-transparent in the original cutout) and must
// survive any cleanup — they are real artwork (verified visually 2026-07-01).
function dropSmallComponents(img, minSize) {
  const { data, width } = img;
  const { labels, comps } = components(img);
  const maxAlpha = new Array(comps.length).fill(0);
  for (let p = 0; p < width * img.height; p++) {
    const l = labels[p];
    if (l !== -1) {
      const a = data[p * 4 + 3];
      if (a > maxAlpha[l]) maxAlpha[l] = a;
    }
  }
  const drop = new Set(
    comps
      .filter((c) => c.size < minSize || (maxAlpha[c.id] <= 16 && c.size < 2000))
      .map((c) => c.id),
  );
  let removed = 0;
  for (let p = 0; p < img.width * img.height; p++) {
    if (labels[p] !== -1 && drop.has(labels[p])) {
      img.data.writeUInt32LE(0, p * 4);
      removed++;
    }
  }
  return { islands: drop.size, pixels: removed };
}

// Keep ONLY the largest component (notification-icon: pin without frame).
function keepLargestComponent(img) {
  const { labels, comps } = components(img);
  const keep = comps.reduce((a, b) => (b.size > a.size ? b : a), comps[0]).id;
  let removed = 0;
  for (let p = 0; p < img.width * img.height; p++) {
    if (labels[p] !== -1 && labels[p] !== keep) {
      img.data.writeUInt32LE(0, p * 4);
      removed++;
    }
  }
  return { dropped: comps.length - 1, pixels: removed };
}

// Recolor every component to a flat color chosen by its opaque-core hue
// (orange vs dark), preserving the alpha channel (all the anti-aliasing
// of this artwork lives in alpha — RGB is flat per glyph).
function recolorComponents(img, darkTo, orangeTo) {
  const { labels, comps } = components(img);
  const colorFor = comps.map((c) => (c.r > 180 && c.g < 140 ? orangeTo : darkTo));
  let orange = 0, dark = 0;
  comps.forEach((c, i) => (colorFor[i] === orangeTo ? orange++ : dark++));
  for (let p = 0; p < img.width * img.height; p++) {
    const l = labels[p];
    if (l !== -1) {
      const c = colorFor[l];
      img.data[p * 4] = c.r;
      img.data[p * 4 + 1] = c.g;
      img.data[p * 4 + 2] = c.b;
    }
  }
  return { dark, orange };
}

function cloneImg(img) {
  return { data: Buffer.from(img.data), width: img.width, height: img.height };
}

async function writePng(img, w, h, file, { pad = 0 } = {}) {
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let pipe = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(w - 2 * pad, h - 2 * pad, {
      fit: 'contain',
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  if (pad > 0) {
    pipe = pipe.extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  await pipe.png({ compressionLevel: 9 }).toFile(file);
  const after = fs.statSync(file).size;
  console.log(`  wrote ${path.relative(ROOT, file)}  ${w}x${h}  ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB`);
}

async function writeRawAsIs(img, file) {
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
  const after = fs.statSync(file).size;
  console.log(`  wrote ${path.relative(ROOT, file)}  ${img.width}x${img.height}  ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB`);
}

// ---------- 1) wordmarks from the HD master ----------

async function regenerateWordmarks() {
  console.log('1) Wordmarks from wordmark-hd.png');
  const master = await loadRaw(P('apps/client/assets/wordmark-hd.png'));
  const content = crop(master, bbox(master));

  // The HD master carries ~330 sub-perceptual low-alpha crumbs (alpha 1-40)
  // floating around the glyphs. Invisible, but drop them so the regenerated
  // exports are byte-clean (the 9 real glyph components are thousands of px).
  const pre = dropSmallComponents(content, 100);
  console.log(`  master pre-clean: dropped ${pre.islands} low-alpha crumbs (${pre.pixels}px)`);

  const dark = cloneImg(content);
  const d = recolorComponents(dark, DARK, ORANGE);
  console.log(`  master content ${content.width}x${content.height} — comps: ${d.dark} dark + ${d.orange} orange`);

  const white = cloneImg(content);
  recolorComponents(white, WHITE, ORANGE);

  // Same canvas sizes + filenames as today → zero code changes.
  const DARK_TARGETS = [
    ['apps/client/assets/logo-wordmark.png', 600, 143],
    ['apps/driver/assets/logo-wordmark.png', 600, 143],
    ['apps/web/public/logo-wordmark.png', 600, 143],
    ['apps/web/public/logo-email-light.png', 336, 80],
    ['apps/admin/public/logo-wordmark.png', 400, 96], // was 200x48 + baked white box; 2x + real alpha (pages use h-10 w-auto)
  ];
  const WHITE_TARGETS = [
    ['apps/client/assets/logo-wordmark-white.png', 600, 143],
    ['apps/driver/assets/logo-wordmark-white.png', 600, 143],
    ['apps/web/public/logo-wordmark-white.png', 600, 143],
    ['apps/web/public/logo-email-dark.png', 336, 80],
    ['apps/admin/public/logo-wordmark-white.png', 400, 96],
  ];
  for (const [file, w, h] of DARK_TARGETS) await writePng(dark, w, h, P(file));
  for (const [file, w, h] of WHITE_TARGETS) await writePng(white, w, h, P(file));
}

// ---------- 2) notification-icon (client): drop frame + specks ----------

async function fixNotificationIcon() {
  console.log('2) notification-icon.png (client): keep pin, drop frame + specks');
  const file = P('apps/client/assets/notification-icon.png');
  const img = await loadRaw(file);
  const r = keepLargestComponent(img);
  console.log(`  dropped ${r.dropped} components (${r.pixels}px: frame bars + specks)`);
  await writeRawAsIs(img, file);
}

// ---------- 3+4) stray-speck cleanup ----------

async function cleanStrays() {
  console.log('3) login-hero.png: remove stray islands');
  for (const rel of ['apps/client/assets/login-hero.png', 'apps/driver/assets/login-hero.png']) {
    const img = await loadRaw(P(rel));
    const r = dropSmallComponents(img, 50);
    console.log(`  ${rel}: removed ${r.islands} islands (${r.pixels}px)`);
    await writeRawAsIs(img, P(rel));
  }

  console.log('4) dropoff-pin.png: remove stray pixels (clean once, write 3 copies)');
  const pin = await loadRaw(P('apps/client/assets/markers/dropoff-pin.png'));
  const r = dropSmallComponents(pin, 50);
  console.log(`  removed ${r.islands} islands (${r.pixels}px)`);
  for (const rel of [
    'apps/client/assets/markers/dropoff-pin.png',
    'apps/driver/assets/markers/dropoff-pin.png',
    'apps/web/public/markers/dropoff-pin.png',
  ]) {
    await writeRawAsIs(pin, P(rel));
  }
}

// ---------- 5) web PWA icons from the 1024 master ----------

async function regenerateIcon512() {
  console.log('5) apps/web/public/icon-512.png + icon-192.png from client icon.png (1024)');
  const img = await loadRaw(P('apps/client/assets/icon.png'));
  await writePng(img, 512, 512, P('apps/web/public/icon-512.png'));
  // icon-192 shipped in the OLD rounded-square-on-white style (baked white
  // corners) while icon-512 went full-bleed — regenerate it from the same
  // master so both PWA icons are consistent and safe to declare
  // `purpose: "any maskable"` in manifest.json (the launcher applies its own
  // rounded mask; baked white corners would show inside the mask otherwise).
  await writePng(img, 192, 192, P('apps/web/public/icon-192.png'));
}

// ---------- 6) tricoin-small from tricoin-logo@3x ----------

async function regenerateTricoinSmall() {
  console.log('6) tricoin-small from tricoin-logo@3x.png (crop coin bbox, ~88% fill)');
  const logo = await loadRaw(P('apps/client/assets/coins/tricoin-logo@3x.png'));
  const coin = crop(logo, bbox(logo));
  const targets = [
    ['apps/client/assets/coins/tricoin-small.png', 24],
    ['apps/client/assets/coins/tricoin-small@2x.png', 48],
    ['apps/client/assets/coins/tricoin-small@3x.png', 72],
    ['apps/driver/assets/coins/tricoin-small.png', 24],
    ['apps/driver/assets/coins/tricoin-small@2x.png', 48],
    ['apps/driver/assets/coins/tricoin-small@3x.png', 72],
    ['apps/web/public/images/coins/tricoin-small.png', 48],
  ];
  for (const [file, size] of targets) {
    await writePng(coin, size, size, P(file), { pad: Math.max(1, Math.round(size * 0.06)) });
  }
}

(async () => {
  await regenerateWordmarks();
  await fixNotificationIcon();
  await cleanStrays();
  await regenerateIcon512();
  await regenerateTricoinSmall();
  console.log('Done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
