import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { MISSED_RIDES_UNAVAILABLE, missedRideService } from '../missed-ride.service';

const ok = (data: unknown) => ({ data, error: null });
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };

beforeEach(() => {
  mockRpc.mockReset();
});

describe('missedRideService.list', () => {
  it('asks for a view and a window and returns numbers as numbers', async () => {
    mockRpc.mockResolvedValueOnce(ok([{ user_id: 'u-1', failed_requests: '2', contacts: '0', coupon_status: 'none' }]));
    const rows = await missedRideService.list('pending', 30);
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_riders', { p_view: 'pending', p_days: 30 });
    expect(rows[0]).toMatchObject({ user_id: 'u-1', failed_requests: 2, contacts: 0 });
  });

  it('passes no window for everything', async () => {
    mockRpc.mockResolvedValueOnce(ok([]));
    await missedRideService.list('contacted', null);
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_riders', { p_view: 'contacted', p_days: null });
  });

  it('says the function is not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce(MISSING);
    const err = await missedRideService.list('pending', 30).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(MISSED_RIDES_UNAVAILABLE);
  });

  it('rethrows any other database error', async () => {
    const dbErr = { code: '42501', message: 'Solo el equipo de operaciones ve esta lista.' };
    mockRpc.mockResolvedValueOnce({ data: null, error: dbErr });
    await expect(missedRideService.list('pending', 30)).rejects.toBe(dbErr);
  });
});

describe('missedRideService.currentCoupon', () => {
  it('returns the coupon in use', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      id: 'p-1', code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500,
      valid_until: null, max_uses: 100, current_uses: 3,
    }));
    await expect(missedRideService.currentCoupon()).resolves.toEqual({
      id: 'p-1', code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500,
      valid_until: null, max_uses: 100, current_uses: 3,
    });
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_ride_coupon', {});
  });

  it('returns null when there is none', async () => {
    mockRpc.mockResolvedValueOnce(ok(null));
    await expect(missedRideService.currentCoupon()).resolves.toBeNull();
  });
});

describe('missedRideService.contact', () => {
  it('records the contact and returns the phone and the coupon', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      success: true, phone: '5355500001', full_name: 'Ana Pérez', last_failed_at: '2026-10-28T15:00:00+00:00',
      coupon: { code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500, valid_until: null },
      coupon_reason: null,
    }));
    await expect(missedRideService.contact('u-1', '2026-10-28T15:00:00+00:00')).resolves.toEqual({
      phone: '5355500001',
      fullName: 'Ana Pérez',
      lastFailedAt: '2026-10-28T15:00:00+00:00',
      coupon: { code: 'PERDON', type: 'fixed_discount', discountPercent: null, discountFixedCup: 500, validUntil: null },
      couponReason: null,
    });
    expect(mockRpc).toHaveBeenCalledWith('ops_contact_missed_rider', {
      p_user_id: 'u-1', p_expected_last_failed_at: '2026-10-28T15:00:00+00:00',
    });
  });

  it('returns the reason when there is no coupon', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      success: true, phone: '5355500001', full_name: null, last_failed_at: '2026-10-28T15:00:00+00:00',
      coupon: null, coupon_reason: 'already_given',
    }));
    const r = await missedRideService.contact('u-1', '2026-10-28T15:00:00+00:00');
    expect(r.coupon).toBeNull();
    expect(r.couponReason).toBe('already_given');
  });

  it("throws the server's refusal as an AppError with its code", async () => {
    mockRpc.mockResolvedValueOnce(ok({ error: 'missed_rider_changed' }));
    const err = await missedRideService.contact('u-1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('missed_rider_changed');
  });

  it('says the function is not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce(MISSING);
    const err = await missedRideService.contact('u-1', 'x').catch((e: unknown) => e);
    expect((err as AppError).code).toBe(MISSED_RIDES_UNAVAILABLE);
  });
});
