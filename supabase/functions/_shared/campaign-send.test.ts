import { describe, expect, it } from 'vitest';
import {
  campaignChannels,
  campaignEmailHtml,
  campaignOutcome,
  chunkIds,
  MAX_ERROR,
  mergeChannelResults,
  RECIPIENT_CHUNK,
} from './campaign-send.ts';

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
    expect(campaignOutcome([{ channel: 'push', ok: false, sent: 0, error: long }]).lastError!.length).toBe(MAX_ERROR);
    expect(MAX_ERROR).toBe(500);
  });

  it('a channel that worked with some batches failing: sent, its error noted', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: true, sent: 600, error: '1/3 batches failed: HTTP 500' },
      { channel: 'email', ok: true, sent: 40 },
    ])).toEqual({
      status: 'sent', pushSent: 600, emailSent: 40, sentCount: 600, lastError: 'push: 1/3 batches failed: HTTP 500',
    });
  });

  it('a partial failure on one channel and a full failure on the other: still sent, both noted', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: true, sent: 300, error: '1/2 batches failed: boom' },
      { channel: 'email', ok: false, sent: 0, error: 'resend_not_configured' },
    ])).toEqual({
      status: 'sent', pushSent: 300, emailSent: 0, sentCount: 300,
      lastError: 'push: 1/2 batches failed: boom · email: resend_not_configured',
    });
  });
});

describe('campaignChannels', () => {
  it('maps each known channel to the channels it sends, push first', () => {
    expect(campaignChannels('push')).toEqual(['push']);
    expect(campaignChannels('email')).toEqual(['email']);
    expect(campaignChannels('both')).toEqual(['push', 'email']);
  });

  it('anything else is unknown (the column has no CHECK)', () => {
    for (const v of ['sms', 'PUSH', '', null, undefined, 3]) expect(campaignChannels(v)).toBeNull();
  });
});

describe('chunkIds', () => {
  it('splits into chunks of at most the given size, in order', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `u${i}`);
    expect(chunkIds(ids, 3)).toEqual([['u0', 'u1', 'u2'], ['u3', 'u4', 'u5'], ['u6']]);
  });

  it('no ids: no chunks', () => {
    expect(chunkIds([], 300)).toEqual([]);
  });

  it('the default chunk keeps a call under the PostgREST URL limit', () => {
    expect(RECIPIENT_CHUNK).toBe(300);
    expect(chunkIds(Array.from({ length: 1000 }, (_, i) => `u${i}`)).map((c) => c.length)).toEqual([300, 300, 300, 100]);
  });

  it('rejects a size below 1', () => {
    expect(() => chunkIds(['a'], 0)).toThrow();
  });
});

describe('mergeChannelResults', () => {
  it('every batch worked: ok, counts summed, no error', () => {
    expect(mergeChannelResults('push', [
      { channel: 'push', ok: true, sent: 280 },
      { channel: 'push', ok: true, sent: 290 },
    ])).toEqual({ channel: 'push', ok: true, sent: 570 });
  });

  it('one batch failed: ok, the others summed, the failure counted with the first error', () => {
    expect(mergeChannelResults('email', [
      { channel: 'email', ok: true, sent: 10 },
      { channel: 'email', ok: false, sent: 0, error: 'HTTP 500' },
      { channel: 'email', ok: true, sent: 12 },
      { channel: 'email', ok: false, sent: 0, error: 'timeout' },
    ])).toEqual({ channel: 'email', ok: true, sent: 22, error: '2/4 batches failed: HTTP 500' });
  });

  it('every batch failed: failed', () => {
    expect(mergeChannelResults('push', [
      { channel: 'push', ok: false, sent: 0, error: 'HTTP 400' },
      { channel: 'push', ok: false, sent: 0, error: 'HTTP 400' },
    ])).toEqual({ channel: 'push', ok: false, sent: 0, error: '2/2 batches failed: HTTP 400' });
  });

  it('a single batch keeps its error as is', () => {
    expect(mergeChannelResults('push', [{ channel: 'push', ok: false, sent: 0, error: 'boom' }]))
      .toEqual({ channel: 'push', ok: false, sent: 0, error: 'boom' });
  });

  it('a failed batch without an error message still counts', () => {
    expect(mergeChannelResults('push', [
      { channel: 'push', ok: true, sent: 5 },
      { channel: 'push', ok: false, sent: 0 },
    ])).toEqual({ channel: 'push', ok: true, sent: 5, error: '1/2 batches failed: error' });
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
