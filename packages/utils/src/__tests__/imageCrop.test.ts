import { describe, it, expect } from 'vitest';
import { coverScale, clampCropOffset, computeCropRect, computeDisplayRect } from '../imageCrop';

// The partner-place window is 340x128 — 2.66:1. That is WIDER in ratio than
// almost any photograph, so for ordinary sources the WIDTH governs the fit and
// what gets cut is the top and bottom. Only a source even wider than the window
// (a panorama) is cropped at the sides instead.
const BOX = { boxW: 340, boxH: 128 };
const LANDSCAPE = { imgW: 1600, imgH: 1200 };   // 4:3
const PORTRAIT = { imgW: 1200, imgH: 1600 };    // 3:4
const PANORAMA = { imgW: 2000, imgH: 400 };     // 5:1 — wider than the window
const EXACT = { imgW: 680, imgH: 256 };         // already 340:128

describe('coverScale', () => {
  // "Cover" is the smallest scale that leaves no empty space: the LARGER of the
  // two axis ratios. Using the smaller one is the classic bug — it fits the
  // image inside the window and leaves bands.
  it('lets the width govern a 4:3 source', () => {
    expect(coverScale(LANDSCAPE.imgW, LANDSCAPE.imgH, BOX.boxW, BOX.boxH)).toBeCloseTo(340 / 1600, 6);
  });

  it('lets the width govern a portrait source too', () => {
    expect(coverScale(PORTRAIT.imgW, PORTRAIT.imgH, BOX.boxW, BOX.boxH)).toBeCloseTo(340 / 1200, 6);
  });

  it('lets the HEIGHT govern a source wider than the window', () => {
    expect(coverScale(PANORAMA.imgW, PANORAMA.imgH, BOX.boxW, BOX.boxH)).toBeCloseTo(128 / 400, 6);
  });

  it('is degenerate-safe', () => {
    expect(coverScale(0, 0, BOX.boxW, BOX.boxH)).toBe(1);
  });
});

describe('clampCropOffset', () => {
  it('gives a 4:3 source vertical slack and none horizontally', () => {
    // At cover the image is 340 x 255: width exact, height overflows.
    const { x, y } = clampCropOffset({ ...LANDSCAPE, ...BOX, zoom: 1, offsetX: 999, offsetY: 999 });
    expect(x).toBe(0);                              // nothing to slide sideways
    expect(y).toBeCloseTo((1200 * (340 / 1600) - 128) / 2, 6);
  });

  it('gives a panorama horizontal slack and none vertically', () => {
    const { x, y } = clampCropOffset({ ...PANORAMA, ...BOX, zoom: 1, offsetX: 999, offsetY: 999 });
    expect(y).toBe(0);
    expect(x).toBeGreaterThan(0);
  });

  it('never lets a drag pull an edge inside the window', () => {
    const { y } = clampCropOffset({ ...PORTRAIT, ...BOX, zoom: 1, offsetX: 0, offsetY: -99999 });
    const scale = coverScale(PORTRAIT.imgW, PORTRAIT.imgH, BOX.boxW, BOX.boxH);
    expect(y).toBeCloseTo(-(PORTRAIT.imgH * scale - BOX.boxH) / 2, 6);
  });

  it('gives an exact-ratio source no slack in either axis', () => {
    const { x, y } = clampCropOffset({ ...EXACT, ...BOX, zoom: 1, offsetX: 50, offsetY: 50 });
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('zooming in creates room to pan where there was none', () => {
    const { x } = clampCropOffset({ ...LANDSCAPE, ...BOX, zoom: 2, offsetX: 999, offsetY: 0 });
    expect(x).toBeGreaterThan(0);
  });
});

describe('computeCropRect', () => {
  // The invariant the whole feature rests on: the rect handed to drawImage must
  // sit INSIDE the source image. Outside it, canvas silently paints transparent
  // edges — the admin would frame one thing and publish another.
  const insideImage = (r: { sx: number; sy: number; sw: number; sh: number }, imgW: number, imgH: number) => {
    expect(r.sx).toBeGreaterThanOrEqual(-0.001);
    expect(r.sy).toBeGreaterThanOrEqual(-0.001);
    expect(r.sx + r.sw).toBeLessThanOrEqual(imgW + 0.001);
    expect(r.sy + r.sh).toBeLessThanOrEqual(imgH + 0.001);
  };

  it('uses a 4:3 source full width and cuts half its height', () => {
    const r = computeCropRect({ ...LANDSCAPE, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(r.sw).toBeCloseTo(LANDSCAPE.imgW, 6);
    expect(r.sh / LANDSCAPE.imgH).toBeCloseTo(0.5, 2);   // the 50% from the crop table
    expect(r.sy).toBeCloseTo((LANDSCAPE.imgH - r.sh) / 2, 6);
    insideImage(r, LANDSCAPE.imgW, LANDSCAPE.imgH);
  });

  it('keeps barely a quarter of a portrait source', () => {
    const r = computeCropRect({ ...PORTRAIT, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(r.sw).toBeCloseTo(PORTRAIT.imgW, 6);
    // ~28% — the number that makes an interactive crop worth building at all.
    expect(r.sh / PORTRAIT.imgH).toBeCloseTo(0.28, 2);
    insideImage(r, PORTRAIT.imgW, PORTRAIT.imgH);
  });

  it('crops a panorama at the sides instead', () => {
    const r = computeCropRect({ ...PANORAMA, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(r.sh).toBeCloseTo(PANORAMA.imgH, 6);
    expect(r.sw).toBeLessThan(PANORAMA.imgW);
    insideImage(r, PANORAMA.imgW, PANORAMA.imgH);
  });

  it('always yields the window ratio, whatever the source or zoom', () => {
    for (const src of [LANDSCAPE, PORTRAIT, PANORAMA, EXACT]) {
      for (const zoom of [1, 1.5, 3]) {
        const r = computeCropRect({ ...src, ...BOX, zoom, offsetX: 20, offsetY: -15 });
        expect(r.sw / r.sh).toBeCloseTo(BOX.boxW / BOX.boxH, 4);
        insideImage(r, src.imgW, src.imgH);
      }
    }
  });

  it('panning down shows the top of the image, and stops at the edge', () => {
    const rest = computeCropRect({ ...LANDSCAPE, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    // Dragging the image DOWN reveals what was above, so sy decreases to 0.
    const panned = computeCropRect({ ...LANDSCAPE, ...BOX, zoom: 1, offsetX: 0, offsetY: 9999 });
    expect(panned.sy).toBeLessThan(rest.sy);
    expect(panned.sy).toBeCloseTo(0, 6);
    insideImage(panned, LANDSCAPE.imgW, LANDSCAPE.imgH);
  });

  it('zooming shrinks the source window', () => {
    const a = computeCropRect({ ...LANDSCAPE, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    const b = computeCropRect({ ...LANDSCAPE, ...BOX, zoom: 2, offsetX: 0, offsetY: 0 });
    expect(b.sw).toBeCloseTo(a.sw / 2, 4);
    expect(b.sh).toBeCloseTo(a.sh / 2, 4);
    insideImage(b, LANDSCAPE.imgW, LANDSCAPE.imgH);
  });

  it('passes an exact-ratio source through whole', () => {
    const r = computeCropRect({ ...EXACT, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(r.sx).toBeCloseTo(0, 6);
    expect(r.sy).toBeCloseTo(0, 6);
    expect(r.sw).toBeCloseTo(EXACT.imgW, 6);
    expect(r.sh).toBeCloseTo(EXACT.imgH, 6);
  });

  it('survives a zero-sized image without producing NaN', () => {
    const r = computeCropRect({ imgW: 0, imgH: 0, ...BOX, zoom: 1, offsetX: 0, offsetY: 0 });
    for (const v of [r.sx, r.sy, r.sw, r.sh]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('computeDisplayRect ↔ computeCropRect', () => {
  // The preview is positioned with computeDisplayRect and the file is cut with
  // computeCropRect. If those two ever disagree the admin frames one thing and
  // publishes another — the exact failure the cropper exists to prevent. They
  // must stay inverses of each other.
  it('is the inverse of the crop rect, at every source, zoom and pan', () => {
    for (const src of [LANDSCAPE, PORTRAIT, PANORAMA, EXACT]) {
      for (const zoom of [1, 1.4, 2.5]) {
        for (const [ox, oy] of [[0, 0], [40, -30], [-9999, 9999]] as const) {
          const input = { ...src, ...BOX, zoom, offsetX: ox, offsetY: oy };
          const d = computeDisplayRect(input);
          const c = computeCropRect(input);
          const scale = d.width / src.imgW;

          // The window's top-left, expressed in source pixels, IS the crop origin.
          expect(-d.left / scale).toBeCloseTo(c.sx, 4);
          expect(-d.top / scale).toBeCloseTo(c.sy, 4);
          // And the window's size, in source pixels, IS the crop size.
          expect(BOX.boxW / scale).toBeCloseTo(c.sw, 4);
          expect(BOX.boxH / scale).toBeCloseTo(c.sh, 4);
        }
      }
    }
  });

  it('never leaves a gap inside the window', () => {
    for (const src of [LANDSCAPE, PORTRAIT, PANORAMA, EXACT]) {
      const d = computeDisplayRect({ ...src, ...BOX, zoom: 1, offsetX: 9999, offsetY: -9999 });
      expect(d.left).toBeLessThanOrEqual(0.001);
      expect(d.top).toBeLessThanOrEqual(0.001);
      expect(d.left + d.width).toBeGreaterThanOrEqual(BOX.boxW - 0.001);
      expect(d.top + d.height).toBeGreaterThanOrEqual(BOX.boxH - 0.001);
    }
  });
});
