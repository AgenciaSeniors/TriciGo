import { describe, expect, it } from 'vitest';
import type { CancellationRatingImpact } from '@tricigo/types';
import { cancelPenaltyNotice } from '../cancelPenaltyNotice';
import { defaultRechargeAmountUsd } from '../rechargeAmount';
import { chatSenderName } from '../chatSender';

const impact = (over: Partial<CancellationRatingImpact> = {}): CancellationRatingImpact => ({
  rating_penalized: false,
  is_grace: true,
  cancel_count_24h: 0,
  rating_value: null,
  stars_before: 4.8,
  stars_after: 4.8,
  ...over,
});

// R2-04: the sheet said "Sin penalización (primera cancelación del día)" for
// every no-penalty case, including a safety cancel (never penalized) and the
// two free minutes after the driver accepts.
describe('cancelPenaltyNotice', () => {
  it('shows nothing until a reason is picked', () => {
    expect(cancelPenaltyNotice({ reason: null, ratingImpact: impact() })).toBeNull();
  });

  it('warns when cancelling lowers the rating', () => {
    expect(
      cancelPenaltyNotice({ reason: 'changed_plans', ratingImpact: impact({ rating_penalized: true }) }),
    ).toBe('penalized');
  });

  it('gives the real reason for a safety cancel, even when a penalty was projected', () => {
    expect(
      cancelPenaltyNotice({ reason: 'safety', ratingImpact: impact({ rating_penalized: true }) }),
    ).toBe('none_safety');
    expect(cancelPenaltyNotice({ reason: 'safety', ratingImpact: null })).toBe('none_safety');
  });

  it('says only "no penalty" when the server projects none for another reason', () => {
    expect(cancelPenaltyNotice({ reason: 'changed_plans', ratingImpact: impact() })).toBe('none');
  });

  it('does not claim "no penalty" when the preview failed', () => {
    expect(cancelPenaltyNotice({ reason: 'changed_plans', ratingImpact: null })).toBe('unknown');
    expect(
      cancelPenaltyNotice({ reason: 'changed_plans', ratingImpact: null, previewLoading: true }),
    ).toBeNull();
  });
});

// R2-10: the amount field showed a grey "20" placeholder while "Pagar con
// tarjeta" stayed disabled until the rider tapped the "$20" chip.
describe('defaultRechargeAmountUsd', () => {
  it('preselects the smallest preset the minimum allows', () => {
    expect(defaultRechargeAmountUsd([20, 50, 100, 200], 20)).toBe('20');
    expect(defaultRechargeAmountUsd([20, 50, 100, 200], 30)).toBe('50');
  });

  it('falls back to the minimum when no preset reaches it', () => {
    expect(defaultRechargeAmountUsd([20, 50], 75)).toBe('75');
  });
});

// R2-14: the chat announced the driver's messages as "Chat con conductor dijo: …".
describe('chatSenderName', () => {
  it('uses the first name of the person writing', () => {
    expect(chatSenderName('María Pérez García', 'El conductor')).toBe('María');
    expect(chatSenderName('  Carlos  ', 'El conductor')).toBe('Carlos');
  });

  it('falls back when there is no name yet', () => {
    expect(chatSenderName(null, 'El conductor')).toBe('El conductor');
    expect(chatSenderName('   ', 'El conductor')).toBe('El conductor');
  });
});
