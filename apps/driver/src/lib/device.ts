// Per-app util (duplicated in apps/client/src/lib/device.ts) because it
// depends on the app's native modules (expo-secure-store / expo-device),
// which aren't appropriate to pull into the shared @tricigo packages.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import type { RegisterLoginDeviceInput } from '@tricigo/api';

const DEVICE_ID_KEY = 'tricigo_device_id';

/** RFC 4122 v4 — fallback for runtimes without crypto.randomUUID. */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : uuidv4();
}

/**
 * Stable per-install device id, persisted in the OS keychain via
 * expo-secure-store. Survives app restarts; resets on reinstall (which
 * is reasonably treated as a new device). Falls back to an ephemeral id
 * if SecureStore is unavailable (e.g. web) so callers never throw.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = newUuid();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return newUuid();
  }
}

/** Device metadata sent at login for new-device detection. */
export async function getDeviceInfo(): Promise<RegisterLoginDeviceInput> {
  return {
    device_id: await getOrCreateDeviceId(),
    platform: Platform.OS,
    model: Device.modelName ?? null,
    os_version: Device.osVersion ?? null,
    app_version: Constants.expoConfig?.version ?? null,
  };
}
