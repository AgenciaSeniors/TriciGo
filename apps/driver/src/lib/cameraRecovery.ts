// ============================================================
// Camera/picker recovery after Android background-activity death
//
// THE BUG THIS FIXES ("se bloquea y regresa atrás"): on low-RAM Android,
// opening the camera (or Google Photos) backgrounds the app, and the OS
// routinely KILLS our process to give the camera memory. When the user
// confirms the photo, Android relaunches the app from scratch: the JS state
// is gone, the picker's await never resolves, and the user lands back on the
// start screen with their photo lost — perceived as a crash. This is process
// death, not a JS error, so no try/catch or Sentry handler ever sees it.
//
// THE FIX: expo-image-picker persists the interrupted picker result natively;
// `ImagePicker.getPendingResultAsync()` returns it exactly once on relaunch.
// What it can NOT tell us is WHICH flow asked for the photo (selfie? vehicle
// slot 2? avatar?), so before every launch we persist a tiny flow marker in
// AsyncStorage. On relaunch the first consumer triggers a one-shot capture of
// the pending result, and each flow screen asks for "its" asset on mount.
//
// Usage per call site:
//   await markPickerLaunch('my-flow', { anyMeta: 'value' });
//   const result = await ImagePicker.launchCameraAsync(...);
//   await clearPickerMarker();               // returned normally — no recovery needed
//   ...
//   // on the screen/hook that owns the flow, at mount:
//   const rec = await consumeRecoveredPickerAsset('my-flow');
//   if (rec) continueFlowWith(rec.asset, rec.meta);
//
// Mirror of apps/client/src/lib/cameraRecovery.ts (per-app on purpose: it
// depends on expo-image-picker / AsyncStorage which are RN-only; keep in sync).
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

const MARKER_KEY = '@tricigo/pending-picker-flow';

// A pending result only exists right after a relaunch from a killed picker
// session, but the user may reopen the app later or wander before returning to
// the flow screen. Past this window we assume the photo is no longer wanted.
const MARKER_TTL_MS = 15 * 60 * 1000;

export interface RecoveredPickerAsset {
  asset: ImagePicker.ImagePickerAsset;
  meta: Record<string, string>;
}

interface FlowMarker {
  flow: string;
  meta?: Record<string, string>;
  ts: number;
}

// One-shot: getPendingResultAsync() consumes the native pending result, so it
// must run exactly once per process. The first consumeRecoveredPickerAsset()
// call triggers it; everyone awaits the same promise.
let capturePromise: Promise<void> | null = null;
let recovered: { marker: FlowMarker; asset: ImagePicker.ImagePickerAsset } | null = null;

/** Persist which flow is about to open the picker. Call right BEFORE launch. */
export async function markPickerLaunch(
  flow: string,
  meta?: Record<string, string>,
): Promise<void> {
  if (Platform.OS !== 'android') return; // pending-result API is Android-only
  try {
    const marker: FlowMarker = { flow, meta, ts: Date.now() };
    await AsyncStorage.setItem(MARKER_KEY, JSON.stringify(marker));
  } catch {
    /* best-effort — worst case is no recovery, same as before this module */
  }
}

/** Clear the marker after the picker returned normally (success OR cancel). */
export async function clearPickerMarker(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await AsyncStorage.removeItem(MARKER_KEY);
  } catch {
    /* best-effort */
  }
}

async function capture(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(MARKER_KEY);
    if (!raw) return; // no interrupted launch
    // Consume the marker unconditionally: whatever happens next, this pending
    // result belongs to that one launch and must not resurrect twice.
    await AsyncStorage.removeItem(MARKER_KEY);
    const marker = JSON.parse(raw) as FlowMarker;
    if (!marker?.flow || typeof marker.ts !== 'number') return;
    if (Date.now() - marker.ts > MARKER_TTL_MS) return;

    const pending = await ImagePicker.getPendingResultAsync();
    // null → nothing pending; { code, message } → picker itself errored.
    if (!pending || 'code' in pending) return;
    if (pending.canceled || !pending.assets?.[0]) return;
    recovered = { marker, asset: pending.assets[0] };
  } catch {
    /* best-effort */
  }
}

/**
 * Ask for the asset recovered for `flow`, if any. Returns it exactly once
 * (subsequent calls — and calls from other flows — get null). Safe to call
 * from any screen mount; the underlying native query runs only once.
 */
export async function consumeRecoveredPickerAsset(
  flow: string,
): Promise<RecoveredPickerAsset | null> {
  if (Platform.OS !== 'android') return null;
  if (!capturePromise) capturePromise = capture();
  await capturePromise;
  if (recovered && recovered.marker.flow === flow) {
    const r = recovered;
    recovered = null;
    return { asset: r.asset, meta: r.marker.meta ?? {} };
  }
  return null;
}
