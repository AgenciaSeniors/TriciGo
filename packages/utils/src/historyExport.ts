// ============================================================
// TriciGo — History Export
// Generate CSV exports for ride/trip history.
// ============================================================

import { classifyWalletTxn, type WalletTxnView } from './ledger';

interface ExportableRide {
  id: string;
  status: string;
  service_type: string;
  payment_method: string;
  pickup_address: string;
  dropoff_address: string;
  estimated_fare_cup: number;
  final_fare_cup: number | null;
  estimated_fare_trc: number | null;
  final_fare_trc: number | null;
  estimated_distance_m: number;
  actual_distance_m: number | null;
  estimated_duration_s: number;
  actual_duration_s: number | null;
  created_at: string;
  completed_at: string | null;
  canceled_at: string | null;
}

const HEADERS_ES = [
  'ID',
  'Fecha',
  'Estado',
  'Tipo de servicio',
  'Método de pago',
  'Recogida',
  'Destino',
  'Tarifa CUP',
  'Tarifa TRC',
  'Distancia (km)',
  'Duración (min)',
];

const HEADERS_EN = [
  'ID',
  'Date',
  'Status',
  'Service type',
  'Payment method',
  'Pickup',
  'Dropoff',
  'Fare CUP',
  'Fare TRC',
  'Distance (km)',
  'Duration (min)',
];

const STATUS_LABELS: Record<string, Record<string, string>> = {
  es: { completed: 'Completado', canceled: 'Cancelado' },
  en: { completed: 'Completed', canceled: 'Canceled' },
};

const PAYMENT_LABELS: Record<string, Record<string, string>> = {
  es: { cash: 'Efectivo', tricicoin: 'TriciCoin', mixed: 'Mixto', stripe: 'Tarjeta', tropipay: 'Tarjeta (legacy)', corporate: 'Corporativo' },
  en: { cash: 'Cash', tricicoin: 'TriciCoin', mixed: 'Mixed', stripe: 'Card', tropipay: 'Card (legacy)', corporate: 'Corporate' },
};

const SERVICE_LABELS: Record<string, Record<string, string>> = {
  es: {
    triciclo_basico: 'Triciclo Básico',
    triciclo_premium: 'Triciclo Premium',
    moto_standard: 'Moto',
    auto_standard: 'Auto',
    mensajeria: 'Mensajería',
  },
  en: {
    triciclo_basico: 'Basic Triciclo',
    triciclo_premium: 'Premium Triciclo',
    moto_standard: 'Moto',
    auto_standard: 'Auto',
    mensajeria: 'Delivery',
  },
};

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-CU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Generate a CSV string from a list of rides.
 */
export function generateHistoryCSV(
  rides: ExportableRide[],
  locale: 'es' | 'en' = 'es',
): string {
  const headers = locale === 'es' ? HEADERS_ES : HEADERS_EN;
  const lines: string[] = [headers.join(',')];

  for (const ride of rides) {
    const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;
    const fareTrc = ride.final_fare_trc ?? ride.estimated_fare_trc ?? 0;
    const distanceKm = ((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1);
    const durationMin = Math.round(
      (ride.actual_duration_s ?? ride.estimated_duration_s) / 60,
    );
    const date = formatDate(ride.completed_at ?? ride.canceled_at ?? ride.created_at);

    const row = [
      ride.id.slice(0, 8),
      date,
      STATUS_LABELS[locale]?.[ride.status] ?? ride.status,
      SERVICE_LABELS[locale]?.[ride.service_type] ?? ride.service_type,
      PAYMENT_LABELS[locale]?.[ride.payment_method] ?? ride.payment_method,
      escapeCsv(ride.pickup_address),
      escapeCsv(ride.dropoff_address),
      fare.toString(),
      (fareTrc / 100).toFixed(2),
      distanceKm,
      durationMin.toString(),
    ];

    lines.push(row.join(','));
  }

  return lines.join('\n');
}

// ============================================================
// Wallet CSV export
// ============================================================

interface ExportableLedgerTransaction {
  id: string;
  type: string;
  reference_type?: string | null;
  metadata?: Record<string, unknown> | null;
  description: string | null;
  created_at: string;
  ledger_entries?: Array<{
    account_id?: string | null;
    amount: number;
    balance_after?: number | null;
  }>;
}

const WALLET_HEADERS_ES = ['Fecha', 'Tipo', 'Descripción', 'Monto (TRC)', 'Balance (TRC)'];
const WALLET_HEADERS_EN = ['Date', 'Type', 'Description', 'Amount (TRC)', 'Balance (TRC)'];

// Direction-aware label from the shared classifier kind (same criterion as the
// in-app surfaces; plain strings because the CSV has no i18n `t()`).
function walletCsvLabel(view: WalletTxnView, locale: 'es' | 'en'): string {
  const es = locale === 'es';
  switch (view.kind) {
    case 'recharge': return es ? 'Recarga' : 'Recharge';
    case 'ride': return view.isCredit
      ? (es ? 'Ingreso por viaje' : 'Ride earning')
      : (es ? 'Pago de viaje' : 'Ride payment');
    case 'commission': return es ? 'Comisión' : 'Commission';
    case 'gift':
    case 'transfer': return view.isCredit
      ? (es ? 'Regalo recibido' : 'Gift received')
      : (es ? 'Regalo enviado' : 'Gift sent');
    case 'tip': return view.isCredit
      ? (es ? 'Propina recibida' : 'Tip received')
      : (es ? 'Propina enviada' : 'Tip sent');
    case 'penalty': return es ? 'Penalización por cancelación' : 'Cancellation penalty';
    case 'bonus': return es ? 'Crédito promocional' : 'Promo credit';
    case 'refund': return es ? 'Reembolso' : 'Refund';
    case 'adjustment':
    default: return es ? 'Ajuste' : 'Adjustment';
  }
}

/**
 * Generate a CSV string from the driver's (or rider's) ledger transactions.
 *
 * The amount is the NET signed effect on `accountId` via the shared
 * `classifyWalletTxn` (a gift/mixed ride touches several accounts; reading
 * `ledger_entries[0]` showed the wrong row/sign). Amounts are whole TRC units
 * — same as the in-app display (`formatCUP`/`formatTriciCoin`), NOT divided by
 * 100. The label is direction-aware (gift received vs sent, tip, etc.).
 *
 * Note: the shared `getTransactions` query does not select `balance_after`, so
 * the Balance column stays blank unless callers pass it explicitly.
 */
export function generateWalletCSV(
  transactions: ExportableLedgerTransaction[],
  accountId: string | null | undefined,
  locale: 'es' | 'en' = 'es',
): string {
  const headers = locale === 'es' ? WALLET_HEADERS_ES : WALLET_HEADERS_EN;
  const lines: string[] = [headers.join(',')];

  for (const tx of transactions) {
    const view = classifyWalletTxn(
      { type: tx.type, reference_type: tx.reference_type, metadata: tx.metadata, ledger_entries: tx.ledger_entries },
      accountId,
    );
    const balance = tx.ledger_entries?.find((e) => e.account_id === accountId)?.balance_after ?? null;

    const row = [
      escapeCsv(formatDate(tx.created_at)),
      escapeCsv(walletCsvLabel(view, locale)),
      escapeCsv(tx.description ?? ''),
      String(Math.round(view.signedAmount)),
      balance !== null ? String(Math.round(balance)) : '',
    ];

    lines.push(row.join(','));
  }

  return lines.join('\n');
}
