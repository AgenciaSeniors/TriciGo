import { describe, it, expect, assert } from 'vitest';
import { generateWalletCSV } from '../historyExport';

describe('generateWalletCSV', () => {
  // Real prod shapes: a gift is ONE transfer_out for both parties; a tip is
  // adjustment+tip (rider debit + driver credit); a mixed ride touches the
  // driver's tricicoin twice. Amounts are whole TRC units (no /100).
  const txns = [
    { id: '1', type: 'transfer_out', reference_type: 'wallet_transfer', description: 'GIFT_IN_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'sender', amount: -3000 }, { account_id: 'me', amount: 3000 }] },
    { id: '2', type: 'transfer_out', reference_type: 'wallet_transfer', description: 'GIFT_OUT_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'me', amount: -3000 }, { account_id: 'other', amount: 3000 }] },
    { id: '3', type: 'adjustment', reference_type: 'tip', description: 'TIP_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'rider', amount: -480 }, { account_id: 'me', amount: 480 }] },
    { id: '4', type: 'ride_payment', reference_type: 'ride', description: 'MIXED_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'me', amount: -720 }, { account_id: 'plat', amount: 720 }, { account_id: 'me', amount: 2400 }] },
    { id: '5', type: 'adjustment', reference_type: 'cancellation_penalty', description: 'PENALTY_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'me', amount: -200 }] },
    { id: '6', type: 'recharge', reference_type: 'payment_intent', description: 'RECHARGE_TEST', created_at: '2026-06-07T03:00:00Z',
      ledger_entries: [{ account_id: 'me', amount: 11600 }] },
  ];

  const csv = generateWalletCSV(txns, 'me', 'es');
  const lines = csv.split('\n');
  const lineOf = (desc: string) => lines.find((l) => l.includes(desc)) ?? '';

  it('gift received → "Regalo recibido" + positive whole amount (not the sender debit)', () => {
    const l = lineOf('GIFT_IN_TEST');
    expect(l).toContain('Regalo recibido');
    expect(l).toContain('3000');
    expect(l).not.toContain('-3000');
  });

  it('gift sent → "Regalo enviado" + negative', () => {
    const l = lineOf('GIFT_OUT_TEST');
    expect(l).toContain('Regalo enviado');
    expect(l).toContain('-3000');
  });

  it('tip received → "Propina recibida" + 480 (the driver credit, not the rider debit)', () => {
    const l = lineOf('TIP_TEST');
    expect(l).toContain('Propina recibida');
    expect(l).toContain('480');
    expect(l).not.toContain('-480');
  });

  it('mixed ride → net +1680 (sums both tricicoin entries, not -720 / 2400)', () => {
    const l = lineOf('MIXED_TEST');
    expect(l).toContain('Ingreso por viaje');
    expect(l).toContain('1680');
  });

  it('cancellation penalty → label + -200', () => {
    const l = lineOf('PENALTY_TEST');
    expect(l).toContain('Penalización por cancelación');
    expect(l).toContain('-200');
  });

  it('recharge → 11600 whole units (NOT divided by 100)', () => {
    const l = lineOf('RECHARGE_TEST');
    expect(l).toContain('Recarga');
    expect(l).toContain('11600');
    expect(l).not.toContain('116.00');
  });

  it('English locale uses English labels', () => {
    const firstTxn = txns[0];
    assert(firstTxn);
    const csvEn = generateWalletCSV([firstTxn], 'me', 'en');
    expect(csvEn.split('\n')[1]).toContain('Gift received');
  });

  it('header row present', () => {
    expect(lines[0]).toContain('Monto (TRC)');
  });
});
