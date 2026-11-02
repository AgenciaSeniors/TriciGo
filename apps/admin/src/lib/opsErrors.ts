import { AppError } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

/**
 * The refusals of the ops functions: onboarding (00672) and support, cases and moderation (00673).
 * onboardingService and caseOpsService throw them as an AppError whose `code` is the refusal. Each
 * has an admin.json text under `ops_errors`.
 */
const CODES = new Set([
  'forbidden',
  'self_action',
  'target_is_staff',
  'driver_changed',
  'invalid_transition',
  'reason_required',
  'driver_has_no_active_vehicle',
  'driver_not_found',
  'document_not_found',
  'invalid_document_type',
  'invalid_path',
  'invalid_channel',
  'account_not_found',
  'not_a_fleet',
  'account_changed',
  'member_not_found',
  'ONBOARDING_UNAVAILABLE',
  // 00673
  'invalid_status',
  'invalid_action',
  'invalid_request',
  'ticket_not_found',
  'ticket_changed',
  'message_required',
  'message_too_long',
  'incident_not_found',
  'incident_changed',
  'review_not_found',
  'review_changed',
  'lost_item_not_found',
  'lost_item_changed',
  'dispute_not_found',
  'dispute_changed',
  'already_assigned',
  'invalid_resolution',
  'reason_too_long',
  'invalid_amount',
  'amount_exceeds_fare',
  'already_escalated',
  'escalation_not_found',
  'escalation_closed',
  'amount_changed',
  'alert_not_found',
  'already_resolved',
  'CASES_UNAVAILABLE',
]);

/** Refusals that mean the row moved while it was on screen: the page should load it again. */
const STALE_CODES = new Set([
  'ticket_changed', 'incident_changed', 'review_changed', 'lost_item_changed', 'dispute_changed',
  'already_assigned', 'already_escalated', 'escalation_closed', 'amount_changed', 'already_resolved',
]);

/** The admin.json key of an ops refusal, or null for any other error. */
export function opsErrorKey(err: unknown): string | null {
  if (!(err instanceof AppError)) return null;
  return CODES.has(err.code) ? `ops_errors.${err.code}` : null;
}

/** The text to show for a failed ops action: the refusal's text, or the error itself. */
export function opsErrorMessage(err: unknown, t: (key: string) => string): string {
  const key = opsErrorKey(err);
  return key ? t(key) : getErrorMessage(err);
}

/** Whether a failed action means the row changed meanwhile, so the page should reload it. */
export function isOpsStaleError(err: unknown): boolean {
  return err instanceof AppError && STALE_CODES.has(err.code);
}
