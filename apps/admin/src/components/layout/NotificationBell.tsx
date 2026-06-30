'use client';

/**
 * NotificationBell — the header "Novedades" bell.
 *
 * Replaces the former decorative placeholder (a Bell with an always-on
 * pulsing dot and no onClick). Surfaces the admin's actionable queue,
 * reusing data sources that already exist — no new plumbing:
 *   - Open SOS incidents, realtime, via useSosAlerts (own channel topic).
 *   - Open incidents + drivers pending verification, from the same
 *     get_admin_dashboard_metrics RPC the dashboard polls.
 *
 * The badge/dot only appears when there is something real to act on, and
 * each row links to the page where the admin resolves it. Closes on
 * outside click and Escape, mirroring the user menu in the same header.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Bell, Siren, UserCheck } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useSosAlerts } from '@/hooks/useSosAlerts';

type Metrics = { open_incidents: number; pending_verifications: number };

export function NotificationBell() {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({ open_incidents: 0, pending_verifications: 0 });
  const { alerts: sosAlerts, count: sosCount } = useSosAlerts('sos-alerts-header');
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await adminService.getDashboardMetrics();
      setMetrics({
        open_incidents: m.open_incidents ?? 0,
        pending_verifications: m.pending_verifications ?? 0,
      });
    } catch {
      // Degrade silently — the bell still surfaces SOS via realtime.
    }
  }, []);

  // Keep the badge live even while the panel is closed (lightweight RPC).
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Fresh data the moment the panel opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Outside-click + Escape close (mirrors the user menu).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // SOS rows are a subset of open_incidents — counting them again would
  // double-count, so the badge total excludes them explicitly.
  const total = metrics.open_incidents + metrics.pending_verifications;
  const hasUrgent = sosCount > 0;
  const isEmpty = total === 0 && sosCount === 0;
  const close = () => setOpen(false);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('notifications_bell.aria', { defaultValue: 'Novedades' })}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
      >
        <Bell className="h-4 w-4" />
        {total > 0 ? (
          <span
            className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white ${hasUrgent ? 'bg-red-500' : 'bg-primary-500'}`}
            aria-hidden="true"
          >
            {total > 9 ? '9+' : total}
          </span>
        ) : hasUrgent ? (
          <span className="absolute right-2 top-2 flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
        ) : null}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-elev-3 animate-fade-in"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-3">
            <span className="font-display text-[14px] font-semibold text-ink">
              {t('notifications_bell.title', { defaultValue: 'Novedades' })}
            </span>
            {total > 0 && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-muted">
                {total}
              </span>
            )}
          </div>

          <div className="max-h-[22rem] overflow-y-auto">
            {/* Urgent: live SOS, each linking to its incident detail. */}
            {sosAlerts.map((a) => (
              <Link
                key={a.id}
                href={`/incidents/${a.id}`}
                onClick={close}
                role="menuitem"
                className="flex items-start gap-2.5 border-b border-line/60 px-3 py-2.5 hover:bg-surface-sunken"
              >
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
                  <Siren className="h-3.5 w-3.5" strokeWidth={2.2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-ink">
                    {t('notifications_bell.sos', { defaultValue: 'SOS activo' })}
                  </p>
                  <p className="truncate text-[11px] text-ink-muted">
                    {a.description || t('notifications_bell.sos_body', { defaultValue: 'Incidente crítico abierto.' })}
                  </p>
                </div>
              </Link>
            ))}

            {/* Open incidents bucket. */}
            {metrics.open_incidents > 0 && (
              <Link
                href="/incidents?status=open"
                onClick={close}
                role="menuitem"
                className="flex items-center gap-2.5 border-b border-line/60 px-3 py-2.5 hover:bg-surface-sunken"
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-ink">
                    {t('notifications_bell.incidents', { defaultValue: 'Incidentes abiertos' })}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    {t('notifications_bell.incidents_body', { defaultValue: 'Requieren revisión' })}
                  </p>
                </div>
                <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">
                  {metrics.open_incidents}
                </span>
              </Link>
            )}

            {/* Drivers awaiting verification. */}
            {metrics.pending_verifications > 0 && (
              <Link
                href="/drivers?status=pending_verification"
                onClick={close}
                role="menuitem"
                className="flex items-center gap-2.5 border-b border-line/60 px-3 py-2.5 hover:bg-surface-sunken"
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <UserCheck className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-ink">
                    {t('notifications_bell.pending_drivers', { defaultValue: 'Conductores por verificar' })}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    {t('notifications_bell.pending_drivers_body', { defaultValue: 'Esperan aprobación' })}
                  </p>
                </div>
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                  {metrics.pending_verifications}
                </span>
              </Link>
            )}

            {/* Nothing to act on. */}
            {isEmpty && (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
                  <Bell className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <p className="font-display text-[13px] font-semibold text-ink">
                  {t('notifications_bell.empty_title', { defaultValue: 'Sin novedades' })}
                </p>
                <p className="max-w-[28ch] text-[11.5px] text-ink-muted">
                  {t('notifications_bell.empty_body', {
                    defaultValue: 'Todo en calma. Cuando algo necesite tu atención, aparecerá aquí.',
                  })}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
