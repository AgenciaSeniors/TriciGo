// How a failed sync-exchange-rate run should be REPORTED — the decision, isolated so it
// can be unit-tested without a network or a database.
//
// WHY THIS EXISTS
// The cron -> Edge Function watchdog (mig 00506/00507) alerts on the HTTP status of each
// cron call, so that status is the only thing standing between a real FX outage and a
// silent one. Until now sync-exchange-rate answered 502 for ANY unsuccessful run, which
// conflated two situations that could not be further apart:
//
//   * elToque rate-limited this particular attempt, and the rate we already hold is 1.8h
//     old. Nothing is wrong. Recharges work. The next run is 15 minutes away.
//   * Nothing has refreshed the rate for a day. Recharges are about to fail closed with
//     503 fx_unavailable, because the four payment EFs reject a rate older than
//     exchange_rate_max_age_hours.
//
// Measured on production over 6h on 2026-07-30: 6 of 24 runs succeeded (25%), every
// failure being [429, 429] from the trmi API plus the long-dead 403 scraper. That is
// enough to keep the rate ~1h fresh against a 24h requirement — a ~20x margin — yet the
// watchdog sat permanently red and mailed on every flap. A light that is always on is a
// light nobody reads, which is the exact failure mode the watchdog was built to prevent.
//
// So: the status code now reports the INVARIANT ("is the stored rate still good?"),
// not the luck of one upstream request.
//
// DELIBERATELY NOT a cron_http_expectations row. Registering 502 as an accepted status
// for this job would silence the genuine outage too — the one case the watchdog exists
// for. The distinction is stateful (how old is the rate?), so it cannot be expressed as
// a set of acceptable status codes.

/** Why a run produced no rate. Config faults are OURS; the rest is upstream. */
export type FxSyncFailureReason =
  | 'all_methods_failed'
  | 'config_token_missing'
  | 'config_read_failed';

export interface FxSyncFailureInput {
  reason: FxSyncFailureReason;
  /** Whether an is_current row exists at all. */
  hasCurrentRate: boolean;
  /** Age of that row in hours; null when unknown/unreadable. */
  rateAgeHours: number | null;
  /** Age at which a stale rate becomes an incident. */
  softLimitHours: number;
}

export interface FxSyncFailureOutcome {
  httpStatus: 200 | 502;
  /**
   * true  -> could not refresh, but the stored rate still covers us (not an incident)
   * false -> the stored rate is missing, unreadable or past the limit (page someone)
   */
  degraded: boolean;
}

const DEFAULT_SOFT_LIMIT_HOURS = 20;
const MIN_SOFT_LIMIT_HOURS = 1;

/**
 * Age at which "could not refresh" stops being routine and becomes an incident.
 *
 * Reuses the EXISTING fx_stale_alert_hours (default 20) rather than inventing a key, so
 * this EF and the SQL freshness watchdog (mig 00503, cron 36) draw the line in the same
 * place instead of contradicting each other — which is precisely the state this change
 * is fixing: fx_health_status said "ok" while cron_http_health_status said "failing".
 *
 * Hard-capped at the money window (exchange_rate_max_age_hours, as resolved and clamped
 * by getFreshFx). Going red only AFTER recharges have already started failing would make
 * the alert useless, so a misconfigured fx_stale_alert_hours can never push the alarm
 * past the cliff it is meant to warn about.
 */
export function resolveSoftLimitHours(raw: unknown, maxAgeHours: number): number {
  // platform_config.value is jsonb: a bare number arrives as a number, but tolerate a
  // (possibly quoted) string — keys in that table are stored both ways. Same reasoning
  // as resolveMaxAgeHours in fx-freshness.ts.
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/"/g, '').trim());
  const wanted = Number.isFinite(n) && n > 0 ? n : DEFAULT_SOFT_LIMIT_HOURS;
  const ceiling = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : DEFAULT_SOFT_LIMIT_HOURS;
  return Math.max(MIN_SOFT_LIMIT_HOURS, Math.min(wanted, ceiling));
}

/**
 * FAILS CLOSED. Anything unknown — no rate row, an unreadable age, a config fault of our
 * own making — reports 502. Only a rate we can actually see, and that is actually young
 * enough, downgrades the run to a non-event.
 */
export function resolveFxSyncFailure(input: FxSyncFailureInput): FxSyncFailureOutcome {
  const { reason, hasCurrentRate, rateAgeHours, softLimitHours } = input;

  // A missing token or an unreadable platform_config is OUR breakage, not elToque's, and
  // it will not heal on its own. Staying quiet for 20 hours because the rate happens to
  // be fresh is how the 4-day freeze of 2026-07-15 went unnoticed. Always loud.
  if (reason !== 'all_methods_failed') return { httpStatus: 502, degraded: false };

  if (!hasCurrentRate) return { httpStatus: 502, degraded: false };
  if (rateAgeHours === null || !Number.isFinite(rateAgeHours)) {
    return { httpStatus: 502, degraded: false };
  }
  // A negative age (clock skew, backdated row) is not "extra fresh". Treat magnitude,
  // mirroring the Math.abs in fx-freshness.ts.
  if (Math.abs(rateAgeHours) >= softLimitHours) return { httpStatus: 502, degraded: false };

  return { httpStatus: 200, degraded: true };
}

/**
 * Reads a platform_config flag that may be jsonb boolean OR string.
 *
 * exchange_rate_auto_update is the FX kill switch. It was seeded by mig 00017 as the
 * jsonb STRING '"true"', but production now holds the jsonb BOOLEAN true — something
 * rewrote it through a surface that emits a real boolean. The old check was
 * `cfg[key] === 'false'`, which a boolean false can never satisfy, so switching the sync
 * off would have silently kept it running.
 *
 * auto-admin, directions-google and create-stripe-payment-intent all already guard both
 * shapes (`=== 'true' || === true`); sync-exchange-rate was the one that did not.
 */
export function configFlag(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^"+|"+$/g, '').toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return fallback;
}
