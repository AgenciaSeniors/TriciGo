'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { FeatureFlag } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { useIsSuperAdmin } from '@/hooks/useIsSuperAdmin';

export default function FeatureFlagsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  // ADM-002: feature flags include security-critical toggles
  // (KYC_ENABLED, RATE_LIMIT_ENABLED, etc). Mig 00292 requires
  // super_admin for INSERT/UPDATE/DELETE on this table.
  const { isSuperAdmin, loading: superAdminLoading } = useIsSuperAdmin();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getFeatureFlags();
        if (!cancelled) setFlags(data);
      } catch (err) {
        // Error handled by UI
        setError(err instanceof Error ? err.message : 'Error al cargar feature flags');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(flag: FeatureFlag) {
    if (!isSuperAdmin) {
      showToast('error', t('feature_flags.requires_super_admin', {
        defaultValue: 'Solo super_admin puede cambiar feature flags',
      }));
      return;
    }
    const newValue = !flag.value;
    setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, value: newValue } : f));
    try {
      await adminService.updateFeatureFlag(flag.id, { value: newValue });
    } catch (err) {
      // Error handled by UI
      setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, value: !newValue } : f));
    }
  }

  async function handleCreate() {
    if (!newKey.trim()) return;
    if (!isSuperAdmin) {
      showToast('error', t('feature_flags.requires_super_admin', {
        defaultValue: 'Solo super_admin puede crear feature flags',
      }));
      return;
    }
    setCreating(true);
    try {
      await adminService.createFeatureFlag({
        key: newKey.trim().toLowerCase().replace(/\s+/g, '_'),
        value: false,
        description: newDesc.trim(),
      });
      const data = await adminService.getFeatureFlags();
      setFlags(data);
      setNewKey('');
      setNewDesc('');
      setShowCreate(false);
    } catch (err) {
      // Error handled by UI
      showToast('error', 'Error al crear flag');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); }}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('feature_flags.title')}</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          disabled={!isSuperAdmin}
          title={!isSuperAdmin ? t('feature_flags.requires_super_admin', { defaultValue: 'Solo super_admin puede modificar feature flags' }) : undefined}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('feature_flags.add_flag')}
        </button>
      </div>

      {!superAdminLoading && !isSuperAdmin && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 mb-6 text-sm" role="status">
          {t('feature_flags.requires_super_admin', {
            defaultValue:
              'Solo super_admin puede modificar feature flags. Tu cuenta puede consultar los flags actuales pero no toggle ni crear nuevos.',
          })}
        </div>
      )}

      {showCreate && (
        <div className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line mb-6">
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-sm font-medium text-ink-muted mb-1">{t('feature_flags.label_key')}</label>
              <input
                className="w-full px-3 py-2 border border-line bg-surface text-ink rounded-lg text-sm"
                placeholder={t('feature_flags.key_placeholder')}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-ink-muted mb-1">{t('feature_flags.label_description')}</label>
              <input
                className="w-full px-3 py-2 border border-line bg-surface text-ink rounded-lg text-sm"
                placeholder={t('feature_flags.description_placeholder')}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating || !newKey.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {t('common.create')}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-sunken text-ink-muted hover:bg-neutral-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-ink-subtle">{t('common.loading')}</p>
      ) : flags.length === 0 ? (
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-8 text-center">
          <p className="text-ink-subtle">{t('feature_flags.no_flags')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {flags.map((flag) => (
            <div
              key={flag.id}
              className="bg-surface-elevated rounded-xl p-5 shadow-sm border border-line flex items-center justify-between"
            >
              <div>
                <p className="font-mono text-sm font-medium text-ink">{flag.key}</p>
                <p className="text-sm text-ink-muted mt-0.5">{flag.description || t('feature_flags.no_description')}</p>
              </div>
              <button
                onClick={() => handleToggle(flag)}
                role="switch"
                aria-checked={flag.value}
                aria-label={`Toggle ${flag.key}`}
                disabled={!isSuperAdmin}
                title={!isSuperAdmin ? t('feature_flags.requires_super_admin', { defaultValue: 'Solo super_admin puede toggle' }) : undefined}
                className={`relative w-12 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  flag.value ? 'bg-primary-500' : 'bg-line-strong'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white dark:bg-neutral-100 rounded-full shadow transition-transform ${
                    flag.value ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
