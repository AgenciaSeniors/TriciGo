'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import { notificationService } from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { formatAdminDate } from '@/lib/formatDate';

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
};

type Promotion = {
  id: string;
  code: string;
  type: string | null;
};

type City = { id: string; name: string; slug: string };

const SEGMENT_KEYS = ['new_users', 'power_users', 'inactive', 'all', 'by_city'] as const;
const CHANNEL_KEYS = ['push', 'email', 'both'] as const;

const PAGE_SIZE = 20;

export default function CampaignsPage() {
  const { t } = useTranslation('admin');

  const segmentLabel = (v: string): string => {
    const fallbacks: Record<string, string> = {
      new_users: 'Recién llegados', power_users: 'Power users', inactive: 'Inactivos',
      all: 'Todos los pasajeros', by_city: 'Por ciudad',
    };
    return t(`campaigns.segment_${v}`, { defaultValue: fallbacks[v] ?? v });
  };
  const channelLabel = (v: string): string => {
    const fallbacks: Record<string, string> = { push: 'Push', email: 'Email', both: 'Ambos' };
    return t(`campaigns.channel_${v}`, { defaultValue: fallbacks[v] ?? v });
  };
  const SEGMENT_OPTIONS = SEGMENT_KEYS.map((v) => ({ value: v, label: segmentLabel(v) }));
  const CHANNEL_OPTIONS = CHANNEL_KEYS.map((v) => ({ value: v, label: channelLabel(v) }));
  const { showToast } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const [formName, setFormName] = useState('');
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

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      setCampaigns([]);
      setError(err instanceof Error ? err.message : t('campaigns.load_error', { defaultValue: 'No pudimos cargar las campañas.' }));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

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

  const getSegmentUserIds = async (): Promise<string[]> => {
    const supabase = getSupabaseClient();
    const now = new Date();

    if (formSegment === 'all') {
      const { data } = await supabase.from('users').select('id').eq('role', 'customer');
      return (data ?? []).map((u) => u.id);
    }
    if (formSegment === 'new_users') {
      const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase.from('users').select('id').gte('created_at', since);
      return (data ?? []).map((u) => u.id);
    }
    if (formSegment === 'power_users') {
      const { data: allRides } = await supabase
        .from('rides')
        .select('customer_id')
        .not('customer_id', 'is', null);
      const rideCounts: Record<string, number> = {};
      for (const r of allRides ?? []) {
        rideCounts[r.customer_id] = (rideCounts[r.customer_id] || 0) + 1;
      }
      return Object.entries(rideCounts)
        .filter(([, c]) => c > 10)
        .map(([id]) => id);
    }
    if (formSegment === 'inactive') {
      const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: activeRiders } = await supabase
        .from('rides')
        .select('customer_id')
        .gte('created_at', since)
        .not('customer_id', 'is', null);
      const activeSet = new Set((activeRiders ?? []).map((r) => r.customer_id));
      const { data: allCustomers } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'customer');
      return (allCustomers ?? []).filter((u) => !activeSet.has(u.id)).map((u) => u.id);
    }
    if (formSegment === 'by_city' && formCityId) {
      const { data } = await supabase.from('users').select('id').eq('city_id', formCityId);
      return (data ?? []).map((u) => u.id);
    }
    return [];
  };

  const validateForm = () => {
    const errors: Record<string, string> = {};
    const required = t('campaigns.required', { defaultValue: 'Requerido' });
    if (!formName.trim()) errors.name = required;
    if (!formTitle.trim()) errors.title = required;
    if (!formBody.trim()) errors.body = required;
    if (formSegment === 'by_city' && !formCityId) errors.city = t('campaigns.choose_city_error', { defaultValue: 'Elegí una ciudad' });
    if (!formSendNow && formSchedule) {
      const d = new Date(formSchedule);
      if (d <= new Date()) errors.schedule = t('campaigns.future_error', { defaultValue: 'Tiene que ser en el futuro' });
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const resetForm = () => {
    setFormName('');
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

  const handleSend = async () => {
    if (!validateForm()) return;
    setSending(true);
    try {
      const supabase = getSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();

      const campaignData: Record<string, unknown> = {
        name: formName,
        segment_type: formSegment,
        segment_city_id: formSegment === 'by_city' ? formCityId : null,
        message_title: formTitle,
        message_body: formBody,
        promo_code_id: formPromoId || null,
        channel: formChannel,
        status: formSendNow ? 'sent' : 'scheduled',
        scheduled_at: !formSendNow && formSchedule ? formSchedule : null,
        created_by: user?.id ?? null,
      };

      if (formSendNow) {
        const userIds = await getSegmentUserIds();
        let sentCount = 0;

        // PUSH — always-on for 'push' and 'both'
        if (formChannel === 'push' || formChannel === 'both') {
          const result = await notificationService.sendToMultipleUsers(userIds, 'campaign', {
            title: formTitle,
            body: formBody,
          });
          sentCount = Math.max(sentCount, result.sent);
        }

        // EMAIL — for 'email' and 'both'. Call bulk edge function.
        if ((formChannel === 'email' || formChannel === 'both') && userIds.length > 0) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
            const res = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session?.access_token ?? ''}`,
                apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
              },
              body: JSON.stringify({
                user_ids: userIds,
                subject: formTitle,
                body_html: `<p>${formBody.replace(/\n/g, '<br/>')}</p>`,
                promo_code_id: formPromoId || null,
              }),
            });
            const json = await res.json();
            if (json.sent) sentCount = Math.max(sentCount, json.sent);
          } catch (err) {
            console.error('[campaigns] email send failed', err);
          }
        }

        // SMS — for 'sms' and 'both'. Call bulk edge function.
        if ((formChannel === 'sms' || formChannel === 'both') && userIds.length > 0) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
            // Keep SMS body short (<160 chars for single-segment delivery)
            const smsBody = formTitle.length + formBody.length > 140
              ? `${formTitle}: ${formBody.slice(0, 140 - formTitle.length)}…`
              : `${formTitle}: ${formBody}`;
            const res = await fetch(`${supabaseUrl}/functions/v1/send-bulk-sms`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session?.access_token ?? ''}`,
                apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
              },
              body: JSON.stringify({ user_ids: userIds, body: smsBody }),
            });
            const json = await res.json();
            if (json.sent) sentCount = Math.max(sentCount, json.sent);
          } catch (err) {
            console.error('[campaigns] sms send failed', err);
          }
        }

        campaignData.sent_at = new Date().toISOString();
        campaignData.sent_count = sentCount;
      }

      const { error: dbError } = await supabase.from('campaigns').insert(campaignData);
      if (dbError) throw dbError;

      resetForm();
      setShowForm(false);
      setPage(0);
      await loadCampaigns();
      showToast('success', formSendNow
        ? t('campaigns.toast_sent', { defaultValue: 'Campaña enviada' })
        : t('campaigns.toast_scheduled', { defaultValue: 'Campaña programada' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('campaigns.send_error', { defaultValue: 'No pudimos enviar la campaña.' }));
    } finally {
      setSending(false);
    }
  };

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
          <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">
            {segmentLabel(c.segment_type)}
          </span>
        ),
        hideBelow: 'md',
        width: '150px',
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
        cell: (c) => <StatusBadge domain="campaign" status={c.status} />,
        width: '130px',
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
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
            {t('campaigns.page_description', { defaultValue: 'Mensajes push y email a segmentos específicos de usuarios. Programá o enviá al toque.' })}
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
                  <option value="">{t('campaigns.placeholder_city', { defaultValue: 'Elegí una ciudad' })}</option>
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
                <FormField label={t('campaigns.field_schedule', { defaultValue: 'Programar para' })} error={formErrors.schedule}>
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
          body: t('campaigns.empty_body', { defaultValue: 'Creá la primera para llegar a un grupo específico de usuarios.' }),
          action: { label: t('campaigns.new_campaign', { defaultValue: 'Nueva campaña' }), onClick: () => setShowForm(true) },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: campaigns.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
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

function inputCls(hasError: boolean, multiline = false) {
  const base = 'rounded-lg border bg-surface text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none';
  const size = multiline ? 'px-2.5 py-1.5' : 'h-9 px-2.5';
  const color = hasError ? 'border-red-500 focus:border-red-500' : 'border-line focus:border-primary-500';
  return `${base} ${size} ${color}`;
}
