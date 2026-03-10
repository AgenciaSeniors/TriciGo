import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { incidentService } from '../incident.service';

describe('incidentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== createSOSReport ====================
  describe('createSOSReport', () => {
    it('inserts SOS report and returns it', async () => {
      const mockReport = {
        id: 'inc-1',
        ride_id: 'r-1',
        reported_by: 'u-1',
        type: 'sos',
        severity: 'critical',
        status: 'open',
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockReport, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await incidentService.createSOSReport({
        ride_id: 'r-1',
        reported_by: 'u-1',
        description: 'Emergency situation',
      });

      expect(mockFrom).toHaveBeenCalledWith('incident_reports');
      expect(mockInsert).toHaveBeenCalledWith({
        ride_id: 'r-1',
        reported_by: 'u-1',
        against_user_id: null,
        type: 'sos',
        severity: 'critical',
        description: 'Emergency situation',
        status: 'open',
      });
      expect(result).toEqual(mockReport);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        incidentService.createSOSReport({
          ride_id: 'r-1',
          reported_by: 'u-1',
          description: 'Emergency',
        }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getIncidentsForRide ====================
  describe('getIncidentsForRide', () => {
    it('returns incidents for a ride', async () => {
      const mockIncidents = [
        { id: 'inc-1', ride_id: 'r-1', type: 'sos' },
        { id: 'inc-2', ride_id: 'r-1', type: 'sos' },
      ];
      const mockOrder = vi.fn().mockResolvedValue({ data: mockIncidents, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await incidentService.getIncidentsForRide('r-1');

      expect(mockFrom).toHaveBeenCalledWith('incident_reports');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('ride_id', 'r-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(result).toEqual(mockIncidents);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(incidentService.getIncidentsForRide('r-1')).rejects.toEqual(err);
    });
  });

  // ==================== getMyIncidents ====================
  describe('getMyIncidents', () => {
    it('returns incidents reported by user', async () => {
      const mockIncidents = [
        { id: 'inc-1', reported_by: 'u-1', type: 'sos' },
      ];
      const mockOrder = vi.fn().mockResolvedValue({ data: mockIncidents, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await incidentService.getMyIncidents('u-1');

      expect(mockFrom).toHaveBeenCalledWith('incident_reports');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('reported_by', 'u-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(result).toEqual(mockIncidents);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(incidentService.getMyIncidents('u-1')).rejects.toEqual(err);
    });
  });
});
