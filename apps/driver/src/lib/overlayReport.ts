// ============================================================
// TriciGo Driver — report the offer auto-open status to the server
// ============================================================
// The server records, per account and install, whether "Display over other
// apps" is granted, whether the Xiaomi step is done, and what happened on
// each launch attempt (report_driver_overlay, migration 00689). It is how we
// learn how many drivers the app can open by itself on an offer, by brand.
// Spec: docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
//
// Android only: on iOS the app cannot open itself, so there is nothing to
// measure. Never throws; once the server says the function does not exist
// yet, every call returns at once until the app restarts.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { deviceService, getSupabaseClient, type DriverLaunchResult } from '@tricigo/api';
import { APP_OPEN_REPORT_INTERVAL_MS, logger } from '@tricigo/utils';
import DriverOverlay, { isDriverOverlayAvailable } from '../../modules/driver-overlay';
import { getDeviceMaker, getOrCreateDeviceId } from '@/lib/device';
import { useAuthStore } from '@/stores/auth.store';

/** Storage key: this account finished the Xiaomi step on this phone. */
export const XIAOMI_OK_KEY = (userId: string): string => `@tricigo/xiaomi_popup_ok:${userId}`;

/**
 * The signed-in driver: the auth store's user, or, when the store is still
 * empty because the data-only push started the app and no screen has mounted
 * yet, the stored Supabase session's user. null without a session. Never throws.
 */
export async function currentDriverUserId(): Promise<string | null> {
  const fromStore = useAuthStore.getState().user?.id;
  if (fromStore) return fromStore;
  try {
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// Per process.
let unavailable = false;
let lastStatus: { userId: string; key: string; at: number } | null = null;

async function readXiaomiOk(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(XIAOMI_OK_KEY(userId))) === 'true';
  } catch {
    return false;
  }
}

async function send(userId: string, launchResult: DriverLaunchResult | null): Promise<void> {
  const maker = getDeviceMaker();
  const outcome = await deviceService.reportDriverOverlay({
    device_id: await getOrCreateDeviceId(),
    manufacturer: maker.manufacturer,
    brand: maker.brand,
    os_version: maker.osVersion,
    app_version: Constants.expoConfig?.version ?? null,
    module_available: isDriverOverlayAvailable,
    overlay_granted: DriverOverlay.canDrawOverlays(),
    xiaomi_ok: await readXiaomiOk(userId),
    launch_result: launchResult,
  });
  if (outcome === 'unavailable') unavailable = true;
}

/** Report one launch attempt for the signed-in driver. Nothing without a session. */
export async function reportOverlayLaunch(result: DriverLaunchResult): Promise<void> {
  if (Platform.OS !== 'android' || unavailable) return;
  const userId = await currentDriverUserId();
  if (!userId) return;
  try {
    await send(userId, result);
  } catch (err) {
    logger.warn('[OverlayReport] launch report failed', { error: String(err) });
  }
}

/**
 * Report the status (permission, Xiaomi step) when it changed since the last
 * report for this account, or when 6 hours passed, the same interval as
 * report_app_open. Called from useReportAppOpen.
 */
export async function reportOverlayStatus(userId: string): Promise<void> {
  if (Platform.OS !== 'android' || unavailable) return;
  try {
    const key = `${isDriverOverlayAvailable}|${DriverOverlay.canDrawOverlays()}|${await readXiaomiOk(userId)}`;
    const now = Date.now();
    if (lastStatus && lastStatus.userId === userId && lastStatus.key === key) {
      const elapsed = now - lastStatus.at;
      if (elapsed >= 0 && elapsed < APP_OPEN_REPORT_INTERVAL_MS) return;
    }
    lastStatus = { userId, key, at: now };
    await send(userId, null);
  } catch (err) {
    lastStatus = null;
    logger.warn('[OverlayReport] status report failed', { error: String(err) });
  }
}

/** Test-only: forget what this process reported. */
export function resetOverlayReportsForTests(): void {
  unavailable = false;
  lastStatus = null;
}
