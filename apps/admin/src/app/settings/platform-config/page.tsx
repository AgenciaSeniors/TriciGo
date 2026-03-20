'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';

type ConfigEntry = { key: string; value: string };

/** Well-known config keys with input type + help text key */
const KNOWN_KEYS: Record<string, { type: 'number' | 'text'; helpKey: string }> = {
  max_driver_rate_multiplier: { type: 'number', helpKey: 'platform_config.max_driver_rate_multiplier_help' },
  default_per_km_rate_cup: { type: 'number', helpKey: 'platform_config.default_per_km_rate_cup_help' },
  commission_rate: { type: 'number', helpKey: 'platform_config.commission_rate_help' },
  exchange_rate_fallback_cup: { type: 'number', helpKey: 'platform_config.exchange_rate_fallback_cup_help' },
  openweather_api_key: { type: 'text', helpKey: 'platform_config.openweather_api_key_help' },
  weather_surge_enabled: { type: 'text', helpKey: 'platform_config.weather_surge_enabled_help' },
};

export default function PlatformConfigPage() {
  const { t } = useTranslation('admin');
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getPlatformConfig();
        if (!cancelled) {
          setConfigs(data);
          const vals: Record<string, string> = {};
          data.forEach((c) => { vals[c.key] = c.value; });
          setEditValues(vals);
        }
      } catch (err) {
        console.error('Error fetching platform config:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  async function handleSave(key: string) {
    const value = editValues[key];
    if (value === undefined) return;

    setSavingKey(key);
    setSavedKey(null);
    setErrorKey(null);

    try {
      await adminService.updatePlatformConfig(key, value);
      setConfigs((prev) =>
        prev.map((c) => c.key === key ? { ...c, value } : c),
      );
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 3000);
    } catch {
      setErrorKey(key);
    } finally {
      setSavingKey(null);
    }
  }

  function getLabel(key: string): string {
    const translationKey = `platform_config.${key}`;
    const translated = t(translationKey);
    // If no translation found, return the key formatted nicely
    return translated !== translationKey ? translated : key.replace(/_/g, ' ');
  }

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">{t('platform_config.title')}</h1>
      <p className="text-neutral-500 mb-6">{t('platform_config.subtitle')}</p>

      {loading ? (
        <p className="text-neutral-400">{t('common.loading')}</p>
      ) : configs.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-8 text-center">
          <p className="text-neutral-400">No configuration entries found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {configs.map((config) => {
            const known = KNOWN_KEYS[config.key];
            const isEdited = editValues[config.key] !== config.value;

            return (
              <div
                key={config.key}
                className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="font-semibold text-neutral-900">
                      {getLabel(config.key)}
                    </p>
                    <p className="font-mono text-xs text-neutral-400 mt-0.5">
                      {config.key}
                    </p>
                    {known && (
                      <p className="text-sm text-neutral-500 mt-1">
                        {t(known.helpKey)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type={known?.type ?? 'text'}
                      step={known?.type === 'number' ? 'any' : undefined}
                      className="w-32 px-3 py-2 border border-neutral-300 rounded-lg text-sm text-right font-mono"
                      value={editValues[config.key] ?? config.value}
                      onChange={(e) =>
                        setEditValues((prev) => ({
                          ...prev,
                          [config.key]: e.target.value,
                        }))
                      }
                    />
                    <button
                      onClick={() => handleSave(config.key)}
                      disabled={!isEdited || savingKey === config.key}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {savingKey === config.key
                        ? t('platform_config.saving')
                        : t('platform_config.save')}
                    </button>
                  </div>
                </div>

                {savedKey === config.key && (
                  <p className="text-sm text-green-600 mt-2 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {t('platform_config.saved')}
                  </p>
                )}
                {errorKey === config.key && (
                  <p className="text-sm text-red-600 mt-2">
                    {t('platform_config.error_saving')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
