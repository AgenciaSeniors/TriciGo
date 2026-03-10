import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { fraudService } from '../fraud.service';

describe('fraudService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== getFraudAlerts ====================
  describe('getFraudAlerts', () => {
    it('returns alerts with default limit and no resolved filter', async () => {
      const mockAlerts = [
        { id: 'fa-1', alert_type: 'velocity', severity: 'high' },
        { id: 'fa-2', alert_type: 'location', severity: 'medium' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: mockAlerts, error: null });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await fraudService.getFraudAlerts();

      expect(mockFrom).toHaveBeenCalledWith('fraud_alerts');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(result).toEqual(mockAlerts);
    });

    it('applies resolved filter and custom limit when provided', async () => {
      const mockAlerts = [{ id: 'fa-1', resolved: false }];
      const mockEq = vi.fn().mockResolvedValue({ data: mockAlerts, error: null });
      const mockLimit = vi.fn(() => ({ eq: mockEq }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await fraudService.getFraudAlerts({ resolved: false, limit: 10 });

      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(mockEq).toHaveBeenCalledWith('resolved', false);
      expect(result).toEqual(mockAlerts);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockLimit = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(fraudService.getFraudAlerts()).rejects.toEqual(err);
    });
  });

  // ==================== getUserAlerts ====================
  describe('getUserAlerts', () => {
    it('returns alerts for a specific user', async () => {
      const mockAlerts = [
        { id: 'fa-3', user_id: 'u-1', alert_type: 'velocity' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: mockAlerts, error: null });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await fraudService.getUserAlerts('u-1');

      expect(mockFrom).toHaveBeenCalledWith('fraud_alerts');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(20);
      expect(result).toEqual(mockAlerts);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Query failed', code: '500' };
      const mockLimit = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(fraudService.getUserAlerts('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== resolveAlert ====================
  describe('resolveAlert', () => {
    it('updates the alert as resolved with note', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      // Use fake timers to control Date
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

      await fraudService.resolveAlert('fa-1', 'admin-1', 'False positive');

      expect(mockFrom).toHaveBeenCalledWith('fraud_alerts');
      expect(mockUpdate).toHaveBeenCalledWith({
        resolved: true,
        resolved_by: 'admin-1',
        resolved_at: '2026-03-10T12:00:00.000Z',
        resolution_note: 'False positive',
      });
      expect(mockEq).toHaveBeenCalledWith('id', 'fa-1');

      vi.useRealTimers();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        fraudService.resolveAlert('fa-1', 'admin-1', 'Note'),
      ).rejects.toEqual(err);
    });
  });

  // ==================== freezeWallet ====================
  describe('freezeWallet', () => {
    it('calls supabase rpc freeze_wallet with correct params', async () => {
      mockRpc.mockResolvedValue({ error: null });

      await fraudService.freezeWallet('u-1', 'Suspicious activity', 'admin-1');

      expect(mockRpc).toHaveBeenCalledWith('freeze_wallet', {
        p_user_id: 'u-1',
        p_reason: 'Suspicious activity',
        p_admin_id: 'admin-1',
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValue({ error: err });

      await expect(
        fraudService.freezeWallet('u-1', 'Reason', 'admin-1'),
      ).rejects.toEqual(err);
    });
  });

  // ==================== unfreezeWallet ====================
  describe('unfreezeWallet', () => {
    it('calls supabase rpc unfreeze_wallet with correct params', async () => {
      mockRpc.mockResolvedValue({ error: null });

      await fraudService.unfreezeWallet('u-1', 'admin-1');

      expect(mockRpc).toHaveBeenCalledWith('unfreeze_wallet', {
        p_user_id: 'u-1',
        p_admin_id: 'admin-1',
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValue({ error: err });

      await expect(
        fraudService.unfreezeWallet('u-1', 'admin-1'),
      ).rejects.toEqual(err);
    });
  });

  // ==================== checkFraudSignals ====================
  describe('checkFraudSignals', () => {
    it('calls supabase rpc check_fraud_signals and returns array of signals', async () => {
      const mockSignals = [
        { alert_type: 'velocity', severity: 'high', details: { trips_per_hour: 15 } },
        { alert_type: 'location', severity: 'medium', details: { distance_km: 500 } },
      ];
      mockRpc.mockResolvedValue({ data: mockSignals, error: null });

      const result = await fraudService.checkFraudSignals('u-1');

      expect(mockRpc).toHaveBeenCalledWith('check_fraud_signals', {
        p_user_id: 'u-1',
      });
      expect(result).toEqual(mockSignals);
    });

    it('returns empty array when data is null', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null });

      const result = await fraudService.checkFraudSignals('u-1');

      expect(result).toEqual([]);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValue({ data: null, error: err });

      await expect(fraudService.checkFraudSignals('u-1')).rejects.toEqual(err);
    });
  });
});
