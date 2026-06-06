import { describe, it, expect } from 'vitest';
import { signedLedgerAmountForAccount } from '../ledger';

describe('signedLedgerAmountForAccount', () => {
  it('sums multiple entries for the same account (mixed ride: wallet credit + commission debit)', () => {
    // "Ganancia conductor mixto": +wallet portion and −commission both land on
    // the driver's tricicoin account in one transaction. Net = 4000 − 1167.
    const entries = [
      { account_id: 'driver-tc', amount: 4000 },
      { account_id: 'driver-tc', amount: -1167 },
      { account_id: 'platform', amount: 1167 },
    ];
    expect(signedLedgerAmountForAccount(entries, 'driver-tc')).toBe(2833);
  });

  it('picks the driver credit for a tip, not the rider debit (regression: "Ajuste −778")', () => {
    // add_tip inserts the rider debit first, then the driver credit. Reading
    // entries[0] showed −778; the driver actually received +778.
    const entries = [
      { account_id: 'rider-cash', amount: -778 },
      { account_id: 'driver-tc', amount: 778 },
    ];
    expect(signedLedgerAmountForAccount(entries, 'driver-tc')).toBe(778);
    expect(signedLedgerAmountForAccount(entries, 'rider-cash')).toBe(-778);
  });

  it('handles a single-account transaction (commission on a cash ride)', () => {
    expect(signedLedgerAmountForAccount([{ account_id: 'driver-tc', amount: -1167 }], 'driver-tc')).toBe(-1167);
  });

  it('falls back to the first entry when the account is unknown', () => {
    expect(signedLedgerAmountForAccount([{ account_id: 'a', amount: 50 }], undefined)).toBe(50);
  });

  it('falls back to the first entry when no entry matches the account', () => {
    expect(signedLedgerAmountForAccount([{ account_id: 'a', amount: 50 }], 'z')).toBe(50);
  });

  it('returns 0 for empty or missing entries', () => {
    expect(signedLedgerAmountForAccount([], 'x')).toBe(0);
    expect(signedLedgerAmountForAccount(undefined, 'x')).toBe(0);
    expect(signedLedgerAmountForAccount(null, 'x')).toBe(0);
  });
});
