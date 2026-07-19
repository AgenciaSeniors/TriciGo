// Shared payment-intent claim recovery policy for provider webhooks.
//
// The database adapter deliberately lives at each call site so this module
// stays runtime-agnostic and can be exercised by the existing Vitest suite.

export type RetryablePaymentIntentStatus =
  | "pending"
  | "created"
  | "failed"
  | "expired";

export interface PaymentIntentClaimRepository {
  releaseIfProcessing(
    intentId: string,
    retryStatus: RetryablePaymentIntentStatus,
  ): Promise<{ released: boolean; error?: string }>;
  readStatus(
    intentId: string,
  ): Promise<{ status: string | null; error?: string }>;
}

const RETRYABLE_STATUSES = new Set<RetryablePaymentIntentStatus>([
  "pending",
  "created",
  "failed",
  "expired",
]);

function retryStatusFor(previousStatus: string): RetryablePaymentIntentStatus {
  return RETRYABLE_STATUSES.has(previousStatus as RetryablePaymentIntentStatus)
    ? (previousStatus as RetryablePaymentIntentStatus)
    : "pending";
}

/**
 * Release a webhook claim after the credit RPC fails.
 *
 * The repository MUST update only rows whose current status is `processing`.
 * That condition preserves `completed` when the RPC committed but its response
 * was lost, while making a genuinely failed transaction claim retryable again.
 */
export async function releasePaymentIntentClaim(
  repository: PaymentIntentClaimRepository,
  intentId: string,
  previousStatus: string,
): Promise<{ released: boolean; retryStatus: RetryablePaymentIntentStatus }> {
  const retryStatus = retryStatusFor(previousStatus);
  const result = await repository.releaseIfProcessing(intentId, retryStatus);
  if (result.error) throw new Error(result.error);
  return { released: result.released, retryStatus };
}

/** A live `processing` lease must produce a provider retry, never a final ACK. */
export async function shouldRetryUnclaimedPaymentIntent(
  repository: PaymentIntentClaimRepository,
  intentId: string,
): Promise<boolean> {
  const result = await repository.readStatus(intentId);
  if (result.error) throw new Error(result.error);
  return result.status === "processing";
}
