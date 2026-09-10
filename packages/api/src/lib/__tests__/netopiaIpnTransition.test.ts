import { describe, expect, it } from "vitest";
import {
  isAuthoritativeNetopiaTransition,
  requiresNetopiaStatusConfirmation,
} from "../../../../../supabase/functions/_shared/netopia-ipn-transition";

describe("NETOPIA IPN transition authentication", () => {
  it.each(["paid", "refunded", "failed"] as const)(
    "requires an authoritative status query before persisting %s",
    (transition) => {
      expect(requiresNetopiaStatusConfirmation(transition)).toBe(true);
    },
  );

  it.each(["pending", "unknown"] as const)(
    "does not query NETOPIA for non-persistent %s notifications",
    (transition) => {
      expect(requiresNetopiaStatusConfirmation(transition)).toBe(false);
    },
  );

  it.each([3, 5])("accepts authoritative paid status %s", (status) => {
    expect(isAuthoritativeNetopiaTransition("paid", status)).toBe(true);
  });

  it.each([8, 17])("accepts authoritative refund status %s", (status) => {
    expect(isAuthoritativeNetopiaTransition("refunded", status)).toBe(true);
  });

  it.each([4, 12, 13])("accepts authoritative failure status %s", (status) => {
    expect(isAuthoritativeNetopiaTransition("failed", status)).toBe(true);
  });

  it("rejects a forged failed IPN when NETOPIA reports a paid transaction", () => {
    expect(isAuthoritativeNetopiaTransition("failed", 3)).toBe(false);
  });

  it("rejects missing or unrelated authoritative statuses", () => {
    expect(isAuthoritativeNetopiaTransition("failed", null)).toBe(false);
    expect(isAuthoritativeNetopiaTransition("paid", 15)).toBe(false);
    expect(isAuthoritativeNetopiaTransition("refunded", 12)).toBe(false);
  });
});
