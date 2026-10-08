import { describe, expect, it } from 'vitest';
import { EMAIL_NOTICE_SNOOZE_MS, emailNoticeErrorKey, emailNoticeVisible } from '../emailNotice';

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
