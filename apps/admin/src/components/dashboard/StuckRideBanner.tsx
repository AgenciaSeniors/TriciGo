/**
 * StuckRideBanner — amber alert banner for rides the watchdog flagged as
 * stuck (migration 00538, Paso 4 of incident b428022b).
 *
 * Mirrors SosAlertBanner: silent when there is nothing, one click goes to
 * the ride detail. Amber (not red) — a stuck ride is operational trouble,
 * not a safety emergency like an SOS.
 */
'use client';

import Link from 'next/link';
import { ArrowRight, OctagonPause } from 'lucide-react';
import { useStuckRideAlerts } from '@/hooks/useStuckRideAlerts';

// One entry per value of the `reason` CHECK on `stuck_ride_alerts`. A missing
// key silently degrades to the generic fallback below, which is how
// 'dead_driver_app' read as "detectado como trabado" for the two months after
// 00542 introduced it.
const REASON_LABEL: Record<string, string> = {
  complete_blocked: 'El conductor intentó finalizar y el candado de distancia lo bloqueó (posible pin mal ubicado).',
  stationary_chat: 'Conductor detenido con el viaje abierto y chat activo entre las partes.',
  dead_driver_app: 'La app del conductor dejó de responder después de recoger. El pasajero puede ir a bordo — requiere revisión humana.',
};

export function StuckRideBanner() {
  const { alerts, count } = useStuckRideAlerts();

  if (count === 0) return null;

  const latest = alerts[0]!;
  const href = count === 1 ? `/rides/${latest.ride_id}` : '/rides';

  return (
    <Link
      href={href}
      className="group relative flex items-start gap-3 overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-600 to-amber-500 p-4 text-white shadow-lg transition-transform hover:scale-[1.005]"
      role="alert"
    >
      <span className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center">
        {/* eslint-disable-next-line tricigo/require-dark-variant -- translucent white on a permanently-amber alert banner */}
        <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/20">
          <OctagonPause className="h-5 w-5" strokeWidth={2.2} />
        </span>
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-display text-[15px] font-bold uppercase tracking-wide">
          {count === 1
            ? `Viaje trabado #${latest.ride_id.slice(0, 8)}`
            : `${count} viajes trabados`}
        </p>
        <p className="mt-0.5 text-[13px] text-white/90 line-clamp-1">
          {count === 1
            ? REASON_LABEL[latest.reason] ?? 'Viaje activo detectado como trabado.'
            : 'Varios viajes activos detectados como trabados por el watchdog.'}
        </p>
      </div>

      {/* eslint-disable-next-line tricigo/require-dark-variant -- translucent white on a permanently-amber alert banner */}
      <span className="flex items-center gap-1 self-center rounded-full bg-white/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors group-hover:bg-white/30">
        Ver {count === 1 ? 'viaje' : 'lista'}
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.4} />
      </span>
    </Link>
  );
}
