'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, Download, RefreshCw } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { launchPulseService, type LaunchPulse, type LaunchPulseWeek } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { exportToCsv } from '@/lib/exportCsv';
import { formatAdminDate } from '@/lib/formatDate';

// The founder's Monday screen: what limited the service last week (requests
// nobody took, drivers online per hour) next to what fed it (signups,
// approvals, referrals). Data: admin_launch_pulse() from migration 00621.

const WEEK_OPTIONS = [4, 8, 12] as const;
type WeekOption = (typeof WEEK_OPTIONS)[number];

/**
 * PostgREST / Postgres codes for "this function or table does not exist":
 * migration 00621 is not in this database yet.
 */
const MISSING_BACKEND_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

interface LoadError {
  message: string;
  missingBackend: boolean;
  forbidden: boolean;
}

const num = (n: number) => n.toLocaleString('es-CU');
const dec = (n: number) => n.toLocaleString('es-CU', { maximumFractionDigits: 1 });

/** A percentage of a whole, null when the whole is 0. */
function share(part: number, whole: number): number | null {
  return whole > 0 ? (100 * part) / whole : null;
}

/** Requests where no driver accepted: nobody got the offer, or nobody took it. */
function noDriverPct(w: LaunchPulseWeek): number | null {
  return share(w.no_offer + w.offered_not_accepted, w.requests);
}

type OnlineKey = 'online_avg' | 'online_avg_day' | 'online_avg_night' | 'hours_nobody_pct';

/** Online metrics only mean something for weeks with snapshots (00621 onwards). */
function online(w: LaunchPulseWeek, key: OnlineKey): number | null {
  const v = w[key];
  return w.hours_measured > 0 && v !== null && v !== undefined ? Number(v) : null;
}

/** Relative change in %, null when there is nothing to compare against. */
function relativeDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** Difference between two percentages, in percentage points. */
function pointsDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

/** "28 sept" for a YYYY-MM-DD Havana date (the date itself, no time zone shift). */
function dayLabel(ymd: string, plusDays = 0): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

type CellFormat = 'int' | 'dec' | 'pct';

interface WeekColumn {
  id: string;
  label: string;
  title?: string;
  get: (w: LaunchPulseWeek) => number | null;
  format: CellFormat;
  /** First column of a group: draws the separator line. */
  groupStart?: boolean;
  strong?: boolean;
}

function formatCell(v: number | null, format: CellFormat): string {
  if (v === null) return '—';
  if (format === 'int') return num(v);
  if (format === 'dec') return dec(v);
  return `${dec(v)} %`;
}

// One palette for both themes, run through the dataviz validator against the
// light (#fff) and dark (#141720) card surfaces: passes lightness, chroma, CVD
// and normal-vision separation; red-700 sits at 2.8:1 on the dark card, so the
// legend, the per-segment tooltip and the weekly table carry the numbers too.
const FUNNEL_SEGMENTS = [
  { key: 'no_offer', swatch: 'bg-red-700' },
  { key: 'offered_not_accepted', swatch: 'bg-amber-600' },
  { key: 'accepted_canceled', swatch: 'bg-sky-600' },
  { key: 'completed', swatch: 'bg-emerald-600' },
  { key: 'open', swatch: 'bg-line-strong' },
] as const;

type FunnelKey = (typeof FUNNEL_SEGMENTS)[number]['key'];

function NowStat({ label, value, sub, action }: { label: string; value: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-surface-sunken/70 px-3.5 py-3">
      <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-muted">{label}</span>
      <span className="font-mono text-[20px] font-semibold leading-none text-ink" data-tabular>
        {value}
      </span>
      {sub && <span className="text-[11px] text-ink-muted">{sub}</span>}
      {action}
    </div>
  );
}

export default function LaunchPulsePage() {
  const { t } = useTranslation('admin');

  const [weeks, setWeeks] = useState<WeekOption>(8);
  const [pulse, setPulse] = useState<LaunchPulse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const request = useRef(0);

  const load = useCallback(async (n: WeekOption) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const data = await launchPulseService.getPulse(n);
      if (id === request.current) {
        setPulse(data);
        setError(null);
      }
    } catch (err) {
      if (id === request.current) {
        const code = (err as { code?: unknown } | null)?.code;
        setPulse(null);
        setError({
          message: getErrorMessage(err),
          missingBackend: typeof code === 'string' && MISSING_BACKEND_CODES.has(code),
          forbidden: code === '42501',
        });
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(weeks);
  }, [load, weeks]);

  const rows = useMemo(() => pulse?.weeks ?? [], [pulse]);
  const latestIndex = rows.findIndex((w) => !w.is_current);
  const latest = latestIndex >= 0 ? rows[latestIndex] : null;
  const previous = latestIndex >= 0 ? (rows[latestIndex + 1] ?? null) : null;
  const currentWeek = rows.find((w) => w.is_current) ?? null;

  const funnelLabels = useMemo<Record<FunnelKey, string>>(
    () => ({
      no_offer: t('launch_pulse.seg_no_offer', { defaultValue: 'Sin oferta' }),
      offered_not_accepted: t('launch_pulse.seg_not_accepted', { defaultValue: 'Ofertas sin aceptar' }),
      accepted_canceled: t('launch_pulse.seg_accepted_canceled', { defaultValue: 'Aceptado y cancelado' }),
      completed: t('launch_pulse.seg_completed', { defaultValue: 'Completados' }),
      open: t('launch_pulse.seg_open', { defaultValue: 'Sin cerrar' }),
    }),
    [t],
  );

  const columns = useMemo<WeekColumn[]>(
    () => [
      {
        id: 'requests',
        label: t('launch_pulse.col_requests', { defaultValue: 'Pedidos' }),
        title: t('launch_pulse.col_requests_title', { defaultValue: 'Viajes pedidos esa semana' }),
        get: (w) => w.requests,
        format: 'int',
        groupStart: true,
        strong: true,
      },
      {
        id: 'no_offer',
        label: t('launch_pulse.col_no_offer', { defaultValue: 'Sin oferta' }),
        title: t('launch_pulse.col_no_offer_title', {
          defaultValue: 'Cancelados sin que ningún conductor recibiera la oferta',
        }),
        get: (w) => w.no_offer,
        format: 'int',
      },
      {
        id: 'offered_not_accepted',
        label: t('launch_pulse.col_not_accepted', { defaultValue: 'Sin aceptar' }),
        title: t('launch_pulse.col_not_accepted_title', {
          defaultValue: 'Cancelados con ofertas enviadas que nadie aceptó',
        }),
        get: (w) => w.offered_not_accepted,
        format: 'int',
      },
      {
        id: 'accepted_canceled',
        label: t('launch_pulse.col_accepted_canceled', { defaultValue: 'Aceptado y cancelado' }),
        title: t('launch_pulse.col_accepted_canceled_title', {
          defaultValue: 'Un conductor lo aceptó y después se canceló',
        }),
        get: (w) => w.accepted_canceled,
        format: 'int',
      },
      {
        id: 'completed',
        label: t('launch_pulse.col_completed', { defaultValue: 'Completados' }),
        get: (w) => w.completed,
        format: 'int',
        strong: true,
      },
      {
        id: 'no_driver_pct',
        label: t('launch_pulse.col_no_driver_pct', { defaultValue: '% sin conductor' }),
        title: t('launch_pulse.col_no_driver_pct_title', {
          defaultValue: 'Sin oferta más sin aceptar, sobre el total de pedidos',
        }),
        get: noDriverPct,
        format: 'pct',
      },
      {
        id: 'online_avg',
        label: t('launch_pulse.col_online_avg', { defaultValue: 'Promedio' }),
        title: t('launch_pulse.col_online_avg_title', {
          defaultValue: 'Conductores en línea por hora, en promedio',
        }),
        get: (w) => online(w, 'online_avg'),
        format: 'dec',
        groupStart: true,
        strong: true,
      },
      {
        id: 'online_avg_day',
        label: t('launch_pulse.col_online_day', { defaultValue: 'Día' }),
        title: t('launch_pulse.col_online_day_title', { defaultValue: 'De 7:00 a 20:59, hora de La Habana' }),
        get: (w) => online(w, 'online_avg_day'),
        format: 'dec',
      },
      {
        id: 'online_avg_night',
        label: t('launch_pulse.col_online_night', { defaultValue: 'Noche' }),
        title: t('launch_pulse.col_online_night_title', { defaultValue: 'De 21:00 a 6:59, hora de La Habana' }),
        get: (w) => online(w, 'online_avg_night'),
        format: 'dec',
      },
      {
        id: 'hours_nobody_pct',
        label: t('launch_pulse.col_hours_nobody', { defaultValue: '% horas sin nadie' }),
        title: t('launch_pulse.col_hours_nobody_title', {
          defaultValue: 'Horas medidas sin ningún conductor en línea',
        }),
        get: (w) => online(w, 'hours_nobody_pct'),
        format: 'pct',
      },
      {
        id: 'drivers_seen_online',
        label: t('launch_pulse.col_drivers_seen', { defaultValue: 'Choferes distintos' }),
        title: t('launch_pulse.col_drivers_seen_title', {
          defaultValue: 'Conductores que estuvieron en línea al menos una hora',
        }),
        get: (w) => (w.hours_measured > 0 ? w.drivers_seen_online : null),
        format: 'int',
      },
      {
        id: 'rider_signups',
        label: t('launch_pulse.col_rider_signups', { defaultValue: 'Registros pasajeros' }),
        get: (w) => w.rider_signups,
        format: 'int',
        groupStart: true,
        strong: true,
      },
      {
        id: 'driver_signups',
        label: t('launch_pulse.col_driver_signups', { defaultValue: 'Registros choferes' }),
        get: (w) => w.driver_signups,
        format: 'int',
        strong: true,
      },
      {
        id: 'drivers_approved',
        label: t('launch_pulse.col_drivers_approved', { defaultValue: 'Aprobados' }),
        title: t('launch_pulse.col_drivers_approved_title', { defaultValue: 'Conductores aprobados esa semana' }),
        get: (w) => w.drivers_approved,
        format: 'int',
      },
      {
        id: 'coded_signups',
        label: t('launch_pulse.col_coded', { defaultValue: 'Con código' }),
        title: t('launch_pulse.col_coded_title', {
          defaultValue: 'Registros de la semana (pasajeros y choferes) que pusieron un código de invitación',
        }),
        get: (w) => w.coded_signups,
        format: 'int',
      },
      {
        id: 'signups_with_push',
        label: t('launch_pulse.col_with_push', { defaultValue: 'Con push' }),
        title: t('launch_pulse.col_with_push_title', {
          defaultValue: 'Registros de la semana que hoy pueden recibir notificaciones',
        }),
        get: (w) => w.signups_with_push,
        format: 'int',
      },
      {
        id: 'marketing_opt_ins',
        label: t('launch_pulse.col_opt_ins', { defaultValue: 'Aceptan novedades' }),
        title: t('launch_pulse.col_opt_ins_title', {
          defaultValue: 'Personas que aceptaron recibir novedades esa semana',
        }),
        get: (w) => w.marketing_opt_ins,
        format: 'int',
      },
      {
        id: 'referrals_created',
        label: t('launch_pulse.col_referrals_created', { defaultValue: 'Referidos creados' }),
        get: (w) => w.referrals_created,
        format: 'int',
      },
      {
        id: 'referrals_rewarded',
        label: t('launch_pulse.col_referrals_rewarded', { defaultValue: 'Referidos pagados' }),
        get: (w) => w.referrals_rewarded,
        format: 'int',
      },
    ],
    [t],
  );

  const groups = useMemo(
    () => [
      { id: 'funnel', label: t('launch_pulse.group_funnel', { defaultValue: 'Pedidos de viaje' }), span: 6 },
      { id: 'online', label: t('launch_pulse.group_online', { defaultValue: 'Conductores en línea por hora' }), span: 5 },
      { id: 'growth', label: t('launch_pulse.group_growth', { defaultValue: 'Crecimiento' }), span: 8 },
    ],
    [t],
  );

  const handleExport = useCallback(() => {
    const yes = t('launch_pulse.yes', { defaultValue: 'Sí' });
    const no = t('launch_pulse.no', { defaultValue: 'No' });
    const csvRows = rows.map((w) => ({
      ...w,
      is_current: w.is_current ? yes : no,
      no_driver_pct: noDriverPct(w)?.toFixed(1) ?? '',
      online_avg: online(w, 'online_avg') ?? '',
      online_avg_day: online(w, 'online_avg_day') ?? '',
      online_avg_night: online(w, 'online_avg_night') ?? '',
      hours_nobody_pct: online(w, 'hours_nobody_pct') ?? '',
      drivers_seen_online: w.hours_measured > 0 ? w.drivers_seen_online : '',
    }));
    exportToCsv(
      csvRows as unknown as Record<string, unknown>[],
      [
        { key: 'week_start', label: t('launch_pulse.csv_week_start', { defaultValue: 'Semana (lunes)' }) },
        { key: 'is_current', label: t('launch_pulse.csv_is_current', { defaultValue: 'En curso' }) },
        { key: 'requests', label: t('launch_pulse.col_requests', { defaultValue: 'Pedidos' }) },
        {
          key: 'riders_requesting',
          label: t('launch_pulse.csv_riders_requesting', { defaultValue: 'Pasajeros que pidieron' }),
        },
        { key: 'no_offer', label: t('launch_pulse.seg_no_offer', { defaultValue: 'Sin oferta' }) },
        { key: 'offered_not_accepted', label: t('launch_pulse.seg_not_accepted', { defaultValue: 'Ofertas sin aceptar' }) },
        {
          key: 'accepted_canceled',
          label: t('launch_pulse.seg_accepted_canceled', { defaultValue: 'Aceptado y cancelado' }),
        },
        { key: 'completed', label: t('launch_pulse.seg_completed', { defaultValue: 'Completados' }) },
        {
          key: 'riders_completed',
          label: t('launch_pulse.csv_riders_completed', { defaultValue: 'Pasajeros con viaje completado' }),
        },
        { key: 'open', label: t('launch_pulse.seg_open', { defaultValue: 'Sin cerrar' }) },
        { key: 'no_driver_pct', label: t('launch_pulse.col_no_driver_pct', { defaultValue: '% sin conductor' }) },
        { key: 'hours_measured', label: t('launch_pulse.csv_hours_measured', { defaultValue: 'Horas medidas' }) },
        {
          key: 'online_avg',
          label: t('launch_pulse.csv_online_avg', { defaultValue: 'Conductores en línea por hora (promedio)' }),
        },
        { key: 'online_avg_day', label: t('launch_pulse.csv_online_day', { defaultValue: 'En línea de día (7-21 h)' }) },
        { key: 'online_avg_night', label: t('launch_pulse.csv_online_night', { defaultValue: 'En línea de noche' }) },
        { key: 'hours_nobody_pct', label: t('launch_pulse.col_hours_nobody', { defaultValue: '% horas sin nadie' }) },
        {
          key: 'drivers_seen_online',
          label: t('launch_pulse.csv_drivers_seen', { defaultValue: 'Choferes distintos en línea' }),
        },
        { key: 'signups', label: t('launch_pulse.csv_signups', { defaultValue: 'Registros (total)' }) },
        { key: 'rider_signups', label: t('launch_pulse.col_rider_signups', { defaultValue: 'Registros pasajeros' }) },
        { key: 'driver_signups', label: t('launch_pulse.col_driver_signups', { defaultValue: 'Registros choferes' }) },
        { key: 'drivers_approved', label: t('launch_pulse.col_drivers_approved', { defaultValue: 'Aprobados' }) },
        { key: 'coded_signups', label: t('launch_pulse.col_coded', { defaultValue: 'Con código' }) },
        { key: 'signups_with_push', label: t('launch_pulse.col_with_push', { defaultValue: 'Con push' }) },
        { key: 'marketing_opt_ins', label: t('launch_pulse.col_opt_ins', { defaultValue: 'Aceptan novedades' }) },
        {
          key: 'referrals_created',
          label: t('launch_pulse.col_referrals_created', { defaultValue: 'Referidos creados' }),
        },
        {
          key: 'referrals_rewarded',
          label: t('launch_pulse.col_referrals_rewarded', { defaultValue: 'Referidos pagados' }),
        },
      ],
      'pulso-lanzamiento',
    );
  }, [rows, t]);

  const maxRequests = useMemo(() => rows.reduce((m, w) => Math.max(m, w.requests), 0), [rows]);
  const kpiLoading = loading && !pulse;
  const now = pulse?.now ?? null;

  // ── KPI values for the latest complete week ────────────────────────────
  const kpi = useMemo(() => {
    if (!latest) return null;
    const noDriver = noDriverPct(latest);
    const avg = online(latest, 'online_avg');
    const nobody = online(latest, 'hours_nobody_pct');
    return {
      noDriver,
      avg,
      nobody,
      deltas: {
        requests: relativeDelta(latest.requests, previous?.requests ?? null),
        noDriver: pointsDelta(noDriver, previous ? noDriverPct(previous) : null),
        completed: relativeDelta(latest.completed, previous?.completed ?? null),
        avg: relativeDelta(avg, previous ? online(previous, 'online_avg') : null),
        nobody: pointsDelta(nobody, previous ? online(previous, 'hours_nobody_pct') : null),
        riderSignups: relativeDelta(latest.rider_signups, previous?.rider_signups ?? null),
        driverSignups: relativeDelta(latest.driver_signups, previous?.driver_signups ?? null),
        approved: relativeDelta(latest.drivers_approved, previous?.drivers_approved ?? null),
      },
    };
  }, [latest, previous]);

  const dash = '—';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('launch_pulse.page_eyebrow', { defaultValue: 'Lanzamiento · cada lunes' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('launch_pulse.title', { defaultValue: 'Pulso del lanzamiento' })}
          </h1>
          <p className="mt-0.5 max-w-[80ch] text-[12.5px] text-ink-muted">
            {t('launch_pulse.description', {
              defaultValue:
                'Qué limita el servicio semana a semana: pedidos que nadie tomó, conductores en línea y registros nuevos. Semanas de lunes a domingo, hora de La Habana; sin cuentas de prueba.',
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('launch_pulse.weeks_aria', { defaultValue: 'Cantidad de semanas' })}
            className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5"
          >
            {WEEK_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={weeks === n}
                onClick={() => setWeeks(n)}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  weeks === n ? 'bg-ink text-surface' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                }`}
              >
                {t('launch_pulse.weeks_option', { n, defaultValue: '{{n}} semanas' })}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={rows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t('launch_pulse.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        </div>
      </div>

      {error ? (
        <section role="alert" className="admin-card flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div className="max-w-[60ch]">
            <p className="font-display text-[15px] font-semibold text-ink">
              {t('launch_pulse.error_title', { defaultValue: 'No pudimos cargar el pulso del lanzamiento' })}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-muted">
              {error.missingBackend
                ? t('launch_pulse.error_missing', {
                    defaultValue:
                      'La base de datos todavía no tiene esta función. Hay que aplicar la migración 00621 para ver esta página.',
                  })
                : error.forbidden
                  ? t('launch_pulse.error_forbidden', {
                      defaultValue: 'Solo un administrador puede ver estos datos. Vuelve a iniciar sesión.',
                    })
                  : t('launch_pulse.error_generic', { defaultValue: 'Reintenta en un momento.' })}
            </p>
            <p className="mt-1 break-words font-mono text-[11px] text-ink-subtle">{error.message}</p>
          </div>
          <button
            type="button"
            onClick={() => void load(weeks)}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('launch_pulse.retry', { defaultValue: 'Reintentar' })}
          </button>
        </section>
      ) : (
        <div className={`flex flex-col gap-5 transition-opacity ${loading && pulse ? 'opacity-60' : ''}`} aria-busy={loading}>
          {/* ── Latest complete week ─────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                {latest
                  ? t('launch_pulse.kpi_week_title', {
                      from: dayLabel(latest.week_start),
                      to: dayLabel(latest.week_start, 6),
                      defaultValue: 'Semana del {{from}} al {{to}}',
                    })
                  : t('launch_pulse.kpi_week_title_loading', { defaultValue: 'Última semana completa' })}
              </h2>
              <p className="text-[12px] text-ink-muted">
                {previous
                  ? t('launch_pulse.kpi_compared_with', {
                      date: dayLabel(previous.week_start),
                      defaultValue: 'Las flechas comparan con la semana del {{date}}.',
                    })
                  : null}{' '}
                {currentWeek
                  ? t('launch_pulse.kpi_current_partial', {
                      date: dayLabel(currentWeek.week_start),
                      defaultValue: 'La semana en curso (desde el {{date}}) está incompleta: solo aparece en la tabla.',
                    })
                  : null}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard
                label={t('launch_pulse.kpi_requests', { defaultValue: 'Pedidos' })}
                value={latest ? num(latest.requests) : dash}
                delta={kpi?.deltas.requests ?? null}
                hint={
                  latest
                    ? t('launch_pulse.kpi_requests_hint', {
                        n: num(latest.riders_requesting),
                        defaultValue: '{{n}} pasajeros distintos',
                      })
                    : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_no_driver', { defaultValue: 'Sin conductor' })}
                value={kpi?.noDriver != null ? dec(kpi.noDriver) : dash}
                unit={kpi?.noDriver != null ? '%' : undefined}
                delta={kpi?.deltas.noDriver ?? null}
                deltaUnit="points"
                deltaInverse
                tone="warning"
                hint={
                  latest
                    ? t('launch_pulse.kpi_no_driver_hint', {
                        no_offer: num(latest.no_offer),
                        not_accepted: num(latest.offered_not_accepted),
                        defaultValue: '{{no_offer}} sin oferta · {{not_accepted}} sin aceptar',
                      })
                    : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_completed', { defaultValue: 'Viajes completados' })}
                value={latest ? num(latest.completed) : dash}
                delta={kpi?.deltas.completed ?? null}
                tone="success"
                hint={
                  latest
                    ? t('launch_pulse.kpi_completed_hint', {
                        n: num(latest.riders_completed),
                        defaultValue: '{{n}} pasajeros distintos',
                      })
                    : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_online_avg', { defaultValue: 'En línea por hora' })}
                value={kpi?.avg != null ? dec(kpi.avg) : dash}
                delta={kpi?.deltas.avg ?? null}
                hint={
                  latest && kpi?.avg != null
                    ? t('launch_pulse.kpi_online_avg_hint', {
                        day: dec(online(latest, 'online_avg_day') ?? 0),
                        night: dec(online(latest, 'online_avg_night') ?? 0),
                        defaultValue: 'Conductores en promedio · día {{day}} · noche {{night}}',
                      })
                    : latest
                      ? t('launch_pulse.kpi_not_measured', { defaultValue: 'Sin medición esa semana' })
                      : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_hours_nobody', { defaultValue: 'Horas sin nadie' })}
                value={kpi?.nobody != null ? dec(kpi.nobody) : dash}
                unit={kpi?.nobody != null ? '%' : undefined}
                delta={kpi?.deltas.nobody ?? null}
                deltaUnit="points"
                deltaInverse
                tone="warning"
                hint={
                  latest && kpi?.nobody != null
                    ? t('launch_pulse.kpi_hours_nobody_hint', {
                        hours: num(latest.hours_measured),
                        defaultValue: 'Sin ningún conductor en línea · {{hours}} h medidas',
                      })
                    : latest
                      ? t('launch_pulse.kpi_not_measured', { defaultValue: 'Sin medición esa semana' })
                      : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_rider_signups', { defaultValue: 'Pasajeros nuevos' })}
                value={latest ? num(latest.rider_signups) : dash}
                delta={kpi?.deltas.riderSignups ?? null}
                tone="info"
                hint={
                  latest
                    ? t('launch_pulse.kpi_rider_signups_hint', {
                        n: num(latest.signups),
                        defaultValue: '{{n}} registros en total',
                      })
                    : undefined
                }
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_driver_signups', { defaultValue: 'Choferes nuevos' })}
                value={latest ? num(latest.driver_signups) : dash}
                delta={kpi?.deltas.driverSignups ?? null}
                tone="primary"
                loading={kpiLoading}
              />
              <KpiCard
                label={t('launch_pulse.kpi_drivers_approved', { defaultValue: 'Choferes aprobados' })}
                value={latest ? num(latest.drivers_approved) : dash}
                delta={kpi?.deltas.approved ?? null}
                tone="success"
                loading={kpiLoading}
              />
            </div>
          </section>

          {/* ── Right now ─────────────────────────────────────────────── */}
          <section className="admin-card p-5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                {t('launch_pulse.now_title', { defaultValue: 'Ahora' })}
              </h2>
              {pulse && (
                <span className="font-mono text-[10.5px] text-ink-subtle">
                  {t('launch_pulse.now_updated', {
                    date: formatAdminDate(pulse.generated_at),
                    defaultValue: 'Actualizado {{date}}',
                  })}
                </span>
              )}
            </div>
            {kpiLoading || !now ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
                {Array.from({ length: 8 }).map((_, i) => (
                  <span key={i} className="h-[74px] animate-pulse rounded-xl bg-surface-sunken" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
                <NowStat label={t('launch_pulse.now_users', { defaultValue: 'Usuarios' })} value={num(now.users)} />
                <NowStat
                  label={t('launch_pulse.now_users_push', { defaultValue: 'Con push' })}
                  value={num(now.users_with_push)}
                  sub={
                    now.users > 0
                      ? t('launch_pulse.now_pct_of_users', {
                          pct: dec(share(now.users_with_push, now.users) ?? 0),
                          defaultValue: '{{pct}} % de los usuarios',
                        })
                      : undefined
                  }
                />
                <NowStat
                  label={t('launch_pulse.now_opted_in', { defaultValue: 'Aceptan novedades' })}
                  value={num(now.users_opted_in)}
                  sub={
                    now.users > 0
                      ? t('launch_pulse.now_pct_of_users', {
                          pct: dec(share(now.users_opted_in, now.users) ?? 0),
                          defaultValue: '{{pct}} % de los usuarios',
                        })
                      : undefined
                  }
                />
                <NowStat
                  label={t('launch_pulse.now_drivers_approved', { defaultValue: 'Choferes aprobados' })}
                  value={num(now.drivers_approved)}
                />
                <NowStat
                  label={t('launch_pulse.now_drivers_push', { defaultValue: 'Aprobados con push' })}
                  value={num(now.drivers_approved_with_push)}
                  sub={
                    now.drivers_approved > 0
                      ? t('launch_pulse.now_pct_of_approved', {
                          pct: dec(share(now.drivers_approved_with_push, now.drivers_approved) ?? 0),
                          defaultValue: '{{pct}} % de los aprobados',
                        })
                      : undefined
                  }
                />
                <NowStat
                  label={t('launch_pulse.now_drivers_pending', { defaultValue: 'Sin terminar el registro' })}
                  value={num(now.drivers_pending)}
                  action={
                    <Link
                      href="/incomplete-drivers"
                      className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary-700 hover:underline dark:text-primary-400"
                    >
                      {t('launch_pulse.now_drivers_pending_link', { defaultValue: 'Ver la lista' })}
                      <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  }
                />
                <NowStat
                  label={t('launch_pulse.now_drivers_review', { defaultValue: 'En revisión' })}
                  value={num(now.drivers_under_review)}
                />
                <NowStat
                  label={t('launch_pulse.now_drivers_online', { defaultValue: 'En línea ahora' })}
                  value={num(now.drivers_online_now)}
                />
              </div>
            )}
          </section>

          {/* ── What happened to each request ─────────────────────────── */}
          {rows.length > 0 && (
            <section className="admin-card p-5">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                {t('launch_pulse.funnel_title', { defaultValue: 'Qué pasó con cada pedido' })}
              </h2>
              <p className="mt-1 text-[12px] text-ink-muted">
                {t('launch_pulse.funnel_description', {
                  defaultValue:
                    'Cada barra es una semana; su largo, la cantidad de pedidos. A la izquierda, los que se quedaron sin conductor.',
                })}
              </p>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label={t('launch_pulse.legend_aria', { defaultValue: 'Leyenda' })}>
                {FUNNEL_SEGMENTS.map((s) => (
                  <li key={s.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                    <span className={`h-2.5 w-2.5 rounded-sm ${s.swatch}`} aria-hidden="true" />
                    {funnelLabels[s.key]}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-col gap-2">
                {rows.map((w) => {
                  const parts = FUNNEL_SEGMENTS.map((s) => ({ ...s, count: w[s.key] })).filter((p) => p.count > 0);
                  const summary = parts
                    .map((p) => `${funnelLabels[p.key]}: ${num(p.count)} (${dec(share(p.count, w.requests) ?? 0)} %)`)
                    .join(' · ');
                  return (
                    <div key={w.week_start} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-3">
                      <span className="text-[11.5px] text-ink-muted">
                        {dayLabel(w.week_start)}
                        {w.is_current && (
                          <span className="block text-[10px] text-ink-subtle">
                            {t('launch_pulse.current_week', { defaultValue: 'en curso' })}
                          </span>
                        )}
                      </span>
                      <div className="h-4">
                        {w.requests > 0 ? (
                          <div
                            role="img"
                            aria-label={`${dayLabel(w.week_start)}: ${summary}`}
                            className="flex h-full gap-[2px]"
                            style={{ width: `${Math.max((w.requests / Math.max(maxRequests, 1)) * 100, 2)}%` }}
                          >
                            {parts.map((p, i) => (
                              <span
                                key={p.key}
                                title={`${funnelLabels[p.key]}: ${num(p.count)} (${dec(share(p.count, w.requests) ?? 0)} %)`}
                                className={`h-full min-w-[3px] basis-0 ${p.swatch} ${i === parts.length - 1 ? 'rounded-r-[4px]' : ''}`}
                                style={{ flexGrow: p.count }}
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-ink-subtle">
                            {t('launch_pulse.funnel_no_requests', { defaultValue: 'Sin pedidos' })}
                          </span>
                        )}
                      </div>
                      <span className="text-right font-mono text-[11.5px] text-ink" data-tabular>
                        {num(w.requests)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Week by week ──────────────────────────────────────────── */}
          <section className="admin-card overflow-hidden">
            <div className="px-5 pb-3 pt-5">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
                {t('launch_pulse.table_title', { defaultValue: 'Semana a semana' })}
              </h2>
              <p className="mt-1 text-[12px] text-ink-muted">
                {t('launch_pulse.table_description', {
                  defaultValue: 'La más reciente primero. Desliza a los lados para ver todas las columnas.',
                })}
              </p>
            </div>
            {kpiLoading ? (
              <div className="flex flex-col gap-2 px-5 pb-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <span key={i} className="h-8 animate-pulse rounded-lg bg-surface-sunken" />
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-max border-separate border-spacing-0 text-[12.5px]">
                  <thead>
                    <tr>
                      <th
                        rowSpan={2}
                        scope="col"
                        className="sticky left-0 z-[1] border-b border-r border-line bg-surface-elevated px-4 py-2 text-left align-bottom font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle"
                      >
                        {t('launch_pulse.col_week', { defaultValue: 'Semana' })}
                      </th>
                      {groups.map((g) => (
                        <th
                          key={g.id}
                          colSpan={g.span}
                          scope="colgroup"
                          className="border-b border-l border-line px-3 pb-1 pt-2 text-left text-[11px] font-semibold text-ink-muted"
                        >
                          {g.label}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c.id}
                          scope="col"
                          title={c.title}
                          className={`whitespace-nowrap border-b border-line px-3 py-2 text-right font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-subtle ${
                            c.groupStart ? 'border-l' : ''
                          } ${c.title ? 'cursor-help' : ''}`}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w, i) => {
                      const last = i === rows.length - 1;
                      const rowBg = w.is_current ? 'bg-surface-sunken' : 'bg-surface-elevated';
                      return (
                        <tr key={w.week_start}>
                          <th
                            scope="row"
                            className={`sticky left-0 z-[1] whitespace-nowrap border-r border-line px-4 py-2.5 text-left font-normal ${rowBg} ${
                              last ? '' : 'border-b'
                            }`}
                          >
                            <span className="block text-[12.5px] font-medium text-ink">{dayLabel(w.week_start)}</span>
                            <span className="block text-[10.5px] text-ink-muted">
                              {w.is_current
                                ? t('launch_pulse.current_week', { defaultValue: 'en curso' })
                                : t('launch_pulse.week_until', {
                                    date: dayLabel(w.week_start, 6),
                                    defaultValue: 'al {{date}}',
                                  })}
                            </span>
                          </th>
                          {columns.map((c) => {
                            const v = c.get(w);
                            const muted = v === null || v === 0;
                            const onlineCol = c.id.startsWith('online') || c.id === 'hours_nobody_pct' || c.id === 'drivers_seen_online';
                            return (
                              <td
                                key={c.id}
                                title={
                                  onlineCol
                                    ? w.hours_measured > 0
                                      ? t('launch_pulse.hours_measured_title', {
                                          hours: num(w.hours_measured),
                                          defaultValue: '{{hours}} h medidas',
                                        })
                                      : t('launch_pulse.not_measured_title', { defaultValue: 'Sin medición esa semana' })
                                    : undefined
                                }
                                className={`whitespace-nowrap px-3 py-2.5 text-right font-mono ${w.is_current ? 'bg-surface-sunken/60' : ''} ${
                                  c.groupStart ? 'border-l border-line' : ''
                                } ${last ? '' : 'border-b border-line'} ${
                                  muted ? 'text-ink-subtle' : c.strong ? 'font-semibold text-ink' : 'text-ink'
                                }`}
                                data-tabular
                              >
                                {formatCell(v, c.format)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t border-line px-5 py-3 text-[11.5px] text-ink-muted">
              {pulse?.online_since
                ? t('launch_pulse.online_since', {
                    date: formatAdminDate(pulse.online_since),
                    defaultValue:
                      'Conductores en línea medidos desde {{date}} (hora de La Habana). Antes de esa fecha esas columnas quedan en «—».',
                  })
                : t('launch_pulse.online_never', {
                    defaultValue:
                      'Todavía no hay mediciones de conductores en línea: se guardan una vez por hora desde que se aplicó la migración 00621.',
                  })}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
