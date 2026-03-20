'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';

interface ZoneRow {
  id: string;
  name: string;
  surge_multiplier: number;
}

interface SurgeStatus {
  zone_id: string;
  zone_name: string;
  multiplier: number;
}

interface LiveMetrics {
  searching_rides: number;
  in_progress_rides: number;
  online_drivers: number;
}

interface WeatherStatus {
  condition: string;
  description: string;
  temp: number;
  multiplier: number;
  lastCheck: string | null;
  surgeActive: boolean;
}

// Center coords for each known zone (approximate Havana locations)
const ZONE_CENTERS: Record<string, { lat: number; lng: number }> = {
  Vedado: { lat: 23.13, lng: -82.40 },
  'Centro Habana': { lat: 23.14, lng: -82.365 },
  'Habana Vieja': { lat: 23.1425, lng: -82.35 },
  Miramar: { lat: 23.115, lng: -82.425 },
};

function getSurgeColor(multiplier: number): string {
  if (multiplier <= 1.0) return 'bg-green-100 text-green-700 border-green-200';
  if (multiplier <= 1.3) return 'bg-yellow-100 text-yellow-700 border-yellow-200';
  if (multiplier <= 1.8) return 'bg-orange-100 text-orange-700 border-orange-200';
  return 'bg-red-100 text-red-700 border-red-200';
}

function getSurgeDot(multiplier: number): string {
  if (multiplier <= 1.0) return 'bg-green-500';
  if (multiplier <= 1.3) return 'bg-yellow-500';
  if (multiplier <= 1.8) return 'bg-orange-500';
  return 'bg-red-500';
}

export default function SurgeDashboardPage() {
  const { t } = useTranslation('admin');
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [surgeStatus, setSurgeStatus] = useState<SurgeStatus[]>([]);
  const [metrics, setMetrics] = useState<LiveMetrics>({ searching_rides: 0, in_progress_rides: 0, online_drivers: 0 });
  const [weather, setWeather] = useState<WeatherStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [zonesData, metricsData, weatherData] = await Promise.all([
        adminService.getZones(),
        adminService.getLiveMetrics(),
        adminService.getWeatherStatus().catch(() => null),
      ]);

      setWeather(weatherData);

      setZones(zonesData as ZoneRow[]);
      setMetrics(metricsData);

      // Get surge for each zone
      const zoneParams = zonesData.map((z: ZoneRow) => {
        const center = ZONE_CENTERS[z.name] ?? { lat: 23.13, lng: -82.38 };
        return { id: z.id, lat: center.lat, lng: center.lng };
      });

      const surgeData = await adminService.getSurgeStatusForZones(zoneParams);
      // Map zone names
      const zoneNameMap = new Map(zonesData.map((z: ZoneRow) => [z.id, z.name]));
      setSurgeStatus(
        surgeData.map((s) => ({ ...s, zone_name: zoneNameMap.get(s.zone_id) ?? 'Unknown' })),
      );
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error refreshing surge data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  const demandRatio = metrics.online_drivers > 0
    ? (metrics.searching_rides / metrics.online_drivers).toFixed(2)
    : metrics.searching_rides > 0 ? '\u221E' : '0.00';

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('surge_dashboard.title')}</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-neutral-500">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            {t('surge_dashboard.auto_refresh')}
          </label>
          <button
            onClick={refresh}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            {loading ? t('surge_dashboard.refreshing') : '\u{21BB} Refresh'}
          </button>
        </div>
      </div>

      {lastUpdated && (
        <p className="text-xs text-neutral-400 mb-4">
          {t('surge_dashboard.last_updated')}: {lastUpdated.toLocaleTimeString()}
        </p>
      )}

      {/* Weather Status Card */}
      {weather && (
        <div className={`rounded-xl border-2 p-4 mb-6 ${
          weather.surgeActive
            ? 'bg-blue-50 border-blue-200'
            : 'bg-green-50 border-green-200'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">
                {weather.condition === 'clear' && '\u2600\uFE0F'}
                {weather.condition === 'clouds' && '\u2601\uFE0F'}
                {weather.condition === 'drizzle' && '\uD83C\uDF26\uFE0F'}
                {weather.condition === 'rain' && '\uD83C\uDF27\uFE0F'}
                {weather.condition === 'heavy_rain' && '\uD83C\uDF27\uFE0F'}
                {weather.condition === 'storm' && '\u26C8\uFE0F'}
                {weather.condition === 'extreme' && '\uD83C\uDF2A\uFE0F'}
                {!['clear', 'clouds', 'drizzle', 'rain', 'heavy_rain', 'storm', 'extreme'].includes(weather.condition) && '\uD83C\uDF24\uFE0F'}
              </span>
              <div>
                <h3 className="font-semibold text-neutral-800">{t('surge_dashboard.weather')}</h3>
                <p className="text-sm text-neutral-600 capitalize">{weather.description}</p>
                {weather.temp > 0 && (
                  <p className="text-xs text-neutral-400">{t('surge_dashboard.weather_temp')}: {weather.temp}°C</p>
                )}
              </div>
            </div>
            <div className="text-right">
              {weather.surgeActive ? (
                <div>
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-blue-100 text-blue-700">
                    {weather.multiplier.toFixed(1)}x
                  </span>
                  <p className="text-xs text-blue-600 mt-1">{t('surge_dashboard.weather_surge_active')}</p>
                </div>
              ) : (
                <div>
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-700">
                    1.0x
                  </span>
                  <p className="text-xs text-green-600 mt-1">{t('surge_dashboard.weather_surge_inactive')}</p>
                </div>
              )}
              {weather.lastCheck && (
                <p className="text-xs text-neutral-400 mt-1">
                  {t('surge_dashboard.weather_last_check')}: {new Date(weather.lastCheck).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Live Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">
          <div className="text-xs font-medium text-neutral-500 mb-1">{t('surge_dashboard.searching_rides')}</div>
          <div className="text-3xl font-bold text-neutral-800">{metrics.searching_rides}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">
          <div className="text-xs font-medium text-neutral-500 mb-1">{t('surge_dashboard.in_progress_rides')}</div>
          <div className="text-3xl font-bold text-neutral-800">{metrics.in_progress_rides}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">
          <div className="text-xs font-medium text-neutral-500 mb-1">{t('surge_dashboard.online_drivers')}</div>
          <div className="text-3xl font-bold text-neutral-800">{metrics.online_drivers}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">
          <div className="text-xs font-medium text-neutral-500 mb-1">{t('surge_dashboard.demand_ratio')}</div>
          <div className="text-3xl font-bold text-neutral-800">{demandRatio}</div>
          <div className="text-xs text-neutral-400 mt-1">
            {metrics.searching_rides} / {metrics.online_drivers}
          </div>
        </div>
      </div>

      {/* Zone Surge Status */}
      <h2 className="text-lg font-semibold mb-3">{t('surge_dashboard.zone_surge')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {loading && surgeStatus.length === 0 ? (
          <div className="col-span-full text-center text-neutral-400 py-8">{t('common.loading')}</div>
        ) : surgeStatus.length === 0 ? (
          <div className="col-span-full text-center text-neutral-400 py-8">{t('surge_dashboard.no_surge')}</div>
        ) : (
          surgeStatus.map((s) => (
            <div
              key={s.zone_id}
              className={`rounded-xl border-2 p-4 transition-all ${getSurgeColor(s.multiplier)}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm">{s.zone_name}</span>
                <span className={`w-3 h-3 rounded-full ${getSurgeDot(s.multiplier)}`} />
              </div>
              <div className="text-3xl font-bold">
                {s.multiplier.toFixed(1)}x
              </div>
              <div className="text-xs mt-1 opacity-70">
                {t('surge_dashboard.current_multiplier')}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Surge Zones (manual) link */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-neutral-700">{t('settings.surge_zones')}</h3>
            <p className="text-sm text-neutral-400">{t('settings.surge_zones_desc')}</p>
          </div>
          <Link
            href="/settings/surge-zones"
            className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors"
          >
            {t('common.view')} &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
