import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { recurringRideService } from '../recurring-ride.service';

const MOCK_RECURRING = {
  id: 'rr-1',
  customer_id: 'u-1',
  pickup_address: 'Casa',
  dropoff_address: 'Oficina',
  service_type: 'triciclo_basico',
  payment_method: 'tricicoin',
  days_of_week: [1, 2, 3, 4, 5],
  time_of_day: '08:00',
  timezone: 'America/Havana',
  status: 'active',
  next_occurrence_at: '2026-03-14T12:00:00Z',
  last_ride_created_at: null,
  created_at: '2026-03-10T00:00:00Z',
  updated_at: '2026-03-10T00:00:00Z',
};

describe('recurringRideService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== getRecurringRides ====================
  describe('getRecurringRides', () => {
    it('returns list of recurring rides', async () => {
      const mockOrder = vi.fn().mockResolvedValue({ data: [MOCK_RECURRING], error: null });
      const mockNeq = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ neq: mockNeq }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await recurringRideService.getRecurringRides('u-1');

      expect(mockFrom).toHaveBeenCalledWith('recurring_rides');
      expect(mockEq).toHaveBeenCalledWith('customer_id', 'u-1');
      expect(mockNeq).toHaveBeenCalledWith('status', 'deleted');
      expect(result).toEqual([MOCK_RECURRING]);
    });

    it('returns empty array when none', async () => {
      const mockOrder = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockNeq = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ neq: mockNeq }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await recurringRideService.getRecurringRides('u-1');
      expect(result).toEqual([]);
    });
  });

  // ==================== createRecurringRide ====================
  describe('createRecurringRide', () => {
    it('inserts and returns recurring ride', async () => {
      // Count check
      const countResult = { count: 2, error: null };
      const mockCountNeq = vi.fn().mockResolvedValue(countResult);
      const mockCountEq = vi.fn(() => ({ neq: mockCountNeq }));
      const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));

      mockFrom.mockReturnValueOnce({ select: mockCountSelect });

      // RPC compute_next_occurrence
      mockRpc.mockResolvedValueOnce({ data: '2026-03-14T12:00:00Z', error: null });

      // Insert
      const mockSingle = vi.fn().mockResolvedValue({ data: MOCK_RECURRING, error: null });
      const mockInsertSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockInsertSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await recurringRideService.createRecurringRide({
        user_id: 'u-1',
        pickup_latitude: 23.11,
        pickup_longitude: -82.36,
        pickup_address: 'Casa',
        dropoff_latitude: 23.14,
        dropoff_longitude: -82.39,
        dropoff_address: 'Oficina',
        service_type: 'triciclo_basico',
        payment_method: 'tricicoin',
        days_of_week: [1, 2, 3, 4, 5],
        time_of_day: '08:00',
      });

      expect(mockRpc).toHaveBeenCalledWith('compute_next_occurrence', {
        p_days: [1, 2, 3, 4, 5],
        p_time: '08:00',
        p_tz: 'America/Havana',
      });
      expect(result).toEqual(MOCK_RECURRING);
    });

    it('throws MAX_RECURRING when limit reached', async () => {
      const countResult = { count: 10, error: null };
      const mockCountNeq = vi.fn().mockResolvedValue(countResult);
      const mockCountEq = vi.fn(() => ({ neq: mockCountNeq }));
      const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));

      mockFrom.mockReturnValueOnce({ select: mockCountSelect });

      await expect(
        recurringRideService.createRecurringRide({
          user_id: 'u-1',
          pickup_latitude: 23.11,
          pickup_longitude: -82.36,
          pickup_address: 'Casa',
          dropoff_latitude: 23.14,
          dropoff_longitude: -82.39,
          dropoff_address: 'Oficina',
          service_type: 'triciclo_basico',
          payment_method: 'tricicoin',
          days_of_week: [1, 2, 3, 4, 5],
          time_of_day: '08:00',
        }),
      ).rejects.toEqual({ message: 'Maximum recurring rides reached', code: 'MAX_RECURRING' });
    });
  });

  // ==================== pauseRecurringRide ====================
  describe('pauseRecurringRide', () => {
    it('sets status to paused and clears next_occurrence_at', async () => {
      const paused = { ...MOCK_RECURRING, status: 'paused', next_occurrence_at: null };
      const mockSingle = vi.fn().mockResolvedValue({ data: paused, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await recurringRideService.pauseRecurringRide('rr-1');

      expect(mockUpdate).toHaveBeenCalledWith({ status: 'paused', next_occurrence_at: null });
      expect(result.status).toBe('paused');
      expect(result.next_occurrence_at).toBeNull();
    });
  });

  // ==================== resumeRecurringRide ====================
  describe('resumeRecurringRide', () => {
    it('recomputes next_occurrence_at and sets active', async () => {
      // Fetch current schedule
      const mockFetchSingle = vi.fn().mockResolvedValue({
        data: { days_of_week: [1, 2, 3, 4, 5], time_of_day: '08:00' },
        error: null,
      });
      const mockFetchEq = vi.fn(() => ({ single: mockFetchSingle }));
      const mockFetchSelect = vi.fn(() => ({ eq: mockFetchEq }));

      mockFrom.mockReturnValueOnce({ select: mockFetchSelect });

      // RPC
      mockRpc.mockResolvedValueOnce({ data: '2026-03-17T12:00:00Z', error: null });

      // Update
      const resumed = { ...MOCK_RECURRING, status: 'active', next_occurrence_at: '2026-03-17T12:00:00Z' };
      const mockSingle = vi.fn().mockResolvedValue({ data: resumed, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await recurringRideService.resumeRecurringRide('rr-1');

      expect(mockRpc).toHaveBeenCalledWith('compute_next_occurrence', {
        p_days: [1, 2, 3, 4, 5],
        p_time: '08:00',
        p_tz: 'America/Havana',
      });
      expect(mockUpdate).toHaveBeenCalledWith({
        status: 'active',
        next_occurrence_at: '2026-03-17T12:00:00Z',
      });
      expect(result.status).toBe('active');
    });
  });

  // ==================== deleteRecurringRide ====================
  describe('deleteRecurringRide', () => {
    it('soft deletes by setting status to deleted', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await recurringRideService.deleteRecurringRide('rr-1');

      expect(mockFrom).toHaveBeenCalledWith('recurring_rides');
      expect(mockUpdate).toHaveBeenCalledWith({ status: 'deleted', next_occurrence_at: null });
      expect(mockEq).toHaveBeenCalledWith('id', 'rr-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(recurringRideService.deleteRecurringRide('rr-999')).rejects.toEqual(err);
    });
  });
});
