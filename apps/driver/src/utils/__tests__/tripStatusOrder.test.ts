import { describe, it, expect } from 'vitest';
import { isStatusAhead } from '../tripStatusOrder';

describe('isStatusAhead (what the server says vs what the screen shows)', () => {
  it('is true for a later active status', () => {
    expect(isStatusAhead('arrived_at_pickup', 'driver_en_route')).toBe(true);
    expect(isStatusAhead('in_progress', 'accepted')).toBe(true);
    expect(isStatusAhead('arrived_at_destination', 'in_progress')).toBe(true);
  });

  it('is false for the same or an earlier status, so a slow answer never moves the screen back', () => {
    expect(isStatusAhead('in_progress', 'in_progress')).toBe(false);
    expect(isStatusAhead('driver_en_route', 'arrived_at_pickup')).toBe(false);
  });

  it('is false for anything outside the active path (completion and release have their own handling)', () => {
    expect(isStatusAhead('completed', 'in_progress')).toBe(false);
    expect(isStatusAhead('searching', 'accepted')).toBe(false);
    expect(isStatusAhead(undefined, 'accepted')).toBe(false);
    expect(isStatusAhead('in_progress', null)).toBe(false);
  });
});
