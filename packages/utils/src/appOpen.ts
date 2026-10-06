/**
 * When the mobile apps report that they were opened (report_app_open,
 * migration 00622). They report when they start with a session and, while
 * they stay open, when they come back to the foreground at least this long
 * after the last report.
 */
export const APP_OPEN_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The last report this process sent: which account, and when (ms). */
export interface AppOpenReport {
  userId: string;
  at: number;
}

/**
 * True when this open should be reported: nothing reported yet in this
 * process, another account is signed in, or the last report is at least
 * `intervalMs` old (or in the future, after a clock change).
 */
export function shouldReportAppOpen(
  last: AppOpenReport | null,
  userId: string,
  now: number,
  intervalMs: number = APP_OPEN_REPORT_INTERVAL_MS,
): boolean {
  if (!last || last.userId !== userId) return true;
  const elapsed = now - last.at;
  return elapsed < 0 || elapsed >= intervalMs;
}
