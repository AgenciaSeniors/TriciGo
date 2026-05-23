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
//   - useDriverLocation calls `startBgLocationTracking(ctx)` when
//     activeRideId becomes truthy AND background permission is
//     granted. The function persists `ctx` (driverId, rideId) to
//     SecureStore and starts startLocationUpdatesAsync with a
//     foreground service notification.
//   - The TaskManager task (defined at module scope below) reads the
//     persisted ctx, uploads each batch of locations via
//     locationService.recordRideLocation, and falls back to the
//     locationBuffer if the upload fails (network down, etc.).
//   - useDriverLocation calls `stopBgLocationTracking()` when the
//     ride completes or the driver goes offline. The function stops
//     the task and clears the persisted ctx.
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

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { locationService } from '@tricigo/api';
import { bufferLocation, type BufferedLocation } from './locationBuffer';

export const LOCATION_TASK = 'tricigo-driver-location-bg';
const CTX_KEY = 'tricigo_bg_location_ctx';

interface BgTaskContext {
  driverId: string;
  rideId: string;
}

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

/**
 * Start real background location tracking for an active ride.
 * Idempotent — safe to call multiple times.
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
  await persistBgTaskContext(ctx);
  const isAlreadyRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);
  if (isAlreadyRunning) {
    return; // task is already running with previous ctx — the next batch will pick up the new ctx
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 3000, // 3 s minimum between callbacks (battery-friendly)
    distanceInterval: 10, // 10 m minimum movement before a callback
    showsBackgroundLocationIndicator: true, // iOS blue bar
    foregroundService: {
      notificationTitle: 'TriciGo Conductor',
      notificationBody: 'Compartiendo tu ubicación con el pasajero durante el viaje activo.',
      notificationColor: '#111111',
    },
    // pausesUpdatesAutomatically: false is the default; we want continuous
    // updates while the ride is active.
  });
}

/**
 * Stop background location tracking. Called when the ride ends or the
 * driver goes offline.
 */
export async function stopBgLocationTracking(): Promise<void> {
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

  // Upload each location. recordRideLocation hits the
  // `ride_location_events` table which has RLS allowing the driver to
  // INSERT their own rows. If the upload fails (offline, token
  // expired), buffer for later flush by the foreground hook on next
  // network event.
  for (const loc of locations) {
    try {
      await locationService.recordRideLocation({
        ride_id: ctx.rideId,
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
        rideId: ctx.rideId,
        driverId: ctx.driverId,
      };
      bufferLocation(buffered);
      console.warn('[bg-location-task] upload failed, buffered:', uploadErr);
    }
  }
});
