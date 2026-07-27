import { BENIGN_NETWORK_PATTERNS } from './sentryNoise';

/**
 * True when a thrown value looks like a transport failure (no data, captive
 * portal, socket dropped while backgrounded) rather than a decision the server
 * made.
 *
 * The distinction matters wherever we retry or queue work offline: a transient
 * failure deserves a replay, while a rejection the server already issued
 * ("Estás a 5341 m del destino", "Forbidden", an invalid FSM jump) must be
 * surfaced and dropped. Queueing a rejection would spin forever and hide a real
 * message from the user.
 *
 * Reuses BENIGN_NETWORK_PATTERNS so the two places that reason about network
 * failures — Sentry noise filtering and offline retry — cannot drift apart.
 * Those patterns are deliberately narrow: they match "the operation was
 * aborted" but not "Transaction aborted by user", and "ETIMEDOUT" but not
 * "Payment timed out".
 */
export function isNetworkError(err: unknown): boolean {
  const message =
    typeof err === 'string'
      ? err
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : '';
  if (!message) return false;
  return BENIGN_NETWORK_PATTERNS.some((re) => re.test(message));
}
