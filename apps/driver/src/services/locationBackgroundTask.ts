// ============================================================
// TriciGo Driver — Background Location Task
// ============================================================
// BUG-Store-Readiness-Driver (FD1): real background tracking via
// expo-task-manager + Location.startLocationUpdatesAsync.
//
// The previous implementation in useDriverLocation.ts only called
// Location.watchPositionAsync, which on Android stops invoking its
// callback the moment the app moves to background (or the screen
// turns off). That contradicted the promise in
// app-store-review-notes.md and broke the rider's expectation of
// seeing the driver's marker move while the driver had the
// TriciGo Conductor app minimized.
//
// This module defines a TaskManager task that the OS keeps alive
// inside a foreground service (Android) or via the
// UIBackgroundModes=location entitlement (iOS). The task continues
// to receive location callbacks even when the driver minimizes the
// app to take a phone call, switches to a navigation app, or turns
// the screen off.
//
// Lifecycle:
//   - useDriverLocation calls `startBgLocationTracking(ctx)` whenever
//     the driver is ONLINE (with or without an active ride) AND
//     background permission is granted. The function persists `ctx`
//     (driverId, rideId, mode) to SecureStore and starts
//     startLocationUpdatesAsync with a foreground service notification.
//   - Two modes:
//       * 'online' — driver is online waiting for offers. Low-frequency
//         location + heartbeat. The foreground service keeps the JS
//         runtime alive so the driver's `last_heartbeat_at` keeps
//         refreshing even when the app is minimized / screen off.
//         Without this, backgrounding the app stopped the heartbeat and
//         the `auto-offline-stale-drivers` cron (10 min) — plus the
//         3-min `accept_ride_v2` gate — silently suspended the driver.
//       * 'ride' — driver has an active trip. High-frequency location so
//         the rider sees the marker move in real time, plus heartbeat.
//   - The TaskManager task (defined at module scope below) reads the
//     persisted ctx, ALWAYS refreshes the heartbeat, and (only when a
//     rideId is present) uploads each batch of locations via
//     locationService.recordRideLocation, falling back to the
//     locationBuffer if the upload fails (network down, etc.).
//   - useDriverLocation calls `stopBgLocationTracking()` when the
//     driver goes offline. The function stops the task and clears the
//     persisted ctx.
//
// Constraints:
//   - This module's `TaskManager.defineTask` call MUST run before
//     the OS can fire the task. Achieved by importing the module
//     for its side effects from `apps/driver/app/_layout.tsx`.
//   - The task body runs WITHOUT React state. It has access only to
//     module-scoped imports and the persisted ctx. Hence the
//     SecureStore round-trip on every batch.
//   - Inside the task, `locationService.recordRideLocation` uses
//     the Supabase client, which reads the access token from
//     SecureStore via the storage adapter wired in useAuth. As long
//     as a valid session is persisted, uploads succeed. If the
//     token has expired, Supabase auto-refreshes; if refresh fails,
//     the upload errors and we buffer for later.

import { AppState } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { driverService, locationService } from '@tricigo/api';
import { bufferLocation, type BufferedLocation } from './locationBuffer';

export const LOCATION_TASK = 'tricigo-driver-location-bg';
const CTX_KEY = 'tricigo_bg_location_ctx';

export type BgTaskMode = 'online' | 'ride';

interface BgTaskContext {
  driverId: string;
  // null while the driver is online but has no active trip yet.
  rideId: string | null;
  mode: BgTaskMode;
}

// The mode the foreground service was ACTUALLY started with (its real update
// frequency), as opposed to the desired `mode` persisted in the ctx (which the
// task body reads to decide whether to record ride locations). These diverge
// when a mode change is deferred because the app is backgrounded (see
// startBgLocationTracking). Module-scoped: valid while the JS runtime is alive
// (the foreground service keeps it alive); resets to null if the process is
// killed and relaunched, in which case the task is no longer registered and the
// next call takes the initial-start path.
let startedMode: BgTaskMode | null = null;

/**
 * Persist context the TaskManager task needs to upload locations.
 * Called by the React hook before starting the task.
 */
export async function persistBgTaskContext(ctx: BgTaskContext): Promise<void> {
  try {
    await SecureStore.setItemAsync(CTX_KEY, JSON.stringify(ctx));
  } catch {
    // best-effort — if SecureStore fails, the task will skip uploads
  }
}

/**
 * Clear the persisted ctx. Called when the ride completes or driver
 * goes offline so the next session starts clean.
 */
export async function clearBgTaskContext(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CTX_KEY);
  } catch {
    // best-effort
  }
}

// Per-mode location update options.
//   - 'ride': high frequency so the rider sees the marker move in real
//     time (matches the foreground watchPositionAsync cadence).
//   - 'online': low frequency to save battery while the driver is just
//     waiting for offers. The heartbeat (below) is what keeps the driver
//     matchable; the foreground service keeps the JS runtime alive so the
//     hook's setInterval heartbeats also keep firing in background.
function updateOptionsForMode(mode: BgTaskMode) {
  const foregroundService = {
    notificationTitle: 'TriciGo Conductor',
    notificationBody:
      mode === 'ride'
        ? 'Compartiendo tu ubicación con el pasajero durante el viaje activo.'
        : 'Estás en línea. Podés recibir viajes con la app en segundo plano.',
    notificationColor: '#111111',
  };
  if (mode === 'ride') {
    return {
      accuracy: Location.Accuracy.High,
      timeInterval: 3000, // 3 s minimum between callbacks
      distanceInterval: 10, // 10 m minimum movement before a callback
      showsBackgroundLocationIndicator: true, // iOS blue bar
      foregroundService,
    };
  }
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000, // ~1 fix/min — enough to refresh the heartbeat
    distanceInterval: 0, // time-based, not movement-gated (stationary driver)
    showsBackgroundLocationIndicator: true,
    foregroundService,
  };
}

/**
 * Start real background location tracking while the driver is online.
 * Idempotent within a mode — safe to call multiple times. When the mode
 * changes (online ⇄ ride) the task is restarted with the new frequency
 * and notification, because startLocationUpdatesAsync ignores option
 * changes on an already-running task.
 *
 * On iOS, `showsBackgroundLocationIndicator` shows the blue location
 * indicator in the status bar while the app is in background — Apple
 * requires this for any app that uses UIBackgroundModes=location.
 *
 * On Android, `foregroundService` declares a persistent notification
 * that informs the driver the app is tracking their location. Required
 * by Android 8+ for any background location use; mandatory for the
 * `FOREGROUND_SERVICE_LOCATION` permission on Android 14+.
 */
export async function startBgLocationTracking(ctx: BgTaskContext): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);

  // Persist the desired ctx first — the task body reads driverId/rideId from
  // it on every batch, regardless of whether we (re)start below.
  await persistBgTaskContext(ctx);

  // Not running yet → initial start. This only happens when the driver goes
  // online (a foreground action) or the process was relaunched, so starting
  // the foreground service here is allowed.
  if (!isRunning) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptionsForMode(ctx.mode));
    startedMode = ctx.mode;
    return;
  }

  // Running at the desired frequency already → nothing to do; the task picks up
  // the new rideId from the persisted ctx on its next batch.
  if (startedMode === ctx.mode) {
    return;
  }

  // The running frequency differs from what we want (online ⇄ ride). Applying
  // the new frequency/notification requires a stop+restart, but restarting a
  // location foreground service from the background is blocked on Android 12+
  // (ForegroundServiceStartNotAllowedException). If we're not in the
  // foreground, SKIP the restart: the service keeps running at its current
  // frequency (`startedMode` unchanged) while the task already reads the new
  // mode/rideId from the persisted ctx (so heartbeat + ride-location recording
  // stay correct). The AppState 'active' listener in useDriverLocation
  // re-applies the intended frequency on the next foreground. This is the key
  // guard for a ride that ends — or an auto-accepted ride that starts — while
  // the app is minimized.
  if (AppState.currentState !== 'active') {
    return;
  }
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // best-effort
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptionsForMode(ctx.mode));
  startedMode = ctx.mode;
}

/**
 * Stop background location tracking. Called when the ride ends or the
 * driver goes offline.
 */
export async function stopBgLocationTracking(): Promise<void> {
  startedMode = null;
  const isRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);
  if (isRunning) {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    } catch {
      // best-effort
    }
  }
  await clearBgTaskContext();
}

// ──────────────────────────────────────────────────────────────
// TaskManager task definition (runs at module scope on import)
// ──────────────────────────────────────────────────────────────

interface LocationTaskData {
  locations?: Location.LocationObject[];
}

// Throttle the background heartbeat to ~once per minute. In 'ride' mode the
// OS delivers a location batch every few seconds; without this we'd write a
// heartbeat — and, via the `audit_driver_profiles` trigger, an audit row — on
// every batch, and add an RPC round-trip of latency before each ride-location
// upload. 60s matches the foreground heartbeat cadence (useDriverLocation +
// index.tsx), so this adds no write load beyond what already exists.
// Module-scoped: the foreground service keeps the JS runtime alive so this
// persists across batches; if the OS relaunches a killed task it resets to 0
// and the first batch heartbeats immediately (harmless).
let lastBgHeartbeatMs = 0;
const BG_HEARTBEAT_MIN_INTERVAL_MS = 55_000;

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[bg-location-task] error:', error);
    return;
  }

  const { locations } = (data ?? {}) as LocationTaskData;
  if (!locations || locations.length === 0) return;

  // Load ctx fresh on every batch — handles the case where the user
  // accepts a new ride after the previous one ends (ctx is re-persisted
  // by useDriverLocation in that case).
  let ctx: BgTaskContext | null = null;
  try {
    const raw = await SecureStore.getItemAsync(CTX_KEY);
    if (raw) ctx = JSON.parse(raw) as BgTaskContext;
  } catch {
    ctx = null;
  }

  if (!ctx) {
    // No ctx persisted — likely the task was started by the OS after a
    // crash recovery, but the user hasn't logged back in. Stop the
    // task to avoid burning battery on no-op callbacks.
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
    return;
  }

  // Refresh the heartbeat from the background task (throttled to ~60s). This
  // is the core fix for "driver goes inactive after minimizing the app":
  // while online-but-waiting the foreground JS timers are suspended by the
  // OS, so this task-body heartbeat keeps `last_heartbeat_at` fresh and the
  // driver matchable. driver_heartbeat is SECURITY DEFINER and uses the
  // persisted session, so it works headless. Best-effort — never throw out
  // of the task.
  const nowMs = Date.now();
  if (nowMs - lastBgHeartbeatMs > BG_HEARTBEAT_MIN_INTERVAL_MS) {
    lastBgHeartbeatMs = nowMs;
    try {
      await driverService.sendHeartbeat(ctx.driverId);
    } catch (hbErr) {
      console.warn('[bg-location-task] heartbeat failed:', hbErr);
    }
  }

  // Ride-location upload only makes sense during an active trip. When the
  // driver is merely online (rideId null), the heartbeat above is the only
  // work this task does.
  if (!ctx.rideId) return;
  const rideId = ctx.rideId;

  // Upload each location. recordRideLocation hits the
  // `ride_location_events` table which has RLS allowing the driver to
  // INSERT their own rows. If the upload fails (offline, token
  // expired), buffer for later flush by the foreground hook on next
  // network event.
  for (const loc of locations) {
    try {
      await locationService.recordRideLocation({
        ride_id: rideId,
        driver_id: ctx.driverId,
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        heading: loc.coords.heading ?? undefined,
        speed: loc.coords.speed ?? undefined,
      });
    } catch (uploadErr) {
      const buffered: BufferedLocation = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        heading: loc.coords.heading ?? null,
        speed: loc.coords.speed ?? null,
        accuracy: loc.coords.accuracy ?? null,
        timestamp: loc.timestamp,
        rideId: rideId,
        driverId: ctx.driverId,
      };
      bufferLocation(buffered);
      console.warn('[bg-location-task] upload failed, buffered:', uploadErr);
    }
  }
});
