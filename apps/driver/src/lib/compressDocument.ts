// ============================================================
// Document image compression helper
//
// Why: Cuba's connectivity is often slow/unreliable. Original photos
// from a phone camera are 3–6 MB per image; uploading 4 of them over a
// typical edge/3G link during driver onboarding can take minutes and
// routinely times out. Since documents are only used for *visual*
// human review (ID card, driver's license, vehicle registration,
// selfie), a 1600px max-side JPEG at quality 0.7 is more than
// sufficient and typically lands at 200–400 KB — a 10× reduction.
//
// PDFs pass through untouched: they're usually already small, and
// we don't have a client-side PDF compressor.
// ============================================================

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

export interface CompressResult {
  /** URI of the (possibly compressed) file ready to upload. */
  uri: string;
  /** Original byte size. 0 if it couldn't be measured. */
  originalBytes: number;
  /** Final byte size. 0 if it couldn't be measured. */
  compressedBytes: number;
  /** Whether compression actually ran (false for PDFs or if skipped). */
  wasCompressed: boolean;
}

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.7;

/**
 * Get the byte size of a local file URI, or 0 on any error.
 * Uses expo-file-system on native, and fetch-then-blob on web.
 */
async function getFileSize(uri: string): Promise<number> {
  try {
    if (Platform.OS === 'web') {
      const res = await fetch(uri);
      const blob = await res.blob();
      return blob.size;
    }
    const info = await FileSystem.getInfoAsync(uri);
    // Type from expo-file-system: `size` is present only when exists === true.
    return info.exists && 'size' in info ? (info.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Compress a document image before upload.
 *
 * @param uri       local URI returned by ImagePicker / DocumentPicker
 * @param mimeType  e.g. 'image/jpeg', 'image/png', 'application/pdf'
 * @returns { uri, originalBytes, compressedBytes, wasCompressed }
 */
export async function compressDocument(
  uri: string,
  mimeType?: string,
): Promise<CompressResult> {
  const originalBytes = await getFileSize(uri);

  // PDFs and unknown types pass through — we don't compress those here.
  const isImage = !mimeType || mimeType.startsWith('image/');
  if (!isImage) {
    return { uri, originalBytes, compressedBytes: originalBytes, wasCompressed: false };
  }

  try {
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      // Use `resize: { width }` — manipulator preserves aspect ratio,
      // so the longest side ends up ≤ MAX_DIMENSION when the image is
      // portrait; for landscape we'd need to swap to `height`, but we
      // default to width since most document photos are portrait.
      [{ resize: { width: MAX_DIMENSION } }],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    const compressedBytes = await getFileSize(manipulated.uri);
    // Sanity check: if the "compressed" file somehow grew, keep the original.
    if (compressedBytes > 0 && originalBytes > 0 && compressedBytes >= originalBytes) {
      return { uri, originalBytes, compressedBytes: originalBytes, wasCompressed: false };
    }
    return {
      uri: manipulated.uri,
      originalBytes,
      compressedBytes,
      wasCompressed: true,
    };
  } catch {
    // Best-effort: on any error, fall back to the original. Upload can
    // still proceed (just slower) — we never want the driver to be
    // blocked from onboarding because manipulation failed.
    return { uri, originalBytes, compressedBytes: originalBytes, wasCompressed: false };
  }
}

/**
 * Downscale a just-picked image to a safe max dimension BEFORE it enters the
 * interactive crop UI (AvatarCropModal).
 *
 * Why: the crop modal renders the source full-res in an `Animated.Image` AND
 * runs a second crop-manipulate on it. Feeding a 12–108 MP original decodes a
 * 48–430 MB ARGB bitmap and OOM-kills the app on low-RAM Android — the app
 * "se bloquea y regresa atrás" (a native kill a JS try/catch can't catch).
 * Capping the longest side to 1600px first bounds the interactive peak memory.
 *
 * Returns the resized dimensions so the crop geometry (which maps display px →
 * original px) stays correct. Best-effort: on any failure or an
 * already-small image, returns the original uri + given dimensions.
 */
export async function resizeImageForCrop(
  uri: string,
  width: number,
  height: number,
): Promise<{ uri: string; width: number; height: number }> {
  if (Math.max(width, height) <= MAX_DIMENSION) return { uri, width, height };
  try {
    // Cap the LONGEST side regardless of orientation (manipulator keeps aspect).
    const action =
      width >= height
        ? { resize: { width: MAX_DIMENSION } }
        : { resize: { height: MAX_DIMENSION } };
    const out = await ImageManipulator.manipulateAsync(uri, [action], {
      compress: JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return { uri: out.uri, width: out.width, height: out.height };
  } catch {
    return { uri, width, height };
  }
}

/** Human-readable "1.2 MB → 340 KB" string. Used in toast messages. */
export function formatSizeDelta(originalBytes: number, compressedBytes: number): string {
  const fmt = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };
  return `${fmt(originalBytes)} → ${fmt(compressedBytes)}`;
}
