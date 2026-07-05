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

// bbox of pixels matching a color predicate (opaque-art masters where the
// subject is segmented by color, not alpha).
function colorBbox({ data, width, height }, keep) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 8 && keep(data[i], data[i + 1], data[i + 2])) {
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

// Surgical defringe (white-matte decontamination). Semi-transparent edge
// pixels that are much BRIGHTER than every opaque pixel around them carry
// leftover white matte from the original background key-out — legitimate
// anti-aliasing can never exceed the luma of the artwork it belongs to.
// Recolor ONLY those pixels to the average color of the nearest opaque ring;
// alpha and every opaque pixel stay byte-identical, so shapes cannot change.
// Soft shadows (no opaque neighbor within radius 3) are left untouched.
// NOTE: do NOT run this on assets with intentional bright semi-transparency
// next to dark art (e.g. the selection cars' window reflections).
function defringe(img, lumaDelta = 40) {
  const { data, width, height } = img;
  const orig = Buffer.from(data);
  const lum = (b, i) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
  let fixed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const A = orig[p + 3];
      if (A === 0 || A >= 240) continue;
      let sr = 0, sg = 0, sb = 0, n = 0, maxOl = -1;
      for (let rad = 1; rad <= 3 && n === 0; rad++) {
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue; // ring only
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const q = (ny * width + nx) * 4;
            if (orig[q + 3] >= 240) {
              sr += orig[q]; sg += orig[q + 1]; sb += orig[q + 2]; n++;
              const ol = lum(orig, q);
              if (ol > maxOl) maxOl = ol;
            }
          }
        }
      }
      if (n === 0) continue;                       // soft shadow — leave
      if (lum(orig, p) <= maxOl + lumaDelta) continue; // plausible art color — leave
      data[p] = Math.round(sr / n);
      data[p + 1] = Math.round(sg / n);
      data[p + 2] = Math.round(sb / n);
      fixed++;
    }
  }
  return { fixed };
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
    // Email logos ship at 3x (504x120) of the fixed 168x40 <img> in
    // email-templates/_layout.ts — the ONLY consumer (re-grep before
    // changing) — so high-DPI mail apps (Gmail/iOS) render them crisp.
    // Canvas aspect unchanged (504/120 = 336/80 = 4.2) → identical look.
    ['apps/web/public/logo-email-light.png', 504, 120],
    ['apps/admin/public/logo-wordmark.png', 400, 96], // was 200x48 + baked white box; 2x + real alpha (pages use h-10 w-auto)
  ];
  const WHITE_TARGETS = [
    ['apps/client/assets/logo-wordmark-white.png', 600, 143],
    ['apps/driver/assets/logo-wordmark-white.png', 600, 143],
    ['apps/web/public/logo-wordmark-white.png', 600, 143],
    ['apps/web/public/logo-email-dark.png', 504, 120],
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
  console.log('3) login-hero.png: remove stray islands + defringe dark edges');
  for (const rel of ['apps/client/assets/login-hero.png', 'apps/driver/assets/login-hero.png']) {
    const img = await loadRaw(P(rel));
    const r = dropSmallComponents(img, 50);
    // The vehicles were cut out from a white background — dark silhouette
    // edges (canopy, seats, boxes) still carry a 1px bright matte fringe.
    const d = defringe(img);
    console.log(`  ${rel}: removed ${r.islands} islands (${r.pixels}px), defringed ${d.fixed} edge px`);
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

// ---------- 4b) client icon master: flatten the ghost seam ----------

// #723 made the client icon full-bleed by extending the old rounded-square;
// a faint ghost of the old corner arc (salmon ~rgb(252,150,115), up to
// delta 117 vs the flat orange rgb(254,66,2)) plus low-level noise survived
// in the background. The design is a FLAT orange field + white pin (no
// gradient, no shadow — verified: every "darker" deviation is delta<=7
// noise), so everything outside the pin's expanded bbox is flattened to the
// dominant orange. Safety fuse: abort if any background pixel deviates more
// than the mapped seam (delta>130) — that would mean unexpected art.
async function fixIconSeam() {
  console.log('4b) apps/client/assets/icon.png: flatten corner ghost seam');
  const file = P('apps/client/assets/icon.png');
  const img = await loadRaw(file);
  const { data, width, height } = img;
  const px = (x, y) => (y * width + x) * 4;
  // dominant flat orange from the 4 deep corners
  const corners = [[10, 10], [width - 11, 10], [10, height - 11], [width - 11, height - 11]];
  const dom = [0, 1, 2].map((c) => Math.round(corners.reduce((a, [x, y]) => a + data[px(x, y) + c], 0) / 4));
  // pin bbox = near-white pixels, expanded 8px so its anti-aliasing is safe
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = px(x, y);
    if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const M = 8;
  minX -= M; minY -= M; maxX += M; maxY += M;
  let flattened = 0, maxDev = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
    const i = px(x, y);
    const d = Math.max(Math.abs(data[i] - dom[0]), Math.abs(data[i + 1] - dom[1]), Math.abs(data[i + 2] - dom[2]));
    if (d > maxDev) maxDev = d;
    if (d > 130) throw new Error(`fixIconSeam: unexpected art outside pin bbox at ${x},${y} (delta ${d}) — aborting`);
    if (d > 0) { data[i] = dom[0]; data[i + 1] = dom[1]; data[i + 2] = dom[2]; flattened++; }
  }
  console.log(`  pin bbox (${minX + M},${minY + M})-(${maxX - M},${maxY - M}), dominant rgb(${dom.join(',')}), flattened ${flattened}px (maxDev ${maxDev})`);
  // preserve the original RGB (no alpha) format of the master
  const before = fs.statSync(file).size;
  await sharp(data, { raw: { width, height, channels: 4 } }).removeAlpha().png({ compressionLevel: 9 }).toFile(file);
  console.log(`  wrote apps/client/assets/icon.png  ${width}x${height}  ${(before / 1024).toFixed(1)}KB -> ${(fs.statSync(file).size / 1024).toFixed(1)}KB`);
}

// ---------- 4c) driver icon master: geometric parity with the client ----------

// #732 recomposed the driver icon full-bleed and scaled its hollow pin +10%
// (optical compensation next to the client's solid pin). That left the two
// launcher icons geometrically UNEQUAL: driver pin 75.5% of canvas height
// vs client 69% — visibly different sizes side by side on iOS / the stores.
// New rule (user decision 2026-07-05): the pins are geometric twins. The
// client master is the single source of truth — its pin bbox is measured at
// runtime (never hardcoded) and the driver symbol (pin + bolt) is scaled
// and positioned to the same height and center. Idempotent: skips when the
// driver symbol already matches the client metrics within tolerance.
async function fixDriverIcon() {
  console.log('4c) apps/driver/assets/icon.png: match client pin geometry');
  const file = P('apps/driver/assets/icon.png');

  // Reference metrics: client pin = near-white pixels on the flat orange.
  const client = await loadRaw(P('apps/client/assets/icon.png'));
  const ref = colorBbox(client, (r, g, b) => r > 240 && g > 240 && b > 240);
  const refCx = (ref.minX + ref.maxX) / 2, refCy = (ref.minY + ref.maxY) / 2;

  const img = await loadRaw(file);
  const { data, width, height } = img;
  const px = (x, y) => (y * width + x) * 4;
  const corners = [[10, 10], [width - 11, 10], [10, height - 11], [width - 11, height - 11]];
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((a, [x, y]) => a + data[px(x, y) + c], 0) / 4));
  // driver symbol bbox = pixels deviating strongly from the near-black bg
  // (catches the white pin AND the orange bolt; both share the pin's bbox)
  const sym = colorBbox(img, (r, g, b) =>
    Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > 60);
  const symCx = (sym.minX + sym.maxX) / 2, symCy = (sym.minY + sym.maxY) / 2;

  if (Math.abs(sym.h - ref.h) <= 6 && Math.abs(symCx - refCx) <= 4 && Math.abs(symCy - refCy) <= 4) {
    console.log(`  symbol ${sym.w}x${sym.h} @ (${symCx},${symCy}) already matches client ${ref.w}x${ref.h} @ (${refCx},${refCy}) — skip (idempotent)`);
    return;
  }

  const M = 6, s = ref.h / sym.h;
  const crop = { left: sym.minX - M, top: sym.minY - M, width: sym.w + 2 * M, height: sym.h + 2 * M };
  const newW = Math.round(crop.width * s), newH = Math.round(crop.height * s);
  // place so the symbol center lands exactly on the client pin center
  const left = Math.round(refCx - (symCx - crop.left) * s);
  const top = Math.round(refCy - (symCy - crop.top) * s);
  // safety fuse: the placed symbol must keep >=60px margin (iOS corner mask)
  if (left < 60 || top < 60 || left + newW > width - 60 || top + newH > height - 60) {
    throw new Error('fixDriverIcon: parity-scaled symbol would leave <60px margin — aborting');
  }
  const scaledPin = await sharp(data, { raw: { width, height, channels: 4 } })
    .extract(crop)
    .resize(newW, newH, { kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .png().toBuffer();
  const before = fs.statSync(file).size;
  await sharp({ create: { width, height, channels: 3, background: { r: bg[0], g: bg[1], b: bg[2] } } })
    .composite([{ input: scaledPin, left, top }])
    .png({ compressionLevel: 9 }).toFile(file);
  console.log(`  symbol ${sym.w}x${sym.h} @ (${symCx},${symCy}) scaled x${s.toFixed(4)} -> client parity ${ref.w}x${ref.h} @ (${refCx},${refCy}) on flat rgb(${bg.join(',')})`);
  console.log(`  wrote apps/driver/assets/icon.png  ${width}x${height}  ${(before / 1024).toFixed(1)}KB -> ${(fs.statSync(file).size / 1024).toFixed(1)}KB`);
}

// ---------- 4d) driver notification icon: match client glyph metrics ----------

// generate-driver-icon.js rendered the driver status-bar glyph with
// fit:'contain' into the full 96px canvas → glyph height 96/96 (touches the
// canvas edges) while the client glyph is 66/96. Android scales both icons
// to the same dp box, so the driver notification mark rendered ~45% bigger
// than the client's. Re-derive the silhouette from the (parity-matched)
// icon.png symbol at the client's measured glyph height and center.
async function fixDriverNotificationIcon() {
  console.log('4e) apps/driver/assets/notification-icon.png: match client glyph metrics');
  const file = P('apps/driver/assets/notification-icon.png');

  // Reference metrics: client glyph alpha bbox (56x66 in the 96 canvas).
  const refImg = await loadRaw(P('apps/client/assets/notification-icon.png'));
  const ref = bbox(refImg);
  const refCx = (ref.minX + ref.maxX) / 2, refCy = (ref.minY + ref.maxY) / 2;
  const canvas = refImg.width; // 96

  const cur = await loadRaw(file);
  const curB = bbox(cur);
  const curCx = (curB.minX + curB.maxX) / 2, curCy = (curB.minY + curB.maxY) / 2;
  if (Math.abs(curB.h - ref.h) <= 2 && Math.abs(curCx - refCx) <= 2 && Math.abs(curCy - refCy) <= 2) {
    console.log(`  glyph ${curB.w}x${curB.h} @ (${curCx},${curCy}) already matches client ${ref.w}x${ref.h} @ (${refCx},${refCy}) — skip (idempotent)`);
    return;
  }

  // Silhouette source: the hi-res icon.png symbol (white pin + orange bolt
  // → pure white alpha mask; Android tints notification icons itself).
  const icon = await loadRaw(P('apps/driver/assets/icon.png'));
  const px = (x, y) => (y * icon.width + x) * 4;
  const corners = [[10, 10], [icon.width - 11, 10], [10, icon.height - 11], [icon.width - 11, icon.height - 11]];
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((a, [x, y]) => a + icon.data[px(x, y) + c], 0) / 4));
  const mask = Buffer.alloc(icon.data.length);
  for (let i = 0; i < icon.data.length; i += 4) {
    const d = Math.max(Math.abs(icon.data[i] - bg[0]), Math.abs(icon.data[i + 1] - bg[1]), Math.abs(icon.data[i + 2] - bg[2]));
    if (d > 60) {
      mask[i] = 255; mask[i + 1] = 255; mask[i + 2] = 255; mask[i + 3] = 255;
    }
  }
  const maskImg = { data: mask, width: icon.width, height: icon.height };
  const symB = bbox(maskImg);
  const sil = crop(maskImg, symB);
  const newH = ref.h;
  const newW = Math.round(symB.w * (ref.h / symB.h));
  const scaled = await sharp(sil.data, { raw: { width: sil.width, height: sil.height, channels: 4 } })
    .resize(newW, newH, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .png().toBuffer();
  const left = Math.round(refCx - newW / 2), top = Math.round(refCy - newH / 2);
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: scaled, left, top }])
    .png({ compressionLevel: 9 }).toFile(file);
  console.log(`  glyph ${curB.w}x${curB.h} -> ${newW}x${newH} at (${left},${top}) — client parity ${ref.w}x${ref.h} @ (${refCx},${refCy})`);
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

// ---------- 7) defringe web line-icon assets ----------

async function defringeWebIcons() {
  console.log('7) defringe web vehicle line icons (bright matte residue on strokes)');
  for (const rel of [
    'apps/web/public/images/vehicles/auto.png',
    'apps/web/public/images/vehicles/markers/auto@2x.png',
  ]) {
    const img = await loadRaw(P(rel));
    const d = defringe(img);
    console.log(`  ${rel}: defringed ${d.fixed} edge px`);
    await writeRawAsIs(img, P(rel));
  }
}

(async () => {
  await regenerateWordmarks();
  await fixNotificationIcon();
  await cleanStrays();
  await fixIconSeam(); // must run BEFORE regenerateIcon512 (512/192 derive from the master)
  await fixDriverIcon(); // must run BEFORE fixDriverNotificationIcon (silhouette derives from icon.png)
  await fixDriverNotificationIcon();
  await regenerateIcon512();
  await regenerateTricoinSmall();
  await defringeWebIcons();
  console.log('Done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
