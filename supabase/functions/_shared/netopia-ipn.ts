// ============================================================
// Binding a NETOPIA IPN to the payment intent it names.
//
// process-netopia-webhook moves money only after asking NETOPIA whether the
// IPN's ntpID is paid. That answer says nothing about WHICH order the
// transaction belongs to, and the IPN body is attacker-controlled: one real
// paid transaction (its ntpID comes back to the payer from
// create-netopia-payment-intent) could be posted again under the orderID of
// an unpaid intent. Two guards (2026-10-06):
//  - the EF refuses an ntpID that is already stored on a different intent;
//  - if NETOPIA's status answer echoes an order id, it must be ours.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

/**
 * True when NETOPIA's status response names an order other than `orderId`.
 * A response without an order id is not a mismatch: the field's presence
 * is not documented, so its absence must not block real payments.
 */
export function requeryOrderMismatch(parsed: unknown, orderId: string): boolean {
  const echoed = (parsed as { order?: { orderID?: unknown } } | null)?.order?.orderID;
  if (typeof echoed !== 'string' || !echoed) return false;
  return echoed.trim().toLowerCase() !== orderId.trim().toLowerCase();
}
