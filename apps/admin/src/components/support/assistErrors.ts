import { AppError } from '@tricigo/api';

/**
 * The admin.json key for a failed support action (`ride_assist.error_<code>`).
 * rideAssistService throws the server's refusal as an AppError whose `code` is the refusal;
 * a function that raises instead (admin_ride_assist_candidates, admin_support_waiting_rides)
 * comes back as a Postgres error, 42501 when the caller is not an admin.
 */
const CODES = new Set([
  'ride_not_searching',
  'not_online',
  'stale_heartbeat',
  'busy',
  'insufficient_balance',
  'wrong_vehicle_type',
  'blocked',
  'not_in_fleet',
  'driver_not_approved',
  'reason_required',
  'fare_below_minimum',
  'fare_out_of_range',
  'too_many_passengers',
  'same_service_type',
  'service_type_unavailable',
  'offer_already_accepted',
  'driver_inactive',
  'rider_balance_too_low',
  'split_not_supported',
  'payment_method_not_supported',
  'scheduled_not_due',
  'invalid_service_type',
  // Rides that already have a driver (00660).
  'ride_changed',
  'amount_changed',
  'ride_not_releasable',
  'ride_not_advanceable',
  'ride_not_completable',
  'no_agreed_price',
  'self_ride',
  'delivery_proof_missing',
  'forbidden',
  'ride_not_found',
]);

export function assistErrorKey(err: unknown): string {
  const raw = (err as { code?: unknown } | null)?.code;
  // 40P01: a deadlock with the driver's app writing at the same moment aborted the action.
  // Support reads it like ride_changed: the page reloads and they try again.
  const code = raw === '42501' ? 'forbidden' : raw === '40P01' ? 'ride_changed' : raw;
  return typeof code === 'string' && CODES.has(code) ? `ride_assist.error_${code}` : 'ride_assist.error_generic';
}

/**
 * The message of a database error that is not a refusal: complete_ride_and_pay raising, for
 * example, when a corporate wallet cannot be charged. Null for our own AppErrors (a refusal, or a
 * function that is not deployed) and for a request that never got an answer: postgrest-js reports
 * a failed fetch with an empty code, and "the server refused" would be wrong there.
 */
export function serverErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object' || err instanceof AppError) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !code || typeof message !== 'string') return null;
  return message.trim() || null;
}
