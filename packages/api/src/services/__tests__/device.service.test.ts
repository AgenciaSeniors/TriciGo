import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client. The device service must scope every query to the
// authenticated user — it must NOT rely on RLS alone, because the
// `ukd_admin_all` policy (FOR ALL USING is_admin()) widens RLS for admins and
// would otherwise expose every user's devices on the personal "Tus
// dispositivos" screen.
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi.fn();
const mockSupabase = {
  from: mockFrom,
  rpc: mockRpc,
  auth: { getUser: mockGetUser },
};

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { deviceService } from '../device.service';

const SELECT_COLS =
  'id, device_id, platform, model, os_version, app_version, first_seen_at, last_seen_at';

describe('deviceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listMyDevices', () => {
    it('scopes the query to the current user (eq user_id), not RLS alone', async () => {
      const rows = [{ id: 'd1', device_id: 'abc', platform: 'ios' }];
      const order = vi.fn().mockResolvedValue({ data: rows, error: null });
      const eq = vi.fn(() => ({ order }));
      const select = vi.fn(() => ({ eq }));
      mockFrom.mockReturnValueOnce({ select });
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } });

      const result = await deviceService.listMyDevices();

      expect(mockFrom).toHaveBeenCalledWith('user_known_devices');
      expect(select).toHaveBeenCalledWith(SELECT_COLS);
      expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(order).toHaveBeenCalledWith('last_seen_at', { ascending: false });
      expect(result).toEqual(rows);
    });

    it('returns [] when there is no authenticated user', async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: null } });

      const result = await deviceService.listMyDevices();

      expect(result).toEqual([]);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('throws on supabase error', async () => {
      const order = vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'boom', code: '42501' } });
      const eq = vi.fn(() => ({ order }));
      const select = vi.fn(() => ({ eq }));
      mockFrom.mockReturnValueOnce({ select });
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } });

      await expect(deviceService.listMyDevices()).rejects.toEqual({
        message: 'boom',
        code: '42501',
      });
    });
  });

  describe('revokeDevice', () => {
    it('scopes the delete to id AND the current user_id', async () => {
      const eqUser = vi.fn().mockResolvedValue({ error: null });
      const eqId = vi.fn(() => ({ eq: eqUser }));
      const del = vi.fn(() => ({ eq: eqId }));
      mockFrom.mockReturnValueOnce({ delete: del });
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } });

      await deviceService.revokeDevice('dev-1');

      expect(mockFrom).toHaveBeenCalledWith('user_known_devices');
      expect(del).toHaveBeenCalled();
      expect(eqId).toHaveBeenCalledWith('id', 'dev-1');
      expect(eqUser).toHaveBeenCalledWith('user_id', 'user-1');
    });

    it('throws when there is no authenticated user', async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: null } });

      await expect(deviceService.revokeDevice('dev-1')).rejects.toThrow();
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('reportAppOpen', () => {
    const input = { app: 'client' as const, device_id: 'dev-1', app_version: '1.7.4', platform: 'android' };

    it('reports through report_app_open and never touches user_known_devices', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'recorded', error: null });

      const outcome = await deviceService.reportAppOpen(input);

      expect(outcome).toBe('recorded');
      expect(mockRpc).toHaveBeenCalledWith('report_app_open', {
        p_app: 'client',
        p_device_id: 'dev-1',
        p_app_version: '1.7.4',
        p_platform: 'android',
      });
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('passes a missing version or platform as null', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'updated', error: null });

      await deviceService.reportAppOpen({ app: 'driver', device_id: 'dev-2', app_version: null, platform: null });

      expect(mockRpc).toHaveBeenCalledWith('report_app_open', {
        p_app: 'driver',
        p_device_id: 'dev-2',
        p_app_version: null,
        p_platform: null,
      });
    });

    it("answers 'unavailable' while the migration is not applied", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.report_app_open in the schema cache' },
      });

      await expect(deviceService.reportAppOpen(input)).resolves.toBe('unavailable');
    });

    it('throws any other error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not signed in' } });

      await expect(deviceService.reportAppOpen(input)).rejects.toMatchObject({ message: 'not signed in' });
    });
  });
});
