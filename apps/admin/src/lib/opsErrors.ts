import { AppError } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

/**
 * The refusals of the onboarding ops functions (00672): onboardingService throws them as an
 * AppError whose `code` is the refusal. Each has an admin.json text under `ops_errors`.
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
]);

/** The admin.json key of an onboarding refusal, or null for any other error. */
export function opsErrorKey(err: unknown): string | null {
  if (!(err instanceof AppError)) return null;
  return CODES.has(err.code) ? `ops_errors.${err.code}` : null;
}

/** The text to show for a failed onboarding action: the refusal's text, or the error itself. */
export function opsErrorMessage(err: unknown, t: (key: string) => string): string {
  const key = opsErrorKey(err);
  return key ? t(key) : getErrorMessage(err);
}
