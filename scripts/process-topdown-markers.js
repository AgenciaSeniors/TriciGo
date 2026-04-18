#!/usr/bin/env node
// Process top-down vehicle marker images (from Downloads/img/) into
// 48/96/144 density variants for driver + client apps.
//
// Run: node scripts/process-topdown-markers.js

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC_DIR = 'C:\\Users\\Eduardo\\Downloads\\img';
const APPS = [
  'apps/driver/assets/vehicles/markers',
  'apps/client/assets/vehicles/markers',
];

const SIZES = [
  { suffix: '', size: 48 },
  { suffix: '@2x', size: 96 },
  { suffix: '@3x', size: 144 },
];

// Source filename → target basename
const MARKERS = {
  auto: 'Auto Para marcador del mapa (vista desde arriba).png',
  moto: 'Moto Para marcador del mapa (vista desde arriba).png',
  triciclo: 'Triciclo Para marcador del mapa (vista desde arriba).png',
  // Almendron is a separate vehicle icon — save it as `auto_clasico` marker
  // for the classic Cuban car service tier if used in map later.
  auto_clasico: 'Almendron Para marcador del mapa (vista desde arriba).png',
};

async function main() {
  for (const [name, srcName] of Object.entries(MARKERS)) {
    const srcPath = path.join(SRC_DIR, srcName);
    if (!fs.existsSync(srcPath)) {
      console.log(`[skip] ${srcName} — not found`);
      continue;
    }
    for (const app of APPS) {
      for (const { suffix, size } of SIZES) {
        const outPath = path.join(app, `${name}${suffix}.png`);
        await sharp(srcPath)
          .resize(size, size, {
            fit: 'contain',
            kernel: 'lanczos3',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png({ compressionLevel: 9 })
          .toFile(outPath);
      }
      console.log(`✓ ${app}/${name}.png (3 sizes)`);
    }
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
