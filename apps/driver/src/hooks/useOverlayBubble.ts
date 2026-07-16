import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import DriverOverlay from '../../modules/driver-overlay';

/**
 * useOverlayBubble — show the floating chat-head over other apps ONLY while
 * the driver is online AND the app is backgrounded AND the user granted
 * "Display over other apps" (SYSTEM_ALERT_WINDOW). Hidden the moment the app
 * comes back to the foreground or the driver goes offline.
 *
 * While online, the expo-location foreground service (FD1) keeps the JS
 * runtime alive in the background, so this AppState listener actually runs
 * there. `canDrawOverlays()` is re-checked at every event — a mid-session
 * permission revocation degrades silently to the push-notification path.
 * Without the native module in the binary (old APK + OTA JS) every call is a
 * no-op via the requireOptionalNativeModule fallback.
 */
export function useOverlayBubble(isOnline: boolean): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!isOnline) {
      DriverOverlay.hideBubble();
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && DriverOverlay.canDrawOverlays()) {
        DriverOverlay.showBubble();
      } else if (state === 'active') {
        DriverOverlay.hideBubble();
      }
    });
    return () => {
      sub.remove();
      DriverOverlay.hideBubble();
    };
  }, [isOnline]);
}
