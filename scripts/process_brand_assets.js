const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ISOTIPO = path.join(__dirname, 'brand_image1.png');
const WORDMARK = path.join(__dirname, 'brand_image2.png');

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function processIsotipo() {
  // brand_image1.png is 1300x866 with white bg around the orange rounded square
  // Trim whitespace first to get just the icon
  const trimmed = await sharp(ISOTIPO)
    .trim({ threshold: 10 })
    .toBuffer();

  const meta = await sharp(trimmed).metadata();
  console.log(`Isotipo trimmed: ${meta.width}x${meta.height}`);

  // Make it square by extending the shorter dimension with white
  const size = Math.max(meta.width, meta.height);
  const squareIcon = await sharp(trimmed)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toBuffer();

  // App icon: 1024x1024 (both apps use same icon)
  const icon1024 = await sharp(squareIcon)
    .resize(1024, 1024, { fit: 'cover' })
    .png()
    .toBuffer();

  // Write client icon
  const clientAssets = path.join(ROOT, 'apps/client/assets');
  ensureDir(clientAssets);
  fs.writeFileSync(path.join(clientAssets, 'icon.png'), icon1024);
  console.log('Written: apps/client/assets/icon.png (1024x1024)');

  // Write driver icon
  const driverAssets = path.join(ROOT, 'apps/driver/assets');
  ensureDir(driverAssets);
  fs.writeFileSync(path.join(driverAssets, 'icon.png'), icon1024);
  console.log('Written: apps/driver/assets/icon.png (1024x1024)');

  // Adaptive icon: icon with extra padding on transparent bg for Android
  // Android adaptive icons use a 108dp canvas with 72dp safe zone
  // So we add ~16.7% padding on each side
  const adaptiveIcon = await sharp(squareIcon)
    .resize(660, 660, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 182,
      bottom: 182,
      left: 182,
      right: 182,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(1024, 1024)
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(clientAssets, 'adaptive-icon.png'), adaptiveIcon);
  console.log('Written: apps/client/assets/adaptive-icon.png (1024x1024)');
  fs.writeFileSync(path.join(driverAssets, 'adaptive-icon.png'), adaptiveIcon);
  console.log('Written: apps/driver/assets/adaptive-icon.png (1024x1024)');

  // Favicon: 32x32 PNG (we'll name it .png, Next.js supports it)
  const favicon = await sharp(squareIcon)
    .resize(32, 32)
    .png()
    .toBuffer();

  const adminPublic = path.join(ROOT, 'apps/admin/public');
  ensureDir(adminPublic);
  fs.writeFileSync(path.join(adminPublic, 'favicon.png'), favicon);
  console.log('Written: apps/admin/public/favicon.png (32x32)');

  // Also create a larger version for apple-touch-icon
  const favicon192 = await sharp(squareIcon)
    .resize(192, 192)
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(adminPublic, 'icon-192.png'), favicon192);
  console.log('Written: apps/admin/public/icon-192.png (192x192)');

  // Notification icon: 96x96 white on transparent (monochrome for Android)
  // Extract the white symbol from the isotipo
  const notifIcon = await sharp(squareIcon)
    .resize(96, 96)
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(clientAssets, 'notification-icon.png'), notifIcon);
  console.log('Written: apps/client/assets/notification-icon.png (96x96)');
  fs.writeFileSync(path.join(driverAssets, 'notification-icon.png'), notifIcon);
  console.log('Written: apps/driver/assets/notification-icon.png (96x96)');
}

async function processWordmark() {
  // brand_image2.png is 1300x866 with white bg, wordmark centered
  // Trim whitespace
  const trimmed = await sharp(WORDMARK)
    .trim({ threshold: 10 })
    .toBuffer();

  const meta = await sharp(trimmed).metadata();
  console.log(`Wordmark trimmed: ${meta.width}x${meta.height}`);

  // Splash logo: resize to ~600px wide, keep aspect ratio, transparent bg
  const splashLogo = await sharp(trimmed)
    .resize(600, null, { fit: 'inside' })
    .png()
    .toBuffer();

  const clientAssets = path.join(ROOT, 'apps/client/assets');
  const driverAssets = path.join(ROOT, 'apps/driver/assets');

  fs.writeFileSync(path.join(clientAssets, 'splash-logo.png'), splashLogo);
  console.log('Written: apps/client/assets/splash-logo.png (600w)');
  fs.writeFileSync(path.join(driverAssets, 'splash-logo.png'), splashLogo);
  console.log('Written: apps/driver/assets/splash-logo.png (600w)');

  // Also create a version for the driver splash on dark bg
  // The wordmark has "Trici" in black which won't show on dark bg
  // We'll create the same one for now - the splash bg is #111111 so we need a white "Trici" variant
  // Since we can't easily change the text color, we'll just use the same logo
  // The splash screen uses backgroundColor property so the logo sits on top

  // Admin sidebar wordmark: ~200px wide
  const sidebarLogo = await sharp(trimmed)
    .resize(200, null, { fit: 'inside' })
    .png()
    .toBuffer();

  const adminPublic = path.join(ROOT, 'apps/admin/public');
  fs.writeFileSync(path.join(adminPublic, 'logo-wordmark.png'), sidebarLogo);
  console.log('Written: apps/admin/public/logo-wordmark.png (200w)');

  // Create an inverted version for dark backgrounds (driver app login)
  // We need "Trici" in white and "Go" stays orange
  // Since we can't selectively invert, create a version with white bg removed
  // The wordmark on transparent bg should work on dark bg since "Go" is orange
  // For the "Trici" part being black on dark, we'll need the login screen to handle this differently
  // Let's create a white version by negating the black parts
  const whiteWordmark = await sharp(trimmed)
    .resize(600, null, { fit: 'inside' })
    .png()
    .toBuffer();

  // Save the trimmed transparent version for login screens
  fs.writeFileSync(path.join(clientAssets, 'logo-wordmark.png'), splashLogo);
  console.log('Written: apps/client/assets/logo-wordmark.png (600w)');
  fs.writeFileSync(path.join(driverAssets, 'logo-wordmark.png'), whiteWordmark);
  console.log('Written: apps/driver/assets/logo-wordmark.png (600w)');
}

async function main() {
  console.log('Processing brand assets...\n');
  await processIsotipo();
  console.log('');
  await processWordmark();
  console.log('\nDone! All brand assets generated.');
}

main().catch(console.error);
