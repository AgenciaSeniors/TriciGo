import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UUID } from './helpers/mockSupabase';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSubscribe = vi.fn();
const mockOn = vi.fn(() => ({ subscribe: mockSubscribe }));
const mockChannel = vi.fn(() => ({ on: mockOn }));
const mockSupabase: Record<string, unknown> = { from: mockFrom, rpc: mockRpc, channel: mockChannel };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { chatService, isFinalChatSendError } from '../chat.service';
import { AppError } from '../../errors';

describe('chatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // getMessages
  // ------------------------------------------------------------------
  describe('getMessages', () => {
    it('returns messages ordered by created_at ascending', async () => {
      const mockMessages = [
        { id: 'msg-1', ride_id: 'ride-1', body: 'Hola', created_at: '2025-01-01T10:00:00Z' },
        { id: 'msg-2', ride_id: 'ride-1', body: 'Listo', created_at: '2025-01-01T10:01:00Z' },
      ];

      const mockOrder = vi.fn().mockResolvedValue({ data: mockMessages, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await chatService.getMessages('ride-1');

      expect(mockFrom).toHaveBeenCalledWith('ride_messages');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('ride_id', 'ride-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(result).toEqual(mockMessages);
    });

    it('throws on supabase error', async () => {
      const mockOrder = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Select failed', code: '42P01' },
      });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(chatService.getMessages('ride-1')).rejects.toEqual({
        message: 'Select failed',
        code: '42P01',
      });
    });
  });

  // ------------------------------------------------------------------
  // sendMessage
  // ------------------------------------------------------------------
  describe('sendMessage', () => {
    it('inserts a message and returns it via select().single()', async () => {
      const mockMessage = {
        id: UUID.MSG_1,
        ride_id: UUID.RIDE_1,
        sender_id: UUID.USER_1,
        body: 'En camino',
      };

      const mockSingle = vi.fn().mockResolvedValue({ data: mockMessage, error: null });
      const mockSelectChain = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelectChain }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'En camino');

      expect(mockFrom).toHaveBeenCalledWith('ride_messages');
      expect(mockInsert).toHaveBeenCalledWith({
        ride_id: UUID.RIDE_1,
        sender_id: UUID.USER_1,
        body: 'En camino',
      });
      expect(mockSelectChain).toHaveBeenCalled();
      expect(mockSingle).toHaveBeenCalled();
      expect(result).toEqual(mockMessage);
    });

    it('throws on supabase error', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Insert failed', code: '23505' },
      });
      const mockSelectChain = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelectChain }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'Hola'),
      ).rejects.toEqual({ message: 'Insert failed', code: '23505' });
    });

    // 00653: the server closes a ride's chat when the ride ends and caps a
    // message at 1000 characters. Those answers do not change on retry, so the
    // hooks must drop the message instead of queueing it.
    function failWith(error: Record<string, unknown>) {
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error });
      mockFrom.mockReturnValueOnce({ insert: vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) })) });
    }

    it('turns a closed chat into a final CHAT_CLOSED error with the server sentence', async () => {
      failWith({ message: 'El chat de este viaje ya está cerrado.', details: 'chat_closed', code: 'P0001' });
      const err = await chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'Hola').catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('CHAT_CLOSED');
      expect(err.message).toBe('El chat de este viaje ya está cerrado.');
      expect(isFinalChatSendError(err)).toBe(true);
    });

    it('turns an over-long message into a final CHAT_MESSAGE_LENGTH error', async () => {
      failWith({ message: 'El mensaje debe tener entre 1 y 1000 caracteres.', details: 'chat_message_length', code: 'P0001' });
      const err = await chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'Hola').catch((e) => e);
      expect(err.code).toBe('CHAT_MESSAGE_LENGTH');
      expect(isFinalChatSendError(err)).toBe(true);
    });

    it('rejects a message over 1000 characters before sending it', async () => {
      const err = await chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'x'.repeat(1001)).catch((e) => e);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(isFinalChatSendError(err)).toBe(true);
    });

    it('keeps network and other errors retryable', async () => {
      failWith({ message: 'Failed to fetch', code: '' });
      const err = await chatService.sendMessage(UUID.RIDE_1, UUID.USER_1, 'Hola').catch((e) => e);
      expect(isFinalChatSendError(err)).toBe(false);
      expect(isFinalChatSendError(new TypeError('Network request failed'))).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // subscribeToMessages
  // ------------------------------------------------------------------
  describe('subscribeToMessages', () => {
    it('creates a realtime subscription with correct channel and params', () => {
      const onMessage = vi.fn();

      chatService.subscribeToMessages('ride-42', onMessage);

      expect(mockChannel).toHaveBeenCalledWith('chat:ride-42');
      expect(mockOn).toHaveBeenCalledWith(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_messages',
          filter: 'ride_id=eq.ride-42',
        },
        expect.any(Function),
      );
      expect(mockSubscribe).toHaveBeenCalled();
    });

    it('returns the subscription object', () => {
      const onMessage = vi.fn();
      const mockSubscription = { id: 'sub-1' };
      mockSubscribe.mockReturnValueOnce(mockSubscription);

      const result = chatService.subscribeToMessages('ride-99', onMessage);

      expect(result).toEqual(mockSubscription);
    });
  });

  // ------------------------------------------------------------------
  // Read receipts (00516)
  // ------------------------------------------------------------------
  describe('getMessages with a limit', () => {
    it('takes the MOST RECENT n and hands them back oldest-first', async () => {
      // The rows come back newest-first from the query; the caller renders in
      // order, so the service flips them. Getting this backwards would pin the
      // chat to its oldest messages and look frozen.
      const newestFirst = [
        { id: 'm3', created_at: '2025-01-01T10:02:00Z' },
        { id: 'm2', created_at: '2025-01-01T10:01:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: newestFirst, error: null });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      mockFrom.mockReturnValueOnce({ select: vi.fn(() => ({ eq: mockEq })) });

      const result = await chatService.getMessages('ride-1', 2);

      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(2);
      expect(result.map((m) => m.id)).toEqual(['m2', 'm3']);
    });
  });

  describe('getUnreadCount', () => {
    it('counts without transferring rows', async () => {
      const mockIs = vi.fn().mockResolvedValue({ count: 3, error: null });
      const mockNeq = vi.fn(() => ({ is: mockIs }));
      const mockEq = vi.fn(() => ({ neq: mockNeq }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));
      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const n = await chatService.getUnreadCount('ride-1', UUID.USER_1);

      expect(mockSelect).toHaveBeenCalledWith('id', { count: 'exact', head: true });
      expect(mockNeq).toHaveBeenCalledWith('sender_id', UUID.USER_1);
      expect(mockIs).toHaveBeenCalledWith('read_at', null);
      expect(n).toBe(3);
    });

    it('reports zero when the count comes back null', async () => {
      const mockIs = vi.fn().mockResolvedValue({ count: null, error: null });
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ neq: vi.fn(() => ({ is: mockIs })) })) })),
      });
      expect(await chatService.getUnreadCount('ride-1', UUID.USER_1)).toBe(0);
    });
  });

  describe('markRead', () => {
    it('goes through the RPC — the table has no UPDATE policy on purpose', async () => {
      mockRpc.mockResolvedValueOnce({ data: 2, error: null });

      const n = await chatService.markRead('ride-1');

      expect(mockRpc).toHaveBeenCalledWith('mark_ride_messages_read', { p_ride_id: 'ride-1' });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(n).toBe(2);
    });

    // A build can ship ahead of migration 00516. When it does the chat must
    // keep working, just with nothing ever marked read.
    it('degrades quietly when the RPC is absent (42883)', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'boom' } });
      expect(await chatService.markRead('ride-1')).toBe(0);
    });

    it('degrades on the message alone, without the code', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: undefined, message: 'function mark_ride_messages_read does not exist' },
      });
      expect(await chatService.markRead('ride-1')).toBe(0);
    });

    it('propagates a real failure instead of swallowing it', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '57014', message: 'statement timeout' },
      });
      await expect(chatService.markRead('ride-1')).rejects.toMatchObject({ code: '57014' });
    });
  });
});
