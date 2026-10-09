'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  getSupabaseClient,
  campaignService,
  AppError,
  type CampaignChannel,
  type CampaignSegment,
  type CampaignSendResult,
} from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { havanaLocalToUtcIso } from '@tricigo/utils/date';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { formatAdminDate } from '@/lib/formatDate';
import { usePanelRole } from '@/lib/panelRole';
import { useAdminUser } from '@/lib/useAdminUser';

type Campaign = {
  id: string;
  name: string;
  segment_type: string;
  segment_city_id: string | null;
  message_title: string;
  message_body: string;
  promo_code_id: string | null;
  channel: string;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  sent_count: number;
  created_by: string | null;
  created_at: string;
  // mig 00478 — null on rows created before the column existed (= customer).
  audience_role?: string | null;
  // mig 00649
  started_at?: string | null;
  recipient_count?: number;
  push_sent?: number;
  email_sent?: number;
  last_error?: string | null;
};

type Promotion = {
  id: string;
  code: string;
  type: string | null;
};

type City = { id: string; name: string; slug: string };

const SEGMENT_KEYS = ['new_users', 'power_users', 'inactive', 'all', 'by_city'] as const;
const CHANNEL_KEYS = ['push', 'email', 'both'] as const;
const AUDIENCE_KEYS = ['customer', 'driver'] as const;

const PAGE_SIZE = 20;

export default function CampaignsPage() {
  const { t } = useTranslation('admin');

  const segmentLabel = (v: string): string => {
    const fallbacks: Record<string, string> = {
      new_users: 'Recién llegados', power_users: 'Power users', inactive: 'Inactivos',
      all: 'Todos', by_city: 'Por ciudad',
    };
    return t(`campaigns.segment_${v}`, { defaultValue: fallbacks[v] ?? v });
  };
  const channelLabel = (v: string): string => {
    const fallbacks: Record<string, string> = { push: 'Push', email: 'Email', both: 'Ambos' };
    return t(`campaigns.channel_${v}`, { defaultValue: fallbacks[v] ?? v });
  };
  const audienceLabel = (v: string): string => {
    const fallbacks: Record<string, string> = { customer: 'Pasajeros', driver: 'Conductores' };
    return t(`campaigns.audience_${v}`, { defaultValue: fallbacks[v] ?? v });
  };
  const SEGMENT_OPTIONS = SEGMENT_KEYS.map((v) => ({ value: v, label: segmentLabel(v) }));
  const CHANNEL_OPTIONS = CHANNEL_KEYS.map((v) => ({ value: v, label: channelLabel(v) }));
  const AUDIENCE_OPTIONS = AUDIENCE_KEYS.map((v) => ({ value: v, label: audienceLabel(v) }));
  const { showToast } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const [formName, setFormName] = useState('');
  const [formAudience, setFormAudience] = useState<'customer' | 'driver'>('customer');
  const [formSegment, setFormSegment] = useState('new_users');
  const [formCityId, setFormCityId] = useState('');
  const [formChannel, setFormChannel] = useState('push');
  const [formTitle, setFormTitle] = useState('');
  const [formBody, setFormBody] = useState('');
  const [formPromoId, setFormPromoId] = useState('');
  const [formSchedule, setFormSchedule] = useState('');
  const [formSendNow, setFormSendNow] = useState(true);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [cities, setCities] = useState<City[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);

  const { role } = usePanelRole();
  const isAdminRole = role === 'admin' || role === 'super_admin';
  // From the cookie session, like the other admin pages: the shared @tricigo/api client may
  // not have its session synced yet when this page mounts.
  const { userId: myId } = useAdminUser();
  const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null);
  // Stable: the modal's effect depends on it, and re-running it (on every 30 s refresh) would
  // reset the modal's double-click guard and move the focus.
  const closeCancelDialog = useCallback(() => setCancelTarget(null), []);

  const loadCampaigns = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const supabase = getSupabaseClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error: dbError } = await supabase
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, to);
      if (dbError) throw dbError;
      setCampaigns((data ?? []) as Campaign[]);
    } catch (err) {
      if (!silent) {
        setCampaigns([]);
        setError(getErrorMessage(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  // A scheduled or sending campaign changes on the server: refresh the list every 30 s meanwhile.
  const hasPending = campaigns.some((c) => c.status === 'scheduled' || c.status === 'sending');
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void loadCampaigns(true), 30_000);
    return () => clearInterval(timer);
  }, [hasPending, loadCampaigns]);

  useEffect(() => {
    (async () => {
      try {
        const [citiesData, promoData] = await Promise.all([
          cityService.getAllCities(),
          (async () => {
            const supabase = getSupabaseClient();
            const { data } = await supabase
              .from('promotions')
              .select('id, code, type')
              .eq('is_active', true)
              .order('code');
            return (data ?? []) as Promotion[];
          })(),
        ]);
        setCities(citiesData);
        setPromotions(promoData);
      } catch {
        // best-effort
      }
    })();
  }, []);

  const sortedCampaigns = useMemo(() => {
    if (!sort) return campaigns;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof Campaign;
    return [...campaigns].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [campaigns, sort]);

  const validateForm = () => {
    const errors: Record<string, string> = {};
    const required = t('campaigns.required', { defaultValue: 'Requerido' });
    if (!formName.trim()) errors.name = required;
    if (!formTitle.trim()) errors.title = required;
    if (!formBody.trim()) errors.body = required;
    if (formSegment === 'by_city' && !formCityId) errors.city = t('campaigns.choose_city_error', { defaultValue: 'Elige una ciudad' });
    if (!formSendNow) {
      const scheduledAt = scheduleToUtcIso(formSchedule);
      if (!scheduledAt) {
        errors.schedule = t('campaigns.schedule_required', { defaultValue: 'Elige la fecha y la hora' });
      } else if (new Date(scheduledAt) <= new Date()) {
        errors.schedule = t('campaigns.future_error', { defaultValue: 'Tiene que ser en el futuro' });
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const resetForm = () => {
    setFormName('');
    setFormAudience('customer');
    setFormSegment('new_users');
    setFormCityId('');
    setFormChannel('push');
    setFormTitle('');
    setFormBody('');
    setFormPromoId('');
    setFormSchedule('');
    setFormSendNow(true);
    setFormErrors({});
  };

  // The warnings the old browser send showed, now from send-campaign's per-channel result.
  const warningsFor = (r: CampaignSendResult): string[] => {
    const w: string[] = [];
    // No channel result and 'failed': the recipients could not be read, or the send threw.
    // Not "the segment is empty", which is a 'sent' campaign with zero recipients.
    if (r.status === 'failed' && r.channels.length === 0) {
      w.push([t('campaigns.send_error', { defaultValue: 'No pudimos enviar la campaña.' }), r.last_error].filter(Boolean).join(' '));
      return w;
    }
    if (r.recipient_count === 0) {
      w.push(t('campaigns.warn_no_recipients', { defaultValue: 'El segmento no tiene usuarios; no se envió nada.' }));
      return w;
    }
    for (const ch of r.channels) {
      if (ch.channel === 'push' && !ch.ok) {
        w.push(t('campaigns.warn_push_failed', { defaultValue: 'Guardada, pero falló el envío de push: {{error}}', error: ch.error ?? '' }));
      } else if (ch.channel === 'push' && ch.sent === 0) {
        w.push(t('campaigns.warn_push_zero', { defaultValue: 'Guardada, pero el push no llegó a ningún dispositivo (sin tokens activos).' }));
      } else if (ch.channel === 'email' && !ch.ok) {
        w.push(t('campaigns.warn_email_failed', { defaultValue: 'Guardada, pero falló el envío de correo: {{error}}', error: ch.error ?? '' }));
      } else if (ch.channel === 'email' && ch.sent === 0) {
        w.push(t('campaigns.warn_email_zero_consent', { defaultValue: 'Guardada, pero el correo no se entregó: nadie del segmento tiene un correo válido y aceptó recibir novedades.' }));
      }
    }
    return w;
  };

  const handleSend = async () => {
    if (!validateForm()) return;
    setSending(true);
    try {
      // Throws on an unreadable value instead of falling back to "send now" (validateForm already
      // refused it).
      const scheduledAt = formSendNow ? null : havanaLocalToUtcIso(formSchedule);
      const id = await campaignService.create({
        name: formName,
        audienceRole: formAudience,
        segmentType: formSegment as CampaignSegment,
        segmentCityId: formSegment === 'by_city' ? formCityId : null,
        title: formTitle,
        body: formBody,
        promoCodeId: formPromoId || null,
        channel: formChannel as CampaignChannel,
        scheduledAt,
      });

      resetForm();
      setShowForm(false);
      setPage(0);

      if (scheduledAt) {
        await loadCampaigns();
        showToast('success', t('campaigns.toast_scheduled_at', {
          defaultValue: 'Campaña programada para el {{when}} (hora de Cuba)',
          when: formatAdminDate(scheduledAt),
        }));
        return;
      }

      try {
        const result = await campaignService.sendNow(id);
        const warnings = warningsFor(result);
        await loadCampaigns();
        if (warnings.length > 0) showToast(result.status === 'failed' ? 'error' : 'warning', warnings.join(' · '));
        else showToast('success', t('campaigns.toast_sent_n', { n: result.sent_count, defaultValue: 'Campaña enviada · {{n}} entregas' }));
      } catch (err) {
        // The row is saved and due now: if send-campaign did not take it, the cron job does
        // within a minute, and the list refreshes while it is pending.
        await loadCampaigns();
        if (err instanceof AppError && err.code === 'CAMPAIGN_NOT_CLAIMABLE') {
          showToast('warning', t('campaigns.toast_already_sending', { defaultValue: 'La campaña ya se está enviando. Revisa el estado en la lista.' }));
        } else {
          showToast('warning', t('campaigns.warn_send_failed', {
            defaultValue: 'Guardada, pero el envío no respondió: {{error}}. Revisa el estado en la lista.',
            error: getErrorMessage(err),
          }));
        }
      }
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async (c: Campaign) => {
    try {
      const outcome = await campaignService.cancel(c.id);
      if (outcome === 'cancelled') showToast('success', t('campaigns.toast_cancelled', { defaultValue: 'Campaña cancelada' }));
      else if (outcome === 'not_found') showToast('warning', t('campaigns.toast_cancel_gone', { defaultValue: 'Esa campaña ya no existe.' }));
      else showToast('warning', t('campaigns.toast_cancel_late', { defaultValue: 'Ya no se puede cancelar: el envío ya empezó o terminó.' }));
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      await loadCampaigns();
    }
  };

  const canCancel = (c: Campaign) => c.status === 'scheduled' && (isAdminRole || (!!myId && c.created_by === myId));

  const columns: DataColumn<Campaign>[] = useMemo(
    () => [
      {
        id: 'name',
        header: t('campaigns.col_name', { defaultValue: 'Nombre' }),
        cell: (c) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">{c.name}</span>
            <span className="truncate text-[11.5px] text-ink-muted">{c.message_title}</span>
          </span>
        ),
        primary: true,
        sortKey: 'name',
      },
      {
        id: 'segment_type',
        header: t('campaigns.col_segment', { defaultValue: 'Segmento' }),
        cell: (c) => (
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">
              {audienceLabel(c.audience_role ?? 'customer')}
            </span>
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">
              {segmentLabel(c.segment_type)}
            </span>
          </span>
        ),
        hideBelow: 'md',
        width: '210px',
      },
      {
        id: 'channel',
        header: t('campaigns.col_channel', { defaultValue: 'Canal' }),
        cell: (c) => <span className="capitalize">{channelLabel(c.channel)}</span>,
        hideBelow: 'md',
        width: '90px',
      },
      {
        id: 'status',
        header: t('campaigns.col_status', { defaultValue: 'Estado' }),
        cell: (c) => (
          <span title={c.last_error ?? undefined}>
            <StatusBadge domain="campaign" status={c.status} />
          </span>
        ),
        width: '130px',
      },
      {
        id: 'scheduled_at',
        header: t('campaigns.col_scheduled', { defaultValue: 'Programada para' }),
        // "Enviar ahora" stores scheduled_at = created_at (both now() in the insert), which would
        // read as a schedule nobody chose. Old rows have no scheduled_at at all.
        cell: (c) => (
          <span className="text-ink-muted">
            {c.scheduled_at && c.created_at && c.scheduled_at === c.created_at
              ? t('campaigns.scheduled_on_save', { defaultValue: 'Al guardar' })
              : formatAdminDate(c.scheduled_at)}
          </span>
        ),
        hideBelow: 'lg',
        width: '170px',
      },
      {
        id: 'sent_count',
        header: t('campaigns.col_sent', { defaultValue: 'Enviados' }),
        cell: (c) => <span className="tabular" data-tabular>{c.sent_count.toLocaleString('es-CU')}</span>,
        align: 'right',
        mono: true,
        width: '110px',
        secondary: true,
      },
      {
        id: 'created_at',
        header: t('campaigns.col_created', { defaultValue: 'Creada' }),
        cell: (c) => <span className="text-ink-muted">{formatAdminDate(c.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
      {
        id: 'actions',
        header: '',
        cell: (c) =>
          canCancel(c) ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCancelTarget(c);
              }}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              {t('campaigns.cancel_btn', { defaultValue: 'Cancelar' })}
            </button>
          ) : null,
        align: 'right',
        width: '100px',
        hideInCard: false,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, myId, isAdminRole],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('campaigns.page_eyebrow', { defaultValue: 'Crecimiento · campañas' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('campaigns.title', { defaultValue: 'Campañas' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('campaigns.page_description', { defaultValue: 'Mensajes push y email a segmentos específicos de usuarios. Programa o envía al toque.' })}
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm
            ? t('campaigns.cancel', { defaultValue: 'Cancelar' })
            : t('campaigns.new_campaign', { defaultValue: 'Nueva campaña' })}
        </button>
      </div>

      {showForm && (
        <div className="admin-card p-5 animate-fade-in">
          <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('campaigns.new_campaign_title', { defaultValue: 'Nueva campaña' })}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField label={t('campaigns.field_name', { defaultValue: 'Nombre' })} required error={formErrors.name}>
              <input
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value);
                  setFormErrors(({ name: _n, ...rest }) => rest);
                }}
                placeholder={t('campaigns.placeholder_name', { defaultValue: 'Nombre interno de la campaña' })}
                className={inputCls(!!formErrors.name)}
              />
            </FormField>
            <FormField label={t('campaigns.field_audience', { defaultValue: 'Audiencia' })}>
              <select
                value={formAudience}
                onChange={(e) => setFormAudience(e.target.value as 'customer' | 'driver')}
                className={inputCls(false)}
              >
                {AUDIENCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </FormField>

            <FormField label={t('campaigns.field_segment', { defaultValue: 'Segmento' })}>
              <select
                value={formSegment}
                onChange={(e) => setFormSegment(e.target.value)}
                className={inputCls(false)}
              >
                {SEGMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </FormField>

            {formSegment === 'by_city' && (
              <FormField label={t('campaigns.field_city', { defaultValue: 'Ciudad' })} required error={formErrors.city}>
                <select
                  value={formCityId}
                  onChange={(e) => {
                    setFormCityId(e.target.value);
                    setFormErrors(({ city: _c, ...rest }) => rest);
                  }}
                  className={inputCls(!!formErrors.city)}
                >
                  <option value="">{t('campaigns.placeholder_city', { defaultValue: 'Elige una ciudad' })}</option>
                  {cities.map((city) => (
                    <option key={city.id} value={city.id}>{city.name}</option>
                  ))}
                </select>
              </FormField>
            )}

            <FormField label={t('campaigns.field_channel', { defaultValue: 'Canal' })}>
              <select
                value={formChannel}
                onChange={(e) => setFormChannel(e.target.value)}
                className={inputCls(false)}
              >
                {CHANNEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {(formChannel === 'email' || formChannel === 'both') && (
                <span className="text-[11px] text-ink-muted">
                  {t('campaigns.email_consent_note', { defaultValue: 'El correo solo llega a quienes aceptaron recibir novedades.' })}
                </span>
              )}
            </FormField>

            <FormField
              label={t('campaigns.field_title', { defaultValue: 'Título del mensaje' })}
              required
              error={formErrors.title}
              className="md:col-span-2"
            >
              <input
                value={formTitle}
                onChange={(e) => {
                  setFormTitle(e.target.value);
                  setFormErrors(({ title: _tt, ...rest }) => rest);
                }}
                placeholder={t('campaigns.placeholder_title', { defaultValue: 'Lo que aparece en la notificación' })}
                className={inputCls(!!formErrors.title)}
              />
            </FormField>

            <FormField
              label={t('campaigns.field_body', { defaultValue: 'Cuerpo' })}
              required
              error={formErrors.body}
              className="md:col-span-2"
            >
              <textarea
                rows={3}
                value={formBody}
                onChange={(e) => {
                  setFormBody(e.target.value);
                  setFormErrors(({ body: _b, ...rest }) => rest);
                }}
                placeholder={t('campaigns.placeholder_body', { defaultValue: 'Mensaje completo' })}
                className={inputCls(!!formErrors.body, true)}
              />
            </FormField>

            <FormField label={t('campaigns.field_promo', { defaultValue: 'Código promocional (opcional)' })}>
              <select
                value={formPromoId}
                onChange={(e) => setFormPromoId(e.target.value)}
                className={inputCls(false)}
              >
                <option value="">{t('campaigns.placeholder_no_promo', { defaultValue: 'Sin promoción' })}</option>
                {promotions.map((promo) => (
                  <option key={promo.id} value={promo.id}>
                    {promo.code}
                    {promo.type ? ` · ${promo.type}` : ''}
                  </option>
                ))}
              </select>
            </FormField>

            <div className="flex flex-col gap-1 md:col-span-2">
              <label className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                <input
                  type="checkbox"
                  checked={formSendNow}
                  onChange={(e) => setFormSendNow(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-line"
                />
                {t('campaigns.send_now', { defaultValue: 'Enviar ahora' })}
              </label>
              {!formSendNow && (
                <FormField label={t('campaigns.field_schedule_havana', { defaultValue: 'Programar para (hora de Cuba)' })} required error={formErrors.schedule}>
                  <input
                    type="datetime-local"
                    value={formSchedule}
                    onChange={(e) => {
                      setFormSchedule(e.target.value);
                      setFormErrors(({ schedule: _s, ...rest }) => rest);
                    }}
                    className={inputCls(!!formErrors.schedule)}
                  />
                </FormField>
              )}
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => void handleSend()}
              disabled={
                sending ||
                !formName.trim() ||
                !formTitle.trim() ||
                !formBody.trim() ||
                (formSegment === 'by_city' && !formCityId)
              }
              className="rounded-full bg-primary-500 px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {sending
                ? t('campaigns.processing', { defaultValue: 'Procesando…' })
                : formSendNow
                  ? t('campaigns.send_now_btn', { defaultValue: 'Enviar ahora' })
                  : t('campaigns.schedule_btn', { defaultValue: 'Programar' })}
            </button>
          </div>
        </div>
      )}

      <DataTable<Campaign>
        columns={columns}
        rows={sortedCampaigns}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void loadCampaigns()}
        empty={{
          icon: Megaphone,
          title: t('campaigns.empty_title', { defaultValue: 'Sin campañas' }),
          body: t('campaigns.empty_body', { defaultValue: 'Crea la primera para llegar a un grupo específico de usuarios.' }),
          action: { label: t('campaigns.new_campaign', { defaultValue: 'Nueva campaña' }), onClick: () => setShowForm(true) },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: campaigns.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
      />

      <AdminConfirmModal
        open={!!cancelTarget}
        title={t('campaigns.cancel_title', { defaultValue: 'Cancelar campaña' })}
        message={t('campaigns.cancel_confirm', {
          defaultValue: 'La campaña «{{name}}» no se va a enviar. ¿La cancelas?',
          name: cancelTarget?.name ?? '',
        })}
        // The modal's default buttons read "Confirmar" / "Cancelar": here "Cancelar" would close
        // the dialog without cancelling the campaign.
        confirmLabel={t('campaigns.cancel_submit', { defaultValue: 'Sí, cancelar campaña' })}
        cancelLabel={t('campaigns.cancel_dismiss', { defaultValue: 'No, volver' })}
        variant="danger"
        onConfirm={async () => {
          if (cancelTarget) {
            const target = cancelTarget;
            setCancelTarget(null);
            await handleCancel(target);
          }
        }}
        onCancel={closeCancelDialog}
      />
    </div>
  );
}

function FormField({
  label,
  required,
  error,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </span>
      {children}
      {error && <span className="text-[11px] text-red-500">{error}</span>}
    </label>
  );
}

/**
 * The datetime-local value read as Havana time, as a UTC ISO string; null when empty or not
 * 'YYYY-MM-DDTHH:mm' (havanaLocalToUtcIso throws on anything else).
 */
function scheduleToUtcIso(value: string): string | null {
  if (!value) return null;
  try {
    return havanaLocalToUtcIso(value);
  } catch {
    return null;
  }
}

function inputCls(hasError: boolean, multiline = false) {
  const base = 'rounded-lg border bg-surface text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none';
  const size = multiline ? 'px-2.5 py-1.5' : 'h-9 px-2.5';
  const color = hasError ? 'border-red-500 focus:border-red-500' : 'border-line focus:border-primary-500';
  return `${base} ${size} ${color}`;
}
