import { describe, it, expect } from 'vitest';
import { decideIncomingOffer } from '../incomingOffer';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const at = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString();

describe('decideIncomingOffer', () => {
  it('adds an offer the app has never heard of', () => {
    expect(decideIncomingOffer(at(60), null, false, NOW)).toBe('add');
    expect(decideIncomingOffer(undefined, null, false, NOW)).toBe('add');
  });

  it('ignores the same offer heard twice (poll after realtime, or two polls)', () => {
    expect(decideIncomingOffer(at(60), { expiresAt: at(60) }, false, NOW)).toBe('ignore');
  });

  it('ignores a copy that does not expire later than the one on screen', () => {
    expect(decideIncomingOffer(at(30), { expiresAt: at(60) }, false, NOW)).toBe('ignore');
  });

  it('refreshes the card in place when support extends the live offer to a later expiry', () => {
    expect(decideIncomingOffer(at(120), { expiresAt: at(20) }, false, NOW)).toBe('replace');
  });

  it('adds it again, as news, when the copy on screen had already lapsed (a re-armed offer)', () => {
    expect(decideIncomingOffer(at(120), { expiresAt: at(-5) }, false, NOW)).toBe('add');
    expect(decideIncomingOffer(at(120), { expiresAt: at(0) }, false, NOW)).toBe('add');
  });

  it('keeps a refusal ("No me sirve") for the session, whatever the expiry', () => {
    // The normal re-offer re-arms a refused offer every few minutes with a later expiry; it must
    // not bring the card back. Support assigns directly instead.
    expect(decideIncomingOffer(at(40), null, true, NOW)).toBe('ignore');
    expect(decideIncomingOffer(at(120), null, true, NOW)).toBe('ignore');
    expect(decideIncomingOffer(undefined, null, true, NOW)).toBe('ignore');
    expect(decideIncomingOffer(at(120), { expiresAt: at(20) }, true, NOW)).toBe('ignore');
  });

  it('never refreshes a cached copy when an expiry is missing or unreadable', () => {
    expect(decideIncomingOffer(at(120), { expiresAt: undefined }, false, NOW)).toBe('ignore');
    expect(decideIncomingOffer(null, { expiresAt: at(60) }, false, NOW)).toBe('ignore');
    expect(decideIncomingOffer('not a date', { expiresAt: at(60) }, false, NOW)).toBe('ignore');
  });

  it('compares instants, not strings (the server may send another offset format)', () => {
    // 12:02:00Z written as -04:00 is later than 12:01:00Z even though it sorts earlier as text.
    expect(decideIncomingOffer('2026-10-07T08:02:00-04:00', { expiresAt: '2026-10-07T12:01:00Z' }, false, NOW)).toBe(
      'replace',
    );
  });
});
