'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import { notificationService } from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';
import { formatAdminDate } from '@/lib/formatDate';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

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
  description: string | null;
};

type City = { id: string; name: string; slug: string };

const SEGMENT_OPTIONS = [
  { value: 'new_users', labelKey: 'campaigns.segment_new_users' },
  { value: 'power_users', labelKey: 'campaigns.segment_power_users' },
  { value: 'inactive', labelKey: 'campaigns.segment_inactive' },
  { value: 'all', labelKey: 'campaigns.segment_all' },
  { value: 'by_city', labelKey: 'campaigns.segment_by_city' },
];

const CHANNEL_OPTIONS = [
  { value: 'push', labelKey: 'campaigns.channel_push' },
  { value: 'email', labelKey: 'campaigns.channel_email' },
  { value: 'both', labelKey: 'campaigns.channel_both' },
];

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-neutral-100 text-neutral-600',
  scheduled: 'bg-blue-100 text-blue-700',
  sent: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};


const PAGE_SIZE = 20;

export default function CampaignsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [sending, setSending] = useState(false);

  // Form state
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

  // Reference data
  const [cities, setCities] = useState<City[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);

  useEffect(() => {
    loadCampaigns();
  }, [page]);

  useEffect(() => {
    loadReferenceData();
  }, []);

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const supabase = getSupabaseClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data } = await supabase
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, to);
      setCampaigns((data ?? []) as Campaign[]);
    } catch (err) {
      console.error('Error loading campaigns:', err);
      setError(err instanceof Error ? err.message : 'Error al cargar campañas');
    } finally {
      setLoading(false);
    }
  };

  const loadReferenceData = async () => {
    try {
      const [citiesData, promoData] = await Promise.all([
        cityService.getAllCities(),
        (async () => {
          const supabase = getSupabaseClient();
          const { data } = await supabase
            .from('promotions')
            .select('id, code, description')
            .eq('is_active', true)
            .order('code');
          return (data ?? []) as Promotion[];
        })(),
      ]);
      setCities(citiesData);
      setPromotions(promoData);
    } catch (err) {
      console.error('Error loading reference data:', err);
    }
  };

  const getSegmentUserIds = async (): Promise<string[]> => {
    const supabase = getSupabaseClient();
    const now = new Date();

    if (formSegment === 'all') {
      const { data } = await supabase.from('profiles').select('id').eq('role', 'customer');
      return (data ?? []).map((u) => u.id);
    }

    if (formSegment === 'new_users') {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .gte('created_at', sevenDaysAgo);
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
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: activeRiders } = await supabase
        .from('rides')
        .select('customer_id')
        .gte('created_at', thirtyDaysAgo)
        .not('customer_id', 'is', null);
      const activeSet = new Set((activeRiders ?? []).map((r) => r.customer_id));
      const { data: allCustomers } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'customer');
      return (allCustomers ?? []).filter((u) => !activeSet.has(u.id)).map((u) => u.id);
    }

    if (formSegment === 'by_city' && formCityId) {
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .eq('city_id', formCityId);
      return (data ?? []).map((u) => u.id);
    }

    return [];
  };

  function validateCampaignForm() {
    const errors: Record<string, string> = {};
    if (!formName.trim()) errors.name = 'Campo requerido';
    if (!formTitle.trim()) errors.title = 'Campo requerido';
    if (!formBody.trim()) errors.body = 'Campo requerido';
    if (formSegment === 'by_city' && !formCityId) errors.city = 'Campo requerido';
    if (!formSendNow && formSchedule) {
      const scheduleDate = new Date(formSchedule);
      if (scheduleDate <= new Date()) {
        errors.schedule = 'Debe ser una fecha futura';
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const handleSend = async () => {
    if (!validateCampaignForm()) return;

    setSending(true);
    try {
      const supabase = getSupabaseClient();

      // Get current user
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // Create campaign record
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
        // Send immediately
        const userIds = await getSegmentUserIds();

        const result = await notificationService.sendToMultipleUsers(userIds, 'campaign', {
          title: formTitle,
          body: formBody,
        });

        campaignData.sent_at = new Date().toISOString();
        campaignData.sent_count = result.sent;
      }

      const { error } = await supabase.from('campaigns').insert(campaignData);
      if (error) throw error;

      // Reset form
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
      setShowForm(false);

      setPage(0);
      loadCampaigns();
      showToast('success', t('campaigns.send_success'));
    } catch (err) {
      console.error('Error sending campaign:', err);
      showToast('error', t('campaigns.send_error'));
    } finally {
      setSending(false);
    }
  };

  const canGoPrev = page > 0;
  const canGoNext = campaigns.length === PAGE_SIZE;

  const getSegmentLabel = (segmentType: string): string => {
    const option = SEGMENT_OPTIONS.find((o) => o.value === segmentType);
    return option ? t(option.labelKey) : segmentType;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('campaigns.title')}</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
        >
          {showForm ? t('common.cancel') : t('campaigns.new_campaign')}
        </button>
      </div>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); loadCampaigns(); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* New Campaign Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('campaigns.new_campaign')}</h2>

          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_name')}<span className="text-red-500 ml-1">*</span>
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => { setFormName(e.target.value); setFormErrors((prev) => { const { name, ...rest } = prev; return rest; }); }}
                placeholder={t('campaigns.name_placeholder')}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.name ? 'border-red-500' : 'border-neutral-200'}`}
              />
              {formErrors.name && <p className="text-red-500 text-xs mt-1">{formErrors.name}</p>}
            </div>

            {/* Segment */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_segment')}
              </label>
              <select
                value={formSegment}
                onChange={(e) => setFormSegment(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              >
                {SEGMENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {/* City filter (if by_city) */}
            {formSegment === 'by_city' && (
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  {t('campaigns.label_city')}<span className="text-red-500 ml-1">*</span>
                </label>
                <select
                  value={formCityId}
                  onChange={(e) => { setFormCityId(e.target.value); setFormErrors((prev) => { const { city, ...rest } = prev; return rest; }); }}
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.city ? 'border-red-500' : 'border-neutral-200'}`}
                >
                  <option value="">{t('segments.select_city')}</option>
                  {cities.map((city) => (
                    <option key={city.id} value={city.id}>
                      {city.name}
                    </option>
                  ))}
                </select>
                {formErrors.city && <p className="text-red-500 text-xs mt-1">{formErrors.city}</p>}
              </div>
            )}

            {/* Channel */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_channel')}
              </label>
              <select
                value={formChannel}
                onChange={(e) => setFormChannel(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              >
                {CHANNEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {/* Message title */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_msg_title')}<span className="text-red-500 ml-1">*</span>
              </label>
              <input
                type="text"
                value={formTitle}
                onChange={(e) => { setFormTitle(e.target.value); setFormErrors((prev) => { const { title, ...rest } = prev; return rest; }); }}
                placeholder={t('campaigns.msg_title_placeholder')}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.title ? 'border-red-500' : 'border-neutral-200'}`}
              />
              {formErrors.title && <p className="text-red-500 text-xs mt-1">{formErrors.title}</p>}
            </div>

            {/* Message body */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_msg_body')}<span className="text-red-500 ml-1">*</span>
              </label>
              <textarea
                value={formBody}
                onChange={(e) => { setFormBody(e.target.value); setFormErrors((prev) => { const { body, ...rest } = prev; return rest; }); }}
                placeholder={t('campaigns.msg_body_placeholder')}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.body ? 'border-red-500' : 'border-neutral-200'}`}
                rows={3}
              />
              {formErrors.body && <p className="text-red-500 text-xs mt-1">{formErrors.body}</p>}
            </div>

            {/* Promo code (optional) */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('campaigns.label_promo')}
              </label>
              <select
                value={formPromoId}
                onChange={(e) => setFormPromoId(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              >
                <option value="">{t('campaigns.no_promo')}</option>
                {promotions.map((promo) => (
                  <option key={promo.id} value={promo.id}>
                    {promo.code} {promo.description ? `- ${promo.description}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Schedule */}
            <div>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={formSendNow}
                  onChange={(e) => setFormSendNow(e.target.checked)}
                  className="rounded border-neutral-300"
                />
                <span className="text-sm font-medium text-neutral-700">
                  {t('campaigns.send_now')}
                </span>
              </label>
              {!formSendNow && (
                <>
                  <input
                    type="datetime-local"
                    value={formSchedule}
                    onChange={(e) => { setFormSchedule(e.target.value); setFormErrors((prev) => { const { schedule, ...rest } = prev; return rest; }); }}
                    className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.schedule ? 'border-red-500' : 'border-neutral-200'}`}
                  />
                  {formErrors.schedule && <p className="text-red-500 text-xs mt-1">{formErrors.schedule}</p>}
                </>
              )}
            </div>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={
                sending ||
                !formName.trim() ||
                !formTitle.trim() ||
                !formBody.trim() ||
                (formSegment === 'by_city' && !formCityId)
              }
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
            >
              {sending
                ? t('common.processing')
                : formSendNow
                  ? t('campaigns.btn_send')
                  : t('campaigns.btn_schedule')}
            </button>
          </div>
        </div>
      )}

      {/* Campaigns list */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-100">
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                  {t('campaigns.col_name')}
                </th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                  {t('campaigns.col_segment')}
                </th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                  {t('campaigns.col_channel')}
                </th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                  {t('campaigns.col_status')}
                </th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                  {t('campaigns.col_sent_count')}
                </th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                  {t('campaigns.col_created')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-0 py-0">
                    <AdminTableSkeleton rows={5} columns={6} />
                  </td>
                </tr>
              ) : campaigns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-neutral-400">
                    {t('campaigns.no_campaigns')}
                  </td>
                </tr>
              ) : (
                campaigns.map((campaign) => (
                  <tr
                    key={campaign.id}
                    className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                  >
                    <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                      {campaign.name}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {getSegmentLabel(campaign.segment_type)}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 capitalize">
                      {campaign.channel}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          STATUS_COLORS[campaign.status] ?? 'bg-neutral-100 text-neutral-600'
                        }`}
                      >
                        {t(`campaigns.status_${campaign.status}`)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">{campaign.sent_count}</td>
                    <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                      {formatAdminDate(campaign.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">
          {t('common.page')} {page + 1}
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoNext
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
