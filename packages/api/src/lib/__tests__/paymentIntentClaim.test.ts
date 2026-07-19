import { describe, expect, it } from "vitest";
import {
  releasePaymentIntentClaim,
  shouldRetryUnclaimedPaymentIntent,
  type PaymentIntentClaimRepository,
} from "../../../../../supabase/functions/_shared/payment-intent-claim";

function createRepository(initialStatus: string): {
  repository: PaymentIntentClaimRepository;
  getStatus: () => string;
} {
  let status = initialStatus;

  return {
    repository: {
      async releaseIfProcessing(_intentId, retryStatus) {
        if (status !== "processing") return { released: false };
        status = retryStatus;
        return { released: true };
      },
      async readStatus() {
        return { status };
      },
    },
    getStatus: () => status,
  };
}

describe("payment intent claim recovery", () => {
  it("releases a failed processing claim to its previous retryable status", async () => {
    const { repository, getStatus } = createRepository("processing");

    const result = await releasePaymentIntentClaim(
      repository,
      "intent-1",
      "expired",
    );

    expect(result).toEqual({ released: true, retryStatus: "expired" });
    expect(getStatus()).toBe("expired");
  });

  it("does not overwrite an intent that already completed after a lost response", async () => {
    const { repository, getStatus } = createRepository("completed");

    const result = await releasePaymentIntentClaim(
      repository,
      "intent-1",
      "pending",
    );

    expect(result).toEqual({ released: false, retryStatus: "pending" });
    expect(getStatus()).toBe("completed");
  });

  it("falls back to pending when the pre-claim status is not retryable", async () => {
    const { repository, getStatus } = createRepository("processing");

    const result = await releasePaymentIntentClaim(
      repository,
      "intent-1",
      "processing",
    );

    expect(result).toEqual({ released: true, retryStatus: "pending" });
    expect(getStatus()).toBe("pending");
  });

  it("asks the provider to retry while another invocation holds the claim", async () => {
    const { repository } = createRepository("processing");

    await expect(
      shouldRetryUnclaimedPaymentIntent(repository, "intent-1"),
    ).resolves.toBe(true);
  });

  it("acknowledges an unclaimed intent that is already completed", async () => {
    const { repository } = createRepository("completed");

    await expect(
      shouldRetryUnclaimedPaymentIntent(repository, "intent-1"),
    ).resolves.toBe(false);
  });
});
