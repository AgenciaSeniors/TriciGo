// ============================================================
// TriciGo — History Export
// Generate CSV exports for ride/trip history.
// ============================================================

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
