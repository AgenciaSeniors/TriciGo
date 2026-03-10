import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { matchingService } from '../matching.service';

describe('matchingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // findBestDrivers
  // ------------------------------------------------------------------
  describe('findBestDrivers', () => {
    it('calls rpc with all parameters including defaults and returns drivers', async () => {
      const mockDrivers = [
        { driver_id: 'd-1', composite_score: 85.2, distance_m: 500 },
        { driver_id: 'd-2', composite_score: 72.1, distance_m: 1200 },
      ];
      mockRpc.mockResolvedValueOnce({ data: mockDrivers, error: null });

      const result = await matchingService.findBestDrivers({
        pickup_lat: 19.4326,
        pickup_lng: -99.1332,
        service_type: 'mototaxi',
      });

      expect(mockRpc).toHaveBeenCalledWith('find_best_drivers', {
        p_pickup_lat: 19.4326,
        p_pickup_lng: -99.1332,
        p_service_type: 'mototaxi',
        p_limit: 5,
        p_radius_m: 5000,
      });
      expect(result).toEqual(mockDrivers);
    });

    it('throws on supabase error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC failed', code: '42883' },
      });

      await expect(
        matchingService.findBestDrivers({
          pickup_lat: 19.4326,
          pickup_lng: -99.1332,
          service_type: 'mototaxi',
        }),
      ).rejects.toEqual({ message: 'RPC failed', code: '42883' });
    });
  });

  // ------------------------------------------------------------------
  // updateDriverScore
  // ------------------------------------------------------------------
  describe('updateDriverScore', () => {
    it('calls rpc with correct parameters and returns the new score', async () => {
      mockRpc.mockResolvedValueOnce({ data: 78.5, error: null });

      const result = await matchingService.updateDriverScore(
        'driver-1',
        'ride_completed' as any,
        { ride_id: 'ride-1' },
      );

      expect(mockRpc).toHaveBeenCalledWith('update_driver_score', {
        p_driver_id: 'driver-1',
        p_event_type: 'ride_completed',
        p_details: { ride_id: 'ride-1' },
      });
      expect(result).toBe(78.5);
    });

    it('throws on supabase error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Score update failed', code: '42883' },
      });

      await expect(
        matchingService.updateDriverScore('driver-1', 'ride_completed' as any),
      ).rejects.toEqual({ message: 'Score update failed', code: '42883' });
    });
  });

  // ------------------------------------------------------------------
  // getDriverScore
  // ------------------------------------------------------------------
  describe('getDriverScore', () => {
    it('returns match_score and acceptance_rate from driver_profiles', async () => {
      const mockProfile = { match_score: 82.3, acceptance_rate: 95.0 };

      const mockSingle = vi.fn().mockResolvedValue({ data: mockProfile, error: null });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await matchingService.getDriverScore('driver-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockSelect).toHaveBeenCalledWith('match_score, acceptance_rate');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'driver-1');
      expect(mockSingle).toHaveBeenCalled();
      expect(result).toEqual({ match_score: 82.3, acceptance_rate: 95.0 });
    });

    it('throws on supabase error', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Profile not found', code: 'PGRST116' },
      });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(
        matchingService.getDriverScore('driver-x'),
      ).rejects.toEqual({ message: 'Profile not found', code: 'PGRST116' });
    });
  });

  // ------------------------------------------------------------------
  // getScoreEvents
  // ------------------------------------------------------------------
  describe('getScoreEvents', () => {
    it('returns score events ordered by created_at desc with limit', async () => {
      const mockEvents = [
        { id: 'evt-1', driver_id: 'driver-1', event_type: 'ride_completed', created_at: '2025-01-02' },
        { id: 'evt-2', driver_id: 'driver-1', event_type: 'ride_cancelled', created_at: '2025-01-01' },
      ];

      const mockLimit = vi.fn().mockResolvedValue({ data: mockEvents, error: null });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await matchingService.getScoreEvents('driver-1', 20);

      expect(mockFrom).toHaveBeenCalledWith('driver_score_events');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('driver_id', 'driver-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(20);
      expect(result).toEqual(mockEvents);
    });

    it('throws on supabase error', async () => {
      const mockLimit = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Query failed', code: '42P01' },
      });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(
        matchingService.getScoreEvents('driver-1'),
      ).rejects.toEqual({ message: 'Query failed', code: '42P01' });
    });
  });
});
