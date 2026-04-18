'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  Flame,
  MapPinned,
  Snowflake,
  Sparkles,
  UserCog,
  Users as UsersIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatAdminDate } from '@/lib/formatDate';

type SegmentType = 'new_users' | 'power_users' | 'inactive' | 'by_city';

type SegmentUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  rides_count: number;
  last_ride_date: string | null;
  city_name: string | null;
};

type City = { id: string; name: string; slug: string };

const PAGE_SIZE = 20;

const SEGMENT_META: Record<
  SegmentType,
  { icon: LucideIcon; tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  new_users: { icon: Sparkles, tone: 'success' },
  power_users: { icon: Flame, tone: 'primary' },
  inactive: { icon: Snowflake, tone: 'warning' },
  by_city: { icon: MapPinned, tone: 'info' },
};

export default function SegmentsPage() {
  const { t } = useTranslation('admin');

  const segmentLabel = (type: SegmentType): string => {
    const fallbacks: Record<SegmentType, string> = {
      new_users: 'Recién llegados',
      power_users: 'Power users',
      inactive: 'Inactivos',
      by_city: 'Por provincia',
    };
    return t(`segments.type_${type}`, { defaultValue: fallbacks[type] });
  };
  const [error, setError] = useState<string | null>(null);

  const [counts, setCounts] = useState<Record<SegmentType, number>>({
    new_users: 0,
    power_users: 0,
    inactive: 0,
    by_city: 0,
  });
  const [countsLoading, setCountsLoading] = useState(true);

  const [activeSegment, setActiveSegment] = useState<SegmentType | null>(null);
  const [users, setUsers] = useState<SegmentUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [page, setPage] = useState(0);

  const [cities, setCities] = useState<City[]>([]);
  const [selectedCityId, setSelectedCityId] = useState('');

  useEffect(() => {
    cityService.getAllCities().then(setCities).catch(() => {});
  }, []);

  const loadCounts = useCallback(async () => {
    setCountsLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { count: newCount } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', sevenDaysAgo);

      const { data: powerData } = await supabase.rpc('count_power_users', {}).maybeSingle();
      let powerCount = (powerData as { count?: number } | null)?.count ?? 0;
      if (!powerData) {
        const { data: rideGroups } = await supabase
          .from('rides')
          .select('customer_id')
          .not('customer_id', 'is', null);
        if (rideGroups) {
          const rideCounts: Record<string, number> = {};
          for (const r of rideGroups) {
            rideCounts[r.customer_id] = (rideCounts[r.customer_id] || 0) + 1;
          }
          powerCount = Object.values(rideCounts).filter((c) => c > 10).length;
        }
      }

      const { data: activeRiders } = await supabase
        .from('rides')
        .select('customer_id')
        .gte('created_at', thirtyDaysAgo)
        .not('customer_id', 'is', null);
      const activeRiderIds = new Set((activeRiders ?? []).map((r) => r.customer_id));
      const { count: totalCustomers } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'customer');
      const inactiveCount = (totalCustomers ?? 0) - activeRiderIds.size;

      setCounts({
        new_users: newCount ?? 0,
        power_users: powerCount,
        inactive: Math.max(0, inactiveCount),
        by_city: 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('segments.load_error', { defaultValue: 'No pudimos cargar los segmentos.' }));
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const loadSegmentUsers = useCallback(
    async (segment: SegmentType, pageNum: number, cityId?: string) => {
      setUsersLoading(true);
      try {
        const supabase = getSupabaseClient();
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const offset = pageNum * PAGE_SIZE;

        let userIds: string[] = [];

        if (segment === 'new_users') {
          const { data } = await supabase
            .from('users')
            .select('id')
            .gte('created_at', sevenDaysAgo)
            .range(offset, offset + PAGE_SIZE - 1);
          userIds = (data ?? []).map((u) => u.id);
        } else if (segment === 'power_users') {
          const { data: allRides } = await supabase
            .from('rides')
            .select('customer_id')
            .not('customer_id', 'is', null);
          if (allRides) {
            const rideCounts: Record<string, number> = {};
            for (const r of allRides) {
              rideCounts[r.customer_id] = (rideCounts[r.customer_id] || 0) + 1;
            }
            userIds = Object.entries(rideCounts)
              .filter(([, c]) => c > 10)
              .map(([id]) => id)
              .slice(offset, offset + PAGE_SIZE);
          }
        } else if (segment === 'inactive') {
          const { data: activeRiders } = await supabase
            .from('rides')
            .select('customer_id')
            .gte('created_at', thirtyDaysAgo)
            .not('customer_id', 'is', null);
          const activeSet = new Set((activeRiders ?? []).map((r) => r.customer_id));
          const { data: allCustomers } = await supabase
            .from('users')
            .select('id')
            .eq('role', 'customer');
          const inactiveIds = (allCustomers ?? [])
            .filter((u) => !activeSet.has(u.id))
            .map((u) => u.id);
          userIds = inactiveIds.slice(offset, offset + PAGE_SIZE);
        } else if (segment === 'by_city' && cityId) {
          const { data } = await supabase
            .from('users')
            .select('id')
            .eq('city_id', cityId)
            .range(offset, offset + PAGE_SIZE - 1);
          userIds = (data ?? []).map((u) => u.id);
        }

        if (userIds.length === 0) {
          setUsers([]);
          return;
        }

        const { data: profiles } = await supabase
          .from('users')
          .select('id, full_name, email, phone, city_id')
          .in('id', userIds);

        const { data: rides } = await supabase
          .from('rides')
          .select('customer_id, created_at')
          .in('customer_id', userIds);

        const rideStats: Record<string, { count: number; lastRide: string | null }> = {};
        for (const ride of rides ?? []) {
          if (!rideStats[ride.customer_id]) rideStats[ride.customer_id] = { count: 0, lastRide: null };
          const stat = rideStats[ride.customer_id]!;
          stat.count++;
          if (!stat.lastRide || ride.created_at > stat.lastRide) stat.lastRide = ride.created_at;
        }

        const cityIds = [...new Set((profiles ?? []).map((p) => p.city_id).filter(Boolean))];
        const cityMap: Record<string, string> = {};
        if (cityIds.length > 0) {
          const { data: citiesData } = await supabase
            .from('cities')
            .select('id, name')
            .in('id', cityIds as string[]);
          for (const c of citiesData ?? []) cityMap[c.id] = c.name;
        }

        const result: SegmentUser[] = (profiles ?? []).map((p) => ({
          id: p.id,
          full_name: p.full_name,
          email: p.email,
          phone: p.phone,
          rides_count: rideStats[p.id]?.count ?? 0,
          last_ride_date: rideStats[p.id]?.lastRide ?? null,
          city_name: p.city_id ? cityMap[p.city_id] ?? null : null,
        }));

        setUsers(result);
      } catch {
        setUsers([]);
      } finally {
        setUsersLoading(false);
      }
    },
    [],
  );

  const handleViewUsers = (segment: SegmentType) => {
    setActiveSegment(segment);
    setPage(0);
    if (segment === 'by_city' && !selectedCityId) return;
    void loadSegmentUsers(segment, 0, selectedCityId);
  };

  useEffect(() => {
    if (activeSegment && (activeSegment !== 'by_city' || selectedCityId)) {
      void loadSegmentUsers(activeSegment, page, selectedCityId);
    }

  }, [page]);

  const handleCityChange = (cityId: string) => {
    setSelectedCityId(cityId);
    if (activeSegment === 'by_city' && cityId) {
      setPage(0);
      void loadSegmentUsers('by_city', 0, cityId);
      const supabase = getSupabaseClient();
      supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('city_id', cityId)
        .then(({ count }) => {
          setCounts((prev) => ({ ...prev, by_city: count ?? 0 }));
        });
    }
  };

  const handleExportCSV = () => {
    if (users.length === 0) return;
    const headers = [
      t('segments.csv_name', { defaultValue: 'Nombre' }),
      t('segments.csv_email', { defaultValue: 'Email' }),
      t('segments.csv_phone', { defaultValue: 'Teléfono' }),
      t('segments.csv_rides', { defaultValue: 'Viajes' }),
      t('segments.csv_last_ride', { defaultValue: 'Último viaje' }),
      t('segments.csv_city', { defaultValue: 'Ciudad' }),
    ];
    const rows = users.map((u) => [
      u.full_name ?? '',
      u.email ?? '',
      u.phone ?? '',
      String(u.rides_count),
      u.last_ride_date ? new Date(u.last_ride_date).toISOString().split('T')[0] : '',
      u.city_name ?? '',
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `segment_${activeSegment}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const columns: DataColumn<SegmentUser>[] = [
    {
      id: 'full_name',
      header: t('segments.col_name', { defaultValue: 'Nombre' }),
      cell: (u) => <span className="font-medium text-ink">{u.full_name ?? t('segments.no_name', { defaultValue: 'Sin nombre' })}</span>,
      primary: true,
    },
    {
      id: 'phone',
      header: t('segments.col_phone', { defaultValue: 'Teléfono' }),
      cell: (u) => u.phone ?? <span className="text-ink-subtle">—</span>,
      mono: true,
      hideBelow: 'md',
      width: '150px',
    },
    {
      id: 'email',
      header: t('segments.col_email', { defaultValue: 'Email' }),
      cell: (u) => u.email ?? <span className="text-ink-subtle">—</span>,
      hideBelow: 'lg',
      secondary: true,
    },
    {
      id: 'rides_count',
      header: t('segments.col_rides', { defaultValue: 'Viajes' }),
      cell: (u) => u.rides_count,
      align: 'right',
      mono: true,
      width: '90px',
    },
    {
      id: 'last_ride_date',
      header: t('segments.col_last_ride', { defaultValue: 'Último viaje' }),
      cell: (u) => <span className="text-ink-muted">{formatAdminDate(u.last_ride_date)}</span>,
      hideBelow: 'lg',
      width: '170px',
    },
    {
      id: 'city_name',
      header: t('segments.col_city', { defaultValue: 'Ciudad' }),
      cell: (u) => u.city_name ?? <span className="text-ink-subtle">—</span>,
      hideBelow: 'lg',
      width: '150px',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('segments.page_eyebrow', { defaultValue: 'Crecimiento · segmentos' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('segments.title', { defaultValue: 'Segmentos' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {t('segments.page_description', { defaultValue: 'Cortes de usuarios por comportamiento. Explorá cada cohorte para entenderla mejor.' })}
        </p>
      </div>

      {error && (
        <div className="admin-card border-red-500/30 bg-red-500/5 px-5 py-3 text-[13px] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(SEGMENT_META) as SegmentType[]).map((type) => {
          const meta = SEGMENT_META[type];
          const Icon = meta.icon;
          const active = activeSegment === type;
          return (
            <div
              key={type}
              className={`admin-card flex flex-col gap-3 p-5 transition-all ${
                active ? 'ring-2 ring-primary-500/40' : ''
              }`}
            >
              <KpiCardBlock
                label={segmentLabel(type)}
                value={countsLoading ? '—' : String(counts[type])}
                tone={meta.tone}
                icon={Icon}
              />

              {type === 'by_city' && (
                <select
                  value={selectedCityId}
                  onChange={(e) => handleCityChange(e.target.value)}
                  aria-label={t('segments.choose_city_aria', { defaultValue: 'Seleccionar ciudad' })}
                  className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
                >
                  <option value="">{t('segments.choose_city_placeholder', { defaultValue: 'Elegí una ciudad' })}</option>
                  {cities.map((city) => (
                    <option key={city.id} value={city.id}>
                      {city.name}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => handleViewUsers(type)}
                disabled={type === 'by_city' && !selectedCityId}
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('segments.view_users', { defaultValue: 'Ver usuarios' })}
              </button>
            </div>
          );
        })}
      </div>

      {activeSegment && (
        <SectionCard
          eyebrow={t('segments.section_result_eyebrow', { defaultValue: 'Resultado' })}
          title={segmentLabel(activeSegment)}
          description={`${t('segments.page_label', { defaultValue: 'Página' })} ${page + 1}`}
          action={
            users.length > 0
              ? undefined
              : undefined
          }
        >
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={handleExportCSV}
              disabled={users.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              {t('segments.export_csv', { defaultValue: 'Exportar CSV' })}
            </button>
          </div>
          <DataTable<SegmentUser>
            columns={columns}
            rows={users}
            keyField="id"
            loading={usersLoading}
            empty={{
              icon: UsersIcon,
              title: t('segments.empty_title', { defaultValue: 'Sin usuarios en este segmento' }),
              body: t('segments.empty_body', { defaultValue: 'Todavía no hay nadie que cumpla las condiciones.' }),
            }}
            pagination={{ page, pageSize: PAGE_SIZE, hasMore: users.length === PAGE_SIZE }}
            onPaginationChange={(next) => setPage(next.page)}
          />
        </SectionCard>
      )}

      {!activeSegment && (
        <SectionCard
          eyebrow={t('segments.start_eyebrow', { defaultValue: 'Empezá por acá' })}
          title={t('segments.start_title', { defaultValue: 'Elegí un segmento arriba' })}
          description={t('segments.start_description', { defaultValue: 'Cada tarjeta abre la lista detallada de quiénes lo componen.' })}
        >
          <div className="flex items-center gap-3 text-[12.5px] text-ink-muted">
            <UserCog className="h-4 w-4" />
            {t('segments.start_hint', { defaultValue: 'Los segmentos se calculan sobre la última actividad registrada.' })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function KpiCardBlock({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  icon: LucideIcon;
}) {
  return <KpiCard label={label} value={value} tone={tone} icon={icon} />;
}
