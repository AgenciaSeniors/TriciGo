import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client. The device service must scope every query to the
// authenticated user — it must NOT rely on RLS alone, because the
// `ukd_admin_all` policy (FOR ALL USING is_admin()) widens RLS for admins and
// would otherwise expose every user's devices on the personal "Tus
// dispositivos" screen.
const mockFrom = vi.fn();
const mockGetUser = vi.fn();
const mockSupabase = {
  from: mockFrom,
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
});
