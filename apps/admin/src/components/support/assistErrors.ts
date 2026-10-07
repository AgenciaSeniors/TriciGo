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
  'forbidden',
]);

export function assistErrorKey(err: unknown): string {
  const raw = (err as { code?: unknown } | null)?.code;
  const code = raw === '42501' ? 'forbidden' : raw;
  return typeof code === 'string' && CODES.has(code) ? `ride_assist.error_${code}` : 'ride_assist.error_generic';
}
