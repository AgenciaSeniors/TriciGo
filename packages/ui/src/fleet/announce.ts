import { AccessibilityInfo } from 'react-native';

/**
 * A message that appears on screen is silent for a screen reader. Queued so
 * VoiceOver does not cut it off to read the button the user just tapped.
 */
export function announce(message: string) {
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}
