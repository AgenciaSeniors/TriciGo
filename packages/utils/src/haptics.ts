/**
 * Haptic feedback utilities.
 * On native (Expo), expo-haptics loads normally.
 * On web (Next.js), the require fails silently and haptics are no-ops.
 *
 * Uses indirect require with string concatenation to prevent webpack (Next.js)
 * from resolving the module at build time — otherwise Next tries to parse
 * expo-haptics and its transitive deps (expo, expo-modules-core, etc.), all
 * of which ship raw TypeScript that Next's default Webpack config can't parse.
 */

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const _require = typeof require !== 'undefined' ? require : undefined;
const HAPTICS_MODULE = 'expo-' + 'haptics';

let _haptics: any = null;
let _hapticsLoaded = false;

function getHaptics(): any {
  if (_hapticsLoaded) return _haptics;
  _hapticsLoaded = true;
  try {
    _haptics = _require?.(HAPTICS_MODULE);
  } catch {
    _haptics = null;
  }
  return _haptics;
}

export async function triggerHaptic(
  type: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' = 'medium',
): Promise<void> {
  const Haptics = getHaptics();
  if (!Haptics) return;

  try {
    switch (type) {
      case 'light':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      case 'medium':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case 'heavy':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      case 'success':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case 'warning':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      case 'error':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  } catch {
    // Haptic call failed
  }
}

export async function triggerSelection(): Promise<void> {
  const Haptics = getHaptics();
  if (!Haptics) return;

  try {
    return Haptics.selectionAsync();
  } catch {
    // Selection haptic failed
  }
}
