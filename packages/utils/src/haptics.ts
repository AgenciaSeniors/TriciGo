/**
 * Haptic feedback utilities.
 * On native (Expo), expo-haptics loads normally.
 * On web (Next.js), the import fails silently and haptics are no-ops.
 */

let _haptics: any = null;
let _hapticsLoaded = false;

function getHaptics(): any {
  if (_hapticsLoaded) return _haptics;
  _hapticsLoaded = true;
  try {
    // Static require so Metro/Hermes can resolve the module at bundle time
    _haptics = require('expo-haptics');
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
