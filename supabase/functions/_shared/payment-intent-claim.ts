// ============================================================
// Claiming a payment intent before crediting it.
//
// process-netopia-webhook moves an intent to 'processing' before it calls
// process_recharge_payment, so two deliveries of the same IPN cannot both
// send the push and the receipt. Until 2026-10-08 that claim was a one-way
// door: if the credit failed (a timeout, a lock, the database down), the row
// stayed 'processing', the 500 made NETOPIA retry, and every retry matched
// no claimable row and was ACKed as a replay. The card was charged and the
// wallet never credited, with nothing left to retry it. Now:
//  - a failed credit puts the row back to 'pending' (never to 'failed': that
//    would fire the payment-failed push and e-mail again);
//  - a delivery that finds a fresh 'processing' row gets a 503, so NETOPIA
//    retries instead of being told the payment was handled;
//  - a 'processing' row older than the lease is claimable again, for a run
//    that died between the claim and the credit.
// process_recharge_payment locks the intent and is idempotent, so a second
// claim can never credit twice.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

/** Statuses a paid IPN may claim. */
export const CLAIMABLE_STATUSES = ['pending', 'created', 'failed', 'expired'] as const;

/** How long a 'processing' claim protects a run. An Edge Function run ends well before. */
export const PROCESSING_LEASE_MS = 10 * 60 * 1000;

/** PostgREST `or` filter for the claim: a claimable status, or an expired processing lease. */
export function claimFilter(now: Date): string {
  const cutoff = new Date(now.getTime() - PROCESSING_LEASE_MS).toISOString();
  return `status.in.(${CLAIMABLE_STATUSES.join(',')}),and(status.eq.processing,updated_at.lt."${cutoff}")`;
}

/**
 * What to answer NETOPIA when the claim matched no row. A row another run is
 * still processing must be retried; anything else (completed, refunded, gone)
 * is settled and gets the ACK.
 */
export function unclaimedReply(status: string | null | undefined): 'ack' | 'retry' {
  return status === 'processing' ? 'retry' : 'ack';
}
