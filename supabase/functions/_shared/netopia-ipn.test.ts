import { describe, expect, it } from 'vitest';
import { requeryOrderMismatch } from './netopia-ipn';

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
