import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { locationService } from '../location.service';

describe('locationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // recordRideLocation
  // ------------------------------------------------------------------
  describe('recordRideLocation', () => {
    it('inserts a location event with correct POINT format', async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await locationService.recordRideLocation({
        ride_id: 'ride-1',
        driver_id: 'driver-1',
        latitude: 19.4326,
        longitude: -99.1332,
        heading: 90,
        speed: 30,
      });

      expect(mockFrom).toHaveBeenCalledWith('ride_location_events');
      expect(mockInsert).toHaveBeenCalledWith({
        ride_id: 'ride-1',
        driver_id: 'driver-1',
        location: 'POINT(-99.1332 19.4326)',
        heading: 90,
        speed: 30,
      });
    });

    it('throws on supabase error', async () => {
      const mockInsert = vi.fn().mockResolvedValue({
        error: { message: 'Insert failed', code: '23505' },
      });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        locationService.recordRideLocation({
          ride_id: 'ride-1',
          driver_id: 'driver-1',
          latitude: 19.4326,
          longitude: -99.1332,
        }),
      ).rejects.toEqual({ message: 'Insert failed', code: '23505' });
    });
  });

  // ------------------------------------------------------------------
  // calculateRideDistance
  // ------------------------------------------------------------------
  describe('calculateRideDistance', () => {
    it('calls rpc with correct parameters and returns distance data', async () => {
      const mockResult = [{ distance_m: 1500, point_count: 12 }];
      mockRpc.mockResolvedValueOnce({ data: mockResult, error: null });

      const result = await locationService.calculateRideDistance('ride-1');

      expect(mockRpc).toHaveBeenCalledWith('calculate_ride_distance', {
        p_ride_id: 'ride-1',
      });
      expect(result).toEqual({ distance_m: 1500, point_count: 12 });
    });

    it('throws on supabase error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC failed', code: '42883' },
      });

      await expect(
        locationService.calculateRideDistance('ride-1'),
      ).rejects.toEqual({ message: 'RPC failed', code: '42883' });
    });
  });

  // ------------------------------------------------------------------
  // getLatestLocation
  // ------------------------------------------------------------------
  describe('getLatestLocation', () => {
    it('returns the latest location for a ride', async () => {
      const mockLocation = {
        id: 'loc-1',
        ride_id: 'ride-1',
        driver_id: 'driver-1',
        location: 'POINT(-99.1332 19.4326)',
        recorded_at: '2025-01-01T10:00:00Z',
      };

      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockLocation, error: null });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await locationService.getLatestLocation('ride-1');

      expect(mockFrom).toHaveBeenCalledWith('ride_location_events');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('ride_id', 'ride-1');
      expect(mockOrder).toHaveBeenCalledWith('recorded_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(1);
      expect(mockMaybeSingle).toHaveBeenCalled();
      expect(result).toEqual(mockLocation);
    });

    it('throws on supabase error', async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Query failed', code: '42P01' },
      });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(
        locationService.getLatestLocation('ride-1'),
      ).rejects.toEqual({ message: 'Query failed', code: '42P01' });
    });
  });
});
