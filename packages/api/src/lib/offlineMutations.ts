// ============================================================
// TriciGo — Offline Mutation Registration
// Registers key mutation handlers for offline queueing.
// ============================================================

import { registerOfflineMutation } from './offlineQueue';
import { rideService } from '../services/ride.service';
import { driverService } from '../services/driver.service';
import { reviewService } from '../services/review.service';
import { incidentService } from '../services/incident.service';
import { supportService } from '../services/support.service';

/**
 * Register all critical mutation handlers for offline support.
 * Call this once during app initialization (after initOfflineQueue).
 */
export function registerAllOfflineMutations() {
  registerOfflineMutation('ride.cancel', async (...args: unknown[]) => {
    const [rideId, userId, reason] = args as [string, string?, string?];
    await rideService.cancelRide(rideId, userId, reason);
  });

  // G2 — a trip completed while the driver was offline (after the in-line
  // retries exhausted). completeRide / complete_ride_and_pay is idempotent
  // (BUG-263 recovery), so replaying on reconnect is safe: if the server
  // already completed it, the RPC's guard short-circuits cleanly.
  registerOfflineMutation('ride.complete', async (...args: unknown[]) => {
    const [params] = args as [Parameters<typeof driverService.completeRide>[0]];
    await driverService.completeRide(params);
  });

  registerOfflineMutation('review.submit', async (...args: unknown[]) => {
    const [params] = args as [Parameters<typeof reviewService.submitReview>[0]];
    await reviewService.submitReview(params);
  });

  registerOfflineMutation('incident.sos', async (...args: unknown[]) => {
    const [params] = args as [Parameters<typeof incidentService.createSOSReport>[0]];
    await incidentService.createSOSReport(params);
  });

  registerOfflineMutation('support.createTicket', async (...args: unknown[]) => {
    const [params] = args as [Parameters<typeof supportService.createTicket>[0]];
    await supportService.createTicket(params);
  });
}
