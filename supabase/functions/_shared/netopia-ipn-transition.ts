export type NetopiaMappedStatus =
  | "paid"
  | "failed"
  | "pending"
  | "refunded"
  | "unknown";

/** Only transitions that persist provider state need an authoritative re-query. */
export function requiresNetopiaStatusConfirmation(
  status: NetopiaMappedStatus,
): boolean {
  return status === "paid" || status === "refunded" || status === "failed";
}

/** Match the claimed transition to NETOPIA's independently queried status. */
export function isAuthoritativeNetopiaTransition(
  transition: NetopiaMappedStatus,
  authoritativeStatus: number | null,
): boolean {
  if (transition === "paid")
    return authoritativeStatus === 3 || authoritativeStatus === 5;
  if (transition === "refunded")
    return authoritativeStatus === 8 || authoritativeStatus === 17;
  if (transition === "failed") {
    return (
      authoritativeStatus === 4 ||
      authoritativeStatus === 12 ||
      authoritativeStatus === 13
    );
  }
  return false;
}
