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
// The watch measures wall-clock time: a resume later than 4 s (JS timers are
// paused in the background, so the timer may not have fired) is the driver
// opening the app by hand, not the launch. A resume within 1.5 s on a
// Xiaomi-family phone proves the extra permission, so it marks the Xiaomi step
// done. A miss never clears it.
// Spec: docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DriverLaunchResult } from '@tricigo/api';
import { isXiaomiFamily, logger } from '@tricigo/utils';
import DriverOverlay from '../../modules/driver-overlay';
import { getDeviceMaker } from '@/lib/device';
import { currentDriverUserId, reportOverlayLaunch, XIAOMI_OK_KEY } from '@/lib/overlayReport';

export const LAUNCH_WATCH_MS = 4_000;
/**
 * A resume this soon after the launch call is the launch itself, not the driver
 * tapping the push or the bubble: only then does it prove the Xiaomi permission.
 */
export const XIAOMI_PROOF_MS = 1_500;
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

interface ForegroundWatch {
  result: 'foreground' | 'not_foreground';
  /** Wall-clock ms from the start of the watch to the resume, when there was one. */
  latencyMs: number | null;
}

/**
 * Resolves 'foreground' when AppState turns active within `ms` of wall-clock
 * time, else 'not_foreground'. The timer alone is not enough: React Native
 * pauses JS timers while the app is in the background (outside a headless
 * task, as on the Realtime path), so it may only run after the driver opens the
 * app by hand. That late resume must not count as the launch working.
 */
function watchForeground(ms: number): Promise<ForegroundWatch> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (watch: ForegroundWatch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.remove();
      resolve(watch);
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const latencyMs = Date.now() - startedAt;
      const inTime = latencyMs >= 0 && latencyMs <= ms;
      finish({ result: inTime ? 'foreground' : 'not_foreground', latencyMs });
    });
    const timer = setTimeout(() => finish({ result: 'not_foreground', latencyMs: null }), ms);
  });
}

async function markXiaomiOk(): Promise<void> {
  const userId = await currentDriverUserId();
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
    const { result, latencyMs } = await watch;
    if (result === 'foreground' && latencyMs !== null && latencyMs <= XIAOMI_PROOF_MS) {
      await markXiaomiOk();
    }
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
