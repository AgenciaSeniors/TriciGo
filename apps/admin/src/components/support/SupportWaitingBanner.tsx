/**
 * SupportWaitingBanner — rides waiting for support, on every page (mounted in AdminShell).
 * Red when a rider asked for help, amber otherwise. Each row opens /rides/[id]/assist.
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, LifeBuoy, VolumeX } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { useSupportWaitingRides } from '@/hooks/useSupportWaitingRides';
import { chimeReady, unlockChime } from '@/lib/chime';
import { waitLabel } from './supportFormat';

export function SupportWaitingBanner() {
  const { t } = useTranslation('admin');
  const { rides } = useSupportWaitingRides();
  const [soundOn, setSoundOn] = useState(false);

  // Any click on the panel unlocks the audio the browser keeps locked until then.
  useEffect(() => {
    const unlock = () => {
      unlockChime();
      setTimeout(() => setSoundOn(chimeReady()), 100);
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  if (rides.length === 0) return null;
  const help = rides.some((r) => r.help_requested_at);
  const shown = rides.slice(0, 5);

  return (
    <div
      role="alert"
      className={`border-b px-4 py-2.5 text-white md:px-6 ${help ? 'border-red-800 bg-red-700' : 'border-amber-800 bg-amber-700'}`}
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <LifeBuoy className="h-4 w-4 shrink-0" strokeWidth={2.4} />
          <p className="font-display text-[13px] font-bold uppercase tracking-wide">
            {help
              ? t('ride_assist.banner_help', { defaultValue: 'Un pasajero pidió ayuda' })
              : rides.length === 1
                ? t('ride_assist.banner_title_single', { defaultValue: '1 viaje esperando conductor' })
                : t('ride_assist.banner_title_many', { count: rides.length, defaultValue: '{{count}} viajes esperando conductor' })}
          </p>
          {!soundOn && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-white">
              <VolumeX className="h-3.5 w-3.5" />
              {t('ride_assist.banner_sound_off', { defaultValue: 'Haz clic en cualquier parte del panel para activar el sonido de las alertas.' })}
            </span>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {shown.map((r) => (
            <li key={r.ride_id}>
              <Link
                href={`/rides/${r.ride_id}/assist`}
                className="group flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1 text-[12.5px] transition-colors hover:bg-black/15"
              >
                <span className="font-mono font-semibold">#{r.code}</span>
                <span className="tabular-nums">{waitLabel(r.wait_s)}</span>
                <span className="min-w-0 truncate">{r.pickup_address} → {r.dropoff_address}</span>
                <span className="whitespace-nowrap">{r.service_type} · {formatCUP(r.estimated_fare_cup)}</span>
                {r.help_requested_at && (
                  // eslint-disable-next-line tricigo/require-dark-variant -- white chip on a banner that is always red, in both themes
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10.5px] font-semibold uppercase text-red-700">
                    {t('ride_assist.chip_help', { defaultValue: 'Pidió ayuda' })}
                  </span>
                )}
                {r.is_test && (
                  <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10.5px] font-semibold uppercase">
                    {t('ride_assist.chip_test', { defaultValue: 'Prueba' })}
                  </span>
                )}
                {r.pending_offers > 0 && (
                  <span className="text-[11px] text-white">
                    {t('ride_assist.chip_offers', { count: r.pending_offers, defaultValue: '{{count}} ofertas activas' })}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold uppercase">
                  {t('ride_assist.banner_assist', { defaultValue: 'Asistir' })}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {rides.length > shown.length && (
          <p className="px-2 text-[11.5px] text-white">
            {t('ride_assist.banner_more', { count: rides.length - shown.length, defaultValue: 'y {{count}} más' })}
          </p>
        )}
      </div>
    </div>
  );
}
