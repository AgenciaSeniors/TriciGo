import { describe, it, expect } from 'vitest';
import { signedLedgerAmountForAccount, classifyWalletTxn, walletTxnIcon } from '../ledger';

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

describe('classifyWalletTxn', () => {
  it('gift received: transfer_out + wallet_transfer, recipient credit → kind gift, direction in', () => {
    const tx = {
      type: 'transfer_out',
      reference_type: 'wallet_transfer',
      ledger_entries: [
        { account_id: 'sender', amount: -3000 },
        { account_id: 'me', amount: 3000 },
      ],
    };
    const v = classifyWalletTxn(tx, 'me');
    expect(v).toMatchObject({ kind: 'gift', direction: 'in', isCredit: true, isZero: false, signedAmount: 3000 });
  });

  it('gift sent: same transaction from the sender → direction out, debit', () => {
    const tx = {
      type: 'transfer_out',
      reference_type: 'wallet_transfer',
      ledger_entries: [
        { account_id: 'me', amount: -3000 },
        { account_id: 'recipient', amount: 3000 },
      ],
    };
    const v = classifyWalletTxn(tx, 'me');
    expect(v).toMatchObject({ kind: 'gift', direction: 'out', isCredit: false, signedAmount: -3000 });
  });

  it('detects a gift via metadata.kind when reference_type is absent', () => {
    const tx = {
      type: 'transfer_out',
      reference_type: null,
      metadata: { kind: 'gift' },
      ledger_entries: [{ account_id: 'me', amount: 500 }],
    };
    expect(classifyWalletTxn(tx, 'me').kind).toBe('gift');
  });

  it('tip received (driver) vs tip sent (rider): kind tip, direction by sign', () => {
    const tx = {
      type: 'adjustment',
      reference_type: 'tip',
      ledger_entries: [
        { account_id: 'rider', amount: -480 },
        { account_id: 'driver', amount: 480 },
      ],
    };
    expect(classifyWalletTxn(tx, 'driver')).toMatchObject({ kind: 'tip', direction: 'in', isCredit: true });
    expect(classifyWalletTxn(tx, 'rider')).toMatchObject({ kind: 'tip', direction: 'out', isCredit: false });
  });

  it('mixed ride (3 entries, driver tricicoin touched twice) → kind ride, net +1680', () => {
    const tx = {
      type: 'ride_payment',
      reference_type: 'ride',
      ledger_entries: [
        { account_id: 'driver-tc', amount: -720 },   // commission
        { account_id: 'platform', amount: 720 },
        { account_id: 'driver-tc', amount: 2400 },    // earning
      ],
    };
    expect(classifyWalletTxn(tx, 'driver-tc')).toMatchObject({ kind: 'ride', signedAmount: 1680, isCredit: true });
  });

  it('recharge → kind recharge, credit', () => {
    const tx = { type: 'recharge', reference_type: 'payment_intent', ledger_entries: [{ account_id: 'me', amount: 11600 }] };
    expect(classifyWalletTxn(tx, 'me')).toMatchObject({ kind: 'recharge', direction: 'in', isCredit: true });
  });

  it('cancellation penalty → kind penalty, debit', () => {
    const tx = { type: 'adjustment', reference_type: 'cancellation_penalty', ledger_entries: [{ account_id: 'me', amount: -200 }] };
    expect(classifyWalletTxn(tx, 'me')).toMatchObject({ kind: 'penalty', direction: 'out', isCredit: false });
  });

  it('referral bonus → kind bonus', () => {
    const tx = {
      type: 'promo_credit',
      reference_type: 'referral',
      ledger_entries: [{ account_id: 'platform', amount: -94 }, { account_id: 'me', amount: 94 }],
    };
    expect(classifyWalletTxn(tx, 'me')).toMatchObject({ kind: 'bonus', direction: 'in' });
  });

  it('commission → kind commission', () => {
    const tx = { type: 'commission', reference_type: 'ride', ledger_entries: [{ account_id: 'me', amount: -887 }, { account_id: 'platform', amount: 887 }] };
    expect(classifyWalletTxn(tx, 'me')).toMatchObject({ kind: 'commission', isCredit: false });
  });

  it('admin adjustment: debit → adjustment, credit → refund', () => {
    const debit = { type: 'adjustment', reference_type: 'admin_adjustment', ledger_entries: [{ account_id: 'me', amount: -100 }] };
    const credit = { type: 'adjustment', reference_type: 'admin_adjustment', ledger_entries: [{ account_id: 'me', amount: 100 }] };
    expect(classifyWalletTxn(debit, 'me').kind).toBe('adjustment');
    expect(classifyWalletTxn(credit, 'me').kind).toBe('refund');
  });

  it('zero net → isZero true, direction neutral, not credit', () => {
    const tx = { type: 'adjustment', reference_type: 'wallet_unify', ledger_entries: [{ account_id: 'me', amount: 0 }] };
    expect(classifyWalletTxn(tx, 'me')).toMatchObject({ isZero: true, direction: 'neutral', isCredit: false, signedAmount: 0 });
  });
});

describe('walletTxnIcon', () => {
  it('gift direction → arrow in/out', () => {
    expect(walletTxnIcon({ kind: 'gift', direction: 'in' })).toBe('arrow-down');
    expect(walletTxnIcon({ kind: 'gift', direction: 'out' })).toBe('arrow-up');
    expect(walletTxnIcon({ kind: 'transfer', direction: 'in' })).toBe('arrow-down');
  });
  it('tip → heart', () => {
    expect(walletTxnIcon({ kind: 'tip', direction: 'in' })).toBe('heart');
  });
  it('maps the remaining kinds', () => {
    expect(walletTxnIcon({ kind: 'recharge', direction: 'in' })).toBe('add-circle');
    expect(walletTxnIcon({ kind: 'ride', direction: 'out' })).toBe('car');
    expect(walletTxnIcon({ kind: 'commission', direction: 'out' })).toBe('trending-down');
    expect(walletTxnIcon({ kind: 'bonus', direction: 'in' })).toBe('gift');
    expect(walletTxnIcon({ kind: 'penalty', direction: 'out' })).toBe('remove-circle');
    expect(walletTxnIcon({ kind: 'refund', direction: 'in' })).toBe('refresh');
    expect(walletTxnIcon({ kind: 'adjustment', direction: 'out' })).toBe('swap-horizontal');
  });
});
