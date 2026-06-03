'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import { useIsSuperAdmin } from '@/hooks/useIsSuperAdmin';

interface WeatherStatus {
  condition: string;
  description: string;
  temp: number;
  multiplier: number;
  lastCheck: string | null;
  surgeActive: boolean;
}

const CONDITION_EMOJI: Record<string, string> = {
  clear: '☀️',
  clouds: '☁️',
  drizzle: '🌦️',
  rain: '🌧️',
  heavy_rain: '🌧️',
  storm: '⛈️',
  extreme: '🌪️',
  cold: '🥶',
  disabled: '🚫',
};

export default function WeatherPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { isSuperAdmin } = useIsSuperAdmin();
  const [weather, setWeather] = useState<WeatherStatus | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [w, configs] = await Promise.all([
        adminService.getWeatherStatus().catch(() => null),
        adminService.getPlatformConfig().catch(() => [] as { key: string; value: string }[]),
      ]);
      setWeather(w);
      const enabledRaw = configs.find((c) => c.key === 'weather_surge_enabled')?.value;
      setEnabled(!(enabledRaw != null && /false/i.test(String(enabledRaw))));
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  async function toggleEnabled() {
    setSaving(true);
    try {
      await adminService.updatePlatformConfig('weather_surge_enabled', String(!enabled));
      setEnabled(!enabled);
      showToast('success', t('platform_config.saved', { defaultValue: 'Guardado' }));
      await refresh();
    } catch {
      showToast('error', t('platform_config.error_saving', { defaultValue: 'Error al guardar' }));
    } finally {
      setSaving(false);
    }
  }

  const emoji = weather ? (CONDITION_EMOJI[weather.condition] ?? '🌤️') : '🌤️';
  const active = (weather?.multiplier ?? 1) > 1;

  return (
    <div>
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold">{t('weather.title', { defaultValue: 'Clima — tarifa por mal tiempo' })}</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="rounded" />
            {t('weather.auto_refresh', { defaultValue: 'Auto-actualizar' })}
          </label>
          <button
            onClick={refresh}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            {loading ? t('weather.refreshing', { defaultValue: 'Actualizando...' }) : '↻'}
          </button>
        </div>
      </div>
      <p className="text-sm text-ink-muted mb-6">
        {t('weather.subtitle', { defaultValue: 'El mal tiempo (lluvia, tormenta, ciclón, frío extremo) es el único factor que sube la tarifa. Se verifica con una API del tiempo cada 15 minutos y se aplica de forma global a toda la ciudad.' })}
      </p>

      {lastUpdated && (
        <p className="text-xs text-ink-subtle mb-4">
          {t('weather.last_updated', { defaultValue: 'Última actualización' })}: {lastUpdated.toLocaleTimeString()}
        </p>
      )}

      {/* Weather status card */}
      {weather && (
        <div className={`rounded-xl border-2 p-5 mb-6 ${active ? 'bg-blue-50 border-blue-200' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-4xl">{emoji}</span>
              <div>
                <h3 className="font-semibold text-ink">{t('weather.current', { defaultValue: 'Clima actual' })}</h3>
                <p className="text-sm text-ink-muted capitalize">{weather.description || '—'}</p>
                {weather.temp > 0 && (
                  <p className="text-xs text-ink-subtle">{t('weather.temp', { defaultValue: 'Temperatura' })}: {weather.temp}°C</p>
                )}
              </div>
            </div>
            <div className="text-right">
              <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold ${active ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                {(weather.multiplier ?? 1).toFixed(2)}x
              </span>
              <p className={`text-xs mt-1 ${active ? 'text-blue-600' : 'text-green-600'}`}>
                {active
                  ? t('weather.surge_active', { defaultValue: 'Recargo por mal tiempo activo' })
                  : t('weather.surge_inactive', { defaultValue: 'Sin recargo (tiempo normal)' })}
              </p>
              {weather.lastCheck && (
                <p className="text-xs text-ink-subtle mt-1">
                  {t('weather.last_check', { defaultValue: 'Último chequeo' })}: {new Date(weather.lastCheck).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Enable / disable */}
      <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-ink">{t('weather.enabled_title', { defaultValue: 'Recargo por mal tiempo' })}</h3>
            <p className="text-sm text-ink-subtle">
              {enabled
                ? t('weather.enabled_on', { defaultValue: 'Activado: la tarifa sube cuando el tiempo es malo.' })
                : t('weather.enabled_off', { defaultValue: 'Desactivado: la tarifa nunca sube por el tiempo.' })}
            </p>
          </div>
          <button
            onClick={toggleEnabled}
            disabled={saving || !isSuperAdmin}
            title={!isSuperAdmin ? t('platform_config.requires_super_admin', { defaultValue: 'Solo super_admin puede cambiar esto' }) : undefined}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              enabled ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-primary-500 text-white hover:bg-primary-600'
            }`}
          >
            {enabled
              ? t('weather.disable', { defaultValue: 'Desactivar' })
              : t('weather.enable', { defaultValue: 'Activar' })}
          </button>
        </div>
      </div>

      {/* Tuning note */}
      <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-4">
        <p className="text-sm text-ink-muted">
          {t('weather.tuning_note', { defaultValue: 'Los multiplicadores por condición y el umbral de frío extremo se ajustan en Configuración de plataforma (weather_cold_threshold_c, weather_cold_multiplier).' })}
        </p>
        <Link href="/settings/platform-config" className="mt-2 inline-block text-sm text-primary-500 hover:underline">
          {t('weather.go_to_config', { defaultValue: 'Ir a Configuración de plataforma' })} &rarr;
        </Link>
      </div>
    </div>
  );
}
