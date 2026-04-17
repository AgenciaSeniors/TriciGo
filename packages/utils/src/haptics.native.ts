/**
 * Haptic feedback utilities — native implementation.
 * Metro resolves this file on iOS/Android; webpack ignores `.native.ts`.
 * Static import ensures expo-haptics is registered as a bundle dependency.
 */

import * as Haptics from 'expo-haptics';

export async function triggerHaptic(
  type: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' = 'medium',
): Promise<void> {
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
    // Haptic call failed (device doesn't support, permissions, etc.)
  }
}

export async function triggerSelection(): Promise<void> {
  try {
    return Haptics.selectionAsync();
  } catch {
    // Selection haptic failed
  }
}
