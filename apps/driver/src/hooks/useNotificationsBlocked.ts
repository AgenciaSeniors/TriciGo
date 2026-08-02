import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

/**
 * True when the OS will not deliver notifications to this device.
 *
 * Why this exists: a driver whose notification permission is denied gets NO
 * ride-offer push at all. Measured 2026-08-02: 39 of the 60 drivers active in
 * the last 7 days had no push token registered — the documented fallout of the
 * permission dialog firing seconds after login, before the driver had any
 * context (fixed for new installs in #897, but a denial on Android 13+ is
 * permanent). Nothing on the home screen told them; they just sat online
 * waiting for rides that could never announce themselves.
 *
 * Re-checks whenever the app returns to the foreground, so the banner this
 * powers disappears on its own the moment the driver comes back from system
 * Settings — no reload, no restart.
 *
 * Fails CLOSED (returns false) if the permission cannot be read: a spurious
 * "your notifications are off" on a driver who is actually fine would be worse
 * than staying quiet.
 */
export function useNotificationsBlocked(): boolean {
  const [blocked, setBlocked] = useState(false);
  const cancelledRef = useRef(false);

  const check = useCallback(async () => {
    try {
      const { granted } = await Notifications.getPermissionsAsync();
      if (!cancelledRef.current) setBlocked(!granted);
    } catch {
      if (!cancelledRef.current) setBlocked(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    check();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });

    return () => {
      cancelledRef.current = true;
      sub.remove();
    };
  }, [check]);

  return blocked;
}
