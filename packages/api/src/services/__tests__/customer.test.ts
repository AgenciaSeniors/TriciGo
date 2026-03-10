import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { customerService } from '../customer.service';

describe('customerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== getProfile ====================
  describe('getProfile', () => {
    it('returns the customer profile when found', async () => {
      const mockProfile = {
        id: 'cp-1',
        user_id: 'u-1',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockProfile, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await customerService.getProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('customer_profiles');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(result).toEqual(mockProfile);
    });

    it('returns null when no profile exists', async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await customerService.getProfile('u-no-profile');

      expect(result).toBeNull();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(customerService.getProfile('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== createProfile ====================
  describe('createProfile', () => {
    it('inserts a new customer profile with defaults and returns it', async () => {
      const newProfile = {
        id: 'cp-2',
        user_id: 'u-2',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: newProfile, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await customerService.createProfile('u-2');

      expect(mockFrom).toHaveBeenCalledWith('customer_profiles');
      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'u-2',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      });
      expect(mockSelect).toHaveBeenCalled();
      expect(result).toEqual(newProfile);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(customerService.createProfile('u-2')).rejects.toEqual(err);
    });
  });

  // ==================== updateProfile ====================
  describe('updateProfile', () => {
    it('updates the profile and returns the updated record', async () => {
      const updated = {
        id: 'cp-1',
        user_id: 'u-1',
        default_payment_method: 'nequi',
        saved_locations: [],
        emergency_contact: null,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: updated, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await customerService.updateProfile('cp-1', {
        default_payment_method: 'nequi',
      } as any);

      expect(mockFrom).toHaveBeenCalledWith('customer_profiles');
      expect(mockUpdate).toHaveBeenCalledWith({ default_payment_method: 'nequi' });
      expect(mockEq).toHaveBeenCalledWith('id', 'cp-1');
      expect(mockSelect).toHaveBeenCalled();
      expect(result).toEqual(updated);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        customerService.updateProfile('cp-1', { default_payment_method: 'nequi' } as any),
      ).rejects.toEqual(err);
    });
  });

  // ==================== ensureProfile ====================
  describe('ensureProfile', () => {
    it('returns existing profile when one exists', async () => {
      const existingProfile = {
        id: 'cp-1',
        user_id: 'u-1',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: existingProfile, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await customerService.ensureProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('customer_profiles');
      expect(result).toEqual(existingProfile);
      // Should NOT have called insert (only 1 from() call for getProfile)
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('creates a new profile when none exists', async () => {
      // First call: getProfile returns null
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelectGet = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelectGet });

      // Second call: createProfile
      const newProfile = {
        id: 'cp-3',
        user_id: 'u-3',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: newProfile, error: null });
      const mockSelectCreate = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelectCreate }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await customerService.ensureProfile('u-3');

      // getProfile was called first
      expect(mockFrom).toHaveBeenNthCalledWith(1, 'customer_profiles');
      // createProfile was called second
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'customer_profiles');
      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'u-3',
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      });
      expect(result).toEqual(newProfile);
    });
  });
});
