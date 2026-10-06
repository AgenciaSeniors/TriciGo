import { describe, expect, it } from 'vitest';
import { corporateFundingVerdict, type CorporateFundingFacts } from './corporate-funding';

const CALLER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

function facts(over: Partial<CorporateFundingFacts> = {}): CorporateFundingFacts {
  return {
    account: { status: 'approved', createdBy: OTHER },
    callerIsActiveCorpAdmin: false,
    callerIsPlatformAdmin: false,
    ...over,
  };
}

describe('corporateFundingVerdict', () => {
  it('lets the creator of an approved account fund it', () => {
    expect(corporateFundingVerdict(CALLER, facts({ account: { status: 'approved', createdBy: CALLER } }))).toBe('allowed');
  });

  it('lets an active corporate admin of an approved account fund it', () => {
    expect(corporateFundingVerdict(CALLER, facts({ callerIsActiveCorpAdmin: true }))).toBe('allowed');
  });

  it.each(['pending', 'rejected', 'suspended'])('refuses a %s account, even to its creator', (status) => {
    expect(corporateFundingVerdict(CALLER, facts({ account: { status, createdBy: CALLER }, callerIsActiveCorpAdmin: true })))
      .toBe('not_approved');
  });

  it('refuses a user who does not manage the account', () => {
    expect(corporateFundingVerdict(CALLER, facts())).toBe('forbidden');
  });

  it('reports a missing account', () => {
    expect(corporateFundingVerdict(CALLER, facts({ account: null }))).toBe('not_found');
    expect(corporateFundingVerdict(CALLER, facts({ account: null, callerIsPlatformAdmin: true }))).toBe('not_found');
  });

  it('lets a platform admin fund any existing account', () => {
    expect(corporateFundingVerdict(CALLER, facts({ account: { status: 'pending', createdBy: OTHER }, callerIsPlatformAdmin: true })))
      .toBe('allowed');
  });
});
