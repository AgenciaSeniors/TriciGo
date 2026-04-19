#!/usr/bin/env node
// Sync service selection icons from the mockup-approved versions
// (docs/mockups/icons/) into the client app's asset bundle at
// apps/client/assets/vehicles/selection/. Handles @1x/@2x/@3x.
//
// Auto is the new Almendrón (classic Cuban car). The rest are the
// user's existing 3D renders.

const sharp = require('sharp');
const path = require('path');

const SRC = 'docs/mockups/icons';
const DEST = 'apps/client/assets/vehicles/selection';

const ICONS = ['auto', 'confort', 'mensajeria', 'moto', 'triciclo'];
const SIZES = [
  { suffix: '', size: 128 },
  { suffix: '@2x', size: 256 },
  { suffix: '@3x', size: 384 },
];

async function main() {
  for (const icon of ICONS) {
    // Use the @3x source for highest quality, then downscale
    const src = path.join(SRC, `${icon}@3x.png`);
    for (const { suffix, size } of SIZES) {
      const out = path.join(DEST, `${icon}${suffix}.png`);
      await sharp(src)
        .resize(size, size, {
          fit: 'contain',
          kernel: 'lanczos3',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toFile(out);
    }
    console.log(`✓ ${icon} (3 sizes: 128/256/384)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
