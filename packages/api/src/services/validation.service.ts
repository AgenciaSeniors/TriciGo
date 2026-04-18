// ============================================================
// TriciGo — Validation Event Service
// Dual-write helper: sends event to PostHog AND persists to
// Supabase validation_events. Fire-and-forget so it never
// blocks the UI. Lives in @tricigo/api to avoid a circular
// dep with @tricigo/utils (which owns the PostHog wrapper).
// ============================================================

import { trackEvent } from '@tricigo/utils';
import { getSupabaseClient } from '../client';

/**
 * Track a driver-side validation event.
 * - Emits to PostHog via @tricigo/utils `trackEvent`.
 * - Persists to Supabase `validation_events` (fire-and-forget).
 */
export async function trackValidationEvent(
  eventType: string,
  properties: Record<string, unknown>,
  rideId?: string,
) {
  // Send to PostHog
  trackEvent(eventType, properties);

  // Send to Supabase validation_events (fire-and-forget)
  try {
    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      void Promise.resolve(
        supabase
          .from('validation_events')
          .insert({
            driver_id: user.id,
            event_type: eventType,
            ride_id: rideId || null,
            properties,
          }),
      ).catch(() => {
        // Silently fail — validation events are non-critical
      });
    }
  } catch {
    // Silently fail — validation events are non-critical
  }
}
