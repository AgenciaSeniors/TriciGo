import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { deviceService } from '@tricigo/api';
import { logger, shouldReportAppOpen, type AppOpenReport } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { getDeviceInfo } from '@/lib/device';

// Per process. An app update restarts the process, so the version reported
// here never goes stale while the app keeps running.
let lastReport: AppOpenReport | null = null;
let unavailable = false;

/**
 * Report this open for `userId` unless one was sent less than 6 hours ago
 * (report_app_open, migration 00622). Never throws: a failure is logged and
 * retried on the next call, and once the server answers that the function
 * does not exist yet, it stops until the app restarts.
 */
export async function reportAppOpen(userId: string): Promise<void> {
  if (unavailable || !shouldReportAppOpen(lastReport, userId, Date.now())) return;
  lastReport = { userId, at: Date.now() };
  try {
    const info = await getDeviceInfo();
    const outcome = await deviceService.reportAppOpen({
      app: 'client',
      device_id: info.device_id,
      app_version: info.app_version ?? null,
      platform: info.platform ?? null,
    });
    if (outcome === 'unavailable') unavailable = true;
  } catch (err) {
    lastReport = null;
    logger.warn('[AppOpen] report failed', { error: String(err) });
  }
}

/** Test-only: forget what this process reported. */
export function resetAppOpenReportsForTests(): void {
  lastReport = null;
  unavailable = false;
}

/**
 * Report that the app was opened, with its version: when it starts with a
 * session, after a login, and when it comes back to the foreground 6 hours
 * or more after the last report. Never emails and never touches the
 * login-device records, so it is safe on every open. Duplicated in
 * apps/driver/src/hooks/useReportAppOpen.ts.
 */
export function useReportAppOpen(): void {
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (!userId || Platform.OS === 'web') return;
    void reportAppOpen(userId);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reportAppOpen(userId);
    });
    return () => sub.remove();
  }, [userId]);
}
