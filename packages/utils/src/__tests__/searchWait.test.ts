import { describe, it, expect } from 'vitest';
import {
  SEARCH_TYPICAL_WAIT_S,
  SEARCH_LONG_WAIT_S,
  searchWaitStage,
  searchWaitView,
} from '../searchWait';

describe('searchWaitStage — what to tell a rider who is still waiting', () => {
  it('opens with the expectation-setting stage', () => {
    expect(searchWaitStage(0)).toBe('opening');
    expect(searchWaitStage(14)).toBe('opening');
  });

  it('says nothing extra through the stretch where most rides are accepted', () => {
    // Measured 2026-09-10 over the 29 rides with a real accepted offer:
    // p50 = 29 s, p75 = 72 s. Chatter here would be noise.
    expect(searchWaitStage(15)).toBe('normal');
    expect(searchWaitStage(44)).toBe('normal');
  });

  it('reassures through the long tail instead of declaring failure', () => {
    // The app used to replace this whole stretch with "No encontramos
    // conductor" at 120 s, while dispatch was still running and 6 of those
    // 29 rides (21 %) had not been accepted yet.
    expect(searchWaitStage(45)).toBe('extended');
    expect(searchWaitStage(119)).toBe('extended');
    expect(searchWaitStage(SEARCH_TYPICAL_WAIT_S)).toBe('extended');
    expect(searchWaitStage(179)).toBe('extended');
  });

  it('admits it is taking longer than usual past the 90th percentile', () => {
    // p90 = 145 s; only one real ride was ever accepted after 180 s.
    expect(searchWaitStage(SEARCH_LONG_WAIT_S)).toBe('long');
    expect(searchWaitStage(600)).toBe('long');
    expect(searchWaitStage(99999)).toBe('long');
  });

  it('never breaks on a nonsense clock', () => {
    // A negative or NaN elapsed must not skip the rider to the last stage.
    expect(searchWaitStage(-10)).toBe('opening');
    expect(searchWaitStage(Number.NaN)).toBe('opening');
  });

  it('keeps the long mark beyond the typical wait', () => {
    // If these ever crossed, the "taking longer" copy would appear before
    // the progress bar had even finished its normal run.
    expect(SEARCH_LONG_WAIT_S).toBeGreaterThan(SEARCH_TYPICAL_WAIT_S);
  });
});

describe('searchWaitView — everything the waiting screen decides', () => {
  const view = (elapsedSeconds: number, pendingOfferCount = 0, offerSecondsLeft: number | null = null) =>
    searchWaitView({ elapsedSeconds, pendingOfferCount, offerSecondsLeft });

  it('sets the expectation, then gets out of the way', () => {
    expect(view(0)).toMatchObject({ hint: 'typical', longNotice: false, progress: 'typical' });
    expect(view(20)).toMatchObject({ hint: null, longNotice: false, progress: 'typical' });
  });

  it('reassures through the long tail', () => {
    expect(view(60)).toMatchObject({ hint: 'still_searching', longNotice: false });
    expect(view(150)).toMatchObject({ hint: 'still_searching', longNotice: false });
  });

  it('explains itself once the wait is unusual', () => {
    expect(view(180)).toMatchObject({ stage: 'long', hint: null, longNotice: true });
    expect(view(900)).toMatchObject({ stage: 'long', hint: null, longNotice: true });
  });

  it('says nothing extra while a driver is actually deciding', () => {
    // A live "1 conductor evaluando · 45s" countdown answers the question the
    // hints exist to answer. Stacking "seguimos buscando" or "está tardando"
    // on top of it contradicts the more specific, more useful message.
    expect(view(5, 1, 45)).toMatchObject({ hint: null, longNotice: false });
    expect(view(60, 2, 30)).toMatchObject({ hint: null, longNotice: false });
    expect(view(300, 1, 20)).toMatchObject({ hint: null, longNotice: false });
  });

  it('gives the offer countdown the progress bar whenever one is live', () => {
    // The offer window is a REAL deadline (offer_ttl_seconds) — unlike the
    // wait itself. It outranks both other bar modes.
    expect(view(5, 1, 30).progress).toBe('offer');
    expect(view(600, 1, 12).progress).toBe('offer');
  });

  it('hands the bar off to an indeterminate sweep past the typical wait', () => {
    // A bar pinned at 100 % over a search that is still running reads as
    // finished. This is the whole reason the sweep exists.
    expect(view(119).progress).toBe('typical');
    expect(view(SEARCH_TYPICAL_WAIT_S).progress).toBe('sweep');
    expect(view(5000).progress).toBe('sweep');
  });

  it('treats an expired countdown as no countdown', () => {
    // offerSecondsLeft ticks to 0 before the poll clears it; 0 is not a live
    // window, and rendering a 0 %-wide bar would look like a frozen screen.
    expect(view(200, 1, 0).progress).toBe('sweep');
    expect(view(30, 1, 0).progress).toBe('typical');
  });

  it('NEVER produces a failure state, at any point in the wait', () => {
    // The regression this whole change exists to prevent. The server keeps
    // dispatching for as long as this screen is open, so there is no elapsed
    // time at which the app may claim the search is over.
    for (const t of [0, 1, 119, 120, 121, 179, 180, 600, 601, 3600, 86400]) {
      const v = view(t);
      expect(['typical', 'sweep', 'offer']).toContain(v.progress);
      expect(v).not.toHaveProperty('failed');
    }
  });

  it('survives a nonsense clock without escalating', () => {
    expect(view(Number.NaN)).toMatchObject({ stage: 'opening', hint: 'typical', longNotice: false, progress: 'typical' });
    expect(view(-99)).toMatchObject({ stage: 'opening', progress: 'typical' });
  });
});
