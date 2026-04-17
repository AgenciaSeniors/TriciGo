'use client';

import { useEffect, useState } from 'react';

type Props = {
  name: string;
};

function greeting(hour: number) {
  if (hour < 5) return 'Buenas noches';
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function formatDateLong(d: Date) {
  return new Intl.DateTimeFormat('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Havana',
  }).format(d);
}

function formatClock(d: Date) {
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Havana',
  }).format(d);
}

export function DashboardHero({ name }: Props) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const i = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(i);
  }, []);

  const hour = now
    ? Number(
        new Intl.DateTimeFormat('es', { hour: '2-digit', hour12: false, timeZone: 'America/Havana' })
          .format(now)
          .replace(/\D/g, ''),
      )
    : 9;
  const firstName = name?.split(/[.@\s]/)[0] || '';
  const capitalized = firstName ? firstName[0]!.toUpperCase() + firstName.slice(1) : '';

  return (
    <div className="admin-aurora relative overflow-hidden rounded-2xl border border-line bg-surface-elevated px-5 py-6 md:px-7 md:py-8">
      <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-subtle">
            {now ? formatDateLong(now) : '—'}
          </span>
          <h1 className="font-display text-[28px] font-semibold leading-[1.08] tracking-[-0.025em] text-ink md:text-[36px]">
            {greeting(hour)}
            {capitalized && <span className="text-ink-muted">, {capitalized}</span>}
            <span className="text-primary-500">.</span>
          </h1>
          <p className="max-w-xl text-[13px] text-ink-muted">
            Así se mueve <span className="font-editorial italic">Cuba</span> ahora mismo. Pulso en vivo, auto-refresh cada 30 s.
          </p>
        </div>

        {/* Cuba clock */}
        <div className="flex items-stretch overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex flex-col justify-between px-4 py-2.5">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-500" aria-hidden="true" />
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                La Habana · CUT
              </span>
            </span>
            <span className="font-editorial text-[28px] leading-none italic text-ink" data-tabular>
              {now ? formatClock(now) : '—'}
            </span>
            <span className="text-[10px] text-ink-subtle">16 provincias · 168 municipios</span>
          </div>
        </div>
      </div>
    </div>
  );
}
