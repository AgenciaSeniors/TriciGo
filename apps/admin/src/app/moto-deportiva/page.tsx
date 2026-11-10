'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bike, Plus, Search } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  motoDeportivaService,
  type MotoDeportivaMetrics,
  type MotoDeportivaOverview,
  type MotoDeportivaPilot,
  type MotoDeportivaSubscriber,
} from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

const PERIODS = [7, 30, 90] as const;

const STATUS_TONE: Record<string, string> = {
  available: 'bg-green-500/10 text-green-700 dark:text-green-400',
  busy: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
  offline: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  off: 'bg-surface-sunken text-ink-muted',
};

/**
 * Moto Deportiva: the on/off switch, the pilots, the people waiting for a notice and the numbers.
 * Super admins only (middleware and every RPC). The RPCs may not exist yet: any failure shows a
 * "not available" state instead of crashing.
 */
export default function MotoDeportivaPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [overview, setOverview] = useState<MotoDeportivaOverview | null>(null);
  const [subscribers, setSubscribers] = useState<MotoDeportivaSubscriber[] | null>(null);
  const [metrics, setMetrics] = useState<MotoDeportivaMetrics | null>(null);
  const [days, setDays] = useState<number>(30);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [pilotToRemove, setPilotToRemove] = useState<MotoDeportivaPilot | null>(null);
  const [subToRemove, setSubToRemove] = useState<MotoDeportivaSubscriber | null>(null);
  const [filter, setFilter] = useState('');

  const closeToggle = useCallback(() => setToggleOpen(false), []);
  const closePilot = useCallback(() => setPilotToRemove(null), []);
  const closeSub = useCallback(() => setSubToRemove(null), []);

  const errorMessage = useCallback(
    (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      switch (code) {
        case 'MOTO_DEPORTIVA_PHONE_NOT_FOUND':
          return t('moto_deportiva.err_phone_not_found', { defaultValue: 'No hay ninguna cuenta con ese teléfono confirmado' });
        case 'MOTO_DEPORTIVA_NOT_AN_APPROVED_MOTO_DRIVER':
          return t('moto_deportiva.err_not_moto_driver', { defaultValue: 'Esa cuenta no es un conductor aprobado con moto' });
        case 'MOTO_DEPORTIVA_NOT_SUBSCRIBED':
          return t('moto_deportiva.err_not_subscribed', { defaultValue: 'Esa persona ya no está en el aviso.' });
        case 'MOTO_DEPORTIVA_FORBIDDEN':
          return t('moto_deportiva.err_forbidden', { defaultValue: 'Solo los super administradores pueden hacer esto.' });
        default:
          return getErrorMessage(err);
      }
    },
    [t],
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [o, s] = await Promise.all([motoDeportivaService.overview(), motoDeportivaService.subscribers()]);
      setOverview(o);
      setSubscribers(s);
      setUnavailable(false);
    } catch (err) {
      // The migration may not be applied yet (function missing): say so, do not crash.
      if ((err as { code?: string } | null)?.code === 'MOTO_DEPORTIVA_FORBIDDEN') setLoadError(errorMessage(err));
      else setUnavailable(true);
    }
  }, [errorMessage]);

  const loadMetrics = useCallback(async (d: number) => {
    try {
      setMetrics(await motoDeportivaService.metrics(d));
    } catch {
      setMetrics(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadMetrics(days);
  }, [days, loadMetrics]);

  const active = overview?.active ?? false;

  const confirmToggle = async () => {
    setToggleOpen(false);
    setBusy(true);
    try {
      const { notified } = await motoDeportivaService.setActive(!active);
      if (!active && notified > 0) {
        showToast('success', t('moto_deportiva.notified_toast', { defaultValue: 'Se avisó a {{count}} personas', count: notified }));
      } else {
        showToast(
          'success',
          active
            ? t('moto_deportiva.deactivated_toast', { defaultValue: 'Moto Deportiva desactivada.' })
            : t('moto_deportiva.activated_toast', { defaultValue: 'Moto Deportiva activada.' }),
        );
      }
      await load();
    } catch (err) {
      showToast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addPilot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;
    setBusy(true);
    try {
      await motoDeportivaService.addPilot(phone.trim());
      showToast('success', t('moto_deportiva.pilot_added', { defaultValue: 'Piloto agregado.' }));
      setPhone('');
      await load();
    } catch (err) {
      showToast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemovePilot = async () => {
    const pilot = pilotToRemove;
    setPilotToRemove(null);
    if (!pilot) return;
    try {
      await motoDeportivaService.removePilot(pilot.driver_profile_id);
      showToast('success', t('moto_deportiva.pilot_removed', { defaultValue: 'Piloto quitado.' }));
      await load();
    } catch (err) {
      showToast('error', errorMessage(err));
    }
  };

  const confirmRemoveSub = async () => {
    const sub = subToRemove;
    setSubToRemove(null);
    if (!sub) return;
    try {
      await motoDeportivaService.removeSubscriber(sub.user_id);
      showToast('success', t('moto_deportiva.subscriber_removed', { defaultValue: 'Persona quitada del aviso.' }));
      await load();
    } catch (err) {
      showToast('error', errorMessage(err));
    }
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case 'available':
        return t('moto_deportiva.status_available', { defaultValue: 'Disponible' });
      case 'busy':
        return t('moto_deportiva.status_busy', { defaultValue: 'Ocupada' });
      case 'offline':
        return t('moto_deportiva.status_offline', { defaultValue: 'Activada · piloto desconectado' });
      default:
        return t('moto_deportiva.status_off', { defaultValue: 'Desactivada' });
    }
  };

  const shownSubscribers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return subscribers ?? [];
    return (subscribers ?? []).filter(
      (s) => (s.full_name ?? '').toLowerCase().includes(q) || (s.phone ?? '').toLowerCase().includes(q),
    );
  }, [subscribers, filter]);

  const removeBtnCls =
    'whitespace-nowrap rounded-full border border-red-500/40 px-3 py-1 text-[12px] text-red-700 hover:bg-red-500/10 dark:text-red-400';

  const pilotColumns: DataColumn<MotoDeportivaPilot>[] = [
    {
      id: 'name',
      header: t('moto_deportiva.col_name', { defaultValue: 'Nombre' }),
      primary: true,
      cell: (p) => <span className="font-medium text-ink">{p.full_name || '—'}</span>,
    },
    {
      id: 'online',
      header: t('moto_deportiva.col_online', { defaultValue: 'En línea' }),
      cell: (p) => (p.is_online ? t('moto_deportiva.yes', { defaultValue: 'Sí' }) : t('moto_deportiva.no', { defaultValue: 'No' })),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (p) => (
        <button type="button" onClick={() => setPilotToRemove(p)} className={removeBtnCls}>
          {t('moto_deportiva.remove', { defaultValue: 'Quitar' })}
        </button>
      ),
    },
  ];

  const subscriberColumns: DataColumn<MotoDeportivaSubscriber>[] = [
    {
      id: 'name',
      header: t('moto_deportiva.col_name', { defaultValue: 'Nombre' }),
      primary: true,
      cell: (s) => <span className="font-medium text-ink">{s.full_name || '—'}</span>,
    },
    { id: 'phone', header: t('moto_deportiva.col_phone', { defaultValue: 'Teléfono' }), secondary: true, cell: (s) => s.phone ?? '—' },
    { id: 'since', header: t('moto_deportiva.col_since', { defaultValue: 'Desde' }), hideBelow: 'md', cell: (s) => formatAdminDate(s.subscribed_at) },
    {
      id: 'notified',
      header: t('moto_deportiva.col_notified', { defaultValue: 'Último aviso' }),
      hideBelow: 'md',
      cell: (s) => (s.notified_at ? formatAdminDate(s.notified_at) : '—'),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        <button type="button" onClick={() => setSubToRemove(s)} className={removeBtnCls}>
          {t('moto_deportiva.remove_subscriber', { defaultValue: 'Quitar del aviso' })}
        </button>
      ),
    },
  ];

  const inputCls =
    'h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none';

  const tiles: { label: string; value: string; sub?: string; note?: string }[] = metrics
    ? [
        {
          label: t('moto_deportiva.m_subscribers', { defaultValue: 'Suscritos' }),
          value: String(metrics.subscribers_now),
          sub: t('moto_deportiva.m_subscribers_new', { defaultValue: '{{count}} nuevos en el período', count: metrics.subscribers_new }),
        },
        {
          label: t('moto_deportiva.m_notices', { defaultValue: 'Avisos enviados' }),
          value: String(metrics.notices_sent),
          sub: t('moto_deportiva.m_people_notified', { defaultValue: '{{count}} personas avisadas', count: metrics.people_notified }),
        },
        { label: t('moto_deportiva.m_requests', { defaultValue: 'Pedidos' }), value: String(metrics.requests) },
        { label: t('moto_deportiva.m_completed', { defaultValue: 'Viajes completados' }), value: String(metrics.completed) },
        { label: t('moto_deportiva.m_canceled', { defaultValue: 'Cancelados' }), value: String(metrics.canceled) },
        { label: t('moto_deportiva.m_switched', { defaultValue: 'Cambiados a moto normal' }), value: String(metrics.switched_to_moto) },
        { label: t('moto_deportiva.m_revenue', { defaultValue: 'Facturado' }), value: formatCUP(metrics.revenue_cup) },
        {
          label: t('moto_deportiva.m_first_ride', { defaultValue: 'Primer viaje en Moto Deportiva' }),
          value: String(metrics.first_ride_people),
          sub: t('moto_deportiva.m_first_ride_sub', { defaultValue: 'personas' }),
        },
        {
          label: t('moto_deportiva.m_pilot_hours', { defaultValue: 'Horas con el piloto en línea' }),
          value: String(Math.round(metrics.pilot_hours_online * 10) / 10),
          note: t('moto_deportiva.m_pilot_hours_note', { defaultValue: 'Se guardan los últimos 30 días.' }),
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('moto_deportiva.eyebrow', { defaultValue: 'Sistema · servicios' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('moto_deportiva.title', { defaultValue: 'Moto Deportiva' })}
        </h1>
      </div>

      {unavailable && (
        <div role="status" className="admin-card p-5 text-[13px] text-ink-muted">
          {t('moto_deportiva.unavailable', { defaultValue: 'Moto Deportiva no está disponible todavía en esta base de datos.' })}
        </div>
      )}
      {loadError && (
        <div role="alert" className="admin-card p-5 text-[13px] text-red-700 dark:text-red-400">
          {loadError}
        </div>
      )}

      {overview && (
        <section className="admin-card flex flex-col gap-3 p-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('moto_deportiva.state_title', { defaultValue: 'Estado' })}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => setToggleOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-[14px] font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Bike className="h-4 w-4" />
              {active ? t('moto_deportiva.deactivate', { defaultValue: 'Desactivar' }) : t('moto_deportiva.activate', { defaultValue: 'Activar' })}
            </button>
            <span className={`rounded-full px-3 py-1 text-[12.5px] font-medium ${STATUS_TONE[overview.status] ?? STATUS_TONE.off}`}>
              {statusLabel(overview.status)}
            </span>
            <span className="text-[12.5px] text-ink-muted">
              {t('moto_deportiva.last_notice', {
                defaultValue: 'Último aviso: {{when}}',
                when: overview.last_notice_at ? formatAdminDate(overview.last_notice_at) : '—',
              })}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-muted">
            {t('moto_deportiva.help', {
              defaultValue:
                'Activada: se puede pedir mientras el piloto está conectado. Desactivada: no aparece disponible aunque el piloto esté conectado.',
            })}
          </p>
        </section>
      )}

      {overview && (
        <section className="flex flex-col gap-2">
          <h2 className="font-display text-[18px] font-semibold text-ink">{t('moto_deportiva.pilots', { defaultValue: 'Pilotos' })}</h2>
          <DataTable
            columns={pilotColumns}
            rows={overview.pilots}
            keyField="driver_profile_id"
            empty={{ icon: Bike, title: t('moto_deportiva.no_pilots', { defaultValue: 'Todavía no hay pilotos.' }) }}
          />
          <form onSubmit={addPilot} className="flex flex-wrap items-center gap-2">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder={t('moto_deportiva.pilot_phone', { defaultValue: 'Teléfono del piloto' })}
              aria-label={t('moto_deportiva.pilot_phone', { defaultValue: 'Teléfono del piloto' })}
              className={`${inputCls} w-full sm:w-64`}
            />
            <button
              type="submit"
              disabled={busy || !phone.trim()}
              className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> {t('moto_deportiva.add', { defaultValue: 'Agregar' })}
            </button>
          </form>
        </section>
      )}

      {subscribers && (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-[18px] font-semibold text-ink">
              {t('moto_deportiva.subscribers', { defaultValue: 'Suscritos al aviso ({{count}})', count: subscribers.length })}
            </h2>
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-subtle" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('moto_deportiva.filter', { defaultValue: 'Buscar por nombre o teléfono' })}
                aria-label={t('moto_deportiva.filter', { defaultValue: 'Buscar por nombre o teléfono' })}
                className={`${inputCls} w-full pl-8 sm:w-64`}
              />
            </label>
          </div>
          <DataTable
            columns={subscriberColumns}
            rows={shownSubscribers}
            keyField="user_id"
            empty={{ icon: Bike, title: t('moto_deportiva.no_subscribers', { defaultValue: 'Nadie está en el aviso.' }) }}
          />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-[18px] font-semibold text-ink">{t('moto_deportiva.metrics', { defaultValue: 'Métricas' })}</h2>
          <div className="inline-flex gap-1" role="group" aria-label={t('moto_deportiva.period', { defaultValue: 'Período' })}>
            {PERIODS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                onClick={() => setDays(d)}
                className={`rounded-full border px-3 py-1 text-[12px] ${days === d ? 'border-ink bg-ink text-surface' : 'border-line text-ink hover:bg-surface-sunken'}`}
              >
                {t('moto_deportiva.days', { defaultValue: '{{count}} días', count: d })}
              </button>
            ))}
          </div>
        </div>
        {metrics ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map((tile) => (
              <div key={tile.label} className="admin-card flex flex-col gap-0.5 p-4">
                <p className="text-[12px] text-ink-muted">{tile.label}</p>
                <p className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink">{tile.value}</p>
                {tile.sub && <p className="text-[12px] text-ink-muted">{tile.sub}</p>}
                {tile.note && <p className="text-[11.5px] text-ink-subtle">{tile.note}</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-muted">
            {t('moto_deportiva.metrics_unavailable', { defaultValue: 'Las métricas no están disponibles todavía.' })}
          </p>
        )}
      </section>

      <AdminConfirmModal
        open={toggleOpen}
        title={
          active
            ? t('moto_deportiva.deactivate_title', { defaultValue: 'Desactivar Moto Deportiva' })
            : t('moto_deportiva.activate_title', { defaultValue: 'Activar Moto Deportiva' })
        }
        message={
          active
            ? t('moto_deportiva.deactivate_message', {
                defaultValue: 'Moto Deportiva dejará de aparecer disponible aunque el piloto esté conectado.',
              })
            : t('moto_deportiva.activate_message', {
                defaultValue:
                  'Se podrá pedir mientras el piloto esté conectado. Si hay un piloto en línea, se avisará a las personas suscritas.',
              })
        }
        confirmLabel={active ? t('moto_deportiva.deactivate', { defaultValue: 'Desactivar' }) : t('moto_deportiva.activate', { defaultValue: 'Activar' })}
        cancelLabel={t('moto_deportiva.cancel', { defaultValue: 'Cancelar' })}
        variant={active ? 'warning' : 'default'}
        onConfirm={confirmToggle}
        onCancel={closeToggle}
      />
      <AdminConfirmModal
        open={!!pilotToRemove}
        title={t('moto_deportiva.remove_pilot_title', { defaultValue: 'Quitar piloto' })}
        message={t('moto_deportiva.remove_pilot_message', {
          defaultValue: '{{name}} dejará de ser piloto de Moto Deportiva.',
          name: pilotToRemove?.full_name || '',
        })}
        confirmLabel={t('moto_deportiva.remove', { defaultValue: 'Quitar' })}
        cancelLabel={t('moto_deportiva.cancel', { defaultValue: 'Cancelar' })}
        variant="danger"
        onConfirm={confirmRemovePilot}
        onCancel={closePilot}
      />
      <AdminConfirmModal
        open={!!subToRemove}
        title={t('moto_deportiva.remove_subscriber_title', { defaultValue: 'Quitar del aviso' })}
        message={t('moto_deportiva.remove_subscriber_message', {
          defaultValue: '{{name}} dejará de recibir el aviso cuando Moto Deportiva esté disponible.',
          name: subToRemove?.full_name || subToRemove?.phone || '',
        })}
        confirmLabel={t('moto_deportiva.remove_subscriber', { defaultValue: 'Quitar del aviso' })}
        cancelLabel={t('moto_deportiva.cancel', { defaultValue: 'Cancelar' })}
        variant="danger"
        onConfirm={confirmRemoveSub}
        onCancel={closeSub}
      />
    </div>
  );
}
