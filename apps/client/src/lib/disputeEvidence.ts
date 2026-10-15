/**
 * Dispute evidence upload: puts each photo the rider attached in the
 * `dispute-evidence` bucket and returns their public URLs, in order.
 *
 * Extracted from app/ride/dispute/[rideId].tsx so it is reachable by tests:
 * apps/client has no React Native renderer.
 *
 * Each photo gets its own file in disputes/{rideId}/{userId}/: the
 * storage-upload Edge Function only accepts the uploader's own folder of a
 * ride they are a party to.
 */
import { getSupabaseClient, uploadFileFromUri } from '@tricigo/api';

export async function uploadDisputeEvidence(
  rideId: string,
  userId: string,
  evidenceUris: string[],
): Promise<string[]> {
  if (evidenceUris.length === 0) return [];

  const supabase = getSupabaseClient();
  const urls: string[] = [];

  for (let i = 0; i < evidenceUris.length; i++) {
    const uri = evidenceUris[i]!;
    const ext = uri.split('.').pop() || 'jpg';
    const fileName = `${Date.now()}_${i}.${ext}`;
    const storagePath = `disputes/${rideId}/${userId}/${fileName}`;

    // RN-safe upload via FormData. fetch(uri).blob() throws
    // "Network request failed" on native. See _storage-upload.ts.
    await uploadFileFromUri('dispute-evidence', storagePath, uri, {
      fileName,
      mimeType: `image/${ext}`,
    });

    const { data: urlData } = supabase.storage
      .from('dispute-evidence')
      .getPublicUrl(storagePath);
    urls.push(urlData.publicUrl);
  }

  return urls;
}
