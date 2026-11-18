// ============================================================
// TriciGo Driver — bring the app to the front for a ride offer
// ============================================================
// Two paths ask for it: the data-only push's background task
// (tasks/rideOfferLaunchTask.ts, PR #817) and the Realtime INSERT in
// useDriverRide (PR #807). For one offer both can fire a few seconds apart, so
// they share this helper: at most one launch and one report per ride id within
// 60 s (3 s without an id). After launching it watches AppState for 4 s:
//   - 'foreground'      the app reached the front;
//   - 'not_foreground'  it did not: blocked (Xiaomi's extra permission), or the
//                       screen was off, so it opened behind the lock screen.
//                       Read it by brand, not as proof for one phone;
//   - 'no_permission'   no launch: "Display over other apps" is not granted.
// A 'foreground' launch on a Xiaomi-family phone proves the extra permission,
// so it marks the Xiaomi step done. A miss never clears it.
// Spec: docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DriverLaunchResult } from '@tricigo/api';
import { isXiaomiFamily, logger } from '@tricigo/utils';
import DriverOverlay from '../../modules/driver-overlay';
import { getDeviceMaker } from '@/lib/device';
import { reportOverlayLaunch, XIAOMI_OK_KEY } from '@/lib/overlayReport';
import { useAuthStore } from '@/stores/auth.store';

export const LAUNCH_WATCH_MS = 4_000;
export const SAME_RIDE_WINDOW_MS = 60_000;
export const NO_ID_THROTTLE_MS = 3_000;

// Per process: when each ride was last attempted, and the last attempt of all.
const attemptedRides = new Map<string, number>();
let lastAttemptAt: number | null = null;

function within(since: number | null | undefined, now: number, windowMs: number): boolean {
  if (since === null || since === undefined) return false;
  const elapsed = now - since;
  return elapsed >= 0 && elapsed < windowMs;
}

/** Resolves 'foreground' when AppState turns active within `ms`, else 'not_foreground'. */
function watchForeground(ms: number): Promise<'foreground' | 'not_foreground'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: 'foreground' | 'not_foreground') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.remove();
      resolve(result);
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') finish('foreground');
    });
    const timer = setTimeout(() => finish('not_foreground'), ms);
  });
}

async function markXiaomiOk(): Promise<void> {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  const maker = getDeviceMaker();
  if (!isXiaomiFamily(maker.manufacturer, maker.brand)) return;
  try {
    await AsyncStorage.setItem(XIAOMI_OK_KEY(userId), 'true');
  } catch {
    /* the step comes back in 3 days; nothing else to do */
  }
}

/**
 * Bring the app to the front for the offer on `rideId`, unless this offer was
 * already attempted. Returns 'skipped' when nothing was done (not Android, app
 * already in front, or a repeat). Never throws.
 */
export async function attemptOfferLaunch(
  rideId: string | null,
  source: 'push' | 'realtime',
): Promise<DriverLaunchResult | 'skipped'> {
  if (Platform.OS !== 'android') return 'skipped';
  if (AppState.currentState === 'active') return 'skipped';

  const now = Date.now();
  if (rideId ? within(attemptedRides.get(rideId), now, SAME_RIDE_WINDOW_MS) : within(lastAttemptAt, now, NO_ID_THROTTLE_MS)) {
    return 'skipped';
  }
  for (const [id, at] of attemptedRides) {
    if (!within(at, now, SAME_RIDE_WINDOW_MS)) attemptedRides.delete(id);
  }
  if (rideId) attemptedRides.set(rideId, now);
  lastAttemptAt = now;

  try {
    if (!DriverOverlay.canDrawOverlays()) {
      await reportOverlayLaunch('no_permission');
      return 'no_permission';
    }
    // Subscribe before launching, so a fast resume is not missed.
    const watch = watchForeground(LAUNCH_WATCH_MS);
    try {
      DriverOverlay.bringAppToForeground();
    } catch (err) {
      logger.warn('[OfferLaunch] bringAppToForeground threw', { source, error: String(err) });
    }
    const result = await watch;
    if (result === 'foreground') await markXiaomiOk();
    await reportOverlayLaunch(result);
    return result;
  } catch (err) {
    logger.warn('[OfferLaunch] attempt failed', { source, error: String(err) });
    return 'not_foreground';
  }
}

/** Test-only: forget past attempts. */
export function resetOfferLaunchForTests(): void {
  attemptedRides.clear();
  lastAttemptAt = null;
}
