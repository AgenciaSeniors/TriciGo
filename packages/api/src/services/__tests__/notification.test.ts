import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockUpsert = vi.fn();
const mockEq = vi.fn();
const mockNot = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();
const mockFrom = vi.fn();
const mockChannel = vi.fn();
const mockOn = vi.fn();
const mockSubscribe = vi.fn();
const mockSupabase = {
  from: mockFrom,
  channel: mockChannel,
};

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

      const fetchBody = JSON.parse(mockFetch.mock.calls[0]![1]!.body);
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
      const fetchBody = JSON.parse(mockFetch.mock.calls[0]![1]!.body);
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

  describe('updateSmsPreference', () => {
    it('updates sms_notifications_enabled for user', async () => {
      const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

      mockFrom.mockReturnValue({ update: mockUpdate });

      await notificationService.updateSmsPreference('user-1', true);
      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockUpdate).toHaveBeenCalledWith({ sms_notifications_enabled: true });
      expect(mockUpdateEq).toHaveBeenCalledWith('id', 'user-1');
    });

    it('throws when update fails', async () => {
      const mockUpdateEq = vi.fn().mockResolvedValue({ error: { message: 'RLS denied' } });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

      mockFrom.mockReturnValue({ update: mockUpdate });

      await expect(notificationService.updateSmsPreference('user-1', true)).rejects.toBeDefined();
    });
  });

  describe('getSmsPreference', () => {
    it('returns true when sms is enabled', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { sms_notifications_enabled: true },
              error: null,
            }),
          }),
        }),
      });

      const result = await notificationService.getSmsPreference('user-1');
      expect(result).toBe(true);
    });

    it('returns false when sms is disabled', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { sms_notifications_enabled: false },
              error: null,
            }),
          }),
        }),
      });

      const result = await notificationService.getSmsPreference('user-1');
      expect(result).toBe(false);
    });

    it('returns false when user not found', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: null,
            }),
          }),
        }),
      });

      const result = await notificationService.getSmsPreference('user-404');
      expect(result).toBe(false);
    });
  });

  describe('sendSMS', () => {
    it('returns false when user has SMS disabled', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { phone: '+5355555555', sms_notifications_enabled: false },
              error: null,
            }),
          }),
        }),
      });

      const result = await notificationService.sendSMS({
        userId: 'user-1',
        body: 'Test message',
      });
      expect(result.success).toBe(false);
    });

    it('returns false when user has no phone', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { phone: null, sms_notifications_enabled: true },
              error: null,
            }),
          }),
        }),
      });

      const result = await notificationService.sendSMS({
        userId: 'user-1',
        body: 'Test message',
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // In-App Notification Inbox
  // ============================================================

  describe('getInboxNotifications', () => {
    it('returns paginated notifications ordered by created_at desc', async () => {
      const mockNotifs = [
        { id: 'n-1', user_id: 'user-1', type: 'ride_completed', title: 'Viaje completado', body: 'Gracias', data: null, read: false, created_at: '2026-03-13T10:00:00Z' },
        { id: 'n-2', user_id: 'user-1', type: 'promo', title: 'Oferta', body: '50% off', data: null, read: true, created_at: '2026-03-12T10:00:00Z' },
      ];

      const mockRange = vi.fn().mockResolvedValue({ data: mockNotifs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ range: mockRange });
      const mockEqUser = vi.fn().mockReturnValue({ order: mockOrder });
      const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ select: mockSelectFn });

      const result = await notificationService.getInboxNotifications('user-1');

      expect(mockFrom).toHaveBeenCalledWith('notifications');
      expect(mockSelectFn).toHaveBeenCalledWith('*');
      expect(mockEqUser).toHaveBeenCalledWith('user_id', 'user-1');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('n-1');
    });

    it('filters by unread when unreadOnly is true', async () => {
      const mockRange = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ range: mockRange });
      const mockEqRead = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqUser = vi.fn().mockReturnValue({ eq: mockEqRead });
      const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ select: mockSelectFn });

      await notificationService.getInboxNotifications('user-1', { unreadOnly: true });

      expect(mockEqRead).toHaveBeenCalledWith('read', false);
    });

    it('returns empty array when no notifications', async () => {
      const mockRange = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ range: mockRange });
      const mockEqUser = vi.fn().mockReturnValue({ order: mockOrder });
      const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ select: mockSelectFn });

      const result = await notificationService.getInboxNotifications('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getUnreadCount', () => {
    it('returns count of unread notifications', async () => {
      const mockEqRead = vi.fn().mockResolvedValue({ count: 5, error: null });
      const mockEqUser = vi.fn().mockReturnValue({ eq: mockEqRead });
      const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ select: mockSelectFn });

      const count = await notificationService.getUnreadCount('user-1');

      expect(mockFrom).toHaveBeenCalledWith('notifications');
      expect(mockSelectFn).toHaveBeenCalledWith('*', { count: 'exact', head: true });
      expect(mockEqUser).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockEqRead).toHaveBeenCalledWith('read', false);
      expect(count).toBe(5);
    });

    it('returns 0 when no unread notifications', async () => {
      const mockEqRead = vi.fn().mockResolvedValue({ count: 0, error: null });
      const mockEqUser = vi.fn().mockReturnValue({ eq: mockEqRead });
      const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ select: mockSelectFn });

      const count = await notificationService.getUnreadCount('user-1');
      expect(count).toBe(0);
    });
  });

  describe('markAsRead', () => {
    it('updates notification to read=true', async () => {
      const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await notificationService.markAsRead('n-123');

      expect(mockFrom).toHaveBeenCalledWith('notifications');
      expect(mockUpdate).toHaveBeenCalledWith({ read: true });
      expect(mockUpdateEq).toHaveBeenCalledWith('id', 'n-123');
    });

    it('throws on error', async () => {
      const mockUpdateEq = vi.fn().mockResolvedValue({ error: { message: 'Not found' } });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(notificationService.markAsRead('n-bad')).rejects.toBeDefined();
    });
  });

  describe('markAllAsRead', () => {
    it('marks all unread notifications as read for user', async () => {
      const mockEqRead = vi.fn().mockResolvedValue({ error: null });
      const mockEqUser = vi.fn().mockReturnValue({ eq: mockEqRead });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUser });

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await notificationService.markAllAsRead('user-1');

      expect(mockFrom).toHaveBeenCalledWith('notifications');
      expect(mockUpdate).toHaveBeenCalledWith({ read: true });
      expect(mockEqUser).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockEqRead).toHaveBeenCalledWith('read', false);
    });
  });

  describe('createInboxNotification', () => {
    it('inserts notification with data', async () => {
      const notif = { id: 'n-new', user_id: 'user-1', type: 'ride_completed', title: 'Done', body: 'Trip done', data: { ride_id: 'r-1' }, read: false, created_at: '2026-03-13T10:00:00Z' };
      const mockSingle = vi.fn().mockResolvedValue({ data: notif, error: null });
      const mockSelectFn = vi.fn().mockReturnValue({ single: mockSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelectFn });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await notificationService.createInboxNotification(
        'user-1', 'ride_completed', 'Done', 'Trip done', { ride_id: 'r-1' },
      );

      expect(mockFrom).toHaveBeenCalledWith('notifications');
      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'user-1',
        type: 'ride_completed',
        title: 'Done',
        body: 'Trip done',
        data: { ride_id: 'r-1' },
      });
      expect(result.id).toBe('n-new');
    });

    it('inserts notification without data', async () => {
      const notif = { id: 'n-new2', user_id: 'user-1', type: 'system', title: 'Hi', body: 'Welcome', data: null, read: false, created_at: '2026-03-13T10:00:00Z' };
      const mockSingle = vi.fn().mockResolvedValue({ data: notif, error: null });
      const mockSelectFn = vi.fn().mockReturnValue({ single: mockSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelectFn });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await notificationService.createInboxNotification(
        'user-1', 'system', 'Hi', 'Welcome',
      );

      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'user-1',
        type: 'system',
        title: 'Hi',
        body: 'Welcome',
        data: null,
      });
      expect(result.data).toBeNull();
    });
  });

  describe('subscribeToNotifications', () => {
    it('sets up realtime subscription for user inbox', () => {
      const mockSubscribeFn = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
      const mockOnFn = vi.fn().mockReturnValue({ subscribe: mockSubscribeFn });
      mockChannel.mockReturnValue({ on: mockOnFn });

      const callback = vi.fn();
      notificationService.subscribeToNotifications('user-1', callback);

      expect(mockChannel).toHaveBeenCalledWith('inbox:user-1');
      expect(mockOnFn).toHaveBeenCalledWith(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: 'user_id=eq.user-1',
        },
        expect.any(Function),
      );
      expect(mockSubscribeFn).toHaveBeenCalled();
    });
  });
});
