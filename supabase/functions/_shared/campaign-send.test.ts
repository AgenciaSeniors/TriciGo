import { describe, expect, it } from 'vitest';
import { campaignEmailHtml, campaignOutcome } from './campaign-send.ts';

describe('campaignOutcome', () => {
  it('push and e-mail both worked', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: true, sent: 7 },
      { channel: 'email', ok: true, sent: 3 },
    ])).toEqual({ status: 'sent', pushSent: 7, emailSent: 3, sentCount: 7, lastError: null });
  });

  it('one channel failed and the other worked: sent, with the failure noted', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: false, sent: 0, error: 'HTTP 500' },
      { channel: 'email', ok: true, sent: 2 },
    ])).toEqual({ status: 'sent', pushSent: 0, emailSent: 2, sentCount: 2, lastError: 'push: HTTP 500' });
  });

  it('every chosen channel failed: failed', () => {
    expect(campaignOutcome([{ channel: 'email', ok: false, sent: 0, error: 'resend_not_configured' }]))
      .toEqual({ status: 'failed', pushSent: 0, emailSent: 0, sentCount: 0, lastError: 'email: resend_not_configured' });
  });

  it('no recipients and no channel call: sent with zero', () => {
    expect(campaignOutcome([])).toEqual({ status: 'sent', pushSent: 0, emailSent: 0, sentCount: 0, lastError: null });
  });

  it('the recipients could not be read: failed', () => {
    expect(campaignOutcome([], 'recipients: boom'))
      .toEqual({ status: 'failed', pushSent: 0, emailSent: 0, sentCount: 0, lastError: 'recipients: boom' });
  });

  it('keeps last_error short', () => {
    const long = 'x'.repeat(2000);
    expect(campaignOutcome([{ channel: 'push', ok: false, sent: 0, error: long }]).lastError!.length).toBe(500);
  });
});

describe('campaignEmailHtml', () => {
  it('escapes the text and keeps line breaks', () => {
    expect(campaignEmailHtml('Hola <b>Ana</b> & co\nViaja hoy')).toBe(
      '<p>Hola &lt;b&gt;Ana&lt;/b&gt; &amp; co<br/>Viaja hoy</p>',
    );
  });

  it('handles Windows line breaks', () => {
    expect(campaignEmailHtml('a\r\nb')).toBe('<p>a<br/>b</p>');
  });
});
