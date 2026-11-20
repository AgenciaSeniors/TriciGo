import {
  type CancellationRatingImpact,
  type CancellationReasonCode,
  isExemptCancellationReason,
} from '@tricigo/types';

/**
 * Which notice the cancel sheet shows under the reasons.
 *
 * - `penalized`: cancelling now lowers the rider's rating.
 * - `none_safety`: an exempt reason (safety). Never penalized (00486), so the
 *   sheet can say why.
 * - `none`: the server projects no penalty. The reason can be the free minutes
 *   after the driver accepts or the first late cancel of the last 24 hours, and
 *   the preview does not say which, so the sheet only says "no penalty". It
 *   used to add "(primera cancelación del día)" to every case (QA R2-04).
 * - `unknown`: the preview failed. Claiming "no penalty" could be false.
 * - `null`: nothing yet (no reason picked, or the preview is still loading).
 */
export type CancelPenaltyNotice = 'penalized' | 'none_safety' | 'none' | 'unknown';

export function cancelPenaltyNotice({
  reason,
  ratingImpact,
  previewLoading = false,
}: {
  reason: CancellationReasonCode | null;
  ratingImpact: CancellationRatingImpact | null | undefined;
  previewLoading?: boolean;
}): CancelPenaltyNotice | null {
  if (!reason) return null;
  if (isExemptCancellationReason(reason)) return 'none_safety';
  if (ratingImpact) return ratingImpact.rating_penalized ? 'penalized' : 'none';
  return previewLoading ? null : 'unknown';
}
