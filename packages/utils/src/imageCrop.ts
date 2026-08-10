// ============================================================
// Crop maths for a fixed-aspect image picker.
//
// Pure arithmetic, no DOM: the UI positions the image with CSS and then asks
// this module which rectangle of the SOURCE pixels ended up inside the window,
// so `canvas.drawImage` can cut exactly that.
//
// It lives here, tested, because it is the part that can be wrong without
// looking wrong: an off-by-one source rect still renders a picture, just not
// the one the admin framed — the precise failure the crop UI exists to prevent.
// ============================================================

export interface CropInput {
  /** Natural pixel size of the source image. */
  imgW: number;
  imgH: number;
  /** The framing window, in CSS px. Its ratio is the published ratio. */
  boxW: number;
  boxH: number;
  /** 1 = the image just covers the window. Larger crops in further. */
  zoom: number;
  /** Pan, in CSS px, from centred. Positive x moves the image right. */
  offsetX: number;
  offsetY: number;
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Smallest scale at which the image still covers the window — the LARGER of the
 * two axis ratios. Using the smaller one is the classic mistake: it fits the
 * image inside the window and leaves empty bands.
 */
export function coverScale(imgW: number, imgH: number, boxW: number, boxH: number): number {
  if (!(imgW > 0) || !(imgH > 0) || !(boxW > 0) || !(boxH > 0)) return 1;
  return Math.max(boxW / imgW, boxH / imgH);
}

/**
 * How far the image may be panned before an edge would come inside the window.
 * Zero on an axis the image only just covers — there is nothing to slide.
 */
export function cropOffsetBounds(input: Omit<CropInput, 'offsetX' | 'offsetY'>): { maxX: number; maxY: number } {
  const { imgW, imgH, boxW, boxH, zoom } = input;
  const scale = coverScale(imgW, imgH, boxW, boxH) * (zoom > 0 ? zoom : 1);
  return {
    maxX: Math.max(0, (imgW * scale - boxW) / 2),
    maxY: Math.max(0, (imgH * scale - boxH) / 2),
  };
}

/** Clamp a pan so the window is never left partly empty. */
export function clampCropOffset(input: CropInput): { x: number; y: number } {
  const { maxX, maxY } = cropOffsetBounds(input);
  const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(-max, v)) : 0);
  return { x: clamp(input.offsetX, maxX), y: clamp(input.offsetY, maxY) };
}

/**
 * Where the scaled image sits inside the window, in CSS px.
 *
 * The UI positions the preview with exactly this, so the picture on screen and
 * the rectangle `computeCropRect` cuts are derived from ONE calculation. Done
 * separately they can drift, and a drifted preview is the one bug this whole
 * feature exists to prevent: you frame one thing and publish another.
 */
export function computeDisplayRect(input: CropInput): { left: number; top: number; width: number; height: number } {
  const { imgW, imgH, boxW, boxH } = input;
  if (!(imgW > 0) || !(imgH > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = coverScale(imgW, imgH, boxW, boxH) * (input.zoom > 0 ? input.zoom : 1);
  const { x, y } = clampCropOffset(input);
  const width = imgW * scale;
  const height = imgH * scale;
  return { left: (boxW - width) / 2 + x, top: (boxH - height) / 2 + y, width, height };
}

/**
 * The rectangle of SOURCE pixels currently framed by the window.
 *
 * Feed it straight to:
 *   ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
 *
 * `sw/sh` always equals `boxW/boxH`, and the rect is always inside the image —
 * both are asserted in the tests. Outside the image, canvas quietly paints
 * transparent edges instead of failing.
 */
export function computeCropRect(input: CropInput): CropRect {
  const { imgW, imgH, boxW, boxH } = input;
  if (!(imgW > 0) || !(imgH > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { sx: 0, sy: 0, sw: 0, sh: 0 };
  }

  const scale = coverScale(imgW, imgH, boxW, boxH) * (input.zoom > 0 ? input.zoom : 1);
  // Same placement the preview renders — one source of truth for both.
  const { left, top } = computeDisplayRect(input);

  // The window's own top-left is (0,0); divide back out of scale to land in
  // source pixels. Clamped again against float drift at the extremes, so the
  // rect cannot poke a fraction of a pixel outside the bitmap.
  const sw = boxW / scale;
  const sh = boxH / scale;
  const sx = Math.min(Math.max(-left / scale, 0), Math.max(0, imgW - sw));
  const sy = Math.min(Math.max(-top / scale, 0), Math.max(0, imgH - sh));

  return { sx, sy, sw, sh };
}
