import { describe, expect, it } from 'vitest';
import { EMAIL_NOTICE_SNOOZE_MS, emailNoticeErrorKey, emailNoticeVisible, profileEmailSavePlan } from '../emailNotice';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('emailNoticeVisible', () => {
  it('shows only for an unconfirmed address', () => {
    expect(emailNoticeVisible('unconfirmed', null, NOW)).toBe(true);
    expect(emailNoticeVisible('proven', null, NOW)).toBe(false);
    expect(emailNoticeVisible('none', null, NOW)).toBe(false);
    expect(emailNoticeVisible(null, null, NOW)).toBe(false);
    expect(emailNoticeVisible(undefined, null, NOW)).toBe(false);
  });

  it('stays hidden for 7 days after "Ahora no", then comes back', () => {
    expect(EMAIL_NOTICE_SNOOZE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(emailNoticeVisible('unconfirmed', NOW - EMAIL_NOTICE_SNOOZE_MS + 1, NOW)).toBe(false);
    expect(emailNoticeVisible('unconfirmed', NOW - EMAIL_NOTICE_SNOOZE_MS, NOW)).toBe(true);
  });

  it('a dismissal stamped in the future (clock moved back) does not hide it for good', () => {
    expect(emailNoticeVisible('unconfirmed', NOW + 60_000, NOW)).toBe(true);
  });

  it('ignores a dismissal that is not a finite number', () => {
    expect(emailNoticeVisible('unconfirmed', Number.NaN, NOW)).toBe(true);
  });
});

describe('emailNoticeErrorKey', () => {
  it('maps the codes the resend can fail with to their message', () => {
    expect(emailNoticeErrorKey('rate_limited')).toBe('email_notice.error_rate_limited');
    expect(emailNoticeErrorKey('email_already_taken')).toBe('email_notice.error_taken');
    expect(emailNoticeErrorKey('invalid_email')).toBe('email_notice.error_generic');
    expect(emailNoticeErrorKey(undefined)).toBe('email_notice.error_generic');
  });
});

describe('profileEmailSavePlan', () => {
  it('an unchanged address writes nothing, even typed with other capitals or spaces', () => {
    // Rewriting "ana@x.com" as "Ana@X.com" would clear its confirmation (00611).
    expect(profileEmailSavePlan('ana@x.com', 'ana@x.com')).toEqual({ clear: false, send: null });
    expect(profileEmailSavePlan(' Ana@X.com ', 'ana@x.com')).toEqual({ clear: false, send: null });
  });

  it('a new address is sent for confirmation, trimmed, and never written directly', () => {
    expect(profileEmailSavePlan(' new@x.com ', 'ana@x.com')).toEqual({ clear: false, send: 'new@x.com' });
  });

  it('a first address on a phone account counts as new', () => {
    expect(profileEmailSavePlan('ana@x.com', 'phone_5355555555@tricigo.app')).toEqual({ clear: false, send: 'ana@x.com' });
    expect(profileEmailSavePlan('ana@x.com', null)).toEqual({ clear: false, send: 'ana@x.com' });
  });

  it('emptying the field clears the address', () => {
    expect(profileEmailSavePlan('  ', 'ana@x.com')).toEqual({ clear: true, send: null });
  });

  it('an empty field on an account without a real address does nothing', () => {
    expect(profileEmailSavePlan('', null)).toEqual({ clear: false, send: null });
    expect(profileEmailSavePlan('', 'phone_5355555555@tricigo.app')).toEqual({ clear: false, send: null });
  });
});
