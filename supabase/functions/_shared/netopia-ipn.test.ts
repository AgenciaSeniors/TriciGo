import { describe, expect, it } from 'vitest';
import { requeryOrderMismatch, startNtpId } from './netopia-ipn';

const ORDER = '8c1b25c4-9c44-4f05-b2a2-fa261f7611aa';

describe('requeryOrderMismatch', () => {
  it('is false when NETOPIA does not echo an order', () => {
    expect(requeryOrderMismatch({ payment: { status: 3 } }, ORDER)).toBe(false);
    expect(requeryOrderMismatch({}, ORDER)).toBe(false);
    expect(requeryOrderMismatch(null, ORDER)).toBe(false);
  });

  it('is false when the echoed order is ours, in any case', () => {
    expect(requeryOrderMismatch({ order: { orderID: ORDER } }, ORDER)).toBe(false);
    expect(requeryOrderMismatch({ order: { orderID: ORDER.toUpperCase() } }, ORDER)).toBe(false);
  });

  it('is true when NETOPIA reports the transaction under another order', () => {
    expect(requeryOrderMismatch({ order: { orderID: 'bb5193ac-1648-41bb-b29e-cdaed0020c81' } }, ORDER)).toBe(true);
  });

  it('ignores an echoed order that is not a string', () => {
    expect(requeryOrderMismatch({ order: { orderID: 42 } }, ORDER)).toBe(false);
  });
});

describe('startNtpId', () => {
  it('reads the transaction id NETOPIA returns when a payment starts', () => {
    expect(startNtpId({ payment: { ntpID: '525385531', paymentURL: 'https://x' } })).toBe('525385531');
    expect(startNtpId({ payment: { ntpID: 525385531 } })).toBe('525385531');
    expect(startNtpId({ payment: { ntpID: '  525385531 ' } })).toBe('525385531');
  });

  it('is null when the answer carries no usable id', () => {
    expect(startNtpId({ payment: { paymentURL: 'https://x' } })).toBeNull();
    expect(startNtpId({ payment: { ntpID: '' } })).toBeNull();
    expect(startNtpId({ payment: { ntpID: '   ' } })).toBeNull();
    expect(startNtpId({ payment: { ntpID: null } })).toBeNull();
    expect(startNtpId({ payment: { ntpID: { id: 1 } } })).toBeNull();
    expect(startNtpId({})).toBeNull();
    expect(startNtpId(null)).toBeNull();
  });
});
