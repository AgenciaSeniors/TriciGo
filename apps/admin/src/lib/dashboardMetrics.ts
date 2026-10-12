'use client';

import { adminService } from '@tricigo/api/services/admin';
import { createSharedRequests } from '@tricigo/utils/sharedRequest';

const shared = createSharedRequests();

/**
 * The dashboard metrics (get_admin_dashboard_metrics), shared by the header bell
 * and the dashboard: when both ask within maxAgeMs they get one request.
 */
export function getDashboardMetricsShared(maxAgeMs = 20_000) {
  return shared('dashboard-metrics', maxAgeMs, () => adminService.getDashboardMetrics());
}
