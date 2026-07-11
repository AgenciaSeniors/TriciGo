// ============================================================
// ensureDriverProfile — idempotent driver-profile resolver
// ============================================================
//
// Resolves (creating if needed) the driver_profiles row and stores its id in the
// onboarding store. Extracted from onboarding/documents.tsx so it can also run
// EARLIER in the flow (step 2, vehicle-info) — that way the Documents step never
// reaches an upload with a missing profile (which the storage-upload EF would
// reject with 403 and the DB row insert would FK-fail).
//
// - get-first-then-create: avoids the UNIQUE(user_id) violation when a profile
//   already exists (e.g. returning to the flow).
// - module-level dedupe: concurrent callers (vehicle-info mount + a documents
//   tap racing it) share ONE in-flight promise → never two createProfile()
//   INSERTs for the same user.
// - recovers from a lost UNIQUE(user_id) race by re-fetching the winner.
// - returns null on failure so callers can surface a recoverable, retry state
//   instead of leaving the screen stuck.

import { driverService } from '@tricigo/api';
import { useOnboardingStore } from '@/stores/onboarding.store';

let inFlight: Promise<string | null> | null = null;

export async function ensureDriverProfile(userId: string): Promise<string | null> {
  const current = useOnboardingStore.getState().driverProfileId;
  if (current) return current;
  if (!userId) return null;
  if (inFlight) return inFlight;

  const run = (async (): Promise<string | null> => {
    try {
      const existing = await driverService.getProfile(userId);
      if (existing) {
        useOnboardingStore.getState().setDriverProfileId(existing.id);
        return existing.id;
      }
      const created = await driverService.createProfile(userId);
      useOnboardingStore.getState().setDriverProfileId(created.id);
      return created.id;
    } catch (err) {
      // A concurrent create may have won the UNIQUE(user_id) race — the profile
      // now exists even though our insert threw. Fetch the winner.
      try {
        const existing = await driverService.getProfile(userId);
        if (existing) {
          useOnboardingStore.getState().setDriverProfileId(existing.id);
          return existing.id;
        }
      } catch {
        // fall through to the failure below
      }
      console.error(
        '[ensureDriverProfile] failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}
