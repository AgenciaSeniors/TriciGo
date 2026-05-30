// ============================================================
// TriciGo — Storage upload helper (RN-safe)
// ============================================================

import { getSupabaseClient } from '../client';

/**
 * Upload a local file (native `file://`, `content://`, or `ph://` URI) to a
 * Supabase Storage bucket using FormData.
 *
 * WHY FormData and not `fetch(uri).blob()`:
 * On React Native (iOS + Android) `fetch()` does NOT support the `file://`,
 * `content://`, or `ph://` URI schemes, so `await fetch(uri)` → `.blob()` throws
 * **"Network request failed"**. FormData with the RN file descriptor
 * `{ uri, name, type }` is the canonical RN-safe upload path (and works on web
 * too, where RN's FormData polyfill resolves the URI). Mirrors the proven
 * pattern in `driver.service.ts` `uploadDocument` + `auth.service.ts`
 * `uploadAvatar`.
 *
 * Throws the Supabase storage error on failure.
 */
export async function uploadFileFromUri(
  bucket: string,
  storagePath: string,
  uri: string,
  opts: { fileName: string; mimeType?: string; upsert?: boolean },
): Promise<void> {
  const supabase = getSupabaseClient();

  const formData = new FormData();
  formData.append('', {
    uri,
    name: opts.fileName,
    type: opts.mimeType ?? 'image/jpeg',
  } as unknown as Blob);

  const { error } = await supabase.storage.from(bucket).upload(storagePath, formData, {
    contentType: 'multipart/form-data',
    upsert: opts.upsert ?? false,
  });
  if (error) throw error;
}
