import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { trustedContactService } from '../trusted-contact.service';

describe('trustedContactService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== getContacts ====================
  describe('getContacts', () => {
    it('returns contacts ordered by is_emergency desc then created_at asc', async () => {
      const mockContacts = [
        { id: 'tc-1', user_id: 'u-1', name: 'Mama', is_emergency: true },
        { id: 'tc-2', user_id: 'u-1', name: 'Amigo', is_emergency: false },
      ];
      const mockOrder2 = vi.fn().mockResolvedValue({ data: mockContacts, error: null });
      const mockOrder1 = vi.fn(() => ({ order: mockOrder2 }));
      const mockEq = vi.fn(() => ({ order: mockOrder1 }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await trustedContactService.getContacts('u-1');

      expect(mockFrom).toHaveBeenCalledWith('trusted_contacts');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(mockOrder1).toHaveBeenCalledWith('is_emergency', { ascending: false });
      expect(mockOrder2).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(result).toEqual(mockContacts);
    });

    it('returns empty array when no contacts', async () => {
      const mockOrder2 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder1 = vi.fn(() => ({ order: mockOrder2 }));
      const mockEq = vi.fn(() => ({ order: mockOrder1 }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await trustedContactService.getContacts('u-1');
      expect(result).toEqual([]);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder2 = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder1 = vi.fn(() => ({ order: mockOrder2 }));
      const mockEq = vi.fn(() => ({ order: mockOrder1 }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(trustedContactService.getContacts('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== addContact ====================
  describe('addContact', () => {
    it('inserts and returns contact', async () => {
      const mockContact = {
        id: 'tc-1',
        user_id: 'u-1',
        name: 'Mama',
        phone: '+5355555555',
        relationship: 'Madre',
        auto_share: true,
        is_emergency: true,
      };

      // First call: count check
      const mockHead = vi.fn().mockResolvedValue({ count: 2, error: null });
      const mockEqCount = vi.fn(() => ({ select: vi.fn(() => mockHead) }));
      // We need to handle the chaining properly for count
      const mockSelectCount = vi.fn().mockReturnValue({ eq: mockEqCount });

      // Actually, the count check uses select('*', { count: 'exact', head: true }).eq(...)
      // Let's simplify the mock chain
      const countResult = { count: 2, error: null };
      const mockCountEq = vi.fn().mockResolvedValue(countResult);
      const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));

      // Second call: insert
      const mockSingle = vi.fn().mockResolvedValue({ data: mockContact, error: null });
      const mockInsertSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockInsertSelect }));

      mockFrom
        .mockReturnValueOnce({ select: mockCountSelect })
        .mockReturnValueOnce({ insert: mockInsert });

      const result = await trustedContactService.addContact({
        user_id: 'u-1',
        name: 'Mama',
        phone: '+5355555555',
        relationship: 'Madre',
        auto_share: true,
        is_emergency: true,
      });

      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'u-1',
        name: 'Mama',
        phone: '+5355555555',
        relationship: 'Madre',
        auto_share: true,
        is_emergency: true,
      });
      expect(result).toEqual(mockContact);
    });

    it('throws MAX_CONTACTS when limit reached', async () => {
      const countResult = { count: 5, error: null };
      const mockCountEq = vi.fn().mockResolvedValue(countResult);
      const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));

      mockFrom.mockReturnValueOnce({ select: mockCountSelect });

      await expect(
        trustedContactService.addContact({
          user_id: 'u-1',
          name: 'Test',
          phone: '+5300000000',
        }),
      ).rejects.toEqual({ message: 'Maximum contacts reached', code: 'MAX_CONTACTS' });
    });

    it('throws on duplicate phone', async () => {
      const countResult = { count: 1, error: null };
      const mockCountEq = vi.fn().mockResolvedValue(countResult);
      const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));

      const dupErr = { message: 'duplicate key', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: dupErr });
      const mockInsertSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockInsertSelect }));

      mockFrom
        .mockReturnValueOnce({ select: mockCountSelect })
        .mockReturnValueOnce({ insert: mockInsert });

      await expect(
        trustedContactService.addContact({
          user_id: 'u-1',
          name: 'Test',
          phone: '+5355555555',
        }),
      ).rejects.toEqual(dupErr);
    });
  });

  // ==================== updateContact ====================
  describe('updateContact', () => {
    it('updates fields and returns contact', async () => {
      const mockContact = {
        id: 'tc-1',
        name: 'Mama Updated',
        auto_share: false,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockContact, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await trustedContactService.updateContact('tc-1', {
        name: 'Mama Updated',
        auto_share: false,
      });

      expect(mockFrom).toHaveBeenCalledWith('trusted_contacts');
      expect(mockUpdate).toHaveBeenCalledWith({ name: 'Mama Updated', auto_share: false });
      expect(mockEq).toHaveBeenCalledWith('id', 'tc-1');
      expect(result).toEqual(mockContact);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        trustedContactService.updateContact('tc-999', { name: 'Test' }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== deleteContact ====================
  describe('deleteContact', () => {
    it('deletes contact', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockDelete = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await trustedContactService.deleteContact('tc-1');

      expect(mockFrom).toHaveBeenCalledWith('trusted_contacts');
      expect(mockEq).toHaveBeenCalledWith('id', 'tc-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'FK violation', code: '23503' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockDelete = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await expect(trustedContactService.deleteContact('tc-1')).rejects.toEqual(err);
    });
  });

  // ==================== getAutoShareContacts ====================
  describe('getAutoShareContacts', () => {
    it('returns only auto_share=true contacts', async () => {
      const mockContacts = [
        { id: 'tc-1', name: 'Mama', auto_share: true },
      ];
      const mockOrder = vi.fn().mockResolvedValue({ data: mockContacts, error: null });
      const mockEqAutoShare = vi.fn(() => ({ order: mockOrder }));
      const mockEqUser = vi.fn(() => ({ eq: mockEqAutoShare }));
      const mockSelect = vi.fn(() => ({ eq: mockEqUser }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await trustedContactService.getAutoShareContacts('u-1');

      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEqUser).toHaveBeenCalledWith('user_id', 'u-1');
      expect(mockEqAutoShare).toHaveBeenCalledWith('auto_share', true);
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(result).toEqual(mockContacts);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEqAutoShare = vi.fn(() => ({ order: mockOrder }));
      const mockEqUser = vi.fn(() => ({ eq: mockEqAutoShare }));
      const mockSelect = vi.fn(() => ({ eq: mockEqUser }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(trustedContactService.getAutoShareContacts('u-1')).rejects.toEqual(err);
    });
  });
});
