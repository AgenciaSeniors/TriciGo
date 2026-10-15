'use client';

import { useEffect, useState } from 'react';
import { reviewService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { ReviewSummary, ReviewWithReviewer } from '@tricigo/types';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatAdminDate } from '@/lib/formatDate';

const MAX_TOP_TAGS = 5;
const LATEST_REVIEWS = 10;

/** What one load produced, tagged with the person it belongs to. */
interface ReviewsState {
  userId: string;
  summary: ReviewSummary | null;
  reviews: ReviewWithReviewer[];
  error: string | null;
}

const humanize = (key: string) => key.replace(/_/g, ' ');

function Stars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="text-amber-600" role="img" aria-label={`${filled} / 5`}>
      {'★'.repeat(filled)}
      {'☆'.repeat(5 - filled)}
    </span>
  );
}

/**
 * The reviews written ABOUT a person (a driver or a passenger), read-only, for marketing (00663).
 * `userId` is the reviewed person's users.id (reviews.reviewee_id), not a driver profile id.
 * A failure here only shows a line inside this section: the page around it keeps working.
 */
export function ReviewsReadOnly({ userId }: { userId: string | null }) {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<ReviewsState | null>(null);

  useEffect(() => {
    if (!userId) return;
    // A response that arrives after the id changed (or after unmount) is dropped.
    let ignore = false;
    Promise.all([
      reviewService.getReviewSummary(userId),
      reviewService.getReviewsWithReviewerInfo(userId, LATEST_REVIEWS),
    ])
      .then(([summary, reviews]) => {
        if (!ignore) setState({ userId, summary, reviews, error: null });
      })
      .catch((e: unknown) => {
        if (!ignore) setState({ userId, summary: null, reviews: [], error: getErrorMessage(e) });
      });
    return () => {
      ignore = true;
    };
  }, [userId]);

  // Never show the reviews of the previous person while the new ones load.
  const current = state && state.userId === userId ? state : null;
  const summary = current?.summary ?? null;
  const reviews = current?.reviews ?? [];
  const total = summary?.total_reviews ?? reviews.length;
  const topTags = (summary?.top_tags ?? []).slice(0, MAX_TOP_TAGS);

  let body: React.ReactNode;
  if (!current) {
    body = (
      <p className="text-[13px] text-ink-muted" aria-busy="true">
        {t('panel_view.reviews_loading', { defaultValue: 'Cargando reseñas…' })}
      </p>
    );
  } else if (current.error) {
    body = (
      <p role="alert" className="text-[13px] text-red-700 dark:text-red-400">
        {t('panel_view.reviews_error', { defaultValue: 'No se pudieron cargar las reseñas.' })} {current.error}
      </p>
    );
  } else if (total === 0 && reviews.length === 0) {
    body = (
      <p className="text-[13px] text-ink-muted">
        {t('panel_view.reviews_empty', { defaultValue: 'Todavía no tiene reseñas.' })}
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div>
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-xl font-semibold text-ink">
              <span aria-hidden="true" className="text-amber-600">★</span>{' '}
              {summary ? Number(summary.average_rating).toFixed(1) : '—'}
            </span>
            <span className="text-[13px] text-ink-muted">
              {t('panel_view.reviews_count', {
                count: total,
                defaultValue: '{{count}} reseñas',
                defaultValue_one: '{{count}} reseña',
                defaultValue_other: '{{count}} reseñas',
              })}
            </span>
          </p>
          {topTags.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                {t('panel_view.reviews_top_tags', { defaultValue: 'Etiquetas más frecuentes' })}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {topTags.map((tag) => (
                  <li
                    key={tag.tag_key}
                    className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
                  >
                    {t(`drivers.tag_${tag.tag_key}`, { defaultValue: humanize(tag.tag_key) })}
                    <span className="text-ink-subtle">({tag.count})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {reviews.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
              {t('panel_view.reviews_latest', { defaultValue: 'Últimas reseñas' })}
            </p>
            <ul className="flex flex-col divide-y divide-line">
              {reviews.map((r) => (
                <li key={r.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                    <Stars rating={r.rating} />
                    <span className="text-ink">{r.reviewer_first_name || '—'}</span>
                    <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>
                  </div>
                  {r.comment ? (
                    <p className="whitespace-pre-line break-words text-[13px] text-ink">{r.comment}</p>
                  ) : null}
                  {r.review_tags.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {r.review_tags.map((tag, i) => (
                        <li
                          key={`${tag.key}-${i}`}
                          className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
                        >
                          {tag.label_es || humanize(tag.key)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return <SectionCard title={t('panel_view.reviews_title', { defaultValue: 'Reseñas' })}>{body}</SectionCard>;
}
