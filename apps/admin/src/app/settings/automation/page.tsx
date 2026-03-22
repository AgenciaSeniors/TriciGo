'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';

type ConfigEntry = { key: string; value: string };

interface AutomationRule {
  enabledKey: string;
  thresholdKey: string;
  titleKey: string;
  descKey: string;
  thresholdLabel: string;
}

const RULES: AutomationRule[] = [
  {
    enabledKey: 'auto_approve_drivers_enabled',
    thresholdKey: 'auto_approve_drivers_face_threshold',
    titleKey: 'automation.driver_approval',
    descKey: 'automation.driver_approval_desc',
    thresholdLabel: 'automation.face_threshold',
  },
  {
    enabledKey: 'auto_approve_redemptions_enabled',
    thresholdKey: 'auto_approve_redemptions_max_trc',
    titleKey: 'automation.redemption_approval',
    descKey: 'automation.redemption_approval_desc',
    thresholdLabel: 'automation.max_amount',
  },
  {
    enabledKey: 'auto_resolve_fraud_enabled',
    thresholdKey: 'auto_resolve_fraud_hours',
    titleKey: 'automation.fraud_resolve',
    descKey: 'automation.fraud_resolve_desc',
    thresholdLabel: 'automation.hours',
  },
  {
    enabledKey: 'auto_close_incidents_enabled',
    thresholdKey: 'auto_close_incidents_hours',
    titleKey: 'automation.incident_close',
    descKey: 'automation.incident_close_desc',
    thresholdLabel: 'automation.hours',
  },
];

export default function AutomationPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getPlatformConfig();
        if (!cancelled) {
          const vals: Record<string, string> = {};
          data.forEach((c: ConfigEntry) => {
            try {
              vals[c.key] = JSON.parse(c.value);
            } catch {
              vals[c.key] = c.value;
            }
          });
          setConfigs(vals);
        }
      } catch (err) {
        // Error handled by UI
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  async function saveConfig(key: string, value: string) {
    setSavingKey(key);
    setSavedKey(null);
    try {
      await adminService.updatePlatformConfig(key, JSON.stringify(value));
      setConfigs((prev) => ({ ...prev, [key]: value }));
      setSavedKey(key);
      showToast('success', t('automation.saved'));
      setTimeout(() => setSavedKey(null), 3000);
    } catch (err) {
      // Error handled by UI
    } finally {
      setSavingKey(null);
    }
  }

  function toggleEnabled(key: string) {
    const current = configs[key] === 'true';
    saveConfig(key, current ? 'false' : 'true');
  }

  function handleThresholdChange(key: string, value: string) {
    setConfigs((prev) => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return (
      <div>
        <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
          &larr; {t('settings.back_to_settings')}
        </Link>
        <p className="text-neutral-400">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div>
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">{t('automation.title')}</h1>
      <p className="text-neutral-500 mb-6">{t('automation.subtitle')}</p>

      <div className="space-y-4">
        {RULES.map((rule) => {
          const enabled = configs[rule.enabledKey] === 'true';
          const thresholdVal = configs[rule.thresholdKey] ?? '';

          return (
            <div
              key={rule.enabledKey}
              className={`rounded-xl p-6 shadow-sm border transition-colors ${
                enabled
                  ? 'bg-green-50 border-green-200'
                  : 'bg-white border-neutral-100'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h3 className="font-bold text-lg text-neutral-900">
                    {t(rule.titleKey)}
                  </h3>
                  <p className="text-sm text-neutral-500 mt-1">
                    {t(rule.descKey)}
                  </p>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => toggleEnabled(rule.enabledKey)}
                  disabled={savingKey === rule.enabledKey}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t(rule.titleKey)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    enabled ? 'bg-green-500' : 'bg-neutral-300'
                  } ${savingKey === rule.enabledKey ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform ${
                      enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Threshold setting */}
              <div className="mt-4 flex items-center gap-3">
                <label className="text-sm text-neutral-600">
                  {t(rule.thresholdLabel)}:
                </label>
                <input
                  type="number"
                  aria-label={t(rule.thresholdLabel)}
                  className="w-24 px-3 py-1.5 border border-neutral-300 rounded-lg text-sm font-mono text-right"
                  value={thresholdVal}
                  onChange={(e) => handleThresholdChange(rule.thresholdKey, e.target.value)}
                />
                <button
                  onClick={() => saveConfig(rule.thresholdKey, thresholdVal)}
                  disabled={savingKey === rule.thresholdKey}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
                >
                  {savingKey === rule.thresholdKey ? t('automation.saving') : t('common.save')}
                </button>
                {savedKey === rule.thresholdKey && (
                  <span className="text-xs text-green-600">{t('automation.saved')}</span>
                )}
              </div>

              {/* Status indicator */}
              <div className="mt-3">
                <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                  enabled ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-green-500' : 'bg-neutral-400'}`} />
                  {enabled ? t('automation.enabled') : t('automation.disabled')}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
