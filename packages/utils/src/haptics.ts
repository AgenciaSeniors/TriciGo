/**
 * Haptic feedback utilities.
 * Uses indirect require to prevent webpack (Next.js) from trying to bundle expo-haptics.
 * In Expo apps, the module loads normally. In Next.js/web, the require silently fails.
 */

// Indirect require prevents webpack static analysis from tracing expo-haptics
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const _require = typeof require !== 'undefined' ? require : undefined;
const HAPTICS_MODULE = 'expo-' + 'haptics';

function getHaptics(): any {
  try {
    return _require?.(HAPTICS_MODULE);
  } catch {
    return null;
  }
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
