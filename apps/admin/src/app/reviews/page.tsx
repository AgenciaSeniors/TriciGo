'use client';

import { useEffect, useState, useCallback } from 'react';
import { createBrowserClient } from '@/lib/supabase-server';
import { useTranslation } from '@tricigo/i18n';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';
import { formatAdminDate } from '@/lib/formatDate';
import type { Review } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

const PAGE_SIZE = 20;

const RATING_TABS: { labelKey: string; value: string }[] = [
  { labelKey: 'reviews.filter_all', value: 'all' },
  { labelKey: 'reviews.filter_5', value: '5' },
  { labelKey: 'reviews.filter_4', value: '4' },
  { labelKey: 'reviews.filter_3', value: '3' },
  { labelKey: 'reviews.filter_2', value: '2' },
  { labelKey: 'reviews.filter_1', value: '1' },
];

const STAR_COLORS: Record<number, string> = {
  5: 'text-yellow-500',
  4: 'text-yellow-500',
  3: 'text-yellow-400',
  2: 'text-orange-400',
  1: 'text-red-400',
};


function Stars({ rating }: { rating: number }) {
  const color = STAR_COLORS[rating] ?? 'text-yellow-500';
  return (
    <span className={`${color} text-sm tracking-tight`}>
      {'★'.repeat(rating)}
      {'☆'.repeat(5 - rating)}
    </span>
  );
}

interface ReviewRow extends Review {
  reviewer_name?: string;
  reviewee_name?: string;
  tag_keys?: string[];
  is_featured?: boolean;
}

interface ReviewStats {
  total: number;
  average: number;
  today: number;
}

export default function ReviewsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [ratingFilter, setRatingFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stats, setStats] = useState<ReviewStats>({ total: 0, average: 0, today: 0 });
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    const supabase = createBrowserClient();

    // Total reviews and average rating
    const { count: totalCount } = await supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true });

    const { data: avgData } = await supabase
      .rpc('get_global_review_stats') as { data: { average_rating: number } | null; error: unknown };

    // Reviews today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayCount } = await supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString());

    // Fallback: compute average from all reviews if RPC doesn't exist
    let avg = avgData?.average_rating ?? 0;
    if (!avg && totalCount && totalCount > 0) {
      const { data: allRatings } = await supabase
        .from('reviews')
        .select('rating');
      if (allRatings && allRatings.length > 0) {
        const sum = allRatings.reduce((acc: number, r: { rating: number }) => acc + r.rating, 0);
        avg = sum / allRatings.length;
      }
    }

    setStats({
      total: totalCount ?? 0,
      average: Math.round(avg * 10) / 10,
      today: todayCount ?? 0,
    });
  }, []);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createBrowserClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from('reviews')
        .select(`
          *,
          reviewer:profiles!reviews_reviewer_id_fkey(full_name),
          reviewee:profiles!reviews_reviewee_id_fkey(full_name)
        `)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (ratingFilter !== 'all') {
        query = query.eq('rating', parseInt(ratingFilter, 10));
      }

      if (dateFrom) {
        query = query.gte('created_at', new Date(dateFrom).toISOString());
      }
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        query = query.lte('created_at', end.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      // Fetch tags for all reviews
      const reviewIds = (data ?? []).map((r: Record<string, unknown>) => r.id as string);
      let tagsMap: Record<string, string[]> = {};
      if (reviewIds.length > 0) {
        const { data: tags } = await supabase
          .from('review_tags')
          .select('review_id, tag_key')
          .in('review_id', reviewIds);
        if (tags) {
          tagsMap = tags.reduce((acc: Record<string, string[]>, tag: { review_id: string; tag_key: string }) => {
            if (!acc[tag.review_id]) acc[tag.review_id] = [];
            acc[tag.review_id].push(tag.tag_key);
            return acc;
          }, {});
        }
      }

      const rows: ReviewRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
        ...(r as Review),
        reviewer_name: (r.reviewer as { full_name?: string } | null)?.full_name ?? undefined,
        reviewee_name: (r.reviewee as { full_name?: string } | null)?.full_name ?? undefined,
        tag_keys: tagsMap[(r as Review).id] ?? [],
        is_featured: (r as Record<string, unknown>).is_featured as boolean | undefined,
      }));

      setReviews(rows);
    } catch (err) {
      console.error('Error fetching reviews:', err);
      setError(err instanceof Error ? err.message : 'Error al cargar reseñas');
    } finally {
      setLoading(false);
    }
  }, [page, ratingFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const handleToggleVisibility = async (review: ReviewRow) => {
    setActionLoading(review.id);
    try {
      const supabase = createBrowserClient();
      const newVisibility = !review.is_visible;
      const { error } = await supabase
        .from('reviews')
        .update({ is_visible: newVisibility })
        .eq('id', review.id);
      if (error) throw error;
      setReviews((prev) =>
        prev.map((r) => (r.id === review.id ? { ...r, is_visible: newVisibility } : r)),
      );
    } catch (err) {
      console.error('Error toggling visibility:', err);
      showToast('error', 'Error al cambiar visibilidad');
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleFeatured = async (review: ReviewRow) => {
    setActionLoading(review.id);
    try {
      const supabase = createBrowserClient();
      const newFeatured = !review.is_featured;
      const { error } = await supabase
        .from('reviews')
        .update({ is_featured: newFeatured })
        .eq('id', review.id);
      if (error) throw error;
      setReviews((prev) =>
        prev.map((r) => (r.id === review.id ? { ...r, is_featured: newFeatured } : r)),
      );
    } catch (err) {
      console.error('Error toggling featured:', err);
      showToast('error', 'Error al cambiar destacado');
    } finally {
      setActionLoading(null);
    }
  };

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(reviews, 'created_at');

  const canGoPrev = page > 0;
  const canGoNext = reviews.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('reviews.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchReviews(); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard label={t('reviews.stat_total')} value={stats.total} />
        <StatCard
          label={t('reviews.stat_average')}
          value={stats.average > 0 ? `${stats.average} ★` : '—'}
          color="text-yellow-600"
        />
        <StatCard
          label={t('reviews.stat_today')}
          value={stats.today}
          color="text-primary-600"
        />
      </div>

      {/* Rating filter tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {RATING_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setRatingFilter(tab.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              ratingFilter === tab.value
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Date range filter */}
      <div className="flex flex-wrap gap-3 mb-6 items-center">
        <label className="text-sm text-neutral-500">{t('reviews.date_from')}:</label>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
          className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-primary-500"
        />
        <label className="text-sm text-neutral-500">{t('reviews.date_to')}:</label>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
          className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-primary-500"
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setPage(0); }}
            className="text-xs text-primary-500 hover:underline"
          >
            {t('reviews.clear_dates')}
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <AdminTableSkeleton rows={5} columns={4} />
      ) : reviews.length === 0 ? (
        <AdminEmptyState icon="⭐" title={t('reviews.no_reviews')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <SortableHeader label={t('reviews.col_date')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="pb-3 pr-4" />
                <th className="pb-3 pr-4">{t('reviews.col_reviewer')}</th>
                <th className="pb-3 pr-4">{t('reviews.col_reviewee')}</th>
                <SortableHeader label={t('reviews.col_rating')} sortKey="rating" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="pb-3 pr-4" />
                <th className="pb-3 pr-4">{t('reviews.col_comment')}</th>
                <th className="pb-3 pr-4">{t('reviews.col_tags')}</th>
                <th className="pb-3 pr-4">{t('reviews.col_status')}</th>
                <th className="pb-3">{t('reviews.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedData.map((review) => (
                <tr key={review.id} className="border-b hover:bg-neutral-50">
                  <td className="py-3 pr-4 text-neutral-500 text-xs whitespace-nowrap">
                    {formatAdminDate(review.created_at)}
                  </td>
                  <td className="py-3 pr-4 text-xs">
                    {review.reviewer_name ?? review.reviewer_id.substring(0, 8) + '...'}
                  </td>
                  <td className="py-3 pr-4 text-xs">
                    {review.reviewee_name ?? review.reviewee_id.substring(0, 8) + '...'}
                  </td>
                  <td className="py-3 pr-4">
                    <Stars rating={review.rating} />
                  </td>
                  <td className="py-3 pr-4 max-w-[200px] truncate text-xs text-neutral-700">
                    {review.comment ?? <span className="text-neutral-300 italic">—</span>}
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {(review.tag_keys ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600 text-[10px]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex gap-1">
                      {review.is_visible ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          {t('reviews.visible')}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          {t('reviews.hidden')}
                        </span>
                      )}
                      {review.is_featured && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                          ★
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleToggleVisibility(review)}
                        disabled={actionLoading === review.id}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 ${
                          review.is_visible
                            ? 'bg-red-100 text-red-700 hover:bg-red-200'
                            : 'bg-green-100 text-green-700 hover:bg-green-200'
                        }`}
                      >
                        {review.is_visible ? t('reviews.hide') : t('reviews.show')}
                      </button>
                      <button
                        onClick={() => handleToggleFeatured(review)}
                        disabled={actionLoading === review.id}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 ${
                          review.is_featured
                            ? 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                            : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                        }`}
                      >
                        {review.is_featured ? t('reviews.unfeature') : t('reviews.feature')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {(canGoPrev || canGoNext) && (
        <div className="flex items-center justify-between mt-6 text-sm">
          <button
            disabled={!canGoPrev}
            onClick={() => setPage((p) => p - 1)}
            className={`px-4 py-2 rounded-lg ${
              canGoPrev
                ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
            }`}
          >
            {t('common.previous')}
          </button>
          <span className="text-neutral-500">
            {t('common.page')} {page + 1}
          </span>
          <button
            disabled={!canGoNext}
            onClick={() => setPage((p) => p + 1)}
            className={`px-4 py-2 rounded-lg ${
              canGoNext
                ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
            }`}
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-neutral-900'}`}>
        {value}
      </p>
    </div>
  );
}
