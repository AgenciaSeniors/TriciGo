/**
 * Scenario contract: feeds REAL prod ledger shapes (captured 2026-06-07 via SQL
 * + rolled-back RPC sims) through the SHIPPED classifier and asserts what the
 * wallet history renders for each, from each viewer's perspective. Doubles as a
 * human-readable contrast (run with `vitest run` to see the printed table).
 *
 * The classifier (classifyWalletTxn / walletTxnIcon) is the shipped code; the
 * label/filter helpers mirror the client surface (apps/client wallet.tsx).
 */
import { describe, it, expect } from 'vitest';
import { classifyWalletTxn, walletTxnIcon, type WalletTxnView } from '../ledger';
import { formatTriciCoin } from '../currency';

function label(view: WalletTxnView): string {
  switch (view.kind) {
    case 'recharge': return 'Recarga de saldo';
    case 'ride': return view.isCredit ? 'Ingreso por viaje' : 'Pago de viaje';
    case 'commission': return 'Comisión';
    case 'gift':
    case 'transfer': return view.isCredit ? 'Regalo recibido' : 'Regalo enviado';
    case 'tip': return view.isCredit ? 'Propina recibida' : 'Propina enviada';
    case 'penalty': return 'Penalización por cancelación';
    case 'bonus': return 'Bonificación';
    case 'refund': return 'Reembolso';
    default: return 'Ajuste';
  }
}

function filterBucket(type: string): string {
  if (type === 'recharge') return 'Recargas';
  if (['ride_payment', 'ride_hold', 'ride_hold_release', 'redemption'].includes(type)) return 'Viajes';
  if (type === 'promo_credit') return 'Bonos';
  if (type === 'adjustment') return 'Ajustes';
  return '(solo Todos)';
}

function render(tx: { type: string; reference_type?: string | null; metadata?: Record<string, unknown> | null; ledger_entries: { account_id: string; amount: number }[] }, accountId: string) {
  const view = classifyWalletTxn(tx, accountId);
  const displayed = `${view.isZero ? '' : view.isCredit ? '+' : '−'}${formatTriciCoin(Math.abs(view.signedAmount))}`;
  return { label: label(view), displayed, color: view.isZero ? 'neutral' : view.isCredit ? 'green' : 'red', icon: walletTxnIcon(view), filter: filterBucket(tx.type) };
}

// scenario, viewer-perspective, tx (real prod shape), viewer accountId, expected
const SCENARIOS: Array<{ name: string; tx: any; view: string; exp: { label: string; displayed: string; color: string; icon: string; filter: string } }> = [
  { name: 'Ride cash — driver', view: 'drv',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'drv', amount: 2903 }] },
    exp: { label: 'Ingreso por viaje', displayed: '+2,903 TC', color: 'green', icon: 'car', filter: 'Viajes' } },
  { name: 'Ride tricicoin — customer', view: 'cust',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'cust', amount: -5910 }, { account_id: 'plat', amount: 887 }, { account_id: 'drv', amount: 5023 }] },
    exp: { label: 'Pago de viaje', displayed: '−5,910 TC', color: 'red', icon: 'car', filter: 'Viajes' } },
  { name: 'Ride tricicoin — driver', view: 'drv',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'cust', amount: -5910 }, { account_id: 'plat', amount: 887 }, { account_id: 'drv', amount: 5023 }] },
    exp: { label: 'Ingreso por viaje', displayed: '+5,023 TC', color: 'green', icon: 'car', filter: 'Viajes' } },
  { name: 'Ride mixed — customer (wallet portion)', view: 'cust',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'cust', amount: -2400 }] },
    exp: { label: 'Pago de viaje', displayed: '−2,400 TC', color: 'red', icon: 'car', filter: 'Viajes' } },
  { name: 'Ride mixed — driver (net of earning − commission)', view: 'drv',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'drv', amount: -720 }, { account_id: 'plat', amount: 720 }, { account_id: 'drv', amount: 2400 }] },
    exp: { label: 'Ingreso por viaje', displayed: '+1,680 TC', color: 'green', icon: 'car', filter: 'Viajes' } },
  { name: 'Ride discounted — customer (already-discounted amount)', view: 'cust',
    tx: { type: 'ride_payment', reference_type: 'ride', ledger_entries: [{ account_id: 'cust', amount: -1211 }, { account_id: 'plat', amount: 1053 }, { account_id: 'drv', amount: 5969 }] },
    exp: { label: 'Pago de viaje', displayed: '−1,211 TC', color: 'red', icon: 'car', filter: 'Viajes' } },
  { name: 'Recharge (+50 USD)', view: 'me',
    tx: { type: 'recharge', reference_type: 'payment_intent', ledger_entries: [{ account_id: 'me', amount: 30000 }] },
    exp: { label: 'Recarga de saldo', displayed: '+30,000 TC', color: 'green', icon: 'add-circle', filter: 'Recargas' } },
  { name: 'Gift — sender', view: 'snd',
    tx: { type: 'transfer_out', reference_type: 'wallet_transfer', metadata: { kind: 'gift' }, ledger_entries: [{ account_id: 'snd', amount: -1500 }, { account_id: 'rcv', amount: 1500 }] },
    exp: { label: 'Regalo enviado', displayed: '−1,500 TC', color: 'red', icon: 'arrow-up', filter: '(solo Todos)' } },
  { name: 'Gift — recipient', view: 'rcv',
    tx: { type: 'transfer_out', reference_type: 'wallet_transfer', metadata: { kind: 'gift' }, ledger_entries: [{ account_id: 'snd', amount: -1500 }, { account_id: 'rcv', amount: 1500 }] },
    exp: { label: 'Regalo recibido', displayed: '+1,500 TC', color: 'green', icon: 'arrow-down', filter: '(solo Todos)' } },
  { name: 'Admin adjustment — credit', view: 'me',
    tx: { type: 'adjustment', reference_type: 'admin_action', ledger_entries: [{ account_id: 'me', amount: 2500 }] },
    exp: { label: 'Reembolso', displayed: '+2,500 TC', color: 'green', icon: 'refresh', filter: 'Ajustes' } },
  { name: 'Admin adjustment — debit', view: 'me',
    tx: { type: 'adjustment', reference_type: 'admin_action', ledger_entries: [{ account_id: 'me', amount: -800 }] },
    exp: { label: 'Ajuste', displayed: '−800 TC', color: 'red', icon: 'swap-horizontal', filter: 'Ajustes' } },
  { name: 'Tip — rider (sent)', view: 'rider',
    tx: { type: 'adjustment', reference_type: 'tip', ledger_entries: [{ account_id: 'rider', amount: -480 }, { account_id: 'drv', amount: 480 }] },
    exp: { label: 'Propina enviada', displayed: '−480 TC', color: 'red', icon: 'heart', filter: 'Ajustes' } },
  { name: 'Tip — driver (received)', view: 'drv',
    tx: { type: 'adjustment', reference_type: 'tip', ledger_entries: [{ account_id: 'rider', amount: -480 }, { account_id: 'drv', amount: 480 }] },
    exp: { label: 'Propina recibida', displayed: '+480 TC', color: 'green', icon: 'heart', filter: 'Ajustes' } },
];

describe('wallet history — scenario contract (real prod shapes → shipped classifier)', () => {
  it('prints the rendered row for every scenario', () => {
    const out = SCENARIOS.map((s) => {
      const r = render(s.tx, s.view);
      return `${s.name.padEnd(46)} | ${r.label.padEnd(22)} | ${r.displayed.padStart(12)} | ${r.color.padEnd(7)} | ${r.icon.padEnd(14)} | ${r.filter}`;
    });
    // eslint-disable-next-line no-console
    console.log('\n' + 'SCENARIO'.padEnd(46) + ' | ' + 'LABEL'.padEnd(22) + ' | ' + 'AMOUNT'.padStart(12) + ' | COLOR   | ICON           | FILTER\n' + '-'.repeat(120) + '\n' + out.join('\n') + '\n');
    expect(out.length).toBe(SCENARIOS.length);
  });

  for (const s of SCENARIOS) {
    it(s.name, () => {
      expect(render(s.tx, s.view)).toEqual(s.exp);
    });
  }
});
