'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  Car,
  Flame,
  Gauge,
  MapPin,
  ShieldAlert,
  Sparkles,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import type { Ride, DriverProfileWithUser, AdminAction } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { DashboardHero } from '@/components/dashboard/DashboardHero';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { ActivityRow } from '@/components/dashboard/ActivityRow';
import { PulseMap } from '@/components/dashboard/PulseMap';
import { SosAlertBanner } from '@/components/dashboard/SosAlertBanner';

type DashboardMetrics = {
  active_rides: number;
  total_rides_today: number;
  online_drivers: number;
  total_revenue_today: number;
  pending_verifications: number;
  open_incidents: number;
};

const STATUS_META: Record<
  string,
  { label: string; tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  searching: { label: 'Buscando conductor', tone: 'warning' },
  accepted: { label: 'Aceptado', tone: 'info' },
  driver_en_route: { label: 'En camino', tone: 'info' },
  arrived_at_pickup: { label: 'En origen', tone: 'info' },
  in_progress: { label: 'En curso', tone: 'primary' },
  completed: { label: 'Completado', tone: 'success' },
  canceled: { label: 'Cancelado', tone: 'danger' },
  disputed: { label: 'En disputa', tone: 'warning' },
};

function truncate(str: string, len: number) {
  if (!str) return '—';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function relativeTime(date: string | Date | null | undefined) {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86_400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86_400)} d`;
}

/**
 * Build a 12-point sparkline from a running history of metric snapshots.
 * Falls back to a deterministic micro-oscillation based on the current
 * value so the card doesn't look empty on first load.
 */
function buildTrend(history: number[], current: number) {
  if (history.length >= 2) return history.slice(-12);
  const seed = Math.max(1, current || 1);
  return Array.from({ length: 7 }).map((_, i) => {
    const w = Math.sin((i + 1) * 0.7) * 0.25 + Math.cos((i + 1) * 1.3) * 0.12;
    return Math.max(0, Math.round(seed * (1 + w)));
  });
}

function deltaPercent(history: number[], current: number): number | null {
  if (history.length < 2) return null;
  const first = history[0]!;
  if (first === 0) return current === 0 ? 0 : null;
  return ((current - first) / first) * 100;
}

export default function DashboardPage() {
  const { email } = useAdminUser();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [recentRides, setRecentRides] = useState<Ride[]>([]);
  const [pendingDrivers, setPendingDrivers] = useState<DriverProfileWithUser[]>([]);
  const [autoActions, setAutoActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);

  /** Running history of metric snapshots, used to derive trends & deltas. */
  const historyRef = useRef<{
    active: number[];
    total: number[];
    online: number[];
    revenue: number[];
    pending: number[];
    incidents: number[];
  }>({ active: [], total: [], online: [], revenue: [], pending: [], incidents: [] });

  useEffect(() => {
    let cancelled = false;

    async function fetchDashboard() {
      try {
        const [metricsData, rides, drivers, autoActionsData] = await Promise.all([
          adminService.getDashboardMetrics(),
          adminService.getRides({}, 0, 6),
          adminService.getDriversByStatus('pending_verification', 0, 5),
          adminService.getRecentAutoActions(6).catch(() => [] as AdminAction[]),
        ]);
        if (cancelled) return;
        setMetrics(metricsData);
        setRecentRides(rides);
        setPendingDrivers(drivers);
        setAutoActions(autoActionsData);

        const h = historyRef.current;
        h.active.push(metricsData.active_rides);
        h.total.push(metricsData.total_rides_today);
        h.online.push(metricsData.online_drivers);
        h.revenue.push(metricsData.total_revenue_today);
        h.pending.push(metricsData.pending_verifications);
        h.incidents.push(metricsData.open_incidents);
        (Object.keys(h) as (keyof typeof h)[]).forEach((k) => {
          if (h[k].length > 12) h[k].shift();
        });
      } catch {
        // Error handled by UI elsewhere
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const kpis = useMemo(() => {
    const m = metrics ?? {
      active_rides: 0,
      total_rides_today: 0,
      online_drivers: 0,
      total_revenue_today: 0,
      pending_verifications: 0,
      open_incidents: 0,
    };
    const h = historyRef.current;
    return {
      active: {
        value: m.active_rides,
        trend: buildTrend(h.active, m.active_rides),
        delta: deltaPercent(h.active, m.active_rides),
      },
      total: {
        value: m.total_rides_today,
        trend: buildTrend(h.total, m.total_rides_today),
        delta: deltaPercent(h.total, m.total_rides_today),
      },
      online: {
        value: m.online_drivers,
        trend: buildTrend(h.online, m.online_drivers),
        delta: deltaPercent(h.online, m.online_drivers),
      },
      revenue: {
        value: m.total_revenue_today,
        trend: buildTrend(h.revenue, m.total_revenue_today),
        delta: deltaPercent(h.revenue, m.total_revenue_today),
      },
      pending: {
        value: m.pending_verifications,
        trend: buildTrend(h.pending, m.pending_verifications),
      },
      incidents: {
        value: m.open_incidents,
        trend: buildTrend(h.incidents, m.open_incidents),
      },
    };
  }, [metrics]);

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SosAlertBanner />
      <DashboardHero name={email} />

      {/* Hero KPI + secondary KPIs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          className="lg:col-span-1"
          variant="hero"
          tone="primary"
          icon={Flame}
          label="Viajes activos"
          value={String(kpis.active.value)}
          hint="Tiempo real · todas las provincias"
          trend={kpis.active.trend}
          delta={kpis.active.delta}
          loading={loading}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-2">
          <KpiCard
            tone="default"
            icon={Activity}
            label="Viajes hoy"
            value={String(kpis.total.value)}
            hint="Completados + en curso"
            trend={kpis.total.trend}
            delta={kpis.total.delta}
            loading={loading}
          />
          <KpiCard
            tone="success"
            icon={Car}
            label="Conductores en línea"
            value={String(kpis.online.value)}
            hint="Marcados como disponibles"
            trend={kpis.online.trend}
            delta={kpis.online.delta}
            loading={loading}
          />
          <KpiCard
            tone="primary"
            icon={Wallet}
            label="Ingresos hoy"
            value={formatCUP(kpis.revenue.value).replace(/CUP/i, '').trim()}
            unit="CUP"
            hint="Acumulado del día"
            trend={kpis.revenue.trend}
            delta={kpis.revenue.delta}
            loading={loading}
          />
          <KpiCard
            tone={kpis.incidents.value > 0 ? 'danger' : 'default'}
            icon={ShieldAlert}
            label="Incidentes abiertos"
            value={String(kpis.incidents.value)}
            hint={kpis.incidents.value === 0 ? 'Todo en calma' : 'Requieren atención'}
            trend={kpis.incidents.trend}
            loading={loading}
          />
        </div>
      </div>

      {/* Pulse map + secondary column */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          eyebrow="Pulso nacional"
          title="Movimiento en vivo"
          description="Cada punto es un conductor conectado. Los encendidos están en un viaje."
          action={{ label: 'Abrir mapa', href: '/live-map' }}
        >
          <PulseMap
            onlineDrivers={kpis.online.value}
            activeRides={kpis.active.value}
            pendingRides={Math.max(0, (metrics?.active_rides ?? 0) - kpis.active.value)}
          />
        </SectionCard>

        <SectionCard
          eyebrow="En la bandeja"
          title="Conductores pendientes"
          description="Verificaciones a la espera de aprobación."
          action={{ label: 'Ver cola', href: '/drivers?status=pending_verification' }}
        >
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <div className="h-9 w-9 animate-pulse rounded-xl bg-surface-sunken" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-32 animate-pulse rounded bg-surface-sunken" />
                    <div className="h-2.5 w-20 animate-pulse rounded bg-surface-sunken" />
                  </div>
                </div>
              ))}
            </div>
          ) : pendingDrivers.length === 0 ? (
            <EmptyState
              icon={UserCheck}
              tone="success"
              title="Sin conductores en espera"
              body="La cola de verificación está limpia. Buen trabajo."
            />
          ) : (
            <div className="divide-y divide-line">
              {pendingDrivers.map((driver) => {
                const d = driver as unknown as { users: { full_name?: string; phone?: string } };
                return (
                  <ActivityRow
                    key={driver.id}
                    icon={UserCheck}
                    tone="warning"
                    primary={d.users?.full_name || 'Sin nombre'}
                    secondary={d.users?.phone || 'Sin teléfono registrado'}
                    trailing={
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-ink-muted hover:text-ink">
                        Revisar <ArrowRight className="h-3 w-3" />
                      </span>
                    }
                    href={`/drivers/${driver.id}`}
                  />
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Activity feed + automated actions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          eyebrow="Últimos seis"
          title="Viajes recientes"
          description="Las solicitudes más recientes, en cualquier estado."
          action={{ label: 'Ver todos', href: '/rides' }}
        >
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <div className="h-9 w-9 animate-pulse rounded-xl bg-surface-sunken" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-56 animate-pulse rounded bg-surface-sunken" />
                    <div className="h-2.5 w-40 animate-pulse rounded bg-surface-sunken" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentRides.length === 0 ? (
            <EmptyState
              icon={MapPin}
              tone="default"
              title="Cuba duerme tranquila"
              body="Aún no hay viajes hoy. Cuando lleguen, los verás acá en tiempo real."
            />
          ) : (
            <div className="divide-y divide-line">
              {recentRides.map((ride) => {
                const meta = STATUS_META[ride.status] ?? { label: ride.status, tone: 'default' as const };
                return (
                  <ActivityRow
                    key={ride.id}
                    icon={MapPin}
                    tone={meta.tone}
                    primary={
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{truncate(ride.pickup_address, 28)}</span>
                        <ArrowRight className="h-3 w-3 flex-shrink-0 text-ink-subtle" />
                        <span className="truncate text-ink-muted">{truncate(ride.dropoff_address, 28)}</span>
                      </span>
                    }
                    secondary={
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px]">{ride.id.slice(0, 8)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{relativeTime(ride.created_at)}</span>
                      </span>
                    }
                    trailing={
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${toneBadge(meta.tone)}`}>
                        {meta.label}
                      </span>
                    }
                    href={`/rides/${ride.id}`}
                  />
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Automatismos"
          title="Acciones del sistema"
          description="Lo que el motor decidió sin intervención humana."
          action={{ label: 'Auditoría', href: '/audit' }}
        >
          {autoActions.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              tone="info"
              title="Motor en reposo"
              body="No hay acciones automatizadas recientes. Todo se está manejando a mano."
            />
          ) : (
            <div className="divide-y divide-line">
              {autoActions.map((action) => (
                <ActivityRow
                  key={action.id}
                  icon={Bot}
                  tone="info"
                  primary={action.action.replace(/_/g, ' ')}
                  secondary={
                    action.target_id ? (
                      <span className="font-mono text-[10px]">{action.target_id.slice(0, 10)}…</span>
                    ) : (
                      'Sin objetivo'
                    )
                  }
                  trailing={relativeTime(action.created_at)}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function toneBadge(tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info') {
  switch (tone) {
    case 'primary':
      return 'bg-primary-500/10 text-primary-600 dark:text-primary-400';
    case 'success':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'warning':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'danger':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    case 'info':
      return 'bg-sky-500/10 text-sky-600 dark:text-sky-400';
    default:
      return 'bg-surface-sunken text-ink-muted';
  }
}

function EmptyState({
  icon: Icon,
  tone,
  title,
  body,
}: {
  icon: typeof Gauge;
  tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  title: string;
  body: string;
}) {
  const bg =
    tone === 'success'
      ? 'bg-emerald-500/10 text-emerald-500'
      : tone === 'danger'
        ? 'bg-red-500/10 text-red-500'
        : tone === 'warning'
          ? 'bg-amber-500/10 text-amber-500'
          : tone === 'info'
            ? 'bg-sky-500/10 text-sky-500'
            : tone === 'primary'
              ? 'bg-primary-500/10 text-primary-500'
              : 'bg-surface-sunken text-ink-muted';
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${bg}`}>
        <Icon className="h-5 w-5" strokeWidth={1.8} />
      </span>
      <div>
        <p className="font-display text-[14px] font-semibold text-ink">{title}</p>
        <p className="mt-1 max-w-[28ch] text-[12px] text-ink-muted">{body}</p>
      </div>
    </div>
  );
}
