import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockInvoke = vi.fn();
const mockGetPublicUrl = vi.fn(() => ({ data: { publicUrl: 'https://cdn/partner-photos/x.jpg' } }));
const mockSupabase = {
  rpc: mockRpc,
  functions: { invoke: mockInvoke },
  storage: { from: vi.fn(() => ({ getPublicUrl: mockGetPublicUrl })) },
};

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { partnerPlaceService } from '../partner-place.service';

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
      const rows = [{ id: 'a', name: 'Sylvain', discount_percent: 20 }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      expect(await partnerPlaceService.getNearby(1, 2)).toEqual(rows);
    });

    // The migration is merged before anyone applies it to prod (MCP guard), so
    // the RPC is legitimately missing for a while. A missing carousel is
    // invisible; a crashing home screen is not.
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
  });

  describe('getDiscountForDropoff', () => {
    it('maps the dropoff and fare to the RPC params, defaulting to a passenger ride', async () => {
      mockRpc.mockResolvedValueOnce({ data: { found: false }, error: null });
      await partnerPlaceService.getDiscountForDropoff(23.1136, -82.3666, 2000);
      expect(mockRpc).toHaveBeenCalledWith('get_partner_discount_for_dropoff', {
        p_lat: 23.1136, p_lng: -82.3666, p_fare_cup: 2000, p_ride_mode: 'passenger',
      });
    });

    // A delivery gets no partner discount (00564): the person who collects the
    // parcel is the one standing in the shop, and the one who saves is someone
    // else. Passing the mode keeps what is SHOWN equal to what is CHARGED.
    it('passes cargo through so a delivery shows no discount', async () => {
      mockRpc.mockResolvedValueOnce({ data: { found: false }, error: null });
      await partnerPlaceService.getDiscountForDropoff(23.1136, -82.3666, 2000, 'cargo');
      expect(mockRpc).toHaveBeenCalledWith('get_partner_discount_for_dropoff', {
        p_lat: 23.1136, p_lng: -82.3666, p_fare_cup: 2000, p_ride_mode: 'cargo',
      });
    });

    it('returns the discount when the dropoff is at a partner place', async () => {
      const verdict = {
        found: true, place_id: 'p1', place_name: 'Sylvain',
        discount_percent: 10, discount_cup: 200,
      };
      mockRpc.mockResolvedValueOnce({ data: verdict, error: null });
      expect(await partnerPlaceService.getDiscountForDropoff(1, 2, 2000)).toEqual(verdict);
    });

    // Display-only path. Showing no discount is a small loss; blocking the
    // fare estimate — and with it the whole booking flow — is not.
    it('returns found:false when the RPC does not exist yet', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      });
      expect(await partnerPlaceService.getDiscountForDropoff(1, 2, 2000)).toEqual({ found: false });
    });

    it('returns found:false on any other error rather than throwing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
      expect(await partnerPlaceService.getDiscountForDropoff(1, 2, 2000)).toEqual({ found: false });
    });

    // The server is the authority; a null payload must not become `found: true`.
    it('returns found:false when the RPC answers with nothing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      expect(await partnerPlaceService.getDiscountForDropoff(1, 2, 2000)).toEqual({ found: false });
    });
  });

  describe('uploadPhoto', () => {
    const file = new Blob(['x'], { type: 'image/jpeg' });

    it('uploads through the storage-upload Edge Function, under places/', async () => {
      mockInvoke.mockResolvedValueOnce({ data: {}, error: null });
      await partnerPlaceService.uploadPhoto(file, 'place-1');

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      const call = mockInvoke.mock.calls[0] as [string, { body: FormData }];
      expect(call[0]).toBe('storage-upload');
      const fd = call[1].body;
      expect(fd.get('bucket')).toBe('partner-photos');
      expect(fd.get('contentType')).toBe('image/jpeg');
      // The EF's authz branch requires the places/ prefix and >= 3 segments.
      expect(String(fd.get('path'))).toMatch(/^places\/place-1\/\d+\.jpg$/);
    });

    it('returns the public URL of the uploaded object', async () => {
      mockInvoke.mockResolvedValueOnce({ data: {}, error: null });
      const url = await partnerPlaceService.uploadPhoto(file, 'place-1');
      expect(url).toBe('https://cdn/partner-photos/x.jpg');
    });

    it('generates a path even when the place has no id yet', async () => {
      mockInvoke.mockResolvedValueOnce({ data: {}, error: null });
      await partnerPlaceService.uploadPhoto(file, null);
      const call = mockInvoke.mock.calls[0] as [string, { body: FormData }];
      expect(String(call[1].body.get('path'))).toMatch(/^places\/[^/]+\/\d+\.jpg$/);
    });

    // Unlike the readers, this THROWS. An upload that fails silently leaves the
    // admin believing they saved a photo that does not exist.
    it('propagates a transport error', async () => {
      const err = new Error('network down');
      mockInvoke.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.uploadPhoto(file, 'p')).rejects.toThrow('network down');
    });

    // The EF answers 200 with an { error } body for authz/MIME rejections, so a
    // caller that only checks `error` would treat a 403 as a successful upload.
    it('propagates an error returned inside a 200 body', async () => {
      mockInvoke.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
      await expect(partnerPlaceService.uploadPhoto(file, 'p')).rejects.toThrow('forbidden');
    });
  });

  describe('adminList', () => {
    it('calls the RPC with no arguments', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await partnerPlaceService.adminList();
      expect(mockRpc).toHaveBeenCalledWith('admin_list_partner_places', {});
    });

    // An admin staring at an empty table has to know the call failed, rather
    // than believing there are no partner places.
    it('propagates the RPC error', async () => {
      const err = { message: 'admin only', code: '42501' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.adminList()).rejects.toEqual(err);
    });
  });

  describe('adminUpsert', () => {
    it('maps the form to the RPC params, with a percentage and no coupon fields', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'new-id', error: null });
      const id = await partnerPlaceService.adminUpsert({
        id: null,
        name: 'Sylvain',
        category: 'cafe',
        latitude: 23.1,
        longitude: -82.3,
        discount_percent: 20,
        tagline: 'Panadería artesanal',
        radius_m: 120,
        is_active: true,
      });
      expect(id).toBe('new-id');
      expect(mockRpc).toHaveBeenCalledWith('admin_upsert_partner_place', {
        p_id: null,
        p_name: 'Sylvain',
        p_category: 'cafe',
        p_lat: 23.1,
        p_lng: -82.3,
        p_discount_percent: 20,
        p_tagline: 'Panadería artesanal',
        p_photo_url: null,
        p_address: null,
        p_municipality: null,
        p_province: null,
        p_phone: null,
        p_hours: null,
        p_radius_m: 120,
        p_is_active: true,
        p_valid_until: null,
      });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'El descuento debe estar entre 1 y 100.', code: 'P0001' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(partnerPlaceService.adminUpsert({
        id: null, name: 'x', category: 'cafe', latitude: 1, longitude: 2,
        discount_percent: 0, radius_m: 80, is_active: true,
      })).rejects.toEqual(err);
    });
  });
});
