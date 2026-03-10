'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
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

const STATUS_LABEL: Record<string, string> = {
  searching: 'Buscando',
  accepted: 'Aceptado',
  driver_en_route: 'En camino',
  arrived_at_pickup: 'En punto',
  in_progress: 'En progreso',
  completed: 'Completado',
  canceled: 'Cancelado',
  disputed: 'En disputa',
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
        <p className="text-neutral-400">Cargando...</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">Viaje no encontrado</p>
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
          &larr; Volver a viajes
        </button>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Viaje #{ride.id.slice(0, 8)}</h1>
          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
            {STATUS_LABEL[ride.status] ?? ride.status}
          </span>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-[#FF4D00]">{formatCUP(fare)}</p>
          {ride.final_fare_cup != null && ride.final_fare_cup !== ride.estimated_fare_cup && (
            <p className="text-sm text-neutral-400 line-through">{formatCUP(ride.estimated_fare_cup)} est.</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Route */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">Ruta</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">Origen</dt>
              <dd className="text-sm font-medium">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Destino</dt>
              <dd className="text-sm font-medium">{ride.dropoff_address}</dd>
            </div>
            <div className="flex gap-6">
              <div>
                <dt className="text-sm text-neutral-500">Distancia</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_distance_m != null
                    ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                    : ride.estimated_distance_m > 0
                      ? `${(ride.estimated_distance_m / 1000).toFixed(1)} km (est.)`
                      : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Duración</dt>
                <dd className="text-sm font-medium">
                  {ride.actual_duration_s != null
                    ? `${Math.round(ride.actual_duration_s / 60)} min`
                    : `${Math.round(ride.estimated_duration_s / 60)} min (est.)`}
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Método de pago</dt>
              <dd className="text-sm font-medium">{ride.payment_method === 'cash' ? 'Efectivo' : 'TriciCoin'}</dd>
            </div>
          </dl>
        </div>

        {/* People */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">Personas</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">Cliente</dt>
              <dd className="text-sm font-medium">
                {customerInfo ? `${customerInfo.name} (${customerInfo.phone})` : ride.customer_id.slice(0, 8)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Conductor</dt>
              <dd className="text-sm font-medium">
                {driverInfo ? `${driverInfo.name} (${driverInfo.phone})` : ride.driver_id ? ride.driver_id.slice(0, 8) : 'Sin asignar'}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Pricing snapshot */}
      {pricing && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">Desglose de tarifa</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-neutral-500">Base</p>
              <p className="text-sm font-medium">{formatCUP(pricing.base_fare)}</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">Por km</p>
              <p className="text-sm font-medium">{formatCUP(pricing.per_km_rate)}/km</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">Por minuto</p>
              <p className="text-sm font-medium">{formatCUP(pricing.per_minute_rate)}/min</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">Comisión ({(pricing.commission_rate * 100).toFixed(0)}%)</p>
              <p className="text-sm font-medium">{formatCUP(pricing.commission_amount)}</p>
            </div>
          </div>
          {ride.discount_amount_cup > 0 && (
            <p className="text-sm text-green-600 mt-2">Descuento: -{formatCUP(ride.discount_amount_cup)}</p>
          )}
        </div>
      )}

      {/* Transitions timeline */}
      {transitions.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">Historial de estados</h2>
          <div className="space-y-3">
            {transitions.map((tr) => (
              <div key={tr.id} className="flex items-center gap-4">
                <div className="w-2.5 h-2.5 rounded-full bg-[#FF4D00]" />
                <div className="flex-1">
                  <span className="text-sm font-medium">
                    {STATUS_LABEL[tr.to_status] ?? tr.to_status}
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
        <h2 className="text-lg font-bold mb-4">Tiempos</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-neutral-500">Creado</p>
            <p className="text-sm font-medium">{formatDate(ride.created_at)}</p>
          </div>
          {ride.accepted_at && (
            <div>
              <p className="text-sm text-neutral-500">Aceptado</p>
              <p className="text-sm font-medium">{formatDate(ride.accepted_at)}</p>
            </div>
          )}
          {ride.driver_arrived_at && (
            <div>
              <p className="text-sm text-neutral-500">Llegada conductor</p>
              <p className="text-sm font-medium">{formatDate(ride.driver_arrived_at)}</p>
            </div>
          )}
          {ride.pickup_at && (
            <div>
              <p className="text-sm text-neutral-500">Recogida</p>
              <p className="text-sm font-medium">{formatDate(ride.pickup_at)}</p>
            </div>
          )}
          {ride.completed_at && (
            <div>
              <p className="text-sm text-neutral-500">Completado</p>
              <p className="text-sm font-medium">{formatDate(ride.completed_at)}</p>
            </div>
          )}
          {ride.canceled_at && (
            <div>
              <p className="text-sm text-neutral-500">Cancelado</p>
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
