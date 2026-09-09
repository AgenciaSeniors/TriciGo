import { describe, it, expect } from 'vitest';
import { classifyPushPermission } from '../pushRegistration';

describe('classifyPushPermission — why a device has no push token', () => {
  it('reports granted when the OS permission is already given', () => {
    expect(classifyPushPermission({ status: 'granted', canAskAgain: true })).toBe('granted');
    // Granted wins even if the OS says it would not ask again — there is
    // nothing left to ask for.
    expect(classifyPushPermission({ status: 'granted', canAskAgain: false })).toBe('granted');
  });

  it('reports never_asked while the permission is still undetermined', () => {
    // Android 13+ / iOS before the one-shot dialog has been spent. This is the
    // outcome that means WE have a problem: nobody ever put the question to
    // the user, so a missing token is our fault, not their choice.
    expect(classifyPushPermission({ status: 'undetermined', canAskAgain: true })).toBe('never_asked');
  });

  it('reports blocked when the OS will never prompt again', () => {
    // Android 13+ marks POST_NOTIFICATIONS permanently denied after the first
    // refusal. Only system Settings can undo it, so the app must stop asking
    // and start deep-linking.
    expect(classifyPushPermission({ status: 'denied', canAskAgain: false })).toBe('blocked');
  });

  it('reports denied when the user refused but the OS would still ask', () => {
    expect(classifyPushPermission({ status: 'denied', canAskAgain: true })).toBe('denied');
  });

  it('treats an unaskable permission as blocked whatever the status string says', () => {
    // canAskAgain is the load-bearing field: it decides whether a prompt can
    // still recover the user. Trust it over an unfamiliar status.
    expect(classifyPushPermission({ status: 'undetermined', canAskAgain: false })).toBe('blocked');
  });

  it('falls back to denied on a missing or unknown snapshot', () => {
    // Never invent 'never_asked' (which would read as our bug) or 'blocked'
    // (which would read as permanent) out of missing data.
    expect(classifyPushPermission({})).toBe('denied');
    expect(classifyPushPermission({ status: null, canAskAgain: null })).toBe('denied');
    expect(classifyPushPermission({ status: 'provisional' })).toBe('denied');
  });
});
