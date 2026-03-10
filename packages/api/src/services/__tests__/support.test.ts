import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { supportService } from '../support.service';

describe('supportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== createTicket ====================
  describe('createTicket', () => {
    it('inserts ticket and returns it', async () => {
      const mockTicket = {
        id: 't-1',
        user_id: 'u-1',
        category: 'billing',
        subject: 'Charge issue',
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockTicket, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await supportService.createTicket({
        user_id: 'u-1',
        category: 'billing' as any,
        subject: 'Charge issue',
        description: 'I was overcharged',
      });

      expect(mockFrom).toHaveBeenCalledWith('support_tickets');
      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'u-1',
        ride_id: null,
        category: 'billing',
        subject: 'Charge issue',
        description: 'I was overcharged',
      });
      expect(result).toEqual(mockTicket);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        supportService.createTicket({
          user_id: 'u-1',
          category: 'billing' as any,
          subject: 'Charge issue',
        }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getUserTickets ====================
  describe('getUserTickets', () => {
    it('returns tickets for a user', async () => {
      const mockTickets = [
        { id: 't-1', user_id: 'u-1', subject: 'Issue 1' },
        { id: 't-2', user_id: 'u-1', subject: 'Issue 2' },
      ];
      const mockOrder = vi.fn().mockResolvedValue({ data: mockTickets, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await supportService.getUserTickets('u-1');

      expect(mockFrom).toHaveBeenCalledWith('support_tickets');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(result).toEqual(mockTickets);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(supportService.getUserTickets('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== getAllTickets ====================
  describe('getAllTickets', () => {
    it('returns all tickets with optional status filter', async () => {
      const mockTickets = [
        { id: 't-1', status: 'open' },
        { id: 't-2', status: 'open' },
      ];
      // Chain: from -> select -> order -> limit -> eq -> resolves
      const mockEqStatus = vi.fn().mockResolvedValue({ data: mockTickets, error: null });
      const mockLimit = vi.fn(() => ({ eq: mockEqStatus }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await supportService.getAllTickets({ status: 'open' as any, limit: 25 });

      expect(mockFrom).toHaveBeenCalledWith('support_tickets');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(25);
      expect(mockEqStatus).toHaveBeenCalledWith('status', 'open');
      expect(result).toEqual(mockTickets);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      // No status filter: chain is from -> select -> order -> limit -> resolves
      const mockLimit = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(supportService.getAllTickets()).rejects.toEqual(err);
    });
  });

  // ==================== getTicket ====================
  describe('getTicket', () => {
    it('returns a single ticket by ID', async () => {
      const mockTicket = { id: 't-1', subject: 'My issue' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockTicket, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await supportService.getTicket('t-1');

      expect(mockFrom).toHaveBeenCalledWith('support_tickets');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('id', 't-1');
      expect(result).toEqual(mockTicket);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(supportService.getTicket('t-1')).rejects.toEqual(err);
    });
  });

  // ==================== updateTicket ====================
  describe('updateTicket', () => {
    it('updates ticket fields', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await supportService.updateTicket('t-1', { status: 'resolved' as any, priority: 'high' as any });

      expect(mockFrom).toHaveBeenCalledWith('support_tickets');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'resolved',
          priority: 'high',
          resolved_at: expect.any(String),
          updated_at: expect.any(String),
        }),
      );
      expect(mockEq).toHaveBeenCalledWith('id', 't-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        supportService.updateTicket('t-1', { status: 'in_progress' as any }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getMessages ====================
  describe('getMessages', () => {
    it('returns messages for a ticket', async () => {
      const mockMessages = [
        { id: 'm-1', ticket_id: 't-1', message: 'Hello' },
        { id: 'm-2', ticket_id: 't-1', message: 'Reply' },
      ];
      const mockOrder = vi.fn().mockResolvedValue({ data: mockMessages, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await supportService.getMessages('t-1');

      expect(mockFrom).toHaveBeenCalledWith('ticket_messages');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('ticket_id', 't-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(result).toEqual(mockMessages);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(supportService.getMessages('t-1')).rejects.toEqual(err);
    });
  });

  // ==================== sendMessage ====================
  describe('sendMessage', () => {
    it('inserts message and returns it', async () => {
      const mockMessage = {
        id: 'm-1',
        ticket_id: 't-1',
        sender_id: 'u-1',
        message: 'Need help',
        is_admin: false,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockMessage, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await supportService.sendMessage({
        ticket_id: 't-1',
        sender_id: 'u-1',
        message: 'Need help',
      });

      expect(mockFrom).toHaveBeenCalledWith('ticket_messages');
      expect(mockInsert).toHaveBeenCalledWith({
        ticket_id: 't-1',
        sender_id: 'u-1',
        message: 'Need help',
        is_admin: false,
      });
      expect(result).toEqual(mockMessage);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        supportService.sendMessage({
          ticket_id: 't-1',
          sender_id: 'u-1',
          message: 'Help',
        }),
      ).rejects.toEqual(err);
    });
  });
});
