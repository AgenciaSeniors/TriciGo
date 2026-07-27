'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { useIsSuperAdmin } from '@/hooks/useIsSuperAdmin';

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

/**
 * Is this automation rule on?
 *
 * Deliberately accepts BOTH the boolean and the string, mirroring
 * `supabase/functions/auto-admin/index.ts:37` — the code that actually
 * decides whether the rule fires. These keys are seeded as jsonb strings
 * (`'"false"'`, migration 00061) but written back as raw strings and read
 * through `JSON.parse`, so the same key can legitimately arrive here as
 * `true` or `'true'` depending on how it was last written.
 *
 * The screen previously compared `configs[key] === 'true'` against the
 * PARSED value, which is a boolean — so a rule that was ON rendered as OFF,
 * and the toggle recomputed the same wrong value and re-wrote 'true',
 * making it impossible to switch a rule off from a freshly loaded page
 * while toasting "Guardado". The server disagreed and kept running it.
 */
function isOn(value: unknown): boolean {
  return value === true || value === 'true';
}

export default function AutomationPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  // ADM-002: platform_config writes are super_admin-only (mig 00292).
  // Mirror the RLS in the UI so regular admins don't get silent no-ops.
  const { isSuperAdmin, loading: superAdminLoading } = useIsSuperAdmin();
  // `unknown`, not `string`: the loader below runs `JSON.parse` on each
  // value, so a jsonb string like "true" arrives here as a BOOLEAN. Typing
  // this as `Record<string, string>` was the lie that let `=== 'true'`
  // compile while never being true.
  const [configs, setConfigs] = useState<Record<string, unknown>>({});
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
        if (!cancelled) showToast('error', getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveConfig(key: string, value: string) {
    setSavingKey(key);
    setSavedKey(null);
    try {
      // Raw value (no JSON.stringify): matches how these keys are stored in
      // prod and how platform-config/page.tsx writes them.
      await adminService.updatePlatformConfig(key, value);
      setConfigs((prev) => ({ ...prev, [key]: value }));
      setSavedKey(key);
      showToast('success', t('automation.saved'));
      setTimeout(() => setSavedKey(null), 3000);
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSavingKey(null);
    }
  }

  function toggleEnabled(key: string) {
    const current = isOn(configs[key]);
    saveConfig(key, current ? 'false' : 'true');
  }

  function saveThreshold(key: string, value: string) {
    const num = Number(value.trim());
    if (value.trim() === '' || !Number.isFinite(num) || num <= 0) {
      showToast('error', t('automation.threshold_invalid', { defaultValue: 'El valor debe ser un número mayor que 0' }));
      return;
    }
    saveConfig(key, String(num));
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
        <p className="text-ink-subtle">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div>
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">{t('automation.title')}</h1>
      <p className="text-ink-muted mb-6">{t('automation.subtitle')}</p>

      {!superAdminLoading && !isSuperAdmin && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 mb-6 text-sm" role="status">
          {t('platform_config.requires_super_admin', {
            defaultValue:
              'Solo super_admin puede modificar esta configuración. Tu cuenta puede consultar los valores actuales pero no guardarlos.',
          })}
        </div>
      )}

      <div className="space-y-4">
        {RULES.map((rule) => {
          const enabled = isOn(configs[rule.enabledKey]);
          const thresholdVal = String(configs[rule.thresholdKey] ?? '');

          return (
            <div
              key={rule.enabledKey}
              className={`rounded-xl p-6 shadow-sm border transition-colors ${
                enabled
                  ? 'bg-green-50 border-green-200'
                  : 'bg-surface-elevated border-line'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h3 className="font-bold text-lg text-ink">
                    {t(rule.titleKey)}
                  </h3>
                  <p className="text-sm text-ink-muted mt-1">
                    {t(rule.descKey)}
                  </p>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => toggleEnabled(rule.enabledKey)}
                  disabled={savingKey === rule.enabledKey || !isSuperAdmin}
                  title={!isSuperAdmin ? t('platform_config.requires_super_admin', { defaultValue: 'Solo super_admin puede guardar' }) : undefined}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t(rule.titleKey)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:cursor-not-allowed ${
                    enabled ? 'bg-green-500' : 'bg-line-strong'
                  } ${savingKey === rule.enabledKey || !isSuperAdmin ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 rounded-full bg-white dark:bg-neutral-100 shadow transform transition-transform ${
                      enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Threshold setting */}
              <div className="mt-4 flex items-center gap-3">
                <label className="text-sm text-ink-muted">
                  {t(rule.thresholdLabel)}:
                </label>
                <input
                  type="number"
                  aria-label={t(rule.thresholdLabel)}
                  className="w-24 px-3 py-1.5 border border-line bg-surface text-ink rounded-lg text-sm font-mono text-right"
                  value={thresholdVal}
                  onChange={(e) => handleThresholdChange(rule.thresholdKey, e.target.value)}
                />
                <button
                  onClick={() => saveThreshold(rule.thresholdKey, thresholdVal)}
                  disabled={savingKey === rule.thresholdKey || !isSuperAdmin}
                  title={!isSuperAdmin ? t('platform_config.requires_super_admin', { defaultValue: 'Solo super_admin puede guardar' }) : undefined}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
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
                  enabled ? 'bg-green-100 text-green-700' : 'bg-surface-sunken text-ink-muted'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-green-500' : 'bg-ink-subtle'}`} />
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
