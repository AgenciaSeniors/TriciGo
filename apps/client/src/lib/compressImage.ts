// ============================================================
// Image compression helper (client app)
//
// Why: Cuba's connectivity is slow/unreliable. Original gallery/camera
// photos are 3–12 MP (1.5–5 MB). Uploading several of them over an
// edge/3G link routinely times out. For dispute evidence (human visual
// review only) a 1600px-max JPEG at quality 0.7 is plenty and typically
// lands at ~150–400 KB — a large reduction.
//
// Mirror of apps/driver/src/lib/compressDocument.ts (per-app on purpose:
// it depends on expo-image-manipulator / expo-file-system, which are RN-only
// and must not become deps of the shared, web-consumed @tricigo/utils).
// ============================================================

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

export interface CompressResult {
  /** URI of the (possibly compressed) image ready to upload. */
  uri: string;
  /** Original byte size. 0 if it couldn't be measured. */
  originalBytes: number;
  /** Final byte size. 0 if it couldn't be measured. */
  compressedBytes: number;
  /** Whether compression actually ran. */
  wasCompressed: boolean;
}

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.7;

async function getFileSize(uri: string): Promise<number> {
  try {
    if (Platform.OS === 'web') {
      const res = await fetch(uri);
      const blob = await res.blob();
      return blob.size;
    }
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && 'size' in info ? (info.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Compress an image before upload. Always emits JPEG, which also normalizes
 * iOS HEIC/HEIF inputs (so the declared upload MIME matches the bytes).
 * Best-effort: on any error returns the original URI so the upload can still
 * proceed rather than blocking the user.
 */
export async function compressImage(uri: string): Promise<CompressResult> {
  const originalBytes = await getFileSize(uri);
  try {
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: MAX_DIMENSION } }],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    const compressedBytes = await getFileSize(manipulated.uri);
    if (compressedBytes > 0 && originalBytes > 0 && compressedBytes >= originalBytes) {
      return { uri, originalBytes, compressedBytes: originalBytes, wasCompressed: false };
    }
    return { uri: manipulated.uri, originalBytes, compressedBytes, wasCompressed: true };
  } catch {
    return { uri, originalBytes, compressedBytes: originalBytes, wasCompressed: false };
  }
}
