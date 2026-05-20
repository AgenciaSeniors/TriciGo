'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverProfileWithUser, DriverStatus } from '@tricigo/types';
import { createBrowserClient } from '@/lib/supabase-server';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { exportToCsv } from '@/lib/exportCsv';
import {
  Search,
  Download,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  Star,
  Car,
  Bike,
  Package,
  X,
  Users,
} from 'lucide-react';

const PAGE_SIZE = 20;

type StatusFilter = DriverStatus | 'all';

// ─── Status visual tokens ────────────────────────────────────
const STATUS_STYLES: Record<DriverStatus, { dot: string; text: string; gradient: string }> = {
  pending_verification: { dot: 'bg-yellow-500', text: 'text-yellow-700', gradient: 'from-yellow-400 to-amber-600' },
  under_review:         { dot: 'bg-blue-500',   text: 'text-blue-700',   gradient: 'from-blue-400 to-blue-600' },
  approved:             { dot: 'bg-green-500',  text: 'text-green-700',  gradient: 'from-green-400 to-emerald-600' },
  rejected:             { dot: 'bg-red-500',    text: 'text-red-700',    gradient: 'from-red-400 to-rose-600' },
  suspended:            { dot: 'bg-orange-500', text: 'text-orange-700', gradient: 'from-orange-400 to-orange-600' },
};

const STATUS_LABEL_KEYS: Record<DriverStatus, string> = {
  pending_verification: 'drivers.status_pending',
  under_review: 'drivers.status_in_review',
  approved: 'drivers.status_approved',
  rejected: 'drivers.status_rejected',
  suspended: 'drivers.status_suspended',
};

// ─── Small helpers ───────────────────────────────────────────
function getInitials(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

function vehicleIcon(type?: string) {
  switch (type) {
    case 'auto': return Car;
    case 'moto': case 'triciclo': return Bike;
    default: return Package;
  }
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d < 1) return 'hoy';
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d} días`;
  if (d < 30) return `hace ${Math.floor(d / 7)} sem`;
  if (d < 365) return `hace ${Math.floor(d / 30)} mes`;
  return `hace ${Math.floor(d / 365)} año`;
}

export default function DriversPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');

  // ─── State ─────────────────────────────────────────────────
  const [drivers, setDrivers] = useState<DriverProfileWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Unified filter state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [ratingMin, setRatingMin] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [selectedCity, setSelectedCity] = useState('');

  const hasFilters = !!(statusFilter !== 'all' || search || ratingMin || vehicleType || selectedCity);

  // ─── Data loading ──────────────────────────────────────────
  useEffect(() => {
    const supabase = createBrowserClient();
    supabase.from('cities').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => { if (data) setCities(data); });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const filters: Record<string, unknown> = {};
        if (statusFilter !== 'all') filters.status = statusFilter;
        if (search) filters.search = search;
        if (ratingMin) filters.ratingMin = parseFloat(ratingMin);
        if (vehicleType) filters.vehicleType = vehicleType;
        if (selectedCity) filters.cityId = selectedCity;

        const data = await adminService.getAllDrivers(page, PAGE_SIZE, filters);
        if (!cancelled) setDrivers(data);
      } catch (err) {
        if (!cancelled) {
          setDrivers([]);
          setError(err instanceof Error ? err.message : 'Error al cargar conductores');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter, search, ratingMin, vehicleType, selectedCity]);

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(drivers, 'created_at');

  const canGoPrev = page > 0;
  const canGoNext = drivers.length === PAGE_SIZE;

  // Summary counts (from current page — not global totals)
  const pendingCount = sortedData.filter((d) => d.status === 'pending_verification' || d.status === 'under_review').length;
  const onlineCount = sortedData.filter((d) => d.is_online).length;

  // ─── Handlers ──────────────────────────────────────────────
  const clearFilters = useCallback(() => {
    setStatusFilter('all');
    setSearch('');
    setRatingMin('');
    setVehicleType('');
    setSelectedCity('');
    setPage(0);
  }, []);

  const handleExport = useCallback(() => {
    exportToCsv(
      sortedData.map((d) => ({
        ...d,
        name: d.users?.full_name ?? '',
        phone: d.users?.phone ?? '',
        vehicle: d.vehicles?.[0] ? `${d.vehicles[0].type} — ${d.vehicles[0].plate_number}` : '',
      })) as unknown as Record<string, unknown>[],
      [
        { key: 'name', label: t('drivers.col_name') },
        { key: 'phone', label: t('drivers.col_phone') },
        { key: 'vehicle', label: t('drivers.col_vehicle') },
        { key: 'status', label: t('drivers.col_status') },
        { key: 'rating_avg', label: t('drivers.col_rating') },
        { key: 'created_at', label: t('drivers.col_registered') },
      ],
      'drivers',
    );
  }, [sortedData, t]);

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="min-h-screen">
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPage(0); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* ─── Page header ────────────────────────────────────── */}
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {t('drivers.title', { defaultValue: 'Conductores' })}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              {sortedData.length} {t('drivers.in_page', { defaultValue: 'en esta página' })}
              {pendingCount > 0 && <> · <span className="text-yellow-700">{pendingCount} {t('drivers.pending_label', { defaultValue: 'pendientes' })}</span></>}
              {onlineCount > 0 && <> · <span className="text-green-700">{onlineCount} {t('drivers.online_label', { defaultValue: 'en línea' })}</span></>}
            </p>
          </div>
          <button
            onClick={handleExport}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-line bg-surface-elevated text-sm font-medium text-ink hover:bg-surface-sunken hover:border-line-strong disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={14} />
            {t('common.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        </div>
      </header>

      {/* ─── Unified filter bar ─────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder={t('filters.search_driver_placeholder', { defaultValue: 'Buscar nombre o teléfono...' })}
            className="w-full h-9 pl-9 pr-3 rounded-md border border-line bg-surface text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(0); }}
          className="h-9 px-3 rounded-md border border-line bg-surface text-sm text-ink hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="all">{t('drivers.filter_all', { defaultValue: 'Todos los estados' })}</option>
          <option value="pending_verification">{t('drivers.status_pending', { defaultValue: 'Pendiente' })}</option>
          <option value="under_review">{t('drivers.status_in_review', { defaultValue: 'En revisión' })}</option>
          <option value="approved">{t('drivers.status_approved', { defaultValue: 'Aprobado' })}</option>
          <option value="rejected">{t('drivers.status_rejected', { defaultValue: 'Rechazado' })}</option>
          <option value="suspended">{t('drivers.status_suspended', { defaultValue: 'Suspendido' })}</option>
        </select>

        <select
          value={vehicleType}
          onChange={(e) => { setVehicleType(e.target.value); setPage(0); }}
          className="h-9 px-3 rounded-md border border-line bg-surface text-sm text-ink hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">{t('filters.all_vehicles', { defaultValue: 'Todos los vehículos' })}</option>
          <option value="triciclo">{t('drivers.type_triciclo', { defaultValue: 'Triciclo' })}</option>
          <option value="moto">{t('drivers.type_moto', { defaultValue: 'Moto' })}</option>
          <option value="auto">{t('drivers.type_auto', { defaultValue: 'Auto' })}</option>
        </select>

        <select
          value={selectedCity}
          onChange={(e) => { setSelectedCity(e.target.value); setPage(0); }}
          className="h-9 px-3 rounded-md border border-line bg-surface text-sm text-ink hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">{t('cities.all_cities', { defaultValue: 'Todas las ciudades' })}</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select
          value={ratingMin}
          onChange={(e) => { setRatingMin(e.target.value); setPage(0); }}
          className="h-9 px-3 rounded-md border border-line bg-surface text-sm text-ink hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">{t('filters.any_rating', { defaultValue: 'Cualquier rating' })}</option>
          <option value="3.0">3.0+</option>
          <option value="4.0">4.0+</option>
          <option value="4.5">4.5+</option>
        </select>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="inline-flex items-center gap-1 h-9 px-3 rounded-md text-sm text-ink-muted hover:text-ink transition-colors"
          >
            <X size={14} />
            {t('filters.clear_all', { defaultValue: 'Limpiar' })}
          </button>
        )}
      </div>

      {/* ─── Desktop table ──────────────────────────────────── */}
      <div className="hidden md:block bg-surface-elevated rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" aria-label={t('drivers.title')}>
            <thead>
              <tr className="border-b border-line bg-surface-sunken/50">
                <th className="w-14"></th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wider">
                  {t('drivers.col_name', { defaultValue: 'Conductor' })}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wider">
                  {t('drivers.col_vehicle', { defaultValue: 'Vehículo' })}
                </th>
                <SortableHeader
                  label={t('drivers.col_status', { defaultValue: 'Estado' })}
                  sortKey="status"
                  currentSortKey={sortKey as string | null}
                  sortDirection={sortDirection}
                  onSort={toggleSort as (key: string) => void}
                  className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wider"
                />
                <SortableHeader
                  label={t('drivers.col_rating', { defaultValue: 'Rating' })}
                  sortKey="rating_avg"
                  currentSortKey={sortKey as string | null}
                  sortDirection={sortDirection}
                  onSort={toggleSort as (key: string) => void}
                  className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wider"
                />
                <SortableHeader
                  label={t('drivers.col_registered', { defaultValue: 'Registrado' })}
                  sortKey="created_at"
                  currentSortKey={sortKey as string | null}
                  sortDirection={sortDirection}
                  onSort={toggleSort as (key: string) => void}
                  className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wider"
                />
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-0 py-0"><AdminTableSkeleton rows={5} columns={7} /></td></tr>
              ) : sortedData.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16">
                    <div className="flex flex-col items-center text-center gap-2">
                      <Users size={28} className="text-ink-subtle" />
                      <p className="text-sm font-medium text-ink">
                        {t('drivers.no_drivers', { defaultValue: 'No hay conductores' })}
                      </p>
                      {hasFilters && (
                        <button onClick={clearFilters} className="text-sm text-primary-500 hover:text-primary-600 mt-1">
                          {t('filters.clear_all', { defaultValue: 'Limpiar filtros' })}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                sortedData.map((driver) => {
                  const vehicle = driver.vehicles?.[0];
                  const VIcon = vehicleIcon(vehicle?.type);
                  const status = STATUS_STYLES[driver.status];
                  return (
                    <tr
                      key={driver.id}
                      onClick={() => router.push(`/drivers/${driver.id}`)}
                      className="group h-14 border-b border-line last:border-0 hover:bg-surface-sunken cursor-pointer transition-colors border-l-2 border-l-transparent hover:border-l-primary-500"
                    >
                      <td className="pl-4">
                        <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${status.gradient} flex items-center justify-center text-white text-xs font-semibold`}>
                          {getInitials(driver.users?.full_name)}
                        </div>
                      </td>
                      <td className="px-4">
                        <div className="font-medium text-sm text-ink leading-tight">
                          {driver.users?.full_name || t('common.no_name', { defaultValue: 'Sin nombre' })}
                        </div>
                        <div className="text-xs text-ink-muted mt-0.5">{driver.users?.phone ?? '—'}</div>
                      </td>
                      <td className="px-4">
                        {vehicle ? (
                          <div className="flex items-center gap-2">
                            <VIcon size={16} className="text-ink-subtle" />
                            <div>
                              <div className="text-sm text-ink-muted capitalize">{vehicle.type}</div>
                              <div className="text-xs text-ink-muted">{vehicle.plate_number}</div>
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-ink-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4">
                        <div className="inline-flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                          <span className={`text-sm ${status.text}`}>{t(STATUS_LABEL_KEYS[driver.status])}</span>
                        </div>
                        {driver.is_on_break && (
                          <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700">
                            {t('drivers.on_break', { defaultValue: 'En descanso' })}
                          </span>
                        )}
                      </td>
                      <td className="px-4">
                        {driver.rating_avg > 0 ? (
                          <div className="inline-flex items-center gap-1">
                            <Star size={13} className="text-amber-500 fill-amber-500" />
                            <span className="text-sm text-ink-muted tabular-nums">
                              {Number(driver.rating_avg).toFixed(1)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-sm text-ink-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 text-sm text-ink-muted tabular-nums">
                        {formatRelative(driver.created_at)}
                      </td>
                      <td className="pr-4">
                        <ChevronRight size={16} className="text-ink-subtle group-hover:text-ink-muted transition-colors" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Mobile card list ───────────────────────────────── */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-surface-elevated rounded-xl border border-line p-4">
            <AdminTableSkeleton rows={5} columns={1} />
          </div>
        ) : sortedData.length === 0 ? (
          <div className="bg-surface-elevated rounded-xl border border-line p-8 text-center">
            <Users size={28} className="text-ink-subtle mx-auto mb-2" />
            <p className="text-sm font-medium text-ink">{t('drivers.no_drivers', { defaultValue: 'No hay conductores' })}</p>
          </div>
        ) : (
          sortedData.map((driver) => {
            const vehicle = driver.vehicles?.[0];
            const status = STATUS_STYLES[driver.status];
            return (
              <button
                key={driver.id}
                onClick={() => router.push(`/drivers/${driver.id}`)}
                className="w-full text-left bg-surface-elevated rounded-xl border border-line p-3 flex items-center gap-3 hover:bg-surface-sunken transition-colors active:scale-[0.99]"
              >
                <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${status.gradient} flex items-center justify-center text-white text-sm font-semibold shrink-0`}>
                  {getInitials(driver.users?.full_name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-ink truncate">
                    {driver.users?.full_name || '—'}
                  </div>
                  <div className="text-xs text-ink-muted truncate mt-0.5">
                    {driver.users?.phone ?? '—'} {vehicle && <>· {vehicle.plate_number}</>}
                  </div>
                  <div className="mt-1 inline-flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                    <span className={`text-xs ${status.text}`}>{t(STATUS_LABEL_KEYS[driver.status])}</span>
                  </div>
                </div>
                <ChevronRight size={16} className="text-ink-subtle shrink-0" />
              </button>
            );
          })
        )}
      </div>

      {/* ─── Pagination ─────────────────────────────────────── */}
      <div className="mt-6 flex items-center justify-between">
        <p className="text-sm text-ink-muted tabular-nums">
          {!loading && sortedData.length > 0 && (
            <>
              {t('common.showing', { defaultValue: 'Mostrando' })} {page * PAGE_SIZE + 1}
              –{page * PAGE_SIZE + sortedData.length}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={!canGoPrev}
            aria-label={t('common.previous', { defaultValue: 'Anterior' })}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-line bg-surface-elevated text-ink hover:bg-surface-sunken disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={14} />
            {t('common.previous', { defaultValue: 'Anterior' })}
          </button>
          <span className="text-sm text-ink-muted tabular-nums px-2">{page + 1}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!canGoNext}
            aria-label={t('common.next', { defaultValue: 'Siguiente' })}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-line bg-surface-elevated text-ink hover:bg-surface-sunken disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t('common.next', { defaultValue: 'Siguiente' })}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
