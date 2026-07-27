import { describe, it, expect } from 'vitest';
import { isNetworkError } from '../networkError';

describe('isNetworkError', () => {
  it('recognises the React Native fetch failure', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
  });

  it('recognises the browser and abort variants', () => {
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('Load failed'))).toBe(true);
    expect(isNetworkError(new Error('The operation was aborted'))).toBe(true);
    expect(isNetworkError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('accepts plain strings and error-shaped objects', () => {
    expect(isNetworkError('Network request failed')).toBe(true);
    expect(isNetworkError({ message: 'Failed to fetch' })).toBe(true);
  });

  // The whole point of the buffer is to retry transient failures and to NOT
  // retry decisions the server already made. Misclassifying a rejection as a
  // network blip would queue it forever.
  it('does not treat server rejections as network failures', () => {
    expect(isNetworkError(new Error('Estás a 5341 m del destino. Acércate más para confirmar.'))).toBe(false);
    expect(isNetworkError(new Error('Forbidden'))).toBe(false);
    expect(isNetworkError(new Error('Ride not found'))).toBe(false);
    expect(isNetworkError(new Error('Invalid ride transition from in_progress to accepted for role driver'))).toBe(false);
    expect(isNetworkError(new Error('use complete_ride_and_pay / cancel_ride for terminal transitions'))).toBe(false);
  });

  it('does not fire on business text that merely sounds network-ish', () => {
    expect(isNetworkError(new Error('Transaction aborted by user'))).toBe(false);
    expect(isNetworkError(new Error('Payment timed out'))).toBe(false);
  });

  it('handles empty and nullish input', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError('')).toBe(false);
    expect(isNetworkError({})).toBe(false);
  });
});
