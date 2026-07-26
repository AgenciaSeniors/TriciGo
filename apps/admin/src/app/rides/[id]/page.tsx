'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import type { Ride, RidePricingSnapshot, RideTransition } from '@tricigo/types';
import type { DeliveryDetails } from '@tricigo/api';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { formatAdminDate } from '@/lib/formatDate';

// States from which an admin may cancel a ride (matches valid_transitions
// rows granting admin/super_admin → canceled, incl. in_progress from mig 00485).
const CANCELABLE_STATUSES = [
  'searching', 'accepted', 'driver_en_route',
  'arrived_at_pickup', 'in_progress', 'arrived_at_destination',
];

const STATUS_BADGE: Record<string, string> = {
  searching: 'bg-yellow-100 text-yellow-700',
  accepted: 'bg-blue-100 text-blue-700',
  driver_en_route: 'bg-blue-100 text-blue-700',
  arrived_at_pickup: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  canceled: 'bg-red-100 text-red-700',
  disputed: 'bg-orange-100 text-orange-700',
};

const STATUS_LABEL_KEY: Record<string, string> = {
  searching: 'rides.status_searching',
  accepted: 'rides.status_accepted',
  driver_en_route: 'rides.status_driver_en_route',
  arrived_at_pickup: 'rides.status_arrived_at_pickup',
  in_progress: 'rides.status_in_progress',
  completed: 'rides.status_completed',
  canceled: 'rides.status_canceled',
  disputed: 'rides.status_disputed',
};

const PAYMENT_KEY: Record<string, string> = {
  cash: 'rides.payment_cash',
  tricicoin: 'rides.payment_tricicoin',
  mixed: 'rides.payment_mixed',
  corporate: 'rides.payment_corporate',
  tropipay: 'rides.payment_tropipay',
  stripe: 'rides.payment_tropipay',
};

const PACKAGE_CATEGORY_KEY: Record<string, string> = {
  documentos: 'rides.cargo_cat_documentos',
  paquete_pequeno: 'rides.cargo_cat_paquete_pequeno',
  paquete_grande: 'rides.cargo_cat_paquete_grande',
  comida: 'rides.cargo_cat_comida',
  fragil: 'rides.cargo_cat_fragil',
};

type RideDetail = {
  ride: Ride;
  transitions: RideTransition[];
  pricing: RidePricingSnapshot | null;
  driverInfo: { name: string; phone: string } | null;
  customerInfo: { name: string; phone: string } | null;
  delivery: DeliveryDetails | null;
};

export default function RideDetailPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const refetch = useCallback(async () => {
    if (!id) return;
    const data = await adminService.getRideDetail(id);
    setDetail(data);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await adminService.getRideDetail(id);
        if (!cancelled) setDetail(data);
      } catch (err) {
        // Error handled by UI
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  const handleCancelConfirm = async () => {
    if (!detail) return;
    try {
      await adminService.cancelRide(detail.ride.id, cancelReason.trim() || undefined);
      showToast('success', t('rides.cancel_success', { defaultValue: 'Viaje cancelado' }));
      setCancelOpen(false);
      setCancelReason('');
      await refetch();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'error';
      const msg =
        code === 'ride_already_closed'
          ? t('rides.cancel_already_closed', { defaultValue: 'El viaje ya estaba cerrado' })
          : code === 'forbidden'
            ? t('rides.cancel_forbidden', { defaultValue: 'No tienes permiso para cancelar viajes' })
            : t('rides.cancel_error', { defaultValue: 'No se pudo cancelar el viaje' });
      showToast('error', msg);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-ink-subtle">{t('common.loading')}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-ink-subtle">{t('rides.ride_not_found')}</p>
      </div>
    );
  }

  const { ride, transitions, pricing, driverInfo, customerInfo, delivery } = detail;
  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;

  // A cargo ride is stored with the chosen vehicle's slug, so ride_mode is the
  // only way to tell a shipment from a normal ride.
  const isCargo = ride.ride_mode === 'cargo';

  // What still blocks completion. tg_rides_require_delivery_proof (00438)
  // refuses the move to 'completed' until BOTH the recipient OTP is validated
  // and the delivery photo exists; is_admin() is the only bypass. Spelling the
  // blockers out is the point of this card — the admin holds the override and
  // could not see what it was for.
  const proofBlockers: string[] = [];
  if (isCargo && ride.status !== 'completed' && ride.status !== 'canceled') {
    if (!delivery) {
      proofBlockers.push(t('rides.cargo_blocker_no_details', { defaultValue: 'Faltan los datos del envío' }));
    } else {
      if (!delivery.delivery_otp_validated_at) {
        proofBlockers.push(t('rides.cargo_blocker_otp', { defaultValue: 'Falta validar el código del destinatario' }));
      }
      if (!delivery.delivery_photo_url) {
        proofBlockers.push(t('rides.cargo_blocker_photo', { defaultValue: 'Falta la foto de entrega' }));
      }
    }
  }

  return (
    <div className="max-w-4xl">
      <AdminBreadcrumb items={[{ label: 'Viajes', href: '/rides' }, { label: 'Detalle del viaje' }]} />

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{t('rides.ride_detail')} #{ride.id.slice(0, 8)}</h1>
          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${STATUS_BADGE[ride.status] ?? 'bg-surface-sunken text-ink-muted'}`}>
            {STATUS_LABEL_KEY[ride.status] ? t(STATUS_LABEL_KEY[ride.status]!) : ride.status}
          </span>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-primary-500">{formatCUP(fare)}</p>
          {ride.final_fare_cup != null && ride.final_fare_cup !== ride.estimated_fare_cup && (
            <p className="text-sm text-ink-subtle line-through">{formatCUP(ride.estimated_fare_cup)} {t('rides.estimated')}</p>
          )}
          {CANCELABLE_STATUSES.includes(ride.status) && (
            <button
              onClick={() => { setCancelReason(''); setCancelOpen(true); }}
              className="mt-3 px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium"
            >
              {t('rides.cancel_ride', { defaultValue: 'Cancelar viaje' })}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Route */}
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6">
          <h2 className="text-lg font-bold mb-4">{t('rides.route_section')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-ink-muted">{t('rides.label_origin')}</dt>
              <dd className="text-sm font-medium">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-muted">{t('rides.label_destination')}</dt>
              <dd className="text-sm font-medium">{ride.dropoff_address}</dd>
            </div>
            <div className="flex gap-6">
              <div>
                <dt className="text-sm text-ink-muted">{t('rides.label_distance')}</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_distance_m != null
                    ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                    : ride.estimated_distance_m > 0
                      ? `${(ride.estimated_distance_m / 1000).toFixed(1)} km (${t('rides.estimated')})`
                      : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-ink-muted">{t('rides.label_duration')}</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_duration_s != null
                    ? `${Math.round(ride.actual_duration_s / 60)} min`
                    : `${Math.round(ride.estimated_duration_s / 60)} min (${t('rides.estimated')})`}
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-sm text-ink-muted">{t('rides.label_payment_method')}</dt>
              <dd className="text-sm font-medium">{PAYMENT_KEY[ride.payment_method] ? t(PAYMENT_KEY[ride.payment_method]!) : ride.payment_method}</dd>
            </div>
          </dl>
        </div>

        {/* People */}
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6">
          <h2 className="text-lg font-bold mb-4">{t('rides.people_section')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-ink-muted">{t('rides.label_customer')}</dt>
              <dd className="text-sm font-medium">
                {customerInfo ? `${customerInfo.name} (${customerInfo.phone})` : ride.customer_id.slice(0, 8)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-muted">{t('rides.label_driver')}</dt>
              <dd className="text-sm font-medium">
                {driverInfo ? `${driverInfo.name} (${driverInfo.phone})` : ride.driver_id ? ride.driver_id.slice(0, 8) : t('rides.no_driver_assigned')}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Shipment (cargo) */}
      {isCargo && (
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('rides.cargo_section', { defaultValue: 'Envío' })}</h2>

          {/* Blockers first: this is what the admin opened the page for. Icon +
              text, never colour alone. */}
          {proofBlockers.length > 0 && (
            <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 mb-4">
              <svg className="w-5 h-5 shrink-0 text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.19-1.458-1.516-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="text-sm font-medium text-amber-900">
                  {t('rides.cargo_cannot_complete', { defaultValue: 'Este envío todavía no puede completarse' })}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {proofBlockers.map((b) => (
                    <li key={b} className="text-sm text-amber-800">· {b}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {!delivery ? (
            <p className="text-sm text-ink-muted">
              {t('rides.cargo_no_details', {
                defaultValue: 'Este viaje es un envío pero no tiene datos de paquete guardados. No se puede completar salvo por un admin.',
              })}
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <div>
                  <dt className="text-sm text-ink-muted">{t('rides.cargo_recipient', { defaultValue: 'Destinatario' })}</dt>
                  <dd className="text-sm font-medium">
                    {delivery.recipient_name || '—'}
                    {delivery.recipient_phone ? ` (${delivery.recipient_phone})` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-ink-muted">{t('rides.cargo_category', { defaultValue: 'Categoría' })}</dt>
                  <dd className="text-sm font-medium">
                    {delivery.package_category && PACKAGE_CATEGORY_KEY[delivery.package_category]
                      ? t(PACKAGE_CATEGORY_KEY[delivery.package_category]!)
                      : delivery.package_category || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-ink-muted">{t('rides.cargo_description', { defaultValue: 'Paquete' })}</dt>
                  <dd className="text-sm font-medium">{delivery.package_description || '—'}</dd>
                </div>
                <div>
                  <dt className="text-sm text-ink-muted">{t('rides.cargo_size', { defaultValue: 'Peso y medidas' })}</dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {[
                      delivery.estimated_weight_kg != null ? `${delivery.estimated_weight_kg} kg` : null,
                      delivery.package_length_cm && delivery.package_width_cm && delivery.package_height_cm
                        ? `${delivery.package_length_cm}×${delivery.package_width_cm}×${delivery.package_height_cm} cm`
                        : null,
                    ].filter(Boolean).join(' · ') || '—'}
                  </dd>
                </div>
                {delivery.special_instructions && (
                  <div className="md:col-span-2">
                    <dt className="text-sm text-ink-muted">{t('rides.cargo_instructions', { defaultValue: 'Instrucciones' })}</dt>
                    <dd className="text-sm font-medium">{delivery.special_instructions}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm text-ink-muted">{t('rides.cargo_otp', { defaultValue: 'Código de entrega' })}</dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {delivery.delivery_otp ?? '—'}
                    {delivery.delivery_otp_validated_at ? (
                      <span className="ml-2 text-green-700">
                        {t('rides.cargo_otp_validated', { defaultValue: 'validado' })} · {formatAdminDate(delivery.delivery_otp_validated_at)}
                      </span>
                    ) : (
                      <span className="ml-2 text-ink-subtle">
                        {t('rides.cargo_otp_pending', { defaultValue: 'sin validar' })}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>

              {(delivery.pickup_photo_url || delivery.delivery_photo_url) && (
                <div className="flex flex-wrap gap-4 mt-4">
                  {([
                    ['rides.cargo_photo_pickup', 'Foto de recogida', delivery.pickup_photo_url],
                    ['rides.cargo_photo_delivery', 'Foto de entrega', delivery.delivery_photo_url],
                  ] as const).map(([key, fallback, url]) =>
                    url ? (
                      <figure key={key}>
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          {/* Plain <img>, not next/image: these are Supabase
                              Storage URLs whose host is not in the images
                              remotePatterns allowlist, and an admin thumbnail
                              does not need the optimizer. */}
                          <img
                            src={url}
                            alt={t(key, { defaultValue: fallback })}
                            className="w-32 h-32 object-cover rounded-lg border border-line"
                            width={128}
                            height={128}
                            loading="lazy"
                          />
                        </a>
                        <figcaption className="text-xs text-ink-subtle mt-1">
                          {t(key, { defaultValue: fallback })}
                        </figcaption>
                      </figure>
                    ) : null,
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Pricing snapshot */}
      {pricing && (
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('rides.fare_breakdown')}</h2>
          {/* A2 (2026-06-04): split de dinero (reconcilia) en vez de las tasas
              base/per_km/per_min — el snapshot las guarda como DEFAULT del
              servicio, no las de la pricing rule, así que no reflejan lo cobrado.
              Total − comisión = ganancia del conductor. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_trip_fare', { defaultValue: 'Tarifa del viaje' })}</p>
              <p className="text-sm font-medium">{formatCUP(pricing.subtotal)}</p>
            </div>
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_total_charged', { defaultValue: 'Total cobrado' })}</p>
              <p className="text-sm font-medium">{formatCUP(ride.final_fare_cup ?? ride.estimated_fare_cup)}</p>
            </div>
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_commission')} ({(pricing.commission_rate * 100).toFixed(0)}%)</p>
              <p className="text-sm font-medium">{formatCUP(pricing.commission_amount)}</p>
            </div>
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_driver_earnings', { defaultValue: 'Conductor' })}</p>
              <p className="text-sm font-medium">{formatCUP((ride.final_fare_cup ?? ride.estimated_fare_cup) - pricing.commission_amount)}</p>
            </div>
          </div>
          {ride.discount_amount_cup > 0 && (
            <p className="text-sm text-green-600 mt-2">{t('rides.label_discount')}: -{formatCUP(ride.discount_amount_cup)}</p>
          )}
        </div>
      )}

      {/* Transitions timeline */}
      {transitions.length > 0 && (
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('rides.status_history')}</h2>
          <div className="space-y-3">
            {transitions.map((tr) => (
              <div key={tr.id} className="flex items-center gap-4">
                <div className="w-2.5 h-2.5 rounded-full bg-primary-500" />
                <div className="flex-1">
                  <span className="text-sm font-medium">
                    {STATUS_LABEL_KEY[tr.to_status] ? t(STATUS_LABEL_KEY[tr.to_status]!) : tr.to_status}
                  </span>
                  {tr.reason && (
                    <span className="text-xs text-ink-subtle ml-2">({tr.reason})</span>
                  )}
                </div>
                <span className="text-xs text-ink-subtle">{formatAdminDate(tr.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps grid */}
      <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-6">
        <h2 className="text-lg font-bold mb-4">{t('rides.timestamps')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-ink-muted">{t('rides.label_created')}</p>
            <p className="text-sm font-medium">{formatAdminDate(ride.created_at)}</p>
          </div>
          {ride.accepted_at && (
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_accepted')}</p>
              <p className="text-sm font-medium">{formatAdminDate(ride.accepted_at)}</p>
            </div>
          )}
          {ride.driver_arrived_at && (
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_driver_arrived')}</p>
              <p className="text-sm font-medium">{formatAdminDate(ride.driver_arrived_at)}</p>
            </div>
          )}
          {ride.pickup_at && (
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_pickup')}</p>
              <p className="text-sm font-medium">{formatAdminDate(ride.pickup_at)}</p>
            </div>
          )}
          {ride.completed_at && (
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_completed_at')}</p>
              <p className="text-sm font-medium">{formatAdminDate(ride.completed_at)}</p>
            </div>
          )}
          {ride.canceled_at && (
            <div>
              <p className="text-sm text-ink-muted">{t('rides.label_canceled_at')}</p>
              <p className="text-sm font-medium">{formatAdminDate(ride.canceled_at)}</p>
              {ride.cancellation_reason && (
                <p className="text-xs text-ink-subtle">{ride.cancellation_reason}</p>
              )}
            </div>
          )}
        </div>
      </div>

      <AdminConfirmModal
        open={cancelOpen}
        variant="danger"
        title={t('rides.cancel_confirm_title', { defaultValue: 'Cancelar viaje' })}
        message={
          ride.status === 'in_progress'
            ? t('rides.cancel_in_progress_warning', { defaultValue: 'Este viaje está en curso. Se cancelará sin cobro y sin afectar la calificación del pasajero ni del conductor.' })
            : t('rides.cancel_confirm_body', { defaultValue: 'Se cancelará el viaje sin cobro y sin afectar la calificación del pasajero ni del conductor.' })
        }
        confirmLabel={t('rides.cancel_submit', { defaultValue: 'Sí, cancelar viaje' })}
        cancelLabel={t('rides.cancel_dismiss', { defaultValue: 'No, volver' })}
        inputValue={cancelReason}
        onInputChange={setCancelReason}
        inputPlaceholder={t('rides.cancel_reason_placeholder', { defaultValue: 'Motivo (opcional)' })}
        onConfirm={handleCancelConfirm}
        onCancel={() => setCancelOpen(false)}
      />
    </div>
  );
}
