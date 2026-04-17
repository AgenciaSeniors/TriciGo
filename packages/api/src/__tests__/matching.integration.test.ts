// ============================================================
// TriciGo — Matching Service Integration Tests
// Tests driver matching and scoring through the service layer
// with mocked Supabase client.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase Mock ───────────────────────────────────────────
const mockSingle = vi.fn();
const mockRpc = vi.fn();

function chainable() {
  const obj: Record<string, unknown> = {};
  obj.select = vi.fn().mockReturnValue(obj);
  obj.eq = vi.fn().mockReturnValue(obj);
  obj.order = vi.fn().mockReturnValue(obj);
  obj.range = vi.fn().mockReturnValue(obj);
  obj.single = mockSingle;
  return obj;
}

const mockFrom = vi.fn().mockImplementation(() => chainable());

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@tricigo/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
import { matchingService } from '../services/matching.service';

describe('Matching Service Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── findBestDrivers ──────────────────────────────────────

  describe('findBestDrivers', () => {
    it('should return drivers sorted by composite score', async () => {
      const mockDrivers = [
        {
          driver_id: 'd-001',
          distance_m: 500,
          match_score: 85.0,
          rating_avg: 4.8,
          acceptance_rate: 95.0,
          composite_score: 90.2,
        },
        {
          driver_id: 'd-002',
          distance_m: 1200,
          match_score: 70.0,
          rating_avg: 4.5,
          acceptance_rate: 80.0,
          composite_score: 72.5,
        },
        {
          driver_id: 'd-003',
          distance_m: 800,
          match_score: 75.0,
          rating_avg: 4.6,
          acceptance_rate: 88.0,
          composite_score: 78.1,
        },
      ];

      mockRpc.mockResolvedValueOnce({ data: mockDrivers, error: null });

      const result = await matchingService.findBestDrivers({
        pickup_lat: 23.1136,
        pickup_lng: -82.3666,
        service_type: 'triciclo_basico',
        limit: 5,
        radius_m: 5000,
      });

      expect(result).toHaveLength(3);
      // Verify the RPC was called with correct params
      expect(mockRpc).toHaveBeenCalledWith('find_best_drivers', {
        p_pickup_lat: 23.1136,
        p_pickup_lng: -82.3666,
        p_service_type: 'triciclo_basico',
        p_limit: 5,
        p_radius_m: 5000,
        p_is_delivery: false,
      });
      // First driver should have highest composite score
      expect(result[0].composite_score).toBeGreaterThan(result[1].composite_score);
    });

    it('should return empty array when no drivers available', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await matchingService.findBestDrivers({
        pickup_lat: 23.1136,
        pickup_lng: -82.3666,
        service_type: 'triciclo_basico',
      });

      expect(result).toEqual([]);
    });

    it('should use default limit and radius when not specified', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await matchingService.findBestDrivers({
        pickup_lat: 23.1136,
        pickup_lng: -82.3666,
        service_type: 'moto_standard',
      });

      expect(mockRpc).toHaveBeenCalledWith('find_best_drivers', {
        p_pickup_lat: 23.1136,
        p_pickup_lng: -82.3666,
        p_service_type: 'moto_standard',
        p_limit: 5,
        p_radius_m: 5000,
        p_is_delivery: false,
      });
    });

    it('should throw when RPC returns an error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC failed', code: '500' },
      });

      await expect(
        matchingService.findBestDrivers({
          pickup_lat: 23.1136,
          pickup_lng: -82.3666,
          service_type: 'triciclo_basico',
        }),
      ).rejects.toThrow();
    });

    it('should handle single driver result (non-array response)', async () => {
      const singleDriver = {
        driver_id: 'd-001',
        distance_m: 500,
        match_score: 85.0,
        rating_avg: 4.8,
        acceptance_rate: 95.0,
        composite_score: 90.2,
      };

      mockRpc.mockResolvedValueOnce({ data: singleDriver, error: null });

      const result = await matchingService.findBestDrivers({
        pickup_lat: 23.1136,
        pickup_lng: -82.3666,
        service_type: 'triciclo_basico',
      });

      expect(result).toHaveLength(1);
      expect(result[0].driver_id).toBe('d-001');
    });
  });

  // ─── updateDriverScore ────────────────────────────────────

  describe('updateDriverScore', () => {
    it('should update score and return new value', async () => {
      mockRpc.mockResolvedValueOnce({ data: 72.5, error: null });

      const newScore = await matchingService.updateDriverScore(
        'd-001',
        'ride_completed',
        { ride_id: 'ride-001' },
      );

      expect(newScore).toBe(72.5);
      expect(mockRpc).toHaveBeenCalledWith('update_driver_score', {
        p_driver_id: 'd-001',
        p_event_type: 'ride_completed',
        p_details: { ride_id: 'ride-001' },
      });
    });

    it('should default to 50.0 when RPC returns non-number', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const newScore = await matchingService.updateDriverScore(
        'd-001',
        'ride_completed',
      );

      expect(newScore).toBe(50.0);
    });

    it('should pass null details when not provided', async () => {
      mockRpc.mockResolvedValueOnce({ data: 60.0, error: null });

      await matchingService.updateDriverScore('d-001', 'ride_cancelled');

      expect(mockRpc).toHaveBeenCalledWith('update_driver_score', {
        p_driver_id: 'd-001',
        p_event_type: 'ride_cancelled',
        p_details: null,
      });
    });
  });

  // ─── getDriverScore ───────────────────────────────────────

  describe('getDriverScore', () => {
    it('should return driver score and acceptance rate', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { match_score: 82.3, acceptance_rate: 91.5 },
        error: null,
      });

      const result = await matchingService.getDriverScore('d-001');
      expect(result.match_score).toBe(82.3);
      expect(result.acceptance_rate).toBe(91.5);
    });

    it('should return defaults when data fields are null', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { match_score: null, acceptance_rate: null },
        error: null,
      });

      const result = await matchingService.getDriverScore('d-001');
      expect(result.match_score).toBe(50.0);
      expect(result.acceptance_rate).toBe(100.0);
    });
  });
});
