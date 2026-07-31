import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CouponValidation } from '@tricigo/types';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { partnerPlaceService } from '../partner-place.service';

const COUPON = '11111111-1111-1111-1111-111111111111';
const TOKEN = 'a7f3k2b91c04';

describe('partnerPlaceService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getNearby', () => {
    it('maps lat/lng/limit to the RPC params', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await partnerPlaceService.getNearby(23.1136, -82.3666, 5);
      expect(mockRpc).toHaveBeenCalledWith('get_nearby_partner_places', {
        p_lat: 23.1136, p_lng: -82.3666, p_limit: 5,
      });
    });

    it('returns the rows', async () => {
      const rows = [{ id: 'a', name: 'Sylvain', benefit_title: 'Café gratis' }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual(rows);
    });

    // The migration ships to git before anyone applies it to prod (the MCP
    // guard blocks production DDL). A missing RPC must degrade to "no section",
    // never to a crash or an error toast on the passenger's home screen.
    it('returns [] when the RPC does not exist yet', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual([]);
    });

    it('returns [] on any other error rather than throwing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'denied' } });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual([]);
    });

    it('returns [] when data is null without an error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual([]);
    });
  });

  describe('getMyCoupons', () => {
    it('calls the RPC with no arguments', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await partnerPlaceService.getMyCoupons();
      expect(mockRpc).toHaveBeenCalledWith('get_my_partner_coupons', {});
    });

    it('returns [] when the RPC is absent', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'nope' } });
      expect(await partnerPlaceService.getMyCoupons()).toEqual([]);
    });
  });

  describe('validateCode', () => {
    it('passes the business token and the raw code — the RPC normalises the code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'valid' }, error: null });
      await partnerPlaceService.validateCode(TOKEN, 'tg-k7m2qx');
      expect(mockRpc).toHaveBeenCalledWith('validate_partner_coupon', {
        p_token: TOKEN, p_code: 'tg-k7m2qx',
      });
    });

    it('returns the verdict object', async () => {
      const verdict = { status: 'valid', place_name: 'Sylvain', customer: 'Eduardo P.' };
      mockRpc.mockResolvedValueOnce({ data: verdict, error: null });
      expect(await partnerPlaceService.validateCode(TOKEN, 'K7M2QX')).toEqual(verdict);
    });

    // This one is public and business-facing: an error must surface, not be
    // swallowed into a green screen that makes the shop give away a coffee.
    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.validateCode(TOKEN, 'K7M2QX')).rejects.toEqual(err);
    });
  });

  describe('redeemCode', () => {
    it('calls redeem_partner_coupon with token and code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'redeemed' }, error: null });
      expect(await partnerPlaceService.redeemCode(TOKEN, 'K7M2QX')).toEqual({ status: 'redeemed' });
      expect(mockRpc).toHaveBeenCalledWith('redeem_partner_coupon', {
        p_token: TOKEN, p_code: 'K7M2QX',
      });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.redeemCode(TOKEN, 'K7M2QX')).rejects.toEqual(err);
    });
  });

  describe('redeemOwn', () => {
    it('calls redeem_own_partner_coupon with the coupon id', async () => {
      mockRpc.mockResolvedValueOnce({ data: { status: 'redeemed' }, error: null });
      await partnerPlaceService.redeemOwn(COUPON);
      expect(mockRpc).toHaveBeenCalledWith('redeem_own_partner_coupon', { p_coupon_id: COUPON });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.redeemOwn(COUPON)).rejects.toEqual(err);
    });

    // redeem_own_partner_coupon (00531) is the only RPC of the five that can
    // answer with these two, and both are ordinary outcomes rather than faults:
    // 'unavailable' is what a passenger gets for double-tapping "Ya lo usé" or
    // tapping it after the coupon expired, and it must reach the caller intact
    // so the ticket screen can say which. The explicit CouponValidation
    // annotation is the point of these two tests as much as the round-trip is:
    // it makes tsc — not a reviewer's memory — verify that the status union
    // actually covers what the SQL emits.
    it('passes an "unavailable" verdict through untouched', async () => {
      const verdict: CouponValidation = { status: 'unavailable' };
      mockRpc.mockResolvedValueOnce({ data: verdict, error: null });
      expect(await partnerPlaceService.redeemOwn(COUPON)).toEqual({ status: 'unavailable' });
    });

    it('passes an "unauthenticated" verdict through untouched', async () => {
      const verdict: CouponValidation = { status: 'unauthenticated' };
      mockRpc.mockResolvedValueOnce({ data: verdict, error: null });
      expect(await partnerPlaceService.redeemOwn(COUPON)).toEqual({ status: 'unauthenticated' });
    });
  });
});
