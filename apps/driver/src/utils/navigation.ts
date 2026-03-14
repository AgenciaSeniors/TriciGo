import { Linking, Platform } from 'react-native';

/**
 * Open external navigation app with directions to the given coordinates.
 * Priority: Waze → Google Maps (native) → Google Maps (web fallback).
 */
export async function openNavigation(lat: number, lng: number): Promise<void> {
  // Try Waze first (popular in Latin America)
  const wazeUrl = `waze://?ll=${lat},${lng}&navigate=yes`;
  try {
    const canWaze = await Linking.canOpenURL(wazeUrl);
    if (canWaze) {
      await Linking.openURL(wazeUrl);
      return;
    }
  } catch {
    // Waze not available, try next option
  }

  // Try native Google Maps
  const gmapsUrl = Platform.select({
    ios: `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`,
    android: `google.navigation:q=${lat},${lng}`,
  });

  if (gmapsUrl) {
    try {
      const canGmaps = await Linking.canOpenURL(gmapsUrl);
      if (canGmaps) {
        await Linking.openURL(gmapsUrl);
        return;
      }
    } catch {
      // Google Maps not available, use web fallback
    }
  }

  // Final fallback: Google Maps web
  await Linking.openURL(
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  );
}
