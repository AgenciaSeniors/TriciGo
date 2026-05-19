/**
 * SosAlertBanner — sticky critical-alert banner for the admin dashboard.
 *
 * Rendered at the very top of the dashboard when any SOS incident is
 * currently open. One click takes the admin to the filtered incidents
 * list. Silent when there are no open SOS — no empty state, no clutter.
 *
 * Reference: I2 from ride-flow review.
 */
'use client';

import Link from 'next/link';
import { ArrowRight, Siren } from 'lucide-react';
import { useSosAlerts } from '@/hooks/useSosAlerts';

export function SosAlertBanner() {
  const { alerts, count } = useSosAlerts();

  if (count === 0) return null;

  const latest = alerts[0]!;
  const href = count === 1 && latest
    ? `/incidents/${latest.id}`
    : '/incidents?status=open';

  return (
    <Link
      href={href}
      className="group relative flex items-start gap-3 overflow-hidden rounded-2xl border border-red-500/30 bg-gradient-to-r from-red-600 to-red-500 p-4 text-white shadow-lg transition-transform hover:scale-[1.005]"
      role="alert"
    >
      {/* Pulsing ring around icon */}
      <span className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center">
        {/* eslint-disable-next-line tricigo/require-dark-variant -- translucent white on a permanently-red alert banner */}
        <span className="absolute inset-0 animate-ping rounded-full bg-white/40" aria-hidden="true" />
        {/* eslint-disable-next-line tricigo/require-dark-variant -- translucent white on a permanently-red alert banner */}
        <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/20">
          <Siren className="h-5 w-5" strokeWidth={2.2} />
        </span>
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-display text-[15px] font-bold uppercase tracking-wide">
          {count === 1 ? 'SOS activo' : `${count} alertas SOS activas`}
        </p>
        <p className="mt-0.5 text-[13px] text-white/90 line-clamp-1">
          {count === 1
            ? latest.description || 'Incidente crítico abierto. Requiere revisión inmediata.'
            : 'Múltiples pasajeros han activado el botón de emergencia.'}
        </p>
      </div>

      {/* eslint-disable-next-line tricigo/require-dark-variant -- translucent white on a permanently-red alert banner */}
      <span className="flex items-center gap-1 self-center rounded-full bg-white/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors group-hover:bg-white/30">
        Ver {count === 1 ? 'detalle' : 'lista'}
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.4} />
      </span>
    </Link>
  );
}
