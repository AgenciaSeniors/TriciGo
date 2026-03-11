'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride, RidePricingSnapshot, RideTransition } from '@tricigo/types';

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
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

type RideDetail = {
  ride: Ride;
  transitions: RideTransition[];
  pricing: RidePricingSnapshot | null;
  driverInfo: { name: string; phone: string } | null;
  customerInfo: { name: string; phone: string } | null;
};

export default function RideDetailPage() {
  const { t } = useTranslation('admin');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<RideDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await adminService.getRideDetail(id);
        if (!cancelled) setDetail(data);
      } catch (err) {
        console.error('Error loading ride:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('rides.ride_not_found')}</p>
      </div>
    );
  }

  const { ride, transitions, pricing, driverInfo, customerInfo } = detail;
  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.push('/rides')}
          className="text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
        >
          &larr; {t('rides.back_to_rides')}
        </button>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{t('rides.ride_detail')} #{ride.id.slice(0, 8)}</h1>
          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
            {STATUS_LABEL_KEY[ride.status] ? t(STATUS_LABEL_KEY[ride.status]!) : ride.status}
          </span>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-primary-500">{formatCUP(fare)}</p>
          {ride.final_fare_cup != null && ride.final_fare_cup !== ride.estimated_fare_cup && (
            <p className="text-sm text-neutral-400 line-through">{formatCUP(ride.estimated_fare_cup)} {t('rides.estimated')}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Route */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('rides.route_section')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">{t('rides.label_origin')}</dt>
              <dd className="text-sm font-medium">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('rides.label_destination')}</dt>
              <dd className="text-sm font-medium">{ride.dropoff_address}</dd>
            </div>
            <div className="flex gap-6">
              <div>
                <dt className="text-sm text-neutral-500">{t('rides.label_distance')}</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_distance_m != null
                    ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                    : ride.estimated_distance_m > 0
                      ? `${(ride.estimated_distance_m / 1000).toFixed(1)} km (${t('rides.estimated')})`
                      : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('rides.label_duration')}</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_duration_s != null
                    ? `${Math.round(ride.actual_duration_s / 60)} min`
                    : `${Math.round(ride.estimated_duration_s / 60)} min (${t('rides.estimated')})`}
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('rides.label_payment_method')}</dt>
              <dd className="text-sm font-medium">{PAYMENT_KEY[ride.payment_method] ? t(PAYMENT_KEY[ride.payment_method]!) : ride.payment_method}</dd>
            </div>
          </dl>
        </div>

        {/* People */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('rides.people_section')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">{t('rides.label_customer')}</dt>
              <dd className="text-sm font-medium">
                {customerInfo ? `${customerInfo.name} (${customerInfo.phone})` : ride.customer_id.slice(0, 8)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('rides.label_driver')}</dt>
              <dd className="text-sm font-medium">
                {driverInfo ? `${driverInfo.name} (${driverInfo.phone})` : ride.driver_id ? ride.driver_id.slice(0, 8) : t('rides.no_driver_assigned')}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Pricing snapshot */}
      {pricing && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('rides.fare_breakdown')}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_base_fare')}</p>
              <p className="text-sm font-medium">{formatCUP(pricing.base_fare)}</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_per_km')}</p>
              <p className="text-sm font-medium">{formatCUP(pricing.per_km_rate)}/km</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_per_minute')}</p>
              <p className="text-sm font-medium">{formatCUP(pricing.per_minute_rate)}/min</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_commission')} ({(pricing.commission_rate * 100).toFixed(0)}%)</p>
              <p className="text-sm font-medium">{formatCUP(pricing.commission_amount)}</p>
            </div>
          </div>
          {ride.discount_amount_cup > 0 && (
            <p className="text-sm text-green-600 mt-2">{t('rides.label_discount')}: -{formatCUP(ride.discount_amount_cup)}</p>
          )}
        </div>
      )}

      {/* Transitions timeline */}
      {transitions.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
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
                    <span className="text-xs text-neutral-400 ml-2">({tr.reason})</span>
                  )}
                </div>
                <span className="text-xs text-neutral-400">{formatDate(tr.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps grid */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
        <h2 className="text-lg font-bold mb-4">{t('rides.timestamps')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-neutral-500">{t('rides.label_created')}</p>
            <p className="text-sm font-medium">{formatDate(ride.created_at)}</p>
          </div>
          {ride.accepted_at && (
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_accepted')}</p>
              <p className="text-sm font-medium">{formatDate(ride.accepted_at)}</p>
            </div>
          )}
          {ride.driver_arrived_at && (
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_driver_arrived')}</p>
              <p className="text-sm font-medium">{formatDate(ride.driver_arrived_at)}</p>
            </div>
          )}
          {ride.pickup_at && (
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_pickup')}</p>
              <p className="text-sm font-medium">{formatDate(ride.pickup_at)}</p>
            </div>
          )}
          {ride.completed_at && (
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_completed_at')}</p>
              <p className="text-sm font-medium">{formatDate(ride.completed_at)}</p>
            </div>
          )}
          {ride.canceled_at && (
            <div>
              <p className="text-sm text-neutral-500">{t('rides.label_canceled_at')}</p>
              <p className="text-sm font-medium">{formatDate(ride.canceled_at)}</p>
              {ride.cancellation_reason && (
                <p className="text-xs text-neutral-400">{ride.cancellation_reason}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
