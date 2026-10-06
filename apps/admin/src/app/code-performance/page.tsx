'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Ticket, Gift, Megaphone, AlertTriangle, Download, Plus } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  acquisitionCodeService,
  marketingStatsService,
  normalizeAcquisitionCode,
  ACQUISITION_CODE_PATTERN,
  type AcquisitionAudience,
  type AcquisitionChannel,
  type AcquisitionCodeStats,
  type PromoCodePerformance,
  type ReferralCodePerformance,
} from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { useToast } from '@/components/ui/AdminToast';
import { exportToCsv } from '@/lib/exportCsv';
import { formatAdminDate } from '@/lib/formatDate';

type Tab = 'promos' | 'referral' | 'acquisition';

const num = (n: number) => n.toLocaleString('es-CU');
const cupUnit = (n: number) => formatCUP(n).replace('CUP', '').trim();

const CHANNELS: AcquisitionChannel[] = ['influencer', 'ugc', 'bolsas', 'pantallas', 'grupos', 'medios', 'otro'];
const AUDIENCES: AcquisitionAudience[] = ['pasajeros', 'choferes', 'ambos'];

/** Stats row plus the first-ride total, so that column can sort like the others. */
type AcquisitionRow = AcquisitionCodeStats & { first_rides: number };

/**
 * PostgREST / Postgres codes for "this function or table does not exist":
 * the acquisition-code backend (00619) is not in this database yet.
 */
const MISSING_BACKEND_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

interface AcquisitionLoadError {
  message: string;
  missingBackend: boolean;
}

interface AcquisitionForm {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  notes: string;
}

const EMPTY_FORM: AcquisitionForm = { code: '', label: '', channel: 'influencer', audience: 'ambos', notes: '' };

const inputCls =
  'h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none';

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{label}</span>
      {children}
    </label>
  );
}

/** Numeric-aware client sort (same shape as promotions/referrals pages). */
function sortRows<T>(rows: T[], sort: SortState | null): T[] {
  if (!sort) return rows;
  const dir = sort.direction === 'asc' ? 1 : -1;
  const key = sort.columnId as keyof T;
  return [...rows].sort((a, b) => {
    const av = a[key] as unknown;
    const bv = b[key] as unknown;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

function StatusPill({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return active ? (
    <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
      {activeLabel}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {inactiveLabel}
    </span>
  );
}

function ActiveSwitch({
  active,
  busy,
  onLabel,
  offLabel,
  ariaLabel,
  onToggle,
}: {
  active: boolean;
  busy: boolean;
  onLabel: string;
  offLabel: string;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={ariaLabel}
      disabled={busy}
      onClick={onToggle}
      className="inline-flex items-center gap-2 text-[11px] font-medium disabled:cursor-wait disabled:opacity-60"
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          active ? 'bg-emerald-500' : 'bg-line-strong'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform dark:bg-neutral-100 ${
            active ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </span>
      <span className={active ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-muted'}>
        {active ? onLabel : offLabel}
      </span>
    </button>
  );
}

export default function CodePerformancePage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [tab, setTab] = useState<Tab>('promos');
  const [promos, setPromos] = useState<PromoCodePerformance[]>([]);
  const [referrers, setReferrers] = useState<ReferralCodePerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoSort, setPromoSort] = useState<SortState | null>({ columnId: 'completed', direction: 'desc' });
  const [refSort, setRefSort] = useState<SortState | null>({ columnId: 'invited', direction: 'desc' });

  const [codes, setCodes] = useState<AcquisitionCodeStats[]>([]);
  const [codesLoading, setCodesLoading] = useState(true);
  const [codesError, setCodesError] = useState<AcquisitionLoadError | null>(null);
  const [codeSort, setCodeSort] = useState<SortState | null>({ columnId: 'signups', direction: 'desc' });
  const [togglingCodes, setTogglingCodes] = useState<ReadonlySet<string>>(() => new Set());
  const [form, setForm] = useState<AcquisitionForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const codesRequest = useRef(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([
        marketingStatsService.getPromoCodePerformance(),
        marketingStatsService.getReferralCodePerformance(),
      ]);
      setPromos(p);
      setReferrers(r);
    } catch (err) {
      setPromos([]);
      setReferrers([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  /**
   * Loaded apart from fetchData on purpose: the stats RPC is the newest piece
   * (00619), and if it fails (not applied yet, no admin session) the promo and
   * referral tabs must keep working. Returns the fresh rows, or null on error,
   * so callers can confirm a write actually landed.
   */
  const loadCodes = useCallback(async (silent = false): Promise<AcquisitionCodeStats[] | null> => {
    const request = ++codesRequest.current;
    if (!silent) setCodesLoading(true);
    try {
      const rows = await acquisitionCodeService.getStats();
      if (request === codesRequest.current) {
        setCodes(rows);
        setCodesError(null);
      }
      return rows;
    } catch (err) {
      if (request === codesRequest.current) {
        const code = (err as { code?: unknown } | null)?.code;
        setCodes([]);
        setCodesError({
          message: getErrorMessage(err),
          missingBackend: typeof code === 'string' && MISSING_BACKEND_CODES.has(code),
        });
      }
      return null;
    } finally {
      if (request === codesRequest.current) setCodesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCodes();
  }, [loadCodes]);

  const promoTotals = useMemo(
    () => ({
      active: promos.filter((p) => p.is_active).length,
      redemptions: promos.reduce((s, p) => s + p.redemptions, 0),
      completed: promos.reduce((s, p) => s + p.completed, 0),
      discount: promos.reduce((s, p) => s + p.discount_given_cup, 0),
    }),
    [promos],
  );

  const refTotals = useMemo(
    () => ({
      influencers: referrers.length,
      invited: referrers.reduce((s, r) => s + r.invited, 0),
      rewarded: referrers.reduce((s, r) => s + r.rewarded, 0),
      paid: referrers.reduce((s, r) => s + r.bonus_paid_cup, 0),
    }),
    [referrers],
  );

  const sortedPromos = useMemo(() => sortRows(promos, promoSort), [promos, promoSort]);
  const sortedReferrers = useMemo(() => sortRows(referrers, refSort), [referrers, refSort]);

  const codeRows = useMemo<AcquisitionRow[]>(
    () => codes.map((c) => ({ ...c, first_rides: c.riders_with_ride + c.drivers_with_ride })),
    [codes],
  );
  const sortedCodes = useMemo(() => sortRows(codeRows, codeSort), [codeRows, codeSort]);

  const codeTotals = useMemo(
    () => ({
      signups: codeRows.reduce((s, c) => s + c.signups, 0),
      riders: codeRows.reduce((s, c) => s + c.rider_signups, 0),
      drivers: codeRows.reduce((s, c) => s + c.driver_signups, 0),
      approved: codeRows.reduce((s, c) => s + c.drivers_approved, 0),
      ridersWithRide: codeRows.reduce((s, c) => s + c.riders_with_ride, 0),
      driversWithRide: codeRows.reduce((s, c) => s + c.drivers_with_ride, 0),
      firstRides: codeRows.reduce((s, c) => s + c.first_rides, 0),
    }),
    [codeRows],
  );

  const channelLabels = useMemo<Record<AcquisitionChannel, string>>(
    () => ({
      influencer: t('code_performance.channel_influencer', { defaultValue: 'Influencer' }),
      ugc: t('code_performance.channel_ugc', { defaultValue: 'UGC (creadores)' }),
      bolsas: t('code_performance.channel_bolsas', { defaultValue: 'Bolsas' }),
      pantallas: t('code_performance.channel_pantallas', { defaultValue: 'Pantallas' }),
      grupos: t('code_performance.channel_grupos', { defaultValue: 'Grupos' }),
      medios: t('code_performance.channel_medios', { defaultValue: 'Medios' }),
      otro: t('code_performance.channel_otro', { defaultValue: 'Otro' }),
    }),
    [t],
  );

  const audienceLabels = useMemo<Record<AcquisitionAudience, string>>(
    () => ({
      pasajeros: t('code_performance.audience_pasajeros', { defaultValue: 'Pasajeros' }),
      choferes: t('code_performance.audience_choferes', { defaultValue: 'Choferes' }),
      ambos: t('code_performance.audience_ambos', { defaultValue: 'Ambos' }),
    }),
    [t],
  );

  const firstRidesSplit = useCallback(
    (riders: number, drivers: number) =>
      t('code_performance.first_rides_split', {
        riders: num(riders),
        drivers: num(drivers),
        defaultValue: 'Pasajeros: {{riders}} · Choferes: {{drivers}}',
      }),
    [t],
  );

  const handleToggleActive = useCallback(
    async (row: AcquisitionRow) => {
      const next = !row.is_active;
      setTogglingCodes((prev) => new Set(prev).add(row.code));
      try {
        await acquisitionCodeService.setActive(row.code, next);
        // An UPDATE that RLS filters out answers OK with 0 rows, so confirm the
        // change against the reloaded stats instead of trusting the call.
        const rows = await loadCodes(true);
        if (!rows) return; // the tab already shows the load error
        if (rows.find((r) => r.code === row.code)?.is_active === next) {
          showToast(
            'success',
            next
              ? t('code_performance.toast_activated', { code: row.code, defaultValue: 'Código {{code}} activado' })
              : t('code_performance.toast_deactivated', { code: row.code, defaultValue: 'Código {{code}} desactivado' }),
          );
        } else {
          showToast(
            'error',
            t('code_performance.toggle_not_saved', {
              defaultValue: 'El cambio no se guardó. Recarga la página e inténtalo de nuevo.',
            }),
          );
        }
      } catch (err) {
        showToast('error', getErrorMessage(err));
      } finally {
        setTogglingCodes((prev) => {
          const rest = new Set(prev);
          rest.delete(row.code);
          return rest;
        });
      }
    },
    [loadCodes, showToast, t],
  );

  const canonicalCode = normalizeAcquisitionCode(form.code);
  const codeValid = ACQUISITION_CODE_PATTERN.test(canonicalCode);
  const canCreate = codeValid && form.label.trim().length > 0 && !creating;

  const updateForm = useCallback(<K extends keyof AcquisitionForm>(key: K, value: AcquisitionForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setCreateError(null);
  }, []);

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await acquisitionCodeService.create({
        code: form.code,
        label: form.label,
        channel: form.channel,
        audience: form.audience,
        notes: form.notes,
      });
      showToast('success', t('code_performance.toast_created', { code: created.code, defaultValue: 'Código {{code}} creado' }));
      // Keep channel and audience: codes usually come in batches of the same kind.
      setForm((prev) => ({ ...EMPTY_FORM, channel: prev.channel, audience: prev.audience }));
      await loadCodes(true);
    } catch (err) {
      setCreateError(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleExportCodes = useCallback(() => {
    const yes = t('code_performance.yes', { defaultValue: 'Sí' });
    const no = t('code_performance.no', { defaultValue: 'No' });
    exportToCsv(
      sortedCodes as unknown as Record<string, unknown>[],
      [
        { key: 'code', label: t('code_performance.col_code', { defaultValue: 'Código' }) },
        { key: 'label', label: t('code_performance.col_label', { defaultValue: 'Nombre' }) },
        {
          key: 'channel',
          label: t('code_performance.col_channel', { defaultValue: 'Canal' }),
          format: (v) => channelLabels[v as AcquisitionChannel] ?? String(v ?? ''),
        },
        {
          key: 'audience',
          label: t('code_performance.col_audience', { defaultValue: 'Público' }),
          format: (v) => audienceLabels[v as AcquisitionAudience] ?? String(v ?? ''),
        },
        { key: 'signups', label: t('code_performance.col_signups', { defaultValue: 'Registros' }) },
        { key: 'rider_signups', label: t('code_performance.col_rider_signups', { defaultValue: 'Pasajeros' }) },
        { key: 'driver_signups', label: t('code_performance.col_driver_signups', { defaultValue: 'Choferes' }) },
        { key: 'drivers_approved', label: t('code_performance.col_drivers_approved', { defaultValue: 'Aprobados' }) },
        {
          key: 'riders_with_ride',
          label: t('code_performance.csv_riders_with_ride', { defaultValue: 'Pasajeros con primer viaje' }),
        },
        {
          key: 'drivers_with_ride',
          label: t('code_performance.csv_drivers_with_ride', { defaultValue: 'Choferes con primer viaje' }),
        },
        { key: 'first_rides', label: t('code_performance.col_first_rides', { defaultValue: 'Con primer viaje' }) },
        {
          key: 'is_active',
          label: t('code_performance.col_active', { defaultValue: 'Activo' }),
          format: (v) => (v ? yes : no),
        },
        { key: 'created_at', label: t('code_performance.col_created', { defaultValue: 'Creado' }) },
      ],
      'codigos-de-origen',
    );
  }, [sortedCodes, channelLabels, audienceLabels, t]);

  const discountLabel = useCallback(
    (p: PromoCodePerformance) =>
      p.type === 'fixed_discount' ? `−${num(p.discount_fixed_cup ?? 0)} CUP` : `${p.discount_percent ?? 0}%`,
    [],
  );

  const TABS: StatusTab<Tab>[] = useMemo(
    () => [
      { id: 'promos', label: t('code_performance.tab_promos', { defaultValue: 'Códigos promo' }), count: promos.length },
      { id: 'referral', label: t('code_performance.tab_referral', { defaultValue: 'Códigos de referido' }), count: referrers.length },
      {
        id: 'acquisition',
        label: t('code_performance.tab_acquisition', { defaultValue: 'Códigos de origen' }),
        count: codesError ? undefined : codes.length,
      },
    ],
    [t, promos.length, referrers.length, codes.length, codesError],
  );

  const promoColumns: DataColumn<PromoCodePerformance>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('code_performance.col_code', { defaultValue: 'Código' }),
        cell: (p) => <span className="font-mono font-medium tracking-wider text-ink">{p.code}</span>,
        primary: true,
        mono: true,
        sortKey: 'code',
      },
      {
        id: 'type',
        header: t('code_performance.col_type', { defaultValue: 'Descuento' }),
        cell: (p) => <span className="font-mono text-[12px] text-ink-muted">{discountLabel(p)}</span>,
        hideBelow: 'md',
      },
      {
        id: 'is_active',
        header: t('code_performance.col_status', { defaultValue: 'Estado' }),
        cell: (p) => (
          <StatusPill
            active={p.is_active}
            activeLabel={t('code_performance.status_active', { defaultValue: 'Activa' })}
            inactiveLabel={t('code_performance.status_inactive', { defaultValue: 'Inactiva' })}
          />
        ),
        width: '110px',
      },
      {
        id: 'redemptions',
        header: t('code_performance.col_redemptions', { defaultValue: 'Canjes' }),
        cell: (p) => <span className="font-mono text-ink" data-tabular>{num(p.redemptions)}</span>,
        align: 'right',
        sortKey: 'redemptions',
        width: '96px',
      },
      {
        id: 'completed',
        header: t('code_performance.col_completed', { defaultValue: 'Viajes' }),
        cell: (p) => <span className="font-mono font-semibold text-ink" data-tabular>{num(p.completed)}</span>,
        align: 'right',
        sortKey: 'completed',
        width: '96px',
      },
      {
        id: 'unique_users',
        header: t('code_performance.col_unique_users', { defaultValue: 'Usuarios' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{num(p.unique_users)}</span>,
        align: 'right',
        sortKey: 'unique_users',
        width: '96px',
        hideBelow: 'lg',
      },
      {
        id: 'discount_given_cup',
        header: t('code_performance.col_discount', { defaultValue: 'Descuento dado' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{formatCUP(p.discount_given_cup)}</span>,
        align: 'right',
        sortKey: 'discount_given_cup',
        hideBelow: 'lg',
      },
      {
        id: 'revenue_cup',
        header: t('code_performance.col_revenue', { defaultValue: 'Ingreso' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{formatCUP(p.revenue_cup)}</span>,
        align: 'right',
        sortKey: 'revenue_cup',
        hideBelow: 'xl',
      },
      {
        id: 'valid',
        header: t('code_performance.col_valid', { defaultValue: 'Vigencia' }),
        cell: (p) => (
          <span className="text-[11px] text-ink-muted">
            {p.valid_from ? formatAdminDate(p.valid_from) : '—'}
            <span className="mx-1 text-ink-subtle">→</span>
            {p.valid_until ? formatAdminDate(p.valid_until) : '∞'}
          </span>
        ),
        hideBelow: 'xl',
      },
    ],
    [t, discountLabel],
  );

  const referralColumns: DataColumn<ReferralCodePerformance>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('code_performance.col_code', { defaultValue: 'Código' }),
        cell: (r) => <span className="font-mono font-medium tracking-wider text-ink">{r.code || '—'}</span>,
        primary: true,
        mono: true,
        sortKey: 'code',
      },
      {
        id: 'referrer_id',
        header: t('code_performance.col_referrer', { defaultValue: 'Referente' }),
        cell: (r) => <span className="font-mono text-ink-muted">{`${r.referrer_id.substring(0, 8)}…`}</span>,
        mono: true,
        hideBelow: 'md',
        width: '150px',
      },
      {
        id: 'invited',
        header: t('code_performance.col_invited', { defaultValue: 'Invitados' }),
        cell: (r) => <span className="font-mono font-semibold text-ink" data-tabular>{num(r.invited)}</span>,
        align: 'right',
        sortKey: 'invited',
        width: '110px',
      },
      {
        id: 'rewarded',
        header: t('code_performance.col_rewarded', { defaultValue: 'Premiados' }),
        cell: (r) => <span className="font-mono text-emerald-700 dark:text-emerald-400" data-tabular>{num(r.rewarded)}</span>,
        align: 'right',
        sortKey: 'rewarded',
        width: '110px',
      },
      {
        id: 'pending',
        header: t('code_performance.col_pending', { defaultValue: 'Pendientes' }),
        cell: (r) => <span className="font-mono text-ink-muted" data-tabular>{num(r.pending)}</span>,
        align: 'right',
        sortKey: 'pending',
        width: '110px',
        hideBelow: 'lg',
      },
      {
        id: 'bonus_paid_cup',
        header: t('code_performance.col_bonus_paid', { defaultValue: 'Bono pagado' }),
        cell: (r) => <span className="font-mono font-medium text-ink" data-tabular>{formatCUP(r.bonus_paid_cup)}</span>,
        align: 'right',
        sortKey: 'bonus_paid_cup',
      },
    ],
    [t],
  );

  const acquisitionColumns: DataColumn<AcquisitionRow>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('code_performance.col_code', { defaultValue: 'Código' }),
        cell: (c) => <span className="font-mono font-medium tracking-wider text-ink">{c.code}</span>,
        primary: true,
        mono: true,
        sortKey: 'code',
      },
      {
        id: 'label',
        header: t('code_performance.col_label', { defaultValue: 'Nombre' }),
        cell: (c) => <span className="text-ink">{c.label}</span>,
        secondary: true,
        sortKey: 'label',
      },
      {
        id: 'channel',
        header: t('code_performance.col_channel', { defaultValue: 'Canal' }),
        cell: (c) => <span className="text-[12px] text-ink-muted">{channelLabels[c.channel] ?? c.channel}</span>,
        sortKey: 'channel',
        hideBelow: 'lg',
      },
      {
        id: 'audience',
        header: t('code_performance.col_audience', { defaultValue: 'Público' }),
        cell: (c) => <span className="text-[12px] text-ink-muted">{audienceLabels[c.audience] ?? c.audience}</span>,
        sortKey: 'audience',
        hideBelow: 'xl',
      },
      {
        id: 'signups',
        header: t('code_performance.col_signups', { defaultValue: 'Registros' }),
        cell: (c) => <span className="font-mono font-semibold text-ink" data-tabular>{num(c.signups)}</span>,
        align: 'right',
        sortKey: 'signups',
        width: '96px',
      },
      {
        id: 'rider_signups',
        header: t('code_performance.col_rider_signups', { defaultValue: 'Pasajeros' }),
        cell: (c) => <span className="font-mono text-ink-muted" data-tabular>{num(c.rider_signups)}</span>,
        align: 'right',
        sortKey: 'rider_signups',
        width: '96px',
      },
      {
        id: 'driver_signups',
        header: t('code_performance.col_driver_signups', { defaultValue: 'Choferes' }),
        cell: (c) => <span className="font-mono text-ink-muted" data-tabular>{num(c.driver_signups)}</span>,
        align: 'right',
        sortKey: 'driver_signups',
        width: '96px',
      },
      {
        id: 'drivers_approved',
        header: t('code_performance.col_drivers_approved', { defaultValue: 'Aprobados' }),
        cell: (c) => <span className="font-mono text-ink-muted" data-tabular>{num(c.drivers_approved)}</span>,
        align: 'right',
        sortKey: 'drivers_approved',
        width: '96px',
        hideBelow: 'lg',
      },
      {
        id: 'first_rides',
        header: t('code_performance.col_first_rides', { defaultValue: 'Con primer viaje' }),
        cell: (c) => (
          <span className="inline-flex flex-col items-start md:items-end">
            <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400" data-tabular>
              {num(c.first_rides)}
            </span>
            <span className="whitespace-nowrap text-[11px] text-ink-muted">
              {firstRidesSplit(c.riders_with_ride, c.drivers_with_ride)}
            </span>
          </span>
        ),
        align: 'right',
        sortKey: 'first_rides',
      },
      {
        id: 'is_active',
        header: t('code_performance.col_active', { defaultValue: 'Activo' }),
        cell: (c) => (
          <ActiveSwitch
            active={c.is_active}
            busy={togglingCodes.has(c.code)}
            onLabel={t('code_performance.code_active', { defaultValue: 'Activo' })}
            offLabel={t('code_performance.code_inactive', { defaultValue: 'Inactivo' })}
            ariaLabel={t('code_performance.toggle_aria', { code: c.code, defaultValue: 'Activar o desactivar {{code}}' })}
            onToggle={() => void handleToggleActive(c)}
          />
        ),
        width: '120px',
      },
    ],
    [t, channelLabels, audienceLabels, firstRidesSplit, togglingCodes, handleToggleActive],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('code_performance.page_eyebrow', { defaultValue: 'Crecimiento · medición' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('code_performance.title', { defaultValue: 'Rendimiento de códigos' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {tab === 'promos'
            ? t('code_performance.description_promos', {
                defaultValue: 'Qué descuento entregó cada código promo y cuántos viajes generó. Total histórico.',
              })
            : tab === 'referral'
              ? t('code_performance.description_referral', {
                  defaultValue: 'Cuánta gente trajo cada influencer con su código de referido y cuánto bono cobró.',
                })
              : t('code_performance.description_acquisition', {
                  defaultValue:
                    'Cuánta gente se registró con cada código de origen y cuántos llegaron a su primer viaje. Total histórico.',
                })}
        </p>
      </div>

      <FilterBar<Tab>
        sticky
        tabs={TABS}
        activeTab={tab}
        onTabChange={setTab}
        actions={
          tab === 'acquisition' ? (
            <button
              type="button"
              onClick={handleExportCodes}
              disabled={sortedCodes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              {t('code_performance.export_csv', { defaultValue: 'Exportar CSV' })}
            </button>
          ) : undefined
        }
      />

      {tab === 'acquisition' ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard
              label={t('code_performance.kpi_signups', { defaultValue: 'Registros con código' })}
              value={codesError ? '—' : num(codeTotals.signups)}
              loading={codesLoading}
            />
            <KpiCard
              label={t('code_performance.kpi_rider_signups', { defaultValue: 'Pasajeros' })}
              value={codesError ? '—' : num(codeTotals.riders)}
              tone="info"
              loading={codesLoading}
            />
            <KpiCard
              label={t('code_performance.kpi_driver_signups', { defaultValue: 'Choferes' })}
              value={codesError ? '—' : num(codeTotals.drivers)}
              hint={
                codesError
                  ? undefined
                  : t('code_performance.kpi_drivers_approved_hint', {
                      n: num(codeTotals.approved),
                      defaultValue: 'Aprobados: {{n}}',
                    })
              }
              tone="primary"
              loading={codesLoading}
            />
            <KpiCard
              label={t('code_performance.kpi_first_rides', { defaultValue: 'Con primer viaje' })}
              value={codesError ? '—' : num(codeTotals.firstRides)}
              hint={codesError ? undefined : firstRidesSplit(codeTotals.ridersWithRide, codeTotals.driversWithRide)}
              tone="success"
              loading={codesLoading}
            />
          </div>

          {/* Creating needs the same backend as the stats; when that is
              missing the form could only fail, so it stays hidden. */}
          {!codesError?.missingBackend && (
            <section className="admin-card p-5">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                {t('code_performance.form_title', { defaultValue: 'Nuevo código' })}
              </p>
              <p className="mt-1 max-w-[80ch] text-[12px] text-ink-muted">
                {t('code_performance.form_help', {
                  defaultValue:
                    'Estos códigos no pagan bono: solo registran de dónde viene cada persona. La gente los escribe en «Código de invitación» al registrarse. Usa un código por influencer, lote de bolsas, pantalla o grupo.',
                })}
              </p>

              <form
                onSubmit={(e) => void handleCreate(e)}
                className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]"
              >
                <Field label={t('code_performance.field_code', { defaultValue: 'Código' })}>
                  <input
                    value={form.code}
                    onChange={(e) => updateForm('code', e.target.value)}
                    placeholder="MOTORENKO"
                    maxLength={32}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={form.code.trim() !== '' && !codeValid}
                    className={`${inputCls} font-mono uppercase tracking-wider`}
                  />
                  <span className="text-[11px] leading-snug">
                    {form.code.trim() === '' ? (
                      <span className="text-ink-muted">
                        {t('code_performance.code_rule', { defaultValue: 'Letras, números y guiones (3 a 24).' })}
                      </span>
                    ) : codeValid ? (
                      <span className="text-ink-muted">
                        {t('code_performance.code_saved_as', { defaultValue: 'Se guarda como' })}{' '}
                        <span className="font-mono font-semibold tracking-wider text-ink">{canonicalCode}</span>
                      </span>
                    ) : (
                      <span className="text-amber-800 dark:text-amber-400">
                        <span className="font-mono font-semibold tracking-wider">{canonicalCode}</span>
                        {' · '}
                        {t('code_performance.code_invalid', {
                          defaultValue: 'Solo letras, números y guiones, de 3 a 24 caracteres.',
                        })}
                      </span>
                    )}
                  </span>
                </Field>
                <Field label={t('code_performance.field_label', { defaultValue: 'Nombre' })}>
                  <input
                    value={form.label}
                    onChange={(e) => updateForm('label', e.target.value)}
                    placeholder={t('code_performance.placeholder_label', { defaultValue: 'Ej.: Motorenko (Instagram)' })}
                    maxLength={80}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('code_performance.field_channel', { defaultValue: 'Canal' })}>
                  <select
                    value={form.channel}
                    onChange={(e) => updateForm('channel', e.target.value as AcquisitionChannel)}
                    className={inputCls}
                  >
                    {CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {channelLabels[c]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('code_performance.field_audience', { defaultValue: 'Público' })}>
                  <select
                    value={form.audience}
                    onChange={(e) => updateForm('audience', e.target.value as AcquisitionAudience)}
                    className={inputCls}
                  >
                    {AUDIENCES.map((a) => (
                      <option key={a} value={a}>
                        {audienceLabels[a]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t('code_performance.field_notes', { defaultValue: 'Notas (opcional)' })}
                  className="sm:col-span-2 lg:col-span-3"
                >
                  <input
                    value={form.notes}
                    onChange={(e) => updateForm('notes', e.target.value)}
                    placeholder={t('code_performance.placeholder_notes', {
                      defaultValue: 'Contacto, lote, dónde está la pantalla…',
                    })}
                    maxLength={500}
                    className={inputCls}
                  />
                </Field>
                <div className="flex items-end sm:col-span-2 lg:col-span-1">
                  <button
                    type="submit"
                    disabled={!canCreate}
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {creating
                      ? t('code_performance.creating', { defaultValue: 'Creando…' })
                      : t('code_performance.create', { defaultValue: 'Crear código' })}
                  </button>
                </div>
                {createError && (
                  <p
                    role="alert"
                    className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-400 sm:col-span-2 lg:col-span-4"
                  >
                    {createError}
                  </p>
                )}
              </form>
            </section>
          )}

          <DataTable<AcquisitionRow>
            columns={acquisitionColumns}
            rows={sortedCodes}
            keyField="code"
            loading={codesLoading}
            empty={
              codesError
                ? {
                    icon: AlertTriangle,
                    tone: 'warning',
                    title: t('code_performance.acquisition_error_title', {
                      defaultValue: 'No pudimos cargar los códigos de origen',
                    }),
                    body: (
                      <>
                        {codesError.missingBackend
                          ? t('code_performance.acquisition_error_missing', {
                              defaultValue:
                                'La base de datos todavía no tiene los códigos de origen. Las otras pestañas siguen funcionando.',
                            })
                          : t('code_performance.acquisition_error_generic', {
                              defaultValue: 'El resto de esta página no se ve afectado. Reintenta en un momento.',
                            })}
                        <span className="mt-1 block break-words font-mono text-[11px] text-ink-subtle">
                          {codesError.message}
                        </span>
                      </>
                    ),
                    action: {
                      label: t('code_performance.retry', { defaultValue: 'Reintentar' }),
                      onClick: () => void loadCodes(),
                    },
                  }
                : {
                    icon: Megaphone,
                    title: t('code_performance.empty_acquisition_title', { defaultValue: 'Sin códigos de origen' }),
                    body: t('code_performance.empty_acquisition_body', {
                      defaultValue:
                        'Crea el primero arriba y entrégaselo al influencer, al lote de bolsas o a la pantalla.',
                    }),
                  }
            }
            sort={codeSort}
            onSortChange={setCodeSort}
          />
        </>
      ) : tab === 'promos' ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t('code_performance.kpi_active_codes', { defaultValue: 'Códigos activos' })} value={num(promoTotals.active)} loading={loading} />
            <KpiCard label={t('code_performance.kpi_redemptions', { defaultValue: 'Canjes' })} value={num(promoTotals.redemptions)} tone="info" loading={loading} />
            <KpiCard label={t('code_performance.kpi_completed', { defaultValue: 'Viajes completados' })} value={num(promoTotals.completed)} tone="success" loading={loading} />
            <KpiCard label={t('code_performance.kpi_discount_given', { defaultValue: 'Descuento entregado' })} value={cupUnit(promoTotals.discount)} unit="CUP" tone="primary" loading={loading} />
          </div>

          <DataTable<PromoCodePerformance>
            columns={promoColumns}
            rows={sortedPromos}
            keyField="id"
            loading={loading}
            error={error}
            onRetry={() => void fetchData()}
            empty={{
              icon: Ticket,
              title: t('code_performance.empty_promos_title', { defaultValue: 'Sin códigos promo' }),
              body: t('code_performance.empty_promos_body', { defaultValue: 'Crea una promoción para que un influencer la difunda y mide su rendimiento aquí.' }),
              action: { label: t('code_performance.go_promotions', { defaultValue: 'Ir a Promociones' }), href: '/promotions' },
            }}
            sort={promoSort}
            onSortChange={setPromoSort}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t('code_performance.kpi_influencers', { defaultValue: 'Referentes' })} value={num(refTotals.influencers)} loading={loading} />
            <KpiCard label={t('code_performance.kpi_invited', { defaultValue: 'Invitados' })} value={num(refTotals.invited)} tone="info" loading={loading} />
            <KpiCard label={t('code_performance.kpi_rewarded', { defaultValue: 'Premiados' })} value={num(refTotals.rewarded)} tone="success" loading={loading} />
            <KpiCard label={t('code_performance.kpi_bonus_paid', { defaultValue: 'Bono pagado' })} value={cupUnit(refTotals.paid)} unit="CUP" tone="primary" loading={loading} />
          </div>

          <DataTable<ReferralCodePerformance>
            columns={referralColumns}
            rows={sortedReferrers}
            keyField="referrer_id"
            loading={loading}
            error={error}
            onRetry={() => void fetchData()}
            empty={{
              icon: Gift,
              title: t('code_performance.empty_referral_title', { defaultValue: 'Sin referidos todavía' }),
              body: t('code_performance.empty_referral_body', { defaultValue: 'Cuando un influencer comparta su código y alguien se registre con él, vas a ver su desempeño aquí.' }),
            }}
            sort={refSort}
            onSortChange={setRefSort}
          />
        </>
      )}
    </div>
  );
}
