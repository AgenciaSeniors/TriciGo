import * as Location from 'expo-location';

/**
 * The foreground location permission, asking only when it is not granted yet.
 *
 * The home screen used to call requestForegroundPermissionsAsync on every
 * mount. With the permission already granted Android still opens and closes
 * its permission activity, so the app went to the background and back for
 * nothing, and everything tied to "came to the front" ran again (QA R3-06).
 */
export async function ensureForegroundLocationPermission(): Promise<Location.PermissionStatus> {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.status === 'granted') return current.status;
  } catch {
    // Fall through to asking: that is what this did before.
  }
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status;
}
