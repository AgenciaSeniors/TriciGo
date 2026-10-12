import type { Ride } from '@tricigo/types';

/**
 * The trip on screen, marked completed with what the server charged. A completion the app did not
 * make itself (support finished the ride from the panel, 00660, or an offline replay) is only seen
 * on the ride row. Without these fields TripCompleteView shows the estimate as the fare and, on a
 * ride the rider's wallet could not cover (charged as mixed), not the cash to collect. A field the
 * row does not have keeps the value on screen.
 */
export function withServerCompletion(local: Ride, row: Partial<Ride> | null | undefined): Ride {
  return {
    ...local,
    status: 'completed',
    final_fare_cup: row?.final_fare_cup ?? local.final_fare_cup,
    payment_method: row?.payment_method ?? local.payment_method,
    cash_amount_cup: row?.cash_amount_cup ?? local.cash_amount_cup,
    wallet_amount_cup: row?.wallet_amount_cup ?? local.wallet_amount_cup,
    wait_time_charge_cup: row?.wait_time_charge_cup ?? local.wait_time_charge_cup,
    actual_distance_m: row?.actual_distance_m ?? local.actual_distance_m,
    actual_duration_s: row?.actual_duration_s ?? local.actual_duration_s,
    completed_at: row?.completed_at ?? local.completed_at,
  };
}
