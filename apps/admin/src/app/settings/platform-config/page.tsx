'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { notificationService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import { useIsSuperAdmin } from '@/hooks/useIsSuperAdmin';

type ConfigEntry = { key: string; value: string };

/** Well-known config keys with input type + help text key */
type KnownKey = {
  type: 'number' | 'text' | 'select';
  helpKey: string;
  options?: { label: string; value: string }[];
};
const KNOWN_KEYS: Record<string, KnownKey> = {
  // ── Lugares aliados (00531) ──
  partner_places_discovery_radius_m: {
    type: 'number',
    helpKey: 'platform_config.partner_places_discovery_radius_m_help',
  },
  // The one security-relevant number in the feature. It governs the budget on
  // the public validation endpoints, so it lives here rather than as a literal
  // in SQL — during an incident it has to be tightenable without shipping a
  // migration and waiting for a human to apply it.
  coupon_validate_max_per_window: {
    type: 'number',
    helpKey: 'platform_config.coupon_validate_max_per_window_help',
  },
  coupon_validate_window_s: {
    type: 'number',
    helpKey: 'platform_config.coupon_validate_window_s_help',
  },
  // ── Payment provider registry ── (which provider /recargar + web /wallet use)
  active_payment_provider: {
    type: 'select',
    helpKey: 'platform_config.active_payment_provider_help',
    options: [
      { label: 'NETOPIA', value: 'netopia' },
      { label: 'Stripe', value: 'stripe' },
    ],
  },
  // ── NETOPIA Payments (post 2026-05-20 cutover) ──
  netopia_enabled: { type: 'text', helpKey: 'platform_config.netopia_enabled_help' },
  netopia_environment: { type: 'text', helpKey: 'platform_config.netopia_environment_help' },
  netopia_sandbox_signature: { type: 'text', helpKey: 'platform_config.netopia_sandbox_signature_help' },
  netopia_live_signature: { type: 'text', helpKey: 'platform_config.netopia_live_signature_help' },
  netopia_min_recharge_cup: { type: 'number', helpKey: 'platform_config.netopia_min_recharge_cup_help' },
  netopia_max_recharge_cup: { type: 'number', helpKey: 'platform_config.netopia_max_recharge_cup_help' },
  netopia_fee_usd: { type: 'number', helpKey: 'platform_config.netopia_fee_usd_help' },
  netopia_fee_type: { type: 'text', helpKey: 'platform_config.netopia_fee_type_help' },
  netopia_proxy_alert_after_s: { type: 'number', helpKey: 'platform_config.netopia_proxy_alert_after_s_help' },
  // ── Stripe legacy (kept as a row but no longer used) ──
  stripe_enabled: { type: 'text', helpKey: 'platform_config.stripe_enabled_help' },
  // ── Other ──
  cash_enabled: { type: 'text', helpKey: 'platform_config.cash_enabled_help' },
  wallet_enabled: { type: 'text', helpKey: 'platform_config.wallet_enabled_help' },
  // ── Operations notifications ──
  business_notification_email: { type: 'text', helpKey: 'platform_config.business_notification_email_help' },
  // ── Platform config ──
  max_driver_rate_multiplier: { type: 'number', helpKey: 'platform_config.max_driver_rate_multiplier_help' },
  default_per_km_rate_cup: { type: 'number', helpKey: 'platform_config.default_per_km_rate_cup_help' },
  commission_rate: { type: 'number', helpKey: 'platform_config.commission_rate_help' },
  exchange_rate_fallback_cup: { type: 'number', helpKey: 'platform_config.exchange_rate_fallback_cup_help' },
  quota_deduction_rate: { type: 'number', helpKey: 'platform_config.quota_deduction_rate_help' },
  quota_warning_threshold_pct: { type: 'number', helpKey: 'platform_config.quota_warning_threshold_pct_help' },
  quota_grace_trips: { type: 'number', helpKey: 'platform_config.quota_grace_trips_help' },
  openweather_api_key: { type: 'text', helpKey: 'platform_config.openweather_api_key_help' },
  weather_surge_enabled: { type: 'text', helpKey: 'platform_config.weather_surge_enabled_help' },
  weather_surge_multiplier: { type: 'number', helpKey: 'platform_config.weather_surge_multiplier_help' },
  weather_cold_threshold_c: { type: 'number', helpKey: 'platform_config.weather_cold_threshold_c_help' },
  weather_cold_multiplier: { type: 'number', helpKey: 'platform_config.weather_cold_multiplier_help' },
  // ── Stuck-ride watchdog (00538, Paso 4 incidente b428022b) ──
  stuck_ride_watchdog_enabled: { type: 'text', helpKey: 'platform_config.stuck_ride_watchdog_enabled_help' },
  stuck_ride_alert_email: { type: 'text', helpKey: 'platform_config.stuck_ride_alert_email_help' },
  stuck_ride_stationary_min_s: { type: 'number', helpKey: 'platform_config.stuck_ride_stationary_min_s_help' },
  stuck_ride_stationary_radius_m: { type: 'number', helpKey: 'platform_config.stuck_ride_stationary_radius_m_help' },
  stuck_ride_chat_window_s: { type: 'number', helpKey: 'platform_config.stuck_ride_chat_window_s_help' },

  // ── Shared ride (Compartir viaje) ──
  shared_ride_discount_per_seat_pct: { type: 'number', helpKey: 'platform_config.shared_ride_discount_per_seat_pct_help' },

  // ── Loyalty tiers (min completed trips per level; rider + driver combined) ──
  tier_plata_min_trips: { type: 'number', helpKey: 'platform_config.tier_plata_min_trips_help' },
  tier_oro_min_trips: { type: 'number', helpKey: 'platform_config.tier_oro_min_trips_help' },
  tier_platino_min_trips: { type: 'number', helpKey: 'platform_config.tier_platino_min_trips_help' },
  tier_diamante_min_trips: { type: 'number', helpKey: 'platform_config.tier_diamante_min_trips_help' },

  // ── App update prompt (latest published store version per app) ──
  client_latest_version: { type: 'text', helpKey: 'platform_config.client_latest_version_help' },
  driver_latest_version: { type: 'text', helpKey: 'platform_config.driver_latest_version_help' },

  // ── Routing experiment (Google Directions vs Mapbox; OFF by default) ──
  routing_google_enabled: { type: 'text', helpKey: 'platform_config.routing_google_enabled_help' },
  routing_google_daily_cap: { type: 'number', helpKey: 'platform_config.routing_google_daily_cap_help' },

  // ── Referral program (Referidos) ──
  referral_bonus_cup: { type: 'number', helpKey: 'platform_config.referral_bonus_cup_help' },
  referral_welcome_bonus_cup: { type: 'number', helpKey: 'platform_config.referral_welcome_bonus_cup_help' },
  referral_bonus_driver_cup: { type: 'number', helpKey: 'platform_config.referral_bonus_driver_cup_help' },
  referral_welcome_bonus_driver_cup: { type: 'number', helpKey: 'platform_config.referral_welcome_bonus_driver_cup_help' },

  // ── Cancellation reputation (Castigo por cancelar, migs 00372-00374) ──
  cancel_rating_value_second: { type: 'number', helpKey: 'platform_config.cancel_rating_value_second_help' },
  cancel_rating_value_third: { type: 'number', helpKey: 'platform_config.cancel_rating_value_third_help' },
  cancel_rating_event_window_days: { type: 'number', helpKey: 'platform_config.cancel_rating_event_window_days_help' },
  low_rating_rider_threshold: { type: 'number', helpKey: 'platform_config.low_rating_rider_threshold_help' },
  low_rating_rider_dispatch_limit: { type: 'number', helpKey: 'platform_config.low_rating_rider_dispatch_limit_help' },
  low_rating_rider_radius_m: { type: 'number', helpKey: 'platform_config.low_rating_rider_radius_m_help' },

  // ── Wait charge (cargo por espera; cap server-side, mig 00432 DSP-01) ──
  max_billable_wait_minutes: { type: 'number', helpKey: 'platform_config.max_billable_wait_minutes_help' },

  // ── Driver network expansion (00524) — dispatch reach & reactivation ──
  // Staged radius (00525): stage 1 is the head start for nearby drivers.
  dispatch_stage1_seconds: { type: 'number', helpKey: 'platform_config.dispatch_stage1_seconds_help' },
  dispatch_stage1_radius_m: { type: 'number', helpKey: 'platform_config.dispatch_stage1_radius_m_help' },
  dispatch_max_radius_m: { type: 'number', helpKey: 'platform_config.dispatch_max_radius_m_help' },
  dispatch_offer_limit: { type: 'number', helpKey: 'platform_config.dispatch_offer_limit_help' },
  dispatch_heartbeat_window_s: { type: 'number', helpKey: 'platform_config.dispatch_heartbeat_window_s_help' },
  reoffer_cooldown_s: { type: 'number', helpKey: 'platform_config.reoffer_cooldown_s_help' },
  searching_abandon_seconds: { type: 'number', helpKey: 'platform_config.searching_abandon_seconds_help' },
  reactivation_push_after_s: { type: 'number', helpKey: 'platform_config.reactivation_push_after_s_help' },
  reactivation_push_cooldown_s: { type: 'number', helpKey: 'platform_config.reactivation_push_cooldown_s_help' },
  reactivation_push_enabled: { type: 'text', helpKey: 'platform_config.reactivation_push_enabled_help' },

  // ── Auto-offline por inactividad (00527) ──
  driver_offline_after_minutes: { type: 'number', helpKey: 'platform_config.driver_offline_after_minutes_help' },
  driver_offline_notice_enabled: { type: 'text', helpKey: 'platform_config.driver_offline_notice_enabled_help' },

  // ── Comunidad de conductores (grupo de WhatsApp) ──
  // Invite link (https://chat.whatsapp.com/<code>). Empty = the join UI
  // stays hidden in the driver app. Editable only by super_admin.
  driver_whatsapp_group_url: { type: 'text', helpKey: 'platform_config.driver_whatsapp_group_url_help' },
};

export default function PlatformConfigPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  // ADM-002: writes to platform_config now require super_admin tier
  // (mig 00292 split the pc_admin policy into super_admin write +
  // admin read). UI mirrors the policy so non-super-admins see the
  // values but can't try to save.
  const { isSuperAdmin, loading: superAdminLoading } = useIsSuperAdmin();
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [invitingDrivers, setInvitingDrivers] = useState(false);

  // Current WhatsApp group invite link (saved value, not the in-progress
  // edit). Strip any jsonb quoting defensively.
  const whatsappGroupUrl = (
    configs.find((c) => c.key === 'driver_whatsapp_group_url')?.value ?? ''
  ).replace(/^"|"$/g, '').trim();

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
        // Error handled by UI
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
      showToast('success', t('platform_config.saved'));
      setTimeout(() => setSavedKey(null), 3000);
    } catch {
      setErrorKey(key);
    } finally {
      setSavingKey(null);
    }
  }

  async function handleInviteDrivers() {
    if (!isSuperAdmin || !whatsappGroupUrl || invitingDrivers) return;
    const confirmed = window.confirm(
      t('platform_config.whatsapp_invite_confirm', {
        defaultValue:
          'Se enviará una notificación push a todos los conductores aprobados invitándolos al grupo de WhatsApp. ¿Continuar?',
      }),
    );
    if (!confirmed) return;

    setInvitingDrivers(true);
    try {
      const userIds = await adminService.getApprovedDriverUserIds();
      if (userIds.length === 0) {
        showToast('warning', t('platform_config.whatsapp_invite_none', {
          defaultValue: 'No hay conductores aprobados para invitar.',
        }));
        return;
      }
      const res = await notificationService.sendCampaignPush(userIds, {
        title: t('platform_config.whatsapp_invite_push_title', {
          defaultValue: 'Grupo de WhatsApp de conductores',
        }),
        body: t('platform_config.whatsapp_invite_push_body', {
          defaultValue:
            'Únete al grupo oficial de conductores de TriciGo. Abre la app para entrar.',
        }),
      });
      showToast('success', t('platform_config.whatsapp_invite_sent', {
        count: res.sent,
        defaultValue: `Invitación enviada a ${res.sent} conductor(es).`,
      }));
    } catch {
      showToast('error', t('platform_config.whatsapp_invite_error', {
        defaultValue: 'No se pudo enviar la invitación.',
      }));
    } finally {
      setInvitingDrivers(false);
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
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">{t('platform_config.title')}</h1>
      <p className="text-ink-muted mb-6">{t('platform_config.subtitle')}</p>

      {!superAdminLoading && !isSuperAdmin && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 mb-6 text-sm" role="status">
          {t('platform_config.requires_super_admin', {
            defaultValue:
              'Solo super_admin puede modificar esta configuración. Tu cuenta puede consultar los valores actuales pero no guardarlos.',
          })}
        </div>
      )}

      {!loading && (
        <div className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line mb-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700" aria-hidden="true">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.8 14.16c-.24.68-1.4 1.3-1.94 1.35-.5.05-1.13.07-1.82-.11a15.6 15.6 0 0 1-1.65-.61c-2.9-1.25-4.8-4.17-4.94-4.36-.15-.19-1.19-1.58-1.19-3.02 0-1.43.75-2.13 1.02-2.42.27-.29.58-.36.78-.36l.56.01c.18.01.42-.07.66.5.24.58.82 2.01.9 2.16.07.15.12.32.02.51-.1.19-.15.31-.29.48-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.76 1.25 1.63 2.02 1.12.99 2.06 1.3 2.35 1.45.29.15.46.12.63-.07.17-.19.72-.84.91-1.13.19-.29.39-.24.66-.15.27.1 1.7.8 1.99.95.29.15.48.22.55.34.07.12.07.68-.17 1.36Z"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-ink">
                {t('platform_config.whatsapp_invite_title', { defaultValue: 'Grupo de WhatsApp de conductores' })}
              </p>
              <p className="text-sm text-ink-muted mt-1">
                {whatsappGroupUrl
                  ? t('platform_config.whatsapp_invite_help', {
                      defaultValue: 'Invita por notificación push a todos los conductores aprobados a unirse al grupo.',
                    })
                  : t('platform_config.whatsapp_invite_no_url', {
                      defaultValue: 'Configura primero el enlace del grupo (driver_whatsapp_group_url, abajo) para poder invitar.',
                    })}
              </p>
              {whatsappGroupUrl && (
                <a href={whatsappGroupUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary-500 hover:underline mt-1 inline-block break-all">
                  {whatsappGroupUrl}
                </a>
              )}
            </div>
            <button
              onClick={handleInviteDrivers}
              disabled={!isSuperAdmin || !whatsappGroupUrl || invitingDrivers}
              title={!isSuperAdmin ? t('platform_config.requires_super_admin', { defaultValue: 'Solo super_admin puede invitar' }) : undefined}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
            >
              {invitingDrivers
                ? t('platform_config.whatsapp_invite_sending', { defaultValue: 'Enviando…' })
                : t('platform_config.whatsapp_invite_button', { defaultValue: 'Invitar a conductores aprobados' })}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-ink-subtle">{t('common.loading')}</p>
      ) : configs.length === 0 ? (
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line p-8 text-center">
          <p className="text-ink-subtle">No configuration entries found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {configs.map((config) => {
            const known = KNOWN_KEYS[config.key];
            const isEdited = editValues[config.key] !== config.value;

            return (
              <div
                key={config.key}
                className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="font-semibold text-ink">
                      {getLabel(config.key)}
                    </p>
                    <p className="font-mono text-xs text-ink-subtle mt-0.5">
                      {config.key}
                    </p>
                    {known && (
                      <p className="text-sm text-ink-muted mt-1">
                        {t(known.helpKey)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {known?.type === 'select' && known.options ? (
                      <select
                        aria-label={getLabel(config.key)}
                        className="w-32 px-3 py-2 border border-line bg-surface text-ink rounded-lg text-sm"
                        value={String(editValues[config.key] ?? config.value ?? '').replace(/^"|"$/g, '')}
                        onChange={(e) =>
                          setEditValues((prev) => ({ ...prev, [config.key]: e.target.value }))
                        }
                      >
                        {known.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={known?.type ?? 'text'}
                        step={known?.type === 'number' ? 'any' : undefined}
                        aria-label={getLabel(config.key)}
                        className="w-32 px-3 py-2 border border-line bg-surface text-ink rounded-lg text-sm text-right font-mono"
                        value={editValues[config.key] ?? config.value}
                        onChange={(e) =>
                          setEditValues((prev) => ({
                            ...prev,
                            [config.key]: e.target.value,
                          }))
                        }
                      />
                    )}
                    <button
                      onClick={() => handleSave(config.key)}
                      disabled={!isEdited || savingKey === config.key || !isSuperAdmin}
                      title={!isSuperAdmin ? t('platform_config.requires_super_admin', { defaultValue: 'Solo super_admin puede guardar' }) : undefined}
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
