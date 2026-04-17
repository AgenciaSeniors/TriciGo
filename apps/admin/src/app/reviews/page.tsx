'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, StarOff } from 'lucide-react';
import { createBrowserClient } from '@/lib/supabase-server';
import { useTranslation } from '@tricigo/i18n';
import { formatAdminDate } from '@/lib/formatDate';
import type { Review } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { KpiCard } from '@/components/dashboard/KpiCard';

const PAGE_SIZE = 20;

type RatingFilter = 'all' | '5' | '4' | '3' | '2' | '1';

const RATING_TABS: StatusTab<RatingFilter>[] = [
  { id: 'all', label: 'Todas' },
  { id: '5', label: '5 ★', tone: 'success' },
  { id: '4', label: '4 ★', tone: 'success' },
  { id: '3', label: '3 ★', tone: 'warning' },
  { id: '2', label: '2 ★', tone: 'warning' },
  { id: '1', label: '1 ★', tone: 'danger' },
];

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

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${rating} de 5 estrellas`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${
            i < rating ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-ink-subtle'
          }`}
          strokeWidth={1.5}
        />
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stats, setStats] = useState<ReviewStats>({ total: 0, average: 0, today: 0 });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const fetchStats = useCallback(async () => {
    const supabase = createBrowserClient();
    const { count: totalCount } = await supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true });

    const { data: avgData } = (await supabase.rpc('get_global_review_stats')) as {
      data: { average_rating: number } | null;
      error: unknown;
    };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayCount } = await supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString());

    let avg = avgData?.average_rating ?? 0;
    if (!avg && totalCount && totalCount > 0) {
      const { data: allRatings } = await supabase.from('reviews').select('rating');
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
    setError(null);
    try {
      const supabase = createBrowserClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from('reviews')
        .select(
          `*,
          reviewer:profiles!reviews_reviewer_id_fkey(full_name),
          reviewee:profiles!reviews_reviewee_id_fkey(full_name)`,
        )
        .order('created_at', { ascending: false })
        .range(from, to);

      if (ratingFilter !== 'all') {
        query = query.eq('rating', parseInt(ratingFilter, 10));
      }
      if (dateFrom) query = query.gte('created_at', new Date(dateFrom).toISOString());
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        query = query.lte('created_at', end.toISOString());
      }

      const { data, error: dbError } = await query;
      if (dbError) throw dbError;

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
            acc[tag.review_id]!.push(tag.tag_key);
            return acc;
          }, {});
        }
      }

      const rows: ReviewRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
        ...(r as unknown as Review),
        reviewer_name: (r.reviewer as { full_name?: string } | null)?.full_name ?? undefined,
        reviewee_name: (r.reviewee as { full_name?: string } | null)?.full_name ?? undefined,
        tag_keys: tagsMap[(r as unknown as Review).id] ?? [],
        is_featured: (r as Record<string, unknown>).is_featured as boolean | undefined,
      }));

      setReviews(rows);
    } catch (err) {
      setReviews([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar las reseñas.');
    } finally {
      setLoading(false);
    }
  }, [page, ratingFilter, dateFrom, dateTo]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    void fetchReviews();
  }, [fetchReviews]);

  const handleToggleVisibility = async (review: ReviewRow) => {
    setActionLoading(review.id);
    try {
      const supabase = createBrowserClient();
      const newVisibility = !review.is_visible;
      const { error: dbError } = await supabase
        .from('reviews')
        .update({ is_visible: newVisibility })
        .eq('id', review.id);
      if (dbError) throw dbError;
      setReviews((prev) =>
        prev.map((r) => (r.id === review.id ? { ...r, is_visible: newVisibility } : r)),
      );
      showToast('success', newVisibility ? 'Reseña visible' : 'Reseña ocultada');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos cambiar la visibilidad.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleFeatured = async (review: ReviewRow) => {
    setActionLoading(review.id);
    try {
      const supabase = createBrowserClient();
      const newFeatured = !review.is_featured;
      const { error: dbError } = await supabase
        .from('reviews')
        .update({ is_featured: newFeatured })
        .eq('id', review.id);
      if (dbError) throw dbError;
      setReviews((prev) =>
        prev.map((r) => (r.id === review.id ? { ...r, is_featured: newFeatured } : r)),
      );
      showToast('success', newFeatured ? 'Reseña destacada' : 'Reseña sin destacar');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos cambiar el destacado.');
    } finally {
      setActionLoading(null);
    }
  };

  const sortedReviews = useMemo(() => {
    if (!sort) return reviews;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof ReviewRow;
    return [...reviews].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [reviews, sort]);

  const columns: DataColumn<ReviewRow>[] = useMemo(
    () => [
      {
        id: 'reviewer',
        header: 'De → para',
        cell: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">
              {r.reviewer_name ?? r.reviewer_id.substring(0, 8) + '…'}
            </span>
            <span className="truncate text-[11.5px] text-ink-muted">
              → {r.reviewee_name ?? r.reviewee_id.substring(0, 8) + '…'}
            </span>
          </span>
        ),
        primary: true,
      },
      {
        id: 'rating',
        header: 'Estrellas',
        cell: (r) => <Stars rating={r.rating} />,
        sortKey: 'rating',
        width: '140px',
      },
      {
        id: 'comment',
        header: 'Comentario',
        cell: (r) =>
          r.comment ? (
            <span className="block max-w-[260px] truncate text-ink-muted">{r.comment}</span>
          ) : (
            <span className="text-ink-subtle">—</span>
          ),
        hideBelow: 'md',
        secondary: true,
      },
      {
        id: 'tags',
        header: 'Tags',
        cell: (r) =>
          (r.tag_keys ?? []).length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {(r.tag_keys ?? []).slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[9.5px] text-ink-muted"
                >
                  {tag}
                </span>
              ))}
              {(r.tag_keys ?? []).length > 3 && (
                <span className="text-[10px] text-ink-subtle">+{(r.tag_keys ?? []).length - 3}</span>
              )}
            </span>
          ) : (
            <span className="text-ink-subtle">—</span>
          ),
        hideBelow: 'lg',
        width: '180px',
      },
      {
        id: 'status',
        header: 'Estado',
        cell: (r) => (
          <span className="flex items-center gap-1">
            {r.is_visible ? (
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Visible
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                Oculta
              </span>
            )}
            {r.is_featured && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                ★
              </span>
            )}
          </span>
        ),
        width: '150px',
      },
      {
        id: 'created_at',
        header: 'Fecha',
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Gente · reseñas
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            Reseñas
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Opiniones de pasajeros y conductores. Moderá lo que se muestra y destacá lo mejor.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Total de reseñas" value={String(stats.total)} loading={false} />
        <KpiCard
          label="Promedio"
          value={stats.average > 0 ? stats.average.toFixed(1) : '—'}
          unit={stats.average > 0 ? '★' : undefined}
          tone="warning"
          loading={false}
        />
        <KpiCard label="Hoy" value={String(stats.today)} tone="primary" loading={false} />
      </div>

      <FilterBar<RatingFilter>
        sticky
        tabs={RATING_TABS}
        activeTab={ratingFilter}
        onTabChange={(id) => {
          setRatingFilter(id);
          setPage(0);
        }}
        activeFilterCount={(dateFrom ? 1 : 0) + (dateTo ? 1 : 0)}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(0);
              }}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Hasta</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(0);
              }}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
        </div>
        {(dateFrom || dateTo) && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setPage(0);
              }}
              className="text-[11.5px] font-medium text-ink-muted hover:text-ink"
            >
              Limpiar fechas
            </button>
          </div>
        )}
      </FilterBar>

      <DataTable<ReviewRow>
        columns={columns}
        rows={sortedReviews}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchReviews()}
        empty={{
          icon: StarOff,
          title: 'Sin reseñas aún',
          body: 'Cuando lleguen las primeras opiniones, van a aparecer acá.',
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: reviews.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          {
            label: 'Mostrar/Ocultar',
            onClick: (r) => {
              if (actionLoading !== r.id) void handleToggleVisibility(r);
            },
          },
          {
            label: 'Destacar',
            onClick: (r) => {
              if (actionLoading !== r.id) void handleToggleFeatured(r);
            },
          },
        ]}
      />
    </div>
  );
}
