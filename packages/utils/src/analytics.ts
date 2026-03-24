// ============================================================
// TriciGo — Analytics Wrapper (PostHog)
// Shared event tracking abstraction for web and mobile.
// ============================================================

/**
 * Predefined analytics events for TriciGo.
 */
export type AnalyticsEvent =
  | 'ride_requested'
  | 'ride_completed'
  | 'ride_canceled'
  | 'address_searched'
  | 'driver_went_online'
  | 'driver_went_offline'
  | 'payment_method_selected'
  | 'ride_rated'
  | 'promo_applied'
  | 'quest_completed';

/**
 * Analytics interface — each platform implements this.
 * PostHog is initialized in each app's layout/provider.
 */
let _capture: ((event: string, properties?: Record<string, unknown>) => void) | null = null;
let _identify: ((userId: string, traits?: Record<string, unknown>) => void) | null = null;
let _reset: (() => void) | null = null;

/**
 * Initialize the analytics module with platform-specific implementations.
 * Call this once in each app's root (layout.tsx or _layout.tsx).
 */
export function initAnalytics(opts: {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (userId: string, traits?: Record<string, unknown>) => void;
  reset: () => void;
}) {
  _capture = opts.capture;
  _identify = opts.identify;
  _reset = opts.reset;
}

/**
 * Track a named event with optional properties.
 */
export function trackEvent(
  event: AnalyticsEvent | string,
  properties?: Record<string, unknown>,
) {
  try {
    _capture?.(event, properties);
  } catch {
    // Analytics is non-critical
  }
}

/**
 * Identify a user for analytics tracking.
 */
export function identifyUser(
  userId: string,
  traits?: Record<string, unknown>,
) {
  try {
    _identify?.(userId, traits);
  } catch {
    // Analytics is non-critical
  }
}

/**
 * Dual-write helper: sends event to PostHog AND persists to Supabase validation_events.
 * All writes are fire-and-forget so they never block the UI.
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
    const { getSupabaseClient } = await import('@tricigo/api');
    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      supabase.from('validation_events').insert({
        driver_id: user.id,
        event_type: eventType,
        ride_id: rideId || null,
        properties,
      }).then(() => {}).catch(() => {});
    }
  } catch {
    // Silently fail — validation events are non-critical
  }
}

/**
 * Reset analytics (call on logout).
 */
export function resetAnalytics() {
  try {
    _reset?.();
  } catch {
    // Analytics is non-critical
  }
}
