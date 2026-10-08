import { describe, expect, it } from 'vitest';
import { CLAIMABLE_STATUSES, PROCESSING_LEASE_MS, claimFilter, unclaimedReply } from './payment-intent-claim';

describe('claimFilter', () => {
  it('claims a retryable status, or a processing lease older than the lease time', () => {
    const now = new Date('2026-10-08T12:00:00.000Z');
    expect(claimFilter(now)).toBe(
      'status.in.(pending,created,failed,expired),and(status.eq.processing,updated_at.lt."2026-10-08T11:50:00.000Z")',
    );
  });

  it('keeps the lease well above an Edge Function run', () => {
    // A webhook run ends in under 150 s; a lease shorter than that could let a
    // second delivery take an intent whose first run is still crediting it.
    expect(PROCESSING_LEASE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('never claims a finished intent', () => {
    expect(CLAIMABLE_STATUSES).not.toContain('completed');
    expect(CLAIMABLE_STATUSES).not.toContain('refunded');
    expect(CLAIMABLE_STATUSES).not.toContain('processing');
  });
});

describe('unclaimedReply', () => {
  it('asks NETOPIA to retry while another run holds the intent', () => {
    expect(unclaimedReply('processing')).toBe('retry');
  });

  it('acknowledges an intent that is already settled', () => {
    expect(unclaimedReply('completed')).toBe('ack');
    expect(unclaimedReply('refunded')).toBe('ack');
  });

  it('acknowledges when the intent is gone', () => {
    expect(unclaimedReply(null)).toBe('ack');
    expect(unclaimedReply(undefined)).toBe('ack');
  });
});
