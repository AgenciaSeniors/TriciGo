import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockUpsert = vi.fn();
const mockEq = vi.fn();
const mockNot = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Mock global fetch for Expo push API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mock is set up
import { notificationService } from '../notification.service';

describe('notificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerPushToken', () => {
    it('calls supabase upsert with correct parameters', async () => {
      const mockUpsertFn = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({
        upsert: mockUpsertFn,
      });

      await notificationService.registerPushToken('user-1', 'ExponentPushToken[abc123]', 'android');

      expect(mockFrom).toHaveBeenCalledWith('user_devices');
      expect(mockUpsertFn).toHaveBeenCalledWith(
        { user_id: 'user-1', push_token: 'ExponentPushToken[abc123]', platform: 'android' },
        { onConflict: 'user_id,push_token' },
      );
    });

    it('throws on supabase error', async () => {
      mockFrom.mockReturnValueOnce({
        upsert: vi.fn().mockResolvedValue({ error: { message: 'DB error', code: '23505' } }),
      });

      await expect(
        notificationService.registerPushToken('user-1', 'token', 'ios'),
      ).rejects.toEqual({ message: 'DB error', code: '23505' });
    });
  });

  describe('removePushToken', () => {
    it('calls supabase delete with correct eq chain', async () => {
      const mockSecondEq = vi.fn().mockResolvedValue({ error: null });
      const mockFirstEq = vi.fn(() => ({ eq: mockSecondEq }));
      const mockDeleteFn = vi.fn(() => ({ eq: mockFirstEq }));

      mockFrom.mockReturnValueOnce({
        delete: mockDeleteFn,
      });

      await notificationService.removePushToken('user-1', 'ExponentPushToken[abc123]');

      expect(mockFrom).toHaveBeenCalledWith('user_devices');
      expect(mockDeleteFn).toHaveBeenCalled();
      expect(mockFirstEq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockSecondEq).toHaveBeenCalledWith('push_token', 'ExponentPushToken[abc123]');
    });

    it('throws on supabase error', async () => {
      const mockSecondEq = vi.fn().mockResolvedValue({
        error: { message: 'Delete failed', code: '42P01' },
      });
      const mockFirstEq = vi.fn(() => ({ eq: mockSecondEq }));
      const mockDeleteFn = vi.fn(() => ({ eq: mockFirstEq }));

      mockFrom.mockReturnValueOnce({
        delete: mockDeleteFn,
      });

      await expect(
        notificationService.removePushToken('user-1', 'token'),
      ).rejects.toEqual({ message: 'Delete failed', code: '42P01' });
    });
  });

  describe('getDeviceTokens', () => {
    it('returns array of push tokens for user', async () => {
      const mockNotFn = vi.fn().mockResolvedValue({
        data: [
          { push_token: 'ExponentPushToken[aaa]' },
          { push_token: 'ExponentPushToken[bbb]' },
        ],
        error: null,
      });
      const mockEqFn = vi.fn(() => ({ not: mockNotFn }));
      const mockSelectFn = vi.fn(() => ({ eq: mockEqFn }));

      mockFrom.mockReturnValueOnce({
        select: mockSelectFn,
      });

      const tokens = await notificationService.getDeviceTokens('user-1');

      expect(mockFrom).toHaveBeenCalledWith('user_devices');
      expect(mockSelectFn).toHaveBeenCalledWith('push_token');
      expect(mockEqFn).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockNotFn).toHaveBeenCalledWith('push_token', 'is', null);
      expect(tokens).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
    });

    it('returns empty array when user has no devices', async () => {
      const mockNotFn = vi.fn().mockResolvedValue({
        data: [],
        error: null,
      });
      const mockEqFn = vi.fn(() => ({ not: mockNotFn }));
      const mockSelectFn = vi.fn(() => ({ eq: mockEqFn }));

      mockFrom.mockReturnValueOnce({
        select: mockSelectFn,
      });

      const tokens = await notificationService.getDeviceTokens('user-no-devices');

      expect(tokens).toEqual([]);
    });

    it('returns empty array when data is null', async () => {
      const mockNotFn = vi.fn().mockResolvedValue({
        data: null,
        error: null,
      });
      const mockEqFn = vi.fn(() => ({ not: mockNotFn }));
      const mockSelectFn = vi.fn(() => ({ eq: mockEqFn }));

      mockFrom.mockReturnValueOnce({
        select: mockSelectFn,
      });

      const tokens = await notificationService.getDeviceTokens('user-null');

      expect(tokens).toEqual([]);
    });
  });

  describe('sendPushNotification', () => {
    it('sends push notification to Expo API with correct shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { status: 'ok', id: 'ticket-1' },
            { status: 'ok', id: 'ticket-2' },
          ],
        }),
      });

      const result = await notificationService.sendPushNotification(
        ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]'],
        'Viaje aceptado',
        'Tu conductor esta en camino',
        { rideId: 'ride-123' },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://exp.host/--/api/v2/push/send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            {
              to: 'ExponentPushToken[aaa]',
              title: 'Viaje aceptado',
              body: 'Tu conductor esta en camino',
              sound: 'default',
              data: { rideId: 'ride-123' },
            },
            {
              to: 'ExponentPushToken[bbb]',
              title: 'Viaje aceptado',
              body: 'Tu conductor esta en camino',
              sound: 'default',
              data: { rideId: 'ride-123' },
            },
          ]),
        },
      );

      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(0);
    });

    it('returns zero counts for empty tokens array', async () => {
      const result = await notificationService.sendPushNotification(
        [],
        'Title',
        'Body',
      );

      expect(result).toEqual({ successCount: 0, errorCount: 0 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles network error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await notificationService.sendPushNotification(
        ['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]'],
        'Title',
        'Body',
      );

      expect(result).toEqual({ successCount: 0, errorCount: 2 });
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('handles non-ok HTTP response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await notificationService.sendPushNotification(
        ['ExponentPushToken[aaa]'],
        'Title',
        'Body',
      );

      expect(result).toEqual({ successCount: 0, errorCount: 1 });

      consoleSpy.mockRestore();
    });

    it('counts mixed success and error tickets', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { status: 'ok', id: 'ticket-1' },
            { status: 'error', message: 'DeviceNotRegistered' },
            { status: 'ok', id: 'ticket-3' },
          ],
        }),
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await notificationService.sendPushNotification(
        ['token-a', 'token-b', 'token-c'],
        'Title',
        'Body',
      );

      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(1);

      consoleSpy.mockRestore();
    });

    it('omits data field from message when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ status: 'ok', id: 'ticket-1' }],
        }),
      });

      await notificationService.sendPushNotification(
        ['ExponentPushToken[aaa]'],
        'Title',
        'Body',
      );

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody[0]).not.toHaveProperty('data');
      expect(fetchBody[0]).toEqual({
        to: 'ExponentPushToken[aaa]',
        title: 'Title',
        body: 'Body',
        sound: 'default',
      });
    });
  });

  describe('notifyUser', () => {
    it('orchestrates getDeviceTokens and sendPushNotification', async () => {
      // Mock getDeviceTokens via supabase
      const mockNotFn = vi.fn().mockResolvedValue({
        data: [
          { push_token: 'ExponentPushToken[aaa]' },
          { push_token: 'ExponentPushToken[bbb]' },
        ],
        error: null,
      });
      const mockEqFn = vi.fn(() => ({ not: mockNotFn }));
      const mockSelectFn = vi.fn(() => ({ eq: mockEqFn }));

      mockFrom.mockReturnValueOnce({
        select: mockSelectFn,
      });

      // Mock fetch for sendPushNotification
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { status: 'ok', id: 'ticket-1' },
            { status: 'ok', id: 'ticket-2' },
          ],
        }),
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await notificationService.notifyUser(
        'user-1',
        'Viaje completado',
        'Gracias por usar TriciGo',
        { rideId: 'ride-456' },
      );

      // Verify getDeviceTokens was called via supabase
      expect(mockFrom).toHaveBeenCalledWith('user_devices');
      expect(mockSelectFn).toHaveBeenCalledWith('push_token');
      expect(mockEqFn).toHaveBeenCalledWith('user_id', 'user-1');

      // Verify sendPushNotification was called via fetch
      expect(mockFetch).toHaveBeenCalledWith(
        'https://exp.host/--/api/v2/push/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // Verify the fetch body contains the correct tokens and message
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody).toHaveLength(2);
      expect(fetchBody[0].to).toBe('ExponentPushToken[aaa]');
      expect(fetchBody[1].to).toBe('ExponentPushToken[bbb]');
      expect(fetchBody[0].title).toBe('Viaje completado');
      expect(fetchBody[0].body).toBe('Gracias por usar TriciGo');
      expect(fetchBody[0].data).toEqual({ rideId: 'ride-456' });

      consoleSpy.mockRestore();
    });

    it('returns silently without calling push API when user has no tokens', async () => {
      // Mock getDeviceTokens returning empty array
      const mockNotFn = vi.fn().mockResolvedValue({
        data: [],
        error: null,
      });
      const mockEqFn = vi.fn(() => ({ not: mockNotFn }));
      const mockSelectFn = vi.fn(() => ({ eq: mockEqFn }));

      mockFrom.mockReturnValueOnce({
        select: mockSelectFn,
      });

      await notificationService.notifyUser(
        'user-no-devices',
        'Title',
        'Body',
      );

      // getDeviceTokens was called
      expect(mockFrom).toHaveBeenCalledWith('user_devices');

      // fetch should NOT have been called since there are no tokens
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
