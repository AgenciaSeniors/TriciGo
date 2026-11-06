// ============================================================
// Picks a driver's licence photo for a fleet owner (driver app)
// The shared fleet screens take this as `onPickLicense`: they know
// nothing about expo-image-picker. Returns null when the owner cancels
// or does not allow access to their photos (ensurePickerPermission
// already told them why).
// ============================================================
import * as ImagePicker from 'expo-image-picker';
import { compressDocument } from '@/lib/compressDocument';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface PickedFleetLicense {
  uri: string;
  file_name: string;
  mime_type: string;
}

export async function pickFleetLicense(t: Translate): Promise<PickedFleetLicense | null> {
  if (!(await ensurePickerPermission('gallery', t))) return null;

  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.7 });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;

  const mimeType = asset.mimeType ?? 'image/jpeg';
  // Slow links: the same 1600 px JPEG the onboarding documents use.
  const compressed = await compressDocument(asset.uri, mimeType);
  const mime = compressed.wasCompressed ? 'image/jpeg' : mimeType;
  return {
    uri: compressed.uri,
    file_name: `license-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`,
    mime_type: mime,
  };
}
