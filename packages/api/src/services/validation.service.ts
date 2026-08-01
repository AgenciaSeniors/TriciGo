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

/**
 * 00537: log a ride validation event through the SECURITY DEFINER RPC.
 * Used for events the direct-insert path can't cover from the client —
 * e.g. the far-pin flow ('complete_blocked_distance',
 * 'far_pin_override_canceled'), where the server-side RAISE EXCEPTION
 * rolls back and swallows its own telemetry. Fire-and-forget: never
 * throws, tolerates the RPC being absent (fresh envs pre-00537).
 */
export async function logRideValidationEvent(
  rideId: string,
  eventType: 'complete_blocked_distance' | 'far_pin_override_canceled',
  properties: Record<string, unknown> = {},
): Promise<void> {
  trackEvent(eventType, { ...properties, ride_id: rideId });
  try {
    const supabase = getSupabaseClient();
    await supabase.rpc('log_ride_validation_event', {
      p_ride_id: rideId,
      p_event_type: eventType,
      p_properties: properties,
    });
  } catch {
    // Silently fail — telemetry must never block the trip flow
  }
}
